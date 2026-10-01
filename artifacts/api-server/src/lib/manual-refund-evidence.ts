import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  merchantCaseRefundsTable,
  merchantSupportCasesTable,
  refundsTable,
  transactionsTable,
} from "@workspace/db";
import { recordRefundInTransaction } from "./greenpay-ledger";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES, OPEN_REFUND_RESERVATION_STATUSES, remainingRefundableAmount } from "./payment-safety";

type FinancialTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PAID_TRANSACTION_STATUSES = ["success", "refunded"] as const;

export async function recordManualCaseRefundEvidenceInTransaction(
  tx: FinancialTx,
  input: {
    caseId: number;
    amount: number;
    providerReference: string;
    evidenceReference: string;
    idempotencyKey: string;
    requestHash: string;
    note: string;
    createdBy: string;
  },
) {
  const [caseRow] = await tx.select().from(merchantSupportCasesTable)
    .where(eq(merchantSupportCasesTable.id, input.caseId)).for("update").limit(1);
  if (!caseRow) throw Object.assign(new Error("Case not found."), { statusCode: 404 });
  if (caseRow.kind !== "refund") throw Object.assign(new Error("Only refund cases can record refund evidence."), { statusCode: 409 });

  const [existing] = await tx.select().from(merchantCaseRefundsTable).where(and(
    eq(merchantCaseRefundsTable.caseId, caseRow.id),
    eq(merchantCaseRefundsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw Object.assign(new Error("This idempotency key was already used for different refund evidence."), { statusCode: 409 });
    }
    const [refund] = await tx.select().from(refundsTable).where(eq(refundsTable.id, existing.refundId)).limit(1);
    if (!refund || !CUSTOMER_REIMBURSED_REFUND_STATUSES.includes(refund.status as never)) {
      throw Object.assign(new Error("The previously recorded refund is not confirmed."), { statusCode: 409 });
    }
    return { caseRow, refund, replayed: true as const, event: undefined };
  }
  if (caseRow.status === "declined") {
    throw Object.assign(new Error("A declined refund case cannot record new refund evidence."), { statusCode: 409 });
  }

  const [transaction] = await tx.select().from(transactionsTable).where(and(
    eq(transactionsTable.reference, caseRow.transactionReference),
    eq(transactionsTable.merchantId, caseRow.merchantId),
  )).for("update").limit(1);
  if (!transaction || !transaction.paidAt || !PAID_TRANSACTION_STATUSES.includes(transaction.status as never)) {
    throw Object.assign(new Error("Only a confirmed payment can be tied to customer refund evidence."), { statusCode: 409 });
  }
  const [inFlight] = await tx.select({ id: refundsTable.id }).from(refundsTable).where(and(
    eq(refundsTable.originalReference, transaction.reference),
    inArray(refundsTable.status, [...OPEN_REFUND_RESERVATION_STATUSES]),
  )).limit(1);
  if (inFlight) {
    throw Object.assign(new Error("Another refund is pending or requires reconciliation; the remaining balance is held."), { statusCode: 409 });
  }

  const [refundTotal] = await tx.select({
    total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
  }).from(refundsTable).where(and(
    eq(refundsTable.originalReference, transaction.reference),
    inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
  ));
  const remaining = remainingRefundableAmount(Number(transaction.amount), Number(refundTotal?.total ?? 0));
  if (input.amount - remaining > 0.001) {
    throw Object.assign(new Error(`The remaining refundable amount is ${remaining} ${transaction.currency}.`), { statusCode: 400 });
  }

  const [providerReferenceInUse] = await tx.select({ id: refundsTable.id }).from(refundsTable)
    .where(eq(refundsTable.providerReference, input.providerReference)).limit(1);
  if (providerReferenceInUse) {
    throw Object.assign(new Error("This provider refund reference has already been recorded."), { statusCode: 409 });
  }

  const reason = `Admin-recorded manual refund. Evidence ${input.evidenceReference}. ${input.note}`.slice(0, 2000);
  const reservation = await recordRefundInTransaction(tx, {
    originalReference: transaction.reference,
    provider: "manual",
    providerReference: input.providerReference,
    amount: input.amount,
    currency: transaction.currency,
    status: "pending",
    reason,
  });
  const confirmation = await recordRefundInTransaction(tx, {
    originalReference: transaction.reference,
    reservationId: reservation.refund.id,
    provider: "manual",
    providerReference: input.providerReference,
    source: "reconciliation",
    amount: input.amount,
    currency: transaction.currency,
    status: "processed",
    reason,
  });

  await tx.insert(merchantCaseRefundsTable).values({
    merchantId: caseRow.merchantId,
    caseId: caseRow.id,
    transactionReference: transaction.reference,
    refundId: confirmation.refund.id,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    providerReference: input.providerReference,
    evidenceReference: input.evidenceReference,
    createdBy: input.createdBy,
  });
  const [updatedCase] = await tx.update(merchantSupportCasesTable).set({
    financialMovement: "confirmed",
    messages: [...caseRow.messages, {
      id: randomUUID(),
      authorRole: "admin",
      message: `Manual provider refund evidence recorded: ${input.amount.toFixed(2)} ${transaction.currency}; provider reference ${input.providerReference}; evidence reference ${input.evidenceReference}. This records verified external money movement; Greenpay did not initiate a provider refund.`,
      evidenceUrl: null,
      createdAt: new Date().toISOString(),
    }],
    updatedAt: new Date(),
  }).where(eq(merchantSupportCasesTable.id, caseRow.id)).returning();
  if (!updatedCase) throw Object.assign(new Error("Refund evidence was recorded but the case update could not be completed."), { statusCode: 500 });
  return {
    caseRow: updatedCase,
    refund: confirmation.refund,
    replayed: false as const,
    event: confirmation.event,
  };
}