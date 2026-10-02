import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  AddMerchantCaseMessageBody, AddMerchantCaseMessageParams, AddMerchantCaseMessageResponse,
  CreateInvoicePaymentLinkParams, CreateInvoicePaymentLinkResponse, CreateInvoiceReminderBody,
  CreateInvoiceReminderParams, CreateInvoiceReminderResponse, CreateMerchantCaseBody,
  CreateMerchantCaseResponse, CreateMerchantInvoiceBody, CreateMerchantInvoiceResponse,
  GetMerchantCaseParams, GetMerchantCaseResponse, GetMerchantInvoiceParams, GetMerchantInvoiceResponse,
  GetMerchantStatementParams, GetMerchantStatementResponse, GetPublicReceiptParams,
  GetPublicReceiptResponse, ListAdminCasesResponse, ListInvoiceRemindersParams,
  ListInvoiceRemindersResponse, ListMerchantCasesResponse, ListMerchantInvoicesResponse,
  CreateMerchantTransactionRecoveryLinkParams, CreateMerchantTransactionRecoveryLinkResponse,
  CreateMerchantPaymentLinkReminderBody, CreateMerchantPaymentLinkReminderParams,
  CreateMerchantPaymentLinkReminderResponse, ListMerchantPaymentLinkRemindersParams,
  ListMerchantPaymentLinkRemindersResponse,
  ReviewAdminCaseBody, ReviewAdminCaseParams, ReviewAdminCaseResponse, SendMerchantInvoiceParams,
  SendMerchantInvoiceResponse, UpdateMerchantInvoiceBody, UpdateMerchantInvoiceParams,
  UpdateMerchantInvoiceResponse, VoidMerchantInvoiceParams, VoidMerchantInvoiceResponse,
} from "@workspace/api-zod";
import {
  db, merchantInvoiceRemindersTable, merchantInvoicesTable, merchantPaymentLinkRemindersTable, merchantSupportCasesTable,
  merchantCaseAttachmentsTable, merchantCaseRefundsTable, merchantCaseUploadIntentsTable,
  merchantsTable, paymentLinksTable, payoutsTable, refundsTable, transactionsTable,
  transactionalEmailOutboxTable, walletPayoutRequestsTable, walletSettlementConfirmationsTable,
} from "@workspace/db";
import { requireAdmin, requireSignedIn } from "../middlewares/requireAdmin";
import { resolveMerchantAccess } from "../lib/merchant-access";
import { assertMerchantMayTransact, assertPlatformEnabled } from "../lib/platform";
import { assertMerchantActionEnabled } from "../lib/merchant-action-controls";
import { assertSupportedCurrency, getPublicAppUrl } from "../lib/greenpay-provider";
import { assertCollectionAmountPrecision } from "../lib/greenpay-collection";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "../lib/payment-safety";
import { enqueueTransactionalEmail } from "../lib/mailtrap-delivery";
import { dispatchPendingMerchantWebhooks } from "../lib/outbound-webhooks";
import { recordManualCaseRefundEvidenceInTransaction } from "../lib/manual-refund-evidence";
import { refreshInvoicePaymentLinkInTransaction } from "../lib/merchant-invoice-payment-links";
import {
  amountCents, calculateInvoiceLines, caseAttachmentName, confirmedStatementPayouts, confirmedWalletPayoutsInMonth,
  confirmedStatementRows, invoiceOutstandingAmount, invoicePaymentStatus, ownsBusinessResource,
  parseStatementMonth, statementCashDate, validateEvidenceUrl,
} from "../lib/merchant-business-tools";
import {
  CASE_FILE_MAX_BYTES, CASE_FILE_TYPES, createPrivateCaseUpload, deletePrivateCaseObject,
  getPrivateCaseObject, verifyPrivateCaseObject,
  type CaseFileType,
} from "../lib/cloudinary-case-storage";

const router: IRouter = Router();
const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;
const PAID_REFUND_STATUSES = CUSTOMER_REIMBURSED_REFUND_STATUSES;
const PAID_PAYOUT_STATUSES = ["success", "completed", "processed"] as const;
const MAX_CASE_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_CASE_ATTACHMENTS = 25;
const CASE_UPLOAD_TTL_MS = 10 * 60_000;
const CASE_FILE_CONTENT_TYPES = new Set(Object.keys(CASE_FILE_TYPES));

