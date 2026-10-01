import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AddMerchantCaseMessageBody, AddMerchantCaseMessageParams, AddMerchantCaseMessageResponse,
  CreateInvoicePaymentLinkParams, CreateInvoicePaymentLinkResponse, CreateInvoiceReminderBody,
  CreateInvoiceReminderParams, CreateInvoiceReminderResponse, CreateMerchantCaseBody,
  CreateMerchantCaseResponse, CreateMerchantInvoiceBody, CreateMerchantInvoiceResponse,
  GetMerchantCaseParams, GetMerchantCaseResponse, GetMerchantInvoiceParams, GetMerchantInvoiceResponse,
  GetMerchantStatementParams, GetMerchantStatementResponse, GetPublicReceiptParams,
  GetPublicReceiptResponse, ListAdminCasesResponse, ListInvoiceRemindersParams,
  ListInvoiceRemindersResponse, ListMerchantCasesResponse, ListMerchantInvoicesResponse,
  ReviewAdminCaseBody, ReviewAdminCaseParams, ReviewAdminCaseResponse, SendMerchantInvoiceParams,
  SendMerchantInvoiceResponse, UpdateMerchantInvoiceBody, UpdateMerchantInvoiceParams,
  UpdateMerchantInvoiceResponse, VoidMerchantInvoiceParams, VoidMerchantInvoiceResponse,
} from "@workspace/api-zod";
import {
  db, merchantInvoiceRemindersTable, merchantInvoicesTable, merchantSupportCasesTable,
  merchantsTable, paymentLinksTable, payoutsTable, refundsTable, transactionsTable,
} from "@workspace/db";
import { requireAdmin, requireSignedIn } from "../middlewares/requireAdmin";
import { resolveMerchantAccess } from "../lib/merchant-access";
import { assertMerchantMayTransact, assertPlatformEnabled } from "../lib/platform";
import { assertSupportedCurrency, getPublicAppUrl } from "../lib/greenpay-provider";
import { assertCollectionAmountPrecision } from "../lib/greenpay-collection";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "../lib/payment-safety";
import {
  calculateInvoiceLines, invoicePaymentStatus, ownsBusinessResource,
  parseStatementMonth, validateEvidenceUrl,
} from "../lib/merchant-business-tools";

const router: IRouter = Router();
const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;
const PAID_REFUND_STATUSES = CUSTOMER_REIMBURSED_REFUND_STATUSES;
const PAID_PAYOUT_STATUSES = ["success", "completed", "processed"] as const;

async function invoiceDto(row: typeof merchantInvoicesTable.$inferSelect) {
  let paidAmount = 0;
  const payments: Array<{ reference: string; amount: number; paidAt: Date; status: "success" | "refunded" }> = [];
  if (row.paymentLinkId) {
    const confirmed = await db.select().from(transactionsTable).where(and(
      eq(transactionsTable.merchantId, row.merchantId),
      eq(transactionsTable.paymentLinkId, row.paymentLinkId),
      inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    ));
    for (const transaction of confirmed) {
      if (transaction.paidAt) {
        payments.push({
          reference: transaction.reference,
          amount: transaction.amount,
          paidAt: transaction.paidAt,
          status: transaction.status as "success" | "refunded",
        });
      }
      const refunds = await db.select().from(refundsTable).where(and(
        eq(refundsTable.originalReference, transaction.reference),
        inArray(refundsTable.status, [...PAID_REFUND_STATUSES]),
      ));
      paidAmount += Math.max(0, transaction.amount - refunds.reduce((sum, refund) => sum + refund.amount, 0));
    }
  }
  paidAmount = Math.round(paidAmount * 100) / 100;
  const status = invoicePaymentStatus(row.status, paidAmount, row.total);
  let paymentUrl: string | null = null;
  if (row.paymentLinkId) {
    const [link] = await db.select({ slug: paymentLinksTable.slug }).from(paymentLinksTable).where(eq(paymentLinksTable.id, row.paymentLinkId)).limit(1);
    if (link) paymentUrl = `${getPublicAppUrl()}/pay/${encodeURIComponent(link.slug)}`;
  }
  return {
    id: row.id,
    reference: row.reference,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    currency: row.currency,
    dueDate: row.dueDate,
    lines: row.lines,
    subtotal: row.subtotal,
    total: row.total,
    paidAmount,
    payments,
    status,
    note: row.note,
    createdAt: row.createdAt,
    paymentUrl,
  };
}

