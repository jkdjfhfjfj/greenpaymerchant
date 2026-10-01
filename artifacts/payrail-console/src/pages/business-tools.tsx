import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import type { Statement } from '@workspace/api-client-react';
import {
  CreateMerchantInvoiceMutationVariables,
  getGetMerchantCaseQueryKey, getGetMerchantInvoiceQueryKey,
  getListAdminCasesQueryKey, getListInvoiceRemindersQueryKey, getListMerchantCasesQueryKey,
  getListMerchantInvoicesQueryKey,
  useAddMerchantCaseMessage, useCreateInvoicePaymentLink, useCreateInvoiceReminder,
  useCreateMerchantCase, useCreateMerchantInvoice, useGetMerchantCase, useGetMerchantInvoice,
  useGetMerchantStatement, useGetPublicReceipt, useListAdminCases, useListInvoiceReminders,
  useListMerchantCases, useListMerchantInvoices, useReviewAdminCase, useSendMerchantInvoice,
  useUpdateMerchantInvoice, useVoidMerchantInvoice,
} from '@workspace/api-client-react';
import './business-tools.css';

type InvoiceLineInput = { description: string; quantity: number; unitAmount: number };
type InvoiceDraft = {
  customerName: string;
  customerEmail: string;
  currency: string;
  dueDate: string;
  lines: InvoiceLineInput[];
  note?: string;
};

function message(error: unknown) {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The request could not be completed. Try again.';
}

function amount(value: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}

function date(value: string | Date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function BusinessHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function Status({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}><i />{value.replaceAll('_', ' ')}</span>;
}

function ErrorBox({ value }: { value: string }) {
  return value ? <div className="form-error" role="alert">{value}</div> : null;
}

function InvoiceEditor({
  initial,
  busy,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<InvoiceDraft>;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: InvoiceDraft) => void;
}) {
  const [customerName, setCustomerName] = useState(initial?.customerName ?? '');
  const [customerEmail, setCustomerEmail] = useState(initial?.customerEmail ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  const [note, setNote] = useState(initial?.note ?? '');
  const [lines, setLines] = useState<InvoiceLineInput[]>(initial?.lines?.map(({ description, quantity, unitAmount }) => ({ description, quantity, unitAmount })) ?? [{ description: '', quantity: 1, unitAmount: 0 }]);
  function updateLine(index: number, field: keyof InvoiceLineInput, value: string) {
    setLines((previous) => previous.map((line, current) => current === index
      ? { ...line, [field]: field === 'description' ? value : Number(value) }
      : line));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      customerName, customerEmail, currency: currency.toUpperCase(), dueDate,
      lines, ...(note.trim() ? { note: note.trim() } : {}),
    });
  }
  return <form className="form-stack" onSubmit={submit}>
    <div className="form-grid">
      <label className="field">Customer name<input required maxLength={150} value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
      <label className="field">Customer email<input type="email" required maxLength={254} value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} /></label>
      <label className="field">Currency<input required minLength={3} maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
      <label className="field">Due date<input type="date" required value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
    </div>
    <div className="business-line-editor"><div className="business-line-head"><strong>Line items</strong><button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((items) => [...items, { description: '', quantity: 1, unitAmount: 0 }])}>Add line</button></div>
      {lines.map((line, index) => <div className="business-line-row" key={index}>
        <label className="field">Description<input required maxLength={300} value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} /></label>
        <label className="field">Qty<input required type="number" min="0.001" max="100000" step="any" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} /></label>
        <label className="field">Unit amount<input required type="number" min="0" max="100000000" step="0.01" value={line.unitAmount} onChange={(event) => updateLine(index, 'unitAmount', event.target.value)} /></label>
        {lines.length > 1 && <button type="button" className="btn btn-quiet btn-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((items) => items.filter((_, current) => current !== index))}>Remove</button>}
      </div>)}
    </div>
    <label className="field">Invoice note <small>Optional · shown to the merchant team</small><textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
  </form>;
}

