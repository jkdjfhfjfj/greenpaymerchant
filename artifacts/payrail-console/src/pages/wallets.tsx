import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import {
  confirmWalletSettlement, convertMerchantWalletFunds,
  reconcilePayoutRequest, rejectPayoutRequest,
  useGetMerchantWalletFxQuote, useListAdminPayoutRequests, useListAdminWallets, useListAdminMerchants,
  useListMerchantPayoutRequests, useListMerchantWalletLedger,
  useListMerchantWalletPayoutMethods, useListMerchantWallets, useListSettlements,
  type AdminAirtimeTopupCreditResponse, type AdminAirtimeTopupReviewList,
  type AdminWalletAdjustmentResponse,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CURRENCIES, Err, Field, Gate, Heading, Modal, Note, Pill, currencyAmountStep, fmtDate, money, nice, useInvalidateAll } from '@/components/kit';
import { useMerchantActionCapability } from '@/hooks/use-merchant-action-controls';

function requestKey() {
  return crypto.randomUUID();
}

type WalletBalance = {
  currency: string;
  availableBalance: number;
  reservedBalance: number;
  updatedAt?: string | Date | null;
};

function includeSupportedWallets<T extends WalletBalance>(items: T[]) {
  const byCurrency = new Map(items.map((item) => [item.currency, item]));
  const currencies = [...new Set([...items.map((item) => item.currency), ...CURRENCIES])];
  return currencies.map((currency) => byCurrency.get(currency) ?? {
    currency,
    availableBalance: 0,
    reservedBalance: 0,
    updatedAt: undefined,
  });
}