async function ownedInvoice(
  req: Parameters<typeof resolveMerchantAccess>[0],
  res: Parameters<typeof resolveMerchantAccess>[1],
  id: number,
  permission: "read" | "finance" = "read",
) {
  const merchant = await resolveMerchantAccess(req, res, permission);
  if (!merchant) return { merchant: null, invoice: null };
  const [invoice] = await db.select().from(merchantInvoicesTable).where(and(
    eq(merchantInvoicesTable.id, id),
    eq(merchantInvoicesTable.merchantId, merchant.id),
  )).limit(1);
  return {
    merchant,
    invoice: invoice && ownsBusinessResource(invoice.merchantId, merchant.id) ? invoice : null,
  };
}

function caseDto(row: typeof merchantSupportCasesTable.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    transactionReference: row.transactionReference,
    status: row.status,
    financialMovement: row.financialMovement,
    messages: row.messages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get("/merchant/invoices", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(merchantInvoicesTable).where(eq(merchantInvoicesTable.merchantId, merchant.id))
    .orderBy(desc(merchantInvoicesTable.createdAt)).limit(500);
  res.json(ListMerchantInvoicesResponse.parse({ items: await Promise.all(rows.map(invoiceDto)) }));
});

router.post("/merchant/invoices", requireSignedIn, async (req, res): Promise<void> => {
  const body = CreateMerchantInvoiceBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const currency = body.data.currency.toUpperCase();
  assertSupportedCurrency(currency);
  const calculated = calculateInvoiceLines(body.data.lines);
  assertCollectionAmountPrecision(calculated.total, currency);
  const [invoice] = await db.insert(merchantInvoicesTable).values({
    merchantId: merchant.id,
    reference: `INV-${randomUUID()}`,
    customerName: body.data.customerName.trim(),
    customerEmail: body.data.customerEmail.toLowerCase().trim(),
    currency,
    dueDate: body.data.dueDate.toISOString().slice(0, 10),
    lines: calculated.lines,
    subtotal: calculated.total,
    total: calculated.total,
    note: body.data.note?.trim() || null,
  }).returning();
  res.status(201).json(CreateMerchantInvoiceResponse.parse(await invoiceDto(invoice)));
});

router.get("/merchant/invoices/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = GetMerchantInvoiceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { invoice } = await ownedInvoice(req, res, params.data.id);
  if (!invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  res.json(GetMerchantInvoiceResponse.parse(await invoiceDto(invoice)));
});

router.patch("/merchant/invoices/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = UpdateMerchantInvoiceParams.safeParse(req.params);
  const body = UpdateMerchantInvoiceBody.safeParse(req.body);
  if (!params.success || !body.success || !Object.keys(body.success ? body.data : {}).length) {
    res.status(400).json({ error: !params.success ? params.error.message : !body.success ? body.error.message : "Provide at least one invoice field to update." });
    return;
  }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id, "finance");
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  if (invoice.status !== "draft" || invoice.paymentLinkId) { res.status(409).json({ error: "Only draft invoices without a payment link can be edited." }); return; }
  const updates: Partial<typeof merchantInvoicesTable.$inferInsert> = { updatedAt: new Date() };
  if (body.data.customerName !== undefined) updates.customerName = body.data.customerName.trim();
  if (body.data.customerEmail !== undefined) updates.customerEmail = body.data.customerEmail.toLowerCase().trim();
  if (body.data.dueDate !== undefined) updates.dueDate = body.data.dueDate.toISOString().slice(0, 10);
  if (body.data.note !== undefined) updates.note = body.data.note.trim() || null;
  if (body.data.lines !== undefined) {
    const calculated = calculateInvoiceLines(body.data.lines);
    assertCollectionAmountPrecision(calculated.total, invoice.currency);
    updates.lines = calculated.lines;
    updates.subtotal = calculated.total;
    updates.total = calculated.total;
  }
  const [updated] = await db.update(merchantInvoicesTable).set(updates).where(and(
    eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchant.id),
  )).returning();
  res.json(UpdateMerchantInvoiceResponse.parse(await invoiceDto(updated)));
});

