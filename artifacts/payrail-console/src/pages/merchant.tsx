import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { Activity, ArrowRight, CheckCircle2, Clock3, ExternalLink, Link2, LoaderCircle, Plus, Trash2, Pause, Play, ShieldCheck, Send } from 'lucide-react';
import {
  useCreateMerchantProfile, useGetMerchantProfile, getGetMerchantProfileQueryKey, useResubmitMerchantApplication,
  useGetMerchantFees, useGetMerchantKyc, getGetMerchantKycQueryKey, useCreateMerchantKycSession,
  useCreateMerchantCloudinaryUploadSignature, useUpdateMerchantShopProfile,
  useListMerchantPaymentLinks, useCreateMerchantPaymentLink, useUpdateMerchantPaymentLink, useDeleteMerchantPaymentLink,
  useListMerchantTransactions, useListMerchantPayouts, useListSupportedCurrencies,
  useCreateMerchantPaymentLinkReminder, useListMerchantPaymentLinkReminders,
  useCreateMerchantTransactionRecoveryLink,
  type BusinessApplicationDetails,
} from '@workspace/api-client-react';
import { Async, Btn, Card, COUNTRIES, CURRENCIES, Confirm, CopyBtn, Err, Field, Gate, Heading, Modal, Note, Pager, Pill, currencyAmountStep, currencyMinorUnits, fmtDate, money, nice, useAccess, useInvalidateAll } from '@/components/kit';
import { usePlatformBranding } from '@/components/platform-brand';
import { CloudinaryImageUpload } from '@/components/cloudinary-image-upload';
import { LinkCollectedTotals } from '@/components/link-collected-totals';

export function MerchantDashboardPage() { return <Gate need="merchant"><MerchantDashboardInner /></Gate>; }

