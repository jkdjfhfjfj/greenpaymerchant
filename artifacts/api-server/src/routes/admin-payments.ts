import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateTransactionBody,
  CreateTransactionResponse,
  GetDashboardResponse,
  GetTransactionParams,
  GetTransactionResponse,
  ListTransactionsQueryParams,
  ListTransactionsResponse,
  RefundTransactionBody,
  RefundTransactionParams,
  RefundTransactionResponse,
  VerifyTransactionParams,
  VerifyTransactionResponse,
} from "@workspace/api-zod";
import { db, merchantsTable, refundsTable, transactionsTable } from "@workspace/db";
import { createCollection } from "../lib/greenpay-collection";
import {
  asObject,
  fetchProviderJson,
  getProviderStatuses,
  numberValue,
  stringValue,
  verifyProviderPayment,
} from "../lib/greenpay-provider";
import {
  dashboardSummary,
  findTransaction,
  listTransactions,
  markTransactionStatus,
  reconcilePendingPaystackRefunds,
  recordRefund,
  transactionDto,
} from "../lib/greenpay-ledger";
import { providerCredential } from "../lib/credential-runtime";
import { assertMerchantCapability } from "../lib/platform";
import {
  CUSTOMER_REIMBURSED_REFUND_STATUSES,
  OPEN_REFUND_RESERVATION_STATUSES,
  paystackRefundOutcome,
  remainingRefundableAmount,
} from "../lib/payment-safety";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  const summary = await dashboardSummary();
  res.json(GetDashboardResponse.parse({ ...summary, providerStatus: await getProviderStatuses() }));
});

router.get("/providers/status", async (_req, res): Promise<void> => {
  res.json({ items: await getProviderStatuses() });
});

router.get("/transactions", async (req, res): Promise<void> => {
  const parsed = ListTransactionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await listTransactions({
    search: parsed.data.search,
    status: parsed.data.status,
    currency: parsed.data.currency,
    page: parsed.data.page ?? 1,
    perPage: parsed.data.perPage ?? 25,
  });
  res.json(ListTransactionsResponse.parse(result));
});

router.post("/transactions", async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await createCollection(parsed.data);
  res.status(201).json(CreateTransactionResponse.parse({
    transaction: transactionDto(result.transaction),
    checkoutUrl: result.checkoutUrl,
  }));
});

router.get("/transactions/:reference", async (req, res): Promise<void> => {
  const params = GetTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const transaction = await findTransaction(params.data.reference);
  if (!transaction) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  res.json(GetTransactionResponse.parse(transactionDto(transaction)));
});

router.post("/transactions/:reference/verify", async (req, res): Promise<void> => {
  const params = VerifyTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const transaction = await findTransaction(params.data.reference);
  if (!transaction) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  const verified = await verifyProviderPayment(transaction);
  const updated = await markTransactionStatus(transaction.reference, verified);
  if (!updated) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  res.json(VerifyTransactionResponse.parse(transactionDto(updated)));
});

