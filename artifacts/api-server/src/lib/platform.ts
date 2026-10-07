import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db, platformSettingsTable, merchantsTable, verificationTierLimitsTable,
  verificationUsageReservationsTable, type MerchantRecord,
} from "@workspace/db";
import { ApiError } from "./greenpay-provider";
import {
  featureIsEnabled, merchantCapabilityIsEnabled, merchantVerificationTier,
  verificationLimitError, type VerificationAction, type VerificationTier,
} from "./security-policy";
import {
  normalizeMerchantActionControls,
  normalizePayoutSafetySettings,
  MERCHANT_ACTION_KEYS,
  merchantActionPolicyDenial,
  type MerchantActionKey,
  type MerchantActionControls,
  type PayoutSafetySettings,
} from "./merchant-access-policy";

export type PlatformFlag = "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled" | "sandboxApiEnabled" | "newMerchantSignups" | "kycRequired";
export type MerchantFlag = "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled";
export type { VerificationAction, VerificationTier } from "./security-policy";
export type { MerchantActionKey, MerchantActionControls, PayoutSafetySettings } from "./merchant-access-policy";
export type FinancialTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_SETTINGS = {
  newMerchantSignups: true,
  paymentsEnabled: true,
  payoutsEnabled: true,
  refundsEnabled: true,
  apiAccessEnabled: true,
  sandboxApiEnabled: false,
  kycRequired: true,
};

export async function getPlatformSettings() {
  const [row] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  return {
    newMerchantSignups: row.newMerchantSignups,
    paymentsEnabled: row.paymentsEnabled,
    payoutsEnabled: row.payoutsEnabled,
    refundsEnabled: row.refundsEnabled,
    apiAccessEnabled: row.apiAccessEnabled,
    sandboxApiEnabled: row.sandboxApiEnabled,
    kycRequired: row.kycRequired,
  };
}

export async function assertPlatformEnabled(flag: PlatformFlag): Promise<void> {
  const settings = await getPlatformSettings();
  if (!featureIsEnabled(settings, flag)) {
    const labels: Record<PlatformFlag, string> = {
      newMerchantSignups: "Merchant onboarding is currently disabled.",
      paymentsEnabled: "Payments are currently disabled.",
      payoutsEnabled: "Payouts are currently disabled.",
      refundsEnabled: "Refunds are currently disabled.",
      apiAccessEnabled: "Developer API access is currently disabled.",
      sandboxApiEnabled: "The sandbox API is currently disabled by an administrator.",
      kycRequired: "KYC policy is currently enabled.",
    };
    throw new ApiError(403, labels[flag]);
  }
}

export async function assertMerchantCapability(merchant: MerchantRecord, flag: MerchantFlag): Promise<void> {
  if (!merchantCapabilityIsEnabled(merchant, flag)) {
    const labels: Record<MerchantFlag, string> = {
      paymentsEnabled: "Payments are disabled for this merchant.",
      payoutsEnabled: "Payouts are disabled for this merchant.",
      refundsEnabled: "Refunds are disabled for this merchant.",
      apiAccessEnabled: "Developer API access is disabled for this merchant.",
    };
    throw new ApiError(403, labels[flag]);
  }
}

/**
 * Action gate for mutating merchant operations. It intentionally composes
 * granular controls with account state and the pre-existing merchant/global
 * flags. Callers must still apply their existing KYC, amount-limit, balance,
 * idempotency, and provider-confirmation policies; this helper never replaces
 * those business-specific checks.
 */
export async function assertMerchantActionEnabled(
  merchantId: number,
  action: MerchantActionKey,
  tx?: FinancialTransaction,
): Promise<void> {
  const executor = tx ?? db;
  const [merchant] = await executor.select().from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  const [settings] = await executor.select({
    paymentsEnabled: platformSettingsTable.paymentsEnabled,
    payoutsEnabled: platformSettingsTable.payoutsEnabled,
    refundsEnabled: platformSettingsTable.refundsEnabled,
    apiAccessEnabled: platformSettingsTable.apiAccessEnabled,
  }).from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const denial = merchantActionPolicyDenial({
    action,
    controls: merchant.merchantActionControls,
    merchant,
    platform: settings ?? {
      paymentsEnabled: true, payoutsEnabled: true, refundsEnabled: true, apiAccessEnabled: true,
    },
  });
  if (denial) throw new ApiError(403, denial);
}

export type MerchantActionControlState = {
  controls: MerchantActionControls;
  disabledReasons: Partial<Record<MerchantActionKey, string>>;
  businessName: string;
  merchantStatus: string;
};

export async function getMerchantActionControlState(
  merchantId: number,
  tx?: FinancialTransaction,
): Promise<MerchantActionControlState> {
  const executor = tx ?? db;
  const [merchant] = await executor.select().from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  const controls = normalizeMerchantActionControls(merchant.merchantActionControls);
  const [settings] = await executor.select({
    paymentsEnabled: platformSettingsTable.paymentsEnabled,
    payoutsEnabled: platformSettingsTable.payoutsEnabled,
    refundsEnabled: platformSettingsTable.refundsEnabled,
    apiAccessEnabled: platformSettingsTable.apiAccessEnabled,
  }).from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const global = settings ?? {
    paymentsEnabled: true, payoutsEnabled: true, refundsEnabled: true, apiAccessEnabled: true,
  };
  const disabledReasons: Partial<Record<MerchantActionKey, string>> = {};
  for (const action of MERCHANT_ACTION_KEYS) {
    const denial = merchantActionPolicyDenial({ action, controls, merchant, platform: global });
    if (denial) {
      controls[action] = false;
      disabledReasons[action] = denial;
    }
  }
  return {
    controls,
    disabledReasons,
    businessName: merchant.businessName,
    merchantStatus: merchant.status,
  };
}