function officialInvoiceEmailBaseUrl(): string | null {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.hostname.endsWith(".replit.dev") || url.hostname.endsWith(".repl.co")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

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
      if (!transaction.paidAt) continue;
      payments.push({
        reference: transaction.reference,
        amount: transaction.amount,
        paidAt: transaction.paidAt,
        status: transaction.status as "success" | "refunded",
      });
      const refunds = await db.select().from(refundsTable).where(and(
        eq(refundsTable.originalReference, transaction.reference),
        inArray(refundsTable.status, [...PAID_REFUND_STATUSES]),
      ));
      paidAmount += Math.max(0, transaction.amount - refunds.reduce((sum, refund) => sum + refund.amount, 0));
    }
  }
  paidAmount = Math.min(row.total, Math.max(0, Math.round(paidAmount * 100) / 100));
  const status = invoicePaymentStatus(row.status, paidAmount, row.total);
  let paymentUrl: string | null = null;
  let paymentLinkAmount: number | null = null;
  if (row.paymentLinkId) {
    const [link] = await db.select({
      slug: paymentLinksTable.slug, status: paymentLinksTable.status, amount: paymentLinksTable.amount,
    }).from(paymentLinksTable).where(eq(paymentLinksTable.id, row.paymentLinkId)).limit(1);
    if (link && link.status === "active") {
      paymentLinkAmount = link.amount === null ? null : Number(link.amount);
      if (paymentLinkAmount !== null && Math.abs(paymentLinkAmount - invoiceOutstandingAmount(row.total, paidAmount)) <= 0.001) {
        paymentUrl = `${getPublicAppUrl()}/pay/${encodeURIComponent(link.slug)}`;
      }
    }
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
    outstandingAmount: invoiceOutstandingAmount(row.total, paidAmount),
    paymentLinkAmount,
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

async function caseDto(row: typeof merchantSupportCasesTable.$inferSelect) {
  const [attachments, refundEvidence] = await Promise.all([
    db.select().from(merchantCaseAttachmentsTable).where(eq(merchantCaseAttachmentsTable.caseId, row.id))
      .orderBy(merchantCaseAttachmentsTable.createdAt),
    db.select({
      reference: refundsTable.reference,
      amount: refundsTable.amount,
      currency: refundsTable.currency,
      status: refundsTable.status,
      providerReference: merchantCaseRefundsTable.providerReference,
      evidenceReference: merchantCaseRefundsTable.evidenceReference,
      createdAt: refundsTable.createdAt,
    }).from(merchantCaseRefundsTable)
      .innerJoin(refundsTable, eq(merchantCaseRefundsTable.refundId, refundsTable.id))
      .where(eq(merchantCaseRefundsTable.caseId, row.id))
      .orderBy(desc(refundsTable.createdAt)),
  ]);
  return {
    id: row.id,
    kind: row.kind,
    transactionReference: row.transactionReference,
    status: row.status,
    financialMovement: row.financialMovement,
    messages: row.messages.map((message) => ({
      ...message,
      attachments: attachments.filter((attachment) => attachment.messageId === message.id).map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        createdAt: attachment.createdAt,
        downloadPath: `/merchant/cases/${row.id}/attachments/${attachment.id}/download`,
      })),
    })),
    refundEvidence: refundEvidence.map((entry) => ({
      ...entry,
      amount: Number(entry.amount),
      downloadPath: null,
    })),
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
  const view = await invoiceDto(invoice);
  if (view.paidAmount > 0 || invoice.status === "paid" || invoice.status === "partially_paid") {
    res.status(409).json({ error: "An invoice with confirmed payments cannot be voided." }); return;
  }
  if (invoice.status === "void") { res.json(VoidMerchantInvoiceResponse.parse(await invoiceDto(invoice))); return; }
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(merchantInvoicesTable).where(and(
      eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchant.id),
    )).for("update").limit(1);
    if (!locked) throw Object.assign(new Error("Invoice was not found."), { statusCode: 404 });
    const linkedTransactions = locked.paymentLinkId ? await tx.select().from(transactionsTable).where(and(
      eq(transactionsTable.merchantId, merchant.id),
      eq(transactionsTable.paymentLinkId, locked.paymentLinkId),
      inArray(transactionsTable.status, ["pending", ...PAID_TRANSACTION_STATUSES]),
    )).for("update") : [];
    if (linkedTransactions.some((row) => row.status === "pending")) {
      throw Object.assign(new Error("An invoice payment is awaiting provider confirmation. Do not void it until the outcome is known."), { statusCode: 409 });
    }
    const hasConfirmedPayment = linkedTransactions.some((transaction) => transaction.paidAt !== null);
    if (hasConfirmedPayment || locked.status === "paid" || locked.status === "partially_paid") {
      throw Object.assign(new Error("An invoice with confirmed payments cannot be voided."), { statusCode: 409 });
    }
    if (locked.paymentLinkId) {
      await tx.update(paymentLinksTable).set({ status: "archived" }).where(and(
        eq(paymentLinksTable.id, locked.paymentLinkId),
        eq(paymentLinksTable.merchantId, merchant.id),
      ));
    }
    await tx.update(merchantInvoicesTable).set({ status: "void", updatedAt: new Date() }).where(and(
      eq(merchantInvoicesTable.id, locked.id), eq(merchantInvoicesTable.merchantId, merchant.id),
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
  await assertMerchantActionEnabled(merchant.id, "createLinks");
  const currentInvoice = await invoiceDto(invoice);
  if (!["sent", "partially_paid"].includes(currentInvoice.status)) {
    res.status(409).json({ error: "Issue the invoice first; void or fully paid invoices cannot receive payment links." }); return;
  }
  await assertMerchantMayTransact(merchant);
  await assertPlatformEnabled("paymentsEnabled");
  assertSupportedCurrency(invoice.currency);
  const invoiceAfter = await db.transaction((tx) => refreshInvoicePaymentLinkInTransaction(tx, {
    invoiceId: invoice.id,
    merchantId: merchant.id,
  }));
  res.json(CreateInvoicePaymentLinkResponse.parse(await invoiceDto(invoiceAfter)));
});

