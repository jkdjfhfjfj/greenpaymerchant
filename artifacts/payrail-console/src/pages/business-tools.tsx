import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import type { Statement } from '@workspace/api-client-react';
import {
  CreateMerchantInvoiceMutationVariables,
  getGetMerchantCaseQueryKey, getGetMerchantInvoiceQueryKey, getGetMerchantStatementQueryKey,
  getListAdminCasesQueryKey, getListInvoiceRemindersQueryKey, getListMerchantCasesQueryKey,
  getListMerchantInvoicesQueryKey,
  useCreateInvoicePaymentLink, useCreateInvoiceReminder,
  useCreateMerchantCase, useCreateMerchantInvoice, useGetMerchantCase, useGetMerchantInvoice,
  useGetMerchantStatement, useGetPublicReceipt, useListAdminCases, useListInvoiceReminders,
  useListMerchantCases, useListMerchantInvoices, useReviewAdminCase, useSendMerchantInvoice,
  useUpdateMerchantInvoice, useVoidMerchantInvoice,
} from '@workspace/api-client-react';
import { useMerchantActionCapability } from '../hooks/use-merchant-action-controls';
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

type BusinessStatement = Omit<Statement, 'currencySummaries'> & {
  settlements?: Array<{ reference: string; amount: number; currency: string; status: string; createdAt: string | Date }>;
  walletPayoutRequests?: Array<{
    reference: string; amount: number; fee: number; currency: string; status: string;
    createdAt: string | Date; updatedAt: string | Date; completedAt: string | Date | null;
  }>;
  currencySummaries: Array<Statement['currencySummaries'][number] & { settlementsTotal?: number }>;
};

type CaseAttachment = { id: number; name: string; contentType: string; size: number; createdAt: string | Date };
type CaseThreadMessage = {
  id: string; authorRole: 'merchant' | 'admin'; message: string; evidenceUrl: string | null;
  createdAt: string | Date; attachments?: CaseAttachment[];
};
type CaseRecordSummary = {
  id: number; kind: 'refund' | 'dispute'; transactionReference: string; status: string;
  financialMovement: string; updatedAt: string | Date; messages?: CaseThreadMessage[];
  refundEvidence?: Array<{
    reference: string; amount: number; currency: string; status: string;
    providerReference: string; evidenceReference: string; createdAt: string | Date;
  }>;
};

async function postBusinessRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `The request failed (${response.status}).`);
  }
  return payload as T;
}

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
  canSubmit = true,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<InvoiceDraft>;
  busy: boolean;
  canSubmit?: boolean;
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
    <button className="btn btn-primary" type="submit" disabled={busy || !canSubmit}>{busy ? 'Saving…' : !canSubmit ? 'Permission unavailable' : submitLabel}</button>
  </form>;
}