function MerchantDashboardInner() {
  const access = useAccess();
  const transactions = useListMerchantTransactions({ page: 1, perPage: 20 });
  const links = useListMerchantPaymentLinks({ overview: true });
  const items = transactions.data?.items ?? [];
  const linkItems = links.data?.items ?? [];
  const recentSuccess = items.filter((item) => item.status === 'success').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const activeLinks = links.data?.activeCount ?? 0;
  const volumes = items.reduce<Record<string, number>>((totals, item) => {
    if (item.status === 'success') totals[item.currency] = (totals[item.currency] ?? 0) + item.amount;
    return totals;
  }, {});
  const merchant = access.merchant;

  return <>
    <div className="merchant-welcome">
      <div className="merchant-welcome-copy">
        <span className="merchant-kicker">MERCHANT WORKSPACE / TODAY</span>
        <h1>{merchant?.businessName || 'Your collections, at a glance.'}</h1>
        <p>Follow recent payments and manage the links customers use to pay you.</p>
      </div>
      <div className="merchant-welcome-status">
        <span className="merchant-status-label">Account</span>
        <Pill value={merchant?.status} />
        <span className="merchant-status-sub">{merchant?.country} <i /> {merchant?.baseCurrency} base currency</span>
      </div>
    </div>

    <div className="merchant-dashboard-grid">
      <section className="merchant-highlight">
        <div className="merchant-highlight-top"><span className="merchant-highlight-icon"><Activity size={17} /></span><span>RECENT COLLECTIONS</span></div>
        <strong>{transactions.isLoading ? '—' : transactions.isError ? 'Unavailable' : transactions.data?.total.toLocaleString() ?? items.length.toLocaleString()}</strong>
        <p>Transactions on your account, with the latest 20 shown below.</p>
        <Link href="/merchant/transactions" className="merchant-highlight-link">Review transactions <ArrowRight size={15} /></Link>
      </section>
      <section className="merchant-stat-panel">
        <div className="merchant-stat"><span><CheckCircle2 size={15} /> Successful · recent 20</span><strong>{transactions.isLoading ? '—' : recentSuccess}</strong></div>
        <div className="merchant-stat"><span><Clock3 size={15} /> Pending · recent 20</span><strong>{transactions.isLoading ? '—' : pending}</strong></div>
        <div className="merchant-stat"><span><Link2 size={15} /> Active payment links</span><strong>{links.isLoading ? '—' : activeLinks}</strong></div>
      </section>
      <section className="merchant-volume-panel">
        <div className="merchant-section-head"><div><span className="merchant-kicker">RECENT SUCCESSFUL VOLUME</span><h2>By currency</h2></div><span>Latest 20 transactions</span></div>
        {transactions.isLoading ? <div className="merchant-loading-lines"><i /><i /><i /></div> : transactions.isError ? <div className="merchant-inline-error">Volume could not be loaded. <button onClick={() => { void transactions.refetch(); }}>Retry</button></div> : Object.keys(volumes).length ? <div className="merchant-currency-list">{Object.entries(volumes).map(([code, amount]) => <div className="merchant-currency-row" key={code}><span className="merchant-currency-mark">{code.slice(0, 1)}</span><strong>{code}</strong><span>Successful payments</span><b>{money(amount, code)}</b></div>)}</div> : <div className="merchant-empty-inline">Successful collection totals will appear here.</div>}
      </section>
      <section className="merchant-link-panel">
        <div className="merchant-section-head"><div><span className="merchant-kicker">COLLECTION TOOLS</span><h2>Payment links</h2></div><Link href="/merchant/payment-links" className="merchant-text-link">Manage <ArrowRight size={14} /></Link></div>
        <Async q={links} empty={!linkItems.length} emptyTitle="No links created yet" emptyBody="Create a link to give customers a simple way to pay." emptyAction={<Link href="/merchant/payment-links" className="btn btn-primary">Create your first link</Link>}>
          <div className="merchant-link-list">{linkItems.slice(0, 4).map((link) => <div className="merchant-link-row" key={link.id}>
            <div className="merchant-link-symbol"><Link2 size={15} /></div><div className="merchant-link-copy"><strong>{link.name}</strong><span>{link.amountType === 'fixed' ? money(link.amount, link.currency) : `Customer enters · ${link.currency}`}</span></div><Pill value={link.status} />
          </div>)}</div>
        </Async>
      </section>
    </div>

    <Card title="Recent transactions" subtitle="Each amount stays in its original currency." action={<Link href="/merchant/transactions" className="panel-link">All transactions <ArrowRight size={13} /></Link>}>
      <Async q={transactions} empty={!items.length} emptyTitle="No transactions yet" emptyBody="Payments made through your links or API will appear here." emptyAction={<Link href="/merchant/payment-links" className="text-link">Set up a payment link <ArrowRight size={13} /></Link>}>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th><th>Payment method</th><th>Created</th></tr></thead><tbody>
          {items.slice(0, 6).map((transaction) => <tr key={transaction.id} data-testid={`row-merchant-dashboard-tx-${transaction.id}`}><td className="mono">{transaction.reference}</td><td><strong>{transaction.customerName || transaction.customerEmail}</strong><span className="sub">{transaction.customerName ? transaction.customerEmail : transaction.description || 'Customer payment'}</span></td><td className="num">{money(transaction.amount, transaction.currency)}</td><td><Pill value={transaction.status} /></td><td>{nice(transaction.paymentMethod)}</td><td>{fmtDate(transaction.createdAt)}</td></tr>)}
        </tbody></table></div>
      </Async>
    </Card>
  </>;
}

