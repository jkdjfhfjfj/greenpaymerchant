import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray, like, or } from "drizzle-orm";
import {
  adminAuditLogTable,
  db,
  financialNotificationEventsTable,
  merchantCaseRefundsTable,
  merchantSupportCasesTable,
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
  walletPayoutDestinationsTable,
  walletPayoutDestinationVersionsTable,
  walletPayoutDestinationChangeRequestsTable,
  walletRefundAdjustmentsTable,
  walletSettlementConfirmationsTable,
  transactionalEmailOutboxTable,
  userNotificationsTable,
} from "@workspace/db";
import {
  confirmWalletSettlement,
  approveAndSubmitMerchantPayout,
  approveWalletPayoutDestinationChange,
  createMerchantWalletPayoutDestinationChange,
  createWalletPayoutRequest,
  rejectMerchantPayoutRequest,
  reconcileMerchantPayoutRequest,
  listMerchantWalletPayoutDestinations,
  quoteWalletConversion,
  recordMerchantPayoutProviderOutcome,
  reserveWalletRefundFunds,
  setWalletPayoutStatusFromProvider,
  settleWalletRefundFunds,
} from "./wallet-service";
import { recordManualCaseRefundEvidenceInTransaction } from "./manual-refund-evidence";

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
  caseIds?: number[];
}) {
  if (input.caseIds?.length) {
    await db.delete(merchantCaseRefundsTable).where(inArray(merchantCaseRefundsTable.caseId, input.caseIds));
    await db.delete(merchantSupportCasesTable).where(inArray(merchantSupportCasesTable.id, input.caseIds));
  }
  if (input.merchantId !== undefined) {
    const payouts = await db.select({
      id: walletPayoutRequestsTable.id,
      reference: walletPayoutRequestsTable.reference,
    }).from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.merchantId, input.merchantId));
    if (payouts.length) {
      await db.delete(financialNotificationEventsTable).where(inArray(
        financialNotificationEventsTable.walletPayoutRequestId,
        payouts.map(({ id }) => id),
      ));
      await db.delete(userNotificationsTable).where(or(
        ...payouts.map(({ reference }) => like(userNotificationsTable.eventKey, `wallet-payout:${reference}:%`)),
      ));
      await db.delete(transactionalEmailOutboxTable).where(or(
        ...payouts.map(({ reference }) => like(transactionalEmailOutboxTable.eventKey, `wallet-payout:${reference}:%`)),
      ));
    }
    await db.delete(walletPayoutDestinationChangeRequestsTable)
      .where(eq(walletPayoutDestinationChangeRequestsTable.merchantId, input.merchantId));
    await db.delete(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.merchantId, input.merchantId));
    const destinationRows = await db.select({ id: walletPayoutDestinationsTable.id })
      .from(walletPayoutDestinationsTable)
      .where(eq(walletPayoutDestinationsTable.merchantId, input.merchantId));
    const destinationIds = destinationRows.map(({ id }) => id);
    if (destinationIds.length) {
      await db.delete(walletPayoutDestinationVersionsTable)
        .where(inArray(walletPayoutDestinationVersionsTable.destinationId, destinationIds));
    }
    await db.delete(walletPayoutDestinationsTable)
      .where(eq(walletPayoutDestinationsTable.merchantId, input.merchantId));
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

async function createRefundCaseFixture(merchantId: number, transactionReference: string) {
  const [caseRow] = await db.insert(merchantSupportCasesTable).values({
    merchantId,
    kind: "refund",
    transactionReference,
    status: "requested",
    financialMovement: "requested",
    messages: [],
  }).returning();
  return caseRow!;
}