router.get("/merchant/invoices/:id/reminders", requireSignedIn, async (req, res): Promise<void> => {
  const params = ListInvoiceRemindersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { merchant, invoice } = await ownedInvoice(req, res, params.data.id);
  if (!merchant || !invoice) { res.status(404).json({ error: "Invoice not found for this merchant." }); return; }
  const rows = await db.select({
    id: merchantInvoiceRemindersTable.id,
    merchantId: merchantInvoiceRemindersTable.merchantId,
    invoiceId: merchantInvoiceRemindersTable.invoiceId,
    deliveryStatus: sql<string>`coalesce(${transactionalEmailOutboxTable.deliveryState}, ${merchantInvoiceRemindersTable.deliveryStatus})`,
    message: sql<string>`case when ${transactionalEmailOutboxTable.lastError} is not null then ${merchantInvoiceRemindersTable.message} || ' Delivery detail: ' || ${transactionalEmailOutboxTable.lastError} else ${merchantInvoiceRemindersTable.message} end`,
    scheduledAt: merchantInvoiceRemindersTable.scheduledAt,
    eventKey: merchantInvoiceRemindersTable.eventKey,
    deliveryId: merchantInvoiceRemindersTable.deliveryId,
    createdAt: merchantInvoiceRemindersTable.createdAt,
    attemptedAt: sql<Date | null>`case when ${transactionalEmailOutboxTable.deliveryState} = 'queued' then null else coalesce(${transactionalEmailOutboxTable.updatedAt}, ${merchantInvoiceRemindersTable.attemptedAt}) end`,
  }).from(merchantInvoiceRemindersTable).leftJoin(transactionalEmailOutboxTable,
    eq(merchantInvoiceRemindersTable.deliveryId, transactionalEmailOutboxTable.id)).where(and(
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
  await assertMerchantActionEnabled(merchant.id, "invoices");
  await assertMerchantActionEnabled(merchant.id, "reminders");
  const currentInvoice = await invoiceDto(invoice);
  if (!["sent", "partially_paid"].includes(currentInvoice.status)) {
    res.status(409).json({ error: "Only an issued and unpaid invoice can be reminded." }); return;
  }
  if (!currentInvoice.paymentUrl) {
    res.status(409).json({ error: "Create a current payment link for the outstanding invoice balance before queuing a reminder." });
    return;
  }
  const scheduledValue = (req.body as { scheduleAt?: unknown } | null)?.scheduleAt;
  let scheduledAt: Date | undefined;
  if (scheduledValue !== undefined) {
    if (typeof scheduledValue !== "string" || Number.isNaN(Date.parse(scheduledValue))) {
      res.status(400).json({ error: "Scheduled reminder time must be a valid ISO date." });
      return;
    }
    scheduledAt = new Date(scheduledValue);
    if (scheduledAt.getTime() <= Date.now() + 60_000 || scheduledAt.getTime() > Date.now() + 30 * 86_400_000) {
      res.status(400).json({ error: "Schedule reminders at least one minute from now and no more than 30 days ahead." });
      return;
    }
  }
  const [paymentLink] = invoice.paymentLinkId ? await db.select({ slug: paymentLinksTable.slug }).from(paymentLinksTable).where(and(
    eq(paymentLinksTable.id, invoice.paymentLinkId),
    eq(paymentLinksTable.merchantId, merchant.id),
    eq(paymentLinksTable.status, "active"),
  )).limit(1) : [];
  const officialBase = officialInvoiceEmailBaseUrl();
  if (!paymentLink || !officialBase) {
    res.status(503).json({ error: "Invoice reminders require a current payment link and configured official HTTPS app URL." });
    return;
  }
  const eventKey = `invoice-reminder:${invoice.id}:${randomUUID()}`;
  const message = `Invoice reminder queued for ${invoice.customerEmail} with an outstanding balance of ${currentInvoice.outstandingAmount.toFixed(2)} ${invoice.currency}.`;
  try {
    const delivery = await enqueueTransactionalEmail({
      eventKey,
      purpose: "invoice_reminder",
      recipientEmail: invoice.customerEmail,
      template: "invoice_reminder",
      payload: {
        invoiceId: invoice.id,
        merchantId: merchant.id,
        businessName: merchant.businessName,
        customerName: invoice.customerName,
        invoiceReference: invoice.reference,
        amount: currentInvoice.outstandingAmount,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        paymentUrl: new URL(`/pay/${encodeURIComponent(paymentLink.slug)}`, officialBase).toString(),
      },
      ...(scheduledAt ? { sendAfter: scheduledAt } : {}),
    });
    const [reminder] = await db.insert(merchantInvoiceRemindersTable).values({
      merchantId: merchant.id,
      invoiceId: invoice.id,
      deliveryStatus: delivery.deliveryState,
      message,
      scheduledAt: scheduledAt ?? null,
      eventKey,
      deliveryId: delivery.id,
    }).returning();
    res.status(201).json(CreateInvoiceReminderResponse.parse(reminder));
  } catch (error) {
    req.log.error({ err: error, invoiceId: invoice.id }, "Invoice reminder could not be queued");
    res.status(503).json({ error: error instanceof Error ? error.message : "Invoice reminder could not be queued." });
  }
});

router.post("/merchant/transactions/:reference/recovery-link", requireSignedIn, async (req, res): Promise<void> => {
  const params = CreateMerchantTransactionRecoveryLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "collect");
  const [initial] = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.reference, params.data.reference),
    eq(transactionsTable.merchantId, merchant.id),
  )).limit(1);
  if (!initial) { res.status(404).json({ error: "Transaction not found for this merchant." }); return; }
  if (initial.status !== "failed" && initial.status !== "cancelled") {
    res.status(409).json({ error: "Only a confirmed failed or cancelled payment can be retried. Pending or uncertain payments are not eligible." });
    return;
  }
  let shareBase: string;
  try {
    shareBase = officialInvoiceEmailBaseUrl() ?? getPublicAppUrl();
  } catch (error) {
    const statusCode = Number((error as { statusCode?: unknown })?.statusCode) || 503;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : "Hosted checkout is unavailable." });
    return;
  }

  let link: typeof paymentLinksTable.$inferSelect | undefined;
  if (initial.paymentLinkId !== null) {
    const [invoice] = await db.select().from(merchantInvoicesTable).where(and(
      eq(merchantInvoicesTable.merchantId, merchant.id),
      eq(merchantInvoicesTable.paymentLinkId, initial.paymentLinkId),
    )).limit(1);
    if (invoice) {
      if (!["sent", "partially_paid"].includes(invoice.status)) {
        res.status(409).json({ error: "The linked invoice is not unpaid. No retry link was created." });
        return;
      }
      try {
        const refreshed = await db.transaction((tx) => refreshInvoicePaymentLinkInTransaction(tx, {
          invoiceId: invoice.id, merchantId: merchant.id,
        }));
        if (refreshed.paymentLinkId !== null) {
          [link] = await db.select().from(paymentLinksTable).where(and(
            eq(paymentLinksTable.id, refreshed.paymentLinkId),
            eq(paymentLinksTable.merchantId, merchant.id),
            eq(paymentLinksTable.status, "active"),
          )).limit(1);
        }
      } catch (error) {
        const statusCode = Number((error as { statusCode?: unknown })?.statusCode) || 409;
        res.status(statusCode).json({ error: error instanceof Error ? error.message : "The invoice balance could not be safely refreshed." });
        return;
      }
      if (!link) { res.status(409).json({ error: "The invoice has no active payment link. No retry link was created." }); return; }
    }
  }

  if (!link) {
    try {
      link = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(transactionsTable).where(and(
          eq(transactionsTable.id, initial.id),
          eq(transactionsTable.merchantId, merchant.id),
        )).for("update").limit(1);
        if (!current || (current.status !== "failed" && current.status !== "cancelled")) {
          throw Object.assign(new Error("Only a confirmed failed or cancelled payment can be retried."), { statusCode: 409 });
        }
        const [existing] = await tx.select().from(paymentLinksTable).where(
          eq(paymentLinksTable.recoveryForTransactionId, current.id),
        ).for("update").limit(1);
        if (existing) {
          const [successfulRecovery] = await tx.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
            eq(transactionsTable.paymentLinkId, existing.id),
            inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
          )).limit(1);
          if (successfulRecovery) {
            throw Object.assign(new Error("A payment through this recovery link has already succeeded. No additional link was created."), { statusCode: 409 });
          }
          if (existing.status === "active" && (!existing.expiresAt || existing.expiresAt.getTime() > Date.now())) {
            return existing;
          }
          const [renewed] = await tx.update(paymentLinksTable).set({
            slug: randomUUID().replaceAll("-", "").slice(0, 20),
            status: "active",
            expiresAt: null,
          }).where(eq(paymentLinksTable.id, existing.id)).returning();
          if (!renewed) throw new Error("The recovery link could not be refreshed.");
          return renewed;
        }
        const [created] = await tx.insert(paymentLinksTable).values({
          slug: randomUUID().replaceAll("-", "").slice(0, 20),
          name: `Retry payment ${current.reference}`,
          description: `Retry payment for transaction ${current.reference}`,
          amountType: "fixed",
          amount: current.amount,
          currency: current.currency,
          status: "active",
          merchantId: merchant.id,
          recoveryForTransactionId: current.id,
        }).returning();
        if (!created) throw new Error("The recovery link could not be created.");
        return created;
      });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: unknown })?.statusCode) || 500;
      res.status(statusCode).json({ error: error instanceof Error ? error.message : "The recovery link could not be created." });
      return;
    }
  }

  const paymentUrl = new URL(`/pay/${encodeURIComponent(link.slug)}`, shareBase).toString();
  let deliveryStatus: "queued" | "sending" | "sent" | "uncertain" | "unconfigured" | "failed" = "unconfigured";
  let message = "The retry link is ready to share, but email delivery is not configured. The original payment remains unconfirmed.";
  if (officialInvoiceEmailBaseUrl() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(initial.customerEmail)) {
    try {
      const delivery = await enqueueTransactionalEmail({
        eventKey: `payment-recovery:${initial.id}:${link.id}`,
        purpose: "payment_failure_recovery",
        recipientEmail: initial.customerEmail,
        template: "payment_failure_recovery",
        payload: {
          businessName: merchant.businessName,
          customerName: initial.customerName,
          reference: initial.reference,
          amount: Number(initial.amount),
          currency: initial.currency,
          paymentUrl,
        },
      });
      deliveryStatus = delivery.deliveryState;
      message = deliveryStatus === "queued"
        ? `Retry link queued for ${initial.customerEmail}. The original payment is still recorded as ${initial.status}; do not treat it as paid.`
        : deliveryStatus === "sent"
          ? `The retry link email was already confirmed sent to ${initial.customerEmail}. The original payment remains ${initial.status}.`
          : deliveryStatus === "sending"
            ? "Email delivery is in progress. The original payment remains unconfirmed."
            : deliveryStatus === "uncertain"
              ? "Email delivery is uncertain. Do not send it again until delivery is reviewed; copy the link if needed."
              : `Retry link created, but email delivery is ${delivery.deliveryState}. Copy the link to share it.`;
    } catch (error) {
      deliveryStatus = "failed";
      message = `Retry link created, but the email could not be queued${error instanceof Error ? `: ${error.message}` : "."} Copy the link to share it.`;
    }
  } else if (!officialInvoiceEmailBaseUrl()) {
    message = "Retry link created. Email delivery needs the official HTTPS app URL; copy the link to share it.";
  } else {
    deliveryStatus = "failed";
    message = "Retry link created, but the transaction has no valid customer email. Copy the link to share it.";
  }
  res.status(201).json(CreateMerchantTransactionRecoveryLinkResponse.parse({ paymentUrl, deliveryStatus, message }));
});