export function InvoicePage() {
  const query = useListMerchantInvoices();
  const create = useCreateMerchantInvoice();
  const actions = useMerchantActionCapability();
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
    <BusinessHeading eyebrow="MERCHANT / BUSINESS TOOLS" title="Invoices" subtitle="Create itemized invoices, issue balance-specific payment links and track confirmed receipts." action={<button className="btn btn-primary" disabled={!open && !actions.can('invoices')} title={!open ? actions.disabledReason('invoices') ?? undefined : undefined} onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'New invoice'}</button>} />
    {actions.isError && <div className="panel"><ErrorBox value={message(actions.error)} /><button className="btn btn-secondary" onClick={() => { void actions.refetch(); }}>Retry permissions</button></div>}
    {!actions.can('invoices') && !actions.isError && <p className="business-muted" role="status">{actions.disabledReason('invoices')}</p>}
    {open && <section className="panel business-editor"><div className="panel-head"><div><h2>Create an invoice</h2><p>Totals are calculated from your line items. Saving creates a draft and does not collect payment.</p></div></div><InvoiceEditor busy={create.isPending} canSubmit={actions.can('invoices')} submitLabel="Save draft" onSubmit={submit} /><ErrorBox value={error} /></section>}
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
  const actions = useMerchantActionCapability();
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scheduledReminder, setScheduledReminder] = useState('');
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
  const outstandingAmount = invoice.outstandingAmount;
  const paymentLinkAmount = 'paymentLinkAmount' in invoice ? invoice.paymentLinkAmount as number | null : null;
  async function copyPaymentLink() {
    const paymentUrl = invoice?.paymentUrl;
    if (!paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setNotice('Payment link copied. It is for the current outstanding invoice balance.');
      setError('');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the payment URL below.');
    }
  }
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
      <article><span>Outstanding balance</span><strong>{amount(outstandingAmount, invoice.currency)}</strong></article>
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
    <section className="panel"><div className="panel-head"><div><h2>Invoice actions</h2><p>Payment links use the merchant's currency and collection safeguards. Customers complete payment from the link.</p></div></div>
      <div className="business-actions">
        {invoice.status === 'draft' && <button className="btn btn-primary" disabled={busy || !actions.can('invoices')} title={actions.disabledReason('invoices') ?? undefined} onClick={() => run(() => issue.mutate({ id }, { onSuccess: async () => { setNotice('Invoice issued. No payment has been collected. Create a balance-specific link to share.'); await refresh(); }, onError: (err) => setError(message(err)) }))}>Issue invoice</button>}
        {!invoice.paymentUrl && ['sent', 'partially_paid'].includes(invoice.status) && <button className="btn btn-secondary" disabled={busy || !actions.can('invoices') || !actions.can('createLinks')} title={actions.disabledReason('createLinks') ?? actions.disabledReason('invoices') ?? undefined} onClick={() => run(() => makeLink.mutate({ id }, { onSuccess: async () => { setNotice('Current outstanding-balance payment link created.'); await refresh(); }, onError: (err) => setError(message(err)) }))}>Create payment link</button>}
        {invoice.paymentUrl && <><a className="btn btn-secondary" href={invoice.paymentUrl} target="_blank" rel="noreferrer">Open payment page</a><button className="btn btn-secondary" onClick={() => { void copyPaymentLink(); }}>Copy payment link</button><label className="field business-payment-url">Customer payment URL<input readOnly value={invoice.paymentUrl} onFocus={(event) => event.currentTarget.select()} /></label><small className="business-muted">Link amount: {paymentLinkAmount === null ? 'not available' : amount(paymentLinkAmount, invoice.currency)} · outstanding now: {amount(outstandingAmount, invoice.currency)}</small></>}
        {!['void', 'paid', 'partially_paid'].includes(invoice.status) && <button className="btn btn-danger" disabled={busy || !actions.can('invoices')} title={actions.disabledReason('invoices') ?? undefined} onClick={() => {
          if (!window.confirm('Void this invoice? Any active invoice link will be archived.')) return;
          run(() => voidInvoice.mutate({ id }, { onSuccess: async () => { setNotice('Invoice voided.'); await refresh(); }, onError: (err) => setError(message(err)) }));
        }}>Void invoice</button>}
        {['sent', 'partially_paid'].includes(invoice.status) && <div className="business-reminder-form"><label className="field">Schedule reminder <small>Leave blank to queue it now. Scheduled reminders are held in the email queue until due.</small><input type="datetime-local" value={scheduledReminder} min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} max={new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 16)} onChange={(event) => setScheduledReminder(event.target.value)} /></label><button className="btn btn-secondary" disabled={busy || !actions.can('invoices') || !actions.can('reminders') || !invoice.paymentUrl} title={!invoice.paymentUrl ? 'Create a current balance-specific payment link first.' : actions.disabledReason('invoices') ?? actions.disabledReason('reminders') ?? undefined} onClick={() => {
          const scheduleAt = scheduledReminder ? new Date(scheduledReminder).toISOString() : undefined;
          run(() => remind.mutate({ id, data: (scheduleAt ? { scheduleAt } : {}) as never }, { onSuccess: async () => { setScheduledReminder(''); setNotice('Customer reminder queued for delivery. Any scheduled reminder is held until its selected time.'); await refresh(); }, onError: (err) => setError(message(err)) }));
        }}>{scheduledReminder ? 'Schedule reminder' : 'Queue reminder now'}</button></div>}
      </div>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Reminder history</h2><p>Delivery is queued through the transactional email worker. Scheduled messages recheck the invoice balance before sending.</p></div></div>
      {remindersQuery.isLoading ? <div className="loading-state"><div className="skeleton-line" /></div> : remindersQuery.isError ? <ErrorBox value={message(remindersQuery.error)} /> : (remindersQuery.data?.items ?? []).length ? <div className="business-thread">{remindersQuery.data?.items.map((entry) => <article key={entry.id}><div><Status value={entry.deliveryStatus} /><time>{date(entry.createdAt)}</time></div><p>{entry.message}</p>{entry.attemptedAt && <small>Attempted {date(entry.attemptedAt)}</small>}</article>)}</div> : <div className="empty-state"><strong>No reminder requests</strong><span>Nothing has been queued. No email has been sent.</span></div>}
    </section>
  </section>;
}

