export interface PaymentLinkCurrencyTotal {
  currency: string;
  amount: number;
}

export function paymentLinkCurrencyTotals(
  linkCurrency: string,
  rows: readonly { currency: string; amount: number | string }[],
): { totalPaid: number; totalPaidByCurrency: PaymentLinkCurrencyTotal[] } {
  const normalizedLinkCurrency = linkCurrency.trim().toUpperCase();
  const amounts = new Map<string, number>();
  for (const row of rows) {
    const currency = row.currency.trim().toUpperCase();
    const amount = Number(row.amount);
    if (!currency || !Number.isFinite(amount) || amount < 0) {
      throw new RangeError("Payment-link currency totals require a currency code and finite non-negative amount.");
    }
    amounts.set(currency, Math.round(((amounts.get(currency) ?? 0) + amount) * 100) / 100);
  }
  const totalPaidByCurrency = [...amounts.entries()]
    .sort(([left], [right]) => {
      if (left === normalizedLinkCurrency) return right === normalizedLinkCurrency ? 0 : -1;
      if (right === normalizedLinkCurrency) return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([currency, amount]) => ({ currency, amount }));
  return {
    totalPaid: amounts.get(normalizedLinkCurrency) ?? 0,
    totalPaidByCurrency,
  };
}