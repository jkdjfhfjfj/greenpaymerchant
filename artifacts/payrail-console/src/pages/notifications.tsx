import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowRight, Bell, CheckCheck, CircleDollarSign, MessageCircle, ShieldCheck, Wallet } from 'lucide-react';
import { formatSupportDate, markAllUserNotificationsRead, markUserNotificationRead, userNotifications, type UserNotification } from './support-api';
import '@/support.css';

function noticeIcon(type: UserNotification['type']) {
  if (type === 'support_reply') return <MessageCircle size={17} />;
  if (type === 'kyc_update') return <ShieldCheck size={17} />;
  if (type === 'payment_confirmed') return <CircleDollarSign size={17} />;
  return <Wallet size={17} />;
}

export function NotificationsPage() {
  useEffect(() => { document.title = 'Notifications · Greenpay'; }, []);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => userNotifications(),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });
  const markOne = useMutation({
    mutationFn: (id: number) => markUserNotificationRead(id),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['notifications'] }); },
  });
  const markAll = useMutation({
    mutationFn: () => markAllUserNotificationsRead(),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['notifications'] }); },
  });

  return <main className="support-page notifications-page">
    <header className="support-app-header"><div><a href="/" className="support-brand" data-testid="link-notifications-home">greenpay<span>.</span></a><span className="support-header-divider">/</span><strong>Notifications</strong></div><Link href="/support" className="support-header-link" data-testid="link-notifications-support">Support center <ArrowRight size={14} /></Link></header>
    <section className="support-heading-row notification-heading">
      <div><div className="support-eyebrow"><Bell size={14} /> YOUR UPDATES</div><h1>Notifications</h1><p>Persistent updates from your account, support conversations, payments, and payouts.</p></div>
      {!!query.data?.unreadCount && <button className="support-button support-button-quiet" type="button" onClick={() => markAll.mutate()} disabled={markAll.isPending} data-testid="button-mark-all-notifications"><CheckCheck size={15} />Mark all as read</button>}
    </section>
    {query.isLoading && <div className="support-card support-skeleton-card"><div className="support-skeleton" /><div className="support-skeleton support-skeleton-long" /></div>}
    {query.isError && <div className="support-card support-error-state" role="alert" data-testid="text-notifications-error"><p>{query.error.message}</p><button type="button" className="support-button support-button-quiet" onClick={() => { void query.refetch(); }} data-testid="button-retry-notifications">Retry</button></div>}
    {query.data && query.data.items.length === 0 && <div className="support-card notification-empty" data-testid="empty-notifications"><span className="support-empty-mark"><Bell size={22} /></span><h2>No notifications yet</h2><p>When something needs your attention, it will show up here.</p></div>}
    {query.data && query.data.items.length > 0 && <section className="support-card notification-list" aria-label="Your notifications" data-testid="list-notifications">
      {query.data.items.map((item) => <Link key={item.id} href={item.href} className={`notification-row ${item.readAt ? '' : 'is-unread'}`} onClick={() => { if (!item.readAt) markOne.mutate(item.id); }} data-testid={`link-notification-row-${item.id}`}>
        <span className="notification-row-icon">{noticeIcon(item.type)}</span>
        <span className="notification-row-content"><strong>{item.title}</strong><span>{item.body}</span><time>{formatSupportDate(item.createdAt)}</time></span>
        {!item.readAt && <span className="notification-row-unread">Unread</span>}
        <ArrowRight size={16} className="notification-row-arrow" />
      </Link>)}
    </section>}
  </main>;
}

export default NotificationsPage;