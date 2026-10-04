import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  FindAdminPlatformUsersQueryParams, FindAdminPlatformUsersResponse,
  GrantPlatformAdminBody, GrantPlatformAdminParams, GrantPlatformAdminResponse,
  RevokePlatformAdminBody, RevokePlatformAdminParams, RevokePlatformAdminResponse,
  CreateAdminFxRateBody, CreateAdminFxRateResponse, DeleteAdminProviderCredentialsParams,
  DeleteAdminProviderCredentialsResponse, GetAdminMerchantDetailsParams, GetAdminMerchantDetailsResponse,
  GetAdminPlatformSettingsResponse, GetAdminSummaryResponse,
  GetAdminCloudinaryUploadStatusResponse, CreateAdminCloudinaryUploadSignatureResponse,
  ListAdminAuditLogQueryParams, ListAdminAuditLogResponse, ListAdminFeeSchedulesResponse,
  ListAdminFxRatesResponse, ListAdminMerchantsQueryParams, ListAdminMerchantsResponse,
  ListAdminProviderCredentialsResponse, SaveAdminProviderCredentialsBody,
  CreateAdminMerchantApplicationRequestAttachmentUploadIntentBody,
  CreateAdminMerchantApplicationRequestAttachmentUploadIntentResponse,
  DeleteAdminMerchantApplicationRequestAttachmentUploadIntentParams,
  CreateAdminMerchantVerificationRequestBody, CreateAdminMerchantVerificationRequestResponse,
  SaveAdminProviderCredentialsParams, SaveAdminProviderCredentialsResponse,
  UpdateAdminFeeScheduleBody, UpdateAdminFeeScheduleResponse, UpdateAdminFxRateBody,
  UpdateAdminFxRateParams, UpdateAdminFxRateResponse, UpdateAdminMerchantBody,
  UpdateAdminMerchantParams, UpdateAdminMerchantResponse, UpdateAdminPlatformSettingsBody,
  UpdateAdminPlatformSettingsResponse,
  ListAdminCollectionCurrencyAvailabilityResponse, UpdateAdminCollectionCurrencyAvailabilityBody,
  UpdateAdminCollectionCurrencyAvailabilityResponse, ReviewAdminMerchantApplicationBody,
  ReviewAdminMerchantApplicationResponse, ListAdminMerchantApplicationAttachmentsParams,
  ListAdminMerchantApplicationAttachmentsResponse, DownloadAdminMerchantApplicationAttachmentParams,
} from "@workspace/api-zod";
import {
  adminAuditLogTable, db, feeSchedulesTable, fxRatesTable, merchantApiKeysTable,
  merchantsTable, platformSettingsTable, providerCredentialsTable, transactionsTable,
  platformAdminAssignmentsTable, verificationTierLimitsTable, verificationUsageReservationsTable,
  collectionCurrencyAvailabilityTable, merchantApplicationAttachmentsTable,
  merchantApplicationUploadIntentsTable,
} from "@workspace/db";
import type { MerchantApplicationDetails } from "@workspace/db";
import { encryptProviderCredentials, readProviderCredentials } from "../lib/secure-storage";
import { credentialVaultReady } from "../lib/secret-crypto";
import { collectionCurrencyAvailabilityAudit, supportedCollectionCurrencyCode } from "../lib/collection-currency-availability";
import { providerCredential, providerCredentialFields } from "../lib/credential-runtime";
import { cleanPublicUrl, normalizeWhatsAppContact } from "../lib/platform-branding";
import { cloudinaryUploadStatus, createCloudinaryUploadSignature } from "../lib/cloudinary-upload";
import { resolveCloudinaryEnvironment } from "../lib/cloudinary-credentials";
import {
  MERCHANT_ACTION_KEYS,
  normalizeMerchantActionControls,
  normalizePayoutSafetySettings,
  type MerchantActionKey,
} from "../lib/merchant-access-policy";
import { verificationTierForMerchant } from "../lib/platform";
import { notifyMerchantAccountAction } from "../lib/support-service";
import {
  CASE_FILE_MAX_BYTES, CASE_FILE_TYPES, createPrivateApplicationUpload, deletePrivateCaseObject,
  getPrivateCaseObject, verifyPrivateCaseObject, type CaseFileType,
} from "../lib/cloudinary-case-storage";
import { caseAttachmentName } from "../lib/merchant-business-tools";
import {
  allowlistedAdminEmails, ClerkApiError, emailIsBootstrapAdmin, existingClerkUserIds, fetchClerkUser, findVerifiedClerkUsersByEmail,
  platformAdminAuditDetails, remainingEffectiveAdminCount, verifiedEmailAddresses,
  verifiedPhoneNumbers, verifiedPrimaryEmail, verifiedPrimaryPhoneNumber, type ClerkUserRecord,
} from "../lib/platform-admin";

const router: IRouter = Router();
const providers = ["paystack", "payhero", "payzaapi", "didit", "cloudinary", "currencyapi"] as const;
const CASE_FILE_CONTENT_TYPES = new Set(Object.keys(CASE_FILE_TYPES));
const MAX_APPLICATION_REQUEST_ATTACHMENTS = 5;
const APPLICATION_REQUEST_UPLOAD_TTL_MS = 10 * 60_000;

function collectionCurrencyAvailabilityDto(row: typeof collectionCurrencyAvailabilityTable.$inferSelect) {
  return {
    currency: row.currency,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
    actorUserId: row.actorUserId,
  };
}

router.get("/admin/collection-currencies", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const rows = await db.select().from(collectionCurrencyAvailabilityTable)
    .orderBy(collectionCurrencyAvailabilityTable.currency);
  res.json(ListAdminCollectionCurrencyAvailabilityResponse.parse({ items: rows.map(collectionCurrencyAvailabilityDto) }));
});

router.put("/admin/collection-currencies", async (req, res): Promise<void> => {
  const parsed = UpdateAdminCollectionCurrencyAvailabilityBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const currency = supportedCollectionCurrencyCode(parsed.data.currency);
  if (!currency) {
    res.status(400).json({ error: "Currency must be one of Greenpay's supported collection currencies." });
    return;
  }
  const actorUserId = actor(req);
  const saved = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.insert(collectionCurrencyAvailabilityTable).values({
      currency,
      enabled: parsed.data.enabled,
      updatedAt: now,
      actorUserId,
    }).onConflictDoUpdate({
      target: collectionCurrencyAvailabilityTable.currency,
      set: { enabled: parsed.data.enabled, updatedAt: now, actorUserId },
    }).returning();
    await tx.insert(adminAuditLogTable).values(collectionCurrencyAvailabilityAudit(actorUserId, currency, parsed.data.enabled));
    return row!;
  });
  res.json(UpdateAdminCollectionCurrencyAvailabilityResponse.parse(collectionCurrencyAvailabilityDto(saved)));
});

function actor(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): string {
  return getAuth(req).userId ?? "unknown-admin";
}

function clerkLookupFailure(error: unknown): { status: number; message: string } {
  if (error instanceof ClerkApiError && error.status === 404) {
    return { status: 404, message: "The Clerk user could not be found." };
  }
  return { status: 503, message: "Clerk could not verify the user. Try again shortly." };
}

async function platformAdminUserDto(user: ClerkUserRecord & { verifiedEmail: string }) {
  const [assignment] = await db.select().from(platformAdminAssignmentsTable)
    .where(eq(platformAdminAssignmentsTable.clerkUserId, user.id)).limit(1);
  const bootstrapAdmin = emailIsBootstrapAdmin(user.verifiedEmail);
  const assignmentActive = Boolean(assignment && !assignment.revokedAt);
  return {
    userId: user.id,
    email: user.verifiedEmail,
    effectiveRole: bootstrapAdmin || assignmentActive ? "platform_admin" as const : "user" as const,
    assignmentActive,
    bootstrapAdmin,
    assignedAt: assignment?.createdAt ?? null,
    revokedAt: assignment?.revokedAt ?? null,
  };
}

async function verifiedBootstrapAdminIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const email of allowlistedAdminEmails()) {
    const matches = await findVerifiedClerkUsersByEmail(email);
    for (const user of matches) ids.add(user.id);
  }
  return ids;
}

