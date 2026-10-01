import { useEffect, useState, type FormEvent } from 'react';
import { Search, LoaderCircle, Pencil, Trash2, Plus } from 'lucide-react';
import {
  useGetAdminSummary, useListAdminMerchants, useUpdateAdminMerchant, useGetAdminPlatformSettings, useUpdateAdminPlatformSettings,
  useListAdminAuditLog, useListAdminFeeSchedules, useUpdateAdminFeeSchedule, useListAdminFxRates, useCreateAdminFxRate, useUpdateAdminFxRate,
  useListAdminProviderCredentials, useSaveAdminProviderCredentials, useDeleteAdminProviderCredentials,
  type AdminMerchant, type AdminFxRate, type AdminFeeSchedule, type ProviderCredential, type ListAdminMerchantsParams, type PlatformSettings,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CURRENCIES, Confirm, Err, Field, Gate, Heading, Modal, Note, Pager, Pill, Switch, fmtDate, money, nice, useInvalidateAll } from '@/components/kit';

const G = ({ children }: { children: React.ReactNode }) => <Gate need="admin">{children}</Gate>;

export function AdminSummaryPage() { return <G><SummaryInner /></G>; }
function SummaryInner() {
  const q = useGetAdminSummary();
  const d = q.data;
  const tiles: [string, number | undefined, string][] = d ? [['Merchants', d.totalMerchants, 'mint'], ['Active', d.activeMerchants, 'cream'], ['Pending KYC', d.pendingKyc, 'peach'], ['Suspended', d.suspendedMerchants, 'peach'], ['Active API keys', d.activeApiKeys, 'blue'], ['Credential providers', d.credentialProviders, 'blue'], ['Transactions', d.totalTransactions, 'mint']] : [];
  return <><Heading eyebrow="ADMIN" title="Platform summary" subtitle="Merchants, verification, access and provider configuration at a glance." />
    <Async q={q}><div className="metric-grid">{tiles.map(([t, v, tone]) => <section key={t} className={`metric-card tone-${tone}`}><div className="metric-top"><span>{t}</span></div><div className="metric-value" data-testid={`metric-${t.toLowerCase().replaceAll(' ', '-')}`}>{(v ?? 0).toLocaleString()}</div></section>)}</div></Async></>;
}