router.post("/merchant/invoices/:id/send", requireSignedIn, async (req, res): Promise<void> => {
  const params = SendMerchantInvoiceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id, "finance");
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  if (invoice.status !== "draft" || invoice.total <= 0) { res.status(409).json({ error: "Only a non-empty draft invoice can be issued." }); return; }
  const [updated] = await db.update(merchantInvoicesTable).set({ status: "sent", updatedAt: new Date() }).where(and(
    eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchant.id),
  )).returning();
  const [reminder] = await db.insert(merchantInvoiceRemindersTable).values({
    merchantId: merchant.id,
    invoiceId: invoice.id,
    deliveryStatus: "unconfigured",
    message: "Invoice issued. Email delivery is not configured; no email was sent.",
  }).returning();
  void reminder;
  res.json(SendMerchantInvoiceResponse.parse(await invoiceDto(updated)));
});

router.post("/merchant/invoices/:id/void", requireSignedIn, async (req, res): Promise<void> => {
  const params = VoidMerchantInvoiceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id, "finance");
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  const view = await invoiceDto(invoice);
  if (view.paidAmount > 0 || invoice.status === "paid" || invoice.status === "partially_paid") {
    res.status(409).json({ error: "An invoice with confirmed payments cannot be voided." }); return;
  }
  if (invoice.status === "void") { res.json(VoidMerchantInvoiceResponse.parse(await invoiceDto(invoice))); return; }
  await db.transaction(async (tx) => {
    if (invoice.paymentLinkId) {
      await tx.update(paymentLinksTable).set({ status: "archived" }).where(and(
        eq(paymentLinksTable.id, invoice.paymentLinkId),
        eq(paymentLinksTable.merchantId, merchant.id),
      ));
    }
    await tx.update(merchantInvoicesTable).set({ status: "void", updatedAt: new Date() }).where(and(
      eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchant.id),
    ));
  });
  const [updated] = await db.select().from(merchantInvoicesTable).where(eq(merchantInvoicesTable.id, invoice.id)).limit(1);
  res.json(VoidMerchantInvoiceResponse.parse(await invoiceDto(updated)));
});

router.post("/merchant/invoices/:id/payment-link", requireSignedIn, async (req, res): Promise<void> => {
  const params = CreateInvoicePaymentLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id, "finance");
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  const currentInvoice = await invoiceDto(invoice);
  if (!["sent", "partially_paid"].includes(currentInvoice.status)) {
    res.status(409).json({ error: "Issue the invoice first; void or fully paid invoices cannot receive payment links." }); return;
  }
  await assertMerchantMayTransact(merchant);
  await assertPlatformEnabled("paymentsEnabled");
  assertSupportedCurrency(invoice.currency);
  assertCollectionAmountPrecision(invoice.total, invoice.currency);
  let invoiceAfter = invoice;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(merchantInvoicesTable).where(and(
      eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchant.id),
    )).for("update").limit(1);
    if (!locked) throw Object.assign(new Error("Invoice was not found."), { statusCode: 404 });
    if (locked.status === "void") throw Object.assign(new Error("A void invoice cannot receive a payment link."), { statusCode: 409 });
    if (locked.paymentLinkId) {
      invoiceAfter = locked;
      return;
    }
    const [link] = await tx.insert(paymentLinksTable).values({
      slug: randomUUID().replaceAll("-", "").slice(0, 20),
      merchantId: merchant.id,
      name: `Invoice ${locked.reference}`,
      description: `Payment for invoice ${locked.reference}`,
      amountType: "fixed",
      amount: locked.total,
      currency: locked.currency,
      status: "active",
    }).returning();
    [invoiceAfter] = await tx.update(merchantInvoicesTable).set({
      paymentLinkId: link.id,
      updatedAt: new Date(),
    }).where(and(eq(merchantInvoicesTable.id, locked.id), eq(merchantInvoicesTable.merchantId, merchant.id))).returning();
  });
  res.json(CreateInvoicePaymentLinkResponse.parse(await invoiceDto(invoiceAfter)));
});