router.get("/admin/platform-admins/users", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const query = FindAdminPlatformUsersQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  try {
    const users = await findVerifiedClerkUsersByEmail(query.data.email);
    const items = await Promise.all(users.map(platformAdminUserDto));
    res.json(FindAdminPlatformUsersResponse.parse({ items }));
  } catch (error) {
    req.log.error({ err: error }, "Platform-admin user lookup failed");
    res.status(503).json({ error: "Clerk or the database could not verify platform-admin access. Try again shortly." });
  }
});

router.post("/admin/platform-admins/:userId/grant", async (req, res): Promise<void> => {
  const params = GrantPlatformAdminParams.safeParse(req.params);
  const body = GrantPlatformAdminBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid administrator grant." });
    return;
  }
  const reason = body.data.reason.trim();
  if (!reason) { res.status(400).json({ error: "A nonempty audit reason is required." }); return; }
  let user: ClerkUserRecord;
  try {
    user = await fetchClerkUser(params.data.userId);
  } catch (error) {
    const failure = clerkLookupFailure(error);
    res.status(failure.status).json({ error: failure.message });
    return;
  }
  const email = verifiedPrimaryEmail(user);
  if (!email) { res.status(400).json({ error: "The Clerk user's primary email must be verified before granting administrator access." }); return; }
  if (emailIsBootstrapAdmin(email)) {
    res.status(409).json({ error: "This administrator is managed by ADMIN_EMAILS and does not need a persistent assignment." });
    return;
  }

  try {
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(719342001)`);
      const now = new Date();
      const [assignment] = await tx.insert(platformAdminAssignmentsTable).values({
        clerkUserId: user.id,
        verifiedEmailSnapshot: email,
        assignedByClerkUserId: actor(req),
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      }).onConflictDoUpdate({
        target: platformAdminAssignmentsTable.clerkUserId,
        set: {
          verifiedEmailSnapshot: email,
          assignedByClerkUserId: actor(req),
          updatedAt: now,
          revokedAt: null,
        },
      }).returning();
      await tx.insert(adminAuditLogTable).values({
        actor: actor(req),
        action: "platform_admin.granted",
        target: `platform-admin:${user.id}`,
        details: platformAdminAuditDetails(email, reason),
      });
      return assignment;
    });
    res.json(GrantPlatformAdminResponse.parse({
      userId: user.id, email, effectiveRole: "platform_admin", assignmentActive: true,
      bootstrapAdmin: false, assignedAt: saved.createdAt, revokedAt: null,
    }));
  } catch (error) {
    req.log.error({ err: error, userId: user.id }, "Platform-admin grant failed");
    res.status(503).json({ error: "The administrator assignment could not be saved. Try again shortly." });
  }
});

router.post("/admin/platform-admins/:userId/revoke", async (req, res): Promise<void> => {
  const params = RevokePlatformAdminParams.safeParse(req.params);
  const body = RevokePlatformAdminBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid administrator revocation." });
    return;
  }
  const reason = body.data.reason.trim();
  if (!reason) { res.status(400).json({ error: "A nonempty audit reason is required." }); return; }
  let user: ClerkUserRecord;
  try {
    user = await fetchClerkUser(params.data.userId);
  } catch (error) {
    const failure = clerkLookupFailure(error);
    res.status(failure.status).json({ error: failure.message });
    return;
  }
  const email = verifiedPrimaryEmail(user);
  if (!email) { res.status(400).json({ error: "The Clerk user's primary email must be verified before changing administrator access." }); return; }
  if (emailIsBootstrapAdmin(email)) {
    res.status(409).json({ error: "ADMIN_EMAILS bootstrap administrators are non-revocable." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(719342001)`);
      const [assignment] = await tx.select().from(platformAdminAssignmentsTable)
        .where(and(
          eq(platformAdminAssignmentsTable.clerkUserId, user.id),
          isNull(platformAdminAssignmentsTable.revokedAt),
        )).for("update").limit(1);
      if (!assignment) return { outcome: "not_found" as const };

      const activeAssignments = await tx.select({ clerkUserId: platformAdminAssignmentsTable.clerkUserId })
        .from(platformAdminAssignmentsTable).where(isNull(platformAdminAssignmentsTable.revokedAt));
      const existingAssignments = await existingClerkUserIds(activeAssignments.map((row) => row.clerkUserId));
      const bootstrapIds = await verifiedBootstrapAdminIds();
      if (remainingEffectiveAdminCount(
        [...existingAssignments], bootstrapIds, user.id,
      ) < 1) return { outcome: "last_admin" as const };

      const now = new Date();
      const [revoked] = await tx.update(platformAdminAssignmentsTable)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(platformAdminAssignmentsTable.clerkUserId, user.id)).returning();
      await tx.insert(adminAuditLogTable).values({
        actor: actor(req),
        action: "platform_admin.revoked",
        target: `platform-admin:${user.id}`,
        details: platformAdminAuditDetails(email, reason),
      });
      return { outcome: "revoked" as const, assignment: revoked };
    });
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "This user has no active platform-admin assignment." });
      return;
    }
    if (result.outcome === "last_admin") {
      res.status(409).json({ error: "The last effective platform administrator cannot be removed." });
      return;
    }
    res.json(RevokePlatformAdminResponse.parse({
      userId: user.id, email, effectiveRole: "user", assignmentActive: false,
      bootstrapAdmin: false, assignedAt: result.assignment.createdAt, revokedAt: result.assignment.revokedAt,
    }));
  } catch (error) {
    req.log.error({ err: error, userId: user.id }, "Platform-admin revocation failed");
    res.status(503).json({ error: "The administrator revocation could not be verified or saved. Try again shortly." });
  }
});

async function audit(req: Parameters<Parameters<IRouter["get"]>[1]>[0], action: string, target: string, details: string) {
  await db.insert(adminAuditLogTable).values({ actor: actor(req), action, target, details });
}

function routeMerchantId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function adminMerchantControlsDto(merchant: typeof merchantsTable.$inferSelect) {
  const [usageRows, limitRows] = await Promise.all([
    db.select({
      action: verificationUsageReservationsTable.action,
      currency: verificationUsageReservationsTable.currency,
      confirmedAmount: sql<number>`coalesce(sum(${verificationUsageReservationsTable.amount}), 0)::numeric`,
    }).from(verificationUsageReservationsTable).where(and(
      eq(verificationUsageReservationsTable.merchantId, merchant.id),
      eq(verificationUsageReservationsTable.status, "committed"),
    )).groupBy(verificationUsageReservationsTable.action, verificationUsageReservationsTable.currency),
    db.select().from(verificationTierLimitsTable)
      .where(eq(verificationTierLimitsTable.tier, verificationTierForMerchant(merchant))),
  ]);
  return {
    merchantId: merchant.id,
    businessName: merchant.businessName,
    status: merchant.status,
    controls: normalizeMerchantActionControls(merchant.merchantActionControls),
    payoutSafety: normalizePayoutSafetySettings(merchant.payoutSafetySettings),
    usage: usageRows.map((row) => ({
      action: row.action,
      currency: row.currency,
      confirmedAmount: Number(row.confirmedAmount ?? 0),
      basis: "committed" as const,
    })),
    limits: limitRows.map((row) => ({
      tier: row.tier,
      currency: row.currency,
      collectionPerTransactionLimit: row.collectionPerTransactionLimit,
      collectionDailyLimit: row.collectionDailyLimit,
      collectionMonthlyLimit: row.collectionMonthlyLimit,
      payoutLimit: row.payoutLimit,
      conversionLimit: row.conversionLimit,
    })),
    updatedAt: merchant.updatedAt,
  };
}

type AdminMerchantDtoRow = {
  id: number;
  businessName: string;
  shopName: string | null;
  shopLogoUrl: string | null;
  country: string;
  baseCurrency: string;
  registrationNumber: string | null;
  status: string;
  applicationDetails: MerchantApplicationDetails | null;
  applicationStatus: string;
  applicationRequestedInfo: string | null;
  applicationRequestId: string | null;
  applicationSubmittedAt: Date | null;
  applicationReviewedAt: Date | null;
  kycStatus: string;
  kycRequestedInfo: string | null;
  kybStatus: string;
  kybRequestedInfo: string | null;
  paymentsEnabled: boolean;
  apiAccessEnabled: boolean;
  payoutsEnabled: boolean;
  refundsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  ownerClerkId: string;
  riskNote: string | null;
  diditSessionId: string | null;
  diditKybSessionId: string | null;
  verificationUpdatedAt: Date | null;
  kybVerificationUpdatedAt: Date | null;
};

function safeShopLogoUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const localHttp = url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function merchantDto(row: AdminMerchantDtoRow) {
  return {
    id: row.id, businessName: row.businessName, shopName: row.shopName,
    shopLogoUrl: safeShopLogoUrl(row.shopLogoUrl), country: row.country,
    baseCurrency: row.baseCurrency, registrationNumber: row.registrationNumber,
    status: row.status, kycStatus: row.kycStatus, kybStatus: row.kybStatus, createdAt: row.createdAt,
    applicationDetails: row.applicationDetails,
    applicationStatus: row.applicationStatus,
    applicationRequestedInfo: row.applicationRequestedInfo,
    applicationRequestId: row.applicationRequestId,
    applicationSubmittedAt: row.applicationSubmittedAt,
    applicationReviewedAt: row.applicationReviewedAt,
    kycRequestedInfo: row.kycRequestedInfo,
    kybRequestedInfo: row.kybRequestedInfo,
    ownerUserId: row.ownerClerkId, riskNote: row.riskNote, diditSessionId: row.diditSessionId,
    paymentsEnabled: row.paymentsEnabled, apiAccessEnabled: row.apiAccessEnabled,
    payoutsEnabled: row.payoutsEnabled, refundsEnabled: row.refundsEnabled,
    diditKybSessionId: row.diditKybSessionId,
    verificationUpdatedAt: row.verificationUpdatedAt,
    kybVerificationUpdatedAt: row.kybVerificationUpdatedAt,
    updatedAt: row.updatedAt,
  };
}

function adminMerchantSelect() {
  return {
    id: merchantsTable.id,
    businessName: merchantsTable.businessName,
    shopName: merchantsTable.shopName,
    shopLogoUrl: merchantsTable.shopLogoUrl,
    country: merchantsTable.country,
    baseCurrency: merchantsTable.baseCurrency,
    registrationNumber: merchantsTable.registrationNumber,
    status: merchantsTable.status,
    applicationDetails: merchantsTable.applicationDetails,
    applicationStatus: merchantsTable.applicationStatus,
    applicationRequestedInfo: merchantsTable.applicationRequestedInfo,
    applicationRequestId: sql<string | null>`to_jsonb(${merchantsTable})->>'application_request_id'`,
    applicationSubmittedAt: merchantsTable.applicationSubmittedAt,
    applicationReviewedAt: merchantsTable.applicationReviewedAt,
    kycStatus: merchantsTable.kycStatus,
    kycRequestedInfo: sql<string | null>`to_jsonb(${merchantsTable})->>'kyc_requested_info'`,
    // Keep compatibility with databases that have not yet added these columns.
    kybStatus: sql<string>`coalesce(to_jsonb(${merchantsTable})->>'kyb_status', 'not_started')`,
    kybRequestedInfo: sql<string | null>`to_jsonb(${merchantsTable})->>'kyb_requested_info'`,
    diditKybSessionId: sql<string | null>`to_jsonb(${merchantsTable})->>'didit_kyb_session_id'`,
    verificationUpdatedAt: sql<Date | null>`nullif(to_jsonb(${merchantsTable})->>'verification_updated_at', '')::timestamptz`,
    kybVerificationUpdatedAt: sql<Date | null>`nullif(to_jsonb(${merchantsTable})->>'kyb_verification_updated_at', '')::timestamptz`,
    paymentsEnabled: merchantsTable.paymentsEnabled,
    apiAccessEnabled: merchantsTable.apiAccessEnabled,
    payoutsEnabled: merchantsTable.payoutsEnabled,
    refundsEnabled: merchantsTable.refundsEnabled,
    createdAt: merchantsTable.createdAt,
    updatedAt: merchantsTable.updatedAt,
    ownerClerkId: merchantsTable.ownerClerkId,
    riskNote: merchantsTable.riskNote,
    diditSessionId: merchantsTable.diditSessionId,
  };
}

function clerkTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fxDto(row: typeof fxRatesTable.$inferSelect) {
  return {
    id: row.id, from: row.fromCurrency, to: row.toCurrency, rate: Number(row.rate),
    active: row.active, source: row.source, effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt, createdAt: row.createdAt,
  };
}

function feeDto(row: typeof feeSchedulesTable.$inferSelect) {
  return {
    id: row.id, merchantId: row.merchantId, percentage: Number(row.percentage),
    flatAmount: Number(row.flatAmount), currency: row.currency,
    fxMarkupBps: row.fxMarkupBps, updatedAt: row.updatedAt,
  };
}

function settingsDto(row: typeof platformSettingsTable.$inferSelect) {
  return {
    newMerchantSignups: row.newMerchantSignups,
    paymentsEnabled: row.paymentsEnabled,
    payoutsEnabled: row.payoutsEnabled,
    refundsEnabled: row.refundsEnabled,
    apiAccessEnabled: row.apiAccessEnabled,
    kycRequired: row.kycRequired,
    platformName: row.platformName,
    baseCurrency: row.baseCurrency,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    contactAddress: row.contactAddress,
    contactWhatsapp: row.contactWhatsapp,
    logoUrl: row.logoUrl,
    faviconUrl: row.faviconUrl,
    walletFxCurrencySpreads: row.walletFxCurrencySpreads ?? {},
  };
}

const defaultSettings = {
  newMerchantSignups: true, paymentsEnabled: true, payoutsEnabled: true,
  refundsEnabled: true, apiAccessEnabled: true, kycRequired: true,
  platformName: "Greenpay", baseCurrency: "USD",
  contactEmail: "support@greenpay.africa", contactPhone: "",
  contactAddress: "", contactWhatsapp: "", logoUrl: null, faviconUrl: null,
  walletFxCurrencySpreads: {},
};

async function credentialDto(provider: typeof providers[number]) {
  const stored = await readProviderCredentials(provider);
  const fields = await Promise.all(providerCredentialFields(provider).map(async (name) => {
    const value = await providerCredential(provider, name) ??
      (provider === "payhero" && name === "PAYHERO_CHANNEL_ID"
        ? stored?.credentials.PAYHERO_CHANNEL_ID?.trim()
        : undefined) ?? "";
    return {
      name, present: Boolean(value),
      masked: value ? `${"•".repeat(Math.min(8, Math.max(4, value.length - 4)))}${value.slice(-4)}` : "",
    };
  }));
  const payheroLegacyAuth = provider === "payhero"
    ? await providerCredential("payhero", "PAYHERO_BASIC_AUTH")
    : null;
  const configured = provider === "paystack"
    ? fields.some((field) => field.name === "PAYSTACK_SECRET_KEY" && field.present)
    : provider === "payhero"
      ? ((fields.some((field) => field.name === "PAYHERO_USERNAME" && field.present) &&
          fields.some((field) => field.name === "PAYHERO_PASSWORD" && field.present)) || Boolean(payheroLegacyAuth)) &&
        fields.some((field) => field.name === "PAYHERO_CHANNEL_ID" && field.present)
      : provider === "didit"
        ? fields.some((field) => field.name === "DIDIT_API_KEY" && field.present) &&
          fields.some((field) => field.name === "DIDIT_WORKFLOW_ID" && field.present) &&
          fields.some((field) => field.name === "DIDIT_KYB_WORKFLOW_ID" && field.present)
        : provider === "currencyapi"
          ? fields.some((field) => field.name === "CURRENCYAPI_API_KEY" && field.present)
        : provider === "cloudinary"
          ? fields.some((field) => field.name === "CLOUDINARY_CLOUD_NAME" && field.present) &&
            fields.some((field) => field.name === "CLOUDINARY_API_KEY" && field.present) &&
            fields.some((field) => field.name === "CLOUDINARY_API_SECRET" && field.present)
          : fields.some((field) => field.name === "PAYZAAPI_API_KEY" && field.present) ||
            (fields.some((field) => field.name === "PAYZA_PUBLIC_KEY" && field.present) &&
             fields.some((field) => field.name === "PAYZA_SECRET_KEY" && field.present));
  const payzaConfigured = fields.some((field) => field.name === "PAYZA_PUBLIC_KEY" && field.present) &&
    fields.some((field) => field.name === "PAYZA_SECRET_KEY" && field.present);
  return {
    provider, configured: (provider === "payzaapi" ? payzaConfigured : configured) && (stored?.enabled ?? true),
    enabled: stored?.enabled ?? configured, fields,
    updatedAt: stored?.updatedAt ?? null,
    storage: stored ? "encrypted_vault" as const : configured ? "environment" as const : "not_configured" as const,
  };
}

