import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  merchantInvoicesTable,
  paymentLinksTable,
  refundsTable,
  transactionsTable,
} from "@workspace/db";
import { assertCollectionAmountPrecision } from "./greenpay-collection";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "./payment-safety";
import { invoiceOutstandingAmount } from "./merchant-business-tools";

type FinancialTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;

export async function refreshInvoicePaymentLinkInTransaction(
  tx: FinancialTx,
  input: { invoiceId: number; merchantId: number },
) {
  const [invoice] = await tx.select().from(merchantInvoicesTable).where(and(
    eq(merchantInvoicesTable.id, input.invoiceId),
    eq(merchantInvoicesTable.merchantId, input.merchantId),
  )).for("update").limit(1);
  if (!invoice) throw Object.assign(new Error("Invoice was not found."), { statusCode: 404 });
  if (invoice.status === "void") {
    throw Object.assign(new Error("A void invoice cannot receive a payment link."), { statusCode: 409 });
  }

  // Lock invoice then stable link, matching collection checkout's lock order.
  const [existingLink] = invoice.paymentLinkId ? await tx.select().from(paymentLinksTable).where(and(
    eq(paymentLinksTable.id, invoice.paymentLinkId),
    eq(paymentLinksTable.merchantId, input.merchantId),
  )).for("update").limit(1) : [];
  if (invoice.paymentLinkId && (!existingLink || existingLink.amountType !== "fixed" ||
      existingLink.currency.toUpperCase() !== invoice.currency.toUpperCase())) {
    throw Object.assign(new Error("The invoice's original payment link is unavailable or inconsistent; support is required before regenerating it."), { statusCode: 409 });
  }

  const paidTransactions = invoice.paymentLinkId ? await tx.select().from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, input.merchantId),
    eq(transactionsTable.paymentLinkId, invoice.paymentLinkId),
    inArray(transactionsTable.status, [...PAID_TRANSACTION_STATUSES]),
  )) : [];
  const collected = paidTransactions.reduce((sum, row) => sum + (row.paidAt ? Number(row.amount) : 0), 0);
  let reimbursed = 0;
  for (const transaction of paidTransactions) {
    const confirmedRefunds = await tx.select({ amount: refundsTable.amount }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, transaction.reference),
      inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
    ));
    reimbursed += confirmedRefunds.reduce((sum, refund) => sum + Number(refund.amount), 0);
  }
  const outstanding = invoiceOutstandingAmount(
    invoice.total,
    Math.max(0, Math.min(invoice.total, collected - reimbursed)),
  );
  if (outstanding <= 0) {
    throw Object.assign(new Error("This invoice has no outstanding balance."), { statusCode: 409 });
  }
  assertCollectionAmountPrecision(outstanding, invoice.currency);

  if (invoice.paymentLinkId) {
    const [pendingCollection] = await tx.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
      eq(transactionsTable.merchantId, input.merchantId),
      eq(transactionsTable.paymentLinkId, invoice.paymentLinkId),
      eq(transactionsTable.status, "pending"),
    )).limit(1);
    if (pendingCollection) {
      throw Object.assign(new Error("An invoice payment is awaiting provider confirmation. The balance is held until its outcome is known."), { statusCode: 409 });
    }
    if (existingLink?.status === "active" && Number(existingLink.amount) === outstanding &&
        Number(invoice.paymentLinkAmount ?? existingLink.amount) === outstanding) {
      return invoice;
    }
  }

  const [link] = existingLink
    ? await tx.update(paymentLinksTable).set({
      amount: outstanding,
      status: "active",
      expiresAt: null,
    }).where(and(
      eq(paymentLinksTable.id, existingLink.id),
      eq(paymentLinksTable.merchantId, input.merchantId),
    )).returning()
    : await tx.insert(paymentLinksTable).values({
      slug: randomUUID().replaceAll("-", "").slice(0, 20),
      merchantId: input.merchantId,
      name: `Invoice ${invoice.reference}`,
      description: `Payment for invoice ${invoice.reference}`,
      amountType: "fixed",
      amount: outstanding,
      currency: invoice.currency,
      status: "active",
    }).returning();
  if (!link) throw Object.assign(new Error("Invoice payment link could not be saved."), { statusCode: 500 });

  const [updatedInvoice] = await tx.update(merchantInvoicesTable).set({
    paymentLinkId: link.id,
    paymentLinkAmount: outstanding,
    updatedAt: new Date(),
  }).where(and(
    eq(merchantInvoicesTable.id, invoice.id),
    eq(merchantInvoicesTable.merchantId, input.merchantId),
  )).returning();
  if (!updatedInvoice) throw Object.assign(new Error("Invoice payment link could not be attached."), { statusCode: 500 });
  return updatedInvoice;
}