router.get("/merchant/invoices/:id/reminders", requireSignedIn, async (req, res): Promise<void> => {
  const params = ListInvoiceRemindersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id);
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  const rows = await db.select().from(merchantInvoiceRemindersTable).where(and(
    eq(merchantInvoiceRemindersTable.invoiceId, invoice.id),
    eq(merchantInvoiceRemindersTable.merchantId, merchant.id),
  )).orderBy(desc(merchantInvoiceRemindersTable.createdAt));
  res.json(ListInvoiceRemindersResponse.parse({ items: rows }));
});

router.post("/merchant/invoices/:id/reminders", requireSignedIn, async (req, res): Promise<void> => {
  const params = CreateInvoiceReminderParams.safeParse(req.params);
  const body = CreateInvoiceReminderBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) { res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id, "finance");
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  const currentInvoice = await invoiceDto(invoice);
  if (!["sent", "partially_paid"].includes(currentInvoice.status)) {
    res.status(409).json({ error: "Only an issued and unpaid invoice can be reminded." }); return;
  }
  const message = body.data.note?.trim() || `Reminder requested for invoice ${invoice.reference}. Email delivery is not configured; no email was sent.`;
  const [reminder] = await db.insert(merchantInvoiceRemindersTable).values({
    merchantId: merchant.id, invoiceId: invoice.id, deliveryStatus: "unconfigured", message,
  }).returning();
  res.status(201).json(CreateInvoiceReminderResponse.parse(reminder));
});