export function MerchantPage({ addBusiness = false }: { addBusiness?: boolean } = {}) {
  const access = useAccess();
  const create = useCreateMerchantProfile();
  const profileQuery = useGetMerchantProfile({ query: { queryKey: getGetMerchantProfileQueryKey(), enabled: !addBusiness && !!access.merchant } });
  const queryClient = useQueryClient();
  const resubmit = useResubmitMerchantApplication();
  const [, setLocation] = useLocation();
  const capacity = access.data?.businessCapacity;
  const canCreateBusiness = !!capacity && capacity.businessCount < capacity.businessLimit;
  const fees = useGetMerchantFees({ query: { enabled: !!access.merchant && !addBusiness } as never });
  const m = access.merchant;
  const businessLimitNotice = <Card title="Business limit reached" subtitle={`Your current ${capacity?.tier === 'kyc' ? 'KYC' : 'unverified'} level allows ${capacity?.businessLimit ?? 1} owned business${capacity?.businessLimit === 1 ? '' : 'es'}.`}>
    <Note tone="warn">Complete {capacity?.tier === 'kyc' ? 'KYB' : 'KYC'} verification to increase your business limit.</Note>
    <Link href="/merchant/kyc" className="btn btn-primary">Open verification <ArrowRight size={14} /></Link>
  </Card>;
  return <>
    <Heading eyebrow="MERCHANT" title={addBusiness ? 'Add another business' : m ? m.businessName : 'Business application'} subtitle="Your business profile, application status and the information needed to collect with Greenpay." action={m && canCreateBusiness && !addBusiness ? <Link href="/merchant/new" className="btn btn-primary"><Plus size={15} />Add a business</Link> : undefined} />
    <Async q={access}>
      {!m ? <ApplicationWizard create={create} queryClient={queryClient} onCreated={addBusiness ? () => setLocation('/merchant/dashboard') : undefined} /> : addBusiness ? canCreateBusiness ? <ApplicationWizard create={create} queryClient={queryClient} addBusiness onCreated={() => setLocation('/merchant/dashboard')} /> : businessLimitNotice : <div className="split">
        <div>
          <Card title="Profile">
            <div className="kv">
              <div><span>Status</span><Pill value={m.status} /></div>
              <div><span>Business application</span><Pill value={m.applicationStatus} /></div>
              <div><span>Submitted</span><strong>{fmtDate(m.applicationSubmittedAt)}</strong></div>
              <div><span>Reviewed</span><strong>{fmtDate(m.applicationReviewedAt)}</strong></div>
              <div><span>Verification</span><Pill value={m.kycStatus} /></div>
              <div><span>Country</span><strong>{m.country}</strong></div>
              <div><span>Base currency</span><strong>{m.baseCurrency}</strong></div>
              <div><span>Registration</span><strong>{m.registrationNumber || '-'}</strong></div>
              {([['paymentsEnabled', 'Payments'], ['payoutsEnabled', 'Payouts'], ['refundsEnabled', 'Refunds'], ['apiAccessEnabled', 'API access']] as const).map(([k, t]) => <div key={k}><span>{t}</span><Pill value={m[k] === false ? 'disabled' : 'active'} /></div>)}
              <div><span>Created</span><strong>{fmtDate(m.createdAt)}</strong></div>
            </div>
          </Card>
          {m.applicationDetails && <Card title="Submitted business application" subtitle="These are the business and collection details attached to your current application.">
            <div className="application-review-grid">
              <div><span>Business type</span><strong>{nice(m.applicationDetails.businessType)}</strong></div>
              <div><span>Nature of business</span><p>{m.applicationDetails.natureOfBusiness}</p></div>
              <div><span>Registered address</span><p>{m.applicationDetails.registeredAddress}</p></div>
              <div><span>Website</span><strong>{m.applicationDetails.website || '—'}</strong></div>
              <div><span>Expected monthly volume</span><strong>{money(m.applicationDetails.expectedMonthlyVolume, m.applicationDetails.expectedMonthlyVolumeCurrency)} / month</strong></div>
              <div><span>Expected monthly transactions</span><strong>{m.applicationDetails.expectedMonthlyTransactions.toLocaleString()}</strong></div>
              <div><span>Average transaction value</span><strong>{money(m.applicationDetails.expectedAverageTransactionValue, m.applicationDetails.expectedMonthlyVolumeCurrency)}</strong></div>
              <div><span>Customer countries</span><strong>{m.applicationDetails.expectedCustomerCountries.join(', ')}</strong></div>
              <div><span>Collection currencies</span><strong>{m.applicationDetails.expectedCollectionCurrencies.join(', ')}</strong></div>
              <div><span>Source of funds</span><p>{m.applicationDetails.sourceOfFunds}</p></div>
            </div>
          </Card>}
          {m.applicationStatus === 'more_info_required' && <ApplicationResubmission merchant={profileQuery.data?.merchant ?? m} mutation={resubmit} queryClient={queryClient} />}
          {m.applicationRequestedInfo && <Note tone="warn"><strong>Information requested:</strong> {m.applicationRequestedInfo}</Note>}
          {profileQuery.isError && <Note tone="warn">Application details could not be refreshed. <Btn variant="secondary" small onClick={() => { void profileQuery.refetch(); }}>Retry</Btn></Note>}
          <ShopProfileEditor merchant={m} isOwner={access.data?.role === 'owner'} />
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

function ApplicationWizard({ create, queryClient, addBusiness = false, onCreated }: { create: ReturnType<typeof useCreateMerchantProfile>; queryClient: ReturnType<typeof useQueryClient>; addBusiness?: boolean; onCreated?: () => void }) {
  const branding = usePlatformBranding();
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [businessValues, setBusinessValues] = useState<Record<string, string>>({});
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const value = (key: string) => businessValues[key] ?? String(form.get(key) || '');
    const parseList = (key: string) => String(form.get(key) || '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
    const application: BusinessApplicationDetails = {
      businessType: value('businessType') as BusinessApplicationDetails['businessType'],
      natureOfBusiness: value('natureOfBusiness').trim(),
      registeredAddress: value('registeredAddress').trim(),
      website: value('website').trim() || null,
      expectedMonthlyVolume: Number(form.get('expectedMonthlyVolume')),
      expectedMonthlyVolumeCurrency: String(form.get('expectedMonthlyVolumeCurrency')).toUpperCase(),
      expectedMonthlyTransactions: Number(form.get('expectedMonthlyTransactions')),
      expectedAverageTransactionValue: Number(form.get('expectedAverageTransactionValue')),
      expectedCustomerCountries: parseList('expectedCustomerCountries'),
      expectedCollectionCurrencies: parseList('expectedCollectionCurrencies'),
      sourceOfFunds: String(form.get('sourceOfFunds')).trim(),
    };
    if (!application.expectedCustomerCountries.length || !application.expectedCollectionCurrencies.length) {
      setError('Enter at least one country and one collection currency.');
      return;
    }
    create.mutate({ data: {
      businessName: value('businessName').trim(),
      country: value('country'),
      baseCurrency: value('baseCurrency'),
      ...(value('registrationNumber').trim() ? { registrationNumber: value('registrationNumber').trim() } : {}),
      application,
    } }, { onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetMerchantProfileQueryKey() }),
        queryClient.invalidateQueries(),
      ]);
      onCreated?.();
    }, onError: (failure) => setError(String((failure as Error).message || 'The application could not be submitted.')) });
  }
  return <Card title={addBusiness ? 'Register another business' : 'Start your business application'} subtitle="Two short steps. Greenpay will review the details before collection access is enabled.">
    <form className="form-stack application-wizard" onSubmit={submit}>
      <div className="application-steps" aria-label="Application progress"><span className={step === 1 ? 'current' : 'complete'}>01 <b>Business</b></span><i /><span className={step === 2 ? 'current' : ''}>02 <b>Activity</b></span></div>
      {step === 1 ? <div className="form-stack">
        <div className="form-grid"><Field label="Legal business name"><input name="businessName" required minLength={2} maxLength={150} data-testid="input-business-name" /></Field><Field label="Business type"><select name="businessType" defaultValue="" required data-testid="select-business-type"><option value="" disabled>Select business type</option><option value="sole_proprietor">Sole proprietor</option><option value="limited_company">Limited company</option><option value="partnership">Partnership</option><option value="nonprofit">Nonprofit</option><option value="other">Other</option></select></Field></div>
        <div className="form-grid"><Field label="Country of registration"><select name="country" defaultValue="" required data-testid="select-country"><option value="" disabled>Select country</option>{COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field><Field label="Base currency"><select name="baseCurrency" defaultValue="" required data-testid="select-base-currency"><option value="" disabled>Select currency</option>{[...new Set([branding.baseCurrency, ...CURRENCIES])].map((code) => <option key={code}>{code}</option>)}</select></Field></div>
        <Field label="Registration number" hint="Optional"><input name="registrationNumber" maxLength={150} data-testid="input-registration" /></Field>
        <Field label="Nature of business" hint="Describe the products or services offered"><textarea name="natureOfBusiness" required minLength={10} maxLength={2000} data-testid="input-nature-of-business" /></Field>
        <Field label="Registered address"><textarea name="registeredAddress" required minLength={5} maxLength={500} data-testid="input-registered-address" /></Field>
        <Field label="Website" hint="Optional"><input name="website" type="url" maxLength={500} placeholder="https://" data-testid="input-business-website" /></Field>
        <Btn testId="button-application-continue" onClick={() => {
          const form = document.querySelector<HTMLFormElement>('.application-wizard');
          if (form?.reportValidity()) {
            const values = new FormData(form);
            setBusinessValues(Object.fromEntries(Array.from(values.entries()).map(([key, value]) => [key, String(value)])));
            setStep(2);
          }
        }}>Continue to activity <ArrowRight size={14} /></Btn>
      </div> : <div className="form-stack">
        <div className="form-grid"><Field label="Expected monthly volume"><input name="expectedMonthlyVolume" type="number" min="0" max="1000000000000" step="any" required data-testid="input-monthly-volume" /></Field><Field label="Volume currency"><select name="expectedMonthlyVolumeCurrency" defaultValue="" required data-testid="select-volume-currency"><option value="" disabled>Select currency</option>{CURRENCIES.map((code) => <option key={code}>{code}</option>)}</select></Field></div>
        <div className="form-grid"><Field label="Expected monthly transactions"><input name="expectedMonthlyTransactions" type="number" min="0" max="1000000000" step="1" required data-testid="input-monthly-transactions" /></Field><Field label="Average transaction value"><input name="expectedAverageTransactionValue" type="number" min="0" max="1000000000000" step="any" required data-testid="input-average-value" /></Field></div>
        <Field label="Customer countries" hint="Comma-separated ISO country codes, for example KE, UG"><input name="expectedCustomerCountries" required data-testid="input-customer-countries" /></Field>
        <Field label="Collection currencies" hint="Comma-separated three-letter codes"><input name="expectedCollectionCurrencies" required data-testid="input-collection-currencies" /></Field>
        <Field label="Source of funds" hint="Explain where the business funds originate"><textarea name="sourceOfFunds" required minLength={10} maxLength={1000} data-testid="input-source-of-funds" /></Field>
        {error && <Err error={error} />}
        <div className="row-actions"><Btn variant="secondary" testId="button-application-back" onClick={() => setStep(1)}>Back</Btn><Btn type="submit" disabled={create.isPending} testId="button-submit-application">{create.isPending ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}Submit application</Btn></div>
      </div>}
    </form>
  </Card>;
}

