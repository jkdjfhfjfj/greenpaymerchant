import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ArrowLeft, ArrowRight, CircleAlert, Plus, Send, TicketCheck } from 'lucide-react';
import { Form } from '@/components/ui/form';
import {
  createOwnSupportTicket,
  deliveryNotice,
  formatSupportDate,
  ownSupportTicket,
  ownSupportTickets,
  replyToOwnSupportTicket,
  type SupportTicketInput,
} from './support-api';
import '@/support.css';

type TicketFormValues = SupportTicketInput & {
  category: NonNullable<SupportTicketInput['category']>;
};

interface ReplyFormValues {
  body: string;
}

function ticketStatusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

export function SupportPage() {
  const [, setLocation] = useLocation();
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const value = Number(new URLSearchParams(window.location.search).get('ticket'));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const ticketsQuery = useQuery({
    queryKey: ['support', 'tickets'],
    queryFn: () => ownSupportTickets(),
    staleTime: 15_000,
    refetchOnMount: 'always',
  });
  const detailQuery = useQuery({
    queryKey: ['support', 'ticket', selectedId],
    queryFn: () => ownSupportTicket(selectedId!),
    enabled: selectedId !== null,
    staleTime: 10_000,
  });
  const createForm = useForm<TicketFormValues>({
    defaultValues: { subject: '', category: 'other', message: '' },
  });
  const replyForm = useForm<ReplyFormValues>({ defaultValues: { body: '' } });
  const createTicket = useMutation({
    mutationFn: (values: TicketFormValues) => createOwnSupportTicket({
      ...values, subject: values.subject.trim(), message: values.message.trim(),
    }),
    onSuccess: async (ticket) => {
      createForm.reset();
      setCreating(false);
      setSelectedId(ticket.id);
      setLocation(`/support?ticket=${ticket.id}`);
      await queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] });
      await queryClient.invalidateQueries({ queryKey: ['support', 'ticket', ticket.id] });
    },
  });
  const reply = useMutation({
    mutationFn: (values: ReplyFormValues) => replyToOwnSupportTicket(selectedId!, { body: values.body.trim() }),
    onSuccess: async () => {
      replyForm.reset();
      await queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] });
      await queryClient.invalidateQueries({ queryKey: ['support', 'ticket', selectedId] });
    },
  });

  const selectedTicket = detailQuery.data?.ticket;
  const orderedTickets = useMemo(
    () => ticketsQuery.data?.items ?? [],
    [ticketsQuery.data?.items],
  );

  function selectTicket(id: number) {
    setSelectedId(id);
    setCreating(false);
    setLocation(`/support?ticket=${id}`);
  }

  function startNewTicket() {
    setSelectedId(null);
    setCreating(true);
    setLocation('/support');
  }

  const authRequired = ticketsQuery.isError && ticketsQuery.error.message.toLowerCase().includes('sign in');
  return <main className="support-page">
    <header className="support-app-header">
      <div><a href="/" className="support-brand" data-testid="link-support-home">greenpay<span>.</span></a><span className="support-header-divider">/</span><strong>Support center</strong></div>
      <a href="/contact" className="support-header-link" data-testid="link-public-contact">Contact support</a>
    </header>
    <section className="support-heading-row">
      <div><div className="support-eyebrow"><TicketCheck size={14} /> CUSTOMER CARE</div><h1>Your support requests</h1><p>Follow a conversation, add context, and see updates from the Greenpay team.</p></div>
      <button type="button" className="support-button support-button-primary" onClick={startNewTicket} data-testid="button-new-ticket"><Plus size={16} /> New request</button>
    </section>
    <div className="support-workspace">
      <aside className="support-ticket-sidebar">
        <div className="support-sidebar-title"><span>YOUR TICKETS</span><span>{orderedTickets.length}</span></div>
        {ticketsQuery.isLoading && <div className="support-skeleton" />}
        {ticketsQuery.isError && <div className="support-inline-error" role="alert" data-testid="text-ticket-list-error">
          <CircleAlert size={16} /><span>{ticketsQuery.error.message}</span>
          {authRequired && <a href="/sign-in" data-testid="link-support-sign-in">Sign in</a>}
          <button type="button" onClick={() => { void ticketsQuery.refetch(); }} data-testid="button-retry-tickets">Retry</button>
        </div>}
        {!ticketsQuery.isError && !ticketsQuery.isLoading && orderedTickets.length === 0 && <div className="support-sidebar-empty">No support requests yet. Start a new request whenever you need us.</div>}
        <div className="support-ticket-list">
          {orderedTickets.map((ticket) => <button type="button" key={ticket.id} className={`support-ticket-list-item ${selectedId === ticket.id ? 'is-selected' : ''}`} onClick={() => selectTicket(ticket.id)} data-testid={`button-ticket-${ticket.id}`}>
            <span className="support-ticket-item-top"><strong>{ticket.subject}</strong><span className={`support-status status-${ticket.status}`}>{ticketStatusLabel(ticket.status)}</span></span>
            <span className="support-ticket-item-bottom"><span>{ticket.reference}</span><span>{formatSupportDate(ticket.updatedAt)}</span></span>
          </button>)}
        </div>
      </aside>
      <section className="support-thread-panel">
        {creating ? <div className="support-panel-inner">
          <button type="button" className="support-back-link" onClick={() => { setCreating(false); setLocation('/support'); }} data-testid="button-cancel-new-ticket"><ArrowLeft size={14} /> All requests</button>
          <h2>Open a support request</h2><p className="support-panel-copy">Please include enough detail for us to investigate. Your signed-in account and verified email are attached automatically.</p>
          <Form {...createForm}>
            <form className="support-form support-form-thread" onSubmit={createForm.handleSubmit((values) => createTicket.mutate(values))}>
              <label className="support-field"><span>Subject</span><input {...createForm.register('subject', { required: true, minLength: 3, maxLength: 180 })} maxLength={180} data-testid="input-ticket-subject" /></label>
              <label className="support-field"><span>Request type</span><select {...createForm.register('category')} data-testid="select-ticket-category"><option value="payments">Payments</option><option value="account">Account</option><option value="verification">Business verification</option><option value="technical">Technical issue</option><option value="other">Something else</option></select></label>
              <label className="support-field"><span>Message</span><textarea {...createForm.register('message', { required: true, minLength: 10, maxLength: 8000 })} rows={7} maxLength={8000} data-testid="input-ticket-message" /><small className="support-field-hint">10–8,000 characters. Never include passwords, secret keys, or full payment credentials.</small></label>
              {createTicket.isError && <div className="support-error" role="alert" data-testid="text-create-ticket-error">{createTicket.error.message}</div>}
              <button className="support-button support-button-primary" disabled={createTicket.isPending} type="submit" data-testid="button-submit-ticket"><Send size={15} />{createTicket.isPending ? 'Opening request…' : 'Open request'}</button>
            </form>
          </Form>
        </div> : selectedId === null ? <div className="support-thread-empty">
          <span className="support-empty-mark"><TicketCheck size={25} /></span><h2>Choose a request</h2><p>Select a ticket to see the conversation, or open a new support request.</p>
          <button type="button" className="support-button support-button-primary" onClick={startNewTicket} data-testid="button-empty-new-ticket"><Plus size={15} /> New request</button>
        </div> : detailQuery.isLoading ? <div className="support-panel-inner"><div className="support-skeleton" /><div className="support-skeleton support-skeleton-long" /></div> : detailQuery.isError ? <div className="support-thread-empty" role="alert" data-testid="text-ticket-detail-error">
          <CircleAlert size={22} /><h2>Could not open this request</h2><p>{detailQuery.error.message}</p><button type="button" onClick={() => { void detailQuery.refetch(); }} className="support-button support-button-quiet" data-testid="button-retry-ticket-detail">Try again</button>
        </div> : detailQuery.data ? <div className="support-panel-inner">
          <div className="support-thread-topline"><button type="button" className="support-back-link" onClick={() => { setSelectedId(null); setLocation('/support'); }} data-testid="button-back-to-tickets"><ArrowLeft size={14} /> Requests</button><span className={`support-status status-${selectedTicket?.status}`}>{ticketStatusLabel(selectedTicket?.status ?? '')}</span></div>
          <h2>{selectedTicket?.subject}</h2>
          <div className="support-ticket-meta"><span>{selectedTicket?.reference}</span><span>Opened {selectedTicket ? formatSupportDate(selectedTicket.createdAt) : ''}</span></div>
          <div className="support-message-list" data-testid="list-support-messages">
            {detailQuery.data.messages.map((message) => <article key={message.id} className={`support-message ${message.authorRole === 'admin' ? 'message-agent' : 'message-customer'}`} data-testid={`message-support-${message.id}`}>
              <div className="support-message-byline"><strong>{message.authorRole === 'admin' ? 'Greenpay Support' : 'You'}</strong><time>{formatSupportDate(message.createdAt)}</time></div>
              <p>{message.body}</p>
              <small>In-app message · email delivery not configured</small>
            </article>)}
          </div>
          {selectedTicket?.status === 'closed' ? <div className="support-closed-note">This request is closed. Open a new request if you still need help.</div> : <Form {...replyForm}>
            <form className="support-reply-form" onSubmit={replyForm.handleSubmit((values) => reply.mutate(values))}>
              <label className="support-field"><span>Add a reply</span><textarea {...replyForm.register('body', { required: true, maxLength: 8000 })} rows={3} maxLength={8000} placeholder="Write a reply…" data-testid="input-ticket-reply" /></label>
              {reply.isError && <div className="support-error" role="alert" data-testid="text-ticket-reply-error">{(reply.error as Error).message}</div>}
              <div className="support-reply-actions"><span>Replies are saved in your in-app thread.</span><button type="submit" className="support-button support-button-primary" disabled={reply.isPending} data-testid="button-send-ticket-reply"><Send size={14} />{reply.isPending ? 'Sending…' : 'Send reply'}<ArrowRight size={14} /></button></div>
            </form>
          </Form>}
          <div className="support-delivery-foot">{deliveryNotice()}</div>
        </div> : <div className="support-thread-empty"><h2>Request unavailable</h2><p>Refresh your request list and try again.</p></div>}
      </section>
    </div>
  </main>;
}

export default SupportPage;