router.get("/merchant/statements/:month", requireSignedIn, async (req, res): Promise<void> => {
  const params = GetMerchantStatementParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const range = parseStatementMonth(params.data.month);
  if (!range) { res.status(400).json({ error: "Month must be a valid YYYY-MM value." }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const transactions = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    gte(transactionsTable.paidAt, range.start),
    lt(transactionsTable.paidAt, range.end),
  )).orderBy(desc(transactionsTable.paidAt));
  const refunds = await db.select({ refund: refundsTable }).from(refundsTable)
    .innerJoin(transactionsTable, eq(refundsTable.originalReference, transactionsTable.reference))
    .where(and(
      eq(transactionsTable.merchantId, merchant.id),
      gte(refundsTable.createdAt, range.start),
      lt(refundsTable.createdAt, range.end),
    )).orderBy(desc(refundsTable.createdAt));
  const payouts = await db.select().from(payoutsTable).where(and(
    eq(payoutsTable.merchantId, merchant.id),
    gte(payoutsTable.createdAt, range.start),
    lt(payoutsTable.createdAt, range.end),
  )).orderBy(desc(payoutsTable.createdAt));

  const historyStart = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() - 3, 1));
  const history = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    gte(transactionsTable.paidAt, historyStart),
    lt(transactionsTable.paidAt, range.start),
  ));
  const currencies = new Set([
    ...transactions.map((row) => row.currency),
    ...refunds.map(({ refund }) => refund.currency),
    ...payouts.map((row) => row.currency),
  ]);
  const currencySummaries = [...currencies].sort().map((currency) => {
    const grossConfirmed = transactions.filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + row.amount, 0);
    const fees = transactions.filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + (row.fee ?? 0), 0);
    const refundsTotal = refunds.filter(({ refund }) => refund.currency === currency && PAID_REFUND_STATUSES.includes(refund.status as never))
      .reduce((sum, { refund }) => sum + refund.amount, 0);
    const payoutsTotal = payouts.filter((row) => row.currency === currency && PAID_PAYOUT_STATUSES.includes(row.status as never))
      .reduce((sum, row) => sum + row.amount, 0);
    const currencyHistory = history.filter((row) => row.currency === currency);
    const historyMonths = currencyHistory.filter((row) => row.paidAt)
      .reduce((months, row) => months.add(`${row.paidAt!.getUTCFullYear()}-${row.paidAt!.getUTCMonth()}`), new Set<string>());
    const historyGross = currencyHistory.reduce((sum, row) => sum + row.amount, 0);
    return {
      currency,
      grossConfirmed: Math.round(grossConfirmed * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      refundsTotal: Math.round(refundsTotal * 100) / 100,
      payoutsTotal: Math.round(payoutsTotal * 100) / 100,
      forecast: {
        label: "historical_average_estimate" as const,
        amount: currencyHistory.length ? Math.round(historyGross / 3 * 100) / 100 : null,
        basisMonths: historyMonths.size,
      },
    };
  });
  res.json(GetMerchantStatementResponse.parse({
    month: params.data.month,
    transactions: transactions.map((row) => ({
      reference: row.reference, amount: row.amount, fee: row.fee ?? 0,
      currency: row.currency, paidAt: row.paidAt,
    })),
    refunds: refunds.map(({ refund }) => ({
      reference: refund.reference, originalReference: refund.originalReference,
      amount: refund.amount, currency: refund.currency, status: refund.status, createdAt: refund.createdAt,
    })),
    payouts: payouts.map((row) => ({
      reference: row.reference, amount: row.amount, fee: row.fee ?? 0,
      currency: row.currency, status: row.status, createdAt: row.createdAt,
    })),
    currencySummaries,
  }));
});

router.get("/merchant/cases", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(merchantSupportCasesTable).where(eq(merchantSupportCasesTable.merchantId, merchant.id))
    .orderBy(desc(merchantSupportCasesTable.createdAt));
  res.json(ListMerchantCasesResponse.parse({ items: rows.map(caseDto) }));
});

router.post("/merchant/cases", requireSignedIn, async (req, res): Promise<void> => {
  const body = CreateMerchantCaseBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const transactionReference = body.data.transactionReference.trim();
  const [transaction] = await db.select({
    reference: transactionsTable.reference, merchantId: transactionsTable.merchantId,
  }).from(transactionsTable).where(and(
    eq(transactionsTable.reference, transactionReference),
    eq(transactionsTable.merchantId, merchant.id),
  )).limit(1);
  if (!transaction || transaction.merchantId == null || !ownsBusinessResource(transaction.merchantId, merchant.id)) {
    res.status(404).json({ error: "Transaction not found for this merchant." }); return;
  }
  let evidenceUrl: string | null;
  try { evidenceUrl = validateEvidenceUrl(body.data.evidenceUrl); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence URL." }); return; }
  const [created] = await db.insert(merchantSupportCasesTable).values({
    merchantId: merchant.id,
    kind: body.data.kind,
    transactionReference,
    status: "requested",
    financialMovement: "requested",
    messages: [{
      id: randomUUID(), authorRole: "merchant", message: body.data.message.trim(),
      evidenceUrl, createdAt: new Date().toISOString(),
    }],
  }).returning();
  res.status(201).json(CreateMerchantCaseResponse.parse(caseDto(created)));
});

router.get("/merchant/cases/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = GetMerchantCaseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [row] = await db.select().from(merchantSupportCasesTable).where(and(
    eq(merchantSupportCasesTable.id, params.data.id),
    eq(merchantSupportCasesTable.merchantId, merchant.id),
  )).limit(1);
  if (!row || !ownsBusinessResource(row.merchantId, merchant.id)) { res.status(404).json({ error: "Case not found for this merchant." }); return; }
  res.json(GetMerchantCaseResponse.parse(caseDto(row)));
});