router.get("/merchant/payment-links/:id/reminders", requireSignedIn, async (req, res): Promise<void> => {
  const params = ListMerchantPaymentLinkRemindersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [link] = await db.select({ id: paymentLinksTable.id }).from(paymentLinksTable).where(and(
    eq(paymentLinksTable.id, params.data.id),
    eq(paymentLinksTable.merchantId, merchant.id),
  )).limit(1);
  if (!link) { res.status(404).json({ error: "Payment link not found for this merchant." }); return; }
  const rows = await db.select({
    id: merchantPaymentLinkRemindersTable.id,
    merchantId: merchantPaymentLinkRemindersTable.merchantId,
    paymentLinkId: merchantPaymentLinkRemindersTable.paymentLinkId,
    recipientEmail: merchantPaymentLinkRemindersTable.recipientEmail,
    deliveryStatus: sql<string>`coalesce(${transactionalEmailOutboxTable.deliveryState}, ${merchantPaymentLinkRemindersTable.deliveryStatus})`,
    message: sql<string>`case when ${transactionalEmailOutboxTable.lastError} is not null then ${merchantPaymentLinkRemindersTable.message} || ' Delivery detail: ' || ${transactionalEmailOutboxTable.lastError} else ${merchantPaymentLinkRemindersTable.message} end`,
    scheduledAt: merchantPaymentLinkRemindersTable.scheduledAt,
    createdAt: merchantPaymentLinkRemindersTable.createdAt,
    attemptedAt: sql<Date | null>`case when ${transactionalEmailOutboxTable.deliveryState} = 'queued' then null else coalesce(${transactionalEmailOutboxTable.updatedAt}, ${merchantPaymentLinkRemindersTable.attemptedAt}) end`,
  }).from(merchantPaymentLinkRemindersTable).leftJoin(transactionalEmailOutboxTable,
    eq(merchantPaymentLinkRemindersTable.deliveryId, transactionalEmailOutboxTable.id)).where(and(
    eq(merchantPaymentLinkRemindersTable.paymentLinkId, link.id),
    eq(merchantPaymentLinkRemindersTable.merchantId, merchant.id),
  )).orderBy(desc(merchantPaymentLinkRemindersTable.createdAt));
  res.json(ListMerchantPaymentLinkRemindersResponse.parse({
    items: rows.map((row) => ({
      ...row,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      attemptedAt: row.attemptedAt?.toISOString() ?? null,
    })),
  }));
});

router.post("/merchant/payment-links/:id/reminders", requireSignedIn, async (req, res): Promise<void> => {
  const params = CreateMerchantPaymentLinkReminderParams.safeParse(req.params);
  const body = CreateMerchantPaymentLinkReminderBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "reminders");
  const [link] = await db.select().from(paymentLinksTable).where(and(
    eq(paymentLinksTable.id, params.data.id),
    eq(paymentLinksTable.merchantId, merchant.id),
  )).limit(1);
  if (!link) { res.status(404).json({ error: "Payment link not found for this merchant." }); return; }
  if (link.status !== "active" || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
    res.status(409).json({ error: "Only an active, unexpired payment link can be reminded." });
    return;
  }
  const [invoice] = await db.select({ id: merchantInvoicesTable.id }).from(merchantInvoicesTable).where(and(
    eq(merchantInvoicesTable.merchantId, merchant.id),
    eq(merchantInvoicesTable.paymentLinkId, link.id),
  )).limit(1);
  if (invoice) {
    res.status(409).json({ error: "This link belongs to an invoice. Use the invoice reminder so the current unpaid balance is sent." });
    return;
  }
  const [paidPayment] = await db.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    eq(transactionsTable.paymentLinkId, link.id),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
  )).limit(1);
  if (paidPayment) {
    res.status(409).json({ error: "This link has a confirmed payment and cannot be classified as unpaid." });
    return;
  }
  let scheduledAt: Date | null = null;
  if (body.data.scheduleAt) {
    scheduledAt = new Date(body.data.scheduleAt);
    if (scheduledAt.getTime() <= Date.now() + 60_000 || scheduledAt.getTime() > Date.now() + 30 * 86_400_000) {
      res.status(400).json({ error: "Schedule reminders at least one minute from now and no more than 30 days ahead." });
      return;
    }
  }
  const eventKey = `payment-link-reminder:${link.id}:${randomUUID()}`;
  const officialBase = officialInvoiceEmailBaseUrl();
  let deliveryId: number | null = null;
  let deliveryStatus = "unconfigured";
  let message = "Reminder was recorded but not emailed because the official HTTPS app URL is not configured. Share the payment link directly.";
  if (officialBase) {
    try {
      const delivery = await enqueueTransactionalEmail({
        eventKey,
        purpose: "payment_link_reminder",
        recipientEmail: body.data.recipientEmail,
        template: "payment_link_reminder",
        payload: {
          businessName: merchant.businessName,
          customerName: body.data.customerName ?? "there",
          description: link.description ?? link.name,
          amount: link.amountType === "fixed" ? Number(link.amount) : "As selected by you",
          currency: link.currency,
          paymentUrl: new URL(`/pay/${encodeURIComponent(link.slug)}`, officialBase).toString(),
        },
        ...(scheduledAt ? { sendAfter: scheduledAt } : {}),
      });
      deliveryId = delivery.id;
      deliveryStatus = delivery.deliveryState;
      message = `Reminder ${scheduledAt ? "scheduled" : "queued"} for ${body.data.recipientEmail}. The email delivery status will update as the outbox processes it.`;
    } catch (error) {
      deliveryStatus = "failed";
      message = `Reminder could not be queued${error instanceof Error ? `: ${error.message}` : "."}`;
    }
  }
  const [reminder] = await db.insert(merchantPaymentLinkRemindersTable).values({
    merchantId: merchant.id,
    paymentLinkId: link.id,
    recipientEmail: body.data.recipientEmail,
    deliveryStatus,
    message,
    scheduledAt,
    eventKey,
    deliveryId,
  }).returning();
  res.status(201).json(CreateMerchantPaymentLinkReminderResponse.parse({
    ...reminder,
    scheduledAt: reminder?.scheduledAt?.toISOString() ?? null,
    createdAt: reminder?.createdAt.toISOString(),
    attemptedAt: reminder?.attemptedAt?.toISOString() ?? null,
  }));
});