router.get("/admin/summary", async (_req, res): Promise<void> => {
  const [merchants] = await db.select({
    total: sql<number>`count(*)::int`,
    active: sql<number>`count(*) filter (where ${merchantsTable.status} = 'active')::int`,
    suspended: sql<number>`count(*) filter (where ${merchantsTable.status} = 'suspended')::int`,
    pendingKyc: sql<number>`count(*) filter (where ${merchantsTable.kycStatus} in ('pending','in_review'))::int`,
  }).from(merchantsTable);
  const [keys] = await db.select({ count: sql<number>`count(*)::int` }).from(merchantApiKeysTable)
    .where(isNull(merchantApiKeysTable.revokedAt));
  const [credentials] = await db.select({ count: sql<number>`count(*)::int` }).from(providerCredentialsTable)
    .where(eq(providerCredentialsTable.enabled, true));
  const [transactions] = await db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable);
  res.json(GetAdminSummaryResponse.parse({
    totalMerchants: Number(merchants?.total ?? 0), activeMerchants: Number(merchants?.active ?? 0),
    pendingKyc: Number(merchants?.pendingKyc ?? 0), suspendedMerchants: Number(merchants?.suspended ?? 0),
    activeApiKeys: Number(keys?.count ?? 0), credentialProviders: Number(credentials?.count ?? 0),
    totalTransactions: Number(transactions?.count ?? 0),
  }));
});

router.get("/admin/merchants", async (req, res): Promise<void> => {
  const parsed = ListAdminMerchantsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const conditions = [];
  if (parsed.data.status) conditions.push(eq(merchantsTable.status, parsed.data.status));
  if (parsed.data.kycStatus) conditions.push(eq(merchantsTable.kycStatus, parsed.data.kycStatus));
  if (parsed.data.search) conditions.push(ilike(merchantsTable.businessName, `%${parsed.data.search}%`));
  try {
    const rows = await db.select(adminMerchantSelect()).from(merchantsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(merchantsTable.createdAt))
      .limit(1000);
    const response = ListAdminMerchantsResponse.safeParse({ items: rows.map(merchantDto) });
    if (!response.success) {
      req.log.error({ issues: response.error.issues }, "Admin merchant list failed response validation");
      res.status(500).json({ error: "Merchant records could not be returned." });
      return;
    }
    res.json(response.data);
  } catch (error) {
    req.log.error({ err: error }, "Could not load admin merchant list");
    res.status(500).json({ error: "Merchant records could not be loaded. Try again shortly." });
  }
});

router.get("/admin/merchants/:merchantId/application-attachments", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "private, no-store");
  const params = ListAdminMerchantApplicationAttachmentsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [merchant] = await db.select({ id: merchantsTable.id }).from(merchantsTable)
    .where(eq(merchantsTable.id, params.data.merchantId)).limit(1);
  if (!merchant) { res.status(404).json({ error: "Merchant not found." }); return; }
  const rows = await db.select().from(merchantApplicationAttachmentsTable).where(
    eq(merchantApplicationAttachmentsTable.merchantId, merchant.id),
  ).orderBy(merchantApplicationAttachmentsTable.createdAt);
  res.json(ListAdminMerchantApplicationAttachmentsResponse.parse({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      size: row.size,
      contentType: row.contentType,
      createdAt: row.createdAt,
      direction: row.requestId ? "requested" : "submitted",
      requestId: row.requestId,
      downloadPath: `/api/admin/merchants/${merchant.id}/application-attachments/${row.id}/download`,
    })),
  }));
});

router.get("/admin/merchants/:merchantId/application-attachments/:attachmentId/download", async (req, res): Promise<void> => {
  const params = DownloadAdminMerchantApplicationAttachmentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [attachment] = await db.select().from(merchantApplicationAttachmentsTable).where(and(
    eq(merchantApplicationAttachmentsTable.id, params.data.attachmentId),
    eq(merchantApplicationAttachmentsTable.merchantId, params.data.merchantId),
  )).limit(1);
  if (!attachment) { res.status(404).json({ error: "Application attachment was not found for this merchant." }); return; }
  try {
    const file = await getPrivateCaseObject(attachment.objectPath, {
      size: attachment.size,
      contentType: attachment.contentType as CaseFileType,
      sha256: attachment.sha256,
    });
    const safeName = attachment.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Length", String(attachment.size));
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    file.createReadStream().pipe(res);
  } catch (error) {
    req.log.error({ err: error, merchantId: params.data.merchantId, attachmentId: attachment.id }, "Private application attachment download failed");
    if (!res.headersSent) res.status(503).json({ error: "The private application attachment is unavailable." });
  }
});

router.post("/admin/merchants/:merchantId/application-request-attachments/upload-intent", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const parsed = CreateAdminMerchantApplicationRequestAttachmentUploadIntentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.data.requestId)) {
    res.status(400).json({ error: "A valid request ID is required." });
    return;
  }
  if (parsed.data.size > CASE_FILE_MAX_BYTES || !CASE_FILE_CONTENT_TYPES.has(parsed.data.contentType)) {
    res.status(413).json({ error: "Choose a PDF, PNG, or JPEG file no larger than 10 MB." });
    return;
  }
  let name: string;
  try { name = caseAttachmentName(parsed.data.name, parsed.data.contentType); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid filename." }); return; }
  const [merchant] = await db.select({
    id: merchantsTable.id,
    applicationStatus: merchantsTable.applicationStatus,
  }).from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) { res.status(404).json({ error: "Merchant not found." }); return; }
  if (merchant.applicationStatus !== "awaiting_review") {
    res.status(409).json({ error: "Only applications awaiting review can receive a document request." });
    return;
  }

  const expired = await db.select().from(merchantApplicationUploadIntentsTable).where(and(
    eq(merchantApplicationUploadIntentsTable.merchantId, merchantId),
    eq(merchantApplicationUploadIntentsTable.requestId, parsed.data.requestId),
    isNull(merchantApplicationUploadIntentsTable.consumedAt),
    lt(merchantApplicationUploadIntentsTable.expiresAt, new Date()),
  ));
  for (const intent of expired) await deletePrivateCaseObject(intent.objectPath);
  if (expired.length) {
    await db.delete(merchantApplicationUploadIntentsTable)
      .where(inArray(merchantApplicationUploadIntentsTable.id, expired.map(({ id }) => id)));
  }
  const [existing] = await db.select({ count: sql<number>`count(*)::int` })
    .from(merchantApplicationAttachmentsTable).where(and(
      eq(merchantApplicationAttachmentsTable.merchantId, merchantId),
      eq(merchantApplicationAttachmentsTable.requestId, parsed.data.requestId),
    ));
  const activeIntents = await db.select({ id: merchantApplicationUploadIntentsTable.id })
    .from(merchantApplicationUploadIntentsTable).where(and(
      eq(merchantApplicationUploadIntentsTable.merchantId, merchantId),
      eq(merchantApplicationUploadIntentsTable.requestId, parsed.data.requestId),
      isNull(merchantApplicationUploadIntentsTable.consumedAt),
      gte(merchantApplicationUploadIntentsTable.expiresAt, new Date()),
    ));
  if (Number(existing?.count ?? 0) + activeIntents.length >= MAX_APPLICATION_REQUEST_ATTACHMENTS) {
    res.status(409).json({ error: "Attach no more than five files to one document request." });
    return;
  }

  let objectPath: string | undefined;
  try {
    const upload = await createPrivateApplicationUpload(merchantId, parsed.data.contentType as CaseFileType);
    objectPath = upload.objectPath;
    const token = randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Math.min(upload.expiresAt.getTime(), Date.now() + APPLICATION_REQUEST_UPLOAD_TTL_MS));
    await db.insert(merchantApplicationUploadIntentsTable).values({
      token,
      merchantId,
      requestId: parsed.data.requestId,
      objectPath: upload.objectPath,
      name,
      contentType: parsed.data.contentType,
      size: parsed.data.size,
      expiresAt,
    });
    res.status(201).json(CreateAdminMerchantApplicationRequestAttachmentUploadIntentResponse.parse({
      ...upload,
      uploadToken: token,
      expiresAt,
    }));
  } catch (error) {
    if (objectPath) await deletePrivateCaseObject(objectPath).catch(() => undefined);
    req.log.error({ err: error, merchantId }, "Could not create private merchant document-request attachment upload");
    res.status(503).json({ error: "Private application-file storage is temporarily unavailable. No file was attached." });
  }
});

