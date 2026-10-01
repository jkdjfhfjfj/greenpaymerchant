import { createHash } from "node:crypto";

export const CUSTOMER_REIMBURSED_REFUND_STATUSES = ["success", "completed", "processed"] as const;
export const OPEN_REFUND_RESERVATION_STATUSES = ["pending", "manual_required", "recorded"] as const;
export const CONFIRMED_PAYOUT_STATUSES = ["success", "completed", "processed"] as const;

export function payoutConfirmationTimestamp(
  previousStatus: string,
  previousConfirmedAt: Date | null,
  nextStatus: string,
  confirmedAt = new Date(),
): Date | null {
  if (!CONFIRMED_PAYOUT_STATUSES.includes(nextStatus as never)) return previousConfirmedAt;
  if (CONFIRMED_PAYOUT_STATUSES.includes(previousStatus as never)) return previousConfirmedAt;
  return previousConfirmedAt ?? confirmedAt;
}

export function providerPaymentEvidenceMatches(input: {
  expectedReference: string;
  reportedReference: string | undefined;
  expectedAmount: number;
  reportedAmount: number | undefined;
  amountDivisor: number;
  expectedCurrency: string;
  reportedCurrency: string | undefined;
}): boolean {
  return Boolean(
    input.reportedReference &&
    input.reportedReference === input.expectedReference &&
    input.reportedAmount !== undefined &&
    input.reportedCurrency &&
    input.reportedCurrency.toUpperCase() === input.expectedCurrency.toUpperCase() &&
    Math.abs(input.reportedAmount / input.amountDivisor - input.expectedAmount) <= 0.011,
  );
}

export function paystackRefundOutcome(input: {
  status: string | undefined;
  reportedAmount: number | undefined;
  requestedAmount: number;
  reportedCurrency: string | undefined;
  expectedCurrency: string;
}): "success" | "failed" | "pending" {
  if (input.status === "processed" &&
      input.reportedAmount !== undefined &&
      input.reportedCurrency?.toUpperCase() === input.expectedCurrency.toUpperCase() &&
      Math.abs(input.reportedAmount / 100 - input.requestedAmount) <= 0.011) {
    return "success";
  }
  if (input.status === "failed" || input.status === "reversed") return "failed";
  return "pending";
}

export function idempotencyDisposition(input: {
  status: string;
  requestHashMatches: boolean;
  hasResponse: boolean;
  replayableStatuses?: readonly string[];
}): "mismatch" | "replay" | "in_flight" | "uncertain" {
  if (!input.requestHashMatches) return "mismatch";
  if (input.hasResponse && (input.replayableStatuses ?? ["completed"]).includes(input.status)) return "replay";
  return input.status === "in_flight" ? "in_flight" : "uncertain";
}

export function developerTransactionRequestFingerprint(input: {
  amount: number;
  currency: string;
  paymentMethod: "hosted_checkout" | "mobile_prompt";
  customerEmail: string;
  customerName?: string | null;
  customerPhone?: string | null;
  description?: string | null;
  paymentLinkId?: number | null;
}): string {
  const requestPayload = {
    amount: input.amount,
    currency: input.currency.trim().toUpperCase(),
    paymentMethod: input.paymentMethod,
    customerEmail: input.customerEmail.trim().toLowerCase(),
    customerName: input.customerName?.trim() ?? null,
    customerPhone: input.customerPhone?.trim() ?? null,
    description: input.description?.trim() ?? null,
    paymentLinkId: input.paymentLinkId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex");
}

export function remainingRefundableAmount(grossAmount: number, reimbursedAmount: number): number {
  return Math.max(0, Math.round((grossAmount - reimbursedAmount) * 100) / 100);
}