import { useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Filter,
  Globe2,
  Search,
} from 'lucide-react';
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
  status: 'pending' | 'due' | 'settled' | 'held';
};

const sampleRows: SettlementRow[] = [
  { id: 1, reference: 'GP-SET-8F31A2', provider: 'paystack', amount: 184500, netAmount: 178962, currency: 'KES', expectedAt: '2026-10-05T00:00:00.000Z', settledAt: null, payoutMethod: 'Bank transfer', status: 'due' },
  { id: 2, reference: 'GP-SET-7C09D4', provider: 'payhero', amount: 92750, netAmount: 90067.25, currency: 'KES', expectedAt: '2026-10-07T00:00:00.000Z', settledAt: null, payoutMethod: 'M-Pesa', status: 'pending' },
  { id: 3, reference: 'GP-SET-6B18E0', provider: 'payzaapi', amount: 1240, netAmount: 1202.8, currency: 'USD', expectedAt: '2026-09-29T00:00:00.000Z', settledAt: '2026-09-30T00:00:00.000Z', payoutMethod: 'Bank transfer', status: 'settled' },
  { id: 4, reference: 'GP-SET-5A72F6', provider: 'payhero', amount: 38200, netAmount: 37054, currency: 'KES', expectedAt: '2026-10-02T00:00:00.000Z', settledAt: null, payoutMethod: 'M-Pesa', status: 'held' },
  { id: 5, reference: 'GP-SET-4D27C1', provider: 'payzaapi', amount: 465000, netAmount: 451050, currency: 'NGN', expectedAt: '2026-10-08T00:00:00.000Z', settledAt: null, payoutMethod: 'Bank transfer', status: 'pending' },
];

const statusOptions = [
  { value: '', label: 'All items' },
  { value: 'due', label: 'Due' },
  { value: 'pending', label: 'Pending' },
  { value: 'held', label: 'Held' },
  { value: 'settled', label: 'Settled' },
] as const;

