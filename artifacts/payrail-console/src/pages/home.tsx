import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, BadgeCheck, Banknote, CalendarClock, FileClock, KeyRound, Link2, Percent, Send } from 'lucide-react';
import '@/home.css';

function Mark() {
  return <span className="hp-brand" data-testid="link-home-brand"><span className="hp-mark"><i /><i /><i /></span><span className="hp-word">greenpay<b>.</b></span></span>;
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
  { icon: Link2, title: 'Payment links', text: 'Create a link, share it anywhere, and let customers pay on a clean hosted page. No storefront needed.', id: 'payment-links' },
  { icon: BadgeCheck, title: 'Confirmed tracking', text: 'A transaction is marked paid only once the payment is confirmed. Until then it stays pending, honestly.', id: 'confirmed-tracking' },
  { icon: KeyRound, title: 'Scoped developer access', text: 'Issue API credentials limited to the permissions an integration actually needs, and revoke them any time.', id: 'developer-access' },
  { icon: Percent, title: 'Fees you can read', text: 'Fees are shown against each transaction so finance can reconcile what was charged and why.', id: 'fees' },
  { icon: Send, title: 'Payout history', text: 'Payouts are operated by the Greenpay team on request, with a full history you can review and export to your books.', id: 'payouts' },
  { icon: Banknote, title: 'Exchange quotes', text: 'Request an indicative quote between currencies before you plan around a conversion. Quotes only, never a commitment.', id: 'exchange-quotes' },
];

const steps = [
  { n: '01', t: 'Create a link', d: 'Set an amount and currency, or let the customer choose.' },
  { n: '02', t: 'Customer pays', d: 'They complete payment on a hosted Greenpay page.' },
  { n: '03', t: 'Payment is confirmed', d: 'Status moves from pending only on confirmation.' },
  { n: '04', t: 'Record is kept', d: 'Reference, fee and status land in your transaction list.' },
];

export default function HomePage() {
  return <div className="hp" data-testid="page-home">
    <header className="hp-nav">
      <a href="/" aria-label="Greenpay home"><Mark /></a>
      <nav className="hp-nav-links" aria-label="Primary">
        <a href="#products" data-testid="link-nav-products">Products</a>
        <a href="#how" data-testid="link-nav-how">How it works</a>
        <a href="#records" data-testid="link-nav-records">For finance</a>
        <a href="mailto:support@greenpay.africa" data-testid="link-nav-support">Support</a>
      </nav>
      <div className="hp-nav-cta">
        <a href="/sign-in" className="hp-signin" data-testid="link-sign-in">Sign in</a>
        <a href="/sign-up" className="hp-btn hp-btn-gold" data-testid="link-sign-up-nav">Get started</a>
      </div>
    </header>

    <main>
      <section className="hp-hero">
        <div className="hp-hero-copy">
          <span className="hp-eyebrow"><i />Payments for African businesses</span>
          <h1>Get paid.<br /><em>Keep the receipts.</em></h1>
          <p>Greenpay lets merchants collect payments with simple links, and gives finance teams one clear record of what was paid, what it cost, and what was sent out.</p>
          <div className="hp-actions">
            <a href="/sign-up" className="hp-btn hp-btn-gold hp-btn-lg" data-testid="link-sign-up-hero">Create your account <ArrowRight size={17} /></a>
            <a href="/sign-in" className="hp-btn hp-btn-ghost hp-btn-lg" data-testid="link-sign-in-hero">Sign in</a>
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
        <span>Pending until confirmed</span><span>Scoped API access</span><span>Fees on every record</span><span>Payout history</span>
      </section>

      <section className="hp-section" id="products">
        <Reveal><span className="hp-eyebrow dark"><i />What you get</span><h2>The essentials of getting paid, done carefully.</h2></Reveal>
        <div className="hp-grid">
          {features.map((f, i) => { const Icon = f.icon; return <Reveal key={f.id} delay={i * 60} className={`hp-feature ${i === 0 ? 'hp-feature-big' : ''}`}><div data-testid={`card-feature-${f.id}`}><span className="hp-ico"><Icon size={20} /></span><h3>{f.title}</h3><p>{f.text}</p></div></Reveal>; })}
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
          <div className="hp-note"><CalendarClock size={20} /><div><strong>Settlement timing is a forecast</strong><p>Greenpay shows a T+3 estimate to help you plan. It is a forecast, not a guaranteed settlement date.</p></div></div>
          <div className="hp-note"><Banknote size={20} /><div><strong>Exchange is quote-only</strong><p>Quotes are indicative and help you compare. Requesting one does not convert any funds.</p></div></div>
          <div className="hp-note"><FileClock size={20} /><div><strong>Payouts are admin-operated</strong><p>The Greenpay team processes payouts, and each one is logged in your history.</p></div></div>
        </Reveal>
      </section>

      <section className="hp-cta">
        <Reveal><h2>Ready to collect with a clear paper trail?</h2><div className="hp-actions center"><a href="/sign-up" className="hp-btn hp-btn-gold hp-btn-lg" data-testid="link-sign-up-cta">Create your account <ArrowRight size={17} /></a><a href="mailto:support@greenpay.africa" className="hp-btn hp-btn-ghost hp-btn-lg" data-testid="link-support-cta">Talk to support</a></div></Reveal>
      </section>
    </main>

    <footer className="hp-footer">
      <Mark /><span>Payments for African businesses.</span>
      <div><a href="/sign-in" data-testid="link-footer-sign-in">Sign in</a><a href="/sign-up" data-testid="link-footer-sign-up">Sign up</a><a href="mailto:support@greenpay.africa" data-testid="link-footer-support">Support</a></div>
    </footer>
  </div>;
}
