import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Inbox, Search, Send, ShieldCheck } from 'lucide-react';
import { Form } from '@/components/ui/form';
import {
  adminSupportTicket,
  adminSupportTickets,
  formatSupportDate,
  replyAsAdmin,
  updateAdminSupportTicket,
  type AdminListSupportTicketsParams,
  type TicketStatus,
} from './support-api';
import '@/support.css';

interface AdminReplyValues { body: string; }

const statusOptions: TicketStatus[] = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];

export function AdminSupportPage() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const replyForm = useForm<AdminReplyValues>({ defaultValues: { body: '' } });
  const ticketsQuery = useQuery({
    queryKey: ['admin', 'support', 'tickets', status, search],
    queryFn: () => {
      const params: AdminListSupportTicketsParams = {
        ...(status ? { status: status as NonNullable<AdminListSupportTicketsParams['status']> } : {}),
        ...(search ? { search } : {}),
      };
      return adminSupportTickets(params);
    },
    staleTime: 10_000,
    refetchOnMount: 'always',
  });
  const detailQuery = useQuery({
    queryKey: ['admin', 'support', 'ticket', selectedId],
    queryFn: () => adminSupportTicket(selectedId!),
    enabled: selectedId !== null,
  });
  const updateStatus = useMutation({
    mutationFn: (nextStatus: TicketStatus) => updateAdminSupportTicket(selectedId!, { status: nextStatus }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'ticket', selectedId] });
    },
  });
  const reply = useMutation({
    mutationFn: (values: AdminReplyValues) => replyAsAdmin(selectedId!, { body: values.body.trim() }),
    onSuccess: async () => {
      replyForm.reset();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'support', 'ticket', selectedId] });
    },
  });
  const tickets = useMemo(() => ticketsQuery.data?.items ?? [], [ticketsQuery.data?.items]);
  const detail = detailQuery.data;

  return <main className="support-page admin-support-page">
    <header className="support-app-header">
      <div><a href="/" className="support-brand" data-testid="link-admin-support-home">greenpay<span>.</span></a><span className="support-header-divider">/</span><strong>Support inbox</strong></div>
      <span className="support-admin-label"><ShieldCheck size={14} /> ADMIN WORKSPACE</span>
    </header>
    <section className="support-heading-row">
      <div><div className="support-eyebrow"><Inbox size={14} /> CUSTOMER CARE</div><h1>Support inbox</h1><p>Review incoming requests, update status, and keep replies in one conversation.</p></div>
      <div className="support-inbox-count"><strong>{tickets.length}</strong><span>Showing requests</span></div>
    </section>
    <div className="support-admin-filters">
      <form className="support-search-form" onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()); }}>
        <Search size={16} /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search subject, email, or reference" maxLength={120} aria-label="Search support inbox" data-testid="input-admin-support-search" />
        <button type="submit" className="support-button support-button-quiet" data-testid="button-admin-support-search">Search</button>
      </form>
      <label className="support-filter-select"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-admin-support-status-filter"><option value="">All statuses</option>{statusOptions.map((item) => <option value={item} key={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
      <button type="button" className="support-button support-button-quiet" onClick={() => { void ticketsQuery.refetch(); }} data-testid="button-refresh-support">Refresh</button>
    </div>
    <div className="support-workspace support-admin-workspace">
      <aside className="support-ticket-sidebar">
        <div className="support-sidebar-title"><span>INBOX</span><span>{tickets.length}</span></div>
        {ticketsQuery.isLoading && <div className="support-skeleton" />}
        {ticketsQuery.isError && <div className="support-inline-error" role="alert" data-testid="text-admin-support-error"><AlertCircle size={16} /><span>{ticketsQuery.error.message}</span><button onClick={() => { void ticketsQuery.refetch(); }} type="button" data-testid="button-retry-admin-support">Retry</button></div>}
        {!ticketsQuery.isLoading && !ticketsQuery.isError && tickets.length === 0 && <div className="support-sidebar-empty">No requests match these filters.</div>}
        <div className="support-ticket-list">
          {tickets.map((ticket) => <button type="button" key={ticket.id} className={`support-ticket-list-item ${selectedId === ticket.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(ticket.id)} data-testid={`button-admin-ticket-${ticket.id}`}>
            <span className="support-ticket-item-top"><strong>{ticket.subject}</strong><span className={`support-status status-${ticket.status}`}>{ticket.status.replaceAll('_', ' ')}</span></span>
            <span className="support-ticket-requester">{ticket.requesterName} · {ticket.requesterEmail}</span>
            <span className="support-ticket-item-bottom"><span>{ticket.reference}</span><span>{formatSupportDate(ticket.updatedAt)}</span></span>
          </button>)}
        </div>
      </aside>
      <section className="support-thread-panel">
        {selectedId === null ? <div className="support-thread-empty"><span className="support-empty-mark"><Inbox size={25} /></span><h2>Select a request</h2><p>Choose a customer request to view its history and respond.</p></div> : detailQuery.isLoading ? <div className="support-panel-inner"><div className="support-skeleton" /><div className="support-skeleton support-skeleton-long" /></div> : detailQuery.isError ? <div className="support-thread-empty" role="alert" data-testid="text-admin-ticket-detail-error"><AlertCircle size={22} /><h2>Request unavailable</h2><p>{detailQuery.error.message}</p><button type="button" className="support-button support-button-quiet" onClick={() => { void detailQuery.refetch(); }} data-testid="button-retry-admin-detail">Retry</button></div> : detail ? <div className="support-panel-inner">
          <div className="support-thread-topline"><button type="button" className="support-back-link" onClick={() => setSelectedId(null)} data-testid="button-close-admin-detail"><ArrowLeft size={14} /> Inbox</button><span className={`support-status status-${detail.ticket.status}`}>{detail.ticket.status.replaceAll('_', ' ')}</span></div>
          <h2>{detail.ticket.subject}</h2>
          <div className="support-ticket-meta"><span>{detail.ticket.reference}</span><span>{detail.ticket.requesterName} · {detail.ticket.requesterEmail}</span><span>Opened {formatSupportDate(detail.ticket.createdAt)}</span></div>
          <label className="support-status-editor"><span>Ticket status</span><select value={detail.ticket.status} onChange={(event) => updateStatus.mutate(event.target.value as TicketStatus)} disabled={updateStatus.isPending} data-testid="select-admin-ticket-status">{statusOptions.map((item) => <option value={item} key={item}>{item.replaceAll('_', ' ')}</option>)}</select>
            {updateStatus.isError && <small role="alert" className="support-field-error">{updateStatus.error.message}</small>}
          </label>
          <div className="support-message-list" data-testid="list-admin-support-messages">
            {detail.messages.map((message) => <article key={message.id} className={`support-message ${message.authorRole === 'admin' ? 'message-agent' : 'message-customer'}`} data-testid={`message-admin-support-${message.id}`}>
              <div className="support-message-byline"><strong>{message.authorRole === 'admin' ? 'Greenpay Support' : message.authorName}</strong><time>{formatSupportDate(message.createdAt)}</time></div>
              <p>{message.body}</p><small>In-app message · email delivery not configured</small>
            </article>)}
          </div>
          <Form {...replyForm}>
            <form className="support-reply-form" onSubmit={replyForm.handleSubmit((values) => reply.mutate(values))}>
              <label className="support-field"><span>Reply to customer</span><textarea {...replyForm.register('body', { required: true, maxLength: 8000 })} rows={4} maxLength={8000} data-testid="input-admin-support-reply" /></label>
              {reply.isError && <div className="support-error" role="alert" data-testid="text-admin-support-reply-error">{reply.error.message}</div>}
              <div className="support-reply-actions"><span>Customer will see this in their in-app ticket thread.</span><button type="submit" className="support-button support-button-primary" disabled={reply.isPending} data-testid="button-admin-send-reply"><Send size={14} />{reply.isPending ? 'Sending…' : 'Send reply'}</button></div>
            </form>
          </Form>
        </div> : <div className="support-thread-empty"><h2>Request unavailable</h2></div>}
      </section>
    </div>
  </main>;
}

export default AdminSupportPage;