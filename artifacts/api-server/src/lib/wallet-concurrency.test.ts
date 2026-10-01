import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminAuditLogTable,
  db,
  merchantWalletsTable,
  merchantsTable,
  pool,
  refundsTable,
  settlementsTable,
  transactionsTable,
  verificationTierLimitsTable,
  walletJournalEntriesTable,
  walletJournalsTable,
  walletPayoutRequestsTable,
  walletRefundAdjustmentsTable,
  walletSettlementConfirmationsTable,
} from "@workspace/db";
import {
  confirmWalletSettlement,
  createWalletPayoutRequest,
  quoteWalletConversion,
  recordMerchantPayoutProviderOutcome,
  reserveWalletRefundFunds,
  setWalletPayoutStatusFromProvider,
  settleWalletRefundFunds,
} from "./wallet-service";

after(async () => {
  await pool.end();
});

async function createMerchantFixture() {
  const token = randomUUID();
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: `wallet-test-${token}`,
    businessName: "Wallet concurrency fixture",
    country: "SL",
    baseCurrency: "USD",
    status: "active",
    kycStatus: "approved",
    kybStatus: "approved",
  }).returning();
  return merchant!;
}

async function cleanupFixture(input: {
  merchantId?: number;
  references: string[];
  actors: string[];
}) {
  if (input.merchantId !== undefined) {
    await db.delete(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.merchantId, input.merchantId));
    await db.delete(walletRefundAdjustmentsTable)
      .where(eq(walletRefundAdjustmentsTable.merchantId, input.merchantId));
    await db.delete(walletSettlementConfirmationsTable)
      .where(eq(walletSettlementConfirmationsTable.merchantId, input.merchantId));
    const journals = await db.select({ id: walletJournalsTable.id }).from(walletJournalsTable)
      .where(eq(walletJournalsTable.merchantId, input.merchantId));
    const journalIds = journals.map(({ id }) => id);
    if (journalIds.length) {
      await db.delete(walletJournalEntriesTable)
        .where(inArray(walletJournalEntriesTable.journalId, journalIds));
    }
    await db.delete(walletJournalsTable).where(eq(walletJournalsTable.merchantId, input.merchantId));
    await db.delete(merchantWalletsTable).where(eq(merchantWalletsTable.merchantId, input.merchantId));
  }
  if (input.references.length) {
    await db.delete(refundsTable).where(inArray(refundsTable.originalReference, input.references));
    await db.delete(settlementsTable).where(inArray(settlementsTable.reference, input.references));
    await db.delete(transactionsTable).where(inArray(transactionsTable.reference, input.references));
  }
  if (input.actors.length) {
    await db.delete(adminAuditLogTable).where(inArray(adminAuditLogTable.actor, input.actors));
  }
  if (input.merchantId !== undefined) {
    await db.delete(merchantsTable).where(eq(merchantsTable.id, input.merchantId));
  }
}

async function provisionPayoutVerificationLimit(): Promise<() => Promise<void>> {
  const [existingUsd] = await db.select().from(verificationTierLimitsTable).where(and(
    eq(verificationTierLimitsTable.tier, "kyb"),
    eq(verificationTierLimitsTable.currency, "USD"),
  )).limit(1);
  if (existingUsd) {
    if (existingUsd.payoutLimit !== null && existingUsd.payoutLimit >= 100) return async () => undefined;
    await db.update(verificationTierLimitsTable)
      .set({ payoutLimit: 100_000 })
      .where(eq(verificationTierLimitsTable.id, existingUsd.id));
    return async () => {
      await db.update(verificationTierLimitsTable)
        .set({ payoutLimit: existingUsd.payoutLimit })
        .where(eq(verificationTierLimitsTable.id, existingUsd.id));
    };
  }
  const [created] = await db.insert(verificationTierLimitsTable).values({
    tier: "kyb", currency: "USD", payoutLimit: 100_000,
  }).onConflictDoNothing().returning();
  if (!created) {
    const [raceWinner] = await db.select().from(verificationTierLimitsTable).where(and(
      eq(verificationTierLimitsTable.tier, "kyb"),
      eq(verificationTierLimitsTable.currency, "USD"),
    )).limit(1);
    if (!raceWinner) throw new Error("Unable to create a verification-limit test fixture.");
    return async () => undefined;
  }
  return async () => {
    await db.delete(verificationTierLimitsTable)
      .where(eq(verificationTierLimitsTable.id, created.id));
  };
}

