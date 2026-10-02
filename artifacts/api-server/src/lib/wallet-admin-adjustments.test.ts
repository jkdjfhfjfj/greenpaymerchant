import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminAuditLogTable,
  db,
  merchantWalletsTable,
  merchantsTable,
  pool,
  walletJournalEntriesTable,
  walletJournalsTable,
} from "@workspace/db";
import app from "../app";
import { adjustAdminWalletBalance } from "./wallet-service";

after(async () => {
  await pool.end();
});

async function createWalletFixture(availableMinor: bigint, reservedMinor: bigint) {
  const token = randomUUID();
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: `wallet-adjustment-test-${token}`,
    businessName: "Admin wallet adjustment fixture",
    country: "SL",
    baseCurrency: "USD",
    status: "active",
    kycStatus: "approved",
    kybStatus: "approved",
  }).returning();
  if (!merchant) throw new Error("Could not create the admin wallet adjustment merchant fixture.");
  await db.insert(merchantWalletsTable).values({
    merchantId: merchant.id,
    currency: "USD",
    availableMinor,
    reservedMinor,
  });
  return merchant.id;
}

async function cleanupWalletFixture(merchantId: number | undefined, actors: string[]) {
  if (merchantId !== undefined) {
    const journals = await db.select({ id: walletJournalsTable.id })
      .from(walletJournalsTable).where(eq(walletJournalsTable.merchantId, merchantId));
    const journalIds = journals.map(({ id }) => id);
    if (journalIds.length) {
      await db.delete(walletJournalEntriesTable)
        .where(inArray(walletJournalEntriesTable.journalId, journalIds));
      await db.delete(walletJournalsTable).where(inArray(walletJournalsTable.id, journalIds));
    }
    await db.delete(merchantWalletsTable).where(eq(merchantWalletsTable.merchantId, merchantId));
    await db.delete(merchantsTable).where(eq(merchantsTable.id, merchantId));
  }
  if (actors.length) {
    await db.delete(adminAuditLogTable).where(inArray(adminAuditLogTable.actor, actors));
  }
}

test("admin wallet adjustment retries post one balanced journal and changed data conflicts", async () => {
  let merchantId: number | undefined;
  const actor = `wallet-adjust-admin-${randomUUID()}`;
  try {
    merchantId = await createWalletFixture(10_000n, 2_200n);
    const input = {
      merchantId,
      currency: "usd",
      direction: "credit" as const,
      amount: 12.34,
      reason: "Corrected collection proceeds",
      idempotencyKey: `wallet-adjust-${randomUUID()}`,
      actor,
    };

    const first = await adjustAdminWalletBalance(input);
    const replay = await adjustAdminWalletBalance(input);
    assert.equal(replay.journalId, first.journalId);
    assert.equal(first.availableBalance, 112.34);
    assert.equal(replay.availableBalance, 112.34);
    assert.equal(first.reservedBalance, 22);

    await assert.rejects(
      adjustAdminWalletBalance({ ...input, amount: 13.34 }),
      /already used for a different wallet adjustment/,
    );

    const [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 11_234n);
    assert.equal(wallet?.reservedMinor, 2_200n);

    const journals = await db.select().from(walletJournalsTable).where(and(
      eq(walletJournalsTable.merchantId, merchantId),
      eq(walletJournalsTable.kind, "admin_adjustment"),
    ));
    assert.equal(journals.length, 1);
    const entries = await db.select().from(walletJournalEntriesTable)
      .where(eq(walletJournalEntriesTable.journalId, first.journalId));
    const debits = entries.filter((entry) => entry.direction === "debit")
      .reduce((total, entry) => total + entry.amountMinor, 0n);
    const credits = entries.filter((entry) => entry.direction === "credit")
      .reduce((total, entry) => total + entry.amountMinor, 0n);
    assert.equal(debits, 1_234n);
    assert.equal(credits, 1_234n);
    assert.equal(entries.some((entry) => entry.account === "merchant_reserved"), false);

    const audits = await db.select().from(adminAuditLogTable).where(and(
      eq(adminAuditLogTable.actor, actor),
      eq(adminAuditLogTable.action, "wallet.admin_adjustment_posted"),
    ));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.target, `merchant:${merchantId}/wallet:USD`);
    assert.deepEqual(JSON.parse(audits[0]?.details ?? "{}"), {
      journalId: first.journalId,
      reference: first.reference,
      direction: "credit",
      amount: 12.34,
      reason: "Corrected collection proceeds",
    });
  } finally {
    await cleanupWalletFixture(merchantId, [actor]);
  }
});

