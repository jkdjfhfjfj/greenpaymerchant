import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import {
  approvePayoutRequest, confirmWalletSettlement, convertMerchantWalletFunds,
  createMerchantPayoutRequest, reconcilePayoutRequest, rejectPayoutRequest,
  useGetMerchantWalletFxQuote, useListAdminPayoutRequests, useListAdminWallets,
  useListMerchantPayoutRequests, useListMerchantWalletLedger,
  useListMerchantWalletPayoutMethods, useListMerchantWallets, useListSettlements,
} from '@workspace/api-client-react';
import { Async, Btn, Card, Err, Field, Gate, Heading, Modal, Note, Pill, fmtDate, money, nice, useInvalidateAll } from '@/components/kit';

function requestKey() {
  return crypto.randomUUID();
}

export function WalletPage() {
  return <Gate need="merchant"><WalletInner /></Gate>;
}

function WalletInner() {
  const wallets = useListMerchantWallets({ query: { queryKey: ['merchant-wallets'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const ledger = useListMerchantWalletLedger(undefined, { query: { queryKey: ['merchant-wallet-ledger'], refetchOnMount: 'always', refetchInterval: 30_000 } });
  const invalidate = useInvalidateAll();
  const [fromCurrency, setFromCurrency] = useState('');
  const [toCurrency, setToCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const idempotencyKey = useRef(requestKey());
  const accounts = wallets.data?.items ?? [];
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
    <Async q={wallets} empty={!accounts.length} emptyTitle="No currency wallets" emptyBody="A zero-balance wallet is created for your merchant base currency. Other currency wallets appear only after an administrator confirms settlement evidence.">
      <div className="metric-grid">
        {accounts.map((account) => <section className="metric-card tone-mint" key={account.currency}>
          <div className="metric-top"><span>{account.currency} available</span><span className="metric-icon"><WalletCards size={17} /></span></div>
          <div className="metric-value">{money(account.availableBalance, account.currency)}</div>
          <div className="metric-detail">Reserved {money(account.reservedBalance, account.currency)} · updated {fmtDate(account.updatedAt)}</div>
        </section>)}
      </div>
    </Async>

    <div className="split" style={{ marginTop: 16 }}>
      <Card title="Convert wallet funds" subtitle="Fresh public market rate, existing platform markup and fee schedule. Conversion is an internal allocation—not external bank FX.">
        <form className="form-stack" onSubmit={submitConversion}>
          <div className="form-grid">
            <Field label="From wallet"><select value={from} onChange={(event) => { setFromCurrency(event.target.value); setToCurrency(''); }} required data-testid="select-wallet-from">{accounts.map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
            <Field label="To wallet"><select value={to} onChange={(event) => setToCurrency(event.target.value)} required data-testid="select-wallet-to">{accounts.filter((account) => account.currency !== from).map((account) => <option key={account.currency}>{account.currency}</option>)}</select></Field>
          </div>
          <Field label={`Amount (${from || 'source currency'})`} hint={accountByCurrency.has(from) ? `Available: ${money(accountByCurrency.get(from)?.availableBalance, from)}` : 'No funded source wallet is available.'}>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required data-testid="input-wallet-conversion-amount" />
          </Field>
          <Async q={quote} empty={!quoteEnabled} emptyTitle="Enter a source amount" emptyBody="A current market rate will be requested after both wallets and an amount are selected.">
            {quote.data && <div className="route-hint"><ArrowLeftRight size={15} /><span>{money(quote.data.sourceAmount, quote.data.fromCurrency)} at {quote.data.effectiveRate} → <strong>{money(quote.data.targetAmount, quote.data.toCurrency)}</strong>. Fee {money(quote.data.feeAmount, quote.data.toCurrency)}; rate dated {quote.data.quotedAt.toLocaleString()}.</span></div>}
          </Async>
          {quote.isError && <Note tone="danger">{(quote.error as Error)?.message || 'A fresh market quote is unavailable; conversion is disabled.'}</Note>}
          {message && <Note>{message}</Note>}
          <Err error={error} />
          <Btn type="submit" disabled={!quote.data || !quoteEnabled || quote.isFetching || !accountByCurrency.has(from)} testId="button-convert-wallet"><ArrowLeftRight size={15} />Convert internally</Btn>
        </form>
      </Card>
      <Card title="Balance policy" subtitle="Funding and payout safeguards">
        <div className="form-stack">
          <Note tone="warn">New wallets start at zero. Successful payment transactions, projected settlements, and expected T+3 dates never increase an available balance.</Note>
          <Note>Wallet movements use integer minor units and a balanced, append-only journal. Conversion quotes retain their rate date, execution rate, markup and fee.</Note>
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
  const invalidate = useInvalidateAll();
  const [currencyCode, setCurrencyCode] = useState('');
  const [methodValue, setMethodValue] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const key = useRef(requestKey());
  const balances = wallets.data?.items ?? [];
  const currency = currencyCode || balances[0]?.currency || '';
  const methods = useListMerchantWalletPayoutMethods({ currency }, {
    query: { queryKey: ['merchant-wallet-payout-methods', currency], enabled: currency.length === 3, refetchOnMount: 'always', staleTime: 0 },
  });
  const items = requests.data?.items ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = {
      amount: Number(form.get('amount')),
      currency,
      method: String(form.get('method') || ''),
      accountName: String(form.get('accountName') || '').trim(),
      accountNumber: String(form.get('accountNumber') || '').trim(),
      ...(String(form.get('bankCode') || '').trim() ? { bankCode: String(form.get('bankCode')).trim() } : {}),
      ...(String(form.get('bankName') || '').trim() ? { bankName: String(form.get('bankName')).trim() } : {}),
    };
    try {
      const request = await createMerchantPayoutRequest(body, { headers: { 'Idempotency-Key': key.current } });
      key.current = requestKey();
      setMessage(`Request ${request.reference} reserved ${money(request.amount + request.fee, request.currency)} for administrator review.`);
      formElement.reset();
      await invalidate();
    } catch (failure) {
      setError(failure);
    }
  }

  const activeMethods = methods.data?.available ? methods.data.methods : [];
  const selectedMethod = activeMethods.find((item) => item.value === methodValue) ?? activeMethods[0];
  return <>
    <Heading eyebrow="MERCHANT / PAYOUTS" title="Payout requests" subtitle="Request a withdrawal from funded wallet balance. Funds are reserved immediately and submitted only after administrator approval." />
    <div className="split">
      <Card title="Request a payout" subtitle={methods.data?.available ? `Provider minimum ${money(methods.data.minimumWithdrawal, currency)} · fees are reserved with the request.` : 'Live methods are loaded from the configured payout provider.'}>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Wallet currency"><select value={currency} onChange={(event) => setCurrencyCode(event.target.value)} required data-testid="select-payout-currency">{balances.map((wallet) => <option key={wallet.currency}>{wallet.currency}</option>)}</select></Field>
          <Field label="Amount to recipient" hint={balances.find((wallet) => wallet.currency === currency) ? `Available before fees: ${money(balances.find((wallet) => wallet.currency === currency)?.availableBalance, currency)}` : 'No balance is available.'}><input name="amount" type="number" min={methods.data?.minimumWithdrawal || 0.01} step="0.01" required data-testid="input-payout-amount" /></Field>
          <Field label="Payout method"><select name="method" value={selectedMethod?.value ?? ''} onChange={(event) => setMethodValue(event.target.value)} required disabled={!activeMethods.length} data-testid="select-payout-method">{activeMethods.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></Field>
          <Field label="Beneficiary name"><input name="accountName" maxLength={200} required data-testid="input-payout-account-name" /></Field>
          <Field label="Account or phone number" hint="Encrypted with the server's SESSION_SECRET; only a masked number is returned."><input name="accountNumber" type="password" autoComplete="off" minLength={3} maxLength={100} required data-testid="input-payout-account-number" /></Field>
          {selectedMethod?.requiresBankFields && <div className="form-grid"><Field label="Bank name"><input name="bankName" maxLength={200} required data-testid="input-payout-bank-name" /></Field><Field label="Bank code"><input name="bankCode" maxLength={100} required data-testid="input-payout-bank-code" /></Field></div>}
          {methods.isError && <Err error={methods.error} />}
          {methods.data && !methods.data.available && <Note tone="warn">Provider payouts are currently unavailable for {currency}. No request can be submitted.</Note>}
          {methods.data && <Note>Current provider fee: {methods.data.fee.type === 'flat' ? money(methods.data.fee.amount, currency) : `${methods.data.fee.percent ?? 0}% (minimum ${money(methods.data.fee.floor ?? 0, currency)})`}. The fee is part of the reserved amount.</Note>}
          {message && <Note>{message}</Note>}
          <Err error={error} />
          <Btn type="submit" disabled={!methods.data?.available || !activeMethods.length} testId="button-create-payout-request"><ArrowUpRight size={15} />Reserve payout request</Btn>
        </form>
      </Card>
      <Card title="Available wallets" subtitle="Balances are refreshed across sessions; only the available column may be requested.">
        <Async q={wallets} empty={!balances.length} emptyTitle="No wallet balances" emptyBody="The wallet balance appears after merchant onboarding.">
          <div className="kv">{balances.map((wallet) => <div key={wallet.currency}><span>{wallet.currency} available</span><strong>{money(wallet.availableBalance, wallet.currency)}</strong><span>Reserved</span><strong>{money(wallet.reservedBalance, wallet.currency)}</strong></div>)}</div>
        </Async>
        <div className="form-stack" style={{ marginTop: 14 }}><Note tone="warn">A pending or uncertain payout remains held. Rejected or confirmed failed requests release the reservation; completed payouts post once.</Note></div>
      </Card>
    </div>
    <Card title="Your payout requests" subtitle="Sensitive account numbers are never shown in request history.">
      <Async q={requests} empty={!items.length} emptyTitle="No payout requests" emptyBody="A request will appear here after funds have been successfully reserved.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Request</th><th>Recipient</th><th>Destination</th><th>Currency</th><th className="num">Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td className="mono">{item.reference}</td><td>{item.accountName}<span className="sub">{nice(item.method)}</span></td><td>{item.maskedAccount}</td><td>{item.currency}</td><td className="num">{money(item.amount, item.currency)}<span className="sub">Fee {money(item.fee, item.currency)}</span></td><td><Pill value={item.status} /></td><td>{fmtDate(item.createdAt)}</td></tr>)}
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
  const invalidate = useInvalidateAll();
  const [selected, setSelected] = useState<{ id: number; reference: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const items = q.data?.items ?? [];
  async function perform(action: 'approve' | 'reconcile', id: number) {
    setError(null);
    setWorking(id);
    try {
      if (action === 'approve') await approvePayoutRequest(id);
      else await reconcilePayoutRequest(id);
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
  return <>
    <Heading eyebrow="PLATFORM ADMIN / PAYOUTS" title="Payout approvals" subtitle="Every request is backed by a wallet reservation. Approval submits once; uncertain provider outcomes stay held and must be reconciled." />
    <Err error={error} />
    <Async q={q} empty={!items.length} emptyTitle="No merchant payout requests" emptyBody="Merchant-initiated requests appear here after wallet funds are reserved.">
      <Card title="Review queue" subtitle="Raw destination account data is not exposed in the admin list.">
        <div className="table-wrap"><table className="dt"><thead><tr><th>Request</th><th>Merchant</th><th>Recipient</th><th>Destination</th><th className="num">Amount + fee</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}>
            <td className="mono">{item.reference}<span className="sub">#{item.id}</span></td><td>#{item.merchantId}</td>
            <td>{item.accountName}<span className="sub">{nice(item.method)}</span></td><td>{item.maskedAccount}</td>
            <td className="num">{money(item.amount + item.fee, item.currency)}<span className="sub">{money(item.amount, item.currency)} recipient · {money(item.fee, item.currency)} fee</span></td>
            <td><Pill value={item.status} /></td><td>{fmtDate(item.createdAt)}</td>
            <td><div className="row-actions">
              {item.status === 'requested' && <><Btn small disabled={working !== null} onClick={() => setSelected({ id: item.id, reference: item.reference })} testId={`button-approve-payout-${item.id}`}><CheckCircle2 size={13} />Approve & submit</Btn><Btn small variant="danger" disabled={working !== null} onClick={() => { setRejecting(item.id); setRejectReason(''); }}>Reject</Btn></>}
              {['approved', 'processing', 'uncertain'].includes(item.status) && <Btn small variant="secondary" disabled={working !== null} onClick={() => void perform('reconcile', item.id)}><RefreshCw size={13} className={working === item.id ? 'spin' : ''} />Check provider</Btn>}
              {working === item.id && <LoaderCircle size={14} className="spin" />}
            </div></td>
          </tr>)}
        </tbody></table></div>
      </Card>
    </Async>
    {selected && <Modal title="Submit approved payout" description={`Approving ${selected.reference} sends one payout instruction through the configured Payzaapi provider. Unknown outcomes retain the wallet hold and cannot be retried automatically.`} onClose={() => setSelected(null)}>
      <div className="form-stack"><Note tone="warn">The provider destination is decrypted only server-side for this one-time submission. A local idempotency key is sent; uncertain requests are not re-submitted.</Note><Err error={error} /><div className="row-actions"><Btn variant="secondary" onClick={() => setSelected(null)}>Cancel</Btn><Btn disabled={working !== null} onClick={() => { const id = selected.id; setSelected(null); void perform('approve', id); }} testId="button-confirm-payout-approval"><ArrowUpRight size={14} />Approve and submit once</Btn></div></div>
    </Modal>}
    {rejecting !== null && <Modal title="Reject payout request" description="Rejecting releases the held funds to the merchant available balance." onClose={() => { setRejecting(null); setRejectReason(''); }}>
      <div className="form-stack"><Field label="Reason"><textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={400} required data-testid="input-payout-rejection-reason" /></Field><Err error={error} /><div className="row-actions"><Btn variant="secondary" onClick={() => setRejecting(null)}>Cancel</Btn><Btn variant="danger" disabled={!rejectReason.trim() || working !== null} onClick={() => void reject()}>Reject and release</Btn></div></div>
    </Modal>}
  </>;
}