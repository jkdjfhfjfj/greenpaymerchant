import { useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, LoaderCircle, Plus, Trash2, Webhook } from 'lucide-react';
import {
  useListMerchantApiKeys, useCreateMerchantApiKey, useRevokeMerchantApiKey,
  useListMerchantWebhookEndpoints, useCreateMerchantWebhookEndpoint, useDeleteMerchantWebhookEndpoint,
  useGetMerchantFxQuote, useGetMerchantFees, useListMerchantWalletFxRates,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CopyBtn, CURRENCIES, Confirm, Err, Field, Gate, Heading, Modal, Note, Pill, fmtDate, money, useInvalidateAll } from '@/components/kit';
import { useMerchantActionCapability } from '@/hooks/use-merchant-action-controls';

const SCOPES = ['read', 'payment_links:write', 'payments:write'] as const;
const EVENTS = ['payment.success', 'payment.failed', 'payment.refunded'] as const;

function Secret({ title, secret, hint, onClose }: { title: string; secret: string; hint: string; onClose: () => void }) {
  return <Modal title={title} onClose={onClose}><div className="secret-box"><small>{hint}</small><code data-testid="text-secret">{secret}</code><div><CopyBtn text={secret} /></div></div><Btn onClick={onClose}>I have stored it</Btn></Modal>;
}

