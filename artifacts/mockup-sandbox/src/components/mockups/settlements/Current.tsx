import { useMemo, useState, type ReactNode } from 'react';
import { CircleHelp, Clock3, FileClock, Filter, Globe2 } from 'lucide-react';
import './_group.css';

type SettlementRow = {
  id: number;
  reference: string;
  provider: string;
  amount: number;
  netAmount: number;
  currency: string;
  expectedAt: string | null;
  settledAt: string | null;
  payoutMethod: string | null;
  status: string;
};

const sampleRows: SettlementRow[] = [
  { id: 1, reference: 'GP-SET-8F31A2', provider: 'paystack', amount: 184500, netAmount: 178962, currency: 'KES', expectedAt: '2026-10-05T00:00:00.000Z', settledAt: null, payoutMethod: 'Bank transfer', status: 'due' },
  { id: 2, reference: 'GP-SET-7C09D4', provider: 'payhero', amount: 92750, netAmount: 90067.25, currency: 'KES', expectedAt: '2026-10-07T00:00:00.000Z', settledAt: null, payoutMethod: 'M-Pesa', status: 'pending' },
  { id: 3, reference: 'GP-SET-6B18E0', provider: 'payzaapi', amount: 1240, netAmount: 1202.8, currency: 'USD', expectedAt: '2026-09-29T00:00:00.000Z', settledAt: '2026-09-30T00:00:00.000Z', payoutMethod: 'Bank transfer', status: 'settled' },
  { id: 4, reference: 'GP-SET-5A72F6', provider: 'payhero', amount: 38200, netAmount: 37054, currency: 'KES', expectedAt: '2026-10-02T00:00:00.000Z', settledAt: null, payoutMethod: 'M-Pesa', status: 'held' },
  { id: 5, reference: 'GP-SET-4D27C1', provider: 'payzaapi', amount: 465000, netAmount: 451050, currency: 'NGN', expectedAt: '2026-10-08T00:00:00.000Z', settledAt: null, payoutMethod: 'Bank transfer', status: 'pending' },
];

function label(value?: string | null) {
  return (value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function dateOnly(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function currency(value: number, code: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value);
}

function StatusPill({ value }: { value?: string | null }) {
  const normalized = (value || 'unknown').toLowerCase();
  return <span className={`status-pill status-${normalized}`}><i />{label(value)}</span>;
}

function PageHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div></div>;
}

function Panel({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: string }) {
  return <section className="panel"><div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div></div>{children}</section>;
}

export function Current() {
  const [status, setStatus] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const rows = useMemo(() => sampleRows.filter((item) => (!status || item.status === status) && (!currencyCode || item.currency === currencyCode)), [status, currencyCode]);
  const dueCount = rows.filter((item) => item.status === 'due').length;
  const openCount = rows.filter((item) => item.status !== 'settled').length;

  return (
    <main className="current-settlements">
      <PageHeading eyebrow="RECONCILIATION / T+3" title="Settlements" subtitle="Know what has landed, what is due and what needs a closer look." />
      <div className="settlement-summary">
        <div><span className="summary-icon"><Clock3 size={17} /></span><div><span>Open settlement items</span><strong>{openCount}</strong></div></div>
        <div><span className="summary-divider" /><div><span>Due for review</span><strong>{dueCount} <small>items</small></strong></div></div>
        <div className="summary-explainer"><FileClock size={15} /><span>T+3 is a tracking target. Actual settlement timing is provider-controlled.</span></div>
      </div>
      <div className="toolbar-filters">
        <label className="select-wrap"><Filter size={14} /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="pending">Pending</option><option value="due">Due</option><option value="settled">Settled</option><option value="held">Held</option></select></label>
        <label className="select-wrap"><Globe2 size={14} /><select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)}><option value="">All currencies</option><option value="KES">KES</option><option value="USD">USD</option><option value="NGN">NGN</option></select></label>
      </div>
      <Panel title="Settlement ledger" subtitle="Provider-level view of collection proceeds">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Reference</th><th>Provider</th><th>Gross</th><th>Net to settle</th><th>Expected by</th><th>Settled on</th><th>Method</th><th>Status</th></tr></thead>
            <tbody>{rows.map((item) => <tr key={item.id}>
              <td><strong className="mono">{item.reference}</strong></td>
              <td><span className="provider-cell"><span className={`provider-mini provider-${item.provider}`} />{label(item.provider)}</span></td>
              <td>{currency(item.amount, item.currency)}</td>
              <td><strong className="amount-cell">{currency(item.netAmount, item.currency)}</strong></td>
              <td>{dateOnly(item.expectedAt)}</td>
              <td>{dateOnly(item.settledAt)}</td>
              <td>{item.payoutMethod || '—'}</td>
              <td><StatusPill value={item.status} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="ledger-note"><CircleHelp size={15} /><span>Expected dates are calculated by the provider route. Bank holidays can affect the final settlement time.</span></div>
      </Panel>
    </main>
  );
}