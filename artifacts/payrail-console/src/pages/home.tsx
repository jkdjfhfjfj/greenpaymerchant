import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, BadgeCheck, Banknote, CalendarClock, FileClock, KeyRound, Link2, Percent, Send } from 'lucide-react';
import { useGetPublicPricing, useListPublicFxRates, useListSupportedCurrencies } from '@workspace/api-client-react';
import '@/home.css';
import { money } from '@/components/kit';
import { PlatformBrand, usePlatformBranding } from '@/components/platform-brand';
import { collectionMethodDisplayOptions } from '@/lib/collection-method-display';

function Mark() {
  return <PlatformBrand variant="home" />;
}

function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { el.classList.add('in'); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { el.classList.add('in'); io.disconnect(); } }), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`hp-reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>;
}

const features = [
  { icon: Link2, title: 'Payment links', text: 'Create a link, share it anywhere, and let customers pay with methods available in their currency. No storefront needed.', id: 'payment-links' },
  { icon: BadgeCheck, title: 'Confirmed tracking', text: 'A transaction is marked paid only once the payment is confirmed. Until then it stays pending, honestly.', id: 'confirmed-tracking' },
  { icon: KeyRound, title: 'Payments API', text: 'Create payment links, start collections, read transaction status, and receive signed webhooks through scoped API access.', id: 'developer-access' },
  { icon: Percent, title: 'Fees you can read', text: 'Fees are shown against each transaction so finance can reconcile what was charged and why.', id: 'fees' },
  { icon: Send, title: 'Payout requests', text: 'Request payouts in provider-supported currencies and methods. Availability, minimums, and fees vary; requests go through review.', id: 'payouts' },
  { icon: Banknote, title: 'Wallet conversion', text: 'Review the live reference rate, system margin and fee before moving funded balances between supported wallets.', id: 'wallet-conversion' },
];

const MARKET_COUNTRIES: Record<string, string[]> = {
  KES: ['Kenya'],
  NGN: ['Nigeria'],
  GHS: ['Ghana'],
  TZS: ['Tanzania'],
  XOF: ['Benin', 'Burkina Faso', "Côte d'Ivoire", 'Guinea-Bissau', 'Mali', 'Niger', 'Senegal', 'Togo'],
  RWF: ['Rwanda'],
  UGX: ['Uganda'],
  ZMW: ['Zambia'],
  MWK: ['Malawi'],
  SLL: ['Sierra Leone'],
  CDF: ['Democratic Republic of the Congo'],
  MZN: ['Mozambique'],
  XAF: ['Cameroon', 'Central African Republic', 'Chad', 'Republic of the Congo', 'Equatorial Guinea', 'Gabon'],
  USD: ['Global'],
};

function formatFxRate(rate: number) {
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 7 }).format(rate);
}

function formatFxDate(value?: Date | string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

const steps = [
  { n: '01', t: 'Create a link', d: 'Set an amount and currency, or let the customer choose.' },
  { n: '02', t: 'Customer chooses a method', d: 'They use an available local payment option, or pay in USD worldwide.' },
  { n: '03', t: 'Payment is confirmed', d: 'Status moves from pending only on confirmation.' },
  { n: '04', t: 'Record is kept', d: 'Reference, fee and status land in your transaction list.' },
];

export default function HomePage() {
  const branding = usePlatformBranding();
  const supportedCurrencies = useListSupportedCurrencies();
  const publicPricing = useGetPublicPricing();
  const publicFxRates = useListPublicFxRates({
    query: { queryKey: ['public-fx-rates'], refetchInterval: 5 * 60 * 1000, staleTime: 60 * 1000, retry: false },
  });
  const currencies = supportedCurrencies.data?.items ?? [];
  const fxRatesByCurrency = new Map((publicFxRates.data?.items ?? []).map((item) => [item.currency, item]));
  const marketRows = currencies.map((currency) => ({
    countries: MARKET_COUNTRIES[currency.code] ?? ['International'],
    currency: currency.code,
    name: currency.name,
    methods: currency.paymentMethods.map((method) => ({
      labels: collectionMethodDisplayOptions(currency.code, method.id),
      ready: method.ready,
    })),
    comingSoon: currency.comingSoon,
    collectionReady: currency.collectionReady,
  }));
  const rateRows = currencies.map((currency) => ({
    currency: currency.code,
    name: currency.name,
    rate: currency.code === 'USD' ? 1 : fxRatesByCurrency.get(currency.code)?.rate ?? null,
    sourceDate: fxRatesByCurrency.get(currency.code)?.sourceDate,
  }));
  useEffect(() => {
    const title = `${branding.platformName} | Payment collection and business finance records`;
    const description = `${branding.platformName} helps businesses collect payments across African markets with payment links and a developer API, then review confirmed transactions, fees and payout records.`;
    const publicBase = import.meta.env.VITE_PUBLIC_SITE_URL?.trim() || 'https://greenpay.co.ke';
    const canonicalUrl = new URL('/', `${publicBase.replace(/\/$/, '')}/`).toString();
    document.title = title;
    const setMeta = (selector: string, attribute: 'name' | 'property', key: string, content: string) => {
      let element = document.querySelector<HTMLMetaElement>(selector);
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attribute, key);
        document.head.append(element);
      }
      element.content = content;
    };
    setMeta('meta[name="description"]', 'name', 'description', description);
    setMeta('meta[name="robots"]', 'name', 'robots', 'index, follow');
    setMeta('meta[property="og:title"]', 'property', 'og:title', title);
    setMeta('meta[property="og:description"]', 'property', 'og:description', description);
    setMeta('meta[property="og:url"]', 'property', 'og:url', canonicalUrl);
    setMeta('meta[property="og:type"]', 'property', 'og:type', 'website');
    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title);
    setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description);
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = canonicalUrl;
  }, [branding.platformName]);
  return <div className="hp" data-testid="page-home">
    <header className="hp-nav">
      <a href="/" aria-label={`${branding.platformName} home`}><Mark /></a>
      <nav className="hp-nav-links" aria-label="Primary">
        <a href="#products" data-testid="link-nav-products">Products</a>
        <a href="#coverage-pricing" data-testid="link-nav-coverage">Markets & pricing</a>
        <a href="/api-docs" data-testid="link-nav-api-docs">API docs</a>
        <a href="#how" data-testid="link-nav-how">How it works</a>
          <a href="#records" data-testid="link-nav-records">For finance</a>
          <a href="/learn" data-testid="link-nav-help">Help & FAQs</a>
          <a href="/guides" data-testid="link-nav-guides">Guides</a>
          <a href="/articles">Articles</a>
        <a href="/about" data-testid="link-nav-about">About</a>
        <a href="/contact" data-testid="link-nav-support">Contact</a>
        <a href="/platform-status" data-testid="link-nav-platform-status">Platform status</a>
      </nav>
      <div className="hp-nav-cta">
        <a href="/sign-in" className="hp-signin" data-testid="link-sign-in">Sign in</a>
        <a href="/sign-up" className="hp-btn hp-btn-gold" data-testid="link-sign-up-nav">Get started</a>
      </div>
    </header>

    <main>
      <section className="hp-hero">
        <div className="hp-hero-copy">
          <span className="hp-eyebrow"><i />African markets. Global USD. Developer API.</span>
          <h1>Collect across Africa.<br /><em>Build for global business.</em></h1>
          <p>{branding.platformName}'s currency catalog spans 25 African country markets plus global USD payments. Create payment links or integrate through our API; live collection availability varies by currency and merchant verification.</p>
          <div className="hp-actions">
            <a href="/sign-up" className="hp-btn hp-btn-gold hp-btn-lg" data-testid="link-sign-up-hero">Create your account <ArrowRight size={17} /></a>
            <a href="/api-docs" className="hp-btn hp-btn-ghost hp-btn-lg" data-testid="link-api-docs-hero">Explore API docs <ArrowUpRight size={17} /></a>
          </div>
        </div>

        <div className="hp-hero-art" aria-hidden="true">
          <div className="hp-orb hp-orb-a" /><div className="hp-orb hp-orb-b" />
          <div className="hp-card hp-card-link">
            <div className="hp-card-top"><span>Payment link</span><em>Illustration</em></div>
            <strong>Invoice settlement</strong>
            <div className="hp-line w80" /><div className="hp-line w55" />
            <div className="hp-fake-btn">Pay now</div>
          </div>
          <div className="hp-card hp-card-ledger">
            <div className="hp-card-top"><span>Transaction record</span><em>Illustration</em></div>
            {[['Reference', 'GP-••••••'], ['Status', 'Awaiting confirmation'], ['Fee', 'Shown per transaction']].map(([k, v]) => <div className="hp-row" key={k}><span>{k}</span><b>{v}</b></div>)}
          </div>
          <div className="hp-chip"><i />Pending until confirmed</div>
        </div>
      </section>

      <section className="hp-strip" aria-label="Principles">
        <span>Pending until confirmed</span><span>Developer API</span><span>Fees on every record</span><span>Reviewed payout requests</span>
      </section>

      <section className="hp-section" id="products">
        <Reveal><span className="hp-eyebrow dark"><i />What you get</span><h2>The essentials of getting paid, done carefully.</h2></Reveal>
        <div className="hp-grid">
          {features.map((f, i) => { const Icon = f.icon; return <Reveal key={f.id} delay={i * 60} className={`hp-feature ${i === 0 ? 'hp-feature-big' : ''}`}><div data-testid={`card-feature-${f.id}`}><span className="hp-ico"><Icon size={20} /></span><h3>{f.title}</h3><p>{f.text}</p></div></Reveal>; })}
        </div>
      </section>

      <section className="hp-section hp-api-section" id="api">
        <div className="hp-api-layout">
          <Reveal>
            <span className="hp-eyebrow dark"><i />For developers</span>
            <h2>Integrate payments into your product.</h2>
            <p className="hp-section-intro">Use merchant-scoped keys to create payment links and collections, read transaction records, and verify signed webhook events. The API reference is public; API access requires an account.</p>
            <div className="hp-actions">
              <a href="/api-docs" className="hp-btn hp-btn-gold" data-testid="link-api-docs-section">Read public API docs <ArrowRight size={16} /></a>
              <a href="/sign-up" className="hp-link" data-testid="link-api-access-section">Get API access <ArrowUpRight size={16} /></a>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="hp-api-sample" aria-label="Example payment link API request">
              <span>PAYMENT LINK REQUEST</span>
              <pre>{`POST /api/v1/payment-links