export function DevelopersPage() { return <Gate need="merchant"><Inner /></Gate>; }
function Inner() {
  const inv = useInvalidateAll();
  const capabilities = useMerchantActionCapability();
  const mayManageApi = capabilities.can('apiAccess');
  const keys = useListMerchantApiKeys();
  const hooks = useListMerchantWebhookEndpoints();
  const mk = useCreateMerchantApiKey();
  const rk = useRevokeMerchantApiKey();
  const mh = useCreateMerchantWebhookEndpoint();
  const dh = useDeleteMerchantWebhookEndpoint();
  const [keyOpen, setKeyOpen] = useState(false);
  const [hookOpen, setHookOpen] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string; hint: string } | null>(null);
  const [revoke, setRevoke] = useState<number | null>(null);
  const [rmHook, setRmHook] = useState<number | null>(null);
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [events, setEvents] = useState<string[]>(['payment.success']);
  const toggle = (arr: string[], v: string, set: (a: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const origin = window.location.origin;

  function createKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    mk.mutate({ data: { name, scopes: scopes as never } }, { onSuccess: (r) => { void inv(); setKeyOpen(false); setSecret({ title: 'API key created', value: r.secret, hint: 'This secret is shown once. Copy it now; it cannot be retrieved later.' }); } });
  }
  function createHook(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get('url')).trim();
    mh.mutate({ data: { url, events: events as never } }, { onSuccess: (r) => { void inv(); setHookOpen(false); setSecret({ title: 'Webhook endpoint created', value: r.signingSecret, hint: 'Signing secret, shown once. Use it to verify delivery signatures.' }); } });
  }
  const kItems = keys.data?.items ?? [];
  const hItems = hooks.data?.items ?? [];
  return <>
    <Heading eyebrow="DEVELOPERS" title="API access" subtitle="Keys, webhook destinations and the endpoints they unlock." action={<a className="btn btn-secondary" href="/developers/docs">API docs &amp; playground</a>} />
    {capabilities.isLoading && <Note>Loading current API-access permissions…</Note>}
    {capabilities.isError && <Note tone="danger">API-access permissions could not be verified. Retry before creating keys or webhooks.</Note>}
    {!capabilities.isLoading && !capabilities.isError && !mayManageApi && <Note tone="warn">{capabilities.disabledReason('apiAccess')}</Note>}
    <Card title="API keys" subtitle="Keys authenticate with Bearer tokens" action={<Btn small disabled={!mayManageApi} onClick={() => { setScopes(['read']); mk.reset(); setKeyOpen(true); }} testId="button-new-key"><Plus size={14} />New key</Btn>}>
      <Async q={keys} empty={!kItems.length} emptyTitle="No API keys" emptyBody="Create a key to call the merchant API."><div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>State</th><th /></tr></thead><tbody>
        {kItems.map((k) => <tr key={k.id} data-testid={`row-key-${k.id}`}><td><strong>{k.name}</strong><span className="sub">Created {fmtDate(k.createdAt)}</span></td><td className="mono">{k.prefix}...</td><td>{k.scopes.join(', ')}</td><td>{fmtDate(k.lastUsedAt)}</td><td><Pill value={k.revokedAt ? 'revoked' : 'active'} /></td><td><div className="row-actions">{!k.revokedAt && <Btn variant="danger" small onClick={() => setRevoke(k.id)}><Trash2 size={13} />Revoke</Btn>}</div></td></tr>)}
      </tbody></table></div></Async>
    </Card>
    <Card title="Webhook destinations" subtitle="Receive signed payment events" action={<Btn small disabled={!mayManageApi} onClick={() => { setEvents(['payment.success']); mh.reset(); setHookOpen(true); }} testId="button-new-webhook"><Webhook size={14} />Add endpoint</Btn>}>
      <Async q={hooks} empty={!hItems.length} emptyTitle="No webhook endpoints" emptyBody="Add an HTTPS URL to be notified of payment events."><div className="table-wrap"><table className="dt"><thead><tr><th>URL</th><th>Events</th><th>State</th><th /></tr></thead><tbody>
        {hItems.map((h) => <tr key={h.id} data-testid={`row-webhook-${h.id}`}><td className="mono" style={{ fontSize: 12 }}>{h.url}<span className="sub">Added {fmtDate(h.createdAt)}</span></td><td>{h.events.join(', ')}</td><td><Pill value={h.active ? 'active' : 'disabled'} /></td><td><div className="row-actions"><Btn variant="danger" small onClick={() => setRmHook(h.id)}><Trash2 size={13} />Delete</Btn></div></td></tr>)}
      </tbody></table></div></Async>
    </Card>
    <Card title="Quick reference" subtitle="Replace PAYRAIL_KEY with a key secret">
      <div className="form-stack">
        <Note>Read scope: GET /api/v1/merchant, /api/v1/transactions, /api/v1/transactions/:reference, /api/v1/fx-quote, /api/v1/fees. payment_links:write: POST /api/v1/payment-links. payments:write: POST /api/v1/transactions (requires an Idempotency-Key header of 8 to 128 characters) and POST /api/v1/transactions/:reference/verify.</Note>
        <pre className="code">{`# Merchant profile
curl ${origin}/api/v1/merchant \\
  -H "Authorization: Bearer PAYRAIL_KEY"

# List payment links
curl ${origin}/api/v1/payment-links \\
  -H "Authorization: Bearer PAYRAIL_KEY"

# Create a payment link (needs payment_links:write)
curl -X POST ${origin}/api/v1/payment-links \\
  -H "Authorization: Bearer PAYRAIL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Invoice 1042","amountType":"fixed","amount":150,"currency":"USD"}'

# Create a payment (needs payments:write; Idempotency-Key is required)
curl -X POST ${origin}/api/v1/transactions \\
  -H "Authorization: Bearer PAYRAIL_KEY" \\
  -H "Idempotency-Key: order-1042-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":150,"currency":"USD","customerEmail":"buyer@example.com"}'

# Read and verify a payment
curl ${origin}/api/v1/transactions/REFERENCE \\
  -H "Authorization: Bearer PAYRAIL_KEY"
curl -X POST ${origin}/api/v1/transactions/REFERENCE/verify \\
  -H "Authorization: Bearer PAYRAIL_KEY"

# FX quote calculation and fee schedule
curl "${origin}/api/v1/fx-quote?amount=100&from=USD&to=KES" \\
  -H "Authorization: Bearer PAYRAIL_KEY"
curl ${origin}/api/v1/fees -H "Authorization: Bearer PAYRAIL_KEY"

# Transactions (paginated)
curl "${origin}/api/v1/transactions?page=1&perPage=20" \\
  -H "Authorization: Bearer PAYRAIL_KEY"`}</pre>
      </div>
    </Card>
    {keyOpen && <Modal title="New API key" onClose={() => setKeyOpen(false)}><form className="form-stack" onSubmit={createKey}>
      <Field label="Name"><input name="name" required minLength={2} maxLength={100} data-testid="input-key-name" /></Field>
      <Field label="Scopes"><div className="chips">{SCOPES.map((s) => <label key={s} className={`chip ${scopes.includes(s) ? 'on' : ''}`}><input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(scopes, s, setScopes)} />{s}</label>)}</div></Field>
      <Err error={mk.error} />
      <Btn type="submit" disabled={!mayManageApi || mk.isPending || !scopes.length} testId="button-create-key">{mk.isPending ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}Create key</Btn>
    </form></Modal>}
    {hookOpen && <Modal title="Add webhook endpoint" onClose={() => setHookOpen(false)}><form className="form-stack" onSubmit={createHook}>
      <Field label="Endpoint URL"><input name="url" type="url" required placeholder="https://example.com/hooks/payrail" data-testid="input-webhook-url" /></Field>
      <Field label="Events"><div className="chips">{EVENTS.map((s) => <label key={s} className={`chip ${events.includes(s) ? 'on' : ''}`}><input type="checkbox" checked={events.includes(s)} onChange={() => toggle(events, s, setEvents)} />{s}</label>)}</div></Field>
      <Err error={mh.error} />
      <Btn type="submit" disabled={!mayManageApi || mh.isPending || !events.length} testId="button-create-webhook">{mh.isPending && <LoaderCircle size={14} className="spin" />}Create endpoint</Btn>
    </form></Modal>}
    {secret && <Secret title={secret.title} secret={secret.value} hint={secret.hint} onClose={() => setSecret(null)} />}
    {revoke !== null && <Confirm title="Revoke API key" body="Requests using this key will be rejected immediately. This cannot be undone." confirmLabel="Revoke key" pending={rk.isPending} error={rk.error} onClose={() => { setRevoke(null); rk.reset(); }} onConfirm={() => rk.mutate({ id: revoke }, { onSuccess: () => { void inv(); setRevoke(null); } })} />}
    {rmHook !== null && <Confirm title="Delete webhook endpoint" body="Events will no longer be delivered to this URL." confirmLabel="Delete endpoint" pending={dh.isPending} error={dh.error} onClose={() => { setRmHook(null); dh.reset(); }} onConfirm={() => dh.mutate({ id: rmHook }, { onSuccess: () => { void inv(); setRmHook(null); } })} />}
  </>;
}

