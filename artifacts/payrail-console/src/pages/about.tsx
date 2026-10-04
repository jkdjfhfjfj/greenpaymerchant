import { ArrowRight, BookOpen, Code2, FileCheck2, Globe2 } from 'lucide-react';
import { PlatformBrand, usePlatformBranding } from '@/components/platform-brand';
import './about.css';

export function AboutPage() {
  const { platformName } = usePlatformBranding();

  return <div className="about-page">
    <header className="about-header">
      <a href="/" aria-label={`${platformName} home`}><PlatformBrand variant="home" /></a>
      <nav aria-label="About page navigation">
        <a href="/api-docs">API documentation</a>
        <a href="/learn">Help &amp; FAQs</a>
        <a href="/contact">Contact</a>
        <a className="about-header-cta" href="/sign-up">Create an account</a>
      </nav>
    </header>

    <main className="about-main">
      <div className="about-eyebrow"><Globe2 size={15} /> PAYMENT COLLECTION AND BUSINESS RECORDS</div>
      <h1>About {platformName}</h1>
      <p className="about-lead">{platformName} provides payment collection tools and business-finance records for merchants serving customers across African markets and beyond.</p>

      <section className="about-section" aria-labelledby="about-tools">
        <h2 id="about-tools">Tools for collecting and tracking payments</h2>
        <p>Businesses can create shareable payment links or integrate collections through the {platformName} developer API. The workspace brings transaction references, statuses, fees, invoices, refunds, settlement evidence, and payout records into view.</p>
        <div className="about-feature-grid">
          <article className="about-feature">
            <span><Globe2 size={19} /></span>
            <h3>Markets and currencies</h3>
            <p>The published currency catalog spans 25 African country markets plus global USD payments. Actual collection availability depends on the currency route, payment method, provider configuration, and merchant verification.</p>
          </article>
          <article className="about-feature">
            <span><Code2 size={19} /></span>
            <h3>Payment links and API</h3>
            <p>Merchants can share payment links or use merchant-scoped API keys from a trusted backend. The public reference explains authentication, collection readiness, payment status, and signed webhooks.</p>
          </article>
          <article className="about-feature">
            <span><FileCheck2 size={19} /></span>
            <h3>Clear financial records</h3>
            <p>Greenpay distinguishes a confirmed payment from a pending request, a settlement forecast from verified wallet funding, and a refund request from money returned to a customer.</p>
          </article>
        </div>
      </section>

      <section className="about-section about-records" aria-labelledby="about-records-heading">
        <div className="about-records-icon"><BookOpen size={21} /></div>
        <div>
          <h2 id="about-records-heading">Records are tied to what has been confirmed</h2>
          <p>A payment is not treated as confirmed just because it was requested. Greenpay records provider-confirmed outcomes, keeps settlement estimates distinct from reconciled funds, and shows payment, invoice, refund, and payout states separately.</p>
          <a href="/learn">Read Greenpay help and payment FAQs <ArrowRight size={15} /></a>
        </div>
      </section>

      <section className="about-cta" aria-labelledby="about-next-steps">
        <div>
          <h2 id="about-next-steps">Learn more about Greenpay</h2>
          <p>Explore the public API reference, or contact support with questions about the platform.</p>
        </div>
        <div className="about-cta-links">
          <a href="/api-docs">Read the API docs <ArrowRight size={15} /></a>
          <a href="/contact">Contact Greenpay <ArrowRight size={15} /></a>
        </div>
      </section>
    </main>

    <footer className="about-footer">
      <a href="/">Greenpay home</a>
      <a href="/api-docs">API documentation</a>
      <a href="/contact">Contact</a>
      <a href="/sign-in">Sign in</a>
    </footer>
  </div>;
}

export default AboutPage;