export function AdminMerchantsPage() { return <G><MerchantsInner /></G>; }
function MerchantsInner() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [kyc, setKyc] = useState('');
  const params: ListAdminMerchantsParams = { ...(search ? { search } : {}), ...(status ? { status: status as never } : {}), ...(kyc ? { kycStatus: kyc as never } : {}) };
  const q = useListAdminMerchants(params);
  const [edit, setEdit] = useState<AdminMerchant | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Merchants" subtitle="Review, activate, suspend and annotate merchant accounts." />
    <div className="toolbar"><div className="search-box"><Search size={14} /><input placeholder="Search business name" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-merchant-search" /></div>
      <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="select-merchant-status"><option value="">Any status</option>{['pending', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{nice(s)}</option>)}</select>
      <select value={kyc} onChange={(e) => setKyc(e.target.value)} data-testid="select-merchant-kyc"><option value="">Any verification</option>{['not_started', 'pending', 'in_review', 'approved', 'declined', 'expired'].map((s) => <option key={s} value={s}>{nice(s)}</option>)}</select></div>
    <Async q={q} empty={!items.length} emptyTitle="No merchants match" emptyBody="Adjust the search or filters."><div className="table-wrap"><table className="dt"><thead><tr><th>Business</th><th>Country</th><th>Base</th><th>Status</th><th>Verification</th><th>Created</th><th /></tr></thead><tbody>
      {items.map((m) => <tr key={m.id} data-testid={`row-merchant-${m.id}`}><td><strong>{m.businessName}</strong><span className="sub">{m.riskNote || m.ownerUserId}</span></td><td>{m.country}</td><td>{m.baseCurrency}</td><td><Pill value={m.status} /></td><td><Pill value={m.kycStatus} /></td><td>{fmtDate(m.createdAt)}</td><td><div className="row-actions"><Btn variant="secondary" small onClick={() => setEdit(m)}><Pencil size={13} />Edit</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <MerchantEdit m={edit} onClose={() => setEdit(null)} />}</>;
}
function MerchantEdit({ m, onClose }: { m: AdminMerchant; onClose: () => void }) {
  const up = useUpdateAdminMerchant();
  const inv = useInvalidateAll();
  const [flags, setFlags] = useState({ paymentsEnabled: m.paymentsEnabled ?? true, payoutsEnabled: m.payoutsEnabled ?? true, refundsEnabled: m.refundsEnabled ?? true, apiAccessEnabled: m.apiAccessEnabled ?? true });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const risk = String(f.get('risk') || '').trim();
    up.mutate({ id: m.id, data: { businessName: String(f.get('name')).trim(), status: String(f.get('status')) as never, baseCurrency: String(f.get('cur')), riskNote: risk || null, paymentsEnabled: flags.paymentsEnabled, payoutsEnabled: flags.payoutsEnabled, refundsEnabled: flags.refundsEnabled, apiAccessEnabled: flags.apiAccessEnabled } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title={`Edit ${m.businessName}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="Business name"><input name="name" defaultValue={m.businessName} required minLength={2} maxLength={150} data-testid="input-edit-name" /></Field>
    <div className="form-grid"><Field label="Status"><select name="status" defaultValue={m.status} data-testid="select-edit-status">{['pending', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{nice(s)}</option>)}</select></Field>
      <Field label="Base currency"><select name="cur" defaultValue={m.baseCurrency}>{[...new Set([m.baseCurrency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select></Field></div>
    <Field label="Risk notes" hint="Internal only, 1000 characters"><textarea name="risk" defaultValue={m.riskNote ?? ''} maxLength={1000} data-testid="input-edit-risk" /></Field>
    <Field label="Capabilities">{([['paymentsEnabled', 'Payments'], ['payoutsEnabled', 'Payouts'], ['refundsEnabled', 'Refunds'], ['apiAccessEnabled', 'API access']] as const).map(([k, t]) => <div className="setting-row" key={k} style={{ padding: '7px 0' }}><span>{t}</span><Switch on={flags[k]} label={`merchant ${t}`} onChange={(v) => setFlags({ ...flags, [k]: v })} /></div>)}</Field>
    <Err error={up.error} /><Btn type="submit" disabled={up.isPending} testId="button-save-merchant">{up.isPending && <LoaderCircle size={14} className="spin" />}Save changes</Btn></form></Modal>;
}

export function AdminFeesPage() { return <G><FeesInner /></G>; }
function FeesInner() {
  const q = useListAdminFeeSchedules();
  const [edit, setEdit] = useState<{ s: AdminFeeSchedule | null } | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Fee schedules" subtitle="A global default plus optional per-merchant overrides." action={<Btn onClick={() => setEdit({ s: null })} testId="button-new-fee"><Plus size={15} />Set schedule</Btn>} />
    <Async q={q} empty={!items.length} emptyTitle="No fee schedules saved" emptyBody="Without a saved schedule, merchants see the platform default reported by the server." emptyAction={<Btn onClick={() => setEdit({ s: null })}>Set global schedule</Btn>}><div className="table-wrap"><table className="dt"><thead><tr><th>Scope</th><th className="num">Percentage</th><th className="num">Flat</th><th className="num">FX markup</th><th>Updated</th><th /></tr></thead><tbody>
      {items.map((s) => <tr key={s.id} data-testid={`row-fee-${s.id}`}><td><strong>{s.merchantId === null ? 'Global default' : `Merchant #${s.merchantId}`}</strong></td><td className="num">{s.percentage}%</td><td className="num">{money(s.flatAmount, s.currency)}</td><td className="num">{s.fxMarkupBps} bps</td><td>{fmtDate(s.updatedAt)}</td><td><div className="row-actions"><Btn variant="secondary" small onClick={() => setEdit({ s })}><Pencil size={13} />Edit</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <FeeEdit s={edit.s} onClose={() => setEdit(null)} />}</>;
}
function FeeEdit({ s, onClose }: { s: AdminFeeSchedule | null; onClose: () => void }) {
  const up = useUpdateAdminFeeSchedule();
  const inv = useInvalidateAll();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const mid = String(f.get('mid')).trim();
    up.mutate({ data: { merchantId: mid ? Number(mid) : null, percentage: Number(f.get('pct')), flatAmount: Number(f.get('flat')), currency: String(f.get('cur')), fxMarkupBps: Number(f.get('bps')) } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title={s ? 'Edit fee schedule' : 'Set fee schedule'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="Merchant ID" hint="Leave blank for the global default"><input name="mid" type="number" min="1" defaultValue={s?.merchantId ?? ''} readOnly={!!s} data-testid="input-fee-merchant" /></Field>
    <div className="form-grid"><Field label="Percentage (0-100)"><input name="pct" type="number" step="0.01" min="0" max="100" required defaultValue={s?.percentage ?? ''} data-testid="input-fee-pct" /></Field>
      <Field label="Flat amount"><input name="flat" type="number" step="0.01" min="0" required defaultValue={s?.flatAmount ?? 0} /></Field>
      <Field label="Flat currency"><select name="cur" defaultValue={s?.currency ?? 'USD'}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
      <Field label="FX markup (bps)"><input name="bps" type="number" step="1" min="0" max="10000" required defaultValue={s?.fxMarkupBps ?? 0} /></Field></div>
    <Err error={up.error} /><Btn type="submit" disabled={up.isPending} testId="button-save-fee">{up.isPending && <LoaderCircle size={14} className="spin" />}Save schedule</Btn></form></Modal>;
}

export function AdminExchangePage() { return <G><RatesInner /></G>; }
function RatesInner() {
  const q = useListAdminFxRates();
  const up = useUpdateAdminFxRate();
  const inv = useInvalidateAll();
  const [edit, setEdit] = useState<{ r: AdminFxRate | null } | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Exchange rates" subtitle="Rates feed merchant quotes only. They do not settle funds with a provider." action={<Btn onClick={() => setEdit({ r: null })} testId="button-new-rate"><Plus size={15} />New rate</Btn>} />
    <Err error={up.error} />
    <Async q={q} empty={!items.length} emptyTitle="No exchange rates" emptyBody="Merchants cannot get quotes until an active rate exists." emptyAction={<Btn onClick={() => setEdit({ r: null })}>Create rate</Btn>}><div className="table-wrap"><table className="dt"><thead><tr><th>Pair</th><th className="num">Rate</th><th>Source</th><th>Effective</th><th>Expires</th><th>State</th><th /></tr></thead><tbody>
      {items.map((r) => <tr key={r.id} data-testid={`row-rate-${r.id}`}><td><strong>{r.from} / {r.to}</strong></td><td className="num mono">{r.rate}</td><td>{r.source}</td><td>{fmtDate(r.effectiveAt)}</td><td>{fmtDate(r.expiresAt)}</td><td><Pill value={r.active ? 'active' : 'disabled'} /></td><td><div className="row-actions"><Btn variant="secondary" small onClick={() => setEdit({ r })}><Pencil size={13} />Edit</Btn><Btn variant="quiet" small disabled={up.isPending} onClick={() => up.mutate({ id: r.id, data: { active: !r.active } }, { onSuccess: () => { void inv(); } })}>{r.active ? 'Deactivate' : 'Activate'}</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <RateEdit r={edit.r} onClose={() => setEdit(null)} />}</>;
}
function RateEdit({ r, onClose }: { r: AdminFxRate | null; onClose: () => void }) {
  const create = useCreateAdminFxRate();
  const up = useUpdateAdminFxRate();
  const inv = useInvalidateAll();
  const err = create.error || up.error;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const exp = String(f.get('exp') || '');
    const expiresAt = exp ? new Date(exp).toISOString() : null;
    const done = { onSuccess: () => { void inv(); onClose(); } };
    if (r) up.mutate({ id: r.id, data: { rate: Number(f.get('rate')), expiresAt } }, done);
    else create.mutate({ data: { from: String(f.get('from')), to: String(f.get('to')), rate: Number(f.get('rate')), source: String(f.get('source')).trim(), expiresAt } }, done);
  }
  return <Modal title={r ? `Edit ${r.from} / ${r.to}` : 'New exchange rate'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    {!r && <div className="form-grid"><Field label="From"><select name="from" defaultValue="USD">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field><Field label="To"><select name="to" defaultValue="KES">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field></div>}
    <Field label="Rate" hint="Units of the target currency per one unit of source"><input name="rate" type="number" step="any" min="0" required defaultValue={r?.rate ?? ''} data-testid="input-rate" /></Field>
    {!r && <Field label="Source"><input name="source" required minLength={2} maxLength={150} placeholder="Treasury desk" data-testid="input-rate-source" /></Field>}
    <Field label="Expires" hint="Optional"><input name="exp" type="datetime-local" defaultValue={r?.expiresAt ? r.expiresAt.slice(0, 16) : ''} /></Field>
    <Err error={err} /><Btn type="submit" disabled={create.isPending || up.isPending} testId="button-save-rate">{(create.isPending || up.isPending) && <LoaderCircle size={14} className="spin" />}Save rate</Btn></form></Modal>;
}

const CRED_FIELDS: Record<string, string[]> = {
  paystack: ['PAYSTACK_SECRET_KEY'], payhero: ['PAYHERO_BASIC_AUTH', 'PAYHERO_CHANNEL_ID'], payzaapi: ['PAYZAAPI_API_KEY', 'PAYZA_PUBLIC_KEY', 'PAYZA_SECRET_KEY', 'PAYZA_WEBHOOK_SECRET'],
  didit: ['DIDIT_API_KEY', 'DIDIT_WEBHOOK_SECRET', 'DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID'],
};
const OPTIONAL = new Set(['DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID']);
const REQUIRED_HINT: Record<string, string> = { PAYZA_PUBLIC_KEY: 'Required for the existing Payza rail', PAYZA_SECRET_KEY: 'Required for the existing Payza rail' };
const PLAIN = new Set(['PAYZA_PUBLIC_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID', 'PAYHERO_CHANNEL_ID']);

export function AdminCredentialsPage() { return <G><CredInner /></G>; }
function CredInner() {
  const q = useListAdminProviderCredentials();
  const save = useSaveAdminProviderCredentials();
  const inv = useInvalidateAll();
  const [edit, setEdit] = useState<ProviderCredential | null>(null);
  const [rm, setRm] = useState<ProviderCredential | null>(null);
  const del = useDeleteAdminProviderCredentials();
  const [off, setOff] = useState<ProviderCredential | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Provider credentials" subtitle="Secrets are encrypted at rest. Only masked values are ever shown." />
    {q.data && !q.data.vaultReady && <Note tone="warn">The encrypted vault is not ready on the server. Saving credentials will fail until vault encryption is configured.</Note>}
    <Err error={save.error} />
    <Async q={q} empty={!items.length} emptyTitle="No providers reported" emptyBody="The server returned no provider entries."><div className="cards" style={{ marginTop: 12 }}>
      {items.map((c) => <div className="card-lite" key={c.provider} data-testid={`card-provider-${c.provider}`}>
        <header><strong>{nice(c.provider)}</strong><Pill value={c.configured ? (c.enabled ? 'ready' : 'disabled') : 'not_started'} /></header>
        <span className="sub">Storage: {nice(c.storage)} {c.updatedAt ? `- updated ${fmtDate(c.updatedAt)}` : ''}</span>
        <div className="fields-list">{[...c.fields, ...(CRED_FIELDS[c.provider] ?? []).filter((n) => !c.fields.some((f) => f.name === n)).map((n) => ({ name: n, present: false, masked: '' }))].map((f) => <div key={f.name}><span>{f.name}</span><code>{f.present ? f.masked : 'not set'}</code></div>)}</div>
        <div className="setting-row" style={{ padding: '6px 0' }}><span>Enabled</span><Switch on={c.enabled} label={`${c.provider} enabled`} disabled={!c.configured || save.isPending} onChange={(v) => { if (v) save.mutate({ provider: c.provider, data: { enabled: true, credentials: {} } }, { onSuccess: () => { void inv(); } }); else setOff(c); }} /></div>
        <div className="row-actions"><Btn variant="secondary" small onClick={() => { save.reset(); setEdit(c); }} testId={`button-edit-${c.provider}`}><Pencil size={13} />{c.configured ? 'Replace' : 'Add'}</Btn>{c.storage === 'encrypted_vault' && <Btn variant="danger" small onClick={() => setRm(c)}><Trash2 size={13} />Delete</Btn>}</div>
      </div>)}</div></Async>
    {off && <Confirm title={`Disable ${nice(off.provider)}`} body="Routes and features that depend on this provider stop working immediately. Stored credentials are kept." confirmLabel="Disable provider" pending={save.isPending} error={save.error} onClose={() => { setOff(null); save.reset(); }} onConfirm={() => save.mutate({ provider: off.provider, data: { enabled: false, credentials: {} } }, { onSuccess: () => { void inv(); setOff(null); } })} />}
    {edit && <CredEdit c={edit} onClose={() => setEdit(null)} />}
    {rm && <Confirm title={`Delete ${nice(rm.provider)} credentials`} body="Stored secrets are removed from the vault. The provider stops working unless environment credentials exist." confirmLabel="Delete credentials" pending={del.isPending} error={del.error} onClose={() => { setRm(null); del.reset(); }} onConfirm={() => del.mutate({ provider: rm.provider }, { onSuccess: () => { void inv(); setRm(null); } })} />}</>;
}
function CredEdit({ c, onClose }: { c: ProviderCredential; onClose: () => void }) {
  const save = useSaveAdminProviderCredentials();
  const inv = useInvalidateAll();
  const [enabled, setEnabled] = useState(true);
  const names = [...new Set([...c.fields.map((f) => f.name), ...(CRED_FIELDS[c.provider] ?? [])])];
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credentials: Record<string, string> = {};
    names.forEach((n) => { const v = String(f.get(n) || '').trim(); if (v) credentials[n] = v; });
    save.mutate({ provider: c.provider, data: { enabled, credentials } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title={`${nice(c.provider)} credentials`} description="Values replace what is stored. Existing secrets are never displayed." onClose={onClose}><form className="form-stack" onSubmit={submit} autoComplete="off">
    {names.map((n) => <Field key={n} label={n} hint={OPTIONAL.has(n) ? 'Optional here, but required before verification sessions can start' : REQUIRED_HINT[n]}><input name={n} type={PLAIN.has(n) ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={c.fields.find((f) => f.name === n)?.present ? c.fields.find((f) => f.name === n)?.masked : ''} data-testid={`input-${n}`} /></Field>)}
    <div className="setting-row"><span>Enable provider</span><Switch on={enabled} onChange={setEnabled} label="enable provider" /></div>
    <Err error={save.error} /><Btn type="submit" disabled={save.isPending} testId="button-save-credentials">{save.isPending && <LoaderCircle size={14} className="spin" />}Save to vault</Btn></form></Modal>;
}

type PlatformFlagSetting = Pick<PlatformSettings, 'newMerchantSignups' | 'paymentsEnabled' | 'payoutsEnabled' | 'refundsEnabled' | 'apiAccessEnabled' | 'kycRequired'>;
const SETTINGS: [keyof PlatformFlagSetting, string, string][] = [
  ['newMerchantSignups', 'New merchant sign-ups', 'Allow new businesses to register.'],
  ['paymentsEnabled', 'Payments', 'Allow new collections to start.'],
  ['payoutsEnabled', 'Payouts', 'Allow payouts to be requested.'],
  ['refundsEnabled', 'Refunds', 'Allow refunds to be recorded.'],
  ['apiAccessEnabled', 'API access', 'Allow API key authenticated requests.'],
  ['kycRequired', 'Verification required', 'Require approved KYC before activity.'],
];
export function AdminSettingsPage() { return <G><SettingsInner /></G>; }
type BrandingFormValues = Pick<PlatformSettings, 'platformName' | 'baseCurrency' | 'contactEmail' | 'contactPhone' | 'contactAddress' | 'contactWhatsapp'> & {
  logoUrl: string;
  faviconUrl: string;
};
function SettingsInner() {
  const q = useGetAdminPlatformSettings();
  const up = useUpdateAdminPlatformSettings();
  const inv = useInvalidateAll();
  const [off, setOff] = useState<string | null>(null);
  const [branding, setBranding] = useState<BrandingFormValues | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setBranding({
      platformName: q.data.platformName,
      baseCurrency: q.data.baseCurrency,
      contactEmail: q.data.contactEmail,
      contactPhone: q.data.contactPhone,
      contactAddress: q.data.contactAddress,
      contactWhatsapp: q.data.contactWhatsapp,
      logoUrl: q.data.logoUrl ?? '',
      faviconUrl: q.data.faviconUrl ?? '',
    });
  }, [q.data]);
  function updateBranding<K extends keyof BrandingFormValues>(key: K, value: BrandingFormValues[K]) {
    setBranding((current) => current ? { ...current, [key]: value } : current);
  }
  function submitBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!branding) return;
    up.mutate({ data: {
      ...branding,
      baseCurrency: branding.baseCurrency.toUpperCase(),
      contactEmail: branding.contactEmail.trim(),
      contactPhone: branding.contactPhone.trim(),
      contactAddress: branding.contactAddress.trim(),
      contactWhatsapp: branding.contactWhatsapp.trim(),
      logoUrl: branding.logoUrl.trim() || null,
      faviconUrl: branding.faviconUrl.trim() || null,
    } }, { onSuccess: () => { void inv(); } });
  }
  return <><Heading eyebrow="ADMIN" title="Platform settings" subtitle="Brand identity, customer contact details and platform-wide feature switches. Changes are audited." />
    <Err error={up.error} />
    <Async q={q}><div className="form-stack">
      <Card title="Platform identity" subtitle="Public details shown across the platform and onboarding.">
        {branding && <form className="form-stack" onSubmit={submitBranding}>
          <Field label="Platform name"><input value={branding.platformName} onChange={(e) => updateBranding('platformName', e.target.value)} required minLength={1} maxLength={100} data-testid="input-platform-name" /></Field>
          <div className="form-grid">
            <Field label="Base currency" hint="Display and new-merchant onboarding default only; changing it never converts or changes existing balances."><select value={branding.baseCurrency} onChange={(e) => updateBranding('baseCurrency', e.target.value)} data-testid="select-platform-base-currency">{[...new Set([branding.baseCurrency, ...CURRENCIES])].map((currency) => <option key={currency}>{currency}</option>)}</select></Field>
            <Field label="Logo URL" hint="Optional HTTPS image URL"><input type="url" value={branding.logoUrl} onChange={(e) => updateBranding('logoUrl', e.target.value)} placeholder="https://…" data-testid="input-platform-logo-url" /></Field>
            <Field label="Favicon URL" hint="Optional HTTPS image URL"><input type="url" value={branding.faviconUrl} onChange={(e) => updateBranding('faviconUrl', e.target.value)} placeholder="https://…" data-testid="input-platform-favicon-url" /></Field>
          </div>
          <div className="form-grid">
            <Field label="Contact email"><input type="email" value={branding.contactEmail} onChange={(e) => updateBranding('contactEmail', e.target.value)} maxLength={254} data-testid="input-platform-contact-email" /></Field>
            <Field label="Contact phone"><input type="tel" value={branding.contactPhone} onChange={(e) => updateBranding('contactPhone', e.target.value)} maxLength={40} data-testid="input-platform-contact-phone" /></Field>
            <Field label="WhatsApp contact" hint="Use an international phone number or an https://wa.me link"><input value={branding.contactWhatsapp} onChange={(e) => updateBranding('contactWhatsapp', e.target.value)} maxLength={100} data-testid="input-platform-contact-whatsapp" /></Field>
          </div>
          <Field label="Contact address"><textarea value={branding.contactAddress} onChange={(e) => updateBranding('contactAddress', e.target.value)} maxLength={250} data-testid="input-platform-contact-address" /></Field>
          <Btn type="submit" disabled={up.isPending} testId="button-save-platform-branding">{up.isPending && <LoaderCircle size={14} className="spin" />}Save platform identity</Btn>
        </form>}
      </Card>
      <Card title="Feature controls" subtitle="Platform-wide switches. Changes apply immediately and are audited.">
        {q.data && SETTINGS.map(([k, t, d]) => <div className="setting-row" key={k}><div><strong>{t}</strong><span>{d}</span></div><Switch on={q.data[k]} label={t} disabled={up.isPending} onChange={(v) => { if (v) up.mutate({ data: { [k]: v } }, { onSuccess: () => { void inv(); } }); else setOff(k); }} /></div>)}
      </Card>
    </div></Async>
    {off && <Confirm title="Turn off this control" body="This applies platform-wide immediately for every merchant." confirmLabel="Turn off" pending={up.isPending} error={up.error} onClose={() => { setOff(null); up.reset(); }} onConfirm={() => up.mutate({ data: { [off]: false } }, { onSuccess: () => { void inv(); setOff(null); } })} />}</>;
}

export function AdminAuditPage() { return <G><AuditInner /></G>; }
function AuditInner() {
  const [page, setPage] = useState(1);
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const q = useListAdminAuditLog({ page, ...(user ? { user } : {}), ...(action ? { action } : {}), ...(search ? { search } : {}) });
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Audit log" subtitle="Server-recorded user and API activity, including the acting identity, method, route and response status." />
    <div className="toolbar"><div className="search-box"><Search size={14} /><input placeholder="Search actor, target or route" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} data-testid="input-audit-search" /></div>
      <input aria-label="Filter by user or API identity" placeholder="User / API identity" value={user} onChange={(e) => { setPage(1); setUser(e.target.value); }} data-testid="input-audit-user" />
      <input aria-label="Filter by action" placeholder="Action" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} data-testid="input-audit-action" /></div>
    <Async q={q} empty={!items.length} emptyTitle="No audit entries" emptyBody="Administrative and meaningful signed-in user/API actions are recorded here."><div className="table-wrap"><table className="dt"><thead><tr><th>When</th><th>User / API actor</th><th>Action</th><th>Method</th><th>Route</th><th>Status</th><th>Target</th><th>Details</th></tr></thead><tbody>
      {items.map((a) => <tr key={a.id} data-testid={`row-audit-${a.id}`}><td>{fmtDate(a.createdAt)}</td><td className="mono" style={{ fontSize: 12 }}>{a.actor}</td><td><strong>{nice(a.action)}</strong></td><td>{a.method || '—'}</td><td className="mono">{a.route || '—'}</td><td>{a.statusCode ?? '—'}</td><td>{a.target}</td><td>{a.details || '—'}</td></tr>)}
    </tbody></table></div>{q.data && <Pager page={page} total={q.data.total} perPage={50} onPage={setPage} />}</Async></>;
}
