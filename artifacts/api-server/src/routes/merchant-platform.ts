import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetAdminVerificationLimitsResponse,
  CreateMerchantApiKeyBody, CreateMerchantApiKeyResponse, CreateMerchantKycSessionBody,
  CreateMerchantKycSessionResponse, CreateMerchantPaymentLinkBody, CreateMerchantPaymentLinkResponse,
  CreateMerchantProfileBody, CreateMerchantProfileResponse, CreateMerchantWebhookEndpointBody,
  CreateMerchantWebhookEndpointResponse, RevokeMerchantApiKeyResponse, DeleteMerchantPaymentLinkResponse,
  CreateMerchantCloudinaryUploadSignatureResponse, UpdateMerchantShopProfileBody,
  UpdateMerchantShopProfileResponse,
  DeleteMerchantWebhookEndpointResponse, GetAccessProfileResponse, GetMerchantFeesResponse,
  GetMerchantFxQuoteQueryParams, GetMerchantFxQuoteResponse, GetMerchantKycResponse,
  GetMerchantProfileResponse, ListDeveloperPaymentLinksResponse, ListDeveloperTransactionsQueryParams,
  ListDeveloperTransactionsResponse, ListMerchantApiKeysResponse, ListMerchantPaymentLinksResponse,
  ListMerchantTransactionsQueryParams, ListMerchantTransactionsResponse, ListMerchantWebhookEndpointsResponse,
  RevokeMerchantApiKeyParams, UpdateMerchantPaymentLinkBody, UpdateMerchantPaymentLinkParams,
  UpdateMerchantPaymentLinkResponse, DeleteMerchantPaymentLinkParams, DeleteMerchantWebhookEndpointParams,
  CreateDeveloperPaymentLinkResponse, CreateDeveloperTransactionBody, CreateDeveloperTransactionHeader,
  CreateDeveloperTransactionResponse, GetDeveloperTransactionParams, GetDeveloperTransactionResponse,
  VerifyDeveloperTransactionParams, VerifyDeveloperTransactionResponse, GetDeveloperFxQuoteQueryParams,
  GetDeveloperFxQuoteResponse, GetDeveloperFeesResponse,
  ListMerchantPayoutsResponse,
  UpdateAdminVerificationLimitsBody, UpdateAdminVerificationLimitsResponse,
} from "@workspace/api-zod";
import {
  adminAuditLogTable, db, developerIdempotencyTable, feeSchedulesTable, fxRatesTable, merchantApiKeysTable,
  merchantWebhookEndpointsTable, merchantsTable, paymentLinksTable, payoutsTable, transactionsTable,
  verificationTierLimitsTable,
} from "@workspace/db";
import { assertCollectionAmountPrecision, createCollection } from "../lib/greenpay-collection";
import {
  assertSupportedCurrency, getPublicAppUrl, providerForCurrency, providerIsConfigured, resolveCollectionPaymentMethod,
} from "../lib/greenpay-provider";
import { requireAdmin, requireSignedIn } from "../middlewares/requireAdmin";
import { resolvePlatformAdmin } from "../lib/platform-admin";
import { developerApiAuth, requireApiScope } from "../middlewares/developerApiAuth";
import {
  assertMerchantActionEnabled,
  assertMerchantMayTransact,
  assertPlatformEnabled,
  getMerchantActionControls,
} from "../lib/platform";
import { apiKeyHash, encryptSecret, validateWebhookUrl } from "../lib/secure-storage";
import {
  findTransaction, markTransactionStatus, paymentLinkDto, paymentLinkStats, payoutDto, transactionDto,
} from "../lib/greenpay-ledger";
import { verifyProviderPayment } from "../lib/greenpay-provider";
import { calculateFxQuote } from "../lib/fx-math";
import { diditDecisionStatus, diditStatusNeedsRefresh, ownsMerchantRecord } from "../lib/security-policy";
import { developerTransactionRequestFingerprint, idempotencyDisposition } from "../lib/payment-safety";
import { verificationTierForMerchant } from "../lib/platform";
import { getAuth } from "@clerk/express";
import { findMerchantAccessForUser, resolveMerchantAccess } from "../lib/merchant-access";
import { cleanPublicUrl } from "../lib/platform-branding";
import { cloudinaryUploadStatus, createCloudinaryUploadSignature } from "../lib/cloudinary-upload";
import { resolveCloudinaryEnvironment } from "../lib/cloudinary-credentials";
import { providerCredential } from "../lib/credential-runtime";

const router: IRouter = Router();
const apiRouter: IRouter = Router();

function profile(row: typeof merchantsTable.$inferSelect) {
  return {
    id: row.id,
    businessName: row.businessName,
    shopName: row.shopName,
    shopLogoUrl: row.shopLogoUrl,
    country: row.country,
    baseCurrency: row.baseCurrency,
    registrationNumber: row.registrationNumber,
    status: row.status,
    kycStatus: row.kycStatus,
    paymentsEnabled: row.paymentsEnabled,
    payoutsEnabled: row.payoutsEnabled,
    refundsEnabled: row.refundsEnabled,
    apiAccessEnabled: row.apiAccessEnabled,
    createdAt: row.createdAt,
  };
}

function merchantFor(reqUserId: string) {
  return db.select().from(merchantsTable).where(eq(merchantsTable.ownerClerkId, reqUserId)).limit(1);
}

