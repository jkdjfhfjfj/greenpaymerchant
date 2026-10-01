import { eq } from "drizzle-orm";
import { db, platformSettingsTable, merchantsTable, type MerchantRecord } from "@workspace/db";
import { ApiError } from "./greenpay-provider";
import { featureIsEnabled, merchantCapabilityIsEnabled } from "./security-policy";

export type PlatformFlag = "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled" | "newMerchantSignups" | "kycRequired";
export type MerchantFlag = "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled";

const DEFAULT_SETTINGS = {
  newMerchantSignups: true,
  paymentsEnabled: true,
  payoutsEnabled: true,
  refundsEnabled: true,
  apiAccessEnabled: true,
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

export async function assertMerchantMayTransact(merchant: MerchantRecord): Promise<void> {
  if (merchant.status !== "active") throw new ApiError(403, "This merchant account is not active.");
  await assertMerchantCapability(merchant, "paymentsEnabled");
  const settings = await getPlatformSettings();
  if (settings.kycRequired && merchant.kycStatus !== "approved") {
    throw new ApiError(403, "Merchant verification must be approved before accepting payments.");
  }
}

export async function assertMerchantMayPayout(merchant: MerchantRecord): Promise<void> {
  if (merchant.status !== "active") throw new ApiError(403, "This merchant account is not active.");
  await assertMerchantCapability(merchant, "payoutsEnabled");
  const settings = await getPlatformSettings();
  if (settings.kycRequired && merchant.kycStatus !== "approved") {
    throw new ApiError(403, "Merchant verification must be approved before initiating payouts.");
  }
}