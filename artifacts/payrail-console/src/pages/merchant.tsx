import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ExternalLink, LoaderCircle, Plus, Trash2, Pause, Play, ShieldCheck } from 'lucide-react';
import {
  useCreateMerchantProfile, useGetMerchantFees, useGetMerchantKyc, getGetMerchantKycQueryKey, useCreateMerchantKycSession,
  useListMerchantPaymentLinks, useCreateMerchantPaymentLink, useUpdateMerchantPaymentLink, useDeleteMerchantPaymentLink,
  useListMerchantTransactions, useListMerchantPayouts, useListSupportedCurrencies,
} from '@workspace/api-client-react';
import { Async, Btn, Card, COUNTRIES, CURRENCIES, Confirm, CopyBtn, Err, Field, Gate, Heading, Modal, Note, Pager, Pill, currencyAmountStep, currencyMinorUnits, fmtDate, money, nice, useAccess, useInvalidateAll } from '@/components/kit';
import { usePlatformBranding } from '@/components/platform-brand';

export function MerchantPage() {
  const access = useAccess();
  const branding = usePlatformBranding();
  const create = useCreateMerchantProfile();
  const inv = useInvalidateAll();
  const fees = useGetMerchantFees({ query: { enabled: !!access.merchant } as never });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reg = String(f.get('reg') || '').trim();
    create.mutate({ data: { businessName: String(f.get('name')).trim(), country: String(f.get('country')), baseCurrency: String(f.get('cur')), ...(reg ? { registrationNumber: reg } : {}) } }, { onSuccess: () => { void inv(); } });
  }
  const m = access.merchant;
  return <>
    <Heading eyebrow="MERCHANT" title={m ? m.businessName : 'Merchant onboarding'} subtitle="Your business profile, verification state and the fees that apply to you." />
    <Async q={access}>
      {!m ? <Card title="Register your business" subtitle="Takes a minute. Verification is a separate step.">
        <form className="form-stack" onSubmit={submit}>
          <Field label="Business name"><input name="name" required minLength={2} maxLength={150} data-testid="input-business-name" /></Field>
          <div className="form-grid">
            <Field label="Country"><select name="country" defaultValue="KE" data-testid="select-country">{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
            <Field label="Base currency"><select key={branding.baseCurrency} name="cur" defaultValue={branding.baseCurrency} data-testid="select-base-currency">{[...new Set([branding.baseCurrency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
          <Field label="Registration number" hint="Optional"><input name="reg" maxLength={150} data-testid="input-registration" /></Field>
          <Err error={create.error} />
          <Btn type="submit" disabled={create.isPending} testId="button-create-merchant">{create.isPending ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Create merchant profile</Btn>
        </form>
      </Card> : <div className="split">
        <div>
          <Card title="Profile">
            <div className="kv">
              <div><span>Status</span><Pill value={m.status} /></div>
              <div><span>Verification</span><Pill value={m.kycStatus} /></div>
              <div><span>Country</span><strong>{m.country}</strong></div>
              <div><span>Base currency</span><strong>{m.baseCurrency}</strong></div>
              <div><span>Registration</span><strong>{m.registrationNumber || '-'}</strong></div>
              {([['paymentsEnabled', 'Payments'], ['payoutsEnabled', 'Payouts'], ['refundsEnabled', 'Refunds'], ['apiAccessEnabled', 'API access']] as const).map(([k, t]) => <div key={k}><span>{t}</span><Pill value={m[k] === false ? 'disabled' : 'active'} /></div>)}
              <div><span>Created</span><strong>{fmtDate(m.createdAt)}</strong></div>
            </div>
          </Card>
          {m.kycStatus !== 'approved' && <Note tone="warn">Verification is {nice(m.kycStatus).toLowerCase()}. <Link href="/merchant/kyc" className="text-link">Open verification <ArrowRight size={13} /></Link></Note>}
        </div>
        <Card title="Your fee schedule" subtitle="Applied to calculations and quotes">
          <Async q={fees}>{fees.data && <div className="form-stack">
            <div className="kv"><div><span>Percentage</span><strong>{fees.data.schedule.percentage}%</strong></div><div><span>Flat</span><strong>{money(fees.data.schedule.flatAmount, fees.data.schedule.currency)}</strong></div><div><span>FX markup</span><strong>{fees.data.schedule.fxMarkupBps} bps</strong></div></div>
            <div><Pill value={fees.data.source} /></div><span className="sub">{fees.data.note}</span></div>}</Async>
        </Card>
      </div>}
    </Async>
  </>;
}

export function KycPage() {
  return <Gate need="merchant"><KycInner /></Gate>;
}
function KycInner() {
  const q = useGetMerchantKyc({ query: {
    queryKey: getGetMerchantKycQueryKey(),
    refetchInterval: (query) => {
      const data = query.state.data;
      const kycActive = Boolean(data?.sessionId) && ['not_started', 'pending', 'in_review'].includes(data?.status || '');
      const kybActive = Boolean(data?.kybSessionId) && ['not_started', 'pending', 'in_review'].includes(data?.kybStatus || '');
      return kycActive || kybActive ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  } });
  const start = useCreateMerchantKycSession();
  const inv = useInvalidateAll();
  useEffect(() => {
    const refreshWhenVisible = () => {
      const kycActive = Boolean(q.data?.sessionId) && ['not_started', 'pending', 'in_review'].includes(q.data?.status || '');
      const kybActive = Boolean(q.data?.kybSessionId) && ['not_started', 'pending', 'in_review'].includes(q.data?.kybStatus || '');
      if (document.visibilityState === 'visible' && (kycActive || kybActive)) {
        void q.refetch();
      }
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [q.data?.sessionId, q.data?.status, q.data?.kybSessionId, q.data?.kybStatus, q.refetch]);
  const run = (kind: 'kyc' | 'kyb') => start.mutate({ data: { kind } }, { onSuccess: (r) => { void inv(); window.open(r.url, '_blank', 'noopener'); } });
  const active = (status: string, sessionId: string | null) => Boolean(sessionId) && ['not_started', 'pending', 'in_review'].includes(status);
  const limitRows = q.data?.limits ?? [];
  const limitLabel = (amount: number | null, currency: string) => amount === null ? 'No configured cap' : money(amount, currency);
  return <>
    <Heading eyebrow="MERCHANT / VERIFICATION" title="Identity and business verification" subtitle="Hosted verification runs on Didit. Active checks sync automatically and refresh when you return to this page." />
    <Async q={q}>{q.data && <div className="split">
      <div className="form-stack">
        <Err error={start.error} />
        <Card title="Personal verification (KYC)" action={<Btn variant="secondary" small onClick={() => { void q.refetch(); }}>Refresh</Btn>}>
          <div className="kv"><div><span>Status</span><Pill value={q.data.status} /></div><div><span>Session</span><strong className="mono" style={{ fontSize: 12 }}>{q.data.sessionId || 'None'}</strong></div><div><span>Updated</span><strong>{fmtDate(q.data.updatedAt)}</strong></div></div>
          {active(q.data.status, q.data.sessionId) && <span className="sub" role="status">Checking for Didit KYC status updates every 15 seconds.</span>}
          {!!q.data.requirements?.length && <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 13 }}>{q.data.requirements.map((r) => <li key={r}>{r}</li>)}</ul>}
          {q.data.sessionUrl && <p style={{ marginTop: 14 }}><a className="text-link" href={q.data.sessionUrl} target="_blank" rel="noreferrer">Resume KYC session <ExternalLink size={13} /></a></p>}
          {!q.data.configured && <Note tone="warn">The Didit KYC workflow is not configured. An administrator must configure the API key and KYC workflow before you can start personal verification.</Note>}
          <div className="form-stack" style={{ marginTop: 12 }}>
            <Btn disabled={start.isPending || !q.data.configured || q.data.status === 'approved' || active(q.data.status, q.data.sessionId)} onClick={() => run('kyc')} testId="button-start-kyc"><ShieldCheck size={15} />Verify identity (KYC)</Btn>
          </div>
        </Card>
        <Card title="Business verification (optional KYB)" subtitle="Approved KYB raises your monetary tier only when personal KYC is also approved.">
          <div className="kv"><div><span>Status</span><Pill value={q.data.kybStatus} /></div><div><span>Session</span><strong className="mono" style={{ fontSize: 12 }}>{q.data.kybSessionId || 'None'}</strong></div><div><span>Updated</span><strong>{fmtDate(q.data.kybUpdatedAt)}</strong></div></div>
          {active(q.data.kybStatus, q.data.kybSessionId) && <span className="sub" role="status">Checking for Didit KYB status updates every 15 seconds.</span>}
          {q.data.kybSessionUrl && <p style={{ marginTop: 14 }}><a className="text-link" href={q.data.kybSessionUrl} target="_blank" rel="noreferrer">Resume KYB session <ExternalLink size={13} /></a></p>}
          {!q.data.kybConfigured && <Note tone="warn">The Didit KYB workflow is not configured. Business verification is optional and unavailable until an administrator configures its workflow.</Note>}
          <div className="form-stack" style={{ marginTop: 12 }}>
            <Btn variant="secondary" disabled={start.isPending || !q.data.kybConfigured || q.data.kybStatus === 'approved' || active(q.data.kybStatus, q.data.kybSessionId)} onClick={() => run('kyb')} testId="button-start-kyb">Verify business (KYB)</Btn>
          </div>
        </Card>
      </div>
      <div className="form-stack">
        <Card title="Your verification tier">
          <div className="kv"><div><span>Active tier</span><Pill value={q.data.tier} /></div><div><span>Personal KYC</span><Pill value={q.data.status} /></div><div><span>Business KYB</span><Pill value={q.data.kybStatus} /></div></div>
          <p className="sub" style={{ marginTop: 12 }}>All merchant features remain available subject to administrator account controls. Verification changes monetary limits, not feature access.</p>
        </Card>
        <Card title="Per-currency limits" subtitle="Limits are enforced server-side. An uncapped field means no tier-specific cap is configured for that action.">
          {!limitRows.length ? <Note tone="warn">No limits are configured for the active tier. Contact the platform administrator before making payments.</Note> : <div className="table-wrap"><table className="dt"><thead><tr><th>Currency</th><th>Single collection</th><th>Daily collections</th><th>Monthly collections</th><th>Payout</th><th>Conversion</th></tr></thead><tbody>
            {limitRows.map((limit) => <tr key={`${limit.tier}-${limit.currency}`}><td><strong>{limit.currency}</strong></td><td>{limitLabel(limit.collectionPerTransactionLimit, limit.currency)}</td><td>{limitLabel(limit.collectionDailyLimit, limit.currency)}</td><td>{limitLabel(limit.collectionMonthlyLimit, limit.currency)}</td><td>{limitLabel(limit.payoutLimit, limit.currency)}</td><td>{limitLabel(limit.conversionLimit, limit.currency)}</td></tr>)}
          </tbody></table></div>}
        </Card>
      </div>
    </div>}</Async>
  </>;
}

export function MerchantLinksPage() { return <Gate need="merchant"><LinksInner /></Gate>; }
type MerchantLinkCurrencyTotal = { currency: string; amount: number };
type MerchantLinkTotalsSource = {
  currency: string;
  totalPaid: number;
  totalPaidByCurrency?: MerchantLinkCurrencyTotal[] | null;
};
function LinkCollectedTotals({ link }: { link: MerchantLinkTotalsSource }) {
  const totals = Array.isArray(link.totalPaidByCurrency)
    ? link.totalPaidByCurrency
    : [{ currency: link.currency, amount: link.totalPaid }];
  return totals.length
    ? <>{totals.map((total) => <span key={total.currency} style={{ display: 'block' }}>{money(total.amount, total.currency)}</span>)}</>
    : <>—</>;
}

function LinksInner() {
  const q = useListMerchantPaymentLinks();
  const update = useUpdateMerchantPaymentLink();
  const del = useDeleteMerchantPaymentLink();
  const inv = useInvalidateAll();
  const [open, setOpen] = useState(false);
  const [rm, setRm] = useState<number | null>(null);
  const items = q.data?.items ?? [];
  return <>
    <Heading eyebrow="MERCHANT" title="Payment links" subtitle="Links you own. Customers pay through the provider routed for the currency." action={<Btn onClick={() => setOpen(true)} testId="button-new-link"><Plus size={15} />New link</Btn>} />
    <Err error={update.error} />
    <Async q={q} empty={!items.length} emptyTitle="No payment links" emptyBody="Create a fixed-price or customer-entered link." emptyAction={<Btn onClick={() => setOpen(true)}>Create link</Btn>}>
       <div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Amount</th><th>Status</th><th className="num">Payments</th><th className="num">Collected</th><th>Link</th><th /></tr></thead><tbody>
        {items.map((l) => <tr key={l.id} data-testid={`row-link-${l.id}`}>
          <td><strong>{l.name}</strong><span className="sub">{l.description}</span></td>
          <td>{l.amountType === 'fixed' ? money(l.amount, l.currency) : `Customer enters (${l.currency})`}</td>
          <td><Pill value={l.status} /></td><td className="num">{l.paidCount}</td><td className="num"><LinkCollectedTotals link={l} /></td>
          <td><div className="copy-line"><code className="mono" style={{ fontSize: 11 }}>{l.url}</code><CopyBtn text={l.url} /></div></td>
          <td><div className="row-actions">
            {l.status !== 'archived' && <Btn variant="quiet" small disabled={update.isPending} onClick={() => update.mutate({ id: l.id, data: { status: l.status === 'active' ? 'paused' : 'active' } }, { onSuccess: () => { void inv(); } })}>{l.status === 'active' ? <><Pause size={13} />Pause</> : <><Play size={13} />Resume</>}</Btn>}
            <Btn variant="danger" small onClick={() => setRm(l.id)}><Trash2 size={13} />Delete</Btn></div></td>
        </tr>)}
      </tbody></table></div>
    </Async>
    {open && <LinkModal onClose={() => setOpen(false)} />}
    {rm !== null && <Confirm title="Delete payment link" body="The link stops accepting payments immediately." confirmLabel="Delete link" pending={del.isPending} error={del.error} onClose={() => { setRm(null); del.reset(); }} onConfirm={() => del.mutate({ id: rm }, { onSuccess: () => { void inv(); setRm(null); } })} />}
  </>;
}
function LinkModal({ onClose }: { onClose: () => void }) {
  const create = useCreateMerchantPaymentLink();
  const currencyCatalog = useListSupportedCurrencies();
  const supportedCurrencies = currencyCatalog.data?.items ?? [];
  const inv = useInvalidateAll();
  const [type, setType] = useState<'fixed' | 'customer_choice'>('fixed');
  const [currency, setCurrency] = useState('USD');
  const selectedCurrency = supportedCurrencies.find((item) => item.code === currency);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedCurrency) return;
    const f = new FormData(e.currentTarget);
    const desc = String(f.get('desc') || '').trim();
    const amount = Number(f.get('amount'));
    const exp = String(f.get('exp') || '');
    create.mutate({ data: { name: String(f.get('name')).trim(), amountType: type, currency: String(f.get('cur')), ...(desc ? { description: desc } : {}), ...(type === 'fixed' ? { amount } : {}), ...(exp ? { expiresAt: new Date(exp).toISOString() } : {}) } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title="New payment link" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Note>Fixed-price links keep this currency. Customer-choice links let the payer choose a supported currency; the entered amount is charged in that currency without automatic conversion.</Note>
    <Field label="Name"><input name="name" required data-testid="input-link-name" /></Field>
    <Field label="Description"><input name="desc" /></Field>
    <div className="form-grid"><Field label="Pricing"><select value={type} onChange={(e) => setType(e.target.value as 'fixed')}><option value="fixed">Fixed amount</option><option value="customer_choice">Customer enters amount</option></select></Field>
      <Field label="Link currency"><select name="cur" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={currencyCatalog.isLoading || !supportedCurrencies.length}>{supportedCurrencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}{item.collectionReady ? '' : ' · unavailable'}</option>)}</select></Field></div>
    {currencyCatalog.isLoading && <span className="sub">Loading supported currencies and payment availability…</span>}
    {currencyCatalog.isError && <Note tone="warn">Supported currencies could not be loaded. <Btn variant="secondary" disabled={currencyCatalog.isFetching} onClick={() => { void currencyCatalog.refetch(); }}>{currencyCatalog.isFetching ? 'Checking…' : 'Retry'}</Btn></Note>}
    {selectedCurrency && !selectedCurrency.collectionReady && <Note tone="warn">Checkout in {selectedCurrency.code} is not currently available. You can create the link now; payments will be unavailable until this currency route is enabled.</Note>}
    {type === 'fixed' && <Field label="Amount"><input name="amount" type="number" step={currencyAmountStep(currency)} min={currencyMinorUnits(currency) === 0 ? '1' : '0.01'} required data-testid="input-link-amount" /></Field>}
    <Field label="Expires" hint="Optional"><input name="exp" type="datetime-local" /></Field>
    <Err error={create.error} />
    <Btn type="submit" disabled={create.isPending || currencyCatalog.isLoading || !selectedCurrency} testId="button-save-link">{create.isPending && <LoaderCircle size={14} className="spin" />}Create link</Btn>
  </form></Modal>;
}

export function MerchantTransactionsPage() { return <Gate need="merchant"><TxInner /></Gate>; }
function TxInner() {
  const [page, setPage] = useState(1);
  const q = useListMerchantTransactions({ page, perPage: 20 });
  const items = q.data?.items ?? [];
  return <>
    <Heading eyebrow="MERCHANT" title="Transactions" subtitle="Payments belonging to your merchant account." />
    <Async q={q} empty={!items.length} emptyTitle="No transactions yet" emptyBody="Payments made through your links or API appear here.">
      <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Customer</th><th className="num">Amount</th><th className="num">Fee</th><th>Status</th><th>Provider</th><th>Created</th></tr></thead><tbody>
        {items.map((t) => <tr key={t.id} data-testid={`row-tx-${t.id}`}><td className="mono" style={{ fontSize: 12 }}>{t.reference}</td><td>{t.customerEmail}<span className="sub">{t.customerName}</span></td><td className="num">{money(t.amount, t.currency)}</td><td className="num">{t.fee != null ? money(t.fee, t.currency) : '-'}</td><td><Pill value={t.status} /></td><td>{nice(t.provider)}</td><td>{fmtDate(t.createdAt)}</td></tr>)}
      </tbody></table></div>
      {q.data && <Pager page={page} total={q.data.total} perPage={q.data.perPage || 20} onPage={setPage} />}
    </Async>
  </>;
}

export function MerchantPayoutsPage() { return <Gate need="merchant"><PayoutsInner /></Gate>; }
function PayoutsInner() {
  const q = useListMerchantPayouts();
  const items = q.data?.items ?? [];
  return <>
    <Heading eyebrow="MERCHANT" title="Admin-operated payouts" subtitle="Payouts the platform team has sent on your behalf. This is a read-only record; there is no balance shown and no automatic withdrawal." />
    <Async q={q} empty={!items.length} emptyTitle="No payouts attributed to you" emptyBody="Payouts operated by an administrator for your account appear here.">
      <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Recipient</th><th className="num">Amount</th><th className="num">Fee</th><th>Status</th><th>Method</th><th>Created</th></tr></thead><tbody>
        {items.map((p) => <tr key={p.id} data-testid={`row-payout-${p.id}`}><td className="mono" style={{ fontSize: 12 }}>{p.reference}</td><td>{p.accountName}<span className="sub">{p.maskedAccount}</span></td><td className="num">{money(p.amount, p.currency)}</td><td className="num">{p.fee != null ? money(p.fee, p.currency) : '-'}</td><td><Pill value={p.status} /></td><td>{nice(p.method)}</td><td>{fmtDate(p.createdAt)}</td></tr>)}
      </tbody></table></div>
    </Async>
  </>;
}
