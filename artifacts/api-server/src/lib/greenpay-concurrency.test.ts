import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  refundsTable,
  settlementsTable,
  transactionsTable,
} from "@workspace/db";
import { createCollection } from "./greenpay-collection";
import { markTransactionStatus, recordRefund } from "./greenpay-ledger";

after(async () => {
  await pool.end();
});

async function deletePaymentFixture(reference: string): Promise<void> {
  await db.delete(refundsTable).where(eq(refundsTable.originalReference, reference));
  await db.delete(settlementsTable).where(eq(settlementsTable.reference, reference));
  await db.delete(transactionsTable).where(eq(transactionsTable.reference, reference));
}

const testCollectionInput = {
  amount: 12.34,
  currency: "USD",
  customerEmail: "interleaving-test@example.invalid",
};

const mockedCollectionDependencies = {
  assertPaymentsEnabled: async () => undefined,
  providerIsConfigured: async () => true,
  loadFeeSchedule: async () => undefined,
};

test("a timed-out initiation stays pending and can later reconcile to provider success", async () => {
  let reference: string | undefined;
  try {
    await assert.rejects(createCollection(testCollectionInput, {
      ...mockedCollectionDependencies,
      startProviderPayment: async (request) => {
        reference = request.reference;
        throw new Error("simulated initiation timeout");
      },
    }), /simulated initiation timeout/);
    assert.ok(reference);

    const [afterTimeout] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, reference));
    assert.equal(afterTimeout?.status, "pending");

    const successful = await markTransactionStatus(reference, {
      status: "success", fee: 0, netAmount: testCollectionInput.amount, paidAt: new Date(),
    });
    assert.equal(successful?.status, "success");
    const settlements = await db.select().from(settlementsTable)
      .where(eq(settlementsTable.reference, reference));
    assert.equal(settlements.length, 1);
  } finally {
    if (reference) await deletePaymentFixture(reference);
  }
});

test("a success callback racing a rejected initiation cannot be overwritten as failed", async () => {
  let reference: string | undefined;
  try {
    await assert.rejects(createCollection(testCollectionInput, {
      ...mockedCollectionDependencies,
      startProviderPayment: async (request) => {
        reference = request.reference;
        await markTransactionStatus(request.reference, {
          status: "success", fee: 0, netAmount: testCollectionInput.amount, paidAt: new Date(),
        });
        throw new Error("simulated lost initiation response");
      },
    }), /simulated lost initiation response/);
    assert.ok(reference);

    const [transaction] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, reference));
    assert.equal(transaction?.status, "success");
    const settlements = await db.select().from(settlementsTable)
      .where(eq(settlementsTable.reference, reference));
    assert.equal(settlements.length, 1);
  } finally {
    if (reference) await deletePaymentFixture(reference);
  }
});

test("a stale pending initiation reply retains an already processed partial refund", async () => {
  const reference = `GP-REFUND-INTERLEAVE-${randomUUID()}`;
  const reservationReference = `GP-RF-INTERLEAVE-${randomUUID()}`;
  let transactionId: number | undefined;
  let reservationId: number | undefined;
  try {
    const [transaction] = await db.insert(transactionsTable).values({
      reference,
      provider: "paystack",
      providerReference: `PAYMENT-${randomUUID()}`,
      amount: 100,
      fee: 5,
      netAmount: 95,
      currency: "USD",
      status: "success",
      customerEmail: "interleaving-test@example.invalid",
      paidAt: new Date(),
      settlementStatus: "pending",
    }).returning();
    transactionId = transaction!.id;
    const [reservation] = await db.insert(refundsTable).values({
      reference: reservationReference,
      originalReference: reference,
      provider: "paystack",
      amount: 25,
      currency: "USD",
      status: "pending",
    }).returning();
    reservationId = reservation!.id;

    const processed = await recordRefund({
      originalReference: reference,
      reservationId,
      provider: "paystack",
      providerReference: "PAYSTACK-REFUND-INTERLEAVE",
      source: "reconciliation",
      amount: 25,
      currency: "USD",
      status: "processed",
    });
    const retained = await recordRefund({
      originalReference: reference,
      reservationId,
      provider: "paystack",
      providerReference: null,
      source: "initiation",
      amount: 25,
      currency: "USD",
      status: "pending",
    });

    assert.equal(processed?.status, "processed");
    assert.equal(retained?.status, "processed");
    assert.equal(retained?.provider, "paystack");
    assert.equal(retained?.providerReference, "PAYSTACK-REFUND-INTERLEAVE");
    assert.equal(retained?.amount, 25);
    const [currentTransaction] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, reference));
    assert.equal(currentTransaction?.status, "success");
    const [refundTotal] = await db.select({ total: refundsTable.amount }).from(refundsTable)
      .where(eq(refundsTable.id, reservationId));
    assert.equal(Number(refundTotal?.total), 25);
  } finally {
    if (reservationId) await db.delete(refundsTable).where(eq(refundsTable.id, reservationId));
    if (transactionId) await db.delete(transactionsTable).where(eq(transactionsTable.id, transactionId));
  }
});