export function hasRequiredScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes(required);
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

export function paymentTransitionAllowed(current: string, next: string): boolean {
  return current === "pending" && ["success", "failed", "cancelled"].includes(next);
}

export function diditCanonicalStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const map: Record<string, string> = {
    approved: "approved", declined: "declined", "in review": "in_review",
    "in progress": "pending", "not started": "not_started", abandoned: "declined",
    expired: "expired", "kyc expired": "expired", resubmitted: "pending",
    "awaiting user": "in_review",
  };
  return map[value.toLowerCase()];
}