async function ownedMerchant(res: Parameters<Parameters<IRouter["get"]>[1]>[1]) {
  const path = res.req.path;
  const method = res.req.method.toUpperCase();
  const ownerOnly = path === "/merchant" ||
    /^\/merchant\/(?:kyc|shop-profile(?:\/|$)|api-keys(?:\/|$)|webhook-endpoints(?:\/|$))/.test(path);
  const permission = ownerOnly ? "owner" : ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? "finance" : "read";
  return resolveMerchantAccess(res.req, res, permission);
}

async function merchantLinks(merchantId: number) {
  const rows = await db.select().from(paymentLinksTable)
    .where(eq(paymentLinksTable.merchantId, merchantId)).orderBy(desc(paymentLinksTable.createdAt)).limit(500);
  return Promise.all(rows.map(async (row) => {
    const stats = await paymentLinkStats(row.id);
    return paymentLinkDto(row, stats.paidCount, stats.totalsByCurrency);
  }));
}

async function createOwnedLink(merchant: typeof merchantsTable.$inferSelect, input: {
  name: string; description?: string; amountType: "fixed" | "customer_choice"; amount?: number;
  currency: string; expiresAt?: Date;
}) {
  await assertMerchantActionEnabled(merchant.id, "createLinks");
  await assertMerchantMayTransact(merchant);
  await assertPlatformEnabled("paymentsEnabled");
  assertSupportedCurrency(input.currency.toUpperCase());
  if (input.amountType === "fixed" && !(input.amount && input.amount > 0)) {
    throw Object.assign(new Error("A fixed-price link needs an amount greater than zero."), { statusCode: 400 });
  }
  if (input.amountType === "fixed") {
    assertCollectionAmountPrecision(input.amount!, input.currency);
  }
  if (input.amountType === "customer_choice" && input.amount !== undefined) {
    throw Object.assign(new Error("Customer-choice links cannot have a preset amount."), { statusCode: 400 });
  }
  const [link] = await db.insert(paymentLinksTable).values({
    slug: randomUUID().replaceAll("-", "").slice(0, 20),
    merchantId: merchant.id,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    amountType: input.amountType,
    amount: input.amountType === "fixed" ? input.amount : null,
    currency: input.currency.toUpperCase(),
    expiresAt: input.expiresAt ?? null,
    status: "active",
  }).returning();
  return paymentLinkDto(link, 0, []);
}

function apiKeyDto(row: typeof merchantApiKeysTable.$inferSelect) {
  return {
    id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, revokedAt: row.revokedAt,
  };
}

function endpointDto(row: typeof merchantWebhookEndpointsTable.$inferSelect) {
  return { id: row.id, url: row.url, events: row.events, active: row.active, createdAt: row.createdAt };
}

router.get("/me", requireSignedIn, async (req, res): Promise<void> => {
  const userId = res.locals.clerkUserId as string;
  const access = await findMerchantAccessForUser(userId);
  let isAdmin = false;
  try {
    isAdmin = (await resolvePlatformAdmin(userId)).isAdmin;
  } catch (error) {
    req.log.warn({ err: error, userId }, "Could not resolve platform-admin access for access profile");
  }
  res.json(GetAccessProfileResponse.parse({
    userId, isAdmin, ...(access ? { role: access.role } : {}),
    merchant: access ? profile(access.merchant) : null,
  }));
});

router.get("/merchant/action-controls", requireSignedIn, async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const userId = res.locals.clerkUserId as string;
  const access = await findMerchantAccessForUser(userId);
  if (!access) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  res.json({
    merchantId: access.merchant.id,
    controls: await getMerchantActionControls(access.merchant.id),
    role: access.role,
  });
});

router.get("/merchant", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) {
    res.status(404).json({ error: "Merchant onboarding is not complete." });
    return;
  }
  res.json(GetMerchantProfileResponse.parse({ merchant: profile(merchant) }));
});

router.patch("/merchant/shop-profile", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) {
    res.status(404).json({ error: "Merchant onboarding is not complete." });
    return;
  }
  const parsed = UpdateMerchantShopProfileBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updates: Partial<typeof merchantsTable.$inferInsert> = { updatedAt: new Date() };
  try {
    if (Object.hasOwn(parsed.data, "shopName")) {
      const shopName = parsed.data.shopName?.trim() || null;
      if (shopName && /[\u0000-\u001f\u007f]/.test(shopName)) {
        res.status(400).json({ error: "Shop name must contain readable text." });
        return;
      }
      updates.shopName = shopName;
    }
    if (Object.hasOwn(parsed.data, "shopLogoUrl")) {
      updates.shopLogoUrl = cleanPublicUrl(parsed.data.shopLogoUrl, "Shop logo URL") ?? null;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid shop profile." });
    return;
  }
  if (Object.keys(updates).length === 1) {
    res.status(400).json({ error: "Provide a shop name or logo URL to update." });
    return;
  }
  const [updated] = await db.update(merchantsTable).set(updates)
    .where(eq(merchantsTable.id, merchant.id)).returning();
  res.json(UpdateMerchantShopProfileResponse.parse({ merchant: profile(updated) }));
});

