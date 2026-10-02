type LinkCurrencyTotal = { currency: string; amount: number };

type LinkCollectedTotalsProps = {
  currency: string;
  totalPaid: number;
  totalPaidByCurrency?: LinkCurrencyTotal[] | null;
};

const formatAmount = new Intl.NumberFormat('en', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function LinkCollectedTotals({ currency, totalPaid, totalPaidByCurrency }: LinkCollectedTotalsProps) {
  const totals = Array.isArray(totalPaidByCurrency)
    ? totalPaidByCurrency
    : [{ currency, amount: totalPaid }];

  if (!totals.length) return <>—</>;

  return (
    <span className="link-collected-totals" role="list" aria-label="Collected totals by currency">
      {totals.map((total) => (
        <span className="link-currency-total" key={total.currency} role="listitem">
          <span className="link-currency-code">{total.currency}</span>
          <span className="link-currency-amount">{formatAmount.format(total.amount)}</span>
        </span>
      ))}
    </span>
  );
}