function csvCell(value: string | number | null | undefined) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function StatementsPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const validMonth = /^\d{4}-\d{2}$/.test(month);
  const query = useGetMerchantStatement(month, {
    query: { enabled: validMonth, queryKey: getGetMerchantStatementQueryKey(month) },
  });
  const statement = query.data as BusinessStatement | undefined;
  const rows = useMemo(() => {
    if (!statement) return [];
    return [
      ['type', 'reference', 'external_reference', 'related_reference', 'currency', 'amount', 'fee', 'status', 'created_at', 'cash_date', 'cash_date_basis', 'updated_at', 'completed_at'],
      ...statement.transactions.map((row) => ['confirmed_payment', row.reference, row.providerReference ?? '', '', row.currency, row.amount, row.fee, 'confirmed', '', new Date(row.paidAt).toISOString(), 'paid_at', '', '']),
      ...statement.refunds.map((row) => ['refund_record', row.reference, row.providerReference ?? '', row.originalReference, row.currency, row.amount, '', row.status, new Date(row.createdAt).toISOString(), new Date(row.cashDate).toISOString(), row.cashDateBasis, '', '']),
      ...statement.payouts.map((row) => ['payout_record', row.reference, row.providerReference ?? '', '', row.currency, row.amount, row.fee, row.status, new Date(row.createdAt).toISOString(), new Date(row.cashDate).toISOString(), row.cashDateBasis, '', '']),
      ...(statement.settlements ?? []).map((row) => ['wallet_settlement', row.reference, '', '', row.currency, row.amount, '', row.status, new Date(row.createdAt).toISOString(), new Date(row.createdAt).toISOString(), 'confirmed_at', '', '']),
      ...(statement.walletPayoutRequests ?? []).map((row) => [
        'wallet_payout_request', row.reference, '', '', row.currency, row.amount, row.fee, row.status,
        new Date(row.createdAt).toISOString(), row.completedAt ? new Date(row.completedAt).toISOString() : '',
        row.completedAt ? 'completed_at' : 'not_confirmed', new Date(row.updatedAt).toISOString(),
        row.completedAt ? new Date(row.completedAt).toISOString() : '',
      ]),
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
    <BusinessHeading eyebrow="MERCHANT / REPORTING" title="Financial statements" subtitle="Download confirmed cash facts with explicit cash-date basis. Wallet payout requests remain separate operational history; this is not a wallet balance." action={<label className="business-month">Statement month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>} />
    {!validMonth ? <div className="panel"><p className="business-muted">Choose a valid statement month to view cash facts and operational history.</p></div> : query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div> : query.isError ? <div className="panel"><ErrorBox value={message(query.error)} /><button className="btn btn-secondary" onClick={() => { void query.refetch(); }}>Retry</button></div> : statement && <>
      <div className="business-metrics">
        {statement.currencySummaries.map((item) => <article key={item.currency}><span>{item.currency} · confirmed gross</span><strong>{amount(item.grossConfirmed, item.currency)}</strong><small>Fees {amount(item.fees, item.currency)} · confirmed refunds {amount(item.refundsTotal, item.currency)} · confirmed settlements {amount(item.settlementsTotal ?? 0, item.currency)} · completed payouts {amount(item.payoutsTotal, item.currency)}</small></article>)}
        {!statement.currencySummaries.length && <article><span>Ledger activity</span><strong>No facts for this month</strong></article>}
      </div>
      <section className="panel"><div className="panel-head"><div><h2>Statement facts · {statement.month}</h2><p>CSV preserves creation timestamps and identifies the date used for cash attribution.</p></div><button className="btn btn-primary" onClick={download} disabled={!rows.length}>Download CSV</button></div>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Reference</th><th>Type</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Status</th><th>Cash date / basis</th></tr></thead><tbody>
          {statement.transactions.map((row) => <tr key={`tx-${row.reference}`}><td className="mono">{row.reference}{row.providerReference && <small className="sub">External reference {row.providerReference}</small>}</td><td>Confirmed payment</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>{amount(row.fee, row.currency)}</td><td><Status value="confirmed" /></td><td>{date(row.paidAt)}<small className="sub">Paid at</small></td></tr>)}
          {statement.refunds.map((row) => <tr key={`rf-${row.reference}`}><td className="mono">{row.reference}{row.providerReference && <small className="sub">External reference {row.providerReference}</small>}<small className="sub">For {row.originalReference}</small></td><td>Refund record</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>—</td><td><Status value={row.status} /></td><td>{date(row.cashDate)}<small className="sub">{row.cashDateBasis === 'legacy_created_at' ? 'Legacy creation date' : 'Confirmed at'}</small><small className="sub">Created {date(row.createdAt)}</small></td></tr>)}
          {statement.payouts.map((row) => <tr key={`po-${row.reference}`}><td className="mono">{row.reference}{row.providerReference && <small className="sub">External reference {row.providerReference}</small>}</td><td>Payout record</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>{amount(row.fee, row.currency)}</td><td><Status value={row.status} /></td><td>{date(row.cashDate)}<small className="sub">{row.cashDateBasis === 'legacy_created_at' ? 'Legacy creation date' : 'Confirmed at'}</small><small className="sub">Created {date(row.createdAt)}</small></td></tr>)}
          {(statement.settlements ?? []).map((row) => <tr key={`st-${row.reference}`}><td className="mono">{row.reference}</td><td>Confirmed wallet settlement</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>—</td><td><Status value={row.status} /></td><td>{date(row.createdAt)}<small className="sub">Confirmed at</small></td></tr>)}
          {(statement.walletPayoutRequests ?? []).map((row) => <tr key={`wpo-${row.reference}`}><td className="mono">{row.reference}<small className="sub">Request created {date(row.createdAt)} · updated {date(row.updatedAt)}</small></td><td>Wallet payout request</td><td>{row.currency}</td><td>{amount(row.amount, row.currency)}</td><td>{amount(row.fee, row.currency)}</td><td><Status value={row.status} /></td><td>{row.completedAt ? date(row.completedAt) : 'Not confirmed'}<small className="sub">{row.completedAt ? 'Operational completion timestamp' : 'Operational history only · no confirmed cash date'}</small></td></tr>)}
          {!statement.transactions.length && !statement.refunds.length && !statement.payouts.length && !(statement.settlements ?? []).length && !(statement.walletPayoutRequests ?? []).length && <tr><td colSpan={7}><div className="business-empty">No payment, refund, settlement or payout facts were recorded in this month.</div></td></tr>}
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
  const actions = useMerchantActionCapability();
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
    if (!actions.can(kind === 'refund' ? 'refundRequests' : 'disputeRequests')) {
      setError(actions.disabledReason(kind === 'refund' ? 'refundRequests' : 'disputeRequests') ?? 'This case action is unavailable.');
      return;
    }
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
    <BusinessHeading eyebrow="MERCHANT / SUPPORT" title="Refund & dispute cases" subtitle="Submit refund or dispute requests with private files and threaded updates. This page records your request; it does not issue a refund." />
    {notice && <div className="notice">{notice}</div>}<ErrorBox value={error} />
    {actions.isError && <div className="panel"><ErrorBox value={message(actions.error)} /><button className="btn btn-secondary" onClick={() => { void actions.refetch(); }}>Retry permissions</button></div>}
    <section className="panel"><div className="panel-head"><div><h2>Open a case</h2><p>Transaction ownership and confirmed payment status are checked before the case is saved. Add private files in the case thread after submission.</p></div></div>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid"><label className="field">Case type<select value={kind} onChange={(event) => setKind(event.target.value as 'refund' | 'dispute')}><option value="refund">Refund request</option><option value="dispute">Dispute</option></select></label><label className="field">Transaction reference<input required maxLength={100} value={reference} onChange={(event) => setReference(event.target.value)} /></label></div>
        <label className="field">Supporting text<textarea required minLength={1} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label className="field">Evidence URL <small>Optional HTTP(S) URL; no files or base64 are stored</small><input type="url" maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={create.isPending || !actions.can(kind === 'refund' ? 'refundRequests' : 'disputeRequests')} title={actions.disabledReason(kind === 'refund' ? 'refundRequests' : 'disputeRequests') ?? undefined}>{create.isPending ? 'Submitting…' : 'Submit case'}</button>
      </form>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Your cases</h2><p>Status and money movement are tracked separately.</p></div></div>
      {query.isLoading ? <div className="loading-state"><div className="skeleton-line wide" /></div> : query.isError ? <ErrorBox value={message(query.error)} /> : items.length ? <div className="business-case-list">{items.map((item) => {
        const action = item.kind === 'refund' ? 'refundRequests' : 'disputeRequests';
        const canReply = actions.can(action);
        return <CaseConversation key={item.id} id={item.id} fallback={item as unknown as CaseRecordSummary} selected={selectedId === item.id} onSelect={() => setSelectedId((current) => current === item.id ? null : item.id)} mode="merchant" canReply={canReply} replyUnavailableReason={!canReply ? actions.disabledReason(action) ?? undefined : undefined} onUpdated={async () => { await client.invalidateQueries({ queryKey: getListMerchantCasesQueryKey() }); }} />;
      })}</div> : <div className="empty-state"><strong>No cases submitted</strong><span>Refund and dispute requests appear here after submission.</span></div>}
    </section>
  </section>;
}

function CaseConversation({ id, selected, onSelect, mode, onUpdated, canReply = false, fallback, replyUnavailableReason }: {
  id: number; selected: boolean; onSelect: () => void; mode: 'merchant' | 'admin';
  onUpdated: () => Promise<void>; canReply?: boolean; fallback?: CaseRecordSummary; replyUnavailableReason?: string;
}) {
  const query = useGetMerchantCase(id, { query: { queryKey: getGetMerchantCaseQueryKey(id), enabled: mode === 'merchant' && selected } });
  const review = useReviewAdminCase();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<'in_review' | 'resolved' | 'declined'>('in_review');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [providerReference, setProviderReference] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [refundNote, setRefundNote] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID().replaceAll('-', ''));
  const item = query.data;
  const adminQuery = useListAdminCases({ query: { queryKey: getListAdminCasesQueryKey(), enabled: mode === 'admin' } });
  const adminItem = mode === 'admin' ? adminQuery.data?.items.find((row) => row.id === id) : undefined;
  const caseItem = (item ?? adminItem ?? fallback) as unknown as CaseRecordSummary | undefined;
  const threadMessages = caseItem?.messages;
  const refunds = caseItem?.refundEvidence ?? [];
  useEffect(() => {
    if (mode === 'admin' && selected && caseItem && ['in_review', 'resolved', 'declined'].includes(caseItem.status)) {
      setStatus(caseItem.status as typeof status);
    }
  }, [caseItem?.id, caseItem?.status, mode, selected]);
  const attachmentCount = threadMessages?.reduce((count, entry) => count + (entry.attachments?.length ?? 0), 0) ?? 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const evidenceUrl = evidence.trim() || undefined;
    if (mode === 'merchant') {
      if (!canReply) {
        setError('Your current merchant permissions do not allow updates to this case.');
        return;
      }
      if (files.length > 5 || attachmentCount + files.length > 25) {
        setError('Attach no more than five files per message and 25 files per case.');
        return;
      }
      setSubmitting(true);
      try {
        const attachmentUploadTokens: string[] = [];
        for (const file of files) {
          const intent = await postBusinessRequest<{
            uploadURL: string; uploadParameters: Record<string, string>; uploadToken: string; expiresAt: string;
          }>(`/merchant/cases/${id}/attachments/upload-intent`, {
            name: file.name, size: file.size, contentType: file.type,
          });
          const form = new FormData();
          for (const [key, value] of Object.entries(intent.uploadParameters)) form.append(key, value);
          form.append('file', file);
          const uploaded = await fetch(intent.uploadURL, {
            method: 'POST',
            body: form,
          });
          if (!uploaded.ok) throw new Error(`Private upload failed for ${file.name} (${uploaded.status}).`);
          attachmentUploadTokens.push(intent.uploadToken);
        }
        await postBusinessRequest(`/merchant/cases/${id}`, {
          message: text.trim() || (files.length ? 'Supporting files attached.' : ''),
          ...(evidenceUrl ? { evidenceUrl } : {}),
          ...(attachmentUploadTokens.length ? { attachmentUploadTokens } : {}),
        });
        setText(''); setEvidence(''); setFiles([]);
        await Promise.all([query.refetch(), onUpdated()]);
      } catch (err) {
        setError(message(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    review.mutate({ id, data: { status, message: text.trim(), ...(evidenceUrl ? { evidenceUrl } : {}) } }, {
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

  async function recordExternalRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setRefundBusy(true);
    try {
      await postBusinessRequest(`/admin/cases/${id}/refund-record`, {
        amount: Number(refundAmount),
        providerReference: providerReference.trim(),
        evidenceReference: evidenceReference.trim(),
        idempotencyKey,
        note: refundNote.trim(),
      });
      setRefundAmount(''); setProviderReference(''); setEvidenceReference(''); setRefundNote('');
      setIdempotencyKey(crypto.randomUUID().replaceAll('-', ''));
      await Promise.all([
        client.invalidateQueries({ queryKey: getListAdminCasesQueryKey() }),
        client.invalidateQueries({ queryKey: getListMerchantCasesQueryKey() }),
        onUpdated(),
      ]);
    } catch (err) {
      setError(message(err));
    } finally {
      setRefundBusy(false);
    }
  }

  if (!caseItem) return null;
  return <article className="business-case-card">
    <button className="business-case-summary" onClick={onSelect} aria-expanded={selected}>
      <span><strong>#{caseItem.id} · {caseItem.kind} · {caseItem.transactionReference}</strong><small>Updated {date(caseItem.updatedAt)}</small></span>
      <span className="business-case-status"><Status value={caseItem.status} /><Status value={`movement_${caseItem.financialMovement}`} /></span>
    </button>
    {selected && <div className="business-case-detail">
      <div className="business-movement-note"><strong>Money movement: {caseItem.financialMovement}</strong><span>Requested or recorded cases do not mean customer funds moved. Confirmed requires a linked, confirmed refund record for this exact case.</span></div>
      {mode === 'admin' && <a className="btn btn-secondary btn-sm business-review-link" href="/transactions">Open verified transaction/refund workflow <span className="mono">{caseItem.transactionReference}</span></a>}
      {mode === 'merchant' && query.isError && <div className="business-empty"><ErrorBox value={message(query.error)} /><button className="btn btn-secondary" onClick={() => { void query.refetch(); }}>Retry case details</button></div>}
      {mode === 'merchant' && query.isLoading ? <div className="loading-state"><div className="skeleton-line" /></div> : <div className="business-thread">{threadMessages?.map((entry) => <div key={entry.id} className={`business-message business-message-${entry.authorRole}`}><div><strong>{entry.authorRole === 'admin' ? 'Greenpay support' : 'Merchant'}</strong><time>{date(entry.createdAt)}</time></div><p>{entry.message}</p>{entry.evidenceUrl && <a href={entry.evidenceUrl} target="_blank" rel="noreferrer">Open evidence link</a>}
        {!!entry.attachments?.length && <div className="business-attachments">{entry.attachments.map((attachment) => <a key={attachment.id} className="business-attachment" href={`/api${mode === 'admin' ? `/admin/cases/${id}/attachments/${attachment.id}/download` : `/merchant/cases/${id}/attachments/${attachment.id}/download`}`} download><strong>{attachment.name}</strong><small>{attachment.contentType} · {(attachment.size / 1024 / 1024).toFixed(2)} MB</small></a>)}</div>}
      </div>)}</div>}
      {!!refunds.length && <section className="business-refund-evidence"><h3>Confirmed refund evidence</h3>{refunds.map((refund) => <article key={`${refund.reference}-${refund.providerReference}`}><strong>{amount(refund.amount, refund.currency)} · {refund.status}</strong><span>Refund {refund.reference} · external reference {refund.providerReference} · evidence {refund.evidenceReference}</span><time>{date(refund.createdAt)}</time></article>)}</section>}
      {mode === 'admin' && caseItem.kind === 'refund' && caseItem.status !== 'declined' && <form className="form-stack business-refund-record" onSubmit={recordExternalRefund}>
        <div><h3>Record externally confirmed refund</h3><p>This form only records a refund already confirmed with its provider. It never submits a provider refund or moves funds.</p></div>
        <div className="form-grid">
          <label className="field">Confirmed refund amount<input required type="number" min="0.01" step="0.01" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} /></label>
          <label className="field">Provider refund reference<input required maxLength={200} value={providerReference} onChange={(event) => setProviderReference(event.target.value)} /></label>
          <label className="field">Evidence reference<input required maxLength={200} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} /></label>
        </div>
        <label className="field">Verification note<textarea required maxLength={4000} value={refundNote} onChange={(event) => setRefundNote(event.target.value)} /></label>
        <label className="field">Idempotency key<input readOnly value={idempotencyKey} /></label>
        <div className="business-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={refundBusy} onClick={() => setIdempotencyKey(crypto.randomUUID().replaceAll('-', ''))}>Generate a new key</button><button className="btn btn-primary" disabled={refundBusy}>{refundBusy ? 'Recording…' : 'Record confirmed provider evidence'}</button></div>
      </form>}
      {mode === 'merchant' && !canReply && <p className="business-muted">{replyUnavailableReason ?? 'Your current merchant permissions do not allow updates to this case.'}</p>}
      <form className="form-stack business-reply" onSubmit={submit}>
        {mode === 'admin' && <label className="field">Review status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="in_review">In review</option><option value="resolved">Resolved</option><option value="declined">Declined</option></select></label>}
        <label className="field">{mode === 'admin' ? 'Support response' : 'Add supporting information'}<textarea required={mode === 'admin' || files.length === 0} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label className="field">Evidence URL <input type="url" maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        {mode === 'merchant' && <label className="field">Private supporting files
          <small>PDF, PNG or JPEG · max 10 MB each · {Math.max(0, 25 - attachmentCount)} files remaining for this case · up to five per message</small>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" multiple disabled={!canReply || attachmentCount >= 25} onChange={(event) => {
            const selectedFiles = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (selectedFiles.length > 5) { setError('Choose no more than five files per message.'); return; }
            if (selectedFiles.some((file) => file.size < 1 || file.size > 10 * 1024 * 1024)) { setError('Each file must be larger than zero and no more than 10 MB.'); return; }
            if (selectedFiles.some((file) => !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type))) { setError('Only PDF, PNG and JPEG files are allowed.'); return; }
            if (attachmentCount + files.length + selectedFiles.length > 25) { setError('This case has reached the 25-file limit.'); return; }
            setError(''); setFiles((current) => [...current, ...selectedFiles]);
          }} />
          {files.length > 0 && <small>{files.map((file) => file.name).join(', ')} <button type="button" className="btn btn-quiet btn-sm" onClick={() => setFiles([])}>Clear</button></small>}
        </label>}
        <ErrorBox value={error} />
        <button className="btn btn-secondary" disabled={submitting || review.isPending || (mode === 'merchant' && !canReply)}>{mode === 'admin' ? 'Save review' : submitting ? 'Uploading and saving…' : 'Add to case thread'}</button>
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