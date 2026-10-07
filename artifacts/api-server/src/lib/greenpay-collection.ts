import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  collectionCurrency,
  hasCollectionAmountPrecision,
  normalizeCollectionAmount,
} from "@workspace/api-zod";
import {
  db, feeSchedulesTable, merchantInvoicesTable, merchantsTable, paymentLinksTable,
  refundsTable, transactionsTable, collectionCurrencyAvailabilityTable,
} from "@workspace/db";
import {
  ApiError, assertSupportedCurrency, providerForCurrency, providerIsConfigured, startProviderPayment,
  resolveCollectionPaymentMethod, type CollectionPaymentMethodId, type ProviderName, type StartPaymentInput, type StartPaymentResult,
} from "./greenpay-provider";
import { markTransactionStatus } from "./greenpay-ledger";
import { assertMerchantMayTransact, assertPlatformEnabled, reserveVerificationUsage } from "./platform";
import { invoiceOutstandingAmount } from "./merchant-business-tools";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "./payment-safety";

const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;
const OPEN_TRANSACTION_STATUSES = ["pending"] as const;

export interface CreateCollectionInput {
  amount: number;
  currency: string;
  paymentMethod?: CollectionPaymentMethodId;
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
  isCurrencyEnabled?: (currency: string) => Promise<boolean>;
  loadFeeSchedule?: (merchantId?: number) => Promise<typeof feeSchedulesTable.$inferSelect | undefined>;
  startProviderPayment?: (input: StartPaymentInput) => Promise<StartPaymentResult>;
}

export function assertCollectionAmountPrecision(amount: number, currency: string): void {
  const item = collectionCurrency(currency);
  if (!item || !hasCollectionAmountPrecision(amount, currency)) {
    const digits = item?.minorUnits ?? 0;
    const precision = digits === 0 ? "whole units" : `at most ${digits} fractional digits`;
    throw new ApiError(400, `${currency.toUpperCase()} collection amounts must use ${precision}.`);
  }
}

