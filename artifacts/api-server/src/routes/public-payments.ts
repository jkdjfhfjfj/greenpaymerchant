import { Router, type IRouter } from "express";
import {
  CheckoutPaymentLinkBody,
  CheckoutPaymentLinkParams,
  CheckoutPaymentLinkResponse,
  COLLECTION_CURRENCIES,
  GetPublicPaymentLinkParams,
  GetPublicPaymentLinkResponse,
  GetPublicTransactionStatusParams,
  GetPublicTransactionStatusResponse,
  GetPublicPricingResponse,
  ListMerchantWalletFxRatesResponse,
  ListSupportedCurrenciesResponse,
} from "@workspace/api-zod";
import { createCollection } from "../lib/greenpay-collection";
import {
  ApiError, collectionPaymentMethodsForCurrency, providerForCurrency, providerIsConfigured,
  resolveCollectionPaymentMethod, verifyProviderPayment,
} from "../lib/greenpay-provider";
import {
  findTransaction,
  getPaymentLinkBySlug,
  markTransactionStatus,
} from "../lib/greenpay-ledger";
import { listMerchantWalletFxRates } from "../lib/wallet-service";
import {
  db, feeSchedulesTable, merchantInvoicesTable, merchantsTable, paymentLinksTable, refundsTable, transactionsTable,
  verificationTierLimitsTable, collectionCurrencyAvailabilityTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { assertMerchantActionEnabled, getPlatformSettings } from "../lib/platform";
import { merchantVerificationTier, type VerificationTier } from "../lib/security-policy";
import { invoiceOutstandingAmount } from "../lib/merchant-business-tools";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "../lib/payment-safety";
import {
  publicCheckoutFailure, publicPaymentFailureReason, resolvePublicCheckoutAmount, resolvePublicCheckoutCurrency,
} from "../lib/public-payment-policy";

const router: IRouter = Router();
const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;

async function getCollectionCurrencyOptions(verificationTier?: VerificationTier) {
  const platformReady = (await getPlatformSettings()).paymentsEnabled;
  const adminAvailabilityRows = await db.select().from(collectionCurrencyAvailabilityTable);
  const disabledCurrencies = new Set(adminAvailabilityRows.filter((row) => !row.enabled).map((row) => row.currency));
  const routeReadiness = {
    paystack: await providerIsConfigured("paystack"),
    payhero: await providerIsConfigured("payhero"),
    payzaapi: await providerIsConfigured("payzaapi"),
  };
  const configuredTierRows = verificationTier === undefined
    ? await db.select({ currency: verificationTierLimitsTable.currency }).from(verificationTierLimitsTable)
    : await db.select({ currency: verificationTierLimitsTable.currency }).from(verificationTierLimitsTable)
      .where(eq(verificationTierLimitsTable.tier, verificationTier));
  const configuredTierCurrencies = new Set(configuredTierRows.map(({ currency }) => currency.toUpperCase()));
  return COLLECTION_CURRENCIES.map(({ code, name, minorUnits }) => {
    const comingSoon = disabledCurrencies.has(code);
    const collectionReady = !comingSoon && platformReady &&
      routeReadiness[providerForCurrency(code)] &&
      configuredTierCurrencies.has(code);
    return {
      code,
      name,
      minorUnits,
      comingSoon,
      collectionReady,
      paymentMethods: collectionPaymentMethodsForCurrency(code, collectionReady),
    };
  });
}

type InvoicePaymentLinkState = {
  invoiceOutstandingAmount: number | null;
  hasPendingCollection: boolean;
  problem: { status: number; message: string } | null;
};

async function invoicePaymentLinkState(
  link: Awaited<ReturnType<typeof getPaymentLinkBySlug>>,
): Promise<InvoicePaymentLinkState> {
  if (!link) return { invoiceOutstandingAmount: null, hasPendingCollection: false, problem: null };
  const [invoiceReference] = await db.select({ id: merchantInvoicesTable.id }).from(merchantInvoicesTable)
    .where(eq(merchantInvoicesTable.paymentLinkId, link.id)).limit(1);
  if (!invoiceReference) return { invoiceOutstandingAmount: null, hasPendingCollection: false, problem: null };

  return db.transaction(async (tx): Promise<InvoicePaymentLinkState> => {
    // Keep the same invoice-then-link lock order as createCollection so
    // customer-facing reads cannot deadlock an in-flight checkout.
    const [invoice] = await tx.select().from(merchantInvoicesTable)
      .where(eq(merchantInvoicesTable.id, invoiceReference.id)).for("update").limit(1);
    const [lockedLink] = await tx.select().from(paymentLinksTable)
      .where(eq(paymentLinksTable.id, link.id)).for("update").limit(1);
    if (!invoice || !lockedLink || lockedLink.status !== "active" || invoice.paymentLinkId !== lockedLink.id) {
      if (lockedLink?.status === "active") {
        await tx.update(paymentLinksTable).set({ status: "archived" }).where(and(
          eq(paymentLinksTable.id, lockedLink.id),
          eq(paymentLinksTable.status, "active"),
        ));
      }
      return {
        invoiceOutstandingAmount: null,
        hasPendingCollection: false,
        problem: { status: 409, message: "This invoice payment link is no longer current. Ask the merchant for a fresh payment link." },
      };
    }
    const [pendingCollection] = await tx.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
      eq(transactionsTable.merchantId, invoice.merchantId),
      eq(transactionsTable.paymentLinkId, lockedLink.id),
      eq(transactionsTable.status, "pending"),
    )).limit(1);
    const paidTransactions = await tx.select().from(transactionsTable).where(and(
      eq(transactionsTable.merchantId, invoice.merchantId),
      eq(transactionsTable.paymentLinkId, lockedLink.id),
      inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    ));
    const collected = paidTransactions.reduce((sum, row) => sum + (row.paidAt ? Number(row.amount) : 0), 0);
    let refunded = 0;
    for (const transaction of paidTransactions) {
      const confirmedRefunds = await tx.select({ amount: refundsTable.amount }).from(refundsTable).where(and(
        eq(refundsTable.originalReference, transaction.reference),
        inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
      ));
      refunded += confirmedRefunds.reduce((sum, row) => sum + Number(row.amount), 0);
    }
    const outstanding = invoiceOutstandingAmount(
      invoice.total,
      Math.max(0, Math.min(invoice.total, collected - refunded)),
    );
    const stale = invoice.status === "void" || outstanding <= 0 ||
      lockedLink.amountType !== "fixed" || Number(lockedLink.amount) !== outstanding ||
      Number(invoice.paymentLinkAmount ?? lockedLink.amount) !== outstanding;
    if (stale) {
      await tx.update(paymentLinksTable).set({ status: "archived" }).where(and(
        eq(paymentLinksTable.id, lockedLink.id),
        eq(paymentLinksTable.status, "active"),
      ));
      return {
        invoiceOutstandingAmount: outstanding,
        hasPendingCollection: Boolean(pendingCollection),
        problem: { status: 409, message: "This invoice payment link is no longer current. Ask the merchant for a fresh payment link." },
      };
    }
    return {
      invoiceOutstandingAmount: outstanding,
      hasPendingCollection: Boolean(pendingCollection),
      problem: null,
    };
  });
}

