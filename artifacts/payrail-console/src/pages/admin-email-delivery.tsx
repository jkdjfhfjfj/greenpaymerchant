import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, Clock3, Mail, RefreshCw, RotateCcw, Search,
  Send, ShieldAlert, ShieldCheck, XCircle,
} from 'lucide-react';
import {
  getFindAdminPlatformUsersQueryKey, useFindAdminPlatformUsers, useSendAdminEmailBroadcast,
} from '@workspace/api-client-react';
import './admin-email-delivery.css';

type DeliveryState = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'unconfigured';
type Settings = {
  provider: 'mailtrap';
  enabled: boolean;
  ready: boolean;
  fromEmail: string | null;
  senderVerified: boolean;
  tokenConfigured: boolean;
  worker: 'running' | 'stopped' | 'degraded';
  counts: {
    queued: number;
    sending: number;
    sent: number;
    failed: number;
    uncertain: number;
    heldForReview: number;
  };
};
type DeliveryItem = {
  id: number;
  eventKey: string;
  purpose: string;
  recipientEmail: string;
  deliveryState: DeliveryState;
  attempts: number;
  createdAt: string;
  updatedAt?: string;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  heldForReview: boolean;
};
type Outbox = {
  items: DeliveryItem[];
  legacyHeld: DeliveryItem[];
  total: number;
  page: number;
  perPage: number;
};
type ApiErrorBody = { error?: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function Status({ state }: { state: DeliveryState }) {
  return <span className={`email-status email-status-${state}`}><i />{state.replaceAll('_', ' ')}</span>;
}

function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="email-error" role="alert"><AlertTriangle size={16} />{message}</div> : null;
}

