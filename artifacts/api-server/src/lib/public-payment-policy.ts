import { collectionCurrency } from "@workspace/api-zod";

export type PublicCheckoutAmountInput = {
  amountType: "fixed" | "customer_choice";
  fixedAmount: number | null;
  requestedAmount?: number;
  invoiceOutstandingAmount?: number | null;
};

export type PublicCheckoutAmountResult =
  | { amount: number }
  | { error: "positive_amount_required" | "amount_exceeds_invoice_balance" | "fixed_link_amount_missing" };

export function resolvePublicCheckoutAmount(
  input: PublicCheckoutAmountInput,
): PublicCheckoutAmountResult {
  if (input.invoiceOutstandingAmount !== undefined && input.invoiceOutstandingAmount !== null) {
    const amount = input.requestedAmount ?? input.invoiceOutstandingAmount;
    if (!Number.isFinite(amount) || amount <= 0) return { error: "positive_amount_required" };
    if (amount > input.invoiceOutstandingAmount) return { error: "amount_exceeds_invoice_balance" };
    return { amount };
  }
  if (input.amountType === "fixed") {
    if (input.fixedAmount === null || !Number.isFinite(input.fixedAmount) || input.fixedAmount <= 0) {
      return { error: "fixed_link_amount_missing" };
    }
    // Non-invoice fixed links always use their persisted amount, never the
    // caller-provided amount.
    return { amount: input.fixedAmount };
  }
  const amount = input.requestedAmount;
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return { error: "positive_amount_required" };
  }
  return { amount };
}

export type PublicCheckoutCurrencyInput = {
  linkCurrency: string;
  amountType: "fixed" | "customer_choice";
  isInvoice: boolean;
  requestedCurrency?: string;
};

export type PublicCheckoutCurrencyResult =
  | { currency: string }
  | { error: "unsupported_currency" | "fixed_currency_immutable" };

export type MerchantPaymentReturnUrlResult =
  | { url: string | null }
  | { error: "invalid_return_url" };

export function normalizeMerchantPaymentReturnUrl(
  value: string | null | undefined,
): MerchantPaymentReturnUrlResult {
  if (value == null) return { url: null };
  if (value.length > 2048) return { error: "invalid_return_url" };
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      return { error: "invalid_return_url" };
    }
    return { url: url.toString() };
  } catch {
    return { error: "invalid_return_url" };
  }
}

export function publicMerchantReturnUrl(status: string, configuredUrl: string | null | undefined): string | null {
  if (!["success", "failed", "cancelled"].includes(status)) return null;
  const normalized = normalizeMerchantPaymentReturnUrl(configuredUrl);
  return "url" in normalized ? normalized.url : null;
}

export function knownCustomerPaymentFailureReason(detail: string | null | undefined): string | null {
  const normalized = detail?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/insufficient[\s\S]{0,40}(?:funds?|balance|credits?|float)|(?:funds?|balance|credits?|float)[\s\S]{0,40}insufficient|not enough[\s\S]{0,30}(?:funds?|balance|credits?|float)|low balance|no (?:airtime )?credits?/i.test(normalized)) {
    return "The selected payment account does not have enough funds. Add funds or choose another payment method.";
  }
  if (/cancel(?:led|ed|ation)?|abort(?:ed)?|rejected by user|declined by user|stk.{0,20}cancel/i.test(normalized)) {
    return "The payment request was cancelled before it could be completed.";
  }
  if (/expired|timed?\s*out/i.test(normalized)) {
    return "The payment request expired before it was completed. Please start a new payment.";
  }
  return null;
}

export function publicPaymentFailureReason(status: string, detail?: string | null): string | null {
  if (status !== "failed" && status !== "cancelled") return null;
  return knownCustomerPaymentFailureReason(detail) ??
    (status === "cancelled"
      ? "The payment request was cancelled before it could be completed."
      : "The payment could not be completed. Please try another payment method or contact the merchant.");
}

export function publicCheckoutFailure(status: number, detail: string): { status: number; error: string } {
  if (status === 409) return { status, error: detail };
  if (status === 400 || status === 422) return { status, error: detail };
  if (status === 503 && /coming soon/i.test(detail)) return { status, error: detail };
  return {
    status: 503,
    error: "Payments are unavailable for the selected currency right now. Please choose another currency or try again later.",
  };
}

export function resolvePublicCheckoutCurrency(
  input: PublicCheckoutCurrencyInput,
): PublicCheckoutCurrencyResult {
  const linkCurrency = input.linkCurrency.trim().toUpperCase();
  const currency = input.requestedCurrency?.trim().toUpperCase() || linkCurrency;
  if (!collectionCurrency(currency)) return { error: "unsupported_currency" };
  if ((input.amountType === "fixed" || input.isInvoice) && currency !== linkCurrency) {
    return { error: "fixed_currency_immutable" };
  }
  return { currency };
}