router.post("/merchant/cases/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = AddMerchantCaseMessageParams.safeParse(req.params);
  const body = AddMerchantCaseMessageBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [row] = await db.select().from(merchantSupportCasesTable).where(and(
    eq(merchantSupportCasesTable.id, params.data.id),
    eq(merchantSupportCasesTable.merchantId, merchant.id),
  )).limit(1);
  if (!row || !ownsBusinessResource(row.merchantId, merchant.id)) { res.status(404).json({ error: "Case not found for this merchant." }); return; }
  let evidenceUrl: string | null;
  try { evidenceUrl = validateEvidenceUrl(body.data.evidenceUrl); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence URL." }); return; }
  const [updated] = await db.update(merchantSupportCasesTable).set({
    messages: [...row.messages, {
      id: randomUUID(), authorRole: "merchant", message: body.data.message.trim(),
      evidenceUrl, createdAt: new Date().toISOString(),
    }],
    updatedAt: new Date(),
  }).where(and(eq(merchantSupportCasesTable.id, row.id), eq(merchantSupportCasesTable.merchantId, merchant.id))).returning();
  res.json(AddMerchantCaseMessageResponse.parse(caseDto(updated)));
});

router.get("/admin/cases", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(merchantSupportCasesTable).orderBy(desc(merchantSupportCasesTable.createdAt));
  res.json(ListAdminCasesResponse.parse({ items: rows.map(caseDto) }));
});

router.patch("/admin/cases/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = ReviewAdminCaseParams.safeParse(req.params);
  const body = ReviewAdminCaseBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." }); return; }
  const [row] = await db.select().from(merchantSupportCasesTable).where(eq(merchantSupportCasesTable.id, params.data.id)).limit(1);
  if (!row) { res.status(404).json({ error: "Case not found." }); return; }
  let evidenceUrl: string | null;
  try { evidenceUrl = validateEvidenceUrl(body.data.evidenceUrl); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence URL." }); return; }
  let movement = body.data.financialMovement ?? row.financialMovement;
  if (movement === "confirmed") {
    const [refund] = await db.select({ id: refundsTable.id }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, row.transactionReference),
      inArray(refundsTable.status, [...PAID_REFUND_STATUSES]),
    )).limit(1);
    if (!refund) {
      res.status(409).json({ error: "Customer money movement cannot be marked confirmed without a confirmed refund record." });
      return;
    }
  }
  const [updated] = await db.update(merchantSupportCasesTable).set({
    status: body.data.status,
    financialMovement: movement,
    messages: [...row.messages, {
      id: randomUUID(), authorRole: "admin", message: body.data.message.trim(),
      evidenceUrl, createdAt: new Date().toISOString(),
    }],
    updatedAt: new Date(),
  }).where(eq(merchantSupportCasesTable.id, row.id)).returning();
  res.json(ReviewAdminCaseResponse.parse(caseDto(updated)));
});

router.get("/public/receipts/:reference", async (req, res): Promise<void> => {
  const params = GetPublicReceiptParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [transaction] = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.reference, params.data.reference),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
  )).limit(1);
  if (!transaction?.paidAt || !transaction.merchantId) { res.status(404).json({ error: "A confirmed receipt could not be found." }); return; }
  const [merchant] = await db.select({ businessName: merchantsTable.businessName }).from(merchantsTable)
    .where(eq(merchantsTable.id, transaction.merchantId)).limit(1);
  if (!merchant) { res.status(404).json({ error: "A confirmed receipt could not be found." }); return; }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(GetPublicReceiptResponse.parse({
    reference: transaction.reference,
    businessName: merchant.businessName,
    amount: transaction.amount,
    currency: transaction.currency,
    paidAt: transaction.paidAt,
    status: transaction.status === "refunded" ? "refunded" : "confirmed",
  }));
});

export default router;