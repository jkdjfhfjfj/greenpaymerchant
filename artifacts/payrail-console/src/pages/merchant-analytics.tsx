import { Activity, ArrowDownRight, Clock3, Globe2, RefreshCw } from 'lucide-react';
import { useGetMerchantCollectionAnalytics } from '@workspace/api-client-react';
import { Async, Btn, Card, Gate, Heading, Pill, money } from '@/components/kit';
import './merchant-analytics.css';

type Group = {
  value: string;
  transactionCount: number;
  successfulCount: number;
  successRate: number;
  grossVolume: number | null;
  feeTotal: number | null;
  currency: string | null;
  averageSettlementHours: number | null;
};

function percent(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function AnalyticsGroup({ title, caption, groups, icon: Icon }: { title: string; caption: string; groups: Group[]; icon: typeof Globe2 }) {
  const max = Math.max(1, ...groups.map((group) => group.transactionCount));
  return <Card title={title} subtitle={caption}>
    {!groups.length ? <div className="analytics-empty"><Activity size={18} /><strong>No collection data in this group</strong><span>Activity will appear when a collection has been recorded.</span></div> : <div className="analytics-list">
      {groups.map((group) => <article className="analytics-row" key={`${title}-${group.value}`}>
        <div className="analytics-row-top"><span className="analytics-symbol"><Icon size={15} /></span><div className="analytics-label"><strong>{group.value}</strong><small>{group.transactionCount.toLocaleString()} transactions · {group.successfulCount.toLocaleString()} successful</small></div><div className="analytics-result"><b>{group.grossVolume === null || !group.currency ? '—' : money(group.grossVolume, group.currency)}</b><small>{percent(group.successRate)} success</small></div></div>
        <div className="analytics-track" aria-label={`${group.value} transaction volume`}><i style={{ transform: `scaleX(${Math.min(1, group.transactionCount / max)})` }} /></div>
        <div className="analytics-row-foot"><span>Fees {group.feeTotal === null || !group.currency ? '—' : money(group.feeTotal, group.currency)}</span><span>Avg. settlement {group.averageSettlementHours === null ? '—' : `${group.averageSettlementHours.toLocaleString()} h`}</span></div>
      </article>)}
    </div>}
  </Card>;
}

function AnalyticsInner() {
  const query = useGetMerchantCollectionAnalytics();
  const data = query.data;
  const groups = [...(data?.countries ?? []), ...(data?.currencies ?? []), ...(data?.paymentRails ?? [])];
  const totalTransactions = (data?.countries ?? []).reduce((sum, group) => sum + group.transactionCount, 0);
  const successful = (data?.countries ?? []).reduce((sum, group) => sum + group.successfulCount, 0);
  const uniqueCountries = data?.countries.length ?? 0;
  return <>
    <Heading eyebrow="MERCHANT / PERFORMANCE" title="Collection analytics" subtitle="A 90-day view of payment outcomes by market, currency and payment rail." action={<Btn variant="secondary" testId="button-refresh-analytics" onClick={() => { void query.refetch(); }} disabled={query.isFetching}><RefreshCw size={14} />Refresh</Btn>} />
    <Async q={query}>
      {data && <>
        <section className="analytics-period"><div><span>REPORTING WINDOW</span><strong>{data.windowDays} days</strong><small>From {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(data.windowStart))}</small></div><div className="analytics-period-mark"><Activity size={21} /><span>Collections, without currency conversion</span></div></section>
        <div className="analytics-summary">
          <article><span><ArrowDownRight size={15} /> Transactions represented</span><strong>{totalTransactions.toLocaleString()}</strong></article>
          <article><span><Activity size={15} /> Successful</span><strong>{successful.toLocaleString()}</strong></article>
          <article><span><Globe2 size={15} /> Markets</span><strong>{uniqueCountries.toLocaleString()}</strong></article>
          <article><span><Clock3 size={15} /> Settlement data</span><strong>{groups.some((group) => group.averageSettlementHours !== null) ? 'Available' : 'Not yet available'}</strong></article>
        </div>
        <div className="analytics-grid">
          <AnalyticsGroup title="By country" caption="Customer market or processing country, as reported by the collection ledger." groups={data.countries} icon={Globe2} />
          <AnalyticsGroup title="By currency" caption="Volumes remain in their original settlement currency." groups={data.currencies} icon={Activity} />
          <AnalyticsGroup title="By payment rail" caption="Compare outcomes across the payment methods used by your customers." groups={data.paymentRails} icon={ArrowDownRight} />
        </div>
        <p className="analytics-footnote"><Pill value="90_day_window" /> Values are aggregated server data. Currency totals are never combined across currencies.</p>
      </>}
    </Async>
    {query.isError && <div className="analytics-retry"><button onClick={() => { void query.refetch(); }}>Retry analytics</button></div>}
  </>;
}

export function MerchantAnalyticsPage() {
  return <Gate need="merchant"><AnalyticsInner /></Gate>;
}