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