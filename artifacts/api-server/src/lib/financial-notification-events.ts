import { eq } from "drizzle-orm";
import {
  financialNotificationEventsTable,
} from "@workspace/db/schema";
import type { db } from "@workspace/db";

export type FinancialNotificationTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FinancialNotificationEventInput =
  | {
      kind: "payment";
      transactionId: number;
      reference: string;
      transition: "success" | "failed";
      amount: string | number;
      currency: string;
    }
  | {
      kind: "payout";
      payoutId: number;
      reference: string;
      previousStatus: string;
      status: string;
      amount: string | number;
      currency: string;
    }
  | {
      kind: "wallet_payout";
      walletPayoutRequestId: number;
      reference: string;
      previousStatus: string;
      status: string;
      amount: string | number;
      currency: string;
    };

export async function processFinancialNotificationAttempt<Event extends { id: number }>(
  event: Event,
  operations: {
    deliver: (event: Event) => Promise<void>;
    complete: (event: Event) => Promise<boolean>;
    scheduleRetry: (event: Event, error: unknown) => Promise<boolean>;
  },
): Promise<"processed" | "retried"> {
  try {
    await operations.deliver(event);
    if (!await operations.complete(event)) {
      throw new Error("Financial notification event lease was lost before completion could be recorded.");
    }
    return "processed";
  } catch (error) {
    if (!await operations.scheduleRetry(event, error)) {
      throw new Error("Financial notification event failed and its retry state could not be persisted.");
    }
    return "retried";
  }
}

export function financialPayoutTransitionIsCurrent(
  eventStatus: string,
  persistedStatus: string,
): boolean {
  return eventStatus === persistedStatus;
}

function normalizedAmount(value: string | number): string {
  const parts = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!parts) {
    throw new Error("Financial notification event amounts must be positive decimal strings with at most two fractional digits.");
  }
  const integer = parts[1].replace(/^0+(?=\d)/, "");
  const fraction = (parts[2] ?? "").padEnd(2, "0");
  if (integer.length > 16 || (integer === "0" && fraction === "00")) {
    throw new Error("Financial notification events require a positive amount within supported precision.");
  }
  return `${integer}.${fraction}`;
}

/**
 * Insert the minimal replayable notification source in the same DB transaction
 * as the financial status change. It stores no recipient data or credentials.
 */
export async function persistFinancialNotificationEvent(
  tx: FinancialNotificationTx,
  input: FinancialNotificationEventInput,
): Promise<void> {
  const reference = input.reference.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!reference || reference.length > 100 || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Financial notification events require a reference and three-letter currency.");
  }
  const amount = normalizedAmount(input.amount);
  let eventKey: string;
  let eventType: string;
  let transactionId: number | null = null;
  let payoutId: number | null = null;
  let walletPayoutRequestId: number | null = null;
  let previousStatus: string | null = null;
  let status: string;
  if (input.kind === "payment") {
    if (!Number.isSafeInteger(input.transactionId) || input.transactionId < 1) {
      throw new Error("Payment notification source requires a persisted transaction id.");
    }
    transactionId = input.transactionId;
    status = input.transition;
    eventType = input.transition === "success" ? "payment.success" : "payment.failed";
    eventKey = `financial:payment:${input.transactionId}:${input.transition}`;
  } else if (input.kind === "payout") {
    if (!Number.isSafeInteger(input.payoutId) || input.payoutId < 1 ||
      !input.previousStatus.trim() || !input.status.trim() ||
      input.previousStatus.length > 32 || input.status.length > 32 ||
      input.previousStatus === input.status) {
      throw new Error("Payout notification source requires an actual persisted status transition.");
    }
    payoutId = input.payoutId;
    previousStatus = input.previousStatus;
    status = input.status;
    eventType = "payout.transition";
    eventKey = `financial:payout:${input.payoutId}:${input.previousStatus}->${input.status}`;
  } else {
    if (!Number.isSafeInteger(input.walletPayoutRequestId) || input.walletPayoutRequestId < 1 ||
      !input.previousStatus.trim() || !input.status.trim() ||
      input.previousStatus.length > 32 || input.status.length > 32 ||
      input.previousStatus === input.status) {
      throw new Error("Wallet payout notification source requires an actual persisted status transition.");
    }
    walletPayoutRequestId = input.walletPayoutRequestId;
    previousStatus = input.previousStatus;
    status = input.status;
    eventType = "wallet_payout.transition";
    eventKey = `financial:wallet-payout:${input.walletPayoutRequestId}:${input.previousStatus}->${input.status}`;
  }
  const facts = {
    eventKey,
    eventType,
    transactionId,
    payoutId,
    walletPayoutRequestId,
    reference,
    previousStatus,
    status,
    amount,
    currency,
  };
  const [created] = await tx.insert(financialNotificationEventsTable).values(facts)
    .onConflictDoNothing({ target: financialNotificationEventsTable.eventKey }).returning();
  if (created) return;
  const [existing] = await tx.select().from(financialNotificationEventsTable)
    .where(eq(financialNotificationEventsTable.eventKey, eventKey)).limit(1);
  if (!existing || existing.eventType !== eventType || existing.transactionId !== transactionId ||
    existing.payoutId !== payoutId || existing.walletPayoutRequestId !== walletPayoutRequestId ||
    existing.reference !== reference ||
    existing.previousStatus !== previousStatus || existing.status !== status ||
    normalizedAmount(existing.amount) !== amount || existing.currency !== currency) {
    throw new Error("Financial notification event key was reused for different transition facts.");
  }
}