router.get("/merchant/statements/:month", requireSignedIn, async (req, res): Promise<void> => {
  const params = GetMerchantStatementParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const range = parseStatementMonth(params.data.month);
  if (!range) { res.status(400).json({ error: "Month must be a valid YYYY-MM value." }); return; }
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const transactions = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    gte(transactionsTable.paidAt, range.start),
    lt(transactionsTable.paidAt, range.end),
  )).orderBy(desc(transactionsTable.paidAt));
  const refundCashDate = sql<Date>`coalesce(${refundsTable.confirmedAt}, ${refundsTable.createdAt})`;
  const refundRows = await db.select({ refund: refundsTable }).from(refundsTable)
    .innerJoin(transactionsTable, eq(refundsTable.originalReference, transactionsTable.reference))
    .where(and(
      eq(transactionsTable.merchantId, merchant.id),
      gte(refundCashDate, range.start),
      lt(refundCashDate, range.end),
      inArray(refundsTable.status, [...PAID_REFUND_STATUSES]),
    )).orderBy(desc(refundCashDate));
  const refunds = confirmedStatementRows(refundRows.map(({ refund }) => refund), PAID_REFUND_STATUSES);
  const payoutCashDate = sql<Date>`coalesce(${payoutsTable.confirmedAt}, ${payoutsTable.createdAt})`;
  const payoutRows = await db.select().from(payoutsTable).where(and(
    eq(payoutsTable.merchantId, merchant.id),
    gte(payoutCashDate, range.start),
    lt(payoutCashDate, range.end),
    inArray(payoutsTable.status, [...PAID_PAYOUT_STATUSES]),
  )).orderBy(desc(payoutCashDate));
  const walletPayoutRequests = await db.select().from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.merchantId, merchant.id),
    or(
      and(gte(walletPayoutRequestsTable.createdAt, range.start), lt(walletPayoutRequestsTable.createdAt, range.end)),
      and(gte(walletPayoutRequestsTable.completedAt, range.start), lt(walletPayoutRequestsTable.completedAt, range.end)),
    ),
  )).orderBy(desc(walletPayoutRequestsTable.createdAt));
  const walletBackedLegacyPayouts = payoutRows.length
    ? await db.select({ reference: walletPayoutRequestsTable.reference }).from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      inArray(walletPayoutRequestsTable.reference, payoutRows.map((row) => row.reference)),
    ))
    : [];
  const confirmedWalletPayoutRequests = confirmedWalletPayoutsInMonth(
    walletPayoutRequests,
    PAID_PAYOUT_STATUSES,
    range.start,
    range.end,
  );
  const nonDuplicatePayouts = confirmedStatementPayouts(
    payoutRows,
    walletBackedLegacyPayouts,
    PAID_PAYOUT_STATUSES,
  );
  const walletSettlements = await db.select().from(walletSettlementConfirmationsTable).where(and(
    eq(walletSettlementConfirmationsTable.merchantId, merchant.id),
    gte(walletSettlementConfirmationsTable.confirmedAt, range.start),
    lt(walletSettlementConfirmationsTable.confirmedAt, range.end),
  )).orderBy(desc(walletSettlementConfirmationsTable.confirmedAt));

  const historyStart = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() - 3, 1));
  const history = await db.select().from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
    gte(transactionsTable.paidAt, historyStart),
    lt(transactionsTable.paidAt, range.start),
  ));
  const currencies = new Set([
    ...transactions.map((row) => row.currency),
    ...refunds.map((refund) => refund.currency),
    ...nonDuplicatePayouts.map((row) => row.currency),
    ...walletPayoutRequests.map((row) => row.currency),
    ...walletSettlements.map((row) => row.currency),
  ]);
  const currencySummaries = [...currencies].sort().map((currency) => {
    const grossConfirmed = transactions.filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + row.amount, 0);
    const payoutFees = nonDuplicatePayouts
      .filter((row) => row.currency === currency && PAID_PAYOUT_STATUSES.includes(row.status as never))
      .reduce((sum, row) => sum + Number(row.fee ?? 0), 0) +
      confirmedWalletPayoutRequests.filter((row) => row.currency === currency)
        .reduce((sum, row) => sum + Number(row.feeMinor) / 100, 0);
    const fees = transactions.filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + (row.fee ?? 0), 0) + payoutFees;
    const refundsTotal = refunds.filter((refund) => refund.currency === currency)
      .reduce((sum, refund) => sum + refund.amount, 0);
    const walletPayoutsTotal = confirmedWalletPayoutRequests
      .filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + Number(row.amountMinor) / 100, 0);
    const settlementsTotal = walletSettlements.filter((row) => row.currency === currency)
      .reduce((sum, row) => sum + Number(row.fundedMinor) / 100, 0);
    const currencyHistory = history.filter((row) => row.currency === currency);
    const historyMonths = currencyHistory.filter((row) => row.paidAt)
      .reduce((months, row) => months.add(`${row.paidAt!.getUTCFullYear()}-${row.paidAt!.getUTCMonth()}`), new Set<string>());
    const historyGross = currencyHistory.reduce((sum, row) => sum + row.amount, 0);
    return {
      currency,
      grossConfirmed: Math.round(grossConfirmed * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      refundsTotal: Math.round(refundsTotal * 100) / 100,
      payoutsTotal: Math.round((nonDuplicatePayouts
        .filter((row) => row.currency === currency && PAID_PAYOUT_STATUSES.includes(row.status as never))
        .reduce((sum, row) => sum + row.amount, 0) + walletPayoutsTotal) * 100) / 100,
      settlementsTotal: Math.round(settlementsTotal * 100) / 100,
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
      reference: row.reference, providerReference: row.providerReference,
      amount: row.amount, fee: row.fee ?? 0,
      currency: row.currency, paidAt: row.paidAt,
    })),
    refunds: refunds.map((refund) => ({
      reference: refund.reference, providerReference: refund.providerReference,
      originalReference: refund.originalReference,
      amount: refund.amount, currency: refund.currency, status: refund.status, createdAt: refund.createdAt,
      ...statementCashDate(refund),
    })),
    payouts: nonDuplicatePayouts.map((row) => ({
      reference: row.reference, providerReference: row.providerReference,
      amount: row.amount, fee: row.fee ?? 0,
      currency: row.currency, status: row.status, createdAt: row.createdAt,
      ...statementCashDate(row),
    })),
    settlements: walletSettlements.map((row) => ({
      reference: row.settlementReference,
      amount: Number(row.fundedMinor) / 100,
      currency: row.currency,
      status: "confirmed",
      createdAt: row.confirmedAt,
    })),
    walletPayoutRequests: walletPayoutRequests.map((row) => ({
      reference: row.reference,
      amount: Number(row.amountMinor) / 100,
      fee: Number(row.feeMinor) / 100,
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    })),
    currencySummaries,
  }));
});