function ApplicationResubmission({ merchant, mutation, queryClient }: {
  merchant: NonNullable<ReturnType<typeof useAccess>['merchant']>;
  mutation: ReturnType<typeof useResubmitMerchantApplication>;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const prior = merchant.applicationDetails;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const details: BusinessApplicationDetails = {
      businessType: String(form.get('businessType')) as BusinessApplicationDetails['businessType'],
      natureOfBusiness: String(form.get('natureOfBusiness')).trim(),
      registeredAddress: String(form.get('registeredAddress')).trim(),
      website: String(form.get('website') || '').trim() || null,
      expectedMonthlyVolume: Number(form.get('expectedMonthlyVolume')),
      expectedMonthlyVolumeCurrency: String(form.get('expectedMonthlyVolumeCurrency')).toUpperCase(),
      expectedMonthlyTransactions: Number(form.get('expectedMonthlyTransactions')),
      expectedAverageTransactionValue: Number(form.get('expectedAverageTransactionValue')),
      expectedCustomerCountries: String(form.get('expectedCustomerCountries')).split(',').map((v) => v.trim().toUpperCase()).filter(Boolean),
      expectedCollectionCurrencies: String(form.get('expectedCollectionCurrencies')).split(',').map((v) => v.trim().toUpperCase()).filter(Boolean),
      sourceOfFunds: String(form.get('sourceOfFunds')).trim(),
    };
    mutation.mutate({ data: details }, { onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: getGetMerchantProfileQueryKey() }), queryClient.invalidateQueries()]);
    } });
  }
  return <Card title="Resubmit your application" subtitle="Update the requested information and send the application back for review.">
    {merchant.applicationRequestedInfo && <Note tone="warn"><strong>Requested:</strong> {merchant.applicationRequestedInfo}</Note>}
    {prior && <form className="form-stack application-wizard" onSubmit={submit}>
      <div className="form-grid"><Field label="Business type"><select name="businessType" defaultValue={prior.businessType}><option value="sole_proprietor">Sole proprietor</option><option value="limited_company">Limited company</option><option value="partnership">Partnership</option><option value="nonprofit">Nonprofit</option><option value="other">Other</option></select></Field><Field label="Website"><input name="website" type="url" defaultValue={prior.website ?? ''} /></Field></div>
      <Field label="Nature of business"><textarea name="natureOfBusiness" required minLength={10} defaultValue={prior.natureOfBusiness} /></Field>
      <Field label="Registered address"><textarea name="registeredAddress" required minLength={5} defaultValue={prior.registeredAddress} /></Field>
      <div className="form-grid"><Field label="Expected monthly volume"><input name="expectedMonthlyVolume" type="number" min="0" step="any" required defaultValue={prior.expectedMonthlyVolume} /></Field><Field label="Volume currency"><input name="expectedMonthlyVolumeCurrency" required minLength={3} maxLength={3} defaultValue={prior.expectedMonthlyVolumeCurrency} /></Field></div>
      <div className="form-grid"><Field label="Expected monthly transactions"><input name="expectedMonthlyTransactions" type="number" min="0" step="1" required defaultValue={prior.expectedMonthlyTransactions} /></Field><Field label="Average transaction value"><input name="expectedAverageTransactionValue" type="number" min="0" step="any" required defaultValue={prior.expectedAverageTransactionValue} /></Field></div>
      <Field label="Customer countries" hint="Comma-separated country codes"><input name="expectedCustomerCountries" required defaultValue={prior.expectedCustomerCountries.join(', ')} /></Field>
      <Field label="Collection currencies" hint="Comma-separated currency codes"><input name="expectedCollectionCurrencies" required defaultValue={prior.expectedCollectionCurrencies.join(', ')} /></Field>
      <Field label="Source of funds"><textarea name="sourceOfFunds" required minLength={10} defaultValue={prior.sourceOfFunds} /></Field>
      <Err error={mutation.error} />
      <Btn type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Submitting…' : 'Resubmit application'}</Btn>
    </form>}
  </Card>;
}