const payoutMethodsFixture = {
  currency: "USD",
  available: true,
  minimumWithdrawal: 1,
  fee: { type: "flat" as const, amount: 1, percent: null, floor: null },
  methods: [{ value: "mobile", label: "Mobile wallet", requiresBankFields: false }],
};

test("legacy SLL amount units are never inferred from SLE FX rates", async () => {
  await assert.rejects(
    quoteWalletConversion(1, { amount: 10, fromCurrency: "SLL", toCurrency: "USD" }),
    /legacy SLL amount scale is verified.*never substitutes SLE rates/,
  );
});

test("wallet payout idempotency serializes reservations, replays before provider reads, and honors an early client-reference callback", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = `wallet-fixture-${randomUUID()}`;
  let merchantId: number | undefined;
  let restoreVerificationLimit: (() => Promise<void>) | undefined;
  try {
    const merchant = await createMerchantFixture();
    merchantId = merchant.id;
    restoreVerificationLimit = await provisionPayoutVerificationLimit();
    await db.insert(merchantWalletsTable).values({
      merchantId, currency: "USD", availableMinor: 10_000n, reservedMinor: 0n,
    });
    let methodCalls = 0;
    let releaseMethods!: () => void;
    const methodsGate = new Promise<void>((resolve) => { releaseMethods = resolve; });
    const dependencies = {
      assertPayoutsEnabled: async () => undefined,
      assertMerchantMayPayout: async () => undefined,
      providerIsConfigured: async () => true,
      payoutMethods: async () => {
        methodCalls += 1;
        if (methodCalls === 2) releaseMethods();
        await methodsGate;
        return payoutMethodsFixture;
      },
    };
    const idempotencyKey = `wallet-payout-${randomUUID()}`;
    const input = {
      amount: 25,
      currency: "usd",
      method: "mobile",
      accountName: "  Alice   Merchant ",
      accountNumber: "123 45 6789",
      idempotencyKey,
    };
    const [first, racing] = await Promise.all([
      createWalletPayoutRequest(merchant, input, dependencies),
      createWalletPayoutRequest(merchant, input, dependencies),
    ]);
    assert.equal(first.id, racing.id);
    assert.equal(methodCalls, 2, "concurrent first attempts may both read methods, but must reserve one request");
    const [stored] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, first.id));
    assert.equal(stored?.status, "requested");

    const callsBeforeReplay = methodCalls;
    const replay = await createWalletPayoutRequest(merchant, {
      ...input,
      accountName: "Alice Merchant",
      accountNumber: "123456789",
      currency: "USD",
    }, {
      ...dependencies,
      payoutMethods: async () => {
        throw new Error("idempotent replay must not read live payout methods");
      },
    });
    assert.equal(replay.id, first.id);
    assert.equal(methodCalls, callsBeforeReplay);
    await assert.rejects(
      createWalletPayoutRequest(merchant, { ...input, amount: 26 }, {
        ...dependencies,
        payoutMethods: async () => {
          throw new Error("mismatched replay must fail before provider reads");
        },
      }),
      /already used with different payout details/,
    );
    assert.equal(methodCalls, callsBeforeReplay);

    const uncertain = await createWalletPayoutRequest(merchant, {
      ...input,
      amount: 10,
      idempotencyKey: `wallet-payout-${randomUUID()}`,
    }, dependencies);
    await recordMerchantPayoutProviderOutcome(uncertain.id, { status: "uncertain" });
    let [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.reservedMinor, 3_700n);
    assert.equal(wallet?.availableMinor, 6_300n);

    assert.equal(await setWalletPayoutStatusFromProvider("payzaapi", first.reference, "completed"), true);
    const [callbackCompleted] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, first.id));
    assert.equal(callbackCompleted?.providerReference, null, "the client reference must not be persisted as a provider reference");
    await recordMerchantPayoutProviderOutcome(first.id, {
      status: "processing",
      providerReference: "provider-reference-arrived-after-callback",
    });
    const [completed] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, first.id));
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerReference, "provider-reference-arrived-after-callback");
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.reservedMinor, 1_100n, "the uncertain payout hold remains reserved");
    assert.equal(wallet?.availableMinor, 6_300n);
  } finally {
    await restoreVerificationLimit?.();
    await cleanupFixture({
      merchantId,
      references: [],
      actors: [],
    });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("settlement funding blocks unresolved refunds and uses proportional net reversals before and after funding", async () => {
  let merchantId: number | undefined;
  const sourceReference = `wallet-refund-${randomUUID()}`;
  const actors = [`wallet-test-settlement-${randomUUID()}`];
  try {
    const merchant = await createMerchantFixture();
    merchantId = merchant.id;
    await db.insert(transactionsTable).values({
      reference: sourceReference,
      provider: "payzaapi",
      amount: 100,
      fee: 20,
      netAmount: 80,
      platformNetAmount: 80,
      currency: "USD",
      status: "success",
      customerEmail: "wallet-fixture@example.invalid",
      merchantId,
      settlementStatus: "pending",
    });
    await db.insert(settlementsTable).values({
      reference: sourceReference,
      provider: "payzaapi",
      amount: 100,
      netAmount: 100,
      currency: "USD",
      status: "pending",
      expectedAt: new Date(),
    });
    const [preFundingRefund] = await db.insert(refundsTable).values({
      reference: `wallet-refund-request-${randomUUID()}`,
      originalReference: sourceReference,
      provider: "payzaapi",
      amount: 10,
      currency: "USD",
      status: "recorded",
    }).returning();
    await assert.rejects(
      confirmWalletSettlement({
        settlementReference: sourceReference,
        evidenceReference: `evidence-${randomUUID()}`,
        actor: actors[0]!,
      }),
      /pending or unresolved customer refund/,
    );
    const [unfundedWallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(unfundedWallet, undefined, "an unconfirmed recorded refund must block funding before wallet credit");

    await db.update(refundsTable).set({ status: "success" })
      .where(eq(refundsTable.id, preFundingRefund!.id));
    const confirmation = await confirmWalletSettlement({
      settlementReference: sourceReference,
      evidenceReference: `evidence-${randomUUID()}`,
      actor: actors[0]!,
    });
    assert.equal(confirmation.fundedAmount, 72);
    let [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 7_200n, "pre-funding refund reverses 10% of the eligible net, not its gross amount");

    const [postFundingRefund] = await db.insert(refundsTable).values({
      reference: `wallet-refund-request-${randomUUID()}`,
      originalReference: sourceReference,
      provider: "payzaapi",
      amount: 10,
      currency: "USD",
      status: "recorded",
    }).returning();
    await db.transaction(async (tx) => {
      const [transaction] = await tx.select().from(transactionsTable)
        .where(eq(transactionsTable.reference, sourceReference)).for("update").limit(1);
      await reserveWalletRefundFunds(tx, transaction!, postFundingRefund!);
    });
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 6_400n);
    assert.equal(wallet?.reservedMinor, 800n, "post-funding refund reverses only the incremental proportional net exposure");

    const [processedRefund] = await db.update(refundsTable).set({ status: "success" })
      .where(eq(refundsTable.id, postFundingRefund!.id)).returning();
    await db.transaction(async (tx) => {
      const [transaction] = await tx.select().from(transactionsTable)
        .where(eq(transactionsTable.reference, sourceReference)).for("update").limit(1);
      await settleWalletRefundFunds(tx, transaction!, processedRefund!);
    });
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 6_400n);
    assert.equal(wallet?.reservedMinor, 0n);
    const [adjustment] = await db.select().from(walletRefundAdjustmentsTable)
      .where(eq(walletRefundAdjustmentsTable.refundReference, postFundingRefund!.reference));
    assert.equal(adjustment?.amountMinor, 800n);
    assert.equal(adjustment?.status, "committed");
  } finally {
    await cleanupFixture({ merchantId, references: [sourceReference], actors });
  }
});