import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  CreateAdminFxRateBody, CreateAdminFxRateResponse, DeleteAdminProviderCredentialsParams,
  DeleteAdminProviderCredentialsResponse, GetAdminPlatformSettingsResponse, GetAdminSummaryResponse,
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
} from "@workspace/db";
import { encryptProviderCredentials, readProviderCredentials } from "../lib/secure-storage";
import { credentialVaultReady } from "../lib/secret-crypto";
import { providerCredential, providerCredentialFields } from "../lib/credential-runtime";
import { cleanPublicUrl, normalizeWhatsAppContact } from "../lib/platform-branding";

const router: IRouter = Router();
const providers = ["paystack", "payhero", "payzaapi", "didit"] as const;

function actor(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): string {
  return getAuth(req).userId ?? "unknown-admin";
}

async function audit(req: Parameters<Parameters<IRouter["get"]>[1]>[0], action: string, target: string, details: string) {
  await db.insert(adminAuditLogTable).values({ actor: actor(req), action, target, details });
}

function merchantDto(row: typeof merchantsTable.$inferSelect) {
  return {
    id: row.id, businessName: row.businessName, country: row.country,
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

router.patch("/admin/merchants/:id", async (req, res): Promise<void> => {
  const params = UpdateAdminMerchantParams.safeParse(req.params);
  const parsed = UpdateAdminMerchantBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : parsed.error?.message ?? "Invalid merchant update." }); return;
  }
  const patch = parsed.data as typeof parsed.data & Record<string, unknown>;
  const updates: Partial<typeof merchantsTable.$inferInsert> = { updatedAt: new Date() };
  for (const key of ["businessName", "status", "riskNote", "baseCurrency", "paymentsEnabled", "apiAccessEnabled", "payoutsEnabled", "refundsEnabled"] as const) {
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