export function ExchangePage() { return <Gate need="merchant"><ExchangeInner /></Gate>; }
function ExchangeInner() {
  const [form, setForm] = useState({ amount: '', from: 'USD', to: 'KES' });
  const [ratesBase, setRatesBase] = useState('USD');
  const [params, setParams] = useState<{ amount: number; from: string; to: string } | null>(null);
  const q = useGetMerchantFxQuote(params ?? { amount: 1, from: 'USD', to: 'KES' }, { query: { enabled: !!params, retry: false, queryKey: ['/api/merchant/fx-quote', params] } });
  const rates = useListMerchantWalletFxRates(
    { base: ratesBase },
    { query: { queryKey: ['merchant-wallet-fx-rates', ratesBase], refetchOnMount: 'always', staleTime: 30_000 } },
  );
  const fees = useGetMerchantFees();
  const f = fees.data?.schedule;
  const quote = params ? q.data : undefined;
  return <>
    <Heading eyebrow="EXCHANGE" title="Currency quotes" subtitle="A calculation from active admin-managed rates and your fee schedule. This is a quote, not a provider FX settlement; no funds are converted." />
    <div className="split">
      <Card title="Calculate a quote">
        <form className="form-stack" onSubmit={(e) => { e.preventDefault(); const a = Number(form.amount); if (a > 0) setParams({ amount: a, from: form.from, to: form.to }); }}>
          <Field label="Amount"><input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="input-fx-amount" /></Field>
          <div className="form-grid">
            <Field label="From"><select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} data-testid="select-fx-from">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="To"><select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} data-testid="select-fx-to">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
          <Btn type="submit" disabled={q.isFetching} testId="button-get-quote">{q.isFetching && <LoaderCircle size={14} className="spin" />}Get quote</Btn>
        </form>
      </Card>
      <div>
        {f && <Card title="Fees applied"><div className="kv"><div><span>Percentage</span><strong>{f.percentage}%</strong></div><div><span>Flat</span><strong>{money(f.flatAmount, f.currency)}</strong></div><div><span>FX markup</span><strong>{f.fxMarkupBps} bps</strong></div></div></Card>}
        {params && q.isError && <Err error={q.error} />}
        {quote && <div className="quote-hero" data-testid="card-fx-quote"><small>{money(quote.amount, quote.from)} converts to</small><div className="big">{money(quote.convertedAmount, quote.to)}</div><small>Rate {quote.rate} / effective {quote.effectiveRate} - platform fee {money(quote.platformFee, quote.from)}</small><small>Source: {quote.source}. Expires {fmtDate(quote.expiresAt)}</small>{quote.note && <small>{quote.note}</small>}</div>}
        {!quote && !q.isError && <div className="empty-state"><strong>No quote yet</strong><span>Enter an amount and pair to calculate.</span></div>}
      </div>
    </div>
    <Card title="All live reference rates" subtitle={`One ${ratesBase} equals the listed amount of target currency. Rates are reference data, not a promise of external FX settlement.`} action={<Btn variant="secondary" onClick={() => { void rates.refetch(); }} disabled={rates.isFetching}>Refresh rates</Btn>}>
      <div className="form-grid">
        <Field label="Base currency">
          <select value={ratesBase} onChange={(event) => setRatesBase(event.target.value)} data-testid="select-fx-rates-base">
            {CURRENCIES.filter((currency) => currency !== 'SLL').map((currency) => <option key={currency}>{currency}</option>)}
          </select>
        </Field>
        <div className="notice"><CheckCircle2 size={16} /><div>Source and publication date are shown for each rate. SLL is omitted because its legacy amount scale has not been verified.</div></div>
      </div>
      <Async q={rates} empty={!rates.data?.items.length} emptyTitle="No current rates" emptyBody="Current market reference rates could not be loaded. Retry when a rate provider is available.">
        <div className="table-wrap"><table className="dt">
          <thead><tr><th>Pair</th><th className="num">Rate</th><th>Source</th><th>Published</th><th>Fetched</th></tr></thead>
          <tbody>{(rates.data?.items ?? []).map((item) => <tr key={item.currency}>
            <td><strong>1 {ratesBase} = {item.currency}</strong></td>
            <td className="num mono">{item.rate}</td>
            <td>{item.source}</td>
            <td>{item.sourceDate}</td>
            <td>{fmtDate(item.fetchedAt)}</td>
          </tr>)}</tbody>
        </table></div>
      </Async>
    </Card>
  </>;
}