router.post("/transactions/:reference/refund", async (req, res): Promise<void> => {
  const { assertPlatformEnabled } = await import("../lib/platform");
  await assertPlatformEnabled("refundsEnabled");
  const params = RefundTransactionParams.safeParse(req.params);
  const body = RefundTransactionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid refund request." });
    return;
  }
  const transaction = await findTransaction(params.data.reference);
  if (!transaction) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  if (transaction.status !== "success") {
    res.status(409).json({ error: "Only confirmed payments can be refunded." });
    return;
  }
  if (transaction.merchantId !== null) {
    const [merchant] = await db.select().from(merchantsTable)
      .where(eq(merchantsTable.id, transaction.merchantId)).limit(1);
    if (!merchant) { res.status(409).json({ error: "The transaction's merchant account no longer exists." }); return; }
    await assertMerchantCapability(merchant, "refundsEnabled");
  }
  if (transaction.provider === "paystack") {
    try {
      await reconcilePendingPaystackRefunds(transaction.reference);
    } catch {
      res.status(503).json({ error: "Pending Paystack refunds could not be reconciled; no new refund was submitted." });
      return;
    }
  }
  if (transaction.provider === "payzaapi") {
    res.status(501).json({ error: "Payzaapi's refund endpoint adjusts the provider wallet and does not reimburse the customer. Customer refunds require a supported provider flow or manual handling." });
    return;
  }

  const reason = body.data.reason?.slice(0, 400) ?? null;
  const amountRequest = await db.transaction(async (tx) => {
    await tx.select({ id: transactionsTable.id }).from(transactionsTable)
      .where(eq(transactionsTable.reference, transaction.reference)).for("update");
    const [current] = await tx.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, transaction.reference)).limit(1);
    if (!current || current.status !== "success") return { error: "Only confirmed payments can be refunded." } as const;
    const [inFlight] = await tx.select({ id: refundsTable.id }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, current.reference),
      inArray(refundsTable.status, OPEN_REFUND_RESERVATION_STATUSES),
    )).limit(1);
    if (inFlight) return { error: "A refund for this payment is already pending or requires manual reconciliation." } as const;
    const [refundTotal] = await tx.select({
      total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
    }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, current.reference),
      inArray(refundsTable.status, CUSTOMER_REIMBURSED_REFUND_STATUSES),
    ));
    const refundableLimit = Number(current.amount);
    const remaining = remainingRefundableAmount(refundableLimit, Number(refundTotal?.total ?? 0));
    const requestedAmount = Math.round((body.data.amount ?? remaining) * 100) / 100;
    if (!(requestedAmount > 0) || requestedAmount - remaining > 0.001) {
      return { error: `The remaining refundable amount is ${remaining} ${current.currency}.` } as const;
    }
    const [reservation] = await tx.insert(refundsTable).values({
      reference: `GP-RF-${randomUUID()}`,
      originalReference: current.reference,
      provider: current.provider,
      amount: requestedAmount,
      currency: current.currency,
      status: "pending",
      reason,
    }).returning();
    return { reservation, requestedAmount } as const;
  });
  if ("error" in amountRequest) {
    const message = amountRequest.error ?? "Refund could not be reserved safely.";
    res.status(message.startsWith("The remaining") ? 400 : 409).json({ error: message });
    return;
  }
  const { reservation, requestedAmount } = amountRequest;

  let refund: {
    reference: string;
    originalReference: string;
    amount: number;
    currency: string;
    status: string;
    reason: string | null;
    createdAt: Date;
  };

  if (transaction.provider === "payhero") {
    refund = await recordRefund({
      originalReference: transaction.reference,
      reservationId: reservation.id,
      provider: transaction.provider,
      source: "initiation",
      amount: requestedAmount,
      currency: transaction.currency,
      status: "manual_required",
      reason: reason ?? "PayHero does not provide a documented refund endpoint; return funds manually.",
    });
  } else {
    let response: Record<string, unknown>;
    try {
      response = await fetchProviderJson("Paystack", "https://api.paystack.co/refund", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await providerCredential("paystack", "PAYSTACK_SECRET_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transaction: transaction.providerReference ?? transaction.reference,
          amount: Math.round(requestedAmount * 100),
          ...(reason ? { customer_note: reason } : {}),
          merchant_note: `${reservation.reference}${reason ? `: ${reason}` : ""}`,
        }),
      });
    } catch {
      res.status(503).json({ error: `Paystack refund outcome is uncertain; refund ${reservation.reference} remains reserved for reconciliation.` });
      return;
    }
    const data = asObject(response.data);
    if (response.status !== true) {
      await recordRefund({
        originalReference: transaction.reference,
        reservationId: reservation.id,
        provider: "paystack",
        source: "initiation",
        amount: requestedAmount,
        currency: transaction.currency,
        status: "failed",
        reason,
      });
      res.status(502).json({ error: "Paystack did not accept the refund request." });
      return;
    }
    const providerStatus = stringValue(data.status)?.toLowerCase();
    const reportedAmount = numberValue(data.amount);
    const reportedCurrency = stringValue(data.currency)?.toUpperCase();
    const status = paystackRefundOutcome({
      status: providerStatus, reportedAmount, requestedAmount,
      reportedCurrency, expectedCurrency: transaction.currency,
    });
    refund = await recordRefund({
      originalReference: transaction.reference,
      reservationId: reservation.id,
      provider: "paystack",
      providerReference: data.id === undefined ? null : String(data.id),
      source: "initiation",
      amount: requestedAmount,
      currency: transaction.currency,
      status,
      reason,
    });
  }

  res.status(201).json(RefundTransactionResponse.parse({
    reference: refund.reference,
    originalReference: refund.originalReference,
    amount: Number(refund.amount),
    currency: refund.currency,
    status: refund.status,
    reason: refund.reason,
    createdAt: refund.createdAt,
  }));
});

export default router;