export async function getMerchantActionControls(
  merchantId: number,
  tx?: FinancialTransaction,
): Promise<MerchantActionControls> {
  return (await getMerchantActionControlState(merchantId, tx)).controls;
}

export async function getMerchantPayoutSafetySettings(
  merchantId: number,
  tx?: FinancialTransaction,
): Promise<PayoutSafetySettings> {
  const executor = tx ?? db;
  const [merchant] = await executor.select({
    payoutSafetySettings: merchantsTable.payoutSafetySettings,
  }).from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  return normalizePayoutSafetySettings(merchant.payoutSafetySettings);
}

export async function assertMerchantMayTransact(merchant: MerchantRecord): Promise<void> {
  if (merchant.status !== "active") throw new ApiError(403, "This merchant account is not active.");
  await assertMerchantCapability(merchant, "paymentsEnabled");
}

export async function assertMerchantMayPayout(merchant: MerchantRecord): Promise<void> {
  if (merchant.status !== "active") throw new ApiError(403, "This merchant account is not active.");
  await assertMerchantCapability(merchant, "payoutsEnabled");
}

export function verificationTierForMerchant(merchant: Pick<MerchantRecord, "kycStatus" | "kybStatus">): VerificationTier {
  return merchantVerificationTier(merchant.kycStatus, merchant.kybStatus);
}

export async function enforceVerificationLimit(
  tx: FinancialTransaction,
  merchantId: number,
  action: VerificationAction,
  amount: number,
  currency: string,
): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, "A positive finite amount is required.");
  const normalizedCurrency = currency.toUpperCase();
  const [merchant] = await tx.select().from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).for("update").limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  const tier = verificationTierForMerchant(merchant);
  const [limit] = await tx.select().from(verificationTierLimitsTable).where(and(
    eq(verificationTierLimitsTable.tier, tier),
    eq(verificationTierLimitsTable.currency, normalizedCurrency),
  )).limit(1);
  if (!limit) {
    throw new ApiError(503, `Verification limits are not configured for ${tier} merchants in ${normalizedCurrency}.`);
  }

  let currentDailyVolume = 0;
  let currentMonthlyVolume = 0;
  if (action === "collection") {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const activeStatuses = ["reserved", "committed"] as const;
    const [daily] = await tx.select({
      total: sql<number>`coalesce(sum(${verificationUsageReservationsTable.amount}), 0)::numeric`,
    }).from(verificationUsageReservationsTable).where(and(
      eq(verificationUsageReservationsTable.merchantId, merchantId),
      eq(verificationUsageReservationsTable.action, action),
      eq(verificationUsageReservationsTable.currency, normalizedCurrency),
      inArray(verificationUsageReservationsTable.status, [...activeStatuses]),
      gte(verificationUsageReservationsTable.createdAt, dayStart),
    ));
    const [monthly] = await tx.select({
      total: sql<number>`coalesce(sum(${verificationUsageReservationsTable.amount}), 0)::numeric`,
    }).from(verificationUsageReservationsTable).where(and(
      eq(verificationUsageReservationsTable.merchantId, merchantId),
      eq(verificationUsageReservationsTable.action, action),
      eq(verificationUsageReservationsTable.currency, normalizedCurrency),
      inArray(verificationUsageReservationsTable.status, [...activeStatuses]),
      gte(verificationUsageReservationsTable.createdAt, monthStart),
    ));
    currentDailyVolume = Number(daily?.total ?? 0);
    currentMonthlyVolume = Number(monthly?.total ?? 0);
  }
  const violation = verificationLimitError({
    action, amount, currency: normalizedCurrency, currentDailyVolume, currentMonthlyVolume,
    collectionPerTransactionLimit: limit.collectionPerTransactionLimit,
    collectionDailyLimit: limit.collectionDailyLimit,
    collectionMonthlyLimit: limit.collectionMonthlyLimit,
    payoutLimit: limit.payoutLimit,
    conversionLimit: limit.conversionLimit,
  });
  if (violation) throw new ApiError(403, violation);
}

export async function reserveVerificationUsage(
  tx: FinancialTransaction,
  merchantId: number,
  action: VerificationAction,
  amount: number,
  currency: string,
  transactionId?: number | null,
): Promise<typeof verificationUsageReservationsTable.$inferSelect> {
  await enforceVerificationLimit(tx, merchantId, action, amount, currency);
  const [reservation] = await tx.insert(verificationUsageReservationsTable).values({
    merchantId, action, amount, currency: currency.toUpperCase(),
    transactionId: transactionId ?? null, status: "reserved",
  }).returning();
  return reservation!;
}

export async function settleVerificationUsage(
  tx: FinancialTransaction,
  reservationId: number,
  outcome: "committed" | "released",
): Promise<void> {
  await tx.update(verificationUsageReservationsTable).set({
    status: outcome, updatedAt: new Date(),
  }).where(and(
    eq(verificationUsageReservationsTable.id, reservationId),
    eq(verificationUsageReservationsTable.status, "reserved"),
  ));
}