router.delete("/admin/merchants/:merchantId/application-request-attachments/uploads/:uploadToken", async (req, res): Promise<void> => {
  const params = DeleteAdminMerchantApplicationRequestAttachmentUploadIntentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [intent] = await db.select().from(merchantApplicationUploadIntentsTable).where(and(
    eq(merchantApplicationUploadIntentsTable.merchantId, params.data.merchantId),
    eq(merchantApplicationUploadIntentsTable.token, params.data.uploadToken),
    isNull(merchantApplicationUploadIntentsTable.consumedAt),
  )).limit(1);
  if (!intent) { res.status(404).json({ error: "Unused document-request upload was not found." }); return; }
  try {
    await deletePrivateCaseObject(intent.objectPath);
    await db.delete(merchantApplicationUploadIntentsTable)
      .where(eq(merchantApplicationUploadIntentsTable.id, intent.id));
    res.sendStatus(204);
  } catch (error) {
    req.log.error({ err: error, merchantId: params.data.merchantId }, "Could not cancel private merchant document-request attachment upload");
    res.status(503).json({ error: "The temporary private upload could not be canceled." });
  }
});

router.get("/admin/merchants/:id", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = GetAdminMerchantDetailsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [row] = await db.select(adminMerchantSelect()).from(merchantsTable)
    .where(eq(merchantsTable.id, params.data.id)).limit(1);
  if (!row) { res.status(404).json({ error: "Merchant not found." }); return; }

  let owner: ClerkUserRecord | null;
  try {
    owner = await fetchClerkUser(row.ownerClerkId);
  } catch (error) {
    if (error instanceof ClerkApiError && error.status === 404) {
      owner = null;
      req.log.warn({ merchantId: row.id }, "Merchant owner was not found in Clerk");
    } else {
      req.log.error({ err: error, merchantId: row.id }, "Could not load merchant owner contact details");
      res.status(503).json({ error: "Owner contact details could not be verified. Try again shortly." });
      return;
    }
  }

  const verifiedPhones = owner ? verifiedPhoneNumbers(owner) : [];
  const response = GetAdminMerchantDetailsResponse.safeParse({
    merchant: merchantDto(row),
    owner: {
      userId: row.ownerClerkId,
      lookupStatus: owner ? "available" : "not_found",
      firstName: owner?.first_name ?? null,
      lastName: owner?.last_name ?? null,
      primaryEmail: owner ? verifiedPrimaryEmail(owner) : null,
      verifiedEmails: owner ? verifiedEmailAddresses(owner) : [],
      primaryPhone: owner ? verifiedPrimaryPhoneNumber(owner) : null,
      verifiedPhones,
      createdAt: owner ? clerkTimestamp(owner.created_at) : null,
      lastSignInAt: owner ? clerkTimestamp(owner.last_sign_in_at) : null,
    },
  });
  if (!response.success) {
    req.log.error({ issues: response.error.issues, merchantId: row.id }, "Admin merchant details failed response validation");
    res.status(500).json({ error: "Merchant details could not be returned." });
    return;
  }
  res.json(response.data);
});

router.get("/admin/merchants/:merchantId/controls", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) { res.status(404).json({ error: "Merchant not found." }); return; }
  res.json(await adminMerchantControlsDto(merchant));
});

router.put("/admin/merchants/:merchantId/controls", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 1000) {
    res.status(400).json({ error: "A nonempty audit reason of at most 1000 characters is required." }); return;
  }

  let controlsPatch: Partial<Record<MerchantActionKey, boolean>> | undefined;
  if (body.controls !== undefined) {
    if (!body.controls || typeof body.controls !== "object" || Array.isArray(body.controls)) {
      res.status(400).json({ error: "Controls must be an object of action booleans." }); return;
    }
    const rawControls = body.controls as Record<string, unknown>;
    const unknown = Object.keys(rawControls).filter((key) => !MERCHANT_ACTION_KEYS.includes(key as MerchantActionKey));
    if (unknown.length || Object.values(rawControls).some((value) => typeof value !== "boolean")) {
      res.status(400).json({ error: "Controls contain an unknown action or non-boolean value." }); return;
    }
    controlsPatch = rawControls as Partial<Record<MerchantActionKey, boolean>>;
  }

  let safetyPatch: { largePayoutThresholds: Record<string, number>; dualApprovalEnabled: boolean } | undefined;
  if (body.payoutSafety !== undefined) {
    if (!body.payoutSafety || typeof body.payoutSafety !== "object" || Array.isArray(body.payoutSafety)) {
      res.status(400).json({ error: "Payout safety must be an object." }); return;
    }
    const rawSafety = body.payoutSafety as Record<string, unknown>;
    if (rawSafety.destinationChangeRequiresDualApproval !== undefined &&
        rawSafety.destinationChangeRequiresDualApproval !== true) {
      res.status(400).json({ error: "Dual approval for changed payout destinations is mandatory and cannot be disabled." }); return;
    }
    const thresholds = rawSafety.largePayoutThresholds;
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds) ||
        typeof rawSafety.dualApprovalEnabled !== "boolean") {
      res.status(400).json({ error: "Provide currency-specific positive payout thresholds and a dual-approval setting." }); return;
    }
    const normalizedThresholds: Record<string, number> = {};
    for (const [rawCurrency, amount] of Object.entries(thresholds as Record<string, unknown>)) {
      const currency = rawCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "Every payout threshold needs a three-letter currency and positive finite amount." }); return;
      }
      normalizedThresholds[currency] = amount;
    }
    safetyPatch = {
      largePayoutThresholds: normalizedThresholds,
      dualApprovalEnabled: rawSafety.dualApprovalEnabled,
    };
  }
  if (!controlsPatch && !safetyPatch) {
    res.status(400).json({ error: "Provide at least one merchant control or payout-safety setting to update." }); return;
  }

  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
    if (!current) return null;
    const before = {
      controls: normalizeMerchantActionControls(current.merchantActionControls),
      payoutSafety: normalizePayoutSafetySettings(current.payoutSafetySettings),
    };
    const controls = controlsPatch
      ? { ...normalizeMerchantActionControls(current.merchantActionControls), ...controlsPatch }
      : current.merchantActionControls;
    const oldSafety = normalizePayoutSafetySettings(current.payoutSafetySettings);
    const payoutSafety = safetyPatch
      ? {
          ...oldSafety,
          ...safetyPatch,
          destinationChangeRequiresDualApproval: true as const,
        }
      : current.payoutSafetySettings;
    const changedFields = [
      ...(controlsPatch ? [`controls(${Object.keys(controlsPatch).join(",")})`] : []),
      ...(safetyPatch ? ["payoutSafety"] : []),
    ];
    const [saved] = await tx.update(merchantsTable).set({
      ...(controlsPatch ? { merchantActionControls: controls } : {}),
      ...(safetyPatch ? { payoutSafetySettings: payoutSafety } : {}),
      updatedAt: new Date(),
    }).where(eq(merchantsTable.id, merchantId)).returning();
    await tx.insert(adminAuditLogTable).values({
      actor: actor(req),
      action: "merchant.controls.updated",
      target: `merchant:${merchantId}`,
      details: JSON.stringify({
        changedFields,
        reason,
        before,
        after: {
          controls: controlsPatch ? controls : before.controls,
          payoutSafety: safetyPatch ? payoutSafety : before.payoutSafety,
        },
      }),
    });
    return saved;
  });
  if (!result) { res.status(404).json({ error: "Merchant not found." }); return; }
  res.json(await adminMerchantControlsDto(result));
});