function manualRefundEvidenceInput(caseId: number, amount: number, token: string) {
  const providerReference = `manual-provider-${token}`;
  const evidenceReference = `manual-evidence-${token}`;
  const idempotencyKey = `manual-refund-${token}`;
  const note = "Provider refund independently confirmed.";
  const requestHash = createHash("sha256").update(JSON.stringify({
    amount, providerReference, evidenceReference, note,
  })).digest("hex");
  return {
    caseId, amount, providerReference, evidenceReference, idempotencyKey,
    requestHash, note, createdBy: `manual-refund-admin-${token}`,
  };
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
  const actors = [`wallet-payout-rejecter-${randomUUID()}`];
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
      notifyWalletPayoutTransition: async () => undefined,
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
    await recordMerchantPayoutProviderOutcome(uncertain.id, { status: "uncertain" }, dependencies);
    let [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.reservedMinor, 3_700n);
    assert.equal(wallet?.availableMinor, 6_300n);

    assert.equal(await setWalletPayoutStatusFromProvider("payzaapi", first.reference, "completed", dependencies), true);
    const [callbackCompleted] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, first.id));
    assert.equal(callbackCompleted?.providerReference, null, "the client reference must not be persisted as a provider reference");
    await recordMerchantPayoutProviderOutcome(first.id, {
      status: "processing",
      providerReference: "provider-reference-arrived-after-callback",
    }, dependencies);
    const [completed] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, first.id));
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerReference, "provider-reference-arrived-after-callback");
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.reservedMinor, 1_100n, "the uncertain payout hold remains reserved");
    assert.equal(wallet?.availableMinor, 6_300n);

    const rejectable = await createWalletPayoutRequest(merchant, {
      ...input,
      amount: 5,
      idempotencyKey: `wallet-reject-${randomUUID()}`,
    }, dependencies);
    const rejected = await rejectMerchantPayoutRequest(rejectable.id, actors[0]!, "fixture rejection");
    assert.equal(rejected.status, "rejected");
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.reservedMinor, 1_100n, "rejection releases only its own reservation");
    assert.equal(wallet?.availableMinor, 6_300n);

    const events = await db.select().from(financialNotificationEventsTable).where(inArray(
      financialNotificationEventsTable.walletPayoutRequestId,
      [first.id, uncertain.id, rejectable.id],
    ));
    const transitions = (requestId: number) => events
      .filter((event) => event.walletPayoutRequestId === requestId)
      .sort((a, b) => a.id - b.id)
      .map(({ previousStatus, status }) => [previousStatus, status]);
    assert.deepEqual(transitions(first.id), [["not_created", "requested"], ["requested", "completed"]]);
    assert.deepEqual(transitions(uncertain.id), [["not_created", "requested"], ["requested", "uncertain"]]);
    assert.deepEqual(transitions(rejectable.id), [["not_created", "requested"], ["requested", "rejected"]]);
  } finally {
    await restoreVerificationLimit?.();
    await cleanupFixture({
      merchantId,
      references: [],
      actors,
    });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("sensitive wallet payout requires two identities and submits its provider call exactly once after approval commits", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = `wallet-approval-fixture-${randomUUID()}`;
  let merchantId: number | undefined;
  let restoreVerificationLimit: (() => Promise<void>) | undefined;
  const actors = [`wallet-admin-first-${randomUUID()}`, `wallet-admin-second-${randomUUID()}`, `wallet-admin-racer-${randomUUID()}`];
  try {
    const merchant = await createMerchantFixture();
    merchantId = merchant.id;
    restoreVerificationLimit = await provisionPayoutVerificationLimit();
    await db.insert(merchantWalletsTable).values({
      merchantId, currency: "USD", availableMinor: 10_000n, reservedMinor: 0n,
    });
    const request = await createWalletPayoutRequest(merchant, {
      amount: 10,
      currency: "USD",
      method: "mobile",
      accountName: "Asha Wallet",
      accountNumber: "5551234567",
      idempotencyKey: `wallet-dual-${randomUUID()}`,
      requester: merchant.ownerClerkId,
    }, {
      assertPayoutsEnabled: async () => undefined,
      assertMerchantMayPayout: async () => undefined,
      providerIsConfigured: async () => true,
      payoutMethods: async () => payoutMethodsFixture,
      getPayoutSafetySettings: async () => ({
        largePayoutThresholds: { USD: 1_000 },
        dualApprovalEnabled: false,
        destinationChangeRequiresDualApproval: true,
      }),
      notifyWalletPayoutTransition: async () => undefined,
    });
    assert.equal(request.requiresSecondApproval, true, "a new unapproved destination requires a second reviewer even below threshold");
    await assert.rejects(
      approveAndSubmitMerchantPayout(request.id, merchant.ownerClerkId, request.destinationFingerprint!, {
        assertPayoutsEnabled: async () => undefined,
        notifyWalletPayoutTransition: async () => undefined,
      }),
      /requester cannot approve/,
    );

    const first = await approveAndSubmitMerchantPayout(request.id, actors[0]!, undefined, {
      assertPayoutsEnabled: async () => undefined,
      notifyWalletPayoutTransition: async () => undefined,
    });
    assert.equal(first.status, "awaiting_second_approval");
    await assert.rejects(
      approveAndSubmitMerchantPayout(request.id, actors[0]!, request.destinationFingerprint!, {
        assertPayoutsEnabled: async () => undefined,
      }),
      /different administrator/,
    );

    let providerCalls = 0;
    let releaseProvider!: () => void;
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const dependencies = {
      assertPayoutsEnabled: async () => undefined,
      providerIsConfigured: async () => true,
      notifyWalletPayoutTransition: async () => undefined,
      submitPayout: async () => {
        providerCalls += 1;
        signalProviderStarted();
        await providerGate;
        return { success: true, payout: { reference: "wallet-provider-ref", status: "processing" } };
      },
    };
    const approvedCall = approveAndSubmitMerchantPayout(
      request.id, actors[1]!, request.destinationFingerprint!, dependencies,
    );
    await providerStarted;
    await assert.rejects(
      approveAndSubmitMerchantPayout(request.id, actors[2]!, request.destinationFingerprint!, dependencies),
      /already been approved/,
    );
    assert.equal(providerCalls, 1);
    releaseProvider();
    const submitted = await approvedCall;
    assert.equal(submitted.status, "processing");
    assert.equal(providerCalls, 1, "the persisted approval claim prevents duplicate external submissions");

    const [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchant.id));
    assert.equal(wallet?.availableMinor, 8_900n);
    assert.equal(wallet?.reservedMinor, 1_100n, "uncertain/processing provider outcomes retain the full payout plus fee hold");
    const [stored] = await db.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, request.id));
    assert.equal(stored?.firstApprovedBy, actors[0]);
    assert.equal(stored?.secondApprovedBy, actors[1]);

    const reconciled = await reconcileMerchantPayoutRequest(request.id, {
      providerIsConfigured: async () => true,
      lookupPayout: async (reference) => {
        assert.equal(reference, "wallet-provider-ref");
        return { success: true, payout: { reference, status: "completed" } };
      },
    });
    assert.equal(reconciled.status, "completed");
    const transitions = await db.select().from(financialNotificationEventsTable)
      .where(eq(financialNotificationEventsTable.walletPayoutRequestId, request.id));
    assert.deepEqual(
      transitions.sort((a, b) => a.id - b.id).map(({ previousStatus, status }) => [previousStatus, status]),
      [
        ["not_created", "requested"],
        ["requested", "awaiting_second_approval"],
        ["awaiting_second_approval", "approved"],
        ["approved", "processing"],
        ["processing", "completed"],
      ],
    );
    const [completedWallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchant.id));
    assert.equal(completedWallet?.availableMinor, 8_900n);
    assert.equal(completedWallet?.reservedMinor, 0n);
  } finally {
    await restoreVerificationLimit?.();
    await cleanupFixture({ merchantId, references: [], actors });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("payout destination changes are immutable, masked, fingerprint-bound, and leave the old approved version live until second approval", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = `wallet-destination-fixture-${randomUUID()}`;
  let merchantId: number | undefined;
  const actors = [`wallet-destination-admin-one-${randomUUID()}`, `wallet-destination-admin-two-${randomUUID()}`];
  try {
    const merchant = await createMerchantFixture();
    merchantId = merchant.id;
    const initial = await createMerchantWalletPayoutDestinationChange(merchant, {
      label: "Operating account",
      currency: "USD",
      method: "mobile",
      accountName: "Asha Kallon",
      accountNumber: "555991234567",
      idempotencyKey: `destination-new-${randomUUID()}`,
      requester: merchant.ownerClerkId,
    });
    assert.equal(initial.status, "requested");
    assert.equal(initial.destination.accountName.includes("Asha Kallon"), false);
    assert.equal((await listMerchantWalletPayoutDestinations(merchant.id)).length, 0);
    const simultaneousReviews = await Promise.allSettled([
      approveWalletPayoutDestinationChange(initial.id, actors[0]!),
      approveWalletPayoutDestinationChange(initial.id, actors[1]!),
    ]);
    const successfulFirstReview = simultaneousReviews.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof approveWalletPayoutDestinationChange>>> =>
        result.status === "fulfilled",
    );
    assert.ok(successfulFirstReview, "one administrator records the first review while the competing stale action is rejected");
    assert.equal(simultaneousReviews.filter((result) => result.status === "fulfilled").length, 1);
    const first = successfulFirstReview.value;
    assert.equal(first.status, "first_approved");
    assert.equal((await listMerchantWalletPayoutDestinations(merchant.id)).length, 0);
    await assert.rejects(
      approveWalletPayoutDestinationChange(initial.id, first.firstApprovedBy!, initial.destinationFingerprint),
      /different administrator/,
    );
    const secondActor = actors.find((actor) => actor !== first.firstApprovedBy)!;
    await assert.rejects(
      approveWalletPayoutDestinationChange(initial.id, secondActor, "wrong-fingerprint"),
      /exact fingerprint/,
    );
    const approved = await approveWalletPayoutDestinationChange(
      initial.id, secondActor, initial.destinationFingerprint,
    );
    assert.equal(approved.status, "approved");
    const [oldDestination] = await listMerchantWalletPayoutDestinations(merchant.id);
    assert.equal(oldDestination?.version, 1);
    assert.equal(oldDestination?.maskedAccount.endsWith("4567"), true);
    assert.equal(JSON.stringify(oldDestination).includes("555991234567"), false);

    const changed = await createMerchantWalletPayoutDestinationChange(merchant, {
      destinationId: oldDestination!.id,
      label: "Updated operating account",
      currency: "USD",
      method: "mobile",
      accountName: "Asha New Beneficiary",
      accountNumber: "555998877665",
      idempotencyKey: `destination-change-${randomUUID()}`,
      requester: merchant.ownerClerkId,
    });
    await approveWalletPayoutDestinationChange(changed.id, actors[0]!);
    const stillOld = await listMerchantWalletPayoutDestinations(merchant.id);
    assert.equal(stillOld[0]?.version, 1, "first approval does not mutate the live destination");
    const updated = await approveWalletPayoutDestinationChange(
      changed.id, actors[1]!, changed.destinationFingerprint,
    );
    assert.equal(updated.status, "approved");
    const latest = await listMerchantWalletPayoutDestinations(merchant.id);
    assert.equal(latest[0]?.version, 2);
    assert.equal(latest[0]?.maskedAccount.endsWith("7665"), true);
    assert.equal(JSON.stringify(latest).includes("555998877665"), false);
    const versions = await db.select().from(walletPayoutDestinationVersionsTable)
      .where(eq(walletPayoutDestinationVersionsTable.destinationId, oldDestination!.id));
    assert.equal(versions.length, 2, "updates append a new version instead of overwriting the previously approved details");
    assert.equal(versions.find((version) => version.version === 1)?.fingerprint, oldDestination?.fingerprint);
    assert.equal(versions.find((version) => version.version === 2)?.fingerprint, changed.destinationFingerprint);
    const [changeRow] = await db.select().from(walletPayoutDestinationChangeRequestsTable)
      .where(eq(walletPayoutDestinationChangeRequestsTable.id, changed.id));
    assert.equal(changeRow?.accountName.includes("Asha New Beneficiary"), false, "only the encrypted account payload retains raw beneficiary details");
    assert.equal(changeRow?.encryptedDestination.includes("555998877665"), false);
  } finally {
    await cleanupFixture({ merchantId, references: [], actors });
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

test("manual refund evidence is wallet-accounted before and after funding and replay-safe", async () => {
  let merchantId: number | undefined;
  let caseId: number | undefined;
  const sourceReference = `manual-refund-funding-${randomUUID()}`;
  const replayKey = randomUUID();
  const actors = [`manual-refund-admin-${replayKey}`];
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
      customerEmail: "manual-refund-fixture@example.invalid",
      merchantId,
      paidAt: new Date(),
      settlementStatus: "pending",
    });
    await db.insert(settlementsTable).values({
      reference: sourceReference,
      provider: "payzaapi",
      amount: 100,
      netAmount: 80,
      currency: "USD",
      status: "pending",
      expectedAt: new Date(),
    });
    const caseRow = await createRefundCaseFixture(merchantId, sourceReference);
    caseId = caseRow.id;
    const firstInput = manualRefundEvidenceInput(caseId, 40, replayKey);

    const first = await db.transaction((tx) => recordManualCaseRefundEvidenceInTransaction(tx, firstInput));
    assert.equal(first.replayed, false);
    assert.equal(first.refund.status, "processed");
    let [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet, undefined, "a pre-funding refund is recorded without prematurely crediting a wallet");

    const replay = await db.transaction((tx) => recordManualCaseRefundEvidenceInTransaction(tx, firstInput));
    assert.equal(replay.replayed, true);
    assert.equal(replay.refund.id, first.refund.id, "idempotent replay returns the original confirmed refund");
    const refundRows = await db.select({ id: refundsTable.id }).from(refundsTable)
      .where(eq(refundsTable.originalReference, sourceReference));
    assert.equal(refundRows.length, 1, "replay must not create a second refund reservation");

    const funding = await confirmWalletSettlement({
      settlementReference: sourceReference,
      evidenceReference: `funding-evidence-${replayKey}`,
      actor: actors[0]!,
    });
    assert.equal(funding.fundedAmount, 48, "pre-funding refund reduces subsequent settlement funding proportionally");

    const completionInput = manualRefundEvidenceInput(caseId, 60, `${replayKey}-complete`);
    const completed = await db.transaction((tx) => recordManualCaseRefundEvidenceInTransaction(tx, completionInput));
    assert.equal(completed.refund.status, "processed");
    const [transaction] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, sourceReference));
    assert.equal(transaction?.status, "refunded", "a full manual refund uses the normal transaction-refunded transition");
    [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 0n);
    assert.equal(wallet?.reservedMinor, 0n);
    const adjustments = await db.select().from(walletRefundAdjustmentsTable)
      .where(eq(walletRefundAdjustmentsTable.merchantId, merchantId));
    assert.equal(adjustments.reduce((sum, row) => sum + row.amountMinor, 0n), 4_800n);
    assert.ok(adjustments.every((row) => row.status === "committed"));
  } finally {
    await cleanupFixture({ merchantId, caseIds: caseId ? [caseId] : [], references: [sourceReference], actors });
  }
});