export async function createCollection(
  input: CreateCollectionInput,
  dependencies: CreateCollectionDependencies = {},
) {
  const currency = input.currency.toUpperCase();
  const currencyEnabled = await (dependencies.isCurrencyEnabled ?? (async (code) => {
    const [availability] = await db.select({ enabled: collectionCurrencyAvailabilityTable.enabled })
      .from(collectionCurrencyAvailabilityTable)
      .where(eq(collectionCurrencyAvailabilityTable.currency, code)).limit(1);
    return availability?.enabled ?? true;
  }))(currency);
  if (!currencyEnabled) throw new ApiError(503, `Collections in ${currency} are coming soon and are not currently enabled.`);
  await (dependencies.assertPaymentsEnabled ?? (() => assertPlatformEnabled("paymentsEnabled")))();
  if (input.merchantId !== undefined) {
    const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, input.merchantId)).limit(1);
    if (!merchant) throw new ApiError(404, "Merchant account not found.");
    await assertMerchantMayTransact(merchant);
  }
  assertSupportedCurrency(currency);
  assertCollectionAmountPrecision(input.amount, currency);
  const amount = normalizeCollectionAmount(input.amount, currency);
  const provider: ProviderName = providerForCurrency(currency);
  const paymentMethod = resolveCollectionPaymentMethod(currency, input.paymentMethod);
  if (!await (dependencies.providerIsConfigured ?? providerIsConfigured)(provider)) {
    throw new ApiError(503, "Payments are unavailable for this currency right now.");
  }
  if (provider === "payhero" && !Number.isInteger(input.amount)) {
    throw new ApiError(400, "KES M-Pesa collections must use whole shillings.");
  }
  if (paymentMethod.requiresPhone && !input.customerPhone?.trim()) {
    throw new ApiError(400, "A phone number is required for the selected payment method.");
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
  const outcome = await db.transaction(async (tx) => {
    const [linkedInvoice] = input.paymentLinkId === undefined ? [] : await tx.select().from(merchantInvoicesTable)
      .where(eq(merchantInvoicesTable.paymentLinkId, input.paymentLinkId)).for("update").limit(1);
    let lockedLink: typeof paymentLinksTable.$inferSelect | undefined;
    if (input.paymentLinkId !== undefined) {
      [lockedLink] = await tx.select().from(paymentLinksTable)
        .where(eq(paymentLinksTable.id, input.paymentLinkId)).for("update").limit(1);
      if (!lockedLink || lockedLink.status !== "active" || lockedLink.slug !== input.paymentLinkSlug ||
          lockedLink.merchantId !== (input.merchantId ?? null)) {
        return { blocked: "This payment link is no longer active." as const, statusCode: 409 as const };
      }
      if (!linkedInvoice && lockedLink.amountType === "fixed" && Number(lockedLink.amount) !== amount) {
        return { blocked: "The payment amount does not match this fixed payment link." as const, statusCode: 409 as const };
      }
    }
    if (linkedInvoice) {
      if (!lockedLink || lockedLink.merchantId !== linkedInvoice.merchantId ||
          linkedInvoice.merchantId !== input.merchantId || lockedLink.status !== "active") {
        return { blocked: "This invoice payment link is no longer active." as const, statusCode: 409 as const };
      }
      const [pendingCollection] = await tx.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
        eq(transactionsTable.paymentLinkId, linkedInvoice.paymentLinkId!),
        eq(transactionsTable.merchantId, linkedInvoice.merchantId),
        inArray(transactionsTable.status, [...OPEN_TRANSACTION_STATUSES]),
      )).limit(1);
      if (pendingCollection) {
        return { blocked: "An invoice payment is awaiting provider confirmation. The balance is held until its outcome is known." as const, statusCode: 409 as const };
      }
      const paidTransactions = await tx.select().from(transactionsTable).where(and(
        eq(transactionsTable.merchantId, linkedInvoice.merchantId),
        eq(transactionsTable.paymentLinkId, linkedInvoice.paymentLinkId!),
        inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
      ));
      const collected = paidTransactions.reduce((sum, row) => sum + (row.paidAt ? Number(row.amount) : 0), 0);
      let refunded = 0;
      for (const transaction of paidTransactions) {
        const confirmedRefunds = await tx.select({ amount: refundsTable.amount }).from(refundsTable).where(and(
          eq(refundsTable.originalReference, transaction.reference),
          inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
        ));
        refunded += confirmedRefunds.reduce((sum, refund) => sum + Number(refund.amount), 0);
      }
      const outstanding = invoiceOutstandingAmount(
        linkedInvoice.total,
        Math.max(0, Math.min(linkedInvoice.total, collected - refunded)),
      );
      if (outstanding <= 0 || Number(lockedLink.amount) !== outstanding ||
          Number(linkedInvoice.paymentLinkAmount ?? lockedLink.amount) !== outstanding || amount > outstanding) {
        await tx.update(paymentLinksTable).set({ status: "archived" }).where(eq(paymentLinksTable.id, lockedLink.id));
        return { blocked: "This invoice payment link no longer matches the outstanding balance. Request a fresh invoice payment link." as const, statusCode: 409 as const };
      }
    }
    if (input.merchantId !== undefined) {
      const [merchant] = await tx.select().from(merchantsTable)
        .where(eq(merchantsTable.id, input.merchantId)).for("update").limit(1);
      if (!merchant) return { blocked: "Merchant account not found." as const, statusCode: 404 };
      await assertMerchantMayTransact(merchant);
    }
    const [pending] = await tx.insert(transactionsTable).values({
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
      status: "pending",
      settlementStatus: "not_applicable",
    }).returning();
    if (input.merchantId !== undefined) {
      await reserveVerificationUsage(tx, input.merchantId, "collection", amount, currency, pending!.id);
    }
    return { transaction: pending! };
  });
  if (!("transaction" in outcome) || !outcome.transaction) {
    if ("blocked" in outcome && outcome.blocked) throw new ApiError(outcome.statusCode, outcome.blocked);
    throw new ApiError(500, "The collection could not be reserved.");
  }
  const row = outcome.transaction;

  let payment: StartPaymentResult;
  try {
    payment = await (dependencies.startProviderPayment ?? startProviderPayment)({
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
  } catch (error) {
    if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500) {
      await markTransactionStatus(reference, { status: "failed", reason: error.message });
    }
    throw error;
  }
  const [updated] = await db.update(transactionsTable).set({
    providerReference: payment.providerReference,
    paymentUrl: payment.paymentUrl,
  }).where(eq(transactionsTable.id, row.id)).returning();
  return { transaction: updated, checkoutUrl: payment.paymentUrl };
}