function titleCase(value?: string | null) {
  return (value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatCurrency(value: number, code: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function Status({ value }: { value: SettlementRow['status'] }) {
  return (
    <span className={`gp-status gp-status--${value}`}>
      <span className="gp-status-dot" aria-hidden="true" />
      {titleCase(value)}
    </span>
  );
}

function Provider({ name }: { name: string }) {
  return (
    <span className={`gp-provider gp-provider--${name}`}>
      <span className="gp-provider-mark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      {titleCase(name)}
    </span>
  );
}

export function Improved() {
  const [status, setStatus] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => ({
    open: sampleRows.filter((row) => row.status !== 'settled').length,
    due: sampleRows.filter((row) => row.status === 'due').length,
    settled: sampleRows.filter((row) => row.status === 'settled').length,
  }), []);

  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sampleRows.filter((row) => {
      const matchesStatus = !status || row.status === status;
      const matchesCurrency = !currencyCode || row.currency === currencyCode;
      const matchesQuery = !normalizedQuery
        || row.reference.toLowerCase().includes(normalizedQuery)
        || row.provider.toLowerCase().includes(normalizedQuery)
        || (row.payoutMethod || '').toLowerCase().includes(normalizedQuery);
      return matchesStatus && matchesCurrency && matchesQuery;
    });
  }, [status, currencyCode, query]);

  const clearFilters = () => {
    setStatus('');
    setCurrencyCode('');
    setQuery('');
  };

  return (
    <div className="gp-settlements">
      <style>{`
        .gp-settlements {
          --gp-ink: #213b35;
          --gp-forest: #244b40;
          --gp-muted: #75827b;
          --gp-line: #e5e5db;
          --gp-paper: #fffefa;
          --gp-wash: #f3f3eb;
          --gp-gold: #e8bd70;
          min-height: 100%;
          color: var(--gp-ink);
          background: transparent;
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          animation: gp-arrive .32s ease-out both;
        }
        @keyframes gp-arrive { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .gp-heading { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin:1px 0 22px; }
        .gp-eyebrow { display:flex; align-items:center; gap:7px; color:#879189; font:600 10px 'IBM Plex Mono',monospace; letter-spacing:.12em; text-transform:uppercase; }
        .gp-eyebrow span { width:5px; height:5px; border-radius:50%; background:#c18e3c; }
        .gp-heading h1 { margin:7px 0 4px; font-size:30px; font-weight:650; letter-spacing:-.045em; line-height:1.08; }
        .gp-heading p { max-width:62ch; color:#77827b; font-size:13px; line-height:1.55; }
        .gp-date-stamp { display:flex; flex:none; align-items:center; gap:8px; padding:8px 10px; border:1px solid #e0e1d7; border-radius:8px; background:#fafaf5; color:#65736b; font-size:11px; }
        .gp-date-stamp svg { color:#809087; }
        .gp-summary { display:grid; grid-template-columns:1.1fr 1fr 1fr minmax(230px,1.4fr); overflow:hidden; margin-bottom:19px; border:1px solid #dfe2d8; border-radius:12px; background:#fcfcf7; }
        .gp-stat { min-height:91px; display:flex; align-items:center; gap:12px; padding:15px 17px; border-right:1px solid #e7e8df; }
        .gp-stat-icon { width:32px; height:32px; display:grid; place-items:center; flex:none; border-radius:9px; color:#567463; background:#eaf0e8; }
        .gp-stat-copy { display:grid; gap:3px; }
        .gp-stat-label { color:#77837b; font-size:11px; }
        .gp-stat-value { font-size:23px; font-weight:650; letter-spacing:-.04em; line-height:1.1; font-variant-numeric:tabular-nums; }
        .gp-stat-detail { color:#939b93; font-size:10px; }
        .gp-target { display:flex; align-items:flex-start; gap:10px; padding:17px 16px; background:#f7f3e8; color:#796941; font-size:11px; line-height:1.5; }
        .gp-target svg { flex:none; margin-top:1px; color:#a07b39; }
        .gp-target strong { display:block; margin-bottom:2px; color:#65532d; font-weight:650; }
        .gp-panel { overflow:hidden; border:1px solid #dfe2d8; border-radius:12px; background:var(--gp-paper); }
        .gp-panel-head { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; padding:18px 20px 14px; }
        .gp-panel-title { display:flex; align-items:center; gap:9px; }
        .gp-panel-title h2 { margin:0; font-size:15px; font-weight:650; letter-spacing:-.02em; }
        .gp-row-count { padding:2px 7px; border:1px solid #e6e7de; border-radius:99px; color:#6e7a72; font:500 10px 'IBM Plex Mono',monospace; }
        .gp-panel-subtitle { margin-top:4px; color:#8a948d; font-size:11px; }
        .gp-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:9px; padding:0 20px 13px; border-bottom:1px solid #e8e9e1; }
        .gp-filter-label { display:inline-flex; align-items:center; gap:6px; margin-right:1px; color:#8b948d; font-size:10px; }
        .gp-status-tabs { display:flex; flex-wrap:wrap; gap:4px; }
        .gp-tab { display:inline-flex; align-items:center; gap:6px; min-height:30px; padding:5px 9px; border:1px solid transparent; border-radius:6px; background:transparent; color:#6b7770; font:500 11px 'DM Sans',sans-serif; cursor:pointer; transition:background .15s, color .15s, border-color .15s; }
        .gp-tab:hover { background:#f5f6f0; color:#304d40; }
        .gp-tab[aria-pressed="true"] { border-color:#dce5db; background:#edf2eb; color:#315744; font-weight:650; }
        .gp-tab-count { color:#9aa39b; font:10px 'IBM Plex Mono',monospace; }
        .gp-tab[aria-pressed="true"] .gp-tab-count { color:#63816d; }
        .gp-currency-select { position:relative; display:flex; align-items:center; gap:7px; min-height:31px; margin-left:auto; padding:0 8px; border:1px solid #e2e4da; border-radius:7px; background:#fffefa; color:#7c8981; }
        .gp-currency-select select { width:91px; padding:6px 17px 6px 0; appearance:none; border:0; outline:none; background:transparent; color:#46594e; font:500 11px 'DM Sans',sans-serif; cursor:pointer; }
        .gp-currency-select select:focus-visible { outline:2px solid #648773; outline-offset:3px; border-radius:3px; }
        .gp-currency-select > svg:last-child { position:absolute; right:8px; pointer-events:none; }
        .gp-search { position:relative; width:184px; }
        .gp-search svg { position:absolute; left:9px; top:50%; transform:translateY(-50%); color:#9aa29b; pointer-events:none; }
        .gp-search input { width:100%; height:31px; padding:0 9px 0 29px; border:1px solid #e2e4da; border-radius:7px; outline:none; background:#fffefa; color:#374d42; font:400 11px 'DM Sans',sans-serif; }
        .gp-search input::placeholder { color:#a0a79f; }
        .gp-search input:focus { border-color:#8ca28f; box-shadow:0 0 0 3px #426b5418; }
        .gp-table-wrap { overflow-x:auto; }
        .gp-table { width:100%; border-collapse:collapse; text-align:left; font-size:11px; }
        .gp-table th { padding:10px 11px; border-bottom:1px solid #e8e9e1; background:#fafaf5; color:#8a938c; font:600 9px 'IBM Plex Mono',monospace; letter-spacing:.075em; text-transform:uppercase; white-space:nowrap; }
        .gp-table th:first-child, .gp-table td:first-child { padding-left:20px; }
        .gp-table th:last-child, .gp-table td:last-child { padding-right:20px; }
        .gp-table td { padding:13px 11px; border-bottom:1px solid #eeefe9; color:#4c5d53; vertical-align:middle; white-space:nowrap; }
        .gp-table tbody tr { transition:background .14s ease; }
        .gp-table tbody tr:hover { background:#fafbf6; }
        .gp-table tbody tr:last-child td { border-bottom:0; }
        .gp-reference { display:grid; gap:3px; }
        .gp-reference strong { color:#31483d; font:500 10px 'IBM Plex Mono',monospace; letter-spacing:-.02em; }
        .gp-reference span { color:#9ba39c; font-size:9px; }
        .gp-provider { display:inline-flex; align-items:center; gap:7px; color:#43564a; font-weight:550; }
        .gp-provider-mark { width:21px; height:21px; display:grid; place-items:center; border-radius:6px; background:#edf1e8; color:#536e5a; font:600 9px 'IBM Plex Mono',monospace; }
        .gp-provider--payhero .gp-provider-mark { background:#f5eddf; color:#8d6b35; }
        .gp-provider--payzaapi .gp-provider-mark { background:#e9eef0; color:#536b72; }
        .gp-money { display:grid; gap:3px; text-align:right; font-variant-numeric:tabular-nums; }
        .gp-money strong { color:#34493e; font-weight:650; }
        .gp-money span { color:#9ba39c; font-size:9px; }
        .gp-date { display:grid; gap:3px; }
        .gp-date strong { color:#4d5c53; font-weight:550; }
        .gp-date span { color:#9aa39b; font-size:9px; }
        .gp-status { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:99px; font-size:10px; font-weight:600; }
        .gp-status-dot { width:5px; height:5px; border-radius:50%; background:currentColor; }
        .gp-status--due { color:#936c2b; background:#f8f0dd; }
        .gp-status--pending { color:#617980; background:#edf1f1; }
        .gp-status--settled { color:#397055; background:#e8f1e9; }
        .gp-status--held { color:#956044; background:#f6ece5; }
        .gp-ledger-footer { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; padding:13px 20px; border-top:1px solid #e8e9e1; background:#fcfcf8; color:#879189; font-size:10px; line-height:1.5; }
        .gp-ledger-note { display:flex; align-items:flex-start; gap:7px; max-width:650px; }
        .gp-ledger-note svg { flex:none; margin-top:1px; color:#9a9f93; }
        .gp-static-note { display:flex; align-items:center; gap:5px; white-space:nowrap; color:#9a9f93; }
        .gp-static-note svg { color:#839286; }
        .gp-mobile-list { display:none; }
        .gp-empty { padding:36px 16px; text-align:center; color:#7e8981; }
        .gp-empty strong { display:block; margin-bottom:4px; color:#40564a; font-size:13px; }
        .gp-empty button { margin-top:12px; padding:6px 10px; border:1px solid #dfe4da; border-radius:6px; background:#fffefa; color:#44604d; font:600 11px 'DM Sans',sans-serif; cursor:pointer; }
        .gp-empty button:focus-visible, .gp-tab:focus-visible { outline:2px solid #648773; outline-offset:2px; }
        @media (max-width: 1050px) {
          .gp-summary { grid-template-columns:1fr 1fr 1fr; }
          .gp-target { grid-column:1 / -1; min-height:auto; padding:12px 16px; }
          .gp-stat:nth-child(3) { border-right:0; }
          .gp-table { min-width:900px; }
        }
        @media (max-width: 760px) {
          .gp-heading { align-items:flex-start; flex-direction:column; gap:10px; margin-bottom:16px; }
          .gp-heading h1 { font-size:27px; }
          .gp-heading p { font-size:12px; }
          .gp-date-stamp { padding:6px 8px; }
          .gp-summary { grid-template-columns:1fr 1fr; }
          .gp-stat { min-height:78px; padding:12px; }
          .gp-stat:nth-child(2) { border-right:0; }
          .gp-stat:nth-child(3) { border-top:1px solid #e7e8df; }
          .gp-target { grid-column:auto; min-height:78px; border-top:1px solid #e7e8df; padding:12px; }
          .gp-panel-head { padding:15px 14px 12px; }
          .gp-toolbar { padding:0 14px 12px; gap:8px; }
          .gp-filter-label { display:none; }
          .gp-status-tabs { width:100%; flex-wrap:nowrap; overflow-x:auto; padding-bottom:2px; }
          .gp-tab { flex:none; }
          .gp-currency-select { margin-left:0; }
          .gp-search { flex:1; min-width:135px; }
          .gp-table-wrap { display:none; }
          .gp-mobile-list { display:grid; }
          .gp-mobile-row { padding:13px 14px; border-bottom:1px solid #eeefe9; }
          .gp-mobile-row:last-child { border-bottom:0; }
          .gp-mobile-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
          .gp-mobile-title { display:grid; gap:6px; min-width:0; }
          .gp-mobile-title .gp-provider { font-size:11px; }
          .gp-mobile-title .gp-reference { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .gp-mobile-title .gp-reference strong { font-size:9px; }
          .gp-mobile-money { flex:none; text-align:right; }
          .gp-mobile-money strong { display:block; color:#34493e; font-size:13px; font-variant-numeric:tabular-nums; }
          .gp-mobile-money span { display:block; margin-top:3px; color:#98a199; font-size:9px; }
          .gp-mobile-meta { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:13px; padding-top:10px; border-top:1px dashed #e8e9e1; }
          .gp-mobile-meta span { display:block; margin-bottom:3px; color:#9aa39b; font:500 8px 'IBM Plex Mono',monospace; letter-spacing:.06em; text-transform:uppercase; }
          .gp-mobile-meta strong { color:#56645b; font-size:10px; font-weight:550; }
          .gp-mobile-meta .gp-status { width:fit-content; }
          .gp-ledger-footer { flex-direction:column; gap:6px; padding:11px 14px; }
          .gp-static-note { white-space:normal; }
        }
        @media (prefers-reduced-motion: reduce) {
          .gp-settlements, .gp-settlements * { animation-duration:.01ms !important; transition-duration:.01ms !important; }
        }
      `}</style>

      <section aria-labelledby="settlements-title">
            <div className="gp-heading">
              <div>
                <div className="gp-eyebrow"><span /> Reconciliation / T+3</div>
                <h1 id="settlements-title">Settlements</h1>
                <p>Track provider-held collection proceeds from expected timing through confirmed settlement.</p>
              </div>
              <div className="gp-date-stamp"><CalendarClock size={14} /><span>Illustrative records · Oct 2026</span></div>
            </div>

            <section className="gp-summary" aria-label="Settlement overview">
              <div className="gp-stat">
                <span className="gp-stat-icon"><Clock3 size={16} /></span>
                <span className="gp-stat-copy"><span className="gp-stat-label">Open items</span><strong className="gp-stat-value">{counts.open}</strong><span className="gp-stat-detail">Not yet settled</span></span>
              </div>
              <div className="gp-stat">
                <span className="gp-stat-icon" style={{ background: '#f7f0df', color: '#9b7839' }}><CalendarClock size={16} /></span>
                <span className="gp-stat-copy"><span className="gp-stat-label">Due for review</span><strong className="gp-stat-value">{counts.due}</strong><span className="gp-stat-detail">Past expected date</span></span>
              </div>
              <div className="gp-stat">
                <span className="gp-stat-icon" style={{ background: '#e8f1e9', color: '#4d8060' }}><Check size={16} /></span>
                <span className="gp-stat-copy"><span className="gp-stat-label">Settled</span><strong className="gp-stat-value">{counts.settled}</strong><span className="gp-stat-detail">Confirmed by provider</span></span>
              </div>
              <div className="gp-target">
                <Clock3 size={15} />
                <span><strong>T+3 is a tracking target, not a promise.</strong>Actual settlement timing is provider-controlled.</span>
              </div>
            </section>

            <section className="gp-panel" aria-labelledby="ledger-title">
              <div className="gp-panel-head">
                <div>
                  <div className="gp-panel-title"><h2 id="ledger-title">Settlement ledger</h2><span className="gp-row-count">{rows.length} records</span></div>
                  <p className="gp-panel-subtitle">Provider-level view of collection proceeds</p>
                </div>
              </div>

              <div className="gp-toolbar" aria-label="Filter settlement records">
                <span className="gp-filter-label"><Filter size={13} /> Status</span>
                <div className="gp-status-tabs" role="group" aria-label="Filter by settlement status">
                  {statusOptions.map((option) => {
                    const count = option.value ? sampleRows.filter((row) => row.status === option.value).length : sampleRows.length;
                    return (
                      <button
                        key={option.value || 'all'}
                        className="gp-tab"
                        type="button"
                        aria-pressed={status === option.value}
                        onClick={() => setStatus(option.value)}
                      >
                        {option.label}<span className="gp-tab-count">{count}</span>
                      </button>
                    );
                  })}
                </div>
                <label className="gp-currency-select">
                  <Globe2 size={13} aria-hidden="true" />
                  <span className="sr-only">Filter by currency</span>
                  <select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} aria-label="Filter by currency">
                    <option value="">All currencies</option>
                    <option value="KES">KES</option>
                    <option value="USD">USD</option>
                    <option value="NGN">NGN</option>
                  </select>
                  <ChevronDown size={12} aria-hidden="true" />
                </label>
                <label className="gp-search">
                  <Search size={13} aria-hidden="true" />
                  <span className="sr-only">Search reference, provider or payout method</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search records"
                    aria-label="Search reference, provider or payout method"
                  />
                </label>
              </div>

              {rows.length ? (
                <>
                  <div className="gp-table-wrap">
                    <table className="gp-table">
                      <thead>
                        <tr>
                          <th scope="col">Reference</th>
                          <th scope="col">Provider</th>
                          <th scope="col" style={{ textAlign: 'right' }}>Gross</th>
                          <th scope="col" style={{ textAlign: 'right' }}>Net to settle</th>
                          <th scope="col">Expected by</th>
                          <th scope="col">Settled on</th>
                          <th scope="col">Method</th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((item) => (
                          <tr key={item.id}>
                            <td><span className="gp-reference"><strong>{item.reference}</strong><span>Collection proceeds</span></span></td>
                            <td><Provider name={item.provider} /></td>
                            <td><span className="gp-money"><strong>{formatCurrency(item.amount, item.currency)}</strong><span>Gross amount</span></span></td>
                            <td><span className="gp-money"><strong>{formatCurrency(item.netAmount, item.currency)}</strong><span>Net amount</span></span></td>
                            <td><span className="gp-date"><strong>{formatDate(item.expectedAt)}</strong><span>Expected date</span></span></td>
                            <td><span className="gp-date"><strong>{formatDate(item.settledAt)}</strong><span>{item.settledAt ? 'Confirmed date' : 'Not confirmed'}</span></span></td>
                            <td>{item.payoutMethod || '—'}</td>
                            <td><Status value={item.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="gp-mobile-list">
                    {rows.map((item) => (
                      <article className="gp-mobile-row" key={item.id}>
                        <div className="gp-mobile-top">
                          <div className="gp-mobile-title">
                            <Provider name={item.provider} />
                            <span className="gp-reference"><strong>{item.reference}</strong></span>
                          </div>
                          <div className="gp-mobile-money">
                            <strong>{formatCurrency(item.netAmount, item.currency)}</strong>
                            <span>Net to settle</span>
                          </div>
                        </div>
                        <div className="gp-mobile-meta">
                          <div><span>Gross · {item.currency}</span><strong>{formatCurrency(item.amount, item.currency)}</strong></div>
                          <div><span>Status</span><Status value={item.status} /></div>
                          <div><span>Expected by</span><strong>{formatDate(item.expectedAt)}</strong></div>
                          <div><span>Settled on</span><strong>{formatDate(item.settledAt)}</strong></div>
                          <div><span>Method</span><strong>{item.payoutMethod || '—'}</strong></div>
                          <div><span>Reference type</span><strong>Collection proceeds</strong></div>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="gp-empty" role="status">
                  <strong>No settlement records match these filters</strong>
                  Try another status, currency or search term.
                  <div><button type="button" onClick={clearFilters}>Clear filters</button></div>
                </div>
              )}

              <footer className="gp-ledger-footer">
                <span className="gp-ledger-note"><CircleHelp size={13} />Expected dates are calculated by the provider route. Bank holidays can affect the final settlement time. Settled-on dates reflect confirmed settlement facts.</span>
                <span className="gp-static-note"><Clock3 size={12} />Static illustrative records</span>
              </footer>
            </section>
      </section>
    </div>
  );
}