router.post("/merchant/cases/:id/attachments/upload-intent", requireSignedIn, async (req, res): Promise<void> => {
  const params = GetMerchantCaseParams.safeParse(req.params);
  const body = req.body as Record<string, unknown> | null;
  if (!params.success || !body || typeof body.name !== "string" ||
      typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size < 1 ||
      body.size > CASE_FILE_MAX_BYTES || typeof body.contentType !== "string" ||
      !CASE_FILE_CONTENT_TYPES.has(body.contentType)) {
    res.status(400).json({ error: !params.success ? params.error.message : "Choose a PDF, PNG, or JPEG file no larger than 10 MB." });
    return;
  }
  let name: string;
  try { name = caseAttachmentName(body.name, body.contentType); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid filename." }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [caseRow] = await db.select().from(merchantSupportCasesTable).where(and(
    eq(merchantSupportCasesTable.id, params.data.id),
    eq(merchantSupportCasesTable.merchantId, merchant.id),
  )).limit(1);
  if (!caseRow) { res.status(404).json({ error: "Case not found for this merchant." }); return; }
  const expiredIntents = await db.select().from(merchantCaseUploadIntentsTable).where(and(
    eq(merchantCaseUploadIntentsTable.merchantId, merchant.id),
    eq(merchantCaseUploadIntentsTable.caseId, caseRow.id),
    isNull(merchantCaseUploadIntentsTable.consumedAt),
    lt(merchantCaseUploadIntentsTable.expiresAt, new Date()),
  ));
  for (const expired of expiredIntents) await deletePrivateCaseObject(expired.objectPath);
  if (expiredIntents.length) await db.delete(merchantCaseUploadIntentsTable)
    .where(inArray(merchantCaseUploadIntentsTable.id, expiredIntents.map((intent) => intent.id)));
  const pendingIntentRows = await db.select({ id: merchantCaseUploadIntentsTable.id }).from(merchantCaseUploadIntentsTable).where(and(
    eq(merchantCaseUploadIntentsTable.merchantId, merchant.id),
    eq(merchantCaseUploadIntentsTable.caseId, caseRow.id),
    isNull(merchantCaseUploadIntentsTable.consumedAt),
    gte(merchantCaseUploadIntentsTable.expiresAt, new Date()),
  ));
  if (pendingIntentRows.length >= MAX_CASE_ATTACHMENTS_PER_MESSAGE) {
    res.status(409).json({ error: "This case already has five active file upload links. Finish or retry the current message before starting another." });
    return;
  }
  const current = await db.select({ count: sql<number>`count(*)::int` }).from(merchantCaseAttachmentsTable)
    .where(eq(merchantCaseAttachmentsTable.caseId, caseRow.id));
  if (Number(current[0]?.count ?? 0) + pendingIntentRows.length >= MAX_CASE_ATTACHMENTS) {
    res.status(409).json({ error: "This case has reached the 25-file attachment limit." });
    return;
  }
  try {
    const upload = await createPrivateCaseUpload(merchant.id, caseRow.id, body.contentType as CaseFileType);
    const token = randomUUID().replaceAll("-", "");
    await db.insert(merchantCaseUploadIntentsTable).values({
      token,
      merchantId: merchant.id,
      caseId: caseRow.id,
      objectPath: upload.objectPath,
      name,
      contentType: body.contentType,
      size: body.size,
      expiresAt: new Date(Math.min(upload.expiresAt.getTime(), Date.now() + CASE_UPLOAD_TTL_MS)),
    });
    res.status(201).json({
      uploadURL: upload.uploadURL,
      uploadParameters: upload.uploadParameters,
      objectPath: upload.objectPath,
      uploadToken: token,
      expiresAt: upload.expiresAt,
    });
  } catch (error) {
    req.log.error({ err: error, caseId: caseRow.id }, "Could not create private case evidence upload");
    res.status(503).json({ error: "Private evidence storage is temporarily unavailable. No file was attached." });
  }
});

async function streamCaseAttachment(
  req: Parameters<typeof resolveMerchantAccess>[0],
  res: Parameters<typeof resolveMerchantAccess>[1],
  caseId: number,
  attachmentId: number,
  admin: boolean,
): Promise<void> {
  let merchantId: number | undefined;
  if (!admin) {
    const merchant = await resolveMerchantAccess(req, res, "read");
    if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
    merchantId = merchant.id;
  }
  const [attachment] = await db.select().from(merchantCaseAttachmentsTable).where(and(
    eq(merchantCaseAttachmentsTable.id, attachmentId),
    eq(merchantCaseAttachmentsTable.caseId, caseId),
    merchantId === undefined ? undefined : eq(merchantCaseAttachmentsTable.merchantId, merchantId),
  )).limit(1);
  if (!attachment) { res.status(404).json({ error: "Supporting file was not found for this case." }); return; }
  try {
    const file = await getPrivateCaseObject(attachment.objectPath, {
      size: attachment.size,
      contentType: attachment.contentType as CaseFileType,
      sha256: attachment.sha256,
    });
    const safeName = attachment.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Length", String(attachment.size));
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.status(200);
    file.createReadStream().on("error", (error) => {
      req.log.error({ err: error, caseId, attachmentId }, "Private case evidence download failed");
      if (!res.headersSent) res.status(500).json({ error: "Supporting file could not be downloaded." });
      else res.destroy(error);
    }).pipe(res);
  } catch (error) {
    req.log.error({ err: error, caseId, attachmentId }, "Private case evidence is unavailable");
    if (!res.headersSent) res.status(404).json({ error: "Supporting file is unavailable in private storage." });
  }
}