test("manual refund after wallet funding fails atomically when proceeds were spent", async () => {
  let merchantId: number | undefined;
  let caseId: number | undefined;
  const sourceReference = `manual-refund-insufficient-${randomUUID()}`;
  const token = randomUUID();
  const actors = [`manual-refund-admin-${token}`];
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
      customerEmail: "manual-refund-insufficient@example.invalid",
      merchantId,
      paidAt: new Date(),
      settlementStatus: "pending",
    });
    await db.insert(settlementsTable).values({
      reference: sourceReference,
      provider: "payzaapi",
      amount: 100,
      netAmount: 80,
      currency: "USD",
      status: "pending",
      expectedAt: new Date(),
    });
    const caseRow = await createRefundCaseFixture(merchantId, sourceReference);
    caseId = caseRow.id;
    await confirmWalletSettlement({
      settlementReference: sourceReference,
      evidenceReference: `funding-evidence-${token}`,
      actor: actors[0]!,
    });

    await db.transaction(async (tx) => {
      const [wallet] = await tx.select().from(merchantWalletsTable)
        .where(eq(merchantWalletsTable.merchantId, merchantId!)).for("update").limit(1);
      assert.equal(wallet?.availableMinor, 8_000n);
      const [spend] = await tx.insert(walletJournalsTable).values({
        merchantId: merchantId!,
        currency: "USD",
        kind: "test_payout",
        reference: `fixture-spend:${sourceReference}`,
        sourceReference,
        evidenceReference: `spend-evidence-${token}`,
        idempotencyKey: `fixture-spend:${sourceReference}`,
        requestHash: createHash("sha256").update(sourceReference).digest("hex"),
        metadata: { fixture: true },
      }).returning();
      await tx.insert(walletJournalEntriesTable).values([
        { journalId: spend!.id, merchantId: merchantId!, currency: "USD", account: "merchant_available", direction: "debit", amountMinor: 8_000n },
        { journalId: spend!.id, merchantId: null, currency: "USD", account: "external_account", direction: "credit", amountMinor: 8_000n },
      ]);
      await tx.update(merchantWalletsTable).set({ availableMinor: 0n, updatedAt: new Date() })
        .where(eq(merchantWalletsTable.id, wallet!.id));
    });

    const request = manualRefundEvidenceInput(caseId, 25, token);
    await assert.rejects(
      db.transaction((tx) => recordManualCaseRefundEvidenceInTransaction(tx, request)),
      /Refund cannot be recorded because wallet-funded proceeds/,
    );
    const [transaction] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, sourceReference));
    assert.equal(transaction?.status, "success", "failed wallet reservation must not mark the transaction refunded");
    const refundRows = await db.select({ id: refundsTable.id }).from(refundsTable)
      .where(eq(refundsTable.originalReference, sourceReference));
    assert.equal(refundRows.length, 0, "failed accounting must roll back the pending and confirmed refund rows");
    const [storedCase] = await db.select().from(merchantSupportCasesTable)
      .where(eq(merchantSupportCasesTable.id, caseId));
    assert.equal(storedCase?.financialMovement, "requested");
    const [wallet] = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(wallet?.availableMinor, 0n);
    assert.equal(wallet?.reservedMinor, 0n);
    const adjustments = await db.select().from(walletRefundAdjustmentsTable)
      .where(eq(walletRefundAdjustmentsTable.merchantId, merchantId));
    assert.equal(adjustments.length, 0);
  } finally {
    await cleanupFixture({ merchantId, caseIds: caseId ? [caseId] : [], references: [sourceReference], actors });
  }
});