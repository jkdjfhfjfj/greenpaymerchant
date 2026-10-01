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
  ListSupportedCurrenciesResponse,
} from "@workspace/api-zod";
import { createCollection } from "../lib/greenpay-collection";
import { ApiError, providerForCurrency, providerIsConfigured, verifyProviderPayment } from "../lib/greenpay-provider";
import {
  findTransaction,
  getPaymentLinkBySlug,
  markTransactionStatus,
} from "../lib/greenpay-ledger";
import { db, merchantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPlatformSettings } from "../lib/platform";

const router: IRouter = Router();

router.get("/currencies", async (_req, res): Promise<void> => {
  const platformReady = (await getPlatformSettings()).paymentsEnabled;
  const routeReadiness = {
    paystack: await providerIsConfigured("paystack"),
    payhero: await providerIsConfigured("payhero"),
    payzaapi: await providerIsConfigured("payzaapi"),
  };
  const items = await Promise.all(COLLECTION_CURRENCIES.map(async ({ code, name, minorUnits }) => ({
    code,
    name,
    minorUnits,
    collectionReady: platformReady && routeReadiness[providerForCurrency(code)],
  })));
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(ListSupportedCurrenciesResponse.parse({ items }));
});

router.get("/public/payment-links/:slug", async (req, res): Promise<void> => {
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
  if (link.merchantId !== null) {
    const [merchant] = await db.select({ status: merchantsTable.status }).from(merchantsTable)
      .where(eq(merchantsTable.id, link.merchantId)).limit(1);
    if (!merchant || merchant.status !== "active") {
      res.status(404).json({ error: "This payment link is no longer available." });
      return;
    }
  }
  res.json(GetPublicPaymentLinkResponse.parse({
    slug: link.slug,
    name: link.name,
    description: link.description,
    amountType: link.amountType,
    amount: link.amount === null ? null : Number(link.amount),
    currency: link.currency,
    expiresAt: link.expiresAt,
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
  if (link.merchantId !== null) {
    const [merchant] = await db.select({ status: merchantsTable.status }).from(merchantsTable)
      .where(eq(merchantsTable.id, link.merchantId)).limit(1);
    if (!merchant || merchant.status !== "active") {
      res.status(404).json({ error: "This payment link is no longer available." });
      return;
    }
  }
  const amount = link.amountType === "fixed" ? Number(link.amount) : body.data.amount;
  if (!(amount && amount > 0)) {
    res.status(400).json({ error: "Enter an amount greater than zero." });
    return;
  }
  if (link.currency === "KES" && !body.data.customerPhone?.trim()) {
    res.status(400).json({ error: "A phone number is required for the M-Pesa prompt." });
    return;
  }
  const result = await createCollection({
    amount,
    currency: link.currency,
    customerEmail: body.data.customerEmail,
    customerName: body.data.customerName,
    customerPhone: body.data.customerPhone,
    description: link.description ?? link.name,
    paymentLinkId: link.id,
    paymentLinkSlug: link.slug,
    merchantId: link.merchantId ?? undefined,
  }).catch((error: unknown) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    req.log.warn({ statusCode: status }, "Public checkout could not be initiated");
    if (status === 400 || status === 422) {
      throw new ApiError(status, "We could not start this payment. Please check your details and try again.");
    }
    throw new ApiError(503, "Payments are temporarily unavailable. Please try again shortly.");
  });
  res.status(201).json(CheckoutPaymentLinkResponse.parse({
    reference: result.transaction.reference,
    checkoutUrl: result.checkoutUrl,
    nextAction: result.checkoutUrl
      ? "redirect"
      : result.transaction.provider === "payhero" ? "mobile_prompt" : "check_status",
  }));
});

router.get("/public/transactions/:reference", async (req, res): Promise<void> => {
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
  res.json(GetPublicTransactionStatusResponse.parse({
    reference: transaction.reference,
    status: transaction.status,
    amount: Number(transaction.amount),
    currency: transaction.currency,
    paidAt: transaction.paidAt,
    createdAt: transaction.createdAt,
  }));
});

export default router;