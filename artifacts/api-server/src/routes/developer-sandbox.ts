import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateDeveloperTransactionHeader,
  CreateSandboxTransactionBody,
  CreateSandboxTransactionResponse,
  GetSandboxTransactionParams,
  GetSandboxTransactionResponse,
  ListSandboxTransactionsQueryParams,
  ListSandboxTransactionsResponse,
  VerifySandboxTransactionParams,
  VerifySandboxTransactionResponse,
} from "@workspace/api-zod";
import { db, sandboxTransactionsTable, platformSettingsTable } from "@workspace/db";
import { assertCollectionAmountPrecision } from "../lib/greenpay-collection";
import { assertSupportedCurrency } from "../lib/greenpay-provider";
import { developerApiAuth, requireApiKeyEnvironment, requireApiScope } from "../middlewares/developerApiAuth";

const router: IRouter = Router();
const apiRouter: IRouter = Router();

function transactionDto(row: typeof sandboxTransactionsTable.$inferSelect) {
  return {
    id: row.id,
    reference: row.reference,
    amount: row.amount,
    fee: null,
    netAmount: null,
    currency: row.currency,
    status: row.status,
    provider: "sandbox" as const,
    providerReference: null,
    paymentMethod: row.paymentMethod,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    description: row.description,
    failureReason: row.failureReason,
    paymentUrl: null,
    paymentLinkId: null,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    settlementAt: null,
    settlementStatus: "not_applicable" as const,
  };
}

function createdResponse(row: typeof sandboxTransactionsTable.$inferSelect) {
  return CreateSandboxTransactionResponse.parse({
    transaction: transactionDto(row),
    checkoutUrl: null,
    simulated: true,
  });
}

apiRouter.use(developerApiAuth, requireApiKeyEnvironment("sandbox"), (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

apiRouter.get("/transactions", requireApiScope("read"), async (req, res): Promise<void> => {
  const query = ListSandboxTransactionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const merchantId = (res.locals.merchant as { id: number }).id;
  const where = eq(sandboxTransactionsTable.merchantId, merchantId);
  const [count] = await db.select({ count: sql<number>`count(*)::int` })
    .from(sandboxTransactionsTable).where(where);
  const rows = await db.select().from(sandboxTransactionsTable).where(where)
    .orderBy(desc(sandboxTransactionsTable.createdAt))
    .limit(query.data.perPage)
    .offset((query.data.page - 1) * query.data.perPage);
  res.json(ListSandboxTransactionsResponse.parse({
    items: rows.map(transactionDto),
    total: Number(count?.count ?? 0),
    page: query.data.page,
    perPage: query.data.perPage,
  }));
});

apiRouter.post("/transactions", requireApiScope("payments:write"), async (req, res): Promise<void> => {
  if (typeof req.body === "object" && req.body !== null && "paymentLinkId" in req.body) {
    res.status(400).json({ error: "Sandbox transactions cannot reference live payment links." });
    return;
  }
  const header = CreateDeveloperTransactionHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  const parsed = CreateSandboxTransactionBody.safeParse(req.body);
  if (!header.success || !parsed.success) {
    res.status(400).json({
      error: !header.success ? header.error.message : parsed.error?.message ?? "Invalid sandbox transaction request.",
    });
    return;
  }

  const merchantId = (res.locals.merchant as { id: number }).id;
  const values = parsed.data;
  const currency = values.currency.toUpperCase();
  try {
    assertSupportedCurrency(currency);
    assertCollectionAmountPrecision(values.amount, currency);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported sandbox currency or amount." });
    return;
  }
  if (values.paymentMethod === "mobile_prompt" && !values.customerPhone?.trim()) {
    res.status(400).json({ error: "A phone number is required when testing the mobile prompt payment method." });
    return;
  }

  const [settings] = await db.select({
    sandboxDefaultOutcome: platformSettingsTable.sandboxDefaultOutcome,
  }).from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const status = values.testOutcome ?? settings?.sandboxDefaultOutcome ?? "pending";
  const requestHash = createHash("sha256").update(JSON.stringify({
    amount: values.amount,
    currency,
    paymentMethod: values.paymentMethod ?? null,
    customerEmail: values.customerEmail.trim().toLowerCase(),
    customerName: values.customerName?.trim() ?? null,
    customerPhone: values.customerPhone?.trim() ?? null,
    description: values.description?.trim() ?? null,
    status,
  })).digest("hex");
  const idempotencyKey = header.data["Idempotency-Key"];
  const createdAt = new Date();
  const [created] = await db.insert(sandboxTransactionsTable).values({
    reference: `sbx_${randomUUID().replaceAll("-", "")}`,
    merchantId,
    idempotencyKey,
    requestHash,
    amount: values.amount,
    currency,
    paymentMethod: values.paymentMethod ?? null,
    customerEmail: values.customerEmail.trim().toLowerCase(),
    customerName: values.customerName?.trim() || null,
    customerPhone: values.customerPhone?.trim() || null,
    description: values.description?.trim() || null,
    status,
    failureReason: status === "failed" ? "Simulated sandbox failure." : null,
    createdAt,
    paidAt: status === "success" ? createdAt : null,
  }).onConflictDoNothing({
    target: [sandboxTransactionsTable.merchantId, sandboxTransactionsTable.idempotencyKey],
  }).returning();

  if (!created) {
    const [existing] = await db.select().from(sandboxTransactionsTable).where(and(
      eq(sandboxTransactionsTable.merchantId, merchantId),
      eq(sandboxTransactionsTable.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (!existing) {
      res.status(503).json({ error: "Unable to safely reserve this sandbox idempotency key." });
      return;
    }
    if (existing.requestHash !== requestHash) {
      res.status(409).json({ error: "This idempotency key was already used with a different sandbox request." });
      return;
    }
    res.setHeader("Idempotent-Replayed", "true");
    res.status(201).json(createdResponse(existing));
    return;
  }

  res.status(201).json(createdResponse(created));
});

apiRouter.get("/transactions/:reference", requireApiScope("read"), async (req, res): Promise<void> => {
  const params = GetSandboxTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const merchantId = (res.locals.merchant as { id: number }).id;
  const [transaction] = await db.select().from(sandboxTransactionsTable).where(and(
    eq(sandboxTransactionsTable.reference, params.data.reference),
    eq(sandboxTransactionsTable.merchantId, merchantId),
  )).limit(1);
  if (!transaction) {
    res.status(404).json({ error: "Sandbox transaction not found for this merchant." });
    return;
  }
  res.json(GetSandboxTransactionResponse.parse(transactionDto(transaction)));
});

apiRouter.post("/transactions/:reference/verify", requireApiScope("payments:write"), async (req, res): Promise<void> => {
  const params = VerifySandboxTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const merchantId = (res.locals.merchant as { id: number }).id;
  const [transaction] = await db.select().from(sandboxTransactionsTable).where(and(
    eq(sandboxTransactionsTable.reference, params.data.reference),
    eq(sandboxTransactionsTable.merchantId, merchantId),
  )).limit(1);
  if (!transaction) {
    res.status(404).json({ error: "Sandbox transaction not found for this merchant." });
    return;
  }
  res.json(VerifySandboxTransactionResponse.parse(transactionDto(transaction)));
});

router.use("/sandbox/v1", apiRouter);
export default router;
