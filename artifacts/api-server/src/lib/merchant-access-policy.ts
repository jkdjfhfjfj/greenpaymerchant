export type MerchantPermission = "read" | "finance" | "owner";
export type MerchantTeamRole = "owner" | "finance" | "viewer";

/**
 * Persisted merchant capabilities. Missing legacy values intentionally mean
 * enabled so adding this layer preserves every previously available action.
 */
export const MERCHANT_ACTION_KEYS = [
  "collect",
  "createLinks",
  "refundRequests",
  "disputeRequests",
  "invoices",
  "reminders",
  "payoutRequests",
  "destinationChanges",
  "walletConversion",
  "teamManagement",
  "apiAccess",
] as const;
export type MerchantActionKey = typeof MERCHANT_ACTION_KEYS[number];
export type MerchantActionControls = Record<MerchantActionKey, boolean>;

export const DEFAULT_MERCHANT_ACTION_CONTROLS: MerchantActionControls = {
  collect: true,
  createLinks: true,
  refundRequests: true,
  disputeRequests: true,
  invoices: true,
  reminders: true,
  payoutRequests: true,
  destinationChanges: true,
  walletConversion: true,
  teamManagement: true,
  apiAccess: true,
};

export function normalizeMerchantActionControls(value: unknown): MerchantActionControls {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(MERCHANT_ACTION_KEYS.map((key) => [
    key, typeof record[key] === "boolean" ? record[key] as boolean : DEFAULT_MERCHANT_ACTION_CONTROLS[key],
  ])) as MerchantActionControls;
}

export function merchantActionRoleAllowed(role: MerchantTeamRole, action: MerchantActionKey): boolean {
  if (action === "teamManagement" || action === "apiAccess") {
    return role === "owner";
  }
  return role === "owner" || role === "finance";
}

export function merchantActionPolicyDenial(input: {
  action: MerchantActionKey;
  controls: unknown;
  merchant: {
    status: string;
    paymentsEnabled: boolean;
    payoutsEnabled: boolean;
    refundsEnabled: boolean;
    apiAccessEnabled: boolean;
  };
  platform: {
    paymentsEnabled: boolean;
    payoutsEnabled: boolean;
    refundsEnabled: boolean;
    apiAccessEnabled: boolean;
  };
}): string | undefined {
  if (input.merchant.status !== "active") return "This merchant account is not active.";
  if (!normalizeMerchantActionControls(input.controls)[input.action]) {
    return `This merchant has disabled ${input.action} actions.`;
  }
  const legacy: Partial<Record<MerchantActionKey, {
    merchant: "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled";
    platform: "paymentsEnabled" | "payoutsEnabled" | "refundsEnabled" | "apiAccessEnabled";
    label: string;
  }>> = {
    collect: { merchant: "paymentsEnabled", platform: "paymentsEnabled", label: "Payments" },
    createLinks: { merchant: "paymentsEnabled", platform: "paymentsEnabled", label: "Payments" },
    invoices: { merchant: "paymentsEnabled", platform: "paymentsEnabled", label: "Payments" },
    reminders: { merchant: "paymentsEnabled", platform: "paymentsEnabled", label: "Payments" },
    refundRequests: { merchant: "refundsEnabled", platform: "refundsEnabled", label: "Refunds" },
    disputeRequests: { merchant: "refundsEnabled", platform: "refundsEnabled", label: "Refunds" },
    payoutRequests: { merchant: "payoutsEnabled", platform: "payoutsEnabled", label: "Payouts" },
    destinationChanges: { merchant: "payoutsEnabled", platform: "payoutsEnabled", label: "Payouts" },
    apiAccess: { merchant: "apiAccessEnabled", platform: "apiAccessEnabled", label: "Developer API access" },
  };
  const prerequisite = legacy[input.action];
  if (!prerequisite) return undefined;
  if (!input.merchant[prerequisite.merchant]) return `${prerequisite.label} are disabled for this merchant.`;
  if (!input.platform[prerequisite.platform]) return `${prerequisite.label} are currently disabled.`;
  return undefined;
}

export type PayoutSafetySettings = {
  largePayoutThresholds: Record<string, number>;
  dualApprovalEnabled: boolean;
  destinationChangeRequiresDualApproval: true;
};

export const DEFAULT_PAYOUT_SAFETY_SETTINGS: PayoutSafetySettings = {
  // No threshold is inferred. The payout worker must manually hold amounts
  // for currencies which do not have an explicit threshold.
  largePayoutThresholds: {},
  dualApprovalEnabled: true,
  destinationChangeRequiresDualApproval: true,
};

export function normalizePayoutSafetySettings(value: unknown): PayoutSafetySettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawThresholds = record.largePayoutThresholds && typeof record.largePayoutThresholds === "object" &&
    !Array.isArray(record.largePayoutThresholds)
    ? record.largePayoutThresholds as Record<string, unknown>
    : {};
  const largePayoutThresholds: Record<string, number> = {};
  for (const [rawCurrency, rawAmount] of Object.entries(rawThresholds)) {
    const currency = rawCurrency.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(currency) && typeof rawAmount === "number" && Number.isFinite(rawAmount) && rawAmount > 0) {
      largePayoutThresholds[currency] = rawAmount;
    }
  }
  return {
    largePayoutThresholds,
    dualApprovalEnabled: typeof record.dualApprovalEnabled === "boolean"
      ? record.dualApprovalEnabled
      : DEFAULT_PAYOUT_SAFETY_SETTINGS.dualApprovalEnabled,
    // This is a mandated invariant and is never accepted from the setting.
    destinationChangeRequiresDualApproval: true,
  };
}

export function requiresManualPayoutReview(
  settings: PayoutSafetySettings,
  currency: string,
  amount: number,
): boolean {
  const threshold = settings.largePayoutThresholds[currency.toUpperCase()];
  return threshold === undefined || amount >= threshold;
}

export function roleCanAccess(role: MerchantTeamRole, permission: MerchantPermission): boolean {
  if (permission === "read") return role === "owner" || role === "finance" || role === "viewer";
  if (permission === "finance") return role === "owner" || role === "finance";
  return role === "owner";
}

export function invitationCanBeAccepted(input: {
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitationEmail: string;
  verifiedEmail: string;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  return input.acceptedAt === null &&
    input.revokedAt === null &&
    input.expiresAt.getTime() > now.getTime() &&
    input.invitationEmail.trim().toLowerCase() === input.verifiedEmail.trim().toLowerCase();
}

export function merchantTenantMatches(membershipMerchantId: number, requestedMerchantId: number): boolean {
  return Number.isInteger(requestedMerchantId) && requestedMerchantId > 0 &&
    membershipMerchantId === requestedMerchantId;
}

export function canAcceptWorkspaceInvitation(existingMerchantId: number | null): boolean {
  return existingMerchantId === null;
}