export function InvoicePage() {
  const query = useListMerchantInvoices();
  const create = useCreateMerchantInvoice();
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const invoices = query.data?.items ?? [];
  function submit(data: InvoiceDraft) {
    setError('');
    create.mutate({ data: data as CreateMerchantInvoiceMutationVariables['data'] }, {
      onSuccess: async (invoice) => {
        await client.invalidateQueries({ queryKey: getListMerchantInvoicesQueryKey() });
        setOpen(false);
        navigate(`/invoices/${invoice.id}`);
      },
      onError: (err) => setError(message(err)),
    });
  }
  return <section className="business-page">
    <BusinessHeading eyebrow="MERCHANT / BUSINESS TOOLS" title="Invoices" subtitle="Create itemized invoices, issue payment links and track confirmed receipts." action={<button className="btn btn-primary" onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'New invoice'}</button>} />
    {open && <section className="panel business-editor"><div className="panel-head"><div><h2>Create an invoice</h2><p>Totals are calculated from your line items. Email is not sent from this workspace.</p></div></div><InvoiceEditor busy={create.isPending} submitLabel="Save draft" onSubmit={submit} /><ErrorBox value={error} /></section>}
    <section className="panel business-table-panel"><div className="panel-head"><div><h2>Invoice register</h2><p>Payment progress reflects confirmed transaction and refund records.</p></div></div>
      {query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div>
        : query.isError ? <div className="business-empty"><ErrorBox value={message(query.error)} /><button className="btn btn-secondary" onClick={() => { void query.refetch(); }}>Retry</button></div>
          : invoices.length === 0 ? <div className="empty-state"><strong>No invoices yet</strong><span>Create a draft invoice to begin.</span></div>
            : <div className="table-wrap"><table className="dt"><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th><th /></tr></thead><tbody>
              {invoices.map((invoice) => <tr key={invoice.id}><td><Link className="text-link" href={`/invoices/${invoice.id}`}>{invoice.reference}</Link><small className="sub">Created {date(invoice.createdAt)}</small></td><td>{invoice.customerName}<small className="sub">{invoice.customerEmail}</small></td><td>{date(invoice.dueDate)}</td><td>{amount(invoice.total, invoice.currency)}</td><td>{amount(invoice.paidAmount, invoice.currency)}</td><td><Status value={invoice.status} /></td><td><Link className="btn btn-secondary btn-sm" href={`/invoices/${invoice.id}`}>Open</Link></td></tr>)}
            </tbody></table></div>}
    </section>
  </section>;
}