router.get("/currencies", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ListSupportedCurrenciesResponse.parse({ items: await getCollectionCurrencyOptions() }));
});

router.get("/pricing", async (_req, res): Promise<void> => {
  const [schedule] = await db.select({
    percentage: feeSchedulesTable.percentage,
    flatAmount: feeSchedulesTable.flatAmount,
    currency: feeSchedulesTable.currency,
    fxMarkupBps: feeSchedulesTable.fxMarkupBps,
  }).from(feeSchedulesTable)
    .where(isNull(feeSchedulesTable.merchantId))
    .limit(1);
  res.setHeader("Cache-Control", "no-store");
  res.json(GetPublicPricingResponse.parse({
    globalSchedule: schedule ?? null,
    customSchedulesMayDiffer: true,
  }));
});

router.get("/public/fx-rates", async (_req, res): Promise<void> => {
  const rates = await listMerchantWalletFxRates("USD");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(ListMerchantWalletFxRatesResponse.parse(rates));
});

router.get("/public/payment-links/:slug", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = GetPublicPaymentLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const link = await getPaymentLinkBySlug(params.data.slug);
  if (!link || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
    res.status(404).json({ error: "This payment link is no longer available." });
    return;
  }
  const invoiceState = await invoicePaymentLinkState(link);
  if (invoiceState.problem) {
    res.status(invoiceState.problem.status).json({ error: invoiceState.problem.message });
    return;
  }
  let shopName: string | null = null;
  let shopLogoUrl: string | null = null;
  let verificationTier: VerificationTier | undefined;
  if (link.merchantId !== null) {
    const [merchant] = await db.select({
      status: merchantsTable.status,
      kycStatus: merchantsTable.kycStatus,
      kybStatus: merchantsTable.kybStatus,
      shopName: merchantsTable.shopName,
      shopLogoUrl: merchantsTable.shopLogoUrl,
    }).from(merchantsTable)
      .where(eq(merchantsTable.id, link.merchantId)).limit(1);
    if (!merchant || merchant.status !== "active") {
      res.status(404).json({ error: "This payment link is no longer available." });
      return;
    }
    verificationTier = merchantVerificationTier(merchant.kycStatus, merchant.kybStatus);
    shopName = merchant.shopName;
    shopLogoUrl = merchant.shopLogoUrl;
  }
  const currencies = await getCollectionCurrencyOptions(verificationTier);
  const availableCurrencies = link.amountType === "customer_choice" && invoiceState.invoiceOutstandingAmount === null
    ? currencies
    : currencies.filter(({ code }) => code === link.currency.toUpperCase());
  res.json(GetPublicPaymentLinkResponse.parse({
    slug: link.slug,
    name: link.name,
    description: link.description,
    amountType: link.amountType,
    amount: link.amount === null ? null : Number(link.amount),
    currency: link.currency,
    shopName,
    shopLogoUrl,
    availableCurrencies,
    expiresAt: link.expiresAt,
    invoiceOutstandingAmount: invoiceState.invoiceOutstandingAmount,
  }));
});

