import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminAuditLogTable,
  airtimeTopupsTable,
  airtimeWalletEntriesTable,
  airtimeWalletsTable,
  db,
  merchantsTable,
  pool,
} from "@workspace/db";
import {
  ConfirmAdminAirtimeTopupCreditResponse,
  ListAdminAirtimeTopupsForReviewResponse,
} from "@workspace/api-zod";
import {
  confirmAdminAirtimeTopupCredit,
  listAdminAirtimeTopupsForReview,
  recordAirtimeTopupReconciliationFailure,
} from "./airtime-service";

after(async () => {
  await pool.end();
});

async function createTopupFixture(status: "failed" | "unknown") {
  const token = randomUUID();
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: `airtime-admin-test-${token}`,
    businessName: `Airtime review fixture ${token.slice(0, 8)}`,
    country: "KE",
    baseCurrency: "KES",
    status: "active",
    kycStatus: "approved",
    kybStatus: "approved",
  }).returning();
  if (!merchant) throw new Error("Could not create the airtime admin test merchant.");

  await db.insert(airtimeWalletsTable).values({
    merchantId: merchant.id,
    availableMinor: 1_000n,
    reservedMinor: 700n,
  });
  const reference = `ATU_TEST_${token}`;
  const [topup] = await db.insert(airtimeTopupsTable).values({
    merchantId: merchant.id,
    reference,
    idempotencyKey: `airtime-test-${token}`,
    requestHash: createHash("sha256").update(token).digest("hex"),
    phoneNumber: "254712345678",
    amountMinor: 5_000n,
    providerReference: `provider-${token}`,
    status,
    lastCheckedAt: new Date(),
    lastError: "Payment status could not be confirmed.",
  }).returning();
  if (!topup) throw new Error("Could not create the airtime admin test top-up.");
  return { merchantId: merchant.id, reference };
}

async function cleanupFixtures(merchantIds: number[], actors: string[]) {
  if (merchantIds.length) {
    await db.delete(airtimeWalletEntriesTable)
      .where(inArray(airtimeWalletEntriesTable.merchantId, merchantIds));
    await db.delete(airtimeTopupsTable)
      .where(inArray(airtimeTopupsTable.merchantId, merchantIds));
    await db.delete(airtimeWalletsTable)
      .where(inArray(airtimeWalletsTable.merchantId, merchantIds));
    await db.delete(merchantsTable).where(inArray(merchantsTable.id, merchantIds));
  }
  if (actors.length) {
    await db.delete(adminAuditLogTable).where(and(
      inArray(adminAuditLogTable.actor, actors),
      eq(adminAuditLogTable.action, "airtime.admin_topup_confirmed"),
    ));
  }
}

test("manual airtime confirmation credits once, records evidence, and blocks receipt reuse", async () => {
  const merchantIds: number[] = [];
  const actor = `airtime-admin-${randomUUID()}`;
  try {
    const firstFixture = await createTopupFixture("failed");
    merchantIds.push(firstFixture.merchantId);
    const secondFixture = await createTopupFixture("unknown");
    merchantIds.push(secondFixture.merchantId);
    const input = {
      reference: firstFixture.reference,
      evidenceReference: " mpesa-123456 ",
      reason: "Verified successful receipt in M-Pesa records",
      idempotencyKey: `airtime-confirm-${randomUUID()}`,
      actor,
    };

    const reviewQueue = await listAdminAirtimeTopupsForReview();
    assert.doesNotThrow(() => ListAdminAirtimeTopupsForReviewResponse.parse(reviewQueue));
    assert.equal(reviewQueue.items.some((item) => item.reference === firstFixture.reference), true);

    await recordAirtimeTopupReconciliationFailure(secondFixture.reference, new Error("transport error"));
    const [diagnosticTopup] = await db.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, secondFixture.reference));
    assert.equal(diagnosticTopup?.lastError, "Payment status could not be confirmed. Greenpay will check again.");

    const [first, retry] = await Promise.all([
      confirmAdminAirtimeTopupCredit(input),
      confirmAdminAirtimeTopupCredit(input),
    ]);
    assert.equal(first.topupReference, firstFixture.reference);
    assert.equal(first.amount, 50);
    assert.equal(first.evidenceReference, "MPESA-123456");
    assert.equal(first.availableBalance, 60);
    assert.equal(first.reservedBalance, 7);
    assert.equal(retry.availableBalance, 60);
    assert.doesNotThrow(() => ConfirmAdminAirtimeTopupCreditResponse.parse(first));
    const refreshedRetry = await confirmAdminAirtimeTopupCredit({
      ...input,
      idempotencyKey: `airtime-confirm-${randomUUID()}`,
    });
    assert.equal(refreshedRetry.availableBalance, 60);

    const [wallet] = await db.select().from(airtimeWalletsTable)
      .where(eq(airtimeWalletsTable.merchantId, firstFixture.merchantId));
    assert.equal(wallet?.availableMinor, 6_000n);
    assert.equal(wallet?.reservedMinor, 700n);

    const entries = await db.select().from(airtimeWalletEntriesTable)
      .where(eq(airtimeWalletEntriesTable.reference, firstFixture.reference));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.availableDeltaMinor, 5_000n);
    assert.equal(entries[0]?.reservedDeltaMinor, 0n);
    assert.equal(entries[0]?.metadata.evidenceReference, "MPESA-123456");
    assert.equal(entries[0]?.metadata.actorUserId, actor);
    assert.equal(entries[0]?.metadata.previousStatus, "failed");

    const [topup] = await db.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, firstFixture.reference));
    assert.equal(topup?.status, "succeeded");
    assert.equal(topup?.lastError, null);

    const audits = await db.select().from(adminAuditLogTable).where(and(
      eq(adminAuditLogTable.actor, actor),
      eq(adminAuditLogTable.action, "airtime.admin_topup_confirmed"),
    ));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.target, `merchant:${firstFixture.merchantId}/airtime-wallet`);
    assert.deepEqual(JSON.parse(audits[0]?.details ?? "{}"), {
      topupReference: firstFixture.reference,
      evidenceReference: "MPESA-123456",
      previousStatus: "failed",
      amount: 50,
      reason: input.reason,
    });

    await assert.rejects(
      confirmAdminAirtimeTopupCredit({
        ...input,
        reason: "Changed reason for the same receipt",
        idempotencyKey: `airtime-confirm-${randomUUID()}`,
      }),
      /M-Pesa receipt has already been used/,
    );
    await assert.rejects(
      confirmAdminAirtimeTopupCredit({
        ...input,
        reference: secondFixture.reference,
        idempotencyKey: `airtime-confirm-${randomUUID()}`,
      }),
      /M-Pesa receipt has already been used/,
    );

    const [secondWallet] = await db.select().from(airtimeWalletsTable)
      .where(eq(airtimeWalletsTable.merchantId, secondFixture.merchantId));
    assert.equal(secondWallet?.availableMinor, 1_000n);
    assert.equal((await db.select().from(airtimeWalletEntriesTable)
      .where(eq(airtimeWalletEntriesTable.merchantId, secondFixture.merchantId))).length, 0);
    const finalQueue = await listAdminAirtimeTopupsForReview();
    assert.equal(finalQueue.items.some((item) => item.reference === firstFixture.reference), false);
    assert.equal(finalQueue.items.some((item) => item.reference === secondFixture.reference), true);
  } finally {
    await cleanupFixtures(merchantIds, [actor]);
  }
});
