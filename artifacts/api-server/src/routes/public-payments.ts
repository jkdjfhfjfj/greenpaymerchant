import { Router, type IRouter } from "express";
import {
  CheckoutPaymentLinkBody,
  CheckoutPaymentLinkParams,
  CheckoutPaymentLinkResponse,
  GetPublicPaymentLinkParams,
  GetPublicPaymentLinkResponse,
  GetPublicTransactionStatusParams,
  GetPublicTransactionStatusResponse,
} from "@workspace/api-zod";
import { createCollection } from "../lib/greenpay-collection";
import { providerForCurrency, verifyProviderPayment } from "../lib/greenpay-provider";
import {
  findTransaction,
  getPaymentLinkBySlug,
  markTransactionStatus,
  transactionDto,
} from "../lib/greenpay-ledger";

const router: IRouter = Router();

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
  res.json(GetPublicPaymentLinkResponse.parse({
    slug: link.slug,
    name: link.name,
    description: link.description,
    amountType: link.amountType,
    amount: link.amount === null ? null : Number(link.amount),
    currency: link.currency,
    provider: providerForCurrency(link.currency),
    expiresAt: link.expiresAt,
  }));
});

router.post("/public/payment-links/:slug/checkout", async (req, res): Promise<void> => {
  const params = CheckoutPaymentLinkParams.safeParse(req.params);
  const body = CheckoutPaymentLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error.message });
    return;
  }
  const link = await getPaymentLinkBySlug(params.data.slug);
  if (!link || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
    res.status(404).json({ error: "This payment link is no longer available." });
    return;
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
  });
  res.status(201).json(CheckoutPaymentLinkResponse.parse({
    transaction: transactionDto(result.transaction),
    checkoutUrl: result.checkoutUrl,
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
    const verified = await verifyProviderPayment(transaction);
    transaction = await markTransactionStatus(transaction.reference, verified) ?? transaction;
  }
  res.json(GetPublicTransactionStatusResponse.parse({
    reference: transaction.reference,
    status: transaction.status,
    amount: Number(transaction.amount),
    currency: transaction.currency,
    provider: transaction.provider,
    paidAt: transaction.paidAt,
    createdAt: transaction.createdAt,
  }));
});

export default router;