router.get("/merchant/cases/:id/attachments/:attachmentId/download", requireSignedIn, async (req, res): Promise<void> => {
  const caseParams = GetMerchantCaseParams.safeParse({ id: req.params.id });
  const attachmentId = Number(req.params.attachmentId);
  if (!caseParams.success || !Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    res.status(400).json({ error: "Case or attachment identifier is invalid." });
    return;
  }
  await streamCaseAttachment(req, res, caseParams.data.id, attachmentId, false);
});

router.get("/admin/cases/:id/attachments/:attachmentId/download", requireAdmin, async (req, res): Promise<void> => {
  const caseId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isSafeInteger(caseId) || caseId <= 0 || !Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    res.status(400).json({ error: "Case or attachment identifier is invalid." });
    return;
  }
  await streamCaseAttachment(req, res, caseId, attachmentId, true);
});

router.get("/merchant/cases", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const rows = await db.select().from(merchantSupportCasesTable).where(eq(merchantSupportCasesTable.merchantId, merchant.id))
    .orderBy(desc(merchantSupportCasesTable.createdAt));
  res.json(ListMerchantCasesResponse.parse({ items: await Promise.all(rows.map(caseDto)) }));
});

router.post("/merchant/cases", requireSignedIn, async (req, res): Promise<void> => {
  const body = CreateMerchantCaseBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, body.data.kind === "refund" ? "refundRequests" : "disputeRequests");
  const transactionReference = body.data.transactionReference.trim();
  const [transaction] = await db.select({
    reference: transactionsTable.reference, merchantId: transactionsTable.merchantId,
    status: transactionsTable.status, paidAt: transactionsTable.paidAt,
  }).from(transactionsTable).where(and(
    eq(transactionsTable.reference, transactionReference),
    eq(transactionsTable.merchantId, merchant.id),
  )).limit(1);
  if (!transaction || transaction.merchantId == null || !ownsBusinessResource(transaction.merchantId, merchant.id)) {
    res.status(404).json({ error: "Transaction not found for this merchant." }); return;
  }
  if (!transaction.paidAt || !PAID_TRANSACTION_STATUSES.includes(transaction.status as never)) {
    res.status(409).json({ error: "Refund and dispute cases require a confirmed payment." });
    return;
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
  res.status(201).json(CreateMerchantCaseResponse.parse(await caseDto(created)));
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
  res.json(GetMerchantCaseResponse.parse(await caseDto(row)));
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
  const rawTokens = (req.body as { attachmentUploadTokens?: unknown }).attachmentUploadTokens;
  if (rawTokens !== undefined && (!Array.isArray(rawTokens) || rawTokens.length > MAX_CASE_ATTACHMENTS_PER_MESSAGE ||
      rawTokens.some((token) => typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) ||
      new Set(rawTokens).size !== rawTokens.length)) {
    res.status(400).json({ error: "Attach no more than five valid uploaded files to one message." });
    return;
  }
  const tokens = (rawTokens ?? []) as string[];
  if (!body.data.message.trim() && tokens.length === 0) {
    res.status(400).json({ error: "Add a message or attach supporting files." });
    return;
  }
  let evidenceUrl: string | null;
  try { evidenceUrl = validateEvidenceUrl(body.data.evidenceUrl); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence URL." }); return; }
  const messageId = randomUUID();
  let intents: typeof merchantCaseUploadIntentsTable.$inferSelect[] = [];
  const verifiedObjects = new Map<string, Awaited<ReturnType<typeof verifyPrivateCaseObject>>>();
  if (tokens.length) {
    intents = await db.select().from(merchantCaseUploadIntentsTable).where(and(
      eq(merchantCaseUploadIntentsTable.merchantId, merchant.id),
      eq(merchantCaseUploadIntentsTable.caseId, row.id),
      inArray(merchantCaseUploadIntentsTable.token, tokens),
      isNull(merchantCaseUploadIntentsTable.consumedAt),
      gte(merchantCaseUploadIntentsTable.expiresAt, new Date()),
    ));
    if (intents.length !== tokens.length) {
      res.status(409).json({ error: "One or more file upload links expired or were already used. Upload the files again." });
      return;
    }
    try {
      for (const intent of intents) {
        const verified = await verifyPrivateCaseObject({
          objectPath: intent.objectPath,
          name: intent.name,
          size: intent.size,
          contentType: intent.contentType as CaseFileType,
        });
        verifiedObjects.set(intent.token, verified);
      }
    } catch (error) {
      await Promise.all([
        ...intents.map((intent) => deletePrivateCaseObject(intent.objectPath)),
        ...[...verifiedObjects.values()].map((verified) => deletePrivateCaseObject(verified.objectPath)),
      ]);
      res.status(400).json({ error: error instanceof Error ? error.message : "An uploaded file did not pass validation." });
      return;
    }
  }
  try {
    const [updated] = await db.transaction(async (tx) => {
      const [lockedCase] = await tx.select().from(merchantSupportCasesTable).where(and(
        eq(merchantSupportCasesTable.id, row.id),
        eq(merchantSupportCasesTable.merchantId, merchant.id),
      )).for("update").limit(1);
      if (!lockedCase) throw Object.assign(new Error("Case not found for this merchant."), { statusCode: 404 });
      const [currentCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(merchantCaseAttachmentsTable)
        .where(eq(merchantCaseAttachmentsTable.caseId, row.id));
      if (Number(currentCount?.count ?? 0) + tokens.length > MAX_CASE_ATTACHMENTS) {
        throw Object.assign(new Error("This case has reached the 25-file attachment limit."), { statusCode: 409 });
      }
      const lockedIntents = tokens.length ? await tx.select().from(merchantCaseUploadIntentsTable).where(and(
        eq(merchantCaseUploadIntentsTable.merchantId, merchant.id),
        eq(merchantCaseUploadIntentsTable.caseId, row.id),
        inArray(merchantCaseUploadIntentsTable.token, tokens),
        isNull(merchantCaseUploadIntentsTable.consumedAt),
        gte(merchantCaseUploadIntentsTable.expiresAt, new Date()),
      )).for("update") : [];
      if (lockedIntents.length !== tokens.length) {
        throw Object.assign(new Error("One or more upload tokens were already used or expired. Upload the files again."), { statusCode: 409 });
      }
      const messageAttachments: number[] = [];
      for (const intent of lockedIntents) {
        const verified = verifiedObjects.get(intent.token);
        if (!verified) throw Object.assign(new Error("An uploaded file could not be verified."), { statusCode: 409 });
        const [attachment] = await tx.insert(merchantCaseAttachmentsTable).values({
          merchantId: merchant.id,
          caseId: row.id,
          messageId,
          objectPath: verified.objectPath,
          name: verified.name,
          contentType: verified.contentType,
          size: verified.size,
          sha256: verified.sha256,
        }).returning();
        messageAttachments.push(attachment.id);
        await tx.update(merchantCaseUploadIntentsTable).set({ consumedAt: new Date() })
          .where(eq(merchantCaseUploadIntentsTable.id, intent.id));
      }
      return tx.update(merchantSupportCasesTable).set({
        messages: [...lockedCase.messages, {
          id: messageId, authorRole: "merchant", message: body.data.message.trim(),
          evidenceUrl, ...(messageAttachments.length ? { attachmentIds: messageAttachments } : {}),
          createdAt: new Date().toISOString(),
        }],
        updatedAt: new Date(),
      }).where(and(eq(merchantSupportCasesTable.id, row.id), eq(merchantSupportCasesTable.merchantId, merchant.id))).returning();
    });
    res.json(AddMerchantCaseMessageResponse.parse(await caseDto(updated)));
  } catch (error) {
    for (const intent of intents) {
      await deletePrivateCaseObject(intent.objectPath);
      const verified = verifiedObjects.get(intent.token);
      if (verified) {
        const [persisted] = await db.select({ id: merchantCaseAttachmentsTable.id }).from(merchantCaseAttachmentsTable)
          .where(eq(merchantCaseAttachmentsTable.objectPath, verified.objectPath)).limit(1);
        if (!persisted) await deletePrivateCaseObject(verified.objectPath);
      }
    }
    const status = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode : 500;
    req.log.error({ err: error, caseId: row.id }, "Could not save merchant case message");
    res.status(status).json({ error: error instanceof Error ? error.message : "Could not save the case message." });
  }
});

router.get("/admin/cases", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(merchantSupportCasesTable).orderBy(desc(merchantSupportCasesTable.createdAt));
  res.json(ListAdminCasesResponse.parse({ items: await Promise.all(rows.map(caseDto)) }));
});

router.post("/admin/cases/:id/refund-record", requireAdmin, async (req, res): Promise<void> => {
  const params = ReviewAdminCaseParams.safeParse(req.params);
  const body = req.body as Record<string, unknown> | null;
  if (!params.success || !body || typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0 ||
      typeof body.providerReference !== "string" || !body.providerReference.trim() || body.providerReference.length > 200 ||
      typeof body.evidenceReference !== "string" || !body.evidenceReference.trim() || body.evidenceReference.length > 200 ||
      typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotencyKey) ||
      typeof body.note !== "string" || !body.note.trim() || body.note.length > 4000) {
    res.status(400).json({ error: !params.success ? params.error.message : "Provide a positive refund amount, provider reference, evidence reference, idempotency key, and note." });
    return;
  }
  let amount: number;
  try {
    amount = amountCents(body.amount) / 100;
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Enter a valid refund amount." });
    return;
  }
  const adminId = getAuth(req).userId;
  if (!adminId) { res.status(401).json({ error: "Sign in to record provider refund evidence." }); return; }
  const providerReference = body.providerReference.trim();
  const evidenceReference = body.evidenceReference.trim();
  const note = body.note.trim();
  const requestHash = createHash("sha256").update(JSON.stringify({
    amount, providerReference, evidenceReference, note,
  })).digest("hex");
  try {
    const result = await db.transaction((tx) => recordManualCaseRefundEvidenceInTransaction(tx, {
      caseId: params.data.id,
      amount,
      providerReference,
      evidenceReference,
      idempotencyKey: body.idempotencyKey as string,
      requestHash,
      note,
      createdBy: adminId,
    }));
    if (result.event) void dispatchPendingMerchantWebhooks().catch(() => undefined);
    res.status(result.replayed ? 200 : 201).json({
      case: await caseDto(result.caseRow),
      refundReference: result.refund.reference,
      amount: Number(result.refund.amount),
      currency: result.refund.currency,
      status: result.refund.status,
      providerReference: result.refund.providerReference,
      evidenceReference,
      createdAt: result.refund.createdAt,
      idempotentReplay: result.replayed,
    });
  } catch (error) {
    const status = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode : 409;
    req.log.warn({ err: error, caseId: params.data.id }, "Admin refund evidence could not be recorded");
    res.status(status).json({ error: error instanceof Error ? error.message : "Refund evidence could not be recorded." });
  }
});

