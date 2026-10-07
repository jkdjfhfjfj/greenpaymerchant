export function hasRequiredScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes(required);
}

export function apiKeyEnvironmentAllowed(actual: string | undefined, expected: "live" | "sandbox"): boolean {
  return actual === expected;
}

export function ownsMerchantRecord(recordMerchantId: number | null | undefined, authenticatedMerchantId: number): boolean {
  return recordMerchantId !== null && recordMerchantId !== undefined &&
    Number.isInteger(authenticatedMerchantId) && authenticatedMerchantId > 0 &&
    recordMerchantId === authenticatedMerchantId;
}

export function featureIsEnabled(settings: Record<string, boolean>, flag: string): boolean {
  return settings[flag] === true;
}

export function merchantCapabilityIsEnabled(
  merchant: Record<string, unknown>,
  flag: string,
): boolean {
  return merchant[flag] === true;
}

export function timestampIsFresh(value: string | undefined, now = Date.now(), maxAgeMs = 300_000): boolean {
  if (!value || !/^\d{10,13}$/.test(value)) return false;
  const parsed = Number(value);
  const milliseconds = value.length === 10 ? parsed * 1000 : parsed;
  return Math.abs(now - milliseconds) <= maxAgeMs;
}

export function developerApiStatusAllowed(status: string): boolean {
  return status === "active";
}

export type VerificationTier = "unverified" | "kyc" | "kyb";
export type VerificationAction = "collection" | "payout" | "conversion";

export function merchantVerificationTier(kycStatus: string, kybStatus: string): VerificationTier {
  if (kycStatus === "approved" && kybStatus === "approved") return "kyb";
  if (kycStatus === "approved") return "kyc";
  return "unverified";
}

export function verificationLimitError(input: {
  action: VerificationAction;
  amount: number;
  currency: string;
  currentDailyVolume?: number;
  currentMonthlyVolume?: number;
  collectionPerTransactionLimit: number | null;
  collectionDailyLimit: number | null;
  collectionMonthlyLimit: number | null;
  payoutLimit: number | null;
  conversionLimit: number | null;
}): string | undefined {
  const {
    action, amount, currency, currentDailyVolume = 0, currentMonthlyVolume = 0,
  } = input;
  const checkLimit = (value: number | null, requested: number, label: string) =>
    value !== null && requested > value + 0.000001
      ? `The ${label} verification limit is ${value} ${currency}.`
      : undefined;
  if (action === "collection") {
    return checkLimit(input.collectionPerTransactionLimit, amount, "per-collection") ??
      checkLimit(input.collectionDailyLimit, currentDailyVolume + amount, "daily collection") ??
      checkLimit(input.collectionMonthlyLimit, currentMonthlyVolume + amount, "monthly collection");
  }
  return action === "payout"
    ? checkLimit(input.payoutLimit, amount, "payout")
    : checkLimit(input.conversionLimit, amount, "conversion");
}

export function paymentTransitionAllowed(current: string, next: string): boolean {
  return current === "pending" && ["success", "failed", "cancelled"].includes(next);
}

export function diditCanonicalStatus(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const status = value.trim().toLowerCase().replaceAll("_", " ");
  const map: Record<string, string> = {
    approved: "approved", declined: "declined", "in review": "in_review",
    "in progress": "pending", "not started": "not_started", abandoned: "expired",
    expired: "expired", "kyc expired": "expired", resubmitted: "pending",
    "awaiting user": "in_review",
  };
  return map[status];
}

export function diditDecisionStatus(
  response: unknown,
  expectedSessionId: string,
): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const envelope = response as Record<string, unknown>;
  if (envelope.session_id !== expectedSessionId) return undefined;

  const decision = envelope.decision && typeof envelope.decision === "object" && !Array.isArray(envelope.decision)
    ? envelope.decision as Record<string, unknown>
    : undefined;
  const topLevelStatus = typeof envelope.status === "string" ? envelope.status : undefined;
  const decisionStatus = typeof decision?.status === "string" ? decision.status : undefined;

  // Didit's v3 endpoint reports its authoritative session status at the top level.
  return diditCanonicalStatus(topLevelStatus) ?? diditCanonicalStatus(decisionStatus);
}

export function diditStatusNeedsRefresh(status: string | undefined, sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && status && ["not_started", "pending", "in_review"].includes(status));
}