test("admin debits cannot consume reserved money and preserve reservations", async () => {
  let merchantId: number | undefined;
  const actor = `wallet-adjust-debit-admin-${randomUUID()}`;
  try {
    merchantId = await createWalletFixture(5_000n, 8_000n);
    const idempotencyKey = `wallet-debit-${randomUUID()}`;
    const input = {
      merchantId,
      currency: "USD",
      direction: "debit" as const,
      amount: 50.01,
      reason: "Reduce an incorrect credit",
      idempotencyKey,
      actor,
    };
    await assert.rejects(
      adjustAdminWalletBalance(input),
      /Available balance is insufficient; reserved funds cannot be debited/,
    );

    let [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 5_000n);
    assert.equal(wallet?.reservedMinor, 8_000n);
    assert.equal((await db.select().from(walletJournalsTable)
      .where(eq(walletJournalsTable.merchantId, merchantId))).length, 0);

    const result = await adjustAdminWalletBalance({ ...input, amount: 35.75 });
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(result.availableBalance, 14.25);
    assert.equal(wallet?.availableMinor, 1_425n);
    assert.equal(wallet?.reservedMinor, 8_000n);

    const journal = await db.select().from(walletJournalsTable)
      .where(eq(walletJournalsTable.id, result.journalId));
    const entries = await db.select().from(walletJournalEntriesTable)
      .where(eq(walletJournalEntriesTable.journalId, result.journalId));
    assert.equal(journal.length, 1);
    assert.equal(entries.some((entry) => entry.account === "merchant_reserved"), false);
    assert.equal(entries.reduce((total, entry) => total + (entry.direction === "debit" ? entry.amountMinor : 0n), 0n), 3_575n);
    assert.equal(entries.reduce((total, entry) => total + (entry.direction === "credit" ? entry.amountMinor : 0n), 0n), 3_575n);
  } finally {
    await cleanupWalletFixture(merchantId, [actor]);
  }
});

test("wallet balance, journal, and audit record roll back together when audit insertion fails", async () => {
  let merchantId: number | undefined;
  try {
    merchantId = await createWalletFixture(9_100n, 2_000n);
    const idempotencyKey = `wallet-rollback-${randomUUID()}`;
    await assert.rejects(adjustAdminWalletBalance({
      merchantId,
      currency: "USD",
      direction: "credit",
      amount: 4.25,
      reason: "Audit rollback fixture",
      idempotencyKey,
      actor: null as unknown as string,
    }));

    const [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 9_100n);
    assert.equal(wallet?.reservedMinor, 2_000n);
    assert.equal((await db.select().from(walletJournalsTable)
      .where(and(
        eq(walletJournalsTable.merchantId, merchantId),
        eq(walletJournalsTable.kind, "admin_adjustment"),
      ))).length, 0);
    assert.equal((await db.select().from(adminAuditLogTable)
      .where(eq(adminAuditLogTable.target, `merchant:${merchantId}/wallet:USD`))).length, 0);
  } finally {
    await cleanupWalletFixture(merchantId, []);
  }
});

test("admin wallet adjustment endpoint rejects requests without a signed-in platform admin", async () => {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test API server did not bind to a TCP port.");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/wallets`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in to access Greenpay operations." });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});