Authorization: Bearer $GREENPAY_API_KEY
Content-Type: application/json

{
  "name": "Invoice 1042",
  "amountType": "fixed",
  "amount": 10,
  "currency": "USD"
}`}</pre>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="hp-section hp-coverage" id="coverage-pricing">
        <Reveal>
          <span className="hp-eyebrow dark"><i />Coverage and pricing</span>
          <h2>Supported currencies, current exchange rates and default fees.</h2>
          <p className="hp-section-intro">Every supported currency is listed below, including currencies that are not currently enabled for collections. Availability depends on provider configuration and merchant verification.</p>
        </Reveal>
        <div className="hp-coverage-layout">
          <div className="hp-coverage-card">
            <div className="hp-coverage-card-head"><div><span className="hp-eyebrow dark"><i />Supported catalog</span><h3>Countries, currencies and methods</h3></div></div>
            {supportedCurrencies.isLoading && <p className="hp-muted">Loading the supported currency catalog…</p>}
            {supportedCurrencies.isError && <p className="hp-error">Coverage is temporarily unavailable. Please try again later.</p>}
            {!supportedCurrencies.isLoading && !supportedCurrencies.isError && marketRows.length === 0 && <p className="hp-muted">No supported currencies are currently listed.</p>}
            {!!marketRows.length && <div className="hp-market-list" data-testid="list-live-collection-markets">
              <div className="hp-market-row hp-market-header" aria-hidden="true"><span>Market</span><span>Currency</span><span>Payment method</span><span>Status</span></div>
              {marketRows.map((row) => <div className="hp-market-row" key={row.currency}>
                <div className="hp-market-country"><strong>{row.countries.join(', ')}</strong><small>{row.name}</small></div>
                <span className="hp-market-code">{row.currency}</span>
              <div className="hp-market-methods">{row.methods.flatMap((method) => method.labels.map((label) => <span className={`hp-method-tag${method.ready ? ' ready' : ''}`} key={`${row.currency}-${label}`}>{label}</span>))}</div>
                <span className={`hp-market-status ${row.comingSoon ? 'soon' : row.collectionReady ? 'ready' : 'inactive'}`}>
                  {row.comingSoon ? 'Coming soon' : row.collectionReady ? 'Available' : 'Not active'}
                </span>
              </div>)}
            </div>}
            <p className="hp-footnote">USD is available globally. Local payment options vary by currency; merchant verification and transaction limits can also affect availability.</p>
          </div>

          <div className="hp-coverage-card hp-pricing-card">
            <span className="hp-eyebrow dark"><i />Default fees</span>
            <h3>Pricing you can review</h3>
            {publicPricing.isLoading && <p className="hp-muted">Loading published default pricing…</p>}
            {publicPricing.isError && <p className="hp-error">Default pricing is temporarily unavailable. Please sign in to review your account terms.</p>}
            {publicPricing.data?.globalSchedule ? <>
              <div className="hp-price-line"><span>Collection percentage</span><strong>{publicPricing.data.globalSchedule.percentage}%</strong></div>
              <div className="hp-price-line"><span>Flat fee</span><strong>{money(publicPricing.data.globalSchedule.flatAmount, publicPricing.data.globalSchedule.currency)}</strong></div>
              <div className="hp-price-line"><span>Default FX schedule markup</span><strong>{publicPricing.data.globalSchedule.fxMarkupBps} bps</strong></div>
              <p className="hp-footnote">This is the global default. {publicPricing.data.customSchedulesMayDiffer ? 'Merchant-specific pricing may differ; your account schedule is shown before you collect.' : ''} Wallet conversions show their system margin and fee before confirmation.</p>
            </> : publicPricing.data && <p className="hp-muted">A public default fee schedule has not been published. Sign in or contact the Greenpay team for your account pricing.</p>}
          </div>

          <div className="hp-coverage-card hp-rates-card">
            <span className="hp-eyebrow dark"><i />Live reference rates</span>
            <h3>Currency rates against USD</h3>
            {publicFxRates.isLoading && <p className="hp-muted">Loading current reference rates…</p>}
            {publicFxRates.isError && <p className="hp-error">Live reference rates are temporarily unavailable. The currency catalog remains available above.</p>}
            {publicFxRates.data && <div className="hp-rate-list" data-testid="list-live-fx-rates">
              <div className="hp-rate-row hp-rate-header" aria-hidden="true"><span>Currency</span><span>Units per 1 USD</span><span>Updated</span></div>
              {rateRows.map((row) => <div className="hp-rate-row" key={row.currency}>
                <span className="hp-rate-code">{row.currency}</span>
                <strong>{row.rate === null ? '—' : formatFxRate(row.rate)}</strong>
                <span className="hp-rate-updated">{formatFxDate(row.sourceDate)}</span>
              </div>)}
            </div>}
            <p className="hp-footnote">Indicative market references, not a payment or settlement quote. Rates are refreshed from their sources and may differ from wallet conversion rates after margin and fees. SLL is withheld until its denomination scale is verified.</p>
          </div>
        </div>
      </section>

      <section className="hp-dark" id="how">
        <Reveal><span className="hp-eyebrow"><i />How a payment travels</span><h2>From link to record, in four honest steps.</h2></Reveal>
        <ol className="hp-steps">
          {steps.map((s, i) => <li key={s.n}><Reveal delay={i * 90}><span className="hp-n">{s.n}</span><h3>{s.t}</h3><p>{s.d}</p></Reveal></li>)}
        </ol>
      </section>

      <section className="hp-section hp-records" id="records">
        <Reveal className="hp-records-copy"><span className="hp-eyebrow dark"><i />For finance teams</span><h2>Books that match what actually happened.</h2><p>Every transaction carries its reference, status and fee. Payouts are recorded in a history your team can read back at month end, without chasing screenshots.</p><a href="/sign-up" className="hp-link" data-testid="link-sign-up-records">Open an account <ArrowUpRight size={16} /></a></Reveal>
        <Reveal delay={120} className="hp-notes">
          <div className="hp-note"><CalendarClock size={20} /><div><strong>Settlement timing is a forecast</strong><p>The platform shows a T+3 estimate to help you plan. It is a forecast, not a guaranteed settlement date.</p></div></div>
          <div className="hp-note"><Banknote size={20} /><div><strong>Wallet FX is internal</strong><p>Wallet conversions show the rate, system margin and fees before confirmation. They reallocate funded balances and do not settle external bank FX.</p></div></div>
          <div className="hp-note"><FileClock size={20} /><div><strong>Payouts are team-operated</strong><p>The {branding.platformName} team processes payouts, and each one is logged in your history.</p></div></div>
        </Reveal>
      </section>

      <section className="hp-section hp-help">
        <Reveal><span className="hp-eyebrow dark"><i />Clear answers</span><h2>Requests, forecasts and confirmed money are not the same thing.</h2><p>Greenpay help explains when a receipt is confirmed, what a verified settlement wallet balance means, how invoices differ from payment records, and why a refund request is not proof of reimbursement.</p><div className="hp-help-links"><a href="/learn">Browse payment FAQs <ArrowRight size={15} /></a><a href="/guides">Read Greenpay guides <ArrowRight size={15} /></a><a href="/articles">Explore articles <ArrowRight size={15} /></a></div></Reveal>
      </section>

      <section className="hp-cta">
        <Reveal><h2>Ready to collect with a clear paper trail?</h2><div className="hp-actions center"><a href="/sign-up" className="hp-btn hp-btn-gold hp-btn-lg" data-testid="link-sign-up-cta">Create your account <ArrowRight size={17} /></a><a href="/contact" className="hp-btn hp-btn-ghost hp-btn-lg" data-testid="link-support-cta">Talk to support</a></div></Reveal>
      </section>
    </main>

    <footer className="hp-footer">
      <Mark /><span>Payments for businesses, backed by clear records.</span>
      <div><a href="/api-docs" data-testid="link-footer-api-docs">API docs</a><a href="/learn" data-testid="link-footer-help">Help & FAQs</a><a href="/guides">Guides</a><a href="/articles">Articles</a><a href="/about">About Greenpay</a><a href="/sign-in" data-testid="link-footer-sign-in">Sign in</a><a href="/sign-up" data-testid="link-footer-sign-up">Sign up</a><a href="/contact" data-testid="link-footer-support">Contact</a><a href="/platform-status" data-testid="link-footer-platform-status">Platform status</a><a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`}>Powered by {branding.platformName}</a></div>
    </footer>
  </div>;
}
