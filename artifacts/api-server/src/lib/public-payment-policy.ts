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

export function publicCheckoutFailure(status: number, detail: string): { status: number; error: string } {
  if (status === 409) return { status, error: detail };
  if (status === 400 || status === 422) return { status, error: detail };
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