router.post("/public/payment-links/:slug/checkout", async (req, res): Promise<void> => {
  const params = CheckoutPaymentLinkParams.safeParse(req.params);
  const body = CheckoutPaymentLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid checkout request." });
    return;
  }
  const link = await getPaymentLinkBySlug(params.data.slug);
  if (!link || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
    res.status(404).json({ error: "This payment link is no longer available." });
    return;
  }
  const invoiceState = await invoicePaymentLinkState(link);
  if (invoiceState.problem) {
    res.status(invoiceState.problem.status).json({ error: invoiceState.problem.message });
    return;
  }
  if (invoiceState.hasPendingCollection) {
    res.status(409).json({
      error: "An invoice payment is awaiting confirmation. The outstanding balance is held until its outcome is known.",
    });
    return;
  }
  if (link.merchantId !== null) {
    await assertMerchantActionEnabled(link.merchantId, "collect");
    const [merchant] = await db.select({ status: merchantsTable.status }).from(merchantsTable)
      .where(eq(merchantsTable.id, link.merchantId)).limit(1);
    if (!merchant || merchant.status !== "active") {
      res.status(404).json({ error: "This payment link is no longer available." });
      return;
    }
  }
  const currencyResult = resolvePublicCheckoutCurrency({
    linkCurrency: link.currency,
    amountType: link.amountType === "fixed" ? "fixed" : "customer_choice",
    isInvoice: invoiceState.invoiceOutstandingAmount !== null,
    requestedCurrency: body.data.currency,
  });
  if ("error" in currencyResult) {
    res.status(400).json({
      error: currencyResult.error === "fixed_currency_immutable"
        ? "This payment link must be paid in its listed currency."
        : "This currency is not supported for checkout.",
    });
    return;
  }
  const currency = currencyResult.currency;
  const paymentMethod = resolveCollectionPaymentMethod(currency, body.data.paymentMethod);
  const amountResult = resolvePublicCheckoutAmount({
    amountType: link.amountType === "fixed" ? "fixed" : "customer_choice",
    fixedAmount: link.amount === null ? null : Number(link.amount),
    requestedAmount: body.data.amount,
    invoiceOutstandingAmount: invoiceState.invoiceOutstandingAmount,
  });
  if ("error" in amountResult) {
    const message = amountResult.error === "amount_exceeds_invoice_balance"
      ? "The requested payment exceeds the invoice's current outstanding balance."
      : amountResult.error === "fixed_link_amount_missing"
        ? "This fixed payment link has no valid amount."
        : "Enter an amount greater than zero.";
    res.status(400).json({ error: message });
    return;
  }
  const amount = amountResult.amount;
  if (paymentMethod.requiresPhone && !body.data.customerPhone?.trim()) {
    res.status(400).json({ error: "A phone number is required for the selected payment method." });
    return;
  }
  const result = await createCollection({
    amount,
    currency,
    paymentMethod: paymentMethod.id,
    customerEmail: body.data.customerEmail,
    customerName: body.data.customerName,
    customerPhone: body.data.customerPhone,
    description: link.description ?? link.name,
    paymentLinkId: link.id,
    paymentLinkSlug: link.slug,
    merchantId: link.merchantId ?? undefined,
  }).catch((error: unknown) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    req.log.warn({
      statusCode: status,
      failureReason: error instanceof ApiError ? error.message : "Unexpected collection failure",
    }, "Public checkout could not be initiated");
    const failure = publicCheckoutFailure(
      status,
      error instanceof Error ? error.message : "Please check your payment details.",
    );
    throw new ApiError(failure.status, failure.error);
  });
  res.status(201).json(CheckoutPaymentLinkResponse.parse({
    reference: result.transaction.reference,
    checkoutUrl: result.checkoutUrl,
    nextAction: result.checkoutUrl
      ? paymentMethod.nextAction
      : paymentMethod.nextAction === "mobile_prompt" ? "mobile_prompt" : "check_status",
  }));
});

