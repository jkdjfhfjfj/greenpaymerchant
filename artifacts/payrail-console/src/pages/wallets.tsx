import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import {
  confirmWalletSettlement, convertMerchantWalletFunds,
  reconcilePayoutRequest, rejectPayoutRequest,
  useGetMerchantWalletFxQuote, useListAdminPayoutRequests, useListAdminWallets,
  useListMerchantPayoutRequests, useListMerchantWalletLedger,
  useListMerchantWalletPayoutMethods, useListMerchantWallets, useListSettlements,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CURRENCIES, Err, Field, Gate, Heading, Modal, Note, Pill, fmtDate, money, nice, useInvalidateAll } from '@/components/kit';
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
  version: number;
  currency: string;
  label: string;
  method: string;
  accountName: string;
  maskedAccount: string;
  fingerprint: string;
  status: string;
  approvedBy: string;
  approvedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
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
  const idempotencyKey = useRef(requestKey());
  const walletItems = wallets.data?.items ?? [];
  const accounts = useMemo(() => includeSupportedWallets(walletItems), [walletItems]);
  const from = fromCurrency || accounts[0]?.currency || '';
  const to = toCurrency || accounts.find((account) => account.currency !== from)?.currency || '';
  const amountNumber = Number(amount);
  const quoteEnabled = amountNumber > 0 && Number.isFinite(amountNumber) && from.length === 3 && to.length === 3 && from !== to;
  const quote = useGetMerchantWalletFxQuote({
    amount: quoteEnabled ? amountNumber : 0,
    from,
    to,
  }, { query: { queryKey: ['merchant-wallet-fx-quote', from, to, amountNumber], enabled: quoteEnabled, staleTime: 0, refetchOnWindowFocus: true } });
  const accountByCurrency = useMemo(() => new Map(accounts.map((account) => [account.currency, account])), [accounts]);
  const canConvert = capabilities.can('walletConversion');

  async function submitConversion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    try {
      const result = await convertMerchantWalletFunds(
        { amount: amountNumber, fromCurrency: from, toCurrency: to },
        { headers: { 'Idempotency-Key': idempotencyKey.current } },
      );
      idempotencyKey.current = requestKey();
      setMessage(`Internal allocation posted: ${money(result.sourceAmount, result.fromCurrency)} to ${money(result.targetAmount, result.toCurrency)}.`);
      setAmount('');
      await invalidate();
    } catch (failure) {
      setError(failure);
    }
  }

  return <>
    <Heading eyebrow="MERCHANT / WALLET" title="Funded balances" subtitle="Only administrator-confirmed provider settlements are withdrawable. Payment success and T+3 forecasts are not wallet funds." />
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
            <Field label="From wallet"><select value={from} onChange={(event) => { setFromCurrency(event.target.value); setToCurrency(''); }} required data-testid="select-wallet-from">{accounts.map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
            <Field label="To wallet"><select value={to} onChange={(event) => setToCurrency(event.target.value)} required data-testid="select-wallet-to">{accounts.filter((account) => account.currency !== from).map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
          </div>
          <Field label={`Amount (${from || 'source currency'})`} hint={accountByCurrency.has(from) ? `Available: ${money(accountByCurrency.get(from)?.availableBalance, from)}` : 'No funded source wallet is available.'}>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required data-testid="input-wallet-conversion-amount" />
          </Field>
          <Async q={quote} empty={!quoteEnabled} emptyTitle="Enter a source amount" emptyBody="A current market rate will be requested after both wallets and an amount are selected.">
            {quote.data && <div className="route-hint"><ArrowLeftRight size={15} /><span>{money(quote.data.sourceAmount, quote.data.fromCurrency)} at {quote.data.effectiveRate} → <strong>{money(quote.data.targetAmount, quote.data.toCurrency)}</strong>. Fee {money(quote.data.feeAmount, quote.data.toCurrency)}; schedule markup {quote.data.scheduleMarkupBps} bps + {quote.data.currencySpreadBps} bps {quote.data.toCurrency} spread. Rate from {quote.data.source}, dated {quote.data.quotedAt.toLocaleString()}.</span></div>}
          </Async>
          {quote.isError && <Note tone="danger">{(quote.error as Error)?.message || 'A fresh market quote is unavailable; conversion is disabled.'}</Note>}
          {message && <Note>{message}</Note>}
          <Err error={error} />
          {capabilities.isError && <Err error={capabilities.error} />}
          {!canConvert && <Note tone="warn">{capabilities.disabledReason('walletConversion')}</Note>}
          <Btn type="submit" disabled={!canConvert || !quote.data || !quoteEnabled || quote.isFetching || !accountByCurrency.has(from)} testId="button-convert-wallet"><ArrowLeftRight size={15} />Convert internally</Btn>
        </form>
      </Card>
      <Card title="Balance policy" subtitle="Funding and payout safeguards">
        <div className="form-stack">
          <Note tone="warn">New wallets start at zero. Successful payment transactions, projected settlements, and expected T+3 dates never increase an available balance.</Note>
          <Note>Wallet movements use integer minor units and a balanced, append-only journal. Conversion quotes retain their rate date, execution rate, schedule markup, target-currency spread and fee.</Note>
          <Note tone="warn">Payout requests reserve funds for administrator review. Provider configuration and approval are required before submission; uncertain outcomes stay held.</Note>
        </div>
      </Card>
    </div>

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
          ? 'Destination changes are disabled by the merchant administrator.'
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
      setMessage(`Request ${request.reference} reserved ${money(request.amount + request.fee, request.currency)}. ${request.requiresSecondApproval ? 'Two distinct platform-admin approvals are required before submission.' : 'It is awaiting platform-admin review.'}`);
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
      setMessage(`Destination change #${change.id} is queued for two distinct platform-admin approvals. The active destination is unchanged until both reviews are complete.`);
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
    <Heading eyebrow="MERCHANT / PAYOUTS" title="Payout requests" subtitle="Choose an approved saved destination. Funds are reserved immediately and sensitive payouts are submitted only after two different platform administrators approve." />
    <div className="split">
      <Card title="Request a payout" subtitle={methods.data?.available ? `Provider minimum ${money(methods.data.minimumWithdrawal, currency)} · fees are reserved with the request.` : 'Live methods are loaded from the configured payout provider.'}>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Wallet currency"><select value={currency} onChange={(event) => { setCurrencyCode(event.target.value); setEditDestinationId(''); setDestinationLabel(''); }} required data-testid="select-payout-currency">{balances.map((wallet) => <option key={wallet.currency}>{wallet.currency}</option>)}</select></Field>
          <Field label="Amount to recipient" hint={balances.find((wallet) => wallet.currency === currency) ? `Available before fees: ${money(balances.find((wallet) => wallet.currency === currency)?.availableBalance, currency)}` : 'No balance is available.'}><input name="amount" type="number" min={methods.data?.minimumWithdrawal || 0.01} step="0.01" required data-testid="input-payout-amount" /></Field>
          <Field label="Approved saved destination"><select name="destinationId" defaultValue="" required disabled={!currentDestinations.length} data-testid="select-payout-destination"><option value="" disabled>{currentDestinations.length ? 'Choose an approved destination' : 'No approved destination for this currency'}</option>{currentDestinations.map((destination) => <option value={destination.id} key={destination.id}>{destination.label} · {destination.accountName} · {destination.maskedAccount} · v{destination.version}</option>)}</select></Field>
          {!currentDestinations.length && <Note tone="warn">Create a saved destination below. It cannot be used until two distinct platform administrators approve it.</Note>}
          {methods.isError && <Err error={methods.error} />}
          {methods.data && !methods.data.available && <Note tone="warn">Provider payouts are currently unavailable for {currency}. No request can be submitted.</Note>}
          {methods.data && <Note>Current provider fee: {methods.data.fee.type === 'flat' ? money(methods.data.fee.amount, currency) : `${methods.data.fee.percent ?? 0}% (minimum ${money(methods.data.fee.floor ?? 0, currency)})`}. The fee is part of the reserved amount.</Note>}
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
    <Card title="Saved payout destinations" subtitle="Account numbers are encrypted at rest and only masks are returned. Every new or changed destination is immutable and needs two different platform-admin approvals.">
      <div className="split">
        <div className="form-stack">
          <Async q={destinations} empty={!destinations.data?.items.length} emptyTitle="No approved destinations" emptyBody="Submitted destinations appear here only after two distinct administrator approvals.">
            <div className="kv">{destinations.data?.items.map((destination) => <div key={destination.id}><span>{destination.currency} · {destination.label}</span><strong>{destination.accountName} · {destination.maskedAccount}</strong><span>{nice(destination.method)} · version {destination.version}</span><span>Approved by {destination.approvedBy} · {fmtDate(String(destination.approvedAt))}</span></div>)}</div>
          </Async>
          <Async q={changes} empty={!changes.data?.items.length} emptyTitle="No destination changes" emptyBody="Requested destination changes and their review stages will appear here.">
            <div className="form-stack">{changes.data?.items.map((change) => <div className="route-hint" key={change.id}><ShieldCheck size={15} /><span><strong>{change.destination.currency} · {change.destination.label}</strong><span className="sub">{change.destination.accountName} · {change.destination.maskedAccount} · {nice(change.status)} · fingerprint {change.destinationFingerprint.slice(0, 12)}…</span>{change.decisionReason && <span className="sub">Decision: {change.decisionReason}</span>}{change.reviewHistory.map((entry, index) => <span className="sub" key={`${change.id}-${entry.stage}-${index}`}>{nice(entry.stage)} by {entry.actor} · {fmtDate(String(entry.occurredAt))} · {nice(entry.outcome)}</span>)}</span></div>)}</div>
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
            <Note tone="warn">Submitting never changes the live destination immediately. The old approved version stays active until a second, different admin approves this exact fingerprint.</Note>
            <Err error={error} />
            <Btn type="submit" disabled={!mayChangeDestination || !methods.data?.available || !activeMethods.length} testId="button-submit-destination-change"><ShieldCheck size={15} />Submit for two-person review</Btn>
          </form>
        </div>
      </div>
    </Card>
    <Card title="Your payout requests" subtitle="Review history retains the amount, fee, masked destination, timestamps and each approver.">
      <Async q={requests} empty={!items.length} emptyTitle="No payout requests" emptyBody="A request will appear here after funds have been successfully reserved.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Request</th><th>Destination</th><th>Currency</th><th className="num">Amount</th><th>Status</th><th>Review history</th><th>Created</th></tr></thead><tbody>
          {items.map((item) => {
            const review = item as unknown as WalletPayoutReviewItem;
            return <tr key={item.id}><td className="mono">{item.reference}<span className="sub">Destination version {review.destinationVersion ?? 'legacy'}</span></td><td>{item.accountName}<span className="sub">{nice(item.method)} · {item.maskedAccount}</span></td><td>{item.currency}</td><td className="num">{money(item.amount, item.currency)}<span className="sub">Fee {money(item.fee, item.currency)}</span></td><td><Pill value={item.status} />{review.requiresSecondApproval && <span className="sub">Two approvals required</span>}</td><td><details><summary>{review.reviewHistory?.length ?? 1} events</summary><div className="form-stack">{(review.reviewHistory ?? []).map((entry, index) => <span className="sub" key={`${item.id}-${entry.stage}-${index}`}>{nice(entry.stage)} · {entry.actor} · {fmtDate(String(entry.occurredAt))} · {nice(entry.outcome)} · {money(entry.fee, item.currency)} fee · {entry.destination.maskedAccount} · v{entry.destination.versionId ?? 'legacy'}</span>)}</div></details></td><td>{fmtDate(item.createdAt)}</td></tr>;
          })}
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
  const invalidate = useInvalidateAll();
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const items = wallets.data?.items ?? [];
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
          <Note tone="warn">No automatic or arbitrary balance adjustment endpoint exists. Funding starts at zero until this confirmation workflow posts a balanced journal.</Note>
        </div>
      </Card>
    </div>
    <Card title="Per-currency balances" subtitle="Available balances exclude payout and refund reservations.">
      <Async q={wallets} empty={!items.length} emptyTitle="No funded merchant wallets" emptyBody="Wallets appear here only after their first confirmed settlement.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Merchant</th><th>Currency</th><th className="num">Available</th><th className="num">Reserved</th><th>Updated</th></tr></thead><tbody>
          {items.map((item, index) => <tr key={`${item.merchantId}-${item.currency}-${index}`}><td><strong>{item.businessName}</strong><span className="sub">Merchant #{item.merchantId}</span></td><td>{item.currency}</td><td className="num">{money(item.availableBalance, item.currency)}</td><td className="num">{money(item.reservedBalance, item.currency)}</td><td>{fmtDate(item.updatedAt)}</td></tr>)}
        </tbody></table></div>
      </Async>
      <div className="sub" style={{ marginTop: 12 }}>T+3 settlement status is not a funded balance. Each amount above comes from balanced append-only wallet journal entries.</div>
    </Card>
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