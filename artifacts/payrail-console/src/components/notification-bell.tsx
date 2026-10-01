import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Bell, CircleDollarSign, MessageCircle, ShieldCheck, Wallet } from 'lucide-react';
import { formatSupportDate, markAllUserNotificationsRead, markUserNotificationRead, userNotifications, type UserNotification } from '@/pages/support-api';
import '@/support.css';

function notificationIcon(type: UserNotification['type']) {
  if (type === 'support_reply') return <MessageCircle size={15} />;
  if (type === 'kyc_update') return <ShieldCheck size={15} />;
  if (type === 'payment_confirmed') return <CircleDollarSign size={15} />;
  return <Wallet size={15} />;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => userNotifications(),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });
  const markRead = useMutation({
    mutationFn: (id: number) => markUserNotificationRead(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['notifications'] }); },
  });
  const markAll = useMutation({
    mutationFn: () => markAllUserNotificationsRead(),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['notifications'] }); },
  });
  const unread = notifications.data?.unreadCount ?? 0;

  return <div className="notification-bell-wrap">
    <button type="button" className="notification-bell-button" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="button-notification-bell">
      <Bell size={17} />
      {unread > 0 && <span className="notification-bell-badge" data-testid="badge-notification-unread">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="notification-popover" role="dialog" aria-label="Notifications" data-testid="panel-notification-bell">
      <header><div><strong>Notifications</strong><span>{unread ? `${unread} unread` : 'You’re all caught up'}</span></div>
        {unread > 0 && <button type="button" onClick={() => markAll.mutate()} disabled={markAll.isPending} data-testid="button-notification-mark-all">Mark all read</button>}
      </header>
      {notifications.isLoading && <p className="notification-popover-empty">Loading your notifications…</p>}
      {notifications.isError && <div className="notification-popover-error" role="alert">{notifications.error.message}<button type="button" onClick={() => { void notifications.refetch(); }}>Retry</button></div>}
      {!notifications.isLoading && !notifications.isError && notifications.data?.items.length === 0 && <p className="notification-popover-empty">Updates from support, verification, payments, and payouts will appear here.</p>}
      <div className="notification-popover-list">
        {notifications.data?.items.slice(0, 8).map((item) => <Link key={item.id} href={item.href} className={`notification-popover-item ${item.readAt ? '' : 'is-unread'}`} onClick={() => { if (!item.readAt) markRead.mutate(item.id); setOpen(false); }} data-testid={`link-notification-${item.id}`}>
          <span className="notification-popover-icon">{notificationIcon(item.type)}</span>
          <span className="notification-popover-copy"><strong>{item.title}</strong><span>{item.body}</span><time>{formatSupportDate(item.createdAt)}</time></span>
          {!item.readAt && <i className="notification-unread-dot" />}
        </Link>)}
      </div>
      {notifications.data?.items.length ? <Link href="/notifications" className="notification-popover-footer" onClick={() => setOpen(false)} data-testid="link-all-notifications">View all notifications</Link> : null}
    </div>}
  </div>;
}

export default NotificationBell;