router.patch("/admin/cases/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = ReviewAdminCaseParams.safeParse(req.params);
  const body = ReviewAdminCaseBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." }); return; }
  let evidenceUrl: string | null;
  try { evidenceUrl = validateEvidenceUrl(body.data.evidenceUrl); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence URL." }); return; }
  try {
    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(merchantSupportCasesTable)
        .where(eq(merchantSupportCasesTable.id, params.data.id)).for("update").limit(1);
      if (!row) throw Object.assign(new Error("Case not found."), { statusCode: 404 });
      const movement = body.data.financialMovement ?? row.financialMovement;
      if (movement === "confirmed") {
        const [refund] = await tx.select({ id: refundsTable.id }).from(merchantCaseRefundsTable)
          .innerJoin(refundsTable, eq(merchantCaseRefundsTable.refundId, refundsTable.id))
          .where(and(
            eq(merchantCaseRefundsTable.caseId, row.id),
            eq(merchantCaseRefundsTable.transactionReference, row.transactionReference),
            inArray(refundsTable.status, [...PAID_REFUND_STATUSES]),
          )).limit(1);
        if (!refund) {
          throw Object.assign(new Error("Customer money movement cannot be marked confirmed without a confirmed refund record linked to this case."), { statusCode: 409 });
        }
      }
      return tx.update(merchantSupportCasesTable).set({
        status: body.data.status,
        financialMovement: movement,
        messages: [...row.messages, {
          id: randomUUID(), authorRole: "admin", message: body.data.message.trim(),
          evidenceUrl, createdAt: new Date().toISOString(),
        }],
        updatedAt: new Date(),
      }).where(eq(merchantSupportCasesTable.id, row.id)).returning();
    });
    res.json(ReviewAdminCaseResponse.parse(await caseDto(updated)));
  } catch (error) {
    const status = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode : 500;
    req.log.warn({ err: error, caseId: params.data.id }, "Admin case review could not be saved");
    res.status(status).json({ error: error instanceof Error ? error.message : "Case review could not be saved." });
  }
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