/** Ledger balances and provider fees retain cents, even on whole-unit collection routes. */
export function formatFinancialAmount(value: number | null | undefined, code = 'USD', unavailable = '—') {
  if (value === undefined || value === null || !Number.isFinite(value)) return unavailable;
  const currency = code.toUpperCase();
  const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  // Keep the provider's SLL denomination literal; never imply SLE redenomination.
  if (currency === 'SLL') return `SLL ${value.toLocaleString('en', options)}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, ...options }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en', options)}`;
  }
}