router.post("/merchant/shop-profile/upload-signature", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) {
    res.status(404).json({ error: "Merchant onboarding is not complete." });
    return;
  }
  const environment = await resolveCloudinaryEnvironment(providerCredential);
  if (!cloudinaryUploadStatus(environment).configured) {
    res.status(503).json({
      error: "Cloudinary uploads are not configured. An administrator must add the Cloudinary credentials in Admin → Credentials.",
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const signedUpload = createCloudinaryUploadSignature(`greenpay/merchants/${merchant.id}/profile`, undefined, environment);
  res.json(CreateMerchantCloudinaryUploadSignatureResponse.parse(signedUpload));
});

router.post("/merchant", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateMerchantProfileBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  await assertPlatformEnabled("newMerchantSignups");
  const userId = res.locals.clerkUserId as string;
  const existing = await merchantFor(userId);
  if (existing.length) { res.status(409).json({ error: "A merchant profile already exists for this account." }); return; }
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: userId, businessName: parsed.data.businessName.trim(),
    country: parsed.data.country.toUpperCase(), baseCurrency: parsed.data.baseCurrency.toUpperCase(),
    registrationNumber: parsed.data.registrationNumber?.trim() || null,
  }).returning();
  res.status(201).json(CreateMerchantProfileResponse.parse({ merchant: profile(merchant) }));
});

function verificationLimitDto(row: typeof verificationTierLimitsTable.$inferSelect) {
  return {
    tier: row.tier, currency: row.currency,
    collectionPerTransactionLimit: row.collectionPerTransactionLimit,
    collectionDailyLimit: row.collectionDailyLimit,
    collectionMonthlyLimit: row.collectionMonthlyLimit,
    payoutLimit: row.payoutLimit, conversionLimit: row.conversionLimit,
    updatedAt: row.updatedAt,
  };
}

router.get("/admin/verification-limits", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(verificationTierLimitsTable)
    .orderBy(verificationTierLimitsTable.tier, verificationTierLimitsTable.currency);
  res.json(GetAdminVerificationLimitsResponse.parse({ items: rows.map(verificationLimitDto) }));
});

router.put("/admin/verification-limits", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateAdminVerificationLimitsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const normalized = parsed.data.items.map((item) => ({ ...item, currency: item.currency.toUpperCase() }));
  if (normalized.some((item) => !/^[A-Z]{3}$/.test(item.currency))) {
    res.status(400).json({ error: "Currencies must use a three-letter ISO-style currency code." }); return;
  }
  if (new Set(normalized.map((item) => `${item.tier}:${item.currency}`)).size !== normalized.length) {
    res.status(400).json({ error: "Each verification tier and currency can appear only once." }); return;
  }
  const rows = await db.transaction(async (tx) => {
    await tx.delete(verificationTierLimitsTable);
    for (const item of normalized) {
      await tx.insert(verificationTierLimitsTable).values({
        ...item, updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [verificationTierLimitsTable.tier, verificationTierLimitsTable.currency],
        set: {
          collectionPerTransactionLimit: item.collectionPerTransactionLimit,
          collectionDailyLimit: item.collectionDailyLimit,
          collectionMonthlyLimit: item.collectionMonthlyLimit,
          payoutLimit: item.payoutLimit, conversionLimit: item.conversionLimit,
          updatedAt: new Date(),
        },
      });
    }
    return tx.select().from(verificationTierLimitsTable)
      .orderBy(verificationTierLimitsTable.tier, verificationTierLimitsTable.currency);
  });
  await db.insert(adminAuditLogTable).values({
    actor: getAuth(req).userId ?? "unknown-admin",
    action: "verification_limits.updated",
    target: "verification-limits",
    details: `Updated ${normalized.length} verification tier/currency limit row(s).`,
  });
  res.json(UpdateAdminVerificationLimitsResponse.parse({ items: rows.map(verificationLimitDto) }));
});

