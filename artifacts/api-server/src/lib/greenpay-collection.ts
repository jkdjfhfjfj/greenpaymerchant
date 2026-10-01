import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { db, feeSchedulesTable, merchantsTable, transactionsTable } from "@workspace/db";
import {
  ApiError, assertSupportedCurrency, providerForCurrency, providerIsConfigured, startProviderPayment,
  type ProviderName, type StartPaymentInput, type StartPaymentResult,
} from "./greenpay-provider";
import { insertPendingTransaction } from "./greenpay-ledger";
import { assertMerchantMayTransact, assertPlatformEnabled } from "./platform";

export interface CreateCollectionInput {
  amount: number;
  currency: string;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  description?: string;
  paymentLinkId?: number;
  paymentLinkSlug?: string;
  merchantId?: number;
}

export interface CreateCollectionDependencies {
  assertPaymentsEnabled?: () => Promise<void>;
  providerIsConfigured?: (provider: ProviderName) => Promise<boolean>;
  loadFeeSchedule?: (merchantId?: number) => Promise<typeof feeSchedulesTable.$inferSelect | undefined>;
  startProviderPayment?: (input: StartPaymentInput) => Promise<StartPaymentResult>;
}

export async function createCollection(
  input: CreateCollectionInput,
  dependencies: CreateCollectionDependencies = {},
) {
  const currency = input.currency.toUpperCase();
  await (dependencies.assertPaymentsEnabled ?? (() => assertPlatformEnabled("paymentsEnabled")))();
  if (input.merchantId !== undefined) {
    const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, input.merchantId)).limit(1);
    if (!merchant) throw new ApiError(404, "Merchant account not found.");
    await assertMerchantMayTransact(merchant);
  }
  assertSupportedCurrency(currency);
  const provider: ProviderName = providerForCurrency(currency);
  const amount = Math.round(input.amount * 100) / 100;
  if (!await (dependencies.providerIsConfigured ?? providerIsConfigured)(provider)) {
    throw new ApiError(503, `${provider} is not configured.`);
  }
  if (provider === "payhero" && !Number.isInteger(input.amount)) {
    throw new ApiError(400, "KES M-Pesa collections must use whole shillings.");
  }
  if (provider === "payhero" && !input.customerPhone?.trim()) {
    throw new ApiError(400, "A phone number is required for a KES M-Pesa prompt.");
  }

  let feeSchedule: typeof feeSchedulesTable.$inferSelect | undefined;
  if (dependencies.loadFeeSchedule) {
    feeSchedule = await dependencies.loadFeeSchedule(input.merchantId);
  } else {
    const [merchantSchedule] = input.merchantId === undefined ? [] : await db.select().from(feeSchedulesTable)
      .where(eq(feeSchedulesTable.merchantId, input.merchantId)).limit(1);
    const [globalSchedule] = merchantSchedule ? [] : await db.select().from(feeSchedulesTable)
      .where(isNull(feeSchedulesTable.merchantId)).limit(1);
    feeSchedule = merchantSchedule ?? globalSchedule;
  }
  const platformFeePercent = feeSchedule ? Number(feeSchedule.percentage) : 0;
  const platformFlatFee = feeSchedule ? Number(feeSchedule.flatAmount) : 0;
  if (platformFlatFee > 0 && feeSchedule?.currency.toUpperCase() !== currency) {
    throw new ApiError(409, `The configured flat platform fee is denominated in ${feeSchedule?.currency}; ${currency} collections are paused until a compatible fee schedule is configured.`);
  }
  const platformFee = Math.round((amount * platformFeePercent / 100 + platformFlatFee) * 100) / 100;

  const reference = `GP-${randomUUID()}`;
  const row = await insertPendingTransaction({
    reference,
    provider,
    amount,
    platformFee,
    platformFeePercent,
    platformFlatFee,
    platformFeeCurrency: feeSchedule?.currency.toUpperCase() ?? currency,
    platformFeeScheduleId: feeSchedule?.id ?? null,
    currency,
    customerEmail: input.customerEmail.trim().toLowerCase(),
    customerName: input.customerName?.trim() || null,
    customerPhone: input.customerPhone?.trim() || null,
    description: input.description?.trim() || null,
    paymentLinkId: input.paymentLinkId ?? null,
    merchantId: input.merchantId ?? null,
  });

  const payment = await (dependencies.startProviderPayment ?? startProviderPayment)({
    reference,
    provider,
    amount: Number(row.amount),
    currency,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    description: row.description,
    paymentLinkSlug: input.paymentLinkSlug ?? null,
  });
  const [updated] = await db.update(transactionsTable).set({
    providerReference: payment.providerReference,
    paymentUrl: payment.paymentUrl,
  }).where(eq(transactionsTable.id, row.id)).returning();
  return { transaction: updated, checkoutUrl: payment.paymentUrl };
}