export function AdminEmailDeliveryPage() {
  const queryClient = useQueryClient();
  const [sender, setSender] = useState('');
  const [senderVerified, setSenderVerified] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [broadcastAudience, setBroadcastAudience] = useState<'all' | 'user'>('all');
  const [broadcastLookup, setBroadcastLookup] = useState('');
  const [broadcastSearchEmail, setBroadcastSearchEmail] = useState('');
  const [selectedBroadcastUser, setSelectedBroadcastUser] = useState<{ userId: string; email: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{ broadcastId: string; audience: 'all' | 'user'; queuedRecipients: number; skippedUnverified: number } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin', 'email-delivery', 'settings'],
    queryFn: () => request<Settings>('/api/admin/email-delivery/settings'),
    staleTime: 5_000,
    refetchOnMount: 'always',
    refetchInterval: 15_000,
  });
  const settings = settingsQuery.data;
  const userLookupParams = { email: broadcastSearchEmail };
  const userLookup = useFindAdminPlatformUsers(userLookupParams, {
    query: { queryKey: getFindAdminPlatformUsersQueryKey(userLookupParams), enabled: Boolean(broadcastSearchEmail) },
  });
  const sendBroadcast = useSendAdminEmailBroadcast();
  useEffect(() => {
    if (!settings || settingsDirty) return;
    setSender(settings.fromEmail || '');
    setSenderVerified(settings.senderVerified);
    setEnabled(settings.enabled);
  }, [settings, settingsDirty]);
  const outboxQuery = useQuery({
    queryKey: ['admin', 'email-delivery', 'outbox', 1, filter, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: '1', perPage: '30' });
      if (filter) params.set('deliveryState', filter);
      if (search.trim()) params.set('search', search.trim());
      return request<Outbox>(`/api/admin/email-delivery/outbox?${params}`);
    },
    staleTime: 5_000,
    refetchOnMount: 'always',
    refetchInterval: 15_000,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-delivery', 'settings'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-delivery', 'outbox'] }),
    ]);
  };
  const saveSettings = useMutation({
    mutationFn: (body: { enabled?: boolean; fromEmail?: string; senderVerified?: true }) =>
      request<Settings>('/api/admin/email-delivery/settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: async (next) => {
      setEnabled(next.enabled);
      setSender(next.fromEmail || '');
      setSenderVerified(next.senderVerified);
      setSettingsDirty(false);
      setPageError('');
      setNotice('Mailtrap settings saved. The token remains server-side.');
      await refresh();
    },
    onError: (error) => setPageError(error.message),
  });
  const sendTest = useMutation({
    mutationFn: (recipientEmail: string) =>
      request<{ accepted: boolean; deliveryState: DeliveryState; detail: string }>(
        '/api/admin/email-delivery/test',
        { method: 'POST', body: JSON.stringify({ recipientEmail }) },
      ),
    onSuccess: async (result) => {
      setPageError('');
      setNotice(result.detail);
      await refresh();
    },
    onError: (error) => setPageError(error.message),
  });
  const retry = useMutation({
    mutationFn: (id: number) => request<DeliveryItem>(
      `/api/admin/email-delivery/outbox/${id}/retry`, { method: 'POST', body: '{}' },
    ),
    onSuccess: async () => {
      setPageError('');
      setNotice('Failed email requeued. Uncertain submissions cannot be retried automatically.');
      await refresh();
    },
    onError: (error) => setPageError(error.message),
  });
  const reviewLegacy = useMutation({
    mutationFn: (item: DeliveryItem) => request<DeliveryItem>(
      `/api/admin/email-delivery/outbox/legacy/${item.id}/review-requeue`,
      { method: 'POST', body: JSON.stringify({ reviewed: true }) },
    ),
    onSuccess: async () => {
      setPageError('');
      setNotice('The selected legacy support email has been reviewed and queued. No other backlog was sent.');
      await refresh();
    },
    onError: (error) => setPageError(error.message),
  });

  const testReady = Boolean(settings?.tokenConfigured && settings.senderVerified && settings.fromEmail);
  const emailRows = useMemo(() => outboxQuery.data?.items ?? [], [outboxQuery.data?.items]);
  const legacyRows = useMemo(() => outboxQuery.data?.legacyHeld ?? [], [outboxQuery.data?.legacyHeld]);

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError('');
    setNotice('');
    const current = settingsQuery.data;
    const changedSender = sender.trim().toLowerCase() !== (current?.fromEmail || '').toLowerCase() ||
      (!current?.senderVerified && senderVerified);
    if (changedSender && !senderVerified) {
      setPageError('Confirm that the sender address is verified in Mailtrap before saving it.');
      return;
    }
    saveSettings.mutate({
      enabled,
      ...(changedSender ? { fromEmail: sender.trim(), senderVerified: true as const } : {}),
    });
  }

  function submitTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError('');
    setNotice('');
    sendTest.mutate(testRecipient.trim());
  }

  function findBroadcastUser() {
    setSelectedBroadcastUser(null);
    setBroadcastSearchEmail(broadcastLookup.trim().toLowerCase());
  }

  function submitBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPageError('');
    setNotice('');
    setBroadcastResult(null);
    if (broadcastAudience === 'user' && !selectedBroadcastUser) {
      setPageError('Find and select a verified user before sending to one account.');
      return;
    }
    const form = new FormData(event.currentTarget);
    const subject = String(form.get('broadcastSubject') || '').trim();
    const message = String(form.get('broadcastMessage') || '').trim();
    if (broadcastAudience === 'all' && !confirmAll) {
      setPageError('Confirm the all-user broadcast before queueing it.');
      return;
    }
    sendBroadcast.mutate({
      data: {
        audience: broadcastAudience,
        ...(broadcastAudience === 'user' && selectedBroadcastUser ? { userId: selectedBroadcastUser.userId } : {}),
        subject,
        message,
        confirmAll: broadcastAudience === 'all' ? true : false,
      },
    }, {
      onSuccess: async (result) => {
        setBroadcastResult(result);
        setNotice('Broadcast queued. The delivery result below reflects the server response.');
        setPageError('');
        await refresh();
      },
      onError: (error) => setPageError(error.message),
    });
  }

  return <main className="admin-email-page">
    <header className="admin-email-heading">
      <div>
        <span className="admin-email-eyebrow"><Mail size={14} /> PLATFORM ADMIN / DELIVERY</span>
        <h1>Email delivery</h1>
        <p>Manage Greenpay’s transactional Mailtrap channel, inspect durable queue state, and review legacy messages safely.</p>
      </div>
      <button className="email-button email-button-quiet" type="button" onClick={() => { void refresh(); }} data-testid="button-refresh-email-delivery">
        <RefreshCw size={15} /> Refresh
      </button>
    </header>
    <ErrorNotice message={pageError || (settingsQuery.isError ? settingsQuery.error.message : outboxQuery.isError ? outboxQuery.error.message : '')} />
    {notice && <div className="email-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}

    <section className="email-metrics" aria-label="Email delivery status">
      {[
        { label: 'Queued', value: settings?.counts.queued ?? '—', icon: Clock3, state: 'queued' },
        { label: 'Sending', value: settings?.counts.sending ?? '—', icon: Send, state: 'sending' },
        { label: 'Accepted', value: settings?.counts.sent ?? '—', icon: CheckCircle2, state: 'sent' },
        { label: 'Failed', value: settings?.counts.failed ?? '—', icon: XCircle, state: 'failed' },
        { label: 'Uncertain', value: settings?.counts.uncertain ?? '—', icon: ShieldAlert, state: 'uncertain' },
        { label: 'Held for review', value: settings?.counts.heldForReview ?? '—', icon: AlertTriangle, state: 'unconfigured' },
      ].map((metric) => {
        const Icon = metric.icon;
        return <article className="email-metric" key={metric.label} data-testid={`email-metric-${metric.state}`}>
          <div className={`email-metric-icon metric-${metric.state}`}><Icon size={17} /></div>
          <span>{metric.label}</span><strong>{metric.value}</strong>
        </article>;
      })}
    </section>

    <div className="admin-email-grid">
      <section className="email-panel">
        <div className="email-panel-heading"><div><span className="email-panel-kicker">PROVIDER</span><h2>Mailtrap sending</h2></div>
          <span className={`email-readiness ${settings?.ready ? 'is-ready' : 'is-not-ready'}`}>
            <i />{settings?.ready ? 'Ready' : 'Not ready'}
          </span>
        </div>
        <div className="email-provider-facts">
          <div><span>Transport</span><strong>Mailtrap Email Sending API</strong></div>
          <div><span>Server token</span><strong>{settings?.tokenConfigured ? 'Configured · hidden' : 'Missing server secret'}</strong></div>
          <div><span>Worker</span><strong>{settings?.worker || (settingsQuery.isLoading ? 'Loading' : 'Unknown')}</strong></div>
        </div>
        {!settings?.tokenConfigured && <div className="email-warning"><ShieldAlert size={16} /><span>Add <code>MAILTRAP_API_TOKEN</code> or <code>MAILTRAP_API_KEY</code> as an API server secret. Keys are never shown here.</span></div>}
        <form className="email-settings-form" onSubmit={submitSettings}>
          <label className="email-field"><span>Verified sender email</span>
            <input type="email" value={sender} onChange={(event) => {
              setSender(event.target.value);
              setSettingsDirty(true);
              if (event.target.value.trim().toLowerCase() !== (settings?.fromEmail || '').toLowerCase()) setSenderVerified(false);
            }} placeholder="payments@greenpay.example" autoComplete="email" />
          </label>
          <label className="email-check-row">
            <input type="checkbox" checked={senderVerified} onChange={(event) => { setSettingsDirty(true); setSenderVerified(event.target.checked); }} />
            <span><strong>Sender is verified in Mailtrap</strong><small>Only confirm after its domain/address is verified in the Mailtrap account.</small></span>
          </label>
          <label className="email-check-row">
            <input type="checkbox" checked={enabled} onChange={(event) => { setSettingsDirty(true); setEnabled(event.target.checked); }} />
            <span><strong>Enable transactional email dispatch</strong><small>Existing unconfigured support messages remain held until individually reviewed.</small></span>
          </label>
          <button className="email-button email-button-primary" type="submit" disabled={saveSettings.isPending || settingsQuery.isLoading} data-testid="button-save-email-settings">
            <ShieldCheck size={15} />{saveSettings.isPending ? 'Saving…' : 'Save delivery settings'}
          </button>
        </form>
      </section>

      <section className="email-panel email-test-panel">
        <div className="email-panel-heading"><div><span className="email-panel-kicker">EXPLICIT ACTION</span><h2>Send a test</h2></div><Send size={18} /></div>
        <p className="email-panel-copy">A test message is sent only after submitting this form. It is recorded in the same outbox as a real provider attempt.</p>
        <form className="email-settings-form" onSubmit={submitTest}>
          <label className="email-field"><span>Recipient email</span>
            <input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="you@example.com" required />
          </label>
          {!testReady && <div className="email-warning"><AlertTriangle size={16} /><span>Test sending requires a server token and an explicitly confirmed sender address.</span></div>}
          <button className="email-button email-button-primary" type="submit" disabled={!testReady || sendTest.isPending} data-testid="button-send-email-test">
            <Send size={15} />{sendTest.isPending ? 'Submitting…' : 'Send test email'}
          </button>
        </form>
      </section>
    </div>

    <section className="email-panel email-broadcast-panel">
      <div className="email-panel-heading"><div><span className="email-panel-kicker">ANNOUNCEMENTS</span><h2>Compose a broadcast</h2><p>Queue a message for verified accounts. Sending to everyone requires explicit confirmation.</p></div><Mail size={18} /></div>
      <form className="email-broadcast-form" onSubmit={submitBroadcast}>
        <div className="email-audience-switch" role="group" aria-label="Broadcast audience">
          <button type="button" data-testid="button-audience-all" className={broadcastAudience === 'all' ? 'selected' : ''} onClick={() => { setBroadcastAudience('all'); setSelectedBroadcastUser(null); }}>All verified users</button>
          <button type="button" data-testid="button-audience-user" className={broadcastAudience === 'user' ? 'selected' : ''} onClick={() => { setBroadcastAudience('user'); setConfirmAll(false); }}>One user</button>
        </div>
        {broadcastAudience === 'all' ? <label className="email-check-row email-broadcast-confirm">
          <input type="checkbox" data-testid="input-confirm-broadcast-all" checked={confirmAll} onChange={(event) => setConfirmAll(event.target.checked)} />
          <span><strong>Confirm sending to all verified users</strong><small>Unverified addresses are skipped by the server.</small></span>
        </label> : <div className="email-user-lookup">
          <div className="email-search">
            <Search size={15} /><input type="email" required maxLength={254} value={broadcastLookup} onChange={(event) => setBroadcastLookup(event.target.value)} placeholder="Exact verified email address" aria-label="Find one verified user" data-testid="input-broadcast-user-email" />
            <button type="button" data-testid="button-find-broadcast-user" disabled={userLookup.isFetching || !broadcastLookup.trim()} onClick={findBroadcastUser}>{userLookup.isFetching ? 'Finding…' : 'Find user'}</button>
          </div>
          {broadcastSearchEmail && userLookup.isLoading && <div className="email-lookup-state">Looking up the exact primary email…</div>}
          {broadcastSearchEmail && userLookup.isError && <div className="email-lookup-error">The verified user lookup failed. Search again to retry.</div>}
          {broadcastSearchEmail && userLookup.isSuccess && !userLookup.data?.items.some((user) => user.email.toLowerCase() === broadcastSearchEmail) && <div className="email-lookup-state">No exact verified primary email match.</div>}
          {broadcastSearchEmail && userLookup.data?.items.filter((user) => user.email.toLowerCase() === broadcastSearchEmail).map((user) => <button className={`email-user-result ${selectedBroadcastUser?.userId === user.userId ? 'chosen' : ''}`} type="button" key={user.userId} data-testid={`button-select-broadcast-user-${user.userId}`} onClick={() => setSelectedBroadcastUser({ userId: user.userId, email: user.email })}>
            <span><strong>{user.email}</strong><small>Verified exact match · Clerk user ID {user.userId}</small></span><span>{selectedBroadcastUser?.userId === user.userId ? 'Selected' : 'Select'}</span>
          </button>)}
          {selectedBroadcastUser && <div className="email-selected-user" role="status">Selected account: {selectedBroadcastUser.email}</div>}
        </div>}
        <label className="email-field"><span>Subject</span><input name="broadcastSubject" required minLength={2} maxLength={160} data-testid="input-broadcast-subject" /></label>
        <label className="email-field"><span>Message</span><textarea name="broadcastMessage" required minLength={2} maxLength={12000} rows={6} data-testid="input-broadcast-message" /></label>
        <button className="email-button email-button-primary" type="submit" disabled={sendBroadcast.isPending || (broadcastAudience === 'all' ? !confirmAll : !selectedBroadcastUser)} data-testid="button-send-broadcast">
          <Send size={15} />{sendBroadcast.isPending ? 'Queueing…' : 'Queue broadcast'}
        </button>
      </form>
      {broadcastResult && <div className="email-broadcast-result" role="status" data-testid="broadcast-delivery-result">
        <CheckCircle2 size={17} /><div><strong>Broadcast queued</strong><span>{broadcastResult.queuedRecipients.toLocaleString()} queued · {broadcastResult.skippedUnverified.toLocaleString()} unverified skipped</span><small>Broadcast reference {broadcastResult.broadcastId} · audience: {broadcastResult.audience === 'all' ? 'all verified users' : 'one selected user'}</small></div>
      </div>}
      {sendBroadcast.error && <ErrorNotice message={sendBroadcast.error.message} />}
    </section>

    <section className="email-panel email-outbox-panel">
      <div className="email-panel-heading">
        <div><span className="email-panel-kicker">OBSERVABILITY</span><h2>Transactional outbox</h2><p>Accepted means Mailtrap confirmed acceptance, not inbox delivery.</p></div>
        <span className="email-total-count">{outboxQuery.data?.total ?? 0} records</span>
      </div>
      <div className="email-toolbar">
        <form className="email-search" onSubmit={(event) => event.preventDefault()}>
          <Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search recipient or event key" aria-label="Search transactional outbox" />
        </form>
        <label className="email-filter"><span>Status</span><select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="">All statuses</option>
          {['queued', 'sending', 'sent', 'failed', 'uncertain'].map((state) => <option key={state} value={state}>{state}</option>)}
        </select></label>
      </div>
      {outboxQuery.isLoading ? <div className="email-empty">Loading delivery history…</div> : emailRows.length === 0 ? <div className="email-empty">No transactional email records match these filters.</div> : <div className="email-table-wrap">
        <table className="email-table">
          <thead><tr><th>Message</th><th>Recipient</th><th>Status</th><th>Attempts</th><th>Updated</th><th>Action</th></tr></thead>
          <tbody>{emailRows.map((item) => <tr key={item.id}>
            <td><strong>{item.purpose.replaceAll('_', ' ')}</strong><small>{item.eventKey}</small>{item.lastError && <small className="email-row-error">{item.lastError}</small>}</td>
            <td>{item.recipientEmail}</td><td><Status state={item.deliveryState} /></td>
            <td>{item.attempts}</td><td>{formatDate(item.updatedAt || item.createdAt)}</td>
            <td>{item.deliveryState === 'failed' ? <button type="button" className="email-row-action" onClick={() => retry.mutate(item.id)} disabled={retry.isPending}><RotateCcw size={14} /> Retry</button>
              : item.deliveryState === 'uncertain' ? <span className="email-action-hold" title="Provider acceptance is unknown. Confirm with Mailtrap before any manual follow-up."><ShieldAlert size={14} /> Review</span>
                : <span className="email-action-none">—</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {legacyRows.length > 0 && <div className="email-legacy-block">
        <div className="email-legacy-heading"><div><strong>Legacy support backlog · held</strong><span>Credentials do not release these messages. Review and requeue each item individually.</span></div><span>{legacyRows.length} held</span></div>
        <div className="email-table-wrap"><table className="email-table">
          <thead><tr><th>Legacy event</th><th>Recipient</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
          <tbody>{legacyRows.map((item) => <tr key={`legacy-${item.id}`}>
            <td><strong>{item.purpose.replaceAll('_', ' ')}</strong><small>{item.eventKey}</small></td>
            <td>{item.recipientEmail}</td><td><Status state="unconfigured" /></td><td>{formatDate(item.createdAt)}</td>
            <td><button type="button" className="email-row-action" disabled={reviewLegacy.isPending} onClick={() => {
              const confirmed = window.confirm(`Review and queue the legacy ${item.purpose.replaceAll('_', ' ')} to ${item.recipientEmail}? Only this selected message will be requeued.`);
              if (confirmed) reviewLegacy.mutate(item);
            }}><RotateCcw size={14} /> Review & queue</button></td>
          </tr>)}</tbody>
        </table></div>
      </div>}
    </section>
  </main>;
}

export default AdminEmailDeliveryPage;