router.post("/admin/merchants/:merchantId/status", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const status = body.status;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (status !== "pending" && status !== "active" && status !== "suspended") {
    res.status(400).json({ error: "Merchant status must be pending, active, or suspended." }); return;
  }
  if (!reason || reason.length > 1000) {
    res.status(400).json({ error: "A nonempty audit reason of at most 1000 characters is required." }); return;
  }
  const saved = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
    if (!current) return { kind: "not_found" as const };
    if (status === "active" && ["awaiting_review", "more_info_required"].includes(current.applicationStatus)) {
      return { kind: "application_pending" as const };
    }
    if (current.status === status) return { kind: "unchanged" as const };
    const [updated] = await tx.update(merchantsTable).set({ status, updatedAt: new Date() })
      .where(eq(merchantsTable.id, merchantId)).returning();
    const action = status === "pending" ? "merchant.pending" : status === "suspended" ? "merchant.suspended" : "merchant.reactivated";
    await tx.insert(adminAuditLogTable).values({
      actor: actor(req),
      action,
      target: `merchant:${merchantId}`,
      details: `Status changed from ${current.status} to ${status}. Reason: ${reason}`,
    });
    return { kind: "saved" as const, updated, previousStatus: current.status };
  });
  if (saved.kind === "not_found") { res.status(404).json({ error: "Merchant not found." }); return; }
  if (saved.kind === "application_pending") {
    res.status(409).json({ error: "A submitted business application must be approved before activating the merchant." });
    return;
  }
  if (saved.kind === "unchanged") {
    res.status(200).json({ merchantId, status, reason, updatedAt: new Date() });
    return;
  }
  if (saved.previousStatus !== saved.updated.status) {
    void notifyMerchantAccountAction({
      merchantId: saved.updated.id,
      ownerUserId: saved.updated.ownerClerkId,
      businessName: saved.updated.businessName,
      action: status === "pending" ? "pending" : status === "suspended" ? "suspended" : "active",
      eventKey: `merchant-status:${saved.updated.id}:${status}:${saved.updated.updatedAt.getTime()}`,
    }).catch((error) => {
      req.log.error({
        merchantId: saved.updated.id,
        errorKind: error instanceof Error ? error.name : "unknown",
      }, "Merchant status was updated, but its owner notification could not be queued");
    });
  }
  res.json({ merchantId: saved.updated.id, status: saved.updated.status, reason, updatedAt: saved.updated.updatedAt });
});

router.post("/admin/merchants/:merchantId/application-review", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const parsed = ReviewAdminMerchantApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tokens = parsed.data.attachmentUploadTokens ?? [];
  if (tokens.length > MAX_APPLICATION_REQUEST_ATTACHMENTS || new Set(tokens).size !== tokens.length) {
    res.status(400).json({ error: "Attach no more than five unique files to one document request." });
    return;
  }
  if (parsed.data.decision === "approve" && tokens.length) {
    res.status(400).json({ error: "Files can only be attached when requesting additional information." });
    return;
  }
  const requestedFilesId = parsed.data.decision === "request_information"
    ? parsed.data.requestId?.trim() || randomUUID()
    : null;
  const [preflight] = await db.select({ applicationStatus: merchantsTable.applicationStatus })
    .from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!preflight) { res.status(404).json({ error: "Merchant not found." }); return; }
  if (preflight.applicationStatus !== "awaiting_review") {
    res.status(409).json({ error: "Only applications awaiting review can be approved or sent back for information." });
    return;
  }
  let requestIntents: typeof merchantApplicationUploadIntentsTable.$inferSelect[] = [];
  const verifiedRequestFiles = new Map<string, Awaited<ReturnType<typeof verifyPrivateCaseObject>>>();
  if (tokens.length) {
    if (!parsed.data.requestId) {
      res.status(400).json({ error: "A request ID is required when attaching files." });
      return;
    }
    requestIntents = await db.select().from(merchantApplicationUploadIntentsTable).where(and(
      eq(merchantApplicationUploadIntentsTable.merchantId, merchantId),
      eq(merchantApplicationUploadIntentsTable.requestId, parsed.data.requestId),
      inArray(merchantApplicationUploadIntentsTable.token, tokens),
      isNull(merchantApplicationUploadIntentsTable.consumedAt),
      gte(merchantApplicationUploadIntentsTable.expiresAt, new Date()),
    ));
    if (requestIntents.length !== tokens.length) {
      res.status(409).json({ error: "One or more request-file uploads expired or were already used. Upload those files again." });
      return;
    }
    try {
      for (const intent of requestIntents) {
        const verified = await verifyPrivateCaseObject({
          objectPath: intent.objectPath,
          name: intent.name,
          size: intent.size,
          contentType: intent.contentType as CaseFileType,
        });
        verifiedRequestFiles.set(intent.token, verified);
      }
    } catch (error) {
      await Promise.allSettled(requestIntents.map((intent) => deletePrivateCaseObject(intent.objectPath)));
      await db.delete(merchantApplicationUploadIntentsTable)
        .where(inArray(merchantApplicationUploadIntentsTable.id, requestIntents.map(({ id }) => id)));
      res.status(400).json({ error: error instanceof Error ? error.message : "An attached file did not pass validation." });
      return;
    }
  }
  const reviewedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
    if (!current) return { kind: "not_found" as const };
    if (current.applicationStatus !== "awaiting_review") return { kind: "not_reviewable" as const };

    const approved = parsed.data.decision === "approve";
    const lockedIntents = tokens.length ? await tx.select().from(merchantApplicationUploadIntentsTable).where(and(
      eq(merchantApplicationUploadIntentsTable.merchantId, merchantId),
      eq(merchantApplicationUploadIntentsTable.requestId, parsed.data.requestId!),
      inArray(merchantApplicationUploadIntentsTable.token, tokens),
      isNull(merchantApplicationUploadIntentsTable.consumedAt),
      gte(merchantApplicationUploadIntentsTable.expiresAt, reviewedAt),
    )).for("update") : [];
    if (lockedIntents.length !== tokens.length) return { kind: "uploads_invalid" as const };
    for (const intent of lockedIntents) {
      const verified = verifiedRequestFiles.get(intent.token);
      if (!verified) return { kind: "uploads_invalid" as const };
      await tx.insert(merchantApplicationAttachmentsTable).values({
        merchantId,
        requestId: requestedFilesId,
        objectPath: verified.objectPath,
        name: verified.name,
        contentType: verified.contentType,
        size: verified.size,
        sha256: verified.sha256,
      });
      await tx.update(merchantApplicationUploadIntentsTable).set({ consumedAt: reviewedAt })
        .where(eq(merchantApplicationUploadIntentsTable.id, intent.id));
    }
    const [updated] = await tx.update(merchantsTable).set({
      applicationStatus: approved ? "approved" : "more_info_required",
      applicationRequestedInfo: approved ? null : parsed.data.reason.trim(),
      applicationRequestId: approved ? current.applicationRequestId : requestedFilesId,
      applicationReviewedAt: reviewedAt,
      applicationReviewedBy: actor(req),
      status: approved ? "active" : current.status,
      updatedAt: reviewedAt,
    }).where(eq(merchantsTable.id, merchantId)).returning();
    await tx.insert(adminAuditLogTable).values({
      actor: actor(req),
      action: approved ? "merchant.application_approved" : "merchant.application_information_requested",
      target: `merchant:${merchantId}`,
      details: `${parsed.data.reason.trim()}${tokens.length ? ` Attached files: ${tokens.length}.` : ""}`,
    });
    return { kind: "saved" as const, updated };
  });
  if (result.kind === "not_found") { res.status(404).json({ error: "Merchant not found." }); return; }
  if (result.kind === "not_reviewable") {
    res.status(409).json({ error: "Only applications awaiting review can be approved or sent back for information." });
    return;
  }
  if (result.kind === "uploads_invalid") {
    res.status(409).json({ error: "One or more request-file uploads changed or expired. Upload them again before saving the request." });
    return;
  }
  const ownerNotice = await notifyMerchantAccountAction({
    merchantId: result.updated.id,
    ownerUserId: result.updated.ownerClerkId,
    businessName: result.updated.businessName,
    action: parsed.data.decision === "approve" ? "application_approved" : "more_info_required",
    ...(parsed.data.decision === "request_information" ? { reason: parsed.data.reason.trim() } : {}),
    eventKey: `merchant-application:${result.updated.id}:${result.updated.applicationStatus}:${reviewedAt.getTime()}`,
  });
  if (!ownerNotice.notificationSaved) {
    req.log.error({
      merchantId: result.updated.id,
    }, "Application review was saved, but its owner in-app notification could not be saved");
  }
  if (ownerNotice.emailDeliveryState !== "queued" && ownerNotice.emailDeliveryState !== "sending" &&
      ownerNotice.emailDeliveryState !== "sent") {
    req.log.warn({
      merchantId: result.updated.id,
      emailDeliveryState: ownerNotice.emailDeliveryState,
    }, "Application review was saved with an in-app notice, but no owner email was queued");
  }
  res.json(ReviewAdminMerchantApplicationResponse.parse({
    merchantId: result.updated.id,
    applicationStatus: result.updated.applicationStatus,
    merchantStatus: result.updated.status,
    applicationRequestedInfo: result.updated.applicationRequestedInfo,
    applicationReviewedAt: result.updated.applicationReviewedAt,
  }));
});

