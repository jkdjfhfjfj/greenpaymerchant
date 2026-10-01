import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, CircleHelp, Clock3 } from 'lucide-react';
import { Link } from 'wouter';
import { PlatformBrand, usePlatformBranding } from '@/components/platform-brand';
import { platformOperationalStatus } from './support-api';
import '@/support.css';

function stateIcon(status: string) {
  if (status === 'operational') return <CheckCircle2 size={17} />;
  if (status === 'degraded') return <AlertTriangle size={17} />;
  return <CircleHelp size={17} />;
}

function stateLabel(status: string) {
  return status === 'operational' ? 'Operational' : status === 'degraded' ? 'Degraded' : 'Unavailable';
}

export function PlatformStatusPage() {
  const branding = usePlatformBranding();
  useEffect(() => { document.title = `${branding.platformName} · Platform status`; }, [branding.platformName]);
  const query = useQuery({
    queryKey: ['platform-status'],
    queryFn: () => platformOperationalStatus(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const data = query.data;
  return <main className="support-page platform-status-page">
    <header className="support-public-header"><a href="/" className="support-brand" aria-label={`${branding.platformName} home`} data-testid="link-status-home"><PlatformBrand /></a><Link href="/contact" className="support-header-link" data-testid="link-status-contact">Contact support</Link></header>
    <section className="support-hero status-hero">
      <div className="support-eyebrow"><Activity size={15} /> PLATFORM AVAILABILITY</div>
      <h1>{branding.platformName} platform status</h1>
      <p>Current availability of {branding.platformName}’s core application and platform data services.</p>
    </section>
    <section className="status-card">
      {query.isLoading && <div className="support-skeleton support-skeleton-long" />}
      {query.isError && <div className="support-error-state" role="alert" data-testid="text-platform-status-error"><CircleHelp size={18} /><span>{query.error.message}</span><button type="button" className="support-button support-button-quiet" onClick={() => { void query.refetch(); }} data-testid="button-retry-platform-status">Retry</button></div>}
      {data && <>
        <div className={`status-summary status-${data.status}`} data-testid="status-platform-overall">
          <span>{stateIcon(data.status)}</span><div><span className="support-eyebrow">OVERALL PLATFORM</span><strong>{stateLabel(data.status)}</strong></div>
        </div>
        <div className="status-service-list">
          {data.services.map((service) => <article key={service.name} className="status-service-row" data-testid={`row-platform-service-${service.name.toLowerCase().replaceAll(' ', '-')}`}>
            <span className={`status-service-icon status-${service.status}`}>{stateIcon(service.status)}</span>
            <span className="status-service-copy"><strong>{service.name}</strong><span>{service.description}</span></span>
            <span className={`support-status status-${service.status}`}>{stateLabel(service.status)}</span>
          </article>)}
        </div>
        <div className="status-checked-at"><Clock3 size={14} /><span>Last checked <time dateTime={data.checkedAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.checkedAt))}</time></span></div>
      </>}
    </section>
    <aside className="status-explainer"><strong>Platform status is different from payment status.</strong><span>To check an individual payment, use the payment receipt page and its unique reference. A platform health update cannot confirm whether a particular payment completed.</span></aside>
      <footer className="support-public-footer"><Link href="/" data-testid="link-status-back-home">Back to {branding.platformName}</Link><span>Availability refreshes automatically.</span><a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`}>Powered by {branding.platformName}</a></footer>
  </main>;
}

export default PlatformStatusPage;