async function walletApi<T>(path: string, options: {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
} = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Wallet request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

type WalletPayoutDestination = {
  id: number;
  currency: string;
  label: string;
  method: string;
  accountName: string;
  maskedAccount: string;
  status: string;
  approvedAt: Date | string;
};
type WalletDestinationView = {
  id: number | null;
  label: string;
  currency: string;
  method: string;
  accountName: string;
  maskedAccount: string;
  fingerprint: string;
};
type WalletDestinationChange = {
  id: number;
  destinationId: number | null;
  destination: WalletDestinationView;
  destinationFingerprint: string;
  status: string;
  requestedBy: string;
  firstApprovedBy: string | null;
  firstApprovedAt: Date | string | null;
  secondApprovedBy: string | null;
  secondApprovedAt: Date | string | null;
  decisionReason: string | null;
  reviewHistory: Array<{
    stage: string;
    actor: string;
    occurredAt: Date | string;
    outcome: string;
    destination: WalletDestinationView;
    fee: number | null;
  }>;
};
type WalletPayoutReviewItem = {
  id: number;
  reference: string;
  merchantId: number;
  amount: number;
  fee: number;
  currency: string;
  method: string;
  accountName: string;
  maskedAccount: string;
  destinationId: number | null;
  destinationVersion: number | null;
  destinationFingerprint: string | null;
  requiresSecondApproval: boolean;
  largePayoutThreshold: number | null;
  thresholdConfigured: boolean;
  firstApprovedBy: string | null;
  firstApprovedAt: Date | string | null;
  secondApprovedBy: string | null;
  secondApprovedAt: Date | string | null;
  reviewHistory: Array<{
    stage: string;
    actor: string;
    occurredAt: Date | string;
    outcome: string;
    destination: { id: number | null; versionId: number | null; fingerprint: string | null; accountName: string; maskedAccount: string; method: string; currency: string };
    fee: number;
  }>;
  status: string;
  createdAt: Date | string;
};

export function WalletPage() {
  return <Gate need="merchant"><WalletInner /></Gate>;
}

function WalletInner() {
  const wallets = useListMerchantWallets({ query: { queryKey: ['merchant-wallets'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const ledger = useListMerchantWalletLedger(undefined, { query: { queryKey: ['merchant-wallet-ledger'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const capabilities = useMerchantActionCapability();
  const invalidate = useInvalidateAll();
  const [fromCurrency, setFromCurrency] = useState('');
  const [toCurrency, setToCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submittingConversion, setSubmittingConversion] = useState(false);
  const idempotencyKey = useRef(requestKey());
  const walletItems = wallets.data?.items ?? [];
  const accounts = useMemo(() => includeSupportedWallets(walletItems), [walletItems]);
  const conversionAccounts = useMemo(() => accounts.filter((account) => account.currency !== 'SLL'), [accounts]);
  const from = fromCurrency || conversionAccounts[0]?.currency || '';
  const to = toCurrency || conversionAccounts.find((account) => account.currency !== from)?.currency || '';
  const amountNumber = Number(amount);
  const quoteEnabled = amountNumber > 0 && Number.isFinite(amountNumber) && from.length === 3 && to.length === 3 && from !== to;
  const quote = useGetMerchantWalletFxQuote({
    amount: quoteEnabled ? amountNumber : 0,
    from,
    to,
    idempotencyKey: idempotencyKey.current,
  }, { query: { queryKey: ['merchant-wallet-fx-quote', from, to, amountNumber, idempotencyKey.current], enabled: quoteEnabled, staleTime: 0, refetchOnWindowFocus: true } });
  const accountByCurrency = useMemo(() => new Map(accounts.map((account) => [account.currency, account])), [accounts]);
  const canConvert = capabilities.can('walletConversion');

  async function submitConversion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    if (!quote.data || quote.isFetching || !quoteEnabled) return;
    setConfirmOpen(true);
  }

  async function confirmConversion() {
    if (!quote.data || quote.isFetching || !quoteEnabled) return;
    try {
      setSubmittingConversion(true);
      setError(null);
      const result = await convertMerchantWalletFunds(
        {
          amount: amountNumber,
          fromCurrency: from,
          toCurrency: to,
          quoteId: quote.data.quoteId,
        },
        { headers: { 'Idempotency-Key': idempotencyKey.current } },
      );
      idempotencyKey.current = requestKey();
      setConfirmOpen(false);
      setMessage(`Internal allocation posted: ${money(result.sourceAmount, result.fromCurrency)} to ${money(result.targetAmount, result.toCurrency)}. System margin ${money(result.systemMarginAmount, result.toCurrency)}; fee ${money(result.feeAmount, result.toCurrency)}.`);
      setAmount('');
      await invalidate();
    } catch (failure) {
      setError(failure);
      setConfirmOpen(false);
      void quote.refetch();
    } finally {
      setSubmittingConversion(false);
    }
  }

  return <>
    <Heading eyebrow="MERCHANT / WALLET" title="Funded balances" subtitle="Only confirmed settlements are withdrawable. Payment success and T+3 forecasts are not wallet funds." />
    <Async q={wallets} empty={!accounts.length} emptyTitle="No currency wallets" emptyBody="Supported zero-balance wallets are created automatically. Confirmed settlement evidence is still required to fund them.">
      <div className="metric-grid">
        {accounts.map((account) => <section className="metric-card tone-mint" key={account.currency}>
          <div className="metric-top"><span>{account.currency} available</span><span className="metric-icon"><WalletCards size={17} /></span></div>
          <div className="metric-value">{money(account.availableBalance, account.currency)}</div>
          <div className="metric-detail">Reserved {money(account.reservedBalance, account.currency)} · {account.updatedAt ? `updated ${fmtDate(account.updatedAt)}` : 'no wallet activity yet'}</div>
        </section>)}
      </div>
    </Async>

    <div className="split" style={{ marginTop: 16 }}>
      <Card title="Convert wallet funds" subtitle="Fresh public market rate, platform markup, target-currency spread and fee schedule. Conversion is an internal allocation—not external bank FX.">
        <form className="form-stack" onSubmit={submitConversion}>
          <div className="form-grid">
            <Field label="From wallet"><select value={from} onChange={(event) => { setFromCurrency(event.target.value); setToCurrency(''); }} required data-testid="select-wallet-from">{conversionAccounts.map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
            <Field label="To wallet"><select value={to} onChange={(event) => setToCurrency(event.target.value)} required data-testid="select-wallet-to">{conversionAccounts.filter((account) => account.currency !== from).map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
          </div>
          <Field label={`Amount (${from || 'source currency'})`} hint={accountByCurrency.has(from) ? `Available: ${money(accountByCurrency.get(from)?.availableBalance, from)}` : 'No funded source wallet is available.'}>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required data-testid="input-wallet-conversion-amount" />
          </Field>
          <Async q={quote} empty={!quoteEnabled} emptyTitle="Enter a source amount" emptyBody="A current market rate will be requested after both wallets and an amount are selected.">
          {quote.data && <div className="route-hint"><ArrowLeftRight size={15} /><span>{money(quote.data.sourceAmount, quote.data.fromCurrency)} at effective rate {quote.data.effectiveRate} → <strong>{money(quote.data.targetAmount, quote.data.toCurrency)}</strong>. Reference value {money(quote.data.marketTargetAmount, quote.data.toCurrency)}; system margin {money(quote.data.systemMarginAmount, quote.data.toCurrency)}; fee {money(quote.data.feeAmount, quote.data.toCurrency)}. Published {quote.data.sourceDate}.</span></div>}
          </Async>
          {quote.isError && <Note tone="danger">{(quote.error as Error)?.message || 'A fresh market quote is unavailable; conversion is disabled.'}</Note>}
          {message && <Note>{message}</Note>}
          <Err error={error} />
          {capabilities.isError && <Err error={capabilities.error} />}
          {!canConvert && <Note tone="warn">{capabilities.disabledReason('walletConversion')}</Note>}
          <Btn type="submit" disabled={!canConvert || !quote.data || !quoteEnabled || quote.isFetching || !accountByCurrency.has(from)} testId="button-convert-wallet"><ArrowLeftRight size={15} />Review conversion</Btn>
        </form>
      </Card>
      <Card title="Balance policy" subtitle="Funding and payout safeguards">
        <div className="form-stack">
          <Note tone="warn">New wallets start at zero. Successful payment transactions, projected settlements, and expected T+3 dates never increase an available balance.</Note>
          <Note>Wallet movements use integer minor units and a balanced, append-only journal. Conversion quotes retain their rate date, execution rate, schedule markup, target-currency spread and fee.</Note>
          <Note tone="warn">Payout requests reserve funds until their outcome is confirmed. Unclear outcomes remain on hold.</Note>
        </div>
      </Card>
    </div>

    {confirmOpen && quote.data && <Modal title="Confirm wallet conversion" onClose={() => setConfirmOpen(false)}>
      <div className="form-stack" data-testid="dialog-wallet-conversion-confirm">
        <Note tone="warn">This moves funds between your Greenpay wallets. The quote is valid until {fmtDate(quote.data.expiresAt)}. If the rate or fee changes, confirmation will be rejected so you can review a fresh quote.</Note>
        <div className="kv">
          <div><span>From</span><strong>{money(quote.data.sourceAmount, quote.data.fromCurrency)}</strong></div>
          <div><span>Reference market rate</span><strong>1 {quote.data.fromCurrency} = {quote.data.sourceRate} {quote.data.toCurrency}</strong></div>
          <div><span>Market value before margin</span><strong>{money(quote.data.marketTargetAmount, quote.data.toCurrency)}</strong></div>
          <div><span>System profit margin ({quote.data.currencySpreadBps} bps)</span><strong>− {money(quote.data.systemMarginAmount, quote.data.toCurrency)}</strong></div>
          <div><span>Merchant schedule markup ({quote.data.scheduleMarkupBps} bps)</span><strong>− {money(quote.data.scheduleMarkupAmount, quote.data.toCurrency)}</strong></div>
          <div><span>Conversion fee</span><strong>− {money(quote.data.feeAmount, quote.data.toCurrency)}</strong></div>
          <div><span>Rate after markup</span><strong>1 {quote.data.fromCurrency} = {quote.data.effectiveRate} {quote.data.toCurrency}</strong></div>
          <div><span>Credited to {quote.data.toCurrency} wallet</span><strong>{money(quote.data.targetAmount, quote.data.toCurrency)}</strong></div>
          <div><span>Rate publication date</span><strong>{quote.data.sourceDate}</strong></div>
        </div>
        <Note>On confirmation, both wallet balances and balanced ledger entries update together. This signed quote is tied to the amount and request key shown.</Note>
        <div className="row-actions">
          <Btn variant="secondary" onClick={() => setConfirmOpen(false)} disabled={submittingConversion}>Cancel</Btn>
          <Btn onClick={() => void confirmConversion()} disabled={!canConvert || quote.isFetching || submittingConversion} testId="button-confirm-wallet-conversion">
            {submittingConversion && <LoaderCircle size={14} className="spin" />}Confirm conversion
          </Btn>
        </div>
      </div>
    </Modal>}

    <Card title="Wallet journal" subtitle="Posted entries only; held or forecast amounts are not available funds." className="currency-panel">
      <Async q={ledger} empty={!ledger.data?.items.length} emptyTitle="No posted wallet activity" emptyBody="Confirmed settlements, internal conversions and payout decisions will be listed here.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Currency</th><th>Direction</th><th className="num">Amount</th><th>Type</th><th>Evidence</th><th>Posted</th></tr></thead><tbody>
          {(ledger.data?.items ?? []).map((entry) => <tr key={entry.id}><td className="mono">{entry.reference}</td><td>{entry.currency}</td><td>{entry.direction === 'credit' ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />} {nice(entry.direction)}</td><td className="num">{money(entry.amount, entry.currency)}</td><td>{nice(entry.kind)}</td><td>{entry.evidenceReference || '—'}</td><td>{fmtDate(entry.createdAt)}</td></tr>)}
        </tbody></table></div>
      </Async>
    </Card>
  </>;
}

export function PayoutRequestsPage() {
  return <Gate need="merchant"><PayoutRequestInner /></Gate>;
}

function PayoutRequestInner() {
  const wallets = useListMerchantWallets({ query: { queryKey: ['merchant-wallets'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const requests = useListMerchantPayoutRequests({ query: { queryKey: ['merchant-payout-requests'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const destinations = useQuery({
    queryKey: ['merchant-wallet-payout-destinations'],
    queryFn: () => walletApi<{ items: WalletPayoutDestination[] }>('/wallets/payout-destinations'),
    refetchInterval: 20_000,
  });
  const changes = useQuery({
    queryKey: ['merchant-wallet-payout-destination-changes'],
    queryFn: () => walletApi<{ items: WalletDestinationChange[] }>('/wallets/payout-destination-changes'),
    refetchInterval: 20_000,
  });
  const capabilities = useMerchantActionCapability();
  const invalidate = useInvalidateAll();
  const [currencyCode, setCurrencyCode] = useState('');
  const [methodValue, setMethodValue] = useState('');
  const [editDestinationId, setEditDestinationId] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const key = useRef(requestKey());
  const destinationKey = useRef(requestKey());
  const walletItems = wallets.data?.items ?? [];
  const balances = useMemo(() => includeSupportedWallets(walletItems), [walletItems]);
  const currency = currencyCode || balances[0]?.currency || '';
  const methods = useListMerchantWalletPayoutMethods({ currency }, {
    query: { queryKey: ['merchant-wallet-payout-methods', currency], enabled: currency.length === 3, refetchOnMount: 'always', staleTime: 0 },
  });
  const items = requests.data?.items ?? [];
  const currentDestinations = (destinations.data?.items ?? []).filter((destination) => destination.currency === currency);
  const mayRequestPayout = capabilities.can('payoutRequests');
  const mayChangeDestination = capabilities.role === 'owner' || capabilities.role === 'finance'
    ? capabilities.controls?.destinationChanges === true
    : false;
  const destinationDisabledReason = capabilities.isLoading
    ? 'Loading current merchant permissions.'
    : capabilities.isError
      ? 'Merchant permissions could not be verified. Retry before changing a destination.'
      : capabilities.role === 'viewer'
        ? 'Your read-only accountant role cannot change payout destinations.'
          : !capabilities.controls?.destinationChanges
          ? 'Destination changes are currently unavailable. Contact Greenpay support for help.'
          : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = {
      amount: Number(form.get('amount')),
      currency,
      destinationId: Number(form.get('destinationId')),
    };
    try {
      const request = await walletApi<WalletPayoutReviewItem>('/wallets/payout-requests', {
        method: 'POST', body, idempotencyKey: key.current,
      });
      key.current = requestKey();
      setMessage(`Request ${request.reference} reserved ${money(request.amount + request.fee, request.currency)} and is pending.`);
      formElement.reset();
      await invalidate();
    } catch (failure) {
      setError(failure);
    }
  }

  async function submitDestination(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const accountNumber = String(form.get('accountNumber') || '').trim();
    const body = {
      ...(editDestinationId ? { destinationId: Number(editDestinationId) } : {}),
      label: String(form.get('label') || '').trim(),
      currency,
      method: String(form.get('method') || ''),
      accountName: String(form.get('accountName') || '').trim(),
      accountNumber,
      ...(String(form.get('bankCode') || '').trim() ? { bankCode: String(form.get('bankCode')).trim() } : {}),
      ...(String(form.get('bankName') || '').trim() ? { bankName: String(form.get('bankName')).trim() } : {}),
    };
    try {
      const change = await walletApi<WalletDestinationChange>('/wallets/payout-destinations', {
        method: 'POST', body, idempotencyKey: destinationKey.current,
      });
      destinationKey.current = requestKey();
      setMessage(`Destination change submitted. Your current destination remains active until the new details are approved.`);
      formElement.reset();
      setEditDestinationId('');
      setDestinationLabel('');
      await invalidate();
    } catch (failure) {
      setError(failure);
    }
  }

  const activeMethods = methods.data?.available ? methods.data.methods : [];
  const selectedMethod = activeMethods.find((item) => item.value === methodValue) ?? activeMethods[0];
  return <>
    <Heading eyebrow="MERCHANT / PAYOUTS" title="Payout requests" subtitle="Choose an approved saved destination. Funds are reserved immediately, and you can track each request's status below." />
    <div className="split">
      <Card title="Request a payout" subtitle={methods.data?.available ? `Minimum withdrawal ${money(methods.data.minimumWithdrawal, currency)} · fees are reserved with the request.` : 'Payout options are temporarily unavailable.'}>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Wallet currency"><select value={currency} onChange={(event) => { setCurrencyCode(event.target.value); setEditDestinationId(''); setDestinationLabel(''); }} required data-testid="select-payout-currency">{balances.map((wallet) => <option key={wallet.currency}>{wallet.currency}</option>)}</select></Field>
          <Field label="Amount to recipient" hint={balances.find((wallet) => wallet.currency === currency) ? `Available before fees: ${money(balances.find((wallet) => wallet.currency === currency)?.availableBalance, currency)}` : 'No balance is available.'}><input name="amount" type="number" min={methods.data?.minimumWithdrawal || 0.01} step="0.01" required data-testid="input-payout-amount" /></Field>
          <Field label="Approved saved destination"><select name="destinationId" defaultValue="" required disabled={!currentDestinations.length} data-testid="select-payout-destination"><option value="" disabled>{currentDestinations.length ? 'Choose an approved destination' : 'No approved destination for this currency'}</option>{currentDestinations.map((destination) => <option value={destination.id} key={destination.id}>{destination.label} · {destination.accountName} · {destination.maskedAccount}</option>)}</select></Field>
          {!currentDestinations.length && <Note tone="warn">Create a saved destination below. It will be available once approved.</Note>}
          {methods.isError && <Err error={methods.error} />}
          {methods.data && !methods.data.available && <Note tone="warn">Payouts are currently unavailable for {currency}. No request can be submitted.</Note>}
          {methods.data && <Note>Current payout fee: {methods.data.fee.type === 'flat' ? money(methods.data.fee.amount, currency) : `${methods.data.fee.percent ?? 0}% (minimum ${money(methods.data.fee.floor ?? 0, currency)})`}. The fee is part of the reserved amount.</Note>}
          {capabilities.isError && <Err error={capabilities.error} />}
          {!mayRequestPayout && <Note tone="warn">{capabilities.disabledReason('payoutRequests')}</Note>}
          {message && <Note>{message}</Note>}
          <Err error={error} />
          <Btn type="submit" disabled={!mayRequestPayout || !methods.data?.available || !activeMethods.length || !currentDestinations.length} testId="button-create-payout-request"><ArrowUpRight size={15} />Reserve payout request</Btn>
        </form>
      </Card>
      <Card title="Available wallets" subtitle="Balances are refreshed across sessions; only the available column may be requested.">
        <Async q={wallets} empty={!balances.length} emptyTitle="No wallet balances" emptyBody="The wallet balance appears after merchant onboarding.">
          <div className="kv">{balances.map((wallet) => <div key={wallet.currency}><span>{wallet.currency} available</span><strong>{money(wallet.availableBalance, wallet.currency)}</strong><span>Reserved</span><strong>{money(wallet.reservedBalance, wallet.currency)}</strong></div>)}</div>
        </Async>
        <div className="form-stack" style={{ marginTop: 14 }}><Note tone="warn">A pending or uncertain payout remains held. Rejected or confirmed failed requests release the reservation; completed payouts post once.</Note></div>
      </Card>
    </div>
      <Card title="Saved payout destinations" subtitle="Account numbers are encrypted at rest and only masks are returned. New or changed destinations become active once approved.">
      <div className="split">
        <div className="form-stack">
          <Async q={destinations} empty={!destinations.data?.items.length} emptyBody="Submitted destinations appear here once approved.">
            <div className="kv">{destinations.data?.items.map((destination) => <div key={destination.id}><span>{destination.currency} · {destination.label}</span><strong>{destination.accountName} · {destination.maskedAccount}</strong><span>{nice(destination.method)}</span><span>Approved · {fmtDate(String(destination.approvedAt))}</span></div>)}</div>
          </Async>
            <Async q={changes} empty={!changes.data?.items.length} emptyTitle="No destination changes" emptyBody="Requested destination updates will appear here.">
            <div className="form-stack">{changes.data?.items.map((change) => <div className="route-hint" key={change.id}><ShieldCheck size={15} /><span><strong>{change.destination.currency} · {change.destination.label}</strong><span className="sub">{change.destination.accountName} · {change.destination.maskedAccount} · {nice(change.status)}</span>{change.status === 'rejected' && <span className="sub">This change was not approved. Submit updated details to try again.</span>}</span></div>)}</div>
          </Async>
        </div>
        <div>
          <form className="form-stack" onSubmit={submitDestination}>
            <h3>Register or change a destination</h3>
            <Field label="Wallet currency"><select value={currency} onChange={(event) => { setCurrencyCode(event.target.value); setEditDestinationId(''); setDestinationLabel(''); }} required data-testid="select-destination-currency">{balances.map((wallet) => <option key={wallet.currency}>{wallet.currency}</option>)}</select></Field>
            <Field label="Destination to change"><select value={editDestinationId} onChange={(event) => { const value = event.target.value; setEditDestinationId(value); setDestinationLabel(currentDestinations.find((destination) => String(destination.id) === value)?.label ?? ''); }} data-testid="select-destination-change"><option value="">Register a new destination</option>{currentDestinations.map((destination) => <option value={destination.id} key={destination.id}>{destination.label} · {destination.maskedAccount}</option>)}</select></Field>
            <Field label="Label"><input name="label" value={destinationLabel} onChange={(event) => setDestinationLabel(event.target.value)} maxLength={120} required placeholder="e.g. Operating account" data-testid="input-destination-label" /></Field>
            <Field label="Payout method"><select name="method" value={selectedMethod?.value ?? ''} onChange={(event) => setMethodValue(event.target.value)} required disabled={!activeMethods.length} data-testid="select-destination-method">{activeMethods.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></Field>
            <Field label="Beneficiary name"><input name="accountName" maxLength={200} required data-testid="input-destination-account-name" /></Field>
            <Field label="Account or phone number" hint="Entered details are encrypted; existing values cannot be retrieved or edited in place."><input name="accountNumber" type="password" autoComplete="off" minLength={3} maxLength={100} required data-testid="input-destination-account-number" /></Field>
            {selectedMethod?.requiresBankFields && <div className="form-grid"><Field label="Bank name"><input name="bankName" maxLength={200} required data-testid="input-destination-bank-name" /></Field><Field label="Bank code"><input name="bankCode" maxLength={100} required data-testid="input-destination-bank-code" /></Field></div>}
            {methods.isError && <Err error={methods.error} />}
            {capabilities.isError && <Err error={capabilities.error} />}
            {!mayChangeDestination && <Note tone="warn">{destinationDisabledReason}</Note>}
            <Note tone="warn">Submitting does not change the active destination immediately. The current version stays active until the change is approved.</Note>
            <Err error={error} />
            <Btn type="submit" disabled={!mayChangeDestination || !methods.data?.available || !activeMethods.length} testId="button-submit-destination-change"><ShieldCheck size={15} />Submit destination change</Btn>
          </form>
        </div>
      </div>
    </Card>
    <Card title="Your payout requests" subtitle="Track each request's amount, fee, destination and current status.">
      <Async q={requests} empty={!items.length} emptyTitle="No payout requests" emptyBody="A request will appear here after funds have been successfully reserved.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Request</th><th>Destination</th><th>Currency</th><th className="num">Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td className="mono">{item.reference}</td><td>{item.accountName}<span className="sub">{nice(item.method)} · {item.maskedAccount}</span></td><td>{item.currency}</td><td className="num">{money(item.amount, item.currency)}<span className="sub">Fee {money(item.fee, item.currency)}</span></td><td><Pill value={item.status} /></td><td>{fmtDate(item.createdAt)}</td></tr>)}
        </tbody></table></div>
      </Async>
    </Card>
  </>;
}

export function AdminWalletsPage() {
  return <Gate need="admin"><AdminWalletsInner /></Gate>;
}

function AdminWalletsInner() {
  const wallets = useListAdminWallets({ query: { queryKey: ['admin-wallets'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const settlements = useListSettlements(undefined, { query: { queryKey: ['admin-settlements'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const merchants = useListAdminMerchants(undefined, { query: { queryKey: ['admin-wallet-adjustment-merchants'], staleTime: 30_000 } });
  const airtimeTopups = useQuery<AdminAirtimeTopupReviewList>({
    queryKey: ['admin-airtime-topups-review'],
    queryFn: () => walletApi('/admin/airtime/topups/pending'),
    refetchInterval: 30_000,
  });
  const invalidate = useInvalidateAll();
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [adjustmentError, setAdjustmentError] = useState<unknown>(null);
  const [adjustmentMessage, setAdjustmentMessage] = useState('');
  const [adjustmentPending, setAdjustmentPending] = useState(false);
  const [adjustmentCurrency, setAdjustmentCurrency] = useState(CURRENCIES[0] ?? 'USD');
  const adjustmentKey = useRef<{ signature: string; key: string } | null>(null);
  const [airtimeCreditTopup, setAirtimeCreditTopup] = useState<AdminAirtimeTopupReviewList['items'][number] | null>(null);
  const [airtimeCreditError, setAirtimeCreditError] = useState<unknown>(null);
  const [airtimeCreditPending, setAirtimeCreditPending] = useState(false);
  const [airtimeCreditMessage, setAirtimeCreditMessage] = useState('');
  const airtimeCreditKey = useRef<{ signature: string; key: string } | null>(null);
  const items = wallets.data?.items ?? [];
  const merchantItems = merchants.data?.items ?? [];
  const airtimeItems = airtimeTopups.data?.items ?? [];
  const candidates = (settlements.data?.items ?? []).filter((item) => ['pending', 'due'].includes(item.status));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await confirmWalletSettlement({
        settlementReference: String(form.get('settlementReference') || ''),
        evidenceReference: String(form.get('evidenceReference') || '').trim(),
      });
      setMessage(`Credited ${money(result.fundedAmount, result.currency)} from settlement ${result.settlementReference}.`);
      await invalidate();
    } catch (failure) {
      setError(failure);
    }
  }
  async function submitAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      merchantId: Number(form.get('merchantId')),
      currency: String(form.get('currency') || '').toUpperCase(),
      direction: String(form.get('direction') || ''),
      amount: Number(form.get('amount')),
      reason: String(form.get('reason') || '').trim(),
    };
    setAdjustmentError(null);
    setAdjustmentMessage('');
    const signature = JSON.stringify(payload);
    if (!adjustmentKey.current || adjustmentKey.current.signature !== signature) {
      adjustmentKey.current = { signature, key: requestKey() };
    }
    setAdjustmentPending(true);
    try {
      const result = await walletApi<AdminWalletAdjustmentResponse>('/admin/wallets/adjustments', {
        method: 'POST',
        body: payload,
        idempotencyKey: adjustmentKey.current.key,
      });
      setAdjustmentMessage(
        `Posted ${result.direction} of ${money(result.amount, result.currency)} for ${result.businessName}. ` +
        `Available: ${money(result.availableBalance, result.currency)}; reserved: ${money(result.reservedBalance, result.currency)}. ` +
        `Journal ${result.reference}.`,
      );
      adjustmentKey.current = null;
      formElement.reset();
      setAdjustmentCurrency(CURRENCIES[0] ?? 'USD');
      await invalidate();
    } catch (failure) {
      setAdjustmentError(failure);
    } finally {
      setAdjustmentPending(false);
    }
  }
  async function submitAirtimeCredit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!airtimeCreditTopup) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      evidenceReference: String(form.get('evidenceReference') || '').trim().replace(/\s+/g, '').toUpperCase(),
      reason: String(form.get('reason') || '').trim(),
    };
    setAirtimeCreditError(null);
    setAirtimeCreditMessage('');
    const signature = JSON.stringify({ reference: airtimeCreditTopup.reference, ...payload });
    if (!airtimeCreditKey.current || airtimeCreditKey.current.signature !== signature) {
      airtimeCreditKey.current = { signature, key: requestKey() };
    }
    setAirtimeCreditPending(true);
    try {
      const result = await walletApi<AdminAirtimeTopupCreditResponse>(
        `/admin/airtime/topups/${encodeURIComponent(airtimeCreditTopup.reference)}/confirm-credit`,
        { method: 'POST', body: payload, idempotencyKey: airtimeCreditKey.current.key },
      );
      setAirtimeCreditMessage(
        `Confirmed ${money(result.amount, 'KES')} for ${result.businessName}. ` +
        `Available airtime balance: ${money(result.availableBalance, 'KES')}.`,
      );
      airtimeCreditKey.current = null;
      setAirtimeCreditTopup(null);
      formElement.reset();
      await invalidate();
    } catch (failure) {
      setAirtimeCreditError(failure);
    } finally {
      setAirtimeCreditPending(false);
    }
  }
  function openAirtimeCredit(topup: AdminAirtimeTopupReviewList['items'][number]) {
    setAirtimeCreditError(null);
    airtimeCreditKey.current = null;
    setAirtimeCreditTopup(topup);
  }
  return <>
    <Heading eyebrow="PLATFORM ADMIN / FINANCE" title="Merchant wallets" subtitle="Fund only after independently confirmed settlements. These balances are not forecasts or payment-success totals." />
    <div className="split">
      <Card title="Confirm settlement evidence" subtitle="Credits are capped at confirmed net collections less confirmed refunds. Evidence reference is required and audited.">
        <form className="form-stack" onSubmit={submit}>
          <Field label="Eligible provider settlement"><select name="settlementReference" required data-testid="select-settlement-reference">{candidates.map((item) => <option key={item.reference} value={item.reference}>{item.reference} · {money(item.netAmount, item.currency)} · {nice(item.status)}</option>)}</select></Field>
          <Field label="External evidence / bank reference" hint="Use the provider settlement confirmation identifier."><input name="evidenceReference" minLength={3} maxLength={200} required data-testid="input-settlement-evidence" /></Field>
          <Note tone="warn">This is an audited reconciliation action, not an automatic payment-success credit. It does not send a provider money call.</Note>
          {message && <Note>{message}</Note>}
          <Err error={error} />
          <Btn type="submit" disabled={!candidates.length} testId="button-confirm-wallet-settlement"><ShieldCheck size={15} />Confirm and fund wallet</Btn>
        </form>
      </Card>
      <Card title="Funding controls" subtitle="Evidence-backed ledger rules">
        <div className="form-stack">
          <Note>Every funding credit is bound to a successful merchant collection's settlement row and provider evidence. A source settlement can be credited once.</Note>
          <Note tone="warn">Confirmed customer refunds reduce eligible net proceeds. If credited funds have already been spent or reserved, the refund cannot consume more wallet proceeds.</Note>
          <Note>Manual corrections use a separate balanced adjustment journal; they do not change settlement or payment history.</Note>
        </div>
      </Card>
    </div>
    <Card title="Manual wallet adjustment" subtitle="Available balance only; every adjustment requires a reason and is recorded in the admin audit log.">
      <Note tone="warn">Credits and debits create append-only, balanced journal entries. Debits cannot use reserved funds. Use this for documented corrections, not provider settlement funding.</Note>
      <Async q={merchants} empty={!merchantItems.length} emptyTitle="No merchants available" emptyBody="A merchant must exist before its wallet can be adjusted.">
        <form className="form-stack" onSubmit={submitAdjustment}>
          <Field label="Merchant"><select name="merchantId" required defaultValue="" data-testid="select-adjust-wallet-merchant">
            <option value="" disabled>Select a merchant</option>
            {merchantItems.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.businessName} · #{merchant.id}</option>)}
          </select></Field>
          <div className="split">
            <Field label="Currency"><select name="currency" value={adjustmentCurrency} onChange={(event) => setAdjustmentCurrency(event.target.value as (typeof CURRENCIES)[number])} data-testid="select-adjust-wallet-currency">
              {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select></Field>
            <Field label="Direction"><select name="direction" defaultValue="credit" data-testid="select-adjust-wallet-direction">
              <option value="credit">Credit available balance</option>
              <option value="debit">Debit available balance</option>
            </select></Field>
          </div>
          <Field label="Amount" hint={`Precision: ${currencyAmountStep(adjustmentCurrency)} for ${adjustmentCurrency}.`}>
            <input type="number" name="amount" min="0" step={currencyAmountStep(adjustmentCurrency)} required data-testid="input-adjust-wallet-amount" />
          </Field>
          <Field label="Required audit reason"><textarea name="reason" minLength={3} maxLength={1000} required placeholder="Explain the documented correction" data-testid="input-adjust-wallet-reason" /></Field>
          {adjustmentMessage && <Note>{adjustmentMessage}</Note>}
          <Err error={adjustmentError} />
          <Btn type="submit" disabled={adjustmentPending || !merchantItems.length} testId="button-adjust-wallet-balance">
            {adjustmentPending && <LoaderCircle size={14} className="spin" />}Post audited adjustment
          </Btn>
        </form>
      </Async>
    </Card>
    <Card title="Airtime top-ups needing review" subtitle="Unconfirmed funding stays out of the merchant's available balance until verified.">
      {airtimeCreditMessage && <Note>{airtimeCreditMessage}</Note>}
      <Async q={airtimeTopups} empty={!airtimeItems.length} emptyTitle="No top-ups need review" emptyBody="Pending, unknown, and failed M-Pesa top-ups will appear here.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Merchant / request</th><th>Phone</th><th className="num">Amount</th><th>Status / last check</th><th>Action</th></tr></thead><tbody>
          {airtimeItems.map((item) => <tr key={item.reference}>
            <td><strong>{item.businessName}</strong><span className="sub">Merchant #{item.merchantId} · {item.reference}</span></td>
            <td>{item.phoneNumber}</td>
            <td className="num">{money(item.amount, 'KES')}</td>
            <td><Pill value={item.status} /><span className="sub">{item.lastError ?? (item.lastCheckedAt ? `Last checked ${fmtDate(item.lastCheckedAt)}` : 'Not checked yet')}</span></td>
            <td><Btn variant="secondary" small onClick={() => openAirtimeCredit(item)} testId="button-review-airtime-topup">Review receipt</Btn></td>
          </tr>)}
        </tbody></table></div>
        <div className="sub" style={{ marginTop: 10 }}>Showing the most recent 100 top-ups that are not yet credited.</div>
      </Async>
    </Card>
    <Card title="Per-currency balances" subtitle="Available balances exclude payout and refund reservations.">
      <Async q={wallets} empty={!items.length} emptyTitle="No funded merchant wallets" emptyBody="Wallets appear here only after their first confirmed settlement.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Merchant</th><th>Currency</th><th className="num">Available</th><th className="num">Reserved</th><th>Updated</th></tr></thead><tbody>
          {items.map((item, index) => <tr key={`${item.merchantId}-${item.currency}-${index}`}><td><strong>{item.businessName}</strong><span className="sub">Merchant #{item.merchantId}</span></td><td>{item.currency}</td><td className="num">{money(item.availableBalance, item.currency)}</td><td className="num">{money(item.reservedBalance, item.currency)}</td><td>{fmtDate(item.updatedAt)}</td></tr>)}
        </tbody></table></div>
      </Async>
      <div className="sub" style={{ marginTop: 12 }}>T+3 settlement status is not a funded balance. Each amount above comes from balanced append-only wallet journal entries.</div>
    </Card>
    {airtimeCreditTopup && <Modal
      title="Confirm M-Pesa top-up"
      description={`${airtimeCreditTopup.businessName} · ${airtimeCreditTopup.reference} · ${money(airtimeCreditTopup.amount, 'KES')}`}
      onClose={() => {
        if (airtimeCreditPending) return;
        setAirtimeCreditTopup(null);
        setAirtimeCreditError(null);
        airtimeCreditKey.current = null;
      }}
    >
      <form className="form-stack" onSubmit={submitAirtimeCredit}>
        <Note tone="warn">Confirm only after checking the successful M-Pesa receipt. This credits the full original top-up amount, changes its status to succeeded, and records your identity and reason. A receipt can be used only once.</Note>
        <Field label="M-Pesa receipt reference">
          <input name="evidenceReference" minLength={4} maxLength={100} autoCapitalize="characters" autoComplete="off" required data-testid="input-airtime-credit-evidence" />
        </Field>
        <Field label="Required audit reason">
          <textarea name="reason" minLength={3} maxLength={1000} required placeholder="Explain why the M-Pesa payment was verified manually" data-testid="input-airtime-credit-reason" />
        </Field>
        <Err error={airtimeCreditError} />
        <div className="row-actions">
          <Btn type="button" variant="secondary" disabled={airtimeCreditPending} onClick={() => {
            setAirtimeCreditTopup(null);
            setAirtimeCreditError(null);
            airtimeCreditKey.current = null;
          }}>Cancel</Btn>
          <Btn type="submit" disabled={airtimeCreditPending} testId="button-confirm-airtime-credit">
            {airtimeCreditPending && <LoaderCircle size={14} className="spin" />}Confirm and credit
          </Btn>
        </div>
      </form>
    </Modal>}
  </>;
}

export function AdminPayoutRequestsPage() {
  return <Gate need="admin"><AdminPayoutsInner /></Gate>;
}

function AdminPayoutsInner() {
  const q = useListAdminPayoutRequests(undefined, { query: { queryKey: ['admin-payout-requests'], refetchOnMount: 'always', refetchInterval: 20_000 } });
  const destinationChanges = useQuery({
    queryKey: ['admin-wallet-payout-destination-changes'],
    queryFn: () => walletApi<{ items: WalletDestinationChange[] }>('/admin/payout-destination-changes'),
    refetchInterval: 20_000,
  });
  const invalidate = useInvalidateAll();
  const [selected, setSelected] = useState<WalletPayoutReviewItem | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectingDestination, setRejectingDestination] = useState<WalletDestinationChange | null>(null);
  const [destinationRejectReason, setDestinationRejectReason] = useState('');
  const items = (q.data?.items ?? []) as unknown as WalletPayoutReviewItem[];
  const destinationItems = destinationChanges.data?.items ?? [];
  async function perform(action: 'approve' | 'reconcile', item: WalletPayoutReviewItem) {
    setError(null);
    setWorking(item.id);
    try {
      if (action === 'approve') {
        const secondApproval = String(item.status) === 'awaiting_second_approval';
        await walletApi(`/admin/payout-requests/${item.id}/approve`, {
          method: 'POST',
          ...(secondApproval ? { body: { destinationFingerprint: item.destinationFingerprint } } : {}),
        });
        setSelected(null);
      } else {
        await reconcilePayoutRequest(item.id);
      }
      await invalidate();
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(null);
    }
  }
  async function approveDestination(change: WalletDestinationChange) {
    setError(null);
    setWorking(change.id);
    try {
      await walletApi(`/admin/payout-destination-changes/${change.id}/approve`, {
        method: 'POST',
        ...(change.status === 'first_approved' ? { body: { destinationFingerprint: change.destinationFingerprint } } : {}),
      });
      await invalidate();
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(null);
    }
  }
  async function reject() {
    if (rejecting === null || !rejectReason.trim()) return;
    setError(null);
    setWorking(rejecting);
    try {
      await rejectPayoutRequest(rejecting, { reason: rejectReason.trim() });
      setRejecting(null);
      setRejectReason('');
      await invalidate();
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(null);
    }
  }
  async function rejectDestination() {
    if (!rejectingDestination || !destinationRejectReason.trim()) return;
    setError(null);
    setWorking(rejectingDestination.id);
    try {
      await walletApi(`/admin/payout-destination-changes/${rejectingDestination.id}/reject`, {
        method: 'POST', body: { reason: destinationRejectReason.trim() },
      });
      setRejectingDestination(null);
      setDestinationRejectReason('');
      await invalidate();
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(null);
    }
  }
  return <>
    <Heading eyebrow="PLATFORM ADMIN / PAYOUTS" title="Payout approvals" subtitle="Large payouts, payouts to new or changed destination versions, and every destination change require two different administrator identities. Provider submission happens only after the final approval commits." />
    <Err error={error} />
    <Async q={q} empty={!items.length} emptyTitle="No merchant payout requests" emptyBody="Merchant-initiated requests appear here after wallet funds are reserved.">
      <Card title="Payout review queue" subtitle="Raw destination account data is not exposed. A missing threshold is fail-closed and requires a second administrator; configure an explicit currency threshold in payout safety settings.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Request</th><th>Merchant</th><th>Recipient</th><th>Destination version</th><th className="num">Amount + fee</th><th>Status / safety</th><th>Requested</th><th>Review action</th></tr></thead><tbody>
          {items.map((item) => {
            const status = String(item.status);
            const pendingReview = status === 'requested' || status === 'awaiting_second_approval';
            const secondApproval = status === 'awaiting_second_approval';
            return <tr key={item.id}>
            <td className="mono">{item.reference}<span className="sub">#{item.id}</span></td><td>#{item.merchantId}</td>
            <td>{item.accountName}<span className="sub">{nice(item.method)}</span></td><td>{item.maskedAccount}<span className="sub">v{item.destinationVersion ?? 'legacy'} · {item.destinationFingerprint ? `${item.destinationFingerprint.slice(0, 12)}…` : 'legacy destination'}</span></td>
            <td className="num">{money(item.amount + item.fee, item.currency)}<span className="sub">{money(item.amount, item.currency)} recipient · {money(item.fee, item.currency)} fee</span></td>
            <td><Pill value={status} />{!item.thresholdConfigured && pendingReview && <span className="sub">No {item.currency} threshold configured · second approval required</span>}{item.largePayoutThreshold !== null && <span className="sub">Threshold {money(item.largePayoutThreshold, item.currency)}</span>}{item.requiresSecondApproval && pendingReview && <span className="sub">Two distinct admins required</span>}</td><td>{fmtDate(String(item.createdAt))}</td>
            <td><div className="row-actions">
              {pendingReview && <><Btn small disabled={working !== null || (secondApproval && !item.destinationFingerprint)} onClick={() => setSelected(item)} testId={`button-approve-payout-${item.id}`}>{secondApproval ? <ShieldCheck size={13} /> : <CheckCircle2 size={13} />}{secondApproval ? 'Second approval' : item.requiresSecondApproval ? 'Record first review' : 'Approve & submit once'}</Btn><Btn small variant="danger" disabled={working !== null} onClick={() => { setRejecting(item.id); setRejectReason(''); }}>Reject</Btn></>}
              {['approved', 'processing', 'uncertain'].includes(status) && <Btn small variant="secondary" disabled={working !== null} onClick={() => void perform('reconcile', item)}><RefreshCw size={13} className={working === item.id ? 'spin' : ''} />Check provider</Btn>}
              {working === item.id && <LoaderCircle size={14} className="spin" />}
            </div>{item.reviewHistory?.length > 0 && <details><summary>Approval history ({item.reviewHistory.length})</summary><div className="form-stack">{item.reviewHistory.map((entry, index) => <span className="sub" key={`${item.id}-${entry.stage}-${index}`}>{nice(entry.stage)} · {entry.actor} · {fmtDate(String(entry.occurredAt))} · {nice(entry.outcome)} · {money(entry.fee, item.currency)} fee · {entry.destination.maskedAccount} · {nice(entry.destination.method)} · {entry.destination.currency} · v{entry.destination.versionId ?? 'legacy'} · {entry.destination.fingerprint ? `${entry.destination.fingerprint.slice(0, 12)}…` : 'no fingerprint'}</span>)}</div></details>}</td>
          </tr>;
          })}
        </tbody></table></div>
      </Card>
    </Async>
    <Async q={destinationChanges} empty={!destinationItems.length} emptyTitle="No payout destination changes" emptyBody="Merchant destination requests appear here for independent two-person review.">
      <Card title="Saved destination change reviews" subtitle="The existing active version remains usable until a distinct second administrator approves the exact fingerprint. Raw account data is never shown.">
        <div className="form-stack">{destinationItems.map((change) => <div className="route-hint" key={change.id}>
          <ShieldCheck size={16} /><span><strong>{change.destination.currency} · {change.destination.label} · {change.destination.accountName} · {change.destination.maskedAccount}</strong><span className="sub">Destination #{change.destinationId ?? 'new'} · {nice(change.status)} · fingerprint {change.destinationFingerprint}</span>{change.decisionReason && <span className="sub">Decision: {change.decisionReason}</span>}
            {change.reviewHistory.map((entry, index) => <span className="sub" key={`${change.id}-${entry.stage}-${index}`}>{nice(entry.stage)} · {entry.actor} · {fmtDate(String(entry.occurredAt))} · {nice(entry.outcome)} · {entry.destination.maskedAccount} · {entry.destination.fingerprint.slice(0, 12)}…</span>)}
            {['requested', 'first_approved'].includes(change.status) && <span className="row-actions"><Btn small disabled={working !== null} onClick={() => void approveDestination(change)}>{change.status === 'first_approved' ? <ShieldCheck size={13} /> : <CheckCircle2 size={13} />}{change.status === 'first_approved' ? 'Second approval' : 'Record first review'}</Btn><Btn small variant="danger" disabled={working !== null} onClick={() => { setRejectingDestination(change); setDestinationRejectReason(''); }}>Reject change</Btn></span>}
          </span>
        </div>)}</div>
      </Card>
    </Async>
    {selected && <Modal title={selected.status === 'awaiting_second_approval' ? 'Second administrator approval' : selected.requiresSecondApproval ? 'Record first payout review' : 'Approve and submit payout'} description={`Payout ${selected.reference}: ${money(selected.amount, selected.currency)} to recipient plus ${money(selected.fee, selected.currency)} fee; destination ${selected.maskedAccount}.`} onClose={() => setSelected(null)}>
      <div className="form-stack">
        {selected.status === 'awaiting_second_approval'
          ? <Note tone="warn">This second approval is bound to fingerprint {selected.destinationFingerprint}. The server verifies a different administrator identity and the exact version before committing provider submission.</Note>
          : selected.requiresSecondApproval
            ? <Note tone="warn">This records the first review only. A second distinct administrator must independently verify the exact masked destination and fingerprint before any provider submission.</Note>
            : <Note tone="warn">This payout is within its configured threshold and uses an already approved destination. Approval commits before the single provider submission; uncertain outcomes stay held and are never automatically retried.</Note>}
        {!selected.thresholdConfigured && <Note tone="warn">No {selected.currency} threshold is configured. Do not infer one: the payout is fail-closed and requires two distinct administrators.</Note>}
        <p><strong>Destination fingerprint:</strong> <span className="mono">{selected.destinationFingerprint ?? 'Legacy destination — mandatory second review'}</span></p>
        <p><strong>Fee:</strong> {money(selected.fee, selected.currency)} · <strong>Threshold:</strong> {selected.largePayoutThreshold === null ? 'Not configured' : money(selected.largePayoutThreshold, selected.currency)}</p>
        <Err error={error} />
        <div className="row-actions"><Btn variant="secondary" onClick={() => setSelected(null)}>Cancel</Btn><Btn disabled={working !== null || (selected.status === 'awaiting_second_approval' && !selected.destinationFingerprint)} onClick={() => void perform('approve', selected)} testId="button-confirm-payout-approval"><ArrowUpRight size={14} />{selected.status === 'awaiting_second_approval' ? 'Approve and submit once' : selected.requiresSecondApproval ? 'Record first approval' : 'Approve and submit once'}</Btn></div>
      </div>
    </Modal>}
    {rejecting !== null && <Modal title="Reject payout request" description="Rejecting releases the held funds to the merchant available balance." onClose={() => { setRejecting(null); setRejectReason(''); }}>
      <div className="form-stack"><Field label="Reason"><textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={400} required data-testid="input-payout-rejection-reason" /></Field><Err error={error} /><div className="row-actions"><Btn variant="secondary" onClick={() => setRejecting(null)}>Cancel</Btn><Btn variant="danger" disabled={!rejectReason.trim() || working !== null} onClick={() => void reject()}>Reject and release</Btn></div></div>
    </Modal>}
    {rejectingDestination && <Modal title="Reject payout destination change" description={`Reject the proposed masked destination ${rejectingDestination.destination.maskedAccount}? The currently approved destination will remain active.`} onClose={() => { setRejectingDestination(null); setDestinationRejectReason(''); }}>
      <div className="form-stack"><Field label="Reason"><textarea value={destinationRejectReason} onChange={(event) => setDestinationRejectReason(event.target.value)} maxLength={400} required data-testid="input-destination-rejection-reason" /></Field><Err error={error} /><div className="row-actions"><Btn variant="secondary" onClick={() => setRejectingDestination(null)}>Cancel</Btn><Btn variant="danger" disabled={!destinationRejectReason.trim() || working !== null} onClick={() => void rejectDestination()}>Reject change</Btn></div></div>
    </Modal>}
  </>;
}