import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  CreateAdminFxRateBody, CreateAdminFxRateResponse, DeleteAdminProviderCredentialsParams,
  DeleteAdminProviderCredentialsResponse, GetAdminPlatformSettingsResponse, GetAdminSummaryResponse,
  GetAdminCloudinaryUploadStatusResponse, CreateAdminCloudinaryUploadSignatureResponse,
  ListAdminAuditLogQueryParams, ListAdminAuditLogResponse, ListAdminFeeSchedulesResponse,
  ListAdminFxRatesResponse, ListAdminMerchantsQueryParams, ListAdminMerchantsResponse,
  ListAdminProviderCredentialsResponse, SaveAdminProviderCredentialsBody,
  SaveAdminProviderCredentialsParams, SaveAdminProviderCredentialsResponse,
  UpdateAdminFeeScheduleBody, UpdateAdminFeeScheduleResponse, UpdateAdminFxRateBody,
  UpdateAdminFxRateParams, UpdateAdminFxRateResponse, UpdateAdminMerchantBody,
  UpdateAdminMerchantParams, UpdateAdminMerchantResponse, UpdateAdminPlatformSettingsBody,
  UpdateAdminPlatformSettingsResponse,
} from "@workspace/api-zod";
import {
  adminAuditLogTable, db, feeSchedulesTable, fxRatesTable, merchantApiKeysTable,
  merchantsTable, platformSettingsTable, providerCredentialsTable, transactionsTable,
  verificationTierLimitsTable, verificationUsageReservationsTable,
} from "@workspace/db";
import { encryptProviderCredentials, readProviderCredentials } from "../lib/secure-storage";
import { credentialVaultReady } from "../lib/secret-crypto";
import { providerCredential, providerCredentialFields } from "../lib/credential-runtime";
import { cleanPublicUrl, normalizeWhatsAppContact } from "../lib/platform-branding";
import { cloudinaryUploadStatus, createCloudinaryUploadSignature } from "../lib/cloudinary-upload";
import {
  MERCHANT_ACTION_KEYS,
  normalizeMerchantActionControls,
  normalizePayoutSafetySettings,
  type MerchantActionKey,
} from "../lib/merchant-access-policy";
import { verificationTierForMerchant } from "../lib/platform";

const router: IRouter = Router();
const providers = ["paystack", "payhero", "payzaapi", "didit"] as const;

function actor(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): string {
  return getAuth(req).userId ?? "unknown-admin";
}

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

function merchantDto(row: typeof merchantsTable.$inferSelect) {
  return {
    id: row.id, businessName: row.businessName, shopName: row.shopName, shopLogoUrl: row.shopLogoUrl, country: row.country,
    baseCurrency: row.baseCurrency, registrationNumber: row.registrationNumber,
    status: row.status, kycStatus: row.kycStatus, createdAt: row.createdAt,
    ownerUserId: row.ownerClerkId, riskNote: row.riskNote, diditSessionId: row.diditSessionId,
    paymentsEnabled: row.paymentsEnabled, apiAccessEnabled: row.apiAccessEnabled,
    payoutsEnabled: row.payoutsEnabled, refundsEnabled: row.refundsEnabled,
  };
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
  };
}

const defaultSettings = {
  newMerchantSignups: true, paymentsEnabled: true, payoutsEnabled: true,
  refundsEnabled: true, apiAccessEnabled: true, kycRequired: true,
  platformName: "Greenpay", baseCurrency: "USD",
  contactEmail: "support@greenpay.africa", contactPhone: "",
  contactAddress: "", contactWhatsapp: "", logoUrl: null, faviconUrl: null,
};

async function credentialDto(provider: typeof providers[number]) {
  const stored = await readProviderCredentials(provider);
  const fields = await Promise.all(providerCredentialFields(provider).map(async (name) => {
    const value = await providerCredential(provider, name) ?? "";
    return {
      name, present: Boolean(value),
      masked: value ? `${"•".repeat(Math.min(8, Math.max(4, value.length - 4)))}${value.slice(-4)}` : "",
    };
  }));
  const configured = provider === "paystack"
    ? fields.some((field) => field.name === "PAYSTACK_SECRET_KEY" && field.present)
    : provider === "payhero"
      ? fields.some((field) => field.name === "PAYHERO_BASIC_AUTH" && field.present) &&
        fields.some((field) => field.name === "PAYHERO_CHANNEL_ID" && field.present)
      : provider === "didit"
        ? fields.some((field) => field.name === "DIDIT_API_KEY" && field.present) &&
          fields.some((field) => field.name === "DIDIT_WORKFLOW_ID" && field.present) &&
          fields.some((field) => field.name === "DIDIT_KYB_WORKFLOW_ID" && field.present)
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
  const rows = await db.select().from(merchantsTable)
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(merchantsTable.createdAt)).limit(1000);
  res.json(ListAdminMerchantsResponse.parse({ items: rows.map(merchantDto) }));
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
  if (status !== "active" && status !== "suspended") {
    res.status(400).json({ error: "Merchant status must be active or suspended." }); return;
  }
  if (!reason || reason.length > 1000) {
    res.status(400).json({ error: "A nonempty audit reason of at most 1000 characters is required." }); return;
  }
  const saved = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
    if (!current) return null;
    const [updated] = await tx.update(merchantsTable).set({ status, updatedAt: new Date() })
      .where(eq(merchantsTable.id, merchantId)).returning();
    await tx.insert(adminAuditLogTable).values({
      actor: actor(req),
      action: status === "suspended" ? "merchant.suspended" : "merchant.reactivated",
      target: `merchant:${merchantId}`,
      details: `Status changed from ${current.status} to ${status}. Reason: ${reason}`,
    });
    return updated;
  });
  if (!saved) { res.status(404).json({ error: "Merchant not found." }); return; }
  res.json({ merchantId: saved.id, status: saved.status, reason, updatedAt: saved.updatedAt });
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
  await audit(req, "platform_settings.updated", "platform", `Changed ${Object.keys(parsed.data).join(", ")}. The base currency is a display and onboarding default; existing balances were not converted.`);
  res.json(UpdateAdminPlatformSettingsResponse.parse(settingsDto(row)));
});

router.get("/admin/platform-settings/cloudinary-status", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetAdminCloudinaryUploadStatusResponse.parse(cloudinaryUploadStatus()));
});

router.post("/admin/platform-settings/upload-signature", async (_req, res): Promise<void> => {
  if (!cloudinaryUploadStatus().configured) {
    res.status(503).json({
      error: "Cloudinary uploads are not configured. An administrator must set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Replit Secrets.",
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const signedUpload = createCloudinaryUploadSignature("greenpay/platform");
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