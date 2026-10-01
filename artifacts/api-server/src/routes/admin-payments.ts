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
import { db, refundsTable, transactionsTable } from "@workspace/db";
import { createCollection } from "../lib/greenpay-collection";
import {
  asObject,
  fetchProviderJson,
  getProviderStatuses,
  numberValue,
  payzaApiRequest,
  stringValue,
  verifyProviderPayment,
} from "../lib/greenpay-provider";
import {
  dashboardSummary,
  findTransaction,
  listTransactions,
  markTransactionStatus,
  recordRefund,
  transactionDto,
} from "../lib/greenpay-ledger";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  const summary = await dashboardSummary();
  res.json(GetDashboardResponse.parse({ ...summary, providerStatus: getProviderStatuses() }));
});

router.get("/providers/status", (_req, res): void => {
  res.json({ items: getProviderStatuses() });
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
  const params = RefundTransactionParams.safeParse(req.params);
  const body = RefundTransactionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error.message });
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

  const [refundTotal] = await db.select({
    total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
  }).from(refundsTable).where(and(
    eq(refundsTable.originalReference, transaction.reference),
    inArray(refundsTable.status, ["success", "recorded", "completed", "processed"]),
  ));
  const refundableLimit = Number(transaction.netAmount ?? transaction.amount);
  const remaining = Math.max(0, refundableLimit - Number(refundTotal?.total ?? 0));
  const requestedAmount = body.data.amount ?? remaining;
  if (!(requestedAmount > 0) || requestedAmount - remaining > 0.001) {
    res.status(400).json({ error: `The remaining refundable amount is ${remaining} ${transaction.currency}.` });
    return;
  }
  const reason = body.data.reason?.slice(0, 400) ?? null;
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
      amount: requestedAmount,
      currency: transaction.currency,
      status: "manual_required",
      reason: reason ?? "PayHero does not provide a documented refund endpoint; return funds manually.",
    });
  } else if (transaction.provider === "payzaapi") {
    const response = await payzaApiRequest("/refund", {
      method: "POST",
      body: JSON.stringify({
        reference: transaction.reference,
        ...(body.data.amount === undefined ? {} : { amount: body.data.amount }),
        ...(reason ? { reason } : {}),
      }),
    });
    const data = asObject(response.refund);
    if (response.success !== true) {
      res.status(502).json({ error: stringValue(response.message) ?? "Payzaapi did not record the refund." });
      return;
    }
    refund = await recordRefund({
      originalReference: transaction.reference,
      providerReference: stringValue(data.reference) ?? null,
      amount: numberValue(data.amount) ?? requestedAmount,
      currency: stringValue(data.currency) ?? transaction.currency,
      status: "recorded",
      reason,
    });
  } else {
    const response = await fetchProviderJson("Paystack", "https://api.paystack.co/refund", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: transaction.providerReference ?? transaction.reference,
        ...(body.data.amount === undefined ? {} : { amount: Math.round(body.data.amount * 100) }),
        ...(reason ? { customer_note: reason, merchant_note: reason } : {}),
      }),
    });
    const data = asObject(response.data);
    if (response.status !== true) {
      res.status(502).json({ error: stringValue(response.message) ?? "Paystack did not accept the refund request." });
      return;
    }
    const providerStatus = stringValue(data.status)?.toLowerCase();
    const status = ["processed", "success", "completed"].includes(providerStatus ?? "")
      ? "success"
      : ["failed", "reversed"].includes(providerStatus ?? "")
        ? "failed"
        : "pending";
    refund = await recordRefund({
      originalReference: transaction.reference,
      providerReference: data.id === undefined ? null : String(data.id),
      amount: numberValue(data.amount) === undefined ? requestedAmount : Number(data.amount) / 100,
      currency: stringValue(data.currency) ?? transaction.currency,
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