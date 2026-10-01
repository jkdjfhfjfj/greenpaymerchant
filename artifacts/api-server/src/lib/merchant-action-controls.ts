import { db } from "@workspace/db";
import {
  assertMerchantActionEnabled as assertMerchantActionEnabledFromPlatform,
  getMerchantActionControls as loadMerchantActionControls,
  getMerchantPayoutSafetySettings,
} from "./platform";

type FinancialTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MerchantActionControlsSnapshot = {
  controls: Awaited<ReturnType<typeof loadMerchantActionControls>>;
  payoutSafety: Awaited<ReturnType<typeof getMerchantPayoutSafetySettings>>;
};

export function assertMerchantActionEnabled(
  merchantId: number,
  action: Parameters<typeof assertMerchantActionEnabledFromPlatform>[1],
  tx?: FinancialTx,
): Promise<void> {
  return assertMerchantActionEnabledFromPlatform(merchantId, action, tx);
}

export async function getMerchantActionControls(
  merchantId: number,
  tx?: FinancialTx,
): Promise<MerchantActionControlsSnapshot> {
  const controls = await loadMerchantActionControls(merchantId, tx);
  const payoutSafety = await getMerchantPayoutSafetySettings(merchantId, tx);
  return { controls, payoutSafety };
}