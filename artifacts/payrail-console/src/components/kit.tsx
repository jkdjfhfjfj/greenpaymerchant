import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleAlert, Copy, Check, X, LoaderCircle } from 'lucide-react';
import { COLLECTION_CURRENCIES } from '@workspace/api-zod';
import { useGetAccessProfile } from '@workspace/api-client-react';

export const CURRENCIES = COLLECTION_CURRENCIES.map(({ code }) => code);
export function currencyMinorUnits(code: string) {
  return COLLECTION_CURRENCIES.find((currency) => currency.code === code.toUpperCase())?.minorUnits ?? 2;
}
export function currencyAmountStep(code: string) {
  return currencyMinorUnits(code) === 0 ? '1' : '0.01';
}
export const COUNTRIES: [string, string][] = [['KE', 'Kenya'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['UG', 'Uganda'], ['TZ', 'Tanzania'], ['RW', 'Rwanda'], ['ZM', 'Zambia'], ['MW', 'Malawi'], ['SN', 'Senegal'], ['CI', "Cote d'Ivoire"], ['CM', 'Cameroon'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['MA', 'Morocco'], ['ET', 'Ethiopia']];

export { formatFinancialAmount as money } from '@/lib/money-format';
export function fmtDate(value?: string | null) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function nice(value?: string | null) { return (value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function errMsg(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    const value = err as Record<string, unknown>;
    for (const key of ['detail', 'message', 'error_description', 'error']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const response = value.response;
    if (response && typeof response === 'object') {
      const data = (response as Record<string, unknown>).data;
      if (data && typeof data === 'object') {
        for (const key of ['detail', 'message', 'error_description', 'error']) {
          const candidate = (data as Record<string, unknown>)[key];
          if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
      }
    }
    if (typeof value.status === 'number') {
      return `The request returned HTTP ${value.status}, but no error message was provided.`;
    }
  }
  return 'No error details were returned. Try again, or share the request details with support.';
}

function errorDiagnostics(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  if (typeof value.status === 'number') details.httpStatus = value.status;
  if (typeof value.statusText === 'string' && value.statusText) details.statusText = value.statusText;
  if (typeof value.method === 'string' && value.method) details.method = value.method;
  if (typeof value.url === 'string' && value.url) {
    details.path = value.url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
  }
  const data = value.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const safeResponse: Record<string, string> = {};
    for (const key of ['title', 'detail', 'message', 'error_description', 'error', 'requestId']) {
      const candidate = (data as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.trim()) safeResponse[key] = candidate.trim();
    }
    if (Object.keys(safeResponse).length) details.response = safeResponse;
  }
  return Object.keys(details).length ? JSON.stringify(details, null, 2) : null;
}

export function useAccess() {
  const q = useGetAccessProfile();
  return { ...q, isAdmin: !!q.data?.isAdmin, merchant: q.data?.merchant ?? null };
}
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function Pill({ value }: { value?: string | null }) {
  const v = (value || 'unknown').toLowerCase();
  const label = v === 'awaiting_review' ? 'Under review' : v === 'reverification_required' ? 'Reverification required' : nice(value);
  return <span className={`status-pill status-${v}`} data-testid={`status-${v}`}><i />{label}</span>;
}
export function Btn({ children, variant = 'primary', className = '', onClick, type = 'button', disabled, testId, small }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; className?: string; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; testId?: string; small?: boolean }) {
  return <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={`btn btn-${variant} ${small ? 'btn-sm' : ''} ${className}`}>{children}</button>;
}
export function Heading({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action && <div>{action}</div>}</div>;
}
export function Card({ title, subtitle, action, children, className = '' }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{(title || action) && <div className="panel-head"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</section>;
}
export function Note({ children, tone = 'ok' }: { children: ReactNode; tone?: 'ok' | 'danger' | 'warn' }) {
  return <div className={`notice ${tone === 'danger' ? 'notice-danger' : tone === 'warn' ? 'warn' : ''}`} role={tone === 'danger' ? 'alert' : 'status'}>{tone === 'ok' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<div>{children}</div></div>;
}
export function Err({ error }: { error: unknown }) {
  if (!error) return null;
  const diagnostics = errorDiagnostics(error);
  return <div className="form-error" role="alert" data-testid="text-error">
    <CircleAlert size={15} />
    <div style={{ minWidth: 0 }}>
      <div>{errMsg(error)}</div>
      {diagnostics && <details style={{ marginTop: 5 }}>
        <summary>Error details</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '5px 0 0' }}>{diagnostics}</pre>
      </details>}
    </div>
  </div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Loading() {
  return <div className="loading-state"><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
}
export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Activity size={18} /></div><strong>{title}</strong><span>{body}</span>{action}</div>;
}
export function Async({ q, empty, emptyTitle = 'Nothing here yet', emptyBody = 'Records will appear here.', emptyAction, children }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown }; empty?: boolean; emptyTitle?: string; emptyBody?: string; emptyAction?: ReactNode; children: ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.isError) return <div className="empty-state" role="alert"><CircleAlert size={20} /><strong>This view could not load</strong><span data-testid="text-load-error">{errMsg(q.error)}</span><Btn variant="secondary" onClick={() => { void q.refetch(); }}>Retry</Btn></div>;
  if (empty) return <Empty title={emptyTitle} body={emptyBody} action={emptyAction} />;
  return <>{children}</>;
}
export function Modal({ title, description, onClose, children, wide }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>;
}
export function Confirm({ title, body, confirmLabel, pending, error, onConfirm, onClose }: { title: string; body: string; confirmLabel: string; pending?: boolean; error?: unknown; onConfirm: () => void; onClose: () => void }) {
  return <Modal title={title} description={body} onClose={onClose}><Err error={error} /><div className="row-actions"><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="danger" disabled={pending} onClick={onConfirm} testId="button-confirm">{pending && <LoaderCircle size={14} className="spin" />}{confirmLabel}</Btn></div></Modal>;
}
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!on)} data-testid={`switch-${label.toLowerCase().replaceAll(' ', '-')}`} />;
}
export function CopyBtn({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyText() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard access is unavailable.');
      }
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    window.setTimeout(() => setStatus('idle'), 2500);
  }
  return <span className="copy-action">
    <Btn variant="secondary" small onClick={() => { void copyText(); }} aria-label={status === 'copied' ? 'Copied to clipboard' : 'Copy to clipboard'}>
      {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}
    </Btn>
    {status === 'failed' && <small role="status">Select the text and copy it manually.</small>}
  </span>;
}
export function Pager({ page, total, perPage, onPage }: { page: number; total: number; perPage: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return <div className="pager"><span>Page {page} of {pages} - {total.toLocaleString()} records</span><Btn variant="secondary" small disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Btn><Btn variant="secondary" small disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Btn></div>;
}
export function Gate({ children, need }: { children: ReactNode; need: 'admin' | 'merchant' }) {
  const a = useAccess();
  if (a.isLoading) return <Loading />;
  if (a.isError) return <Async q={a}>{null}</Async>;
  if (need === 'admin' && !a.isAdmin) return <Empty title="Administrators only" body="Administrator access is assigned by the platform team or provided by a verified server-side ADMIN_EMAILS bootstrap entry." />;
  if (need === 'merchant' && !a.merchant) return <Empty title="Create your merchant profile first" body="This area is available once your business is registered." action={<a className="btn btn-primary" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/merchant`}>Go to onboarding</a>} />;
  return <>{children}</>;
}