async function refreshDiditVerification(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  merchant: typeof merchantsTable.$inferSelect,
  kind: "kyc" | "kyb",
  apiKey: string | null | undefined,
): Promise<typeof merchantsTable.$inferSelect> {
  const sessionId = kind === "kyc" ? merchant.diditSessionId : merchant.diditKybSessionId;
  const status = kind === "kyc" ? merchant.kycStatus : merchant.kybStatus;
  if (!diditStatusNeedsRefresh(status, sessionId)) return merchant;
  if (!apiKey) {
    req.log.warn({ kind }, "Didit status refresh is unavailable because API credentials are not configured");
    return merchant;
  }
  try {
    const response = await fetch(`https://verification.didit.me/v3/session/${encodeURIComponent(sessionId!)}/decision/`, {
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Didit decision endpoint returned ${response.status}.`);
    const mapped = diditDecisionStatus(await response.json(), sessionId!);
    if (!mapped) throw new Error("Didit decision response was missing a recognized status or matching session ID.");
    const updated = await db.transaction(async (tx) => {
      const [latest] = await tx.select().from(merchantsTable)
        .where(eq(merchantsTable.id, merchant.id)).for("update").limit(1);
      if (!latest) return undefined;
      const latestSessionId = kind === "kyc" ? latest.diditSessionId : latest.diditKybSessionId;
      const latestStatus = kind === "kyc" ? latest.kycStatus : latest.kybStatus;
      if (latestSessionId !== sessionId || !diditStatusNeedsRefresh(latestStatus, latestSessionId)) return latest;
      if (mapped === latestStatus) return latest;
      const now = new Date();
      const fields = kind === "kyc"
        ? {
            kycStatus: mapped, verificationUpdatedAt: now,
            ...(mapped === "approved" && latest.status === "pending" ? { status: "active" } : {}),
            updatedAt: now,
          }
        : { kybStatus: mapped, kybVerificationUpdatedAt: now, updatedAt: now };
      const [saved] = await tx.update(merchantsTable).set(fields)
        .where(and(
          eq(merchantsTable.id, latest.id),
          eq(kind === "kyc" ? merchantsTable.diditSessionId : merchantsTable.diditKybSessionId, sessionId!),
        )).returning();
      return saved ?? latest;
    });
    return updated ?? merchant;
  } catch (error) {
    req.log.warn({ err: error, kind, sessionId }, "Didit status refresh failed; retaining the last verified status");
    return merchant;
  }
}

async function migrateLegacyKybSession(
  merchant: typeof merchantsTable.$inferSelect,
): Promise<typeof merchantsTable.$inferSelect> {
  if (merchant.diditKind !== "kyb" || merchant.diditKybSessionId || !merchant.diditSessionId) return merchant;
  const [migrated] = await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchant.id)).for("update").limit(1);
    if (!latest || latest.diditKind !== "kyb" || latest.diditKybSessionId || !latest.diditSessionId) return [latest];
    return tx.update(merchantsTable).set({
      diditKybSessionId: latest.diditSessionId,
      diditKybSessionUrl: latest.diditSessionUrl,
      kybStatus: latest.kycStatus,
      kybVerificationUpdatedAt: latest.verificationUpdatedAt,
      diditSessionId: null,
      diditSessionUrl: null,
      diditKind: null,
      kycStatus: "not_started",
      verificationUpdatedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(merchantsTable.id, latest.id),
      eq(merchantsTable.diditSessionId, latest.diditSessionId),
    )).returning();
  });
  return migrated ?? merchant;
}

router.get("/merchant/kyc", requireSignedIn, async (req, res): Promise<void> => {
  let merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  merchant = await migrateLegacyKybSession(merchant);
  const didit = await import("../lib/credential-runtime");
  const apiKey = await didit.providerCredential("didit", "DIDIT_API_KEY");
  const individualWorkflow = await didit.providerCredential("didit", "DIDIT_WORKFLOW_ID");
  const businessWorkflow = await didit.providerCredential("didit", "DIDIT_KYB_WORKFLOW_ID");
  merchant = await refreshDiditVerification(req, merchant, "kyc", apiKey);
  merchant = await refreshDiditVerification(req, merchant, "kyb", apiKey);
  const tier = verificationTierForMerchant(merchant);
  const limits = await db.select().from(verificationTierLimitsTable)
    .where(eq(verificationTierLimitsTable.tier, tier))
    .orderBy(verificationTierLimitsTable.currency);
  res.json(GetMerchantKycResponse.parse({
    status: merchant.kycStatus, configured: Boolean(apiKey && individualWorkflow),
    sessionId: merchant.diditSessionId, sessionUrl: merchant.diditSessionUrl,
    updatedAt: merchant.verificationUpdatedAt, requirements: ["identity", "liveness", "AML", "address"],
    kybStatus: merchant.kybStatus, kybConfigured: Boolean(apiKey && businessWorkflow),
    kybSessionId: merchant.diditKybSessionId, kybSessionUrl: merchant.diditKybSessionUrl,
    kybUpdatedAt: merchant.kybVerificationUpdatedAt, tier, limits: limits.map(verificationLimitDto),
  }));
});

router.post("/merchant/kyc", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateMerchantKycSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  let merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  merchant = await migrateLegacyKybSession(merchant);
  const runtime = await import("../lib/credential-runtime");
  const apiKey = await runtime.providerCredential("didit", "DIDIT_API_KEY");
  const kind = parsed.data.kind;
  const workflowId = await runtime.providerCredential("didit", kind === "kyb" ? "DIDIT_KYB_WORKFLOW_ID" : "DIDIT_WORKFLOW_ID");
  if (!apiKey || !workflowId) {
    res.status(503).json({ error: kind === "kyb"
      ? "Didit API credentials or the KYB workflow are not configured."
      : "Didit API credentials or the KYC workflow are not configured." });
    return;
  }
  const currentSessionId = kind === "kyb" ? merchant.diditKybSessionId : merchant.diditSessionId;
  const currentStatus = kind === "kyb" ? merchant.kybStatus : merchant.kycStatus;
  if (diditStatusNeedsRefresh(currentStatus, currentSessionId) || currentStatus === "approved") {
    res.status(409).json({ error: `A ${kind.toUpperCase()} verification session is already active or approved.` });
    return;
  }
  const callback = `${getPublicAppUrl()}/merchant/kyc`;
  let response: Response;
  try {
    response = await fetch("https://verification.didit.me/v3/session/", {
      method: "POST", headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: workflowId, vendor_data: String(merchant.id), callback }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    res.status(502).json({ error: "Didit could not be reached. Try again shortly." });
    return;
  }
  if (!response.ok) {
    res.status(502).json({ error: "Didit rejected the verification session request." });
    return;
  }
  const result = await response.json() as { session_id?: string; url?: string; session_token?: string };
  if (!result.session_id || !result.url) { res.status(502).json({ error: "Didit returned an incomplete verification session." }); return; }
  const updated = await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchant!.id)).for("update").limit(1);
    if (!latest) return undefined;
    const latestSessionId = kind === "kyb" ? latest.diditKybSessionId : latest.diditSessionId;
    const latestStatus = kind === "kyb" ? latest.kybStatus : latest.kycStatus;
    if (latestSessionId !== currentSessionId || diditStatusNeedsRefresh(latestStatus, latestSessionId) || latestStatus === "approved") return undefined;
    const now = new Date();
    const fields = kind === "kyb" ? {
      diditKybSessionId: result.session_id, diditKybSessionUrl: result.url,
      diditKind: "kyb", kybStatus: "pending", kybVerificationUpdatedAt: now, updatedAt: now,
    } : {
      diditSessionId: result.session_id, diditSessionUrl: result.url,
      diditKind: "kyc", kycStatus: "pending", verificationUpdatedAt: now, updatedAt: now,
    };
    const [saved] = await tx.update(merchantsTable).set(fields)
      .where(eq(merchantsTable.id, latest.id)).returning();
    return saved;
  });
  if (!updated) {
    res.status(409).json({ error: `A ${kind.toUpperCase()} session changed while the new session was being created. Refresh and try again.` });
    return;
  }
  res.status(201).json(CreateMerchantKycSessionResponse.parse({ sessionId: result.session_id, url: result.url, status: "pending" }));
});

router.get("/merchant/transactions", requireSignedIn, async (req, res): Promise<void> => {
  const query = ListMerchantTransactionsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const where = eq(transactionsTable.merchantId, merchant.id);
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable).where(where);
  const rows = await db.select().from(transactionsTable).where(where).orderBy(desc(transactionsTable.createdAt))
    .limit(query.data.perPage).offset((query.data.page - 1) * query.data.perPage);
  res.json(ListMerchantTransactionsResponse.parse({
    items: rows.map(transactionDto), total: Number(count?.count ?? 0),
    page: query.data.page, perPage: query.data.perPage,
  }));
});

router.get("/merchant/payouts", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(payoutsTable).where(eq(payoutsTable.merchantId, merchant.id))
    .orderBy(desc(payoutsTable.createdAt)).limit(500);
  res.json(ListMerchantPayoutsResponse.parse({ items: rows.map(payoutDto) }));
});

router.get("/merchant/payment-links", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  res.json(ListMerchantPaymentLinksResponse.parse({ items: await merchantLinks(merchant.id) }));
});

router.post("/merchant/payment-links", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateMerchantPaymentLinkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const link = await createOwnedLink(merchant, parsed.data);
  res.status(201).json(CreateMerchantPaymentLinkResponse.parse(link));
});

router.patch("/merchant/payment-links/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = UpdateMerchantPaymentLinkParams.safeParse(req.params);
  const body = UpdateMerchantPaymentLinkBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid payment-link update." }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [owned] = await db.select().from(paymentLinksTable).where(and(
    eq(paymentLinksTable.id, params.data.id), eq(paymentLinksTable.merchantId, merchant.id),
  )).limit(1);
  if (!owned || !ownsMerchantRecord(owned.merchantId, merchant.id)) { res.status(404).json({ error: "Payment link not found for this merchant." }); return; }
  const updates: Partial<typeof paymentLinksTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name.trim();
  if (body.data.description !== undefined) updates.description = body.data.description.trim() || null;
  if (body.data.status !== undefined) updates.status = body.data.status;
  if (body.data.expiresAt !== undefined) updates.expiresAt = body.data.expiresAt;
  const [link] = await db.update(paymentLinksTable).set(updates).where(and(
    eq(paymentLinksTable.id, owned.id), eq(paymentLinksTable.merchantId, merchant.id),
  )).returning();
  const stats = await paymentLinkStats(link.id);
  res.json(UpdateMerchantPaymentLinkResponse.parse(paymentLinkDto(link, stats.paidCount, stats.totalsByCurrency)));
});

router.delete("/merchant/payment-links/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = DeleteMerchantPaymentLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [link] = await db.update(paymentLinksTable).set({ status: "archived" })
    .where(and(eq(paymentLinksTable.id, params.data.id), eq(paymentLinksTable.merchantId, merchant.id)))
    .returning({ id: paymentLinksTable.id });
  if (!link) { res.status(404).json({ error: "Payment link not found for this merchant." }); return; }
  res.status(204).send(DeleteMerchantPaymentLinkResponse.parse(undefined));
});

router.get("/merchant/api-keys", requireSignedIn, async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(merchantApiKeysTable).where(eq(merchantApiKeysTable.merchantId, merchant.id))
    .orderBy(desc(merchantApiKeysTable.createdAt));
  res.json(ListMerchantApiKeysResponse.parse({ items: rows.map(apiKeyDto) }));
});

router.post("/merchant/api-keys", requireSignedIn, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = CreateMerchantApiKeyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (new Set(parsed.data.scopes).size !== parsed.data.scopes.length) {
    res.status(400).json({ error: "API key scopes must not contain duplicates." }); return;
  }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "apiAccess");
  await assertMerchantMayTransact(merchant);
  await assertPlatformEnabled("apiAccessEnabled");
  if (!merchant.apiAccessEnabled) { res.status(403).json({ error: "Developer API access is disabled for this merchant." }); return; }
  const secret = `gp_live_${randomBytes(32).toString("base64url")}`;
  const prefix = secret.slice(0, 15);
  const [key] = await db.insert(merchantApiKeysTable).values({
    merchantId: merchant.id, name: parsed.data.name.trim(), prefix,
    secretHash: apiKeyHash(secret), scopes: parsed.data.scopes,
  }).returning();
  res.status(201).json(CreateMerchantApiKeyResponse.parse({ key: apiKeyDto(key), secret }));
});

router.delete("/merchant/api-keys/:id", requireSignedIn, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = RevokeMerchantApiKeyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [key] = await db.update(merchantApiKeysTable).set({ revokedAt: new Date() }).where(and(
    eq(merchantApiKeysTable.id, params.data.id), eq(merchantApiKeysTable.merchantId, merchant.id),
    isNull(merchantApiKeysTable.revokedAt),
  )).returning({ id: merchantApiKeysTable.id });
  if (!key) { res.status(404).json({ error: "API key not found for this merchant." }); return; }
  res.status(204).send(RevokeMerchantApiKeyResponse.parse(undefined));
});

router.get("/merchant/webhook-endpoints", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(merchantWebhookEndpointsTable)
    .where(and(eq(merchantWebhookEndpointsTable.merchantId, merchant.id), eq(merchantWebhookEndpointsTable.active, true)))
    .orderBy(desc(merchantWebhookEndpointsTable.createdAt));
  res.json(ListMerchantWebhookEndpointsResponse.parse({ items: rows.map(endpointDto) }));
});

router.post("/merchant/webhook-endpoints", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = CreateMerchantWebhookEndpointBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const url = await validateWebhookUrl(parsed.data.url);
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "apiAccess");
  await assertMerchantMayTransact(merchant);
  const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
  const [endpoint] = await db.insert(merchantWebhookEndpointsTable).values({
    merchantId: merchant.id, url: url.toString(), events: parsed.data.events,
    encryptedSecret: encryptSecret(signingSecret),
  }).returning();
  res.status(201).json(CreateMerchantWebhookEndpointResponse.parse({ endpoint: endpointDto(endpoint), signingSecret }));
});

router.delete("/merchant/webhook-endpoints/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = DeleteMerchantWebhookEndpointParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [endpoint] = await db.update(merchantWebhookEndpointsTable).set({ active: false }).where(and(
    eq(merchantWebhookEndpointsTable.id, params.data.id),
    eq(merchantWebhookEndpointsTable.merchantId, merchant.id),
    eq(merchantWebhookEndpointsTable.active, true),
  )).returning({ id: merchantWebhookEndpointsTable.id });
  if (!endpoint) { res.status(404).json({ error: "Webhook endpoint not found for this merchant." }); return; }
  res.status(204).send(DeleteMerchantWebhookEndpointResponse.parse(undefined));
});

router.get("/merchant/fees", requireSignedIn, async (_req, res): Promise<void> => {
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [specific] = await db.select().from(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, merchant.id)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable).where(isNull(feeSchedulesTable.merchantId)).limit(1);
  const schedule = specific ?? global;
  res.json(GetMerchantFeesResponse.parse({
    schedule: schedule ? {
      percentage: Number(schedule.percentage), flatAmount: Number(schedule.flatAmount),
      currency: schedule.currency, fxMarkupBps: schedule.fxMarkupBps,
    } : { percentage: 0, flatAmount: 0, currency: merchant.baseCurrency, fxMarkupBps: 0 },
    source: specific ? "merchant" : "default",
    note: "Platform fees are quoted separately from provider fees and do not represent provider settlement charges.",
  }));
});

router.get("/merchant/fx-quote", requireSignedIn, async (req, res): Promise<void> => {
  const query = GetMerchantFxQuoteQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = await ownedMerchant(res);
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const from = query.data.from.toUpperCase(), to = query.data.to.toUpperCase();
  const now = new Date();
  let rate = 1, source = "identity";
  let expiresAt = new Date(now.getTime() + 5 * 60_000);
  if (from !== to) {
    const conditions = [
      eq(fxRatesTable.fromCurrency, from), eq(fxRatesTable.toCurrency, to),
      eq(fxRatesTable.active, true), sql`${fxRatesTable.effectiveAt} <= ${now}`,
      sql`(${fxRatesTable.expiresAt} is null or ${fxRatesTable.expiresAt} > ${now})`,
    ];
    const [activeRate] = await db.select().from(fxRatesTable).where(and(...conditions))
      .orderBy(desc(fxRatesTable.effectiveAt)).limit(1);
    if (!activeRate) { res.status(404).json({ error: "No active exchange rate is available for this currency pair." }); return; }
    rate = Number(activeRate.rate); source = activeRate.source;
    if (activeRate.expiresAt && activeRate.expiresAt < expiresAt) expiresAt = activeRate.expiresAt;
  }
  const [specific] = await db.select().from(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, merchant.id)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable).where(isNull(feeSchedulesTable.merchantId)).limit(1);
  const schedule = specific ?? global;
  const percentage = schedule ? Number(schedule.percentage) : 0;
  const flatAmount = schedule ? Number(schedule.flatAmount) : 0;
  if (schedule && schedule.currency !== to && flatAmount > 0) {
    res.status(409).json({ error: `Fee schedule flat amount is denominated in ${schedule.currency}; a ${to} quote cannot safely apply that flat fee.` });
    return;
  }
  const calculation = calculateFxQuote(query.data.amount, rate, percentage, flatAmount, schedule?.fxMarkupBps ?? 0);
  res.json(GetMerchantFxQuoteResponse.parse({
    from, to, amount: query.data.amount, rate, ...calculation,
    source, quotedAt: now, expiresAt,
    note: "Indicative quote only. This does not execute FX or represent provider fees or settlement.",
  }));
});

apiRouter.use(developerApiAuth, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
apiRouter.get("/merchant", requireApiScope("read"), async (_req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  res.json(GetMerchantProfileResponse.parse({ merchant: profile(merchant) }));
});
apiRouter.get("/payment-links", requireApiScope("read"), async (_req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  res.json(ListDeveloperPaymentLinksResponse.parse({ items: await merchantLinks(merchant.id) }));
});
apiRouter.post("/payment-links", requireApiScope("payment_links:write"), async (req, res): Promise<void> => {
  const parsed = CreateMerchantPaymentLinkBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const link = await createOwnedLink(merchant, parsed.data);
  res.status(201).json(CreateDeveloperPaymentLinkResponse.parse(link));
});
apiRouter.get("/transactions", requireApiScope("read"), async (req, res): Promise<void> => {
  const query = ListDeveloperTransactionsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const where = eq(transactionsTable.merchantId, merchant.id);
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable).where(where);
  const rows = await db.select().from(transactionsTable).where(where).orderBy(desc(transactionsTable.createdAt))
    .limit(query.data.perPage).offset((query.data.page - 1) * query.data.perPage);
  res.json(ListDeveloperTransactionsResponse.parse({
    items: rows.map(transactionDto), total: Number(count?.count ?? 0),
    page: query.data.page, perPage: query.data.perPage,
  }));
});

apiRouter.post("/transactions", requireApiScope("payments:write"), async (req, res): Promise<void> => {
  const header = CreateDeveloperTransactionHeader.safeParse({ "Idempotency-Key": req.get("Idempotency-Key") });
  const parsed = CreateDeveloperTransactionBody.safeParse(req.body);
  if (!header.success || !parsed.success) {
    res.status(400).json({ error: !header.success ? header.error.message : parsed.error?.message ?? "Invalid developer payment request." }); return;
  }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  await assertMerchantActionEnabled(merchant.id, "collect");
  await assertMerchantMayTransact(merchant);
  const values = parsed.data;
  await assertPlatformEnabled("paymentsEnabled");
  const currency = values.currency.toUpperCase();
  assertSupportedCurrency(currency);
  assertCollectionAmountPrecision(values.amount, currency);
  const paymentMethod = resolveCollectionPaymentMethod(currency, values.paymentMethod);
  const provider = providerForCurrency(currency);
  if (!await providerIsConfigured(provider)) {
    res.status(503).json({ error: `${provider} is not configured.` });
    return;
  }
  if (paymentMethod.requiresPhone && !values.customerPhone?.trim()) {
    res.status(400).json({ error: "A phone number is required for the selected payment method." }); return;
  }
  getPublicAppUrl();
  let link: typeof paymentLinksTable.$inferSelect | undefined;
  if (values.paymentLinkId !== undefined) {
    [link] = await db.select().from(paymentLinksTable).where(and(
      eq(paymentLinksTable.id, values.paymentLinkId), eq(paymentLinksTable.merchantId, merchant.id),
      eq(paymentLinksTable.status, "active"),
    )).limit(1);
    if (!link || !ownsMerchantRecord(link.merchantId, merchant.id) || (link.expiresAt && link.expiresAt <= new Date())) {
      res.status(404).json({ error: "Active payment link not found for this merchant." }); return;
    }
    if (link.currency.toUpperCase() !== values.currency.toUpperCase()) {
      res.status(400).json({ error: "Payment currency does not match the selected payment link." }); return;
    }
    if (link.amountType === "fixed" && Math.abs(Number(link.amount) - values.amount) > 0.001) {
      res.status(400).json({ error: "Payment amount does not match the selected fixed-price link." }); return;
    }
  }
  const requestHash = developerTransactionRequestFingerprint({
    amount: values.amount,
    currency,
    paymentMethod: paymentMethod.id,
    customerEmail: values.customerEmail.trim().toLowerCase(),
    customerName: values.customerName?.trim() ?? null,
    customerPhone: values.customerPhone?.trim() ?? null,
    description: values.description?.trim() ?? null,
    paymentLinkId: values.paymentLinkId ?? null,
  });
  const idempotencyKey = header.data["Idempotency-Key"];
  const [reserved] = await db.insert(developerIdempotencyTable).values({
    merchantId: merchant.id, idempotencyKey, requestHash, status: "in_flight",
  }).onConflictDoNothing().returning();
  if (!reserved) {
    const [existing] = await db.select().from(developerIdempotencyTable).where(and(
      eq(developerIdempotencyTable.merchantId, merchant.id),
      eq(developerIdempotencyTable.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (!existing) { res.status(503).json({ error: "Unable to reserve the idempotency key safely." }); return; }
    const disposition = idempotencyDisposition({
      status: existing.status,
      requestHashMatches: existing.requestHash === requestHash,
      hasResponse: Boolean(existing.response),
    });
    if (disposition === "mismatch") {
      res.status(409).json({ error: "This idempotency key was already used with a different request." }); return;
    }
    if (disposition === "replay" && existing.response) {
      res.setHeader("Idempotent-Replayed", "true");
      res.status(201).json(CreateDeveloperTransactionResponse.parse(existing.response));
      return;
    }
    res.status(409).json({
      error: disposition === "in_flight"
        ? "This payment request is still in progress."
        : "The previous payment attempt has an uncertain outcome; use a new idempotency key only after reconciling its transaction.",
    });
    return;
  }
  try {
    const result = await createCollection({
      ...values, paymentMethod: paymentMethod.id, merchantId: merchant.id,
      paymentLinkSlug: link?.slug,
    });
    const response = CreateDeveloperTransactionResponse.parse({
      transaction: transactionDto(result.transaction), checkoutUrl: result.checkoutUrl,
    });
    await db.update(developerIdempotencyTable).set({
      status: "completed", response, updatedAt: new Date(),
    }).where(eq(developerIdempotencyTable.id, reserved.id));
    res.status(201).json(response);
  } catch (error) {
    await db.update(developerIdempotencyTable).set({
      status: "uncertain", updatedAt: new Date(),
    }).where(eq(developerIdempotencyTable.id, reserved.id));
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode) : 502;
    const comingSoonFailure = error instanceof Error && /coming soon/i.test(error.message);
    res.status(statusCode).json({
      error: ((statusCode < 500 || (statusCode === 503 && comingSoonFailure)) && error instanceof Error)
        ? error.message
        : "Payment initiation could not be confirmed. The idempotency reservation is retained to prevent a duplicate charge.",
    });
  }
});

apiRouter.get("/transactions/:reference", requireApiScope("read"), async (req, res): Promise<void> => {
  const params = GetDeveloperTransactionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const [transaction] = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.reference, params.data.reference), eq(transactionsTable.merchantId, merchant.id),
  )).limit(1);
  if (!transaction) { res.status(404).json({ error: "Transaction not found for this merchant." }); return; }
  res.json(GetDeveloperTransactionResponse.parse(transactionDto(transaction)));
});

apiRouter.post("/transactions/:reference/verify", requireApiScope("payments:write"), async (req, res): Promise<void> => {
  const params = VerifyDeveloperTransactionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const [transaction] = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.reference, params.data.reference), eq(transactionsTable.merchantId, merchant.id),
  )).limit(1);
  if (!transaction) { res.status(404).json({ error: "Transaction not found for this merchant." }); return; }
  const verified = await verifyProviderPayment(transaction);
  const updated = await markTransactionStatus(transaction.reference, verified);
  if (!updated) { res.status(404).json({ error: "Transaction not found for this merchant." }); return; }
  res.json(VerifyDeveloperTransactionResponse.parse(transactionDto(updated)));
});

apiRouter.get("/fx-quote", requireApiScope("read"), async (req, res): Promise<void> => {
  const query = GetDeveloperFxQuoteQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const from = query.data.from.toUpperCase(), to = query.data.to.toUpperCase(), now = new Date();
  let rate = 1, source = "identity", expiresAt = new Date(now.getTime() + 5 * 60_000);
  if (from !== to) {
    const [activeRate] = await db.select().from(fxRatesTable).where(and(
      eq(fxRatesTable.fromCurrency, from), eq(fxRatesTable.toCurrency, to),
      eq(fxRatesTable.active, true), sql`${fxRatesTable.effectiveAt} <= ${now}`,
      sql`(${fxRatesTable.expiresAt} is null or ${fxRatesTable.expiresAt} > ${now})`,
    )).orderBy(sql`${fxRatesTable.effectiveAt} DESC`).limit(1);
    if (!activeRate) { res.status(404).json({ error: "No active exchange rate is available for this currency pair." }); return; }
    rate = Number(activeRate.rate); source = activeRate.source;
    if (activeRate.expiresAt && activeRate.expiresAt < expiresAt) expiresAt = activeRate.expiresAt;
  }
  const [specific] = await db.select().from(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, merchant.id)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable).where(isNull(feeSchedulesTable.merchantId)).limit(1);
  const schedule = specific ?? global;
  const percentage = schedule ? Number(schedule.percentage) : 0;
  const flat = schedule ? Number(schedule.flatAmount) : 0;
  if (schedule && flat > 0 && schedule.currency !== to) {
    res.status(409).json({ error: `Fee schedule flat amount is denominated in ${schedule.currency}; a ${to} quote cannot safely apply that fee.` }); return;
  }
  const calculation = calculateFxQuote(query.data.amount, rate, percentage, flat, schedule?.fxMarkupBps ?? 0);
  res.json(GetDeveloperFxQuoteResponse.parse({
    from, to, amount: query.data.amount, rate, ...calculation, source, quotedAt: now, expiresAt,
    note: "Indicative quote only; no FX settlement is performed and provider charges are separate.",
  }));
});

apiRouter.get("/fees", requireApiScope("read"), async (_req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const [specific] = await db.select().from(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, merchant.id)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable).where(isNull(feeSchedulesTable.merchantId)).limit(1);
  const schedule = specific ?? global;
  res.json(GetDeveloperFeesResponse.parse({
    schedule: schedule ? {
      percentage: Number(schedule.percentage), flatAmount: Number(schedule.flatAmount),
      currency: schedule.currency, fxMarkupBps: schedule.fxMarkupBps,
    } : { percentage: 0, flatAmount: 0, currency: merchant.baseCurrency, fxMarkupBps: 0 },
    source: specific ? "merchant" : "default",
    note: "Platform fees are separate from provider fees and settlement charges.",
  }));
});

router.use("/v1", apiRouter);
export default router;