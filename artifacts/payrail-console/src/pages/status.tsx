import { useParams } from 'wouter';
import { LockKeyhole } from 'lucide-react';
import { useGetPublicTransactionStatus } from '@workspace/api-client-react';
import { Btn, Pill, fmtDate, money, errMsg } from '@/components/kit';

export function StatusPage() {
  const { reference = '' } = useParams<{ reference: string }>();
  const q = useGetPublicTransactionStatus(reference, { query: { retry: false, queryKey: ['/api/public/status', reference], refetchInterval: (query) => (query.state.data?.status === 'pending' ? 5000 : false) } });
  const t = q.data;
  const copy: Record<string, string> = { pending: 'Your payment is awaiting confirmation. This page refreshes automatically.', success: 'Your payment has been confirmed.', failed: 'This payment was not completed. You can start again from the original link.', cancelled: 'This payment was cancelled.', refunded: 'This payment was refunded.' };
  return <div className="centered-page"><div className="centered-card" data-testid="card-status">
    <div className="brand"><span className="brand-mark"><span /><span /><span /></span><span className="brand-name">greenpay<span>.</span></span></div>
    <div className="eyebrow"><LockKeyhole size={12} />PAYMENT STATUS</div>
    {q.isLoading && <><div className="skeleton-line wide" /><div className="skeleton-line" /></>}
    {q.isError && <><h1>Unable to check payment</h1><p data-testid="text-status-error">{errMsg(q.error)}</p><Btn variant="secondary" onClick={() => { void q.refetch(); }}>Retry</Btn></>}
    {t && <div className="status-big"><Pill value={t.status} /><div className="amt">{money(t.amount, t.currency)}</div><p>{copy[t.status]}</p>
      <div className="kv" style={{ width: '100%', marginTop: 8 }}><div><span>Reference</span><strong className="mono" style={{ fontSize: 12 }}>{t.reference}</strong></div><div><span>Created</span><strong>{fmtDate(t.createdAt)}</strong></div><div><span>Paid</span><strong>{fmtDate(t.paidAt)}</strong></div></div></div>}
  </div></div>;
}

export function AuthSetupScreen() {
  return <div className="centered-page"><div className="centered-card" data-testid="card-auth-setup">
    <div className="brand"><span className="brand-mark"><span /><span /><span /></span><span className="brand-name">greenpay<span>.</span></span></div>
    <div className="eyebrow">SIGN-IN UNAVAILABLE</div>
    <h1>Authentication is not configured</h1>
    <p>This deployment has no Clerk publishable key, so merchant and administrator sign-in cannot start. Public payment links and payment status pages continue to work.</p>
    <p>An operator needs to provide VITE_CLERK_PUBLISHABLE_KEY and reload the app.</p>
  </div></div>;
}