router.get("/public/transactions/:reference", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const params = GetPublicTransactionStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  let transaction = await findTransaction(params.data.reference);
  if (!transaction) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  if (transaction.status === "pending") {
    const verified = await verifyProviderPayment(transaction).catch(() => {
      req.log.warn("Public payment confirmation is temporarily unavailable");
      throw new ApiError(503, "Payment confirmation is temporarily unavailable. Please try again shortly.");
    });
    transaction = await markTransactionStatus(transaction.reference, verified) ?? transaction;
  }
  let shopName: string | null = null;
  let shopLogoUrl: string | null = null;
  if (transaction.merchantId !== null) {
    const [merchant] = await db.select({
      shopName: merchantsTable.shopName,
      shopLogoUrl: merchantsTable.shopLogoUrl,
    }).from(merchantsTable)
      .where(eq(merchantsTable.id, transaction.merchantId)).limit(1);
    shopName = merchant?.shopName ?? null;
    shopLogoUrl = merchant?.shopLogoUrl ?? null;
  }
  res.json(GetPublicTransactionStatusResponse.parse({
    reference: transaction.reference,
    status: transaction.status,
    amount: Number(transaction.amount),
    currency: transaction.currency,
    paidAt: transaction.paidAt,
    createdAt: transaction.createdAt,
    shopName,
    shopLogoUrl,
    failureReason: publicPaymentFailureReason(transaction.status, transaction.failureReason),
  }));
});

export default router;