type MerchantShopProfile = NonNullable<ReturnType<typeof useAccess>['merchant']>;
function ShopProfileEditor({ merchant, isOwner }: { merchant: MerchantShopProfile; isOwner: boolean }) {
  const update = useUpdateMerchantShopProfile();
  const signature = useCreateMerchantCloudinaryUploadSignature();
  const invalidate = useInvalidateAll();
  const [shopName, setShopName] = useState(merchant.shopName ?? '');
  const [shopLogoUrl, setShopLogoUrl] = useState(merchant.shopLogoUrl ?? '');

  useEffect(() => {
    setShopName(merchant.shopName ?? '');
    setShopLogoUrl(merchant.shopLogoUrl ?? '');
  }, [merchant.id, merchant.shopName, merchant.shopLogoUrl]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({ data: { shopName: shopName.trim() || null, shopLogoUrl: shopLogoUrl.trim() || null } }, {
      onSuccess: () => { void invalidate(); },
    });
  }

  return <Card title="Public shop profile" subtitle="Shown to customers on payment links and payment-status pages.">
    {isOwner ? <form className="form-stack" onSubmit={submit}>
      <Field label="Shop name" hint="Optional. Leave blank to show Greenpay branding to customers.">
        <input value={shopName} onChange={(event) => setShopName(event.target.value)} maxLength={100} placeholder="Enter a public shop name" data-testid="input-shop-name" />
      </Field>
      <CloudinaryImageUpload
        label="Shop profile image"
        value={shopLogoUrl}
        description="This image appears beside your shop name on customer-facing payment pages. Upload first, then save."
        getSignature={() => signature.mutateAsync(undefined)}
        onUploaded={setShopLogoUrl}
      />
      <Field label="Shop image URL" hint="Optional HTTPS URL; uploading an image fills this field.">
        <input type="url" value={shopLogoUrl} onChange={(event) => setShopLogoUrl(event.target.value)} placeholder="https://…" data-testid="input-shop-image-url" />
      </Field>
      <Err error={update.error} />
      <Btn type="submit" disabled={update.isPending} testId="button-save-shop-profile">{update.isPending ? 'Saving…' : 'Save shop profile'}</Btn>
    </form> : <div className="form-stack">
      <div className="kv"><div><span>Public shop name</span><strong>{merchant.shopName || 'Not set · Greenpay branding shown to customers'}</strong></div></div>
      {merchant.shopLogoUrl && <img className="cloudinary-image-preview" src={merchant.shopLogoUrl} alt={`${merchant.shopName || 'Shop'} profile image`} />}
      <Note tone="warn">Only the merchant account owner can change public shop details.</Note>
    </div>}
  </Card>;
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

function LinksInner() {
  const q = useListMerchantPaymentLinks();
  const update = useUpdateMerchantPaymentLink();
  const del = useDeleteMerchantPaymentLink();
  const inv = useInvalidateAll();
  const [open, setOpen] = useState(false);
  const [rm, setRm] = useState<number | null>(null);
  const [reminderId, setReminderId] = useState<number | null>(null);
  const items = q.data?.items ?? [];
  return <>
    <Heading eyebrow="MERCHANT / COLLECTION TOOLS" title="Payment links" subtitle="Create, share and pause customer-facing links. Collected totals stay separated by transaction currency." action={<Btn onClick={() => setOpen(true)} testId="button-new-link"><Plus size={15} />New link</Btn>} />
    <Err error={update.error} />
    <Async q={q} empty={!items.length} emptyTitle="No payment links" emptyBody="Create a fixed-price or customer-entered link." emptyAction={<Btn onClick={() => setOpen(true)}>Create link</Btn>}>
       <div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Amount</th><th>Status</th><th className="num">Payments</th><th className="num">Collected by currency</th><th>Expires</th><th>Share link</th><th /></tr></thead><tbody>
        {items.map((l) => <tr key={l.id} data-testid={`row-link-${l.id}`}>
           <td><strong>{l.name}</strong><span className="sub">{l.description || `Created ${fmtDate(l.createdAt)}`}</span></td>
           <td>{l.amountType === 'fixed' ? money(l.amount, l.currency) : `Customer enters (${l.currency})`}</td>
           <td><Pill value={l.status} /></td><td className="num">{l.paidCount}</td><td className="num"><LinkCollectedTotals currency={l.currency} totalPaid={l.totalPaid} totalPaidByCurrency={l.totalPaidByCurrency} /></td>
           <td>{l.expiresAt ? fmtDate(l.expiresAt) : 'No expiry'}</td>
           <td><div className="copy-line"><code className="mono" style={{ fontSize: 11 }}>{l.url}</code><CopyBtn text={l.url} /></div></td>
          <td><div className="row-actions">
             {l.status === 'active' && <Btn variant="secondary" small onClick={() => setReminderId(l.id)}><Send size={13} />Remind</Btn>}
             {l.status !== 'archived' && <Btn variant="quiet" small disabled={update.isPending} onClick={() => update.mutate({ id: l.id, data: { status: l.status === 'active' ? 'paused' : 'active' } }, { onSuccess: () => { void inv(); } })}>{l.status === 'active' ? <><Pause size={13} />Pause</> : <><Play size={13} />Resume</>}</Btn>}
            <Btn variant="danger" small onClick={() => setRm(l.id)}><Trash2 size={13} />Delete</Btn></div></td>
        </tr>)}
      </tbody></table></div>
    </Async>
    {open && <LinkModal onClose={() => setOpen(false)} />}
    {reminderId !== null && <LinkReminderModal linkId={reminderId} onClose={() => setReminderId(null)} />}
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

function LinkReminderModal({ linkId, onClose }: { linkId: number; onClose: () => void }) {
  const create = useCreateMerchantPaymentLinkReminder();
  const history = useListMerchantPaymentLinkReminders(linkId);
  const invalidate = useInvalidateAll();
  const [scheduleError, setScheduleError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const recipientEmail = String(form.get('recipientEmail') || '').trim();
    const customerName = String(form.get('customerName') || '').trim();
    const rawSchedule = String(form.get('scheduleAt') || '');
    const scheduleAt = rawSchedule ? new Date(rawSchedule) : null;
    if (scheduleAt && (Number.isNaN(scheduleAt.getTime()) || scheduleAt.getTime() <= Date.now() + 60_000 || scheduleAt.getTime() > Date.now() + 30 * 86_400_000)) {
      setScheduleError('Schedule at least one minute from now and no more than 30 days ahead.');
      return;
    }
    setScheduleError('');
    create.mutate({ id: linkId, data: {
      recipientEmail,
      ...(customerName ? { customerName } : {}),
      ...(scheduleAt ? { scheduleAt: scheduleAt.toISOString() } : {}),
    } }, { onSuccess: () => { void invalidate(); } });
  }
  return <Modal title="Remind a customer" description="Send or schedule one email for this active payment link." onClose={onClose} wide>
    <form className="form-stack payment-link-reminder-form" onSubmit={submit}>
      <Note>The server confirms the link is active, unpaid, and not an invoice link before queuing a reminder.</Note>
      <Field label="Recipient email"><input name="recipientEmail" type="email" maxLength={254} required placeholder="customer@example.com" /></Field>
      <Field label="Customer name (optional)"><input name="customerName" maxLength={150} placeholder="Customer name" /></Field>
      <Field label="Schedule later (optional)"><input name="scheduleAt" type="datetime-local" /></Field>
      {scheduleError && <Note>{scheduleError}</Note>}
      {create.data && <div className="payment-link-reminder-result"><strong>{nice(create.data.deliveryStatus)}</strong><span>{create.data.message}</span></div>}
      <Err error={create.error} />
      <div className="row-actions"><Btn variant="secondary" onClick={onClose}>Close</Btn><Btn type="submit" disabled={create.isPending}>{create.isPending ? 'Queuing…' : 'Queue reminder'}</Btn></div>
    </form>
    <div className="payment-link-reminder-history">
      <h3>Recent reminders</h3>
      <Async q={history} empty={!history.data?.items.length} emptyTitle="No reminders yet" emptyBody="Reminder attempts for this link will appear here.">
        <ul>{history.data?.items.map((item) => <li key={item.id}><strong>{nice(item.deliveryStatus)}</strong><span>{item.recipientEmail} · {fmtDate(item.createdAt)}</span><small>{item.message}</small></li>)}</ul>
      </Async>
    </div>
  </Modal>;
}

export function MerchantTransactionsPage() { return <Gate need="merchant"><TxInner /></Gate>; }
function TxInner() {
  const [page, setPage] = useState(1);
  const q = useListMerchantTransactions({ page, perPage: 20 });
  const recovery = useCreateMerchantTransactionRecoveryLink();
  const invalidate = useInvalidateAll();
  const [recoveryResult, setRecoveryResult] = useState<{ paymentUrl: string; message: string } | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const items = q.data?.items ?? [];
  const successful = items.filter((item) => item.status === 'success').length;
  const awaiting = items.filter((item) => item.status === 'pending').length;
  const attention = items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
  return <>
    <Heading eyebrow="MERCHANT / COLLECTIONS" title="Transactions" subtitle="A clear record of collections linked to your business. Amounts, fees and settlements remain in each transaction’s original currency." />
    {recoveryResult && <div className="payment-recovery-result"><strong>Retry link ready</strong><span>{recoveryResult.message}</span><div><code>{recoveryResult.paymentUrl}</code><CopyBtn text={recoveryResult.paymentUrl} /></div></div>}
    {recoveryError && <Note>{recoveryError}</Note>}
    <div className="merchant-tx-summary" aria-label="Current page transaction summary">
      <div><span>Page {page} / latest 20</span><strong>{q.isLoading ? '—' : q.data?.total.toLocaleString() ?? items.length}</strong><small>Total merchant records</small></div>
      <div><span>Successful on page</span><strong>{q.isLoading ? '—' : successful}</strong><small>Confirmed collections</small></div>
      <div><span>Pending on page</span><strong>{q.isLoading ? '—' : awaiting}</strong><small>Awaiting provider update</small></div>
      <div><span>Needs attention on page</span><strong>{q.isLoading ? '—' : attention}</strong><small>Failed or cancelled</small></div>
    </div>
    <Async q={q} empty={!items.length} emptyTitle="No transactions yet" emptyBody="Payments made through your links or API appear here.">
      <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Customer</th><th className="num">Amount</th><th className="num">Fee</th><th className="num">Net</th><th>Status</th><th>Settlement</th><th>Method</th><th>Created</th><th>Recovery</th></tr></thead><tbody>
        {items.map((t) => <tr key={t.id} data-testid={`row-tx-${t.id}`}><td className="mono" style={{ fontSize: 12 }}>{t.reference}<span className="sub">{t.description || nice(t.provider)}</span></td><td>{t.customerName || t.customerEmail}<span className="sub">{t.customerName ? t.customerEmail : t.customerPhone || 'Customer'}</span></td><td className="num">{money(t.amount, t.currency)}</td><td className="num">{t.fee != null ? money(t.fee, t.currency) : '—'}</td><td className="num">{t.netAmount != null ? money(t.netAmount, t.currency) : '—'}</td><td><Pill value={t.status} />{t.failureReason && <span className="sub failure-reason">{t.failureReason}</span>}</td><td><Pill value={t.settlementStatus} />{t.settlementAt && <span className="sub">{fmtDate(t.settlementAt)}</span>}</td><td>{nice(t.paymentMethod)}</td><td>{fmtDate(t.createdAt)}</td><td>{(t.status === 'failed' || t.status === 'cancelled') ? <Btn variant="secondary" small disabled={recovery.isPending} onClick={() => { setRecoveryError(''); setRecoveryResult(null); recovery.mutate({ reference: t.reference }, { onSuccess: (result) => { setRecoveryResult(result); void invalidate(); }, onError: (error) => setRecoveryError(error instanceof Error ? error.message : 'Retry link could not be created.') }); }}>{recovery.isPending ? 'Working…' : 'Send retry link'}</Btn> : '—'}</td></tr>)}
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