router.post("/admin/merchants/:merchantId/verification-request", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchantId = routeMerchantId(req.params.merchantId ?? "");
  if (merchantId === null) { res.status(400).json({ error: "A valid merchant ID is required." }); return; }
  const parsed = CreateAdminMerchantVerificationRequestBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
    if (!current) return undefined;
    const requestedInfo = parsed.data.reason.trim();
    const updatedFields = parsed.data.kind === "kyc"
      ? {
          kycStatus: "reverification_required",
          kycRequestedInfo: requestedInfo,
          diditSessionId: null,
          diditSessionUrl: null,
          diditKind: current.diditKind === "kyc" ? null : current.diditKind,
          verificationUpdatedAt: now,
          updatedAt: now,
        }
      : {
          kybStatus: "reverification_required",
          kybRequestedInfo: requestedInfo,
          diditKybSessionId: null,
          diditKybSessionUrl: null,
          diditKind: current.diditKind === "kyb" ? null : current.diditKind,
          kybVerificationUpdatedAt: now,
          updatedAt: now,
        };
    const [updated] = await tx.update(merchantsTable).set(updatedFields)
      .where(eq(merchantsTable.id, merchantId)).returning();
    await tx.insert(adminAuditLogTable).values({
      actor: actor(req),
      action: `merchant.${parsed.data.kind}_reverification_requested`,
      target: `merchant:${merchantId}`,
      details: requestedInfo,
    });
    return { updated, requestedInfo };
  });
  if (!result) { res.status(404).json({ error: "Merchant not found." }); return; }

  const ownerNotice = await notifyMerchantAccountAction({
    merchantId: result.updated.id,
    ownerUserId: result.updated.ownerClerkId,
    businessName: result.updated.businessName,
    action: parsed.data.kind === "kyc" ? "kyc_reverification_required" : "kyb_reverification_required",
    reason: result.requestedInfo,
    eventKey: `merchant-verification:${result.updated.id}:${parsed.data.kind}:reverification:${now.getTime()}`,
  });
  if (!ownerNotice.notificationSaved) {
    req.log.error({ merchantId }, "Reverification was requested, but its owner in-app notification could not be saved");
  }
  if (ownerNotice.emailDeliveryState !== "queued" && ownerNotice.emailDeliveryState !== "sending" &&
      ownerNotice.emailDeliveryState !== "sent") {
    req.log.warn({
      merchantId,
      emailDeliveryState: ownerNotice.emailDeliveryState,
    }, "Reverification was requested with an in-app notice, but no owner email was queued");
  }
  res.json(CreateAdminMerchantVerificationRequestResponse.parse({
    merchantId,
    kind: parsed.data.kind,
    status: "reverification_required",
    requestedInfo: result.requestedInfo,
    updatedAt: now,
  }));
});

router.patch("/admin/merchants/:id", async (req, res): Promise<void> => {
  const params = UpdateAdminMerchantParams.safeParse(req.params);
  const parsed = UpdateAdminMerchantBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : parsed.error?.message ?? "Invalid merchant update." }); return;
  }
  if (parsed.data.status !== undefined) {
    res.status(400).json({ error: "Status changes require POST /admin/merchants/:merchantId/status with an audit reason." });
    return;
  }
  const patch = parsed.data as typeof parsed.data & Record<string, unknown>;
  const updates: Partial<typeof merchantsTable.$inferInsert> = { updatedAt: new Date() };
  for (const key of ["businessName", "riskNote", "baseCurrency", "paymentsEnabled", "apiAccessEnabled", "payoutsEnabled", "refundsEnabled"] as const) {
    const value = patch[key];
    if (value !== undefined) (updates as Record<string, unknown>)[key] = typeof value === "string" && key === "baseCurrency" ? value.toUpperCase() : value;
  }
  if (Object.keys(updates).length === 1) { res.status(400).json({ error: "Provide at least one merchant setting to update." }); return; }
  const [row] = await db.update(merchantsTable).set(updates).where(eq(merchantsTable.id, params.data.id)).returning();
  if (!row) { res.status(404).json({ error: "Merchant not found." }); return; }
  const keys = Object.keys(updates).filter((key) => key !== "updatedAt");
  await audit(req, "merchant.updated", `merchant:${row.id}`, `Changed ${keys.join(", ")}.`);
  res.json(UpdateAdminMerchantResponse.parse(merchantDto(row)));
});

router.get("/admin/fee-schedules", async (_req, res): Promise<void> => {
  const rows = await db.select().from(feeSchedulesTable).orderBy(feeSchedulesTable.merchantId);
  res.json(ListAdminFeeSchedulesResponse.parse({ items: rows.map(feeDto) }));
});

router.put("/admin/fee-schedules", async (req, res): Promise<void> => {
  const parsed = UpdateAdminFeeScheduleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (parsed.data.merchantId !== null) {
    const [merchant] = await db.select({ id: merchantsTable.id }).from(merchantsTable)
      .where(eq(merchantsTable.id, parsed.data.merchantId)).limit(1);
    if (!merchant) { res.status(404).json({ error: "Merchant not found." }); return; }
  }
  const values = {
    merchantId: parsed.data.merchantId, percentage: parsed.data.percentage,
    flatAmount: parsed.data.flatAmount, currency: parsed.data.currency.toUpperCase(),
    fxMarkupBps: parsed.data.fxMarkupBps, updatedAt: new Date(),
  };
  const existing = parsed.data.merchantId === null
    ? await db.select().from(feeSchedulesTable).where(isNull(feeSchedulesTable.merchantId)).limit(1)
    : await db.select().from(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, parsed.data.merchantId)).limit(1);
  const [row] = existing.length
    ? await db.update(feeSchedulesTable).set(values).where(eq(feeSchedulesTable.id, existing[0]!.id)).returning()
    : await db.insert(feeSchedulesTable).values(values).returning();
  await audit(req, "fee_schedule.updated", row.merchantId === null ? "fees:global" : `fees:merchant:${row.merchantId}`,
    `Fee schedule updated: ${row.percentage}% + ${row.flatAmount} ${row.currency}; FX markup ${row.fxMarkupBps} bps.`);
  res.json(UpdateAdminFeeScheduleResponse.parse(feeDto(row)));
});

router.get("/admin/fx-rates", async (_req, res): Promise<void> => {
  const rows = await db.select().from(fxRatesTable).orderBy(desc(fxRatesTable.effectiveAt)).limit(2000);
  res.json(ListAdminFxRatesResponse.parse({ items: rows.map(fxDto) }));
});

router.post("/admin/fx-rates", async (req, res): Promise<void> => {
  const parsed = CreateAdminFxRateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const from = parsed.data.from.toUpperCase(), to = parsed.data.to.toUpperCase();
  if (from === to) { res.status(400).json({ error: "An FX rate must use two different currencies." }); return; }
  if (parsed.data.expiresAt && parsed.data.expiresAt <= (parsed.data.effectiveAt ?? new Date())) {
    res.status(400).json({ error: "FX rate expiry must be later than its effective time." }); return;
  }
  const [row] = await db.insert(fxRatesTable).values({
    fromCurrency: from, toCurrency: to, rate: parsed.data.rate,
    source: parsed.data.source.trim(), effectiveAt: parsed.data.effectiveAt ?? new Date(),
    expiresAt: parsed.data.expiresAt ?? null, active: true,
  }).returning();
  await audit(req, "fx_rate.created", `fx:${row.id}`, `${from}/${to} rate created from ${row.source}.`);
  res.status(201).json(CreateAdminFxRateResponse.parse(fxDto(row)));
});

