import { useEffect } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Check, CircleAlert, LockKeyhole, ShieldCheck } from 'lucide-react';
import './_group.css';
import './Reorganized.css';

const currencies = [
  ['US Dollar', 'USD', '2'], ['Kenyan Shilling', 'KES', '0'], ['Nigerian Naira', 'NGN', '2'],
  ['Ghanaian Cedi', 'GHS', '2'], ['Tanzanian Shilling', 'TZS', '2'], ['West African CFA Franc', 'XOF', '0'],
  ['Rwandan Franc', 'RWF', '0'], ['Ugandan Shilling', 'UGX', '0'], ['Zambian Kwacha', 'ZMW', '2'],
  ['Malawian Kwacha', 'MWK', '2'], ['Sierra Leonean Leone', 'SLL', '2'], ['Congolese Franc', 'CDF', '2'],
  ['Mozambican Metical', 'MZN', '2'], ['Central African CFA Franc', 'XAF', '0'],
];

const navItems = [
  ['Start here', 'start-here'],
  ['Authentication', 'authentication'],
  ['Endpoints & scopes', 'endpoints'],
  ['Create a collection', 'collections'],
  ['Currency catalog', 'currencies'],
  ['Payment safety', 'payment-safety'],
  ['Webhooks', 'webhooks'],
  ['Payouts', 'payouts'],
  ['Responses', 'responses'],
];

function Brand() {
  return <span className="rd-brand">
    <span className="rd-mark" aria-hidden="true"><i /><i /><i /></span>
    <span>Greenpay</span>
  </span>;
}

function Code({ children }: { children: string }) {
  return <code className="rd-inline-code">{children}</code>;
}

function SectionHeading({ number, eyebrow, title, intro }: { number: string; eyebrow: string; title: string; intro: string }) {
  return <div className="rd-section-heading">
    <span className="rd-section-number">{number}</span>
    <div>
      <div className="rd-kicker">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{intro}</p>
    </div>
  </div>;
}

function Snippet({ label, children }: { label: string; children: string }) {
  return <div className="rd-snippet">
    <div className="rd-snippet-label"><span>{label}</span><span className="rd-language">HTTP</span></div>
    <pre>{children}</pre>
  </div>;
}

