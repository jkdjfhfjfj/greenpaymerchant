import assert from "node:assert/strict";
import test from "node:test";
import {
  financialPayoutTransitionIsCurrent,
  persistFinancialNotificationEvent,
  processFinancialNotificationAttempt,
  type FinancialNotificationTx,
} from "./financial-notification-events";

type StoredSourceEvent = {
  eventKey: string;
  eventType: string;
  transactionId: number | null;
  payoutId: number | null;
  walletPayoutRequestId: number | null;
  reference: string;
  previousStatus: string | null;
  status: string;
  amount: string;
  currency: string;
};

function memoryTransactionStore() {
  const rows = new Map<string, StoredSourceEvent>();

  async function transaction<T>(
    work: (tx: FinancialNotificationTx) => Promise<T>,
    options: { failAfterInsert?: boolean } = {},
  ): Promise<T> {
    const staged: StoredSourceEvent[] = [];
    let lastEventKey = "";
    const tx = {
      insert: () => ({
        values: (row: StoredSourceEvent) => {
          lastEventKey = row.eventKey;
          return {
            onConflictDoNothing: () => ({
              returning: async () => {
                if (rows.has(row.eventKey) || staged.some((item) => item.eventKey === row.eventKey)) return [];
                staged.push(row);
                if (options.failAfterInsert) throw new Error("simulated transactional insert failure");
                return [row];
              },
            }),
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const row = rows.get(lastEventKey) ?? staged.find((item) => item.eventKey === lastEventKey);
              return row ? [row] : [];
            },
          }),
        }),
      }),
    };
    try {
      const result = await work(tx as unknown as FinancialNotificationTx);
      for (const row of staged) rows.set(row.eventKey, row);
      return result;
    } catch (error) {
      // A real transaction rolls back all staged writes when its callback fails.
      staged.length = 0;
      throw error;
    }
  }

  return { rows, transaction };
}

const paymentEvent = {
  kind: "payment" as const,
  transactionId: 42,
  reference: "GP-PAY-42",
  transition: "success" as const,
  amount: "120.50",
  currency: "sll",
};

test("financial event rolls back with its enclosing financial transaction", async () => {
  const store = memoryTransactionStore();
  await assert.rejects(store.transaction(async (tx) => {
    await persistFinancialNotificationEvent(tx, paymentEvent);
    throw new Error("financial transaction rolled back");
  }), /financial transaction rolled back/);
  assert.equal(store.rows.size, 0);
});

test("financial event replay is deduplicated and rejects reused keys with different facts", async () => {
  const store = memoryTransactionStore();
  await store.transaction((tx) => persistFinancialNotificationEvent(tx, paymentEvent));
  await store.transaction((tx) => persistFinancialNotificationEvent(tx, paymentEvent));
  assert.equal(store.rows.size, 1);
  const [saved] = store.rows.values();
  assert.equal(saved.eventKey, "financial:payment:42:success");
  assert.equal(saved.amount, "120.50");
  assert.equal(saved.currency, "SLL");
  assert.equal("accountNumber" in saved, false);
  assert.equal("token" in saved, false);
  await assert.rejects(
    store.transaction((tx) => persistFinancialNotificationEvent(tx, { ...paymentEvent, amount: "121.00" })),
    /reused for different transition facts/,
  );
  assert.equal(store.rows.size, 1);
});

test("an insert failure leaves no financial source event committed", async () => {
  const store = memoryTransactionStore();
  await assert.rejects(
    store.transaction((tx) => persistFinancialNotificationEvent(tx, paymentEvent), { failAfterInsert: true }),
    /simulated transactional insert failure/,
  );
  assert.equal(store.rows.size, 0);
});

test("wallet payout events have a distinct source id and exact decimal facts", async () => {
  const store = memoryTransactionStore();
  await store.transaction((tx) => persistFinancialNotificationEvent(tx, {
    kind: "wallet_payout",
    walletPayoutRequestId: 7,
    reference: "GP-WALLET-7",
    previousStatus: "processing",
    status: "completed",
    amount: "900719925474099.12",
    currency: "SLL",
  }));
  const [saved] = store.rows.values();
  assert.equal(saved.eventType, "wallet_payout.transition");
  assert.equal(saved.payoutId, null);
  assert.equal(saved.walletPayoutRequestId, 7);
  assert.equal(saved.eventKey, "financial:wallet-payout:7:processing->completed");
  assert.equal(saved.amount, "900719925474099.12");
  await assert.rejects(store.transaction((tx) => persistFinancialNotificationEvent(tx, {
    kind: "payment",
    transactionId: 43,
    reference: "GP-PAY-43",
    transition: "success",
    amount: 0.1 + 0.2,
    currency: "SLL",
  })), /at most two fractional digits/);
});

test("recipient lookup failure is persisted for retry and later recovery completes the event", async () => {
  const event = { id: 9, attempts: 1 };
  let state = "processing";
  let completed = false;
  let lookupAvailable = false;
  let retries = 0;
  const process = () => processFinancialNotificationAttempt(event, {
    deliver: async () => {
      if (!lookupAvailable) throw new Error("Clerk recipient lookup failed");
    },
    complete: async () => {
      completed = true;
      state = "processed";
      return true;
    },
    scheduleRetry: async (_claimed, error) => {
      retries += 1;
      state = "queued";
      assert.match(String(error), /Clerk recipient lookup failed/);
      return true;
    },
  });

  assert.equal(await process(), "retried");
  assert.equal(state, "queued");
  assert.equal(completed, false);
  lookupAvailable = true;
  state = "processing";
  assert.equal(await process(), "processed");
  assert.equal(state, "processed");
  assert.equal(completed, true);
  assert.equal(retries, 1);
});

test("replay after partial side effects reuses deterministic in-app and email dedupe keys", async () => {
  const event = { id: 11, attempts: 1 };
  const inApp = new Set<string>();
  const emailOutbox = new Set<string>();
  let completed = false;
  let firstAttempt = true;
  const process = () => processFinancialNotificationAttempt(event, {
    deliver: async () => {
      inApp.add("payment:GP-PAY-42:success");
      emailOutbox.add("payment:GP-PAY-42:customer-receipt");
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("simulated worker interruption after enqueue");
      }
    },
    complete: async () => { completed = true; return true; },
    scheduleRetry: async () => true,
  });

  assert.equal(await process(), "retried");
  assert.equal(completed, false);
  assert.equal(await process(), "processed");
  assert.equal(completed, true);
  assert.equal(inApp.size, 1);
  assert.equal(emailOutbox.size, 1);
});

test("a superseded payout transition completes without announcing stale status", async () => {
  const event = { id: 12 };
  let state = "processing";
  let announced = false;
  const outcome = await processFinancialNotificationAttempt(event, {
    deliver: async () => {
      if (financialPayoutTransitionIsCurrent("processing", "completed")) announced = true;
    },
    complete: async () => { state = "processed"; return true; },
    scheduleRetry: async () => { state = "queued"; return true; },
  });
  assert.equal(outcome, "processed");
  assert.equal(state, "processed");
  assert.equal(announced, false);
});