export function InvoiceDetailPage() {
  const match = window.location.pathname.match(/\/invoices\/(\d+)(?:\/|$)/);
  const id = match ? Number(match[1]) : 0;
  const invoiceQuery = useGetMerchantInvoice(id);
  const remindersQuery = useListInvoiceReminders(id);
  const update = useUpdateMerchantInvoice();
  const issue = useSendMerchantInvoice();
  const voidInvoice = useVoidMerchantInvoice();
  const makeLink = useCreateInvoicePaymentLink();
  const remind = useCreateInvoiceReminder();
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invoice = invoiceQuery.data;
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: getGetMerchantInvoiceQueryKey(id) }),
      client.invalidateQueries({ queryKey: getListMerchantInvoicesQueryKey() }),
      client.invalidateQueries({ queryKey: getListInvoiceRemindersQueryKey(id) }),
    ]);
  };
  const busy = update.isPending || issue.isPending || voidInvoice.isPending || makeLink.isPending || remind.isPending;
  function run(action: () => void) { setError(''); setNotice(''); action(); }
  if (!id) return <section className="business-page"><ErrorBox value="Invoice identifier is invalid." /></section>;
  if (invoiceQuery.isLoading) return <section className="business-page"><div className="loading-state"><div className="skeleton-line wide" /></div></section>;
  if (invoiceQuery.isError || !invoice) return <section className="business-page"><BusinessHeading eyebrow="MERCHANT / INVOICE" title="Invoice unavailable" subtitle="This invoice could not be loaded." /><ErrorBox value={message(invoiceQuery.error)} /></section>;
  const canEdit = invoice.status === 'draft' && !invoice.paymentUrl;
  return <section className="business-page">
    <BusinessHeading eyebrow="MERCHANT / INVOICE" title={invoice.reference} subtitle="Review invoice terms and verified payment progress." action={<Link className="btn btn-secondary" href="/invoices">Back to invoices</Link>} />
    {notice && <div className="notice">{notice}</div>}<ErrorBox value={error} />
    {canEdit && <section className="panel business-editor"><div className="panel-head"><div><h2>Edit draft</h2><p>Saved totals are recalculated on the server.</p></div></div>
      <InvoiceEditor key={invoice.id} initial={{
        customerName: invoice.customerName, customerEmail: invoice.customerEmail,
        currency: invoice.currency, dueDate: new Date(invoice.dueDate).toISOString().slice(0, 10),
        lines: invoice.lines, note: invoice.note ?? '',
      }} busy={update.isPending} submitLabel="Save changes" onSubmit={(draft) => run(() => update.mutate({ id, data: draft }, { onSuccess: async () => { setNotice('Draft invoice saved.'); await refresh(); }, onError: (err) => setError(message(err)) }))} />
    </section>}
    <div className="business-metrics">
      <article><span>Invoice total</span><strong>{amount(invoice.total, invoice.currency)}</strong></article>
      <article><span>Confirmed payment</span><strong>{amount(invoice.paidAmount, invoice.currency)}</strong></article>
      <article><span>Due date</span><strong>{date(invoice.dueDate)}</strong></article>
      <article><span>Status</span><Status value={invoice.status} /></article>
    </div>
    <section className="panel"><div className="panel-head"><div><h2>Invoice details</h2><p>{invoice.customerName} · {invoice.customerEmail}</p></div></div>
      {invoice.note && <p className="business-note">{invoice.note}</p>}
      <div className="table-wrap"><table className="dt"><thead><tr><th>Description</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Line total</th></tr></thead><tbody>{invoice.lines.map((line, index) => <tr key={`${line.description}-${index}`}><td>{line.description}</td><td className="num">{line.quantity}</td><td className="num">{amount(line.unitAmount, invoice.currency)}</td><td className="num">{amount(line.total, invoice.currency)}</td></tr>)}<tr><td colSpan={3}><strong>Total</strong></td><td className="num"><strong>{amount(invoice.total, invoice.currency)}</strong></td></tr></tbody></table></div>
    </section>
    {invoice.payments.length > 0 && <section className="panel"><div className="panel-head"><div><h2>Confirmed payments & receipts</h2><p>Each public receipt contains only safe payment facts, without customer contact or processing details.</p></div></div>
      <div className="table-wrap"><table className="dt"><thead><tr><th>Payment reference</th><th>Amount</th><th>Status</th><th>Paid</th><th /></tr></thead><tbody>
        {invoice.payments.map((payment) => <tr key={payment.reference}><td className="mono">{payment.reference}</td><td>{amount(payment.amount, invoice.currency)}</td><td><Status value={payment.status === 'success' ? 'confirmed' : payment.status} /></td><td>{date(payment.paidAt)}</td><td><a className="btn btn-secondary btn-sm" href={`/receipt/${encodeURIComponent(payment.reference)}`} target="_blank" rel="noreferrer">Open receipt</a></td></tr>)}
      </tbody></table></div>
    </section>}
    <section className="panel"><div className="panel-head"><div><h2>Invoice actions</h2><p>Payment links are created under the merchant's currency and collection safeguards. No provider payment is initiated here.</p></div></div>
      <div className="business-actions">
        {invoice.status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => issue.mutate({ id }, { onSuccess: async () => { setNotice('Invoice issued. Email delivery is not configured; no email was sent.'); await refresh(); }, onError: (err) => setError(message(err)) }))}>Issue invoice</button>}
        {!invoice.paymentUrl && ['sent', 'partially_paid'].includes(invoice.status) && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => makeLink.mutate({ id }, { onSuccess: async () => { setNotice('Payment link created.'); await refresh(); }, onError: (err) => setError(message(err)) }))}>Create payment link</button>}
        {invoice.paymentUrl && <a className="btn btn-secondary" href={invoice.paymentUrl} target="_blank" rel="noreferrer">Open payment page</a>}
        {!['void', 'paid', 'partially_paid'].includes(invoice.status) && <button className="btn btn-danger" disabled={busy} onClick={() => {
          if (!window.confirm('Void this invoice? Any active invoice link will be archived.')) return;
          run(() => voidInvoice.mutate({ id }, { onSuccess: async () => { setNotice('Invoice voided.'); await refresh(); }, onError: (err) => setError(message(err)) }));
        }}>Void invoice</button>}
        {['sent', 'partially_paid'].includes(invoice.status) && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => remind.mutate({ id, data: {} }, { onSuccess: async () => { setNotice('Reminder request persisted. Email delivery is not configured; no email was sent.'); await refresh(); }, onError: (err) => setError(message(err)) }))}>Record reminder request</button>}
      </div>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Reminder history</h2><p>Delivery is explicitly unconfigured until an email provider is set up.</p></div></div>
      {remindersQuery.isLoading ? <div className="loading-state"><div className="skeleton-line" /></div> : remindersQuery.isError ? <ErrorBox value={message(remindersQuery.error)} /> : (remindersQuery.data?.items ?? []).length ? <div className="business-thread">{remindersQuery.data?.items.map((entry) => <article key={entry.id}><div><Status value={entry.deliveryStatus} /><time>{date(entry.createdAt)}</time></div><p>{entry.message}</p>{entry.attemptedAt && <small>Attempted {date(entry.attemptedAt)}</small>}</article>)}</div> : <div className="empty-state"><strong>No reminder requests</strong><span>Nothing has been queued. No email has been sent.</span></div>}
    </section>
  </section>;
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function StatementsPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const query = useGetMerchantStatement(month);
  const statement = query.data as Statement | undefined;
  const rows = useMemo(() => {
    if (!statement) return [];
    return [
      ['type', 'reference', 'related_reference', 'currency', 'amount', 'fee', 'status', 'recorded_at'],
      ...statement.transactions.map((row) => ['confirmed_payment', row.reference, '', row.currency, row.amount, row.fee, 'confirmed', new Date(row.paidAt).toISOString()]),
      ...statement.refunds.map((row) => ['refund_record', row.reference, row.originalReference, row.currency, row.amount, '', row.status, new Date(row.createdAt).toISOString()]),
      ...statement.payouts.map((row) => ['payout_record', row.reference, '', row.currency, row.amount, row.fee, row.status, new Date(row.createdAt).toISOString()]),
    ];
  }, [statement]);
  function download() {
    const contents = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `greenpay-statement-${month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <section className="business-page">
    <BusinessHeading eyebrow="MERCHANT / REPORTING" title="Financial statements" subtitle="Download ledger facts from confirmed payments, recorded refunds, fees and payout records. This is not a wallet balance." action={<label className="business-month">Statement month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>} />
    {query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div> : query.isError ? <div className="panel"><ErrorBox value={message(query.error)} /><button className="btn btn-secondary" onClick={() => { void query.refetch(); }}>Retry</button></div> : statement && <>
      <div className="business-metrics">
        {statement.currencySummaries.map((item) => <article key={item.currency}><span>{item.currency} · confirmed gross</span><strong>{amount(item.grossConfirmed, item.currency)}</strong><small>Fees {amount(item.fees, item.currency)} · confirmed refunds {amount(item.refundsTotal, item.currency)} · completed payouts {amount(item.payoutsTotal, item.currency)}</small></article>)}
        {!statement.currencySummaries.length && <article><span>Ledger activity</span><strong>No facts for this month</strong></article>}
      </div>
      <section className="panel"><div className="panel-head"><div><h2>Statement facts · {statement.month}</h2><p>CSV contains source references and recorded statuses for reconciliation.</p></div><button className="btn btn-primary" onClick={download} disabled={!rows.length}>Download CSV</button></div>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Type</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Status</th><th>Recorded</th></tr></thead><tbody>
          {statement.transactions.map((row) => <tr key={`tx-${row.reference}`}><td className="mono">{row.reference}</td><td>Confirmed payment</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>{amount(row.fee, row.currency)}</td><td><Status value="confirmed" /></td><td>{date(row.paidAt)}</td></tr>)}
          {statement.refunds.map((row) => <tr key={`rf-${row.reference}`}><td className="mono">{row.reference}<small className="sub">For {row.originalReference}</small></td><td>Refund record</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>—</td><td><Status value={row.status} /></td><td>{date(row.createdAt)}</td></tr>)}
          {statement.payouts.map((row) => <tr key={`po-${row.reference}`}><td className="mono">{row.reference}</td><td>Payout record</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>{amount(row.fee, row.currency)}</td><td><Status value={row.status} /></td><td>{date(row.createdAt)}</td></tr>)}
          {!statement.transactions.length && !statement.refunds.length && !statement.payouts.length && <tr><td colSpan={7}><div className="business-empty">No transaction, refund or payout facts were recorded in this month.</div></td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel"><div className="panel-head"><div><h2>Forecast · historical estimate only</h2><p>Not a promise, balance, settlement commitment or available funds.</p></div></div>
        {statement.currencySummaries.length ? <div className="business-forecast">{statement.currencySummaries.map((item) => <article key={item.currency}><span>{item.currency} · estimated monthly confirmed gross average</span><strong>{item.forecast.amount === null ? 'Not enough historical facts' : amount(item.forecast.amount, item.currency)}</strong><small>Previous three calendar months · {item.forecast.basisMonths} month(s) with confirmed payment activity</small></article>)}</div> : <p className="business-muted">No historical data to forecast.</p>}
      </section>
    </>}
  </section>;
}

export function CasesPage() {
  const query = useListMerchantCases();
  const create = useCreateMerchantCase();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState<'refund' | 'dispute'>('refund');
  const [reference, setReference] = useState('');
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState('');
  const client = useQueryClient();
  const items = query.data?.items ?? [];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    create.mutate({ data: { kind, transactionReference: reference.trim(), message: text.trim(), ...(evidence.trim() ? { evidenceUrl: evidence.trim() } : {}) } }, {
      onSuccess: async (item) => {
        setText(''); setEvidence(''); setReference(''); setSelectedId(item.id);
        setNotice('Case created. This request does not issue a refund or move money.');
        await client.invalidateQueries({ queryKey: getListMerchantCasesQueryKey() });
      },
      onError: (err) => setError(message(err)),
    });
  }
  return <section className="business-page">
    <BusinessHeading eyebrow="MERCHANT / SUPPORT" title="Refund & dispute cases" subtitle="Submit a request with context and evidence links. Case handling never automatically initiates a refund." />
    {notice && <div className="notice">{notice}</div>}<ErrorBox value={error} />
    <section className="panel"><div className="panel-head"><div><h2>Open a case</h2><p>Transaction ownership is verified before the case is saved. Use public evidence links; file bytes are not uploaded.</p></div></div>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid"><label className="field">Case type<select value={kind} onChange={(event) => setKind(event.target.value as 'refund' | 'dispute')}><option value="refund">Refund request</option><option value="dispute">Dispute</option></select></label><label className="field">Transaction reference<input required maxLength={100} value={reference} onChange={(event) => setReference(event.target.value)} /></label></div>
        <label className="field">Supporting text<textarea required minLength={1} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label className="field">Evidence URL <small>Optional HTTP(S) URL; no files or base64 are stored</small><input type="url" maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={create.isPending}>{create.isPending ? 'Submitting…' : 'Submit case'}</button>
      </form>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Your cases</h2><p>Status and money movement are tracked separately.</p></div></div>
      {query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div> : query.isError ? <ErrorBox value={message(query.error)} /> : items.length ? <div className="business-case-list">{items.map((item) => <CaseConversation key={item.id} id={item.id} selected={selectedId === item.id} onSelect={() => setSelectedId((current) => current === item.id ? null : item.id)} mode="merchant" onUpdated={async () => { await client.invalidateQueries({ queryKey: getListMerchantCasesQueryKey() }); }} />)}</div> : <div className="empty-state"><strong>No cases submitted</strong><span>Refund and dispute requests appear here after submission.</span></div>}
    </section>
  </section>;
}

function CaseConversation({ id, selected, onSelect, mode, onUpdated }: { id: number; selected: boolean; onSelect: () => void; mode: 'merchant' | 'admin'; onUpdated: () => Promise<void> }) {
  const query = useGetMerchantCase(id, { query: { queryKey: getGetMerchantCaseQueryKey(id), enabled: mode === 'merchant' && selected } });
  const append = useAddMerchantCaseMessage();
  const review = useReviewAdminCase();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState('');
  const [status, setStatus] = useState<'in_review' | 'resolved' | 'declined'>('in_review');
  const [movement, setMovement] = useState<'none' | 'requested' | 'recorded' | 'confirmed'>('requested');
  const [error, setError] = useState('');
  const item = query.data;
  const adminQuery = useListAdminCases({ query: { queryKey: getListAdminCasesQueryKey(), enabled: mode === 'admin' } });
  const adminItem = mode === 'admin' ? adminQuery.data?.items.find((row) => row.id === id) : undefined;
  const caseItem = item ?? adminItem;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const evidenceUrl = evidence.trim() || undefined;
    if (mode === 'merchant') {
      append.mutate({ id, data: { message: text.trim(), ...(evidenceUrl ? { evidenceUrl } : {}) } }, {
        onSuccess: async () => { setText(''); setEvidence(''); await Promise.all([query.refetch(), onUpdated()]); },
        onError: (err) => setError(message(err)),
      });
      return;
    }
    review.mutate({ id, data: { status, financialMovement: movement, message: text.trim(), ...(evidenceUrl ? { evidenceUrl } : {}) } }, {
      onSuccess: async () => {
        setText(''); setEvidence('');
        await Promise.all([
          client.invalidateQueries({ queryKey: getListAdminCasesQueryKey() }),
          client.invalidateQueries({ queryKey: getListMerchantCasesQueryKey() }),
          onUpdated(),
        ]);
      },
      onError: (err) => setError(message(err)),
    });
  }
  if (!caseItem) return null;
  return <article className="business-case-card">
    <button className="business-case-summary" onClick={onSelect} aria-expanded={selected}>
      <span><strong>#{caseItem.id} · {caseItem.kind} · {caseItem.transactionReference}</strong><small>Updated {date(caseItem.updatedAt)}</small></span>
      <span className="business-case-status"><Status value={caseItem.status} /><Status value={`movement_${caseItem.financialMovement}`} /></span>
    </button>
    {selected && <div className="business-case-detail">
      <div className="business-movement-note"><strong>Money movement: {caseItem.financialMovement}</strong><span>Requested or recorded cases do not mean customer funds moved. Confirmed requires an existing confirmed refund record.</span></div>
      {mode === 'admin' && <a className="btn btn-secondary btn-sm business-review-link" href="/transactions">Open verified transaction/refund workflow <span className="mono">{caseItem.transactionReference}</span></a>}
      {mode === 'merchant' && query.isLoading ? <div className="loading-state"><div className="skeleton-line" /></div> : <div className="business-thread">{(mode === 'merchant' ? item?.messages : adminItem?.messages)?.map((entry) => <div key={entry.id} className={`business-message business-message-${entry.authorRole}`}><div><strong>{entry.authorRole === 'admin' ? 'Greenpay support' : 'Merchant'}</strong><time>{date(entry.createdAt)}</time></div><p>{entry.message}</p>{entry.evidenceUrl && <a href={entry.evidenceUrl} target="_blank" rel="noreferrer">Open evidence link</a>}</div>)}</div>}
      <form className="form-stack business-reply" onSubmit={submit}>
        {mode === 'admin' && <div className="form-grid"><label className="field">Review status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="in_review">In review</option><option value="resolved">Resolved</option><option value="declined">Declined</option></select></label><label className="field">Financial movement<select value={movement} onChange={(event) => setMovement(event.target.value as typeof movement)}><option value="requested">Requested — no funds confirmed</option><option value="recorded">Recorded — no funds confirmed</option><option value="confirmed">Confirmed — requires refund evidence</option><option value="none">None</option></select></label></div>}
        <label className="field">{mode === 'admin' ? 'Support response' : 'Add supporting information'}<textarea required maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label className="field">Evidence URL <input type="url" maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        <ErrorBox value={error} />
        <button className="btn btn-secondary" disabled={append.isPending || review.isPending}>{mode === 'admin' ? 'Save review' : 'Add to case thread'}</button>
      </form>
    </div>}
  </article>;
}

export function AdminCasesPage() {
  const query = useListAdminCases();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const items = query.data?.items ?? [];
  async function refresh() {
    await client.invalidateQueries({ queryKey: getListAdminCasesQueryKey() });
  }
  return <section className="business-page">
    <BusinessHeading eyebrow="ADMIN / CASE REVIEW" title="Merchant cases" subtitle="Review refund and dispute requests. Recording a case never executes a provider refund." />
    <section className="panel"><div className="panel-head"><div><h2>Cases for review</h2><p>Customer movement is separately labeled as requested, recorded or confirmed.</p></div></div>
      {query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div> : query.isError ? <><ErrorBox value={message(query.error)} /><button className="btn btn-secondary" onClick={() => { void query.refetch(); }}>Retry</button></> : items.length ? <div className="business-case-list">{items.map((item) => <CaseConversation key={item.id} id={item.id} selected={selectedId === item.id} onSelect={() => setSelectedId((current) => current === item.id ? null : item.id)} mode="admin" onUpdated={refresh} />)}</div> : <div className="empty-state"><strong>No review cases</strong><span>New merchant requests will appear here.</span></div>}
    </section>
  </section>;
}

export function PublicReceiptPage() {
  const reference = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
  const query = useGetPublicReceipt(reference);
  const receipt = query.data;
  if (query.isLoading) return <main className="business-receipt"><div className="loading-state"><div className="skeleton-line wide" /></div></main>;
  if (query.isError || !receipt) return <main className="business-receipt"><div className="business-receipt-card"><strong>Receipt unavailable</strong><p>{message(query.error)}</p></div></main>;
  return <main className="business-receipt">
    <article className="business-receipt-card">
      <div className="business-receipt-brand"><span className="business-receipt-mark">G</span><span>greenpay</span></div>
      <span className="eyebrow">PAYMENT RECEIPT</span><h1>{receipt.businessName}</h1>
      <div className="business-receipt-status"><Status value={receipt.status} /><strong>{receipt.status === 'refunded' ? 'Refund recorded' : 'Payment confirmed'}</strong></div>
      <div className="business-receipt-amount">{amount(receipt.amount, receipt.currency)}</div>
      <dl><div><dt>Payment reference</dt><dd className="mono">{receipt.reference}</dd></div><div><dt>Confirmed on</dt><dd>{new Date(receipt.paidAt).toLocaleString()}</dd></div></dl>
      <p className="business-receipt-safe">This receipt displays payment facts only. Customer contact details and processing information are not included.</p>
      <div className="business-receipt-actions"><button className="btn btn-primary" onClick={() => window.print()}>Print / download PDF</button><a className="btn btn-secondary" href="/">Return to Greenpay</a></div>
    </article>
  </main>;
}