export function Reorganized() {
  useEffect(() => {
    document.title = 'Greenpay API documentation';
    const description = 'A practical guide to Greenpay collections, payment confirmation, webhooks, currencies and payouts.';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.append(meta);
    }
    meta.content = description;
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    if (!targetId) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return <div className="public-api-docs rd-docs">
    <header className="public-api-header rd-header">
      <a href="/" aria-label="Greenpay home"><Brand /></a>
      <nav aria-label="Main navigation">
        <a href="/#coverage-pricing">Markets</a>
        <a href="/sign-in">Sign in</a>
        <a className="public-api-signup" href="/sign-up">Get started <ArrowUpRight size={14} /></a>
      </nav>
    </header>

    <main className="rd-main">
      <div className="rd-breadcrumb"><BookOpen size={14} /><span>Developers</span><span className="rd-slash">/</span><span>API reference</span></div>
      <section className="rd-intro" id="start-here">
        <div className="rd-intro-copy">
          <div className="rd-kicker"><span className="rd-kicker-line" />PUBLIC API DOCUMENTATION</div>
          <h1>Payments, with<br /><em>the important parts</em> clear.</h1>
          <p className="rd-lede">Connect your backend to Greenpay collection flows across African markets. Start with a read-only check, confirm your route, then build around verified payment evidence.</p>
          <div className="rd-intro-links">
            <a className="rd-primary-link" href="#authentication">Read the integration guide <ArrowRight size={15} /></a>
            <a className="rd-text-link" href="#endpoints">Browse endpoints <ArrowDownRight size={15} /></a>
          </div>
        </div>
        <aside className="rd-deployment-card" aria-label="Deployment information">
          <div className="rd-deployment-top"><span className="rd-deployment-symbol"><LockKeyhole size={16} /></span><span>Before you connect</span></div>
          <p>This deployment has <strong>no separate public sandbox hostname.</strong></p>
          <div className="rd-deployment-rule" />
          <p>A payment creation request may initiate a real collection. Use read-only checks first.</p>
          <span className="rd-deployment-foot">DEPLOYMENT-SPECIFIC ROUTES</span>
        </aside>
      </section>

      <div className="rd-alert" role="note">
        <CircleAlert size={18} />
        <p><strong>Keep credentials on your server.</strong> API keys belong in trusted server-side secret storage—never in browser JavaScript, HTML, public build variables, or mobile code.</p>
        <a href="/sign-in">API access <ArrowUpRight size={13} /></a>
      </div>

      <div className="rd-layout">
        <aside className="rd-toc" aria-label="On this page">
          <div className="rd-toc-title">IN THIS GUIDE <span>09</span></div>
          <nav>
            {navItems.map(([label, id], index) => <a href={`#${id}`} key={id}><span className="rd-toc-index">0{index + 1}</span>{label}</a>)}
          </nav>
          <div className="rd-toc-help">Building an integration?<br /><a href="#collections">Follow the collection path <ArrowRight size={12} /></a></div>
        </aside>

        <div className="rd-content">
          <section className="rd-doc-section" id="authentication">
            <SectionHeading number="01" eyebrow="CONNECTION" title="Authenticate from your backend" intro="Every merchant API request uses this deployment’s API host and a merchant-scoped bearer key." />
            <Snippet label="Request headers">{`Base URL: https://<your-greenpay-host>/api
Authorization: Bearer <merchant API key>
Content-Type: application/json`}</Snippet>
            <div className="rd-two-col">
              <div className="rd-detail-block">
                <h3>Keep the key private</h3>
                <p>Create and manage keys after sign-in. Put the secret in a server-side secret manager; your own backend attaches it when it calls Greenpay.</p>
              </div>
              <div className="rd-detail-block">
                <h3>Do not infer the environment</h3>
                <p>A <Code>gp_live_</Code> prefix is not proof of whether a payment route is in test or live mode. Confirm route configuration with your operator before testing collections.</p>
              </div>
            </div>
          </section>

          <section className="rd-doc-section" id="endpoints">
            <SectionHeading number="02" eyebrow="REFERENCE" title="Endpoints & scopes" intro="Keys are bound to one merchant. Grant only the scopes your integration needs." />
            <div className="rd-scope-list">
              <div className="rd-scope-row"><span className="rd-scope-tag">read</span><div><strong>Merchant and transaction reads</strong><p><Code>GET /v1/merchant</Code><Code>GET /v1/payment-links</Code><Code>GET /v1/transactions</Code><Code>GET /v1/transactions/:reference</Code><Code>GET /v1/fx-quote</Code><Code>GET /v1/fees</Code></p></div></div>
              <div className="rd-scope-row"><span className="rd-scope-tag">payment_links:write</span><div><strong>Create a shareable link</strong><p><Code>POST /v1/payment-links</Code> creates a merchant-owned link; it does not itself charge a customer.</p></div></div>
              <div className="rd-scope-row"><span className="rd-scope-tag">payments:write</span><div><strong>Start and verify a collection</strong><p><Code>POST /v1/transactions</Code> starts a payment. <Code>POST /v1/transactions/:reference/verify</Code> refreshes provider status.</p></div></div>
              <div className="rd-scope-row"><span className="rd-scope-tag rd-scope-public">no key</span><div><strong>Customer-safe public reads</strong><p><Code>GET /public/transactions/:reference</Code> and <Code>GET /public/fx-rates</Code> do not require a bearer key.</p></div></div>
            </div>
            <p className="rd-footnote">The public transaction response is limited to reference, status, amount, currency, timestamps and public shop identity. Customer contact and internal provider data are not exposed.</p>
          </section>

          <section className="rd-doc-section" id="collections">
            <SectionHeading number="03" eyebrow="COLLECTION FLOW" title="Create a payment safely" intro="The browser can collect checkout details. Your server owns the amount, API key and payment request." />
            <ol className="rd-steps">
              <li><span>01</span><div><strong>Check this deployment’s currency response</strong><p>Read <Code>GET /currencies</Code>. Offer a currency only when <Code>collectionReady</Code> and a returned <Code>paymentMethods[].ready</Code> are both true. Catalog presence alone is not route readiness.</p></div></li>
              <li><span>02</span><div><strong>Build the request on your server</strong><p>Use a key with <Code>payments:write</Code>. Calculate the order amount server-side and use the returned method <Code>id</Code> as <Code>paymentMethod</Code>.</p></div></li>
              <li><span>03</span><div><strong>Continue checkout</strong><p>Redirect to <Code>checkoutUrl</Code> when returned. <Code>mobile_prompt</Code> requires <Code>customerPhone</Code> and may return no checkout URL.</p></div></li>
              <li><span>04</span><div><strong>Confirm evidence before fulfilment</strong><p>Save the transaction reference. Treat <Code>pending</Code> as unpaid; match confirmed reference, amount and currency to the order.</p></div></li>
            </ol>
            <Snippet label="Example · server request">{`POST /api/v1/transactions
Authorization: Bearer $GREENPAY_API_KEY
Idempotency-Key: order-1042-attempt-1
Content-Type: application/json

{"amount":10,"currency":"USD","paymentMethod":"hosted_checkout","customerEmail":"buyer@example.com"}`}</Snippet>
            <div className="rd-inline-warning"><ShieldCheck size={17} /><p><strong>Real collection risk:</strong> Greenpay has no separate public sandbox hostname. A payment <Code>POST</Code> may initiate a real collection. Use read-only checks for connectivity and test only after confirming the selected route is configured for test mode.</p></div>
          </section>

          <section className="rd-doc-section" id="currencies">
            <SectionHeading number="04" eyebrow="CURRENCY CATALOG" title="Supported codes are not a readiness signal" intro="These are catalog codes and amount precision rules—not a statement that a provider route is enabled on this deployment." />
            <div className="rd-catalog-callout"><span className="rd-catalog-mark">i</span><p>Read <Code>GET /currencies</Code> for current <Code>collectionReady</Code> and payment-method readiness. Both must permit the collection before you offer it.</p></div>
            <div className="rd-currency-grid" role="table" aria-label="Collection currency catalog and fraction digits">
              <div className="rd-currency-head" role="row"><span>Currency</span><span>Code</span><span>Fraction digits</span></div>
              {currencies.map(([name, code, digits]) => <div className={`rd-currency-row${code === 'SLL' ? ' rd-sll-row' : ''}`} role="row" key={code}>
                <span>{name}</span><Code>{code}</Code><span className="rd-digit">{digits}</span>
              </div>)}
            </div>
            <p className="rd-footnote">KES, XOF, RWF, UGX and XAF accept whole units. Follow the precision returned/documented for the currency when validating amounts.</p>
            <div className="rd-sll-note"><strong>SLL denomination scale needs confirmation</strong><p>Use <Code>SLL</Code> as the request code; the reference says to label displayed amounts <Code>SLE</Code>, but does not establish the numeric API amount scale. Greenpay preserves the amount without a 1,000:1 conversion. Confirm the scale before applying any denomination conversion.</p></div>
          </section>

          <section className="rd-doc-section rd-safety-section" id="payment-safety">
            <SectionHeading number="05" eyebrow="RETRIES & CONFIRMATION" title="Make retries safe. Make fulfilment earned." intro="A response timeout does not tell you whether a payment started. Reconcile first; fulfil only after confirmed payment evidence." />
            <div className="rd-safety-grid">
              <article><span className="rd-safety-no">A</span><h3>Send an idempotency key</h3><p>Every payment creation needs an 8–128 character <Code>Idempotency-Key</Code>. Reuse it only for the same logical request; changed payloads conflict.</p></article>
              <article><span className="rd-safety-no">B</span><h3>Reconcile uncertainty</h3><p>If the result is uncertain, look up/reconcile that attempt before retrying. Do not automatically create a new key for an uncertain request.</p></article>
              <article><span className="rd-safety-no">C</span><h3>Require confirmed evidence</h3><p>Verify transaction reference, amount and currency against the order. A return from checkout or a <Code>pending</Code> status is not proof of payment.</p></article>
            </div>
          </section>

          <section className="rd-doc-section" id="webhooks">
            <SectionHeading number="06" eyebrow="PAYMENT EVENTS" title="Verify signed webhooks" intro="Use webhooks for payment state changes. Delivery is signed and at-least-once, so authenticate the raw body and deduplicate." />
            <div className="rd-webhook-meta">
              <div><span>EVENTS</span><p><Code>payment.success</Code><Code>payment.failed</Code><Code>payment.refunded</Code></p></div>
              <div><span>SIGNATURE HEADER</span><p><Code>X-Greenpay-Signature: sha256=&lt;hex HMAC-SHA256&gt;</Code></p></div>
              <div><span>DELIVERY ID</span><p><Code>X-Greenpay-Delivery</Code> is unique per delivery.</p></div>
            </div>
            <ul className="rd-verify-list">
              <li>Read the exact raw UTF-8 JSON bytes before parsing.</li>
              <li>Compute HMAC-SHA256 with the destination signing secret and compare in constant time.</li>
              <li>Deduplicate by delivery ID/event; respond 2xx quickly. Non-2xx responses and timeouts are retried with bounded exponential backoff.</li>
              <li>Fulfil once only after matching reference, amount and currency to confirmed payment evidence.</li>
            </ul>
            <Snippet label="Node.js / Express · signature check">{`const expected = createHmac('sha256', secret)
  .update(rawBody)
  .digest('hex');

const received = (signatureHeader || '').replace(/^sha256=/, '');
const valid = /^[a-f0-9]{64}$/i.test(received) &&
  timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));

// Parse only after signature verification.
// Deduplicate X-Greenpay-Delivery before applying the event.`}</Snippet>
            <p className="rd-footnote">Current event data: <Code>{'{ reference, amount, currency, status, paymentLinkId }'}</Code>, within an event carrying <Code>id</Code>, <Code>type</Code> and <Code>createdAt</Code>.</p>
          </section>

          <section className="rd-doc-section" id="payouts">
            <SectionHeading number="07" eyebrow="MERCHANT WORKSPACE" title="Payouts follow a separate flow" intro="Payout requests are handled in the signed-in merchant workspace—not through developer API-key endpoints." />
            <div className="rd-payout-panel">
              <div className="rd-payout-label"><span className="rd-workspace-dot" />SIGNED-IN WORKSPACE</div>
              <p>Availability depends on a supported currency, a provider method returned as available, and a saved destination in the same currency. Fees and minimums can vary by currency and deployment.</p>
              <div className="rd-payout-steps"><span>Funded wallet balance</span><i>→</i><span>Request review</span><i>→</i><span>Workspace status</span></div>
              <p className="rd-payout-caveat">A request reserves funded wallet money and enters administrator review; it is not an instant payout guarantee. The current catalog is fiat currency codes only. Greenpay makes no cryptocurrency or blockchain payout claim.</p>
            </div>
          </section>

          <section className="rd-doc-section" id="responses">
            <SectionHeading number="08" eyebrow="OPERATING NOTES" title="Responses, limits & useful reads" intro="Handle errors deliberately and prefer event delivery over frequent polling." />
            <div className="rd-response-grid">
              <div className="rd-response-codes"><h3>Common status codes</h3><div><Code>400</Code><span>Invalid input</span></div><div><Code>401</Code><span>Missing or invalid key</span></div><div><Code>403</Code><span>Inactive access or missing scope</span></div><div><Code>404</Code><span>Merchant-owned record not found</span></div><div><Code>409</Code><span>Idempotency conflict or in-flight request</span></div><div><Code>429</Code><span>Rate limit reached</span></div><div><Code>502 / 503</Code><span>Upstream issue / unavailable service</span></div></div>
              <div className="rd-response-side">
                <div><h3>Rate limits</h3><p>Developer-key requests are limited to 120 per key per minute. Respect <Code>Retry-After</Code>.</p></div>
                <div><h3>Transaction lists</h3><p><Code>page</Code> defaults to 1; <Code>perPage</Code> defaults to 25, maximum 100. Response includes <Code>items</Code>, <Code>total</Code>, <Code>page</Code> and <Code>perPage</Code>.</p></div>
                <div><h3>Payment links</h3><p>The response includes its shareable public <Code>url</Code>.</p></div>
              </div>
            </div>
          </section>

          <section className="rd-next-step">
            <div><span className="rd-kicker">READY TO CONNECT?</span><h2>Keep the secret server-side.<br />Keep payment evidence close.</h2></div>
            <a href="/sign-up">Get API access <ArrowUpRight size={15} /></a>
          </section>
          <div className="rd-source-note"><Check size={14} /> Reference codes and examples describe Greenpay API behavior. Route availability remains deployment-specific.</div>
        </div>
      </div>
    </main>

    <footer className="public-api-footer rd-footer">
      <span><Brand /><small>Developer documentation</small></span>
      <div><a href="/">Back to Greenpay</a><span>Payments infrastructure for African markets</span></div>
    </footer>
  </div>;
}

export default Reorganized;