router.patch("/admin/fx-rates/:id", async (req, res): Promise<void> => {
  const params = UpdateAdminFxRateParams.safeParse(req.params);
  const parsed = UpdateAdminFxRateBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : parsed.error?.message ?? "Invalid exchange-rate request." }); return;
  }
  const updates: Partial<typeof fxRatesTable.$inferInsert> = {};
  if (parsed.data.rate !== undefined) updates.rate = parsed.data.rate;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;
  if (parsed.data.expiresAt !== undefined) updates.expiresAt = parsed.data.expiresAt;
  if (!Object.keys(updates).length) { res.status(400).json({ error: "Provide at least one exchange-rate field to update." }); return; }
  const [row] = await db.update(fxRatesTable).set(updates).where(eq(fxRatesTable.id, params.data.id)).returning();
  if (!row) { res.status(404).json({ error: "FX rate not found." }); return; }
  await audit(req, "fx_rate.updated", `fx:${row.id}`, `Changed ${Object.keys(updates).join(", ")}.`);
  res.json(UpdateAdminFxRateResponse.parse(fxDto(row)));
});

router.get("/admin/provider-credentials", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const items = await Promise.all(providers.map(credentialDto));
  res.json(ListAdminProviderCredentialsResponse.parse({ items, vaultReady: credentialVaultReady() }));
});

router.put("/admin/provider-credentials/:provider", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = SaveAdminProviderCredentialsParams.safeParse(req.params);
  const parsed = SaveAdminProviderCredentialsBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : parsed.error?.message ?? "Invalid credential request." }); return;
  }
  const allowed = providerCredentialFields(params.data.provider);
  const invalid = Object.keys(parsed.data.credentials).filter((key) => !allowed.includes(key));
  if (invalid.length) { res.status(400).json({ error: `Unsupported credential field(s): ${invalid.join(", ")}.` }); return; }
  const credentials = Object.fromEntries(Object.entries(parsed.data.credentials).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
  if (params.data.provider === "payhero" && !credentials.PAYHERO_CHANNEL_ID) {
    const stored = await readProviderCredentials("payhero");
    const savedChannelId = stored?.credentials.PAYHERO_CHANNEL_ID?.trim();
    const environmentChannelId = process.env.PAYHERO_CHANNEL_ID?.trim();
    const channelId = savedChannelId || environmentChannelId;
    if (channelId) credentials.PAYHERO_CHANNEL_ID = channelId;
  }
  const saved = await encryptProviderCredentials(params.data.provider, credentials, parsed.data.enabled, actor(req));
  const items = await Promise.all(providers.map(credentialDto));
  const item = items.find((entry) => entry.provider === params.data.provider);
  await audit(req, "provider_credentials.saved", `provider:${params.data.provider}`,
    `Credentials replaced; enabled=${saved.enabled}; fields=${Object.keys(credentials).join(",") || "none"}.`);
  res.json(SaveAdminProviderCredentialsResponse.parse(item));
});

router.delete("/admin/provider-credentials/:provider", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = DeleteAdminProviderCredentialsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  await encryptProviderCredentials(params.data.provider, {}, false, actor(req));
  await audit(req, "provider_credentials.deleted", `provider:${params.data.provider}`, "Stored credentials cleared and provider disabled, overriding environment credentials.");
  res.status(204).send(DeleteAdminProviderCredentialsResponse.parse(undefined));
});

router.get("/admin/platform-settings", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const settings = row ? settingsDto(row) : defaultSettings;
  res.json(GetAdminPlatformSettingsResponse.parse(settings));
});

router.patch("/admin/platform-settings", async (req, res): Promise<void> => {
  const parsed = UpdateAdminPlatformSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!Object.keys(parsed.data).length) { res.status(400).json({ error: "Provide at least one platform setting to update." }); return; }
  const updates = { ...parsed.data } as Partial<typeof platformSettingsTable.$inferInsert>;
  try {
    if (updates.platformName !== undefined) {
      updates.platformName = updates.platformName.trim();
      if (!updates.platformName || /[\u0000-\u001f\u007f]/.test(updates.platformName)) {
        res.status(400).json({ error: "Platform name must contain readable text." }); return;
      }
    }
    if (updates.baseCurrency !== undefined) {
      updates.baseCurrency = updates.baseCurrency.trim().toUpperCase();
      const { assertSupportedCurrency } = await import("../lib/greenpay-provider");
      assertSupportedCurrency(updates.baseCurrency);
    }
    if (updates.walletFxCurrencySpreads !== undefined) {
      const normalized: Record<string, number> = {};
      for (const [rawCurrency, spreadBps] of Object.entries(updates.walletFxCurrencySpreads)) {
        const currency = supportedCollectionCurrencyCode(rawCurrency);
        if (!currency || currency === "SLL" || !Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 10_000) {
          res.status(400).json({ error: "Wallet FX spreads must use a supported non-SLL currency and integer basis points from 0 to 10,000." });
          return;
        }
        if (normalized[currency] !== undefined) {
          res.status(400).json({ error: "Wallet FX spread currencies must be unique." });
          return;
        }
        normalized[currency] = spreadBps;
      }
      updates.walletFxCurrencySpreads = normalized;
    }
    for (const key of ["contactEmail", "contactPhone", "contactAddress", "contactWhatsapp"] as const) {
      if (updates[key] !== undefined) updates[key] = updates[key]!.trim();
    }
    if (updates.contactWhatsapp !== undefined) updates.contactWhatsapp = normalizeWhatsAppContact(updates.contactWhatsapp);
    if (updates.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.contactEmail)) {
      res.status(400).json({ error: "Contact email must be a valid email address." }); return;
    }
    updates.logoUrl = cleanPublicUrl(updates.logoUrl, "Logo URL");
    updates.faviconUrl = cleanPublicUrl(updates.faviconUrl, "Favicon URL");
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid platform branding." });
    return;
  }
  const existing = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const [row] = existing.length
    ? await db.update(platformSettingsTable).set({ ...updates, updatedAt: new Date() }).where(eq(platformSettingsTable.id, 1)).returning()
    : await db.insert(platformSettingsTable).values({ id: 1, ...updates }).returning();
  const spreadAudit = updates.walletFxCurrencySpreads
    ? ` Target-currency wallet FX spreads (bps): ${Object.entries(updates.walletFxCurrencySpreads).map(([currency, bps]) => `${currency}=${bps}`).join(", ") || "none"}.`
    : "";
  await audit(req, "platform_settings.updated", "platform", `Changed ${Object.keys(parsed.data).join(", ")}.${spreadAudit} The base currency is a display and onboarding default; existing balances were not converted.`);
  res.json(UpdateAdminPlatformSettingsResponse.parse(settingsDto(row)));
});

router.get("/admin/platform-settings/cloudinary-status", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const environment = await resolveCloudinaryEnvironment(providerCredential);
  res.json(GetAdminCloudinaryUploadStatusResponse.parse(cloudinaryUploadStatus(environment)));
});

router.post("/admin/platform-settings/upload-signature", async (_req, res): Promise<void> => {
  const environment = await resolveCloudinaryEnvironment(providerCredential);
  if (!cloudinaryUploadStatus(environment).configured) {
    res.status(503).json({
      error: "Cloudinary uploads are not configured. An administrator must add the Cloudinary credentials in Admin → Credentials.",
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const signedUpload = createCloudinaryUploadSignature("greenpay/platform", undefined, environment);
  res.json(CreateAdminCloudinaryUploadSignatureResponse.parse(signedUpload));
});

router.get("/admin/audit-log", async (req, res): Promise<void> => {
  const parsed = ListAdminAuditLogQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const perPage = 50;
  const conditions = [];
  if (parsed.data.user) conditions.push(ilike(adminAuditLogTable.actor, `%${parsed.data.user}%`));
  if (parsed.data.action) conditions.push(ilike(adminAuditLogTable.action, `%${parsed.data.action}%`));
  if (parsed.data.search) {
    const term = `%${parsed.data.search}%`;
    conditions.push(or(
      ilike(adminAuditLogTable.actor, term),
      ilike(adminAuditLogTable.action, term),
      ilike(adminAuditLogTable.target, term),
      ilike(adminAuditLogTable.details, term),
      ilike(adminAuditLogTable.route, term),
      ilike(adminAuditLogTable.method, term),
    )!);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(adminAuditLogTable).where(where);
  const rows = await db.select().from(adminAuditLogTable).where(where).orderBy(desc(adminAuditLogTable.createdAt))
    .limit(perPage).offset((parsed.data.page - 1) * perPage);
  res.json(ListAdminAuditLogResponse.parse({
    items: rows, page: parsed.data.page, total: Number(count?.count ?? 0),
  }));
});

export default router;