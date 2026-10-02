import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, LoaderCircle, Play, ShieldCheck } from 'lucide-react';
import {
  COLLECTION_CURRENCIES,
  hasCollectionAmountPrecision,
} from '@workspace/api-zod';
import { useListSupportedCurrencies } from '@workspace/api-client-react';
import { Async, Btn, Card, CURRENCIES, Err, Field, Gate, Heading, Note } from '@/components/kit';
import { PlatformBrand, usePlatformBranding } from '@/components/platform-brand';
import '@/public-api-docs.css';

type ReadEndpoint = 'merchant' | 'payment-links' | 'transactions' | 'transaction' | 'public-status' | 'public-fx-rates' | 'fees' | 'fx-quote';
type CallResult = { kind: 'read' | 'payment'; status: number; body: string } | null;

const PAYMENT_CONFIRMATION = 'I CONFIRM THIS CAN INITIATE A PAYMENT';
const API_ORIGIN = '/api';

function redactKey(body: string, key: string) {
  return key ? body.replaceAll(key, '[redacted API key]') : body;
}

function makeReadPath(endpoint: ReadEndpoint, reference: string, page: string, perPage: string, fxAmount: string, fxFrom: string, fxTo: string) {
  switch (endpoint) {
    case 'merchant': return '/v1/merchant';
    case 'payment-links': return '/v1/payment-links';
    case 'transactions': {
      const params = new URLSearchParams({ page, perPage });
      return `/v1/transactions?${params.toString()}`;
    }
    case 'transaction': return `/v1/transactions/${encodeURIComponent(reference.trim())}`;
    case 'public-status': return `/public/transactions/${encodeURIComponent(reference.trim())}`;
    case 'public-fx-rates': return '/public/fx-rates';
    case 'fees': return '/v1/fees';
    case 'fx-quote': {
      const params = new URLSearchParams({ amount: fxAmount, from: fxFrom, to: fxTo });
      return `/v1/fx-quote?${params.toString()}`;
    }
  }
}

export function DeveloperDocsPage() {
  return <Gate need="merchant"><DeveloperDocsContent /></Gate>;
}

export function PublicApiDocsPage() {
  const branding = usePlatformBranding();
  useEffect(() => {
    const title = `${branding.platformName} API documentation`;
    const description = `Developer reference for ${branding.platformName}: authentication, collections, webhooks, supported currencies, and payout availability.`;
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
    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title);
    setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description);
  }, [branding.platformName]);
  useEffect(() => {
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    if (!targetId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <div className="public-api-docs">
    <header className="public-api-header">
      <a href="/" aria-label={`${branding.platformName} home`}><PlatformBrand variant="home" /></a>
      <nav aria-label="Documentation navigation">
        <a href="/#coverage-pricing">Markets</a>
        <a href="/sign-in">Sign in</a>
        <a className="public-api-signup" href="/sign-up">Get started</a>
      </nav>
    </header>
    <main className="public-api-main">
      <DeveloperDocsContent publicView />
    </main>
    <footer className="public-api-footer">
      <span>{branding.platformName} developer documentation</span>
      <a href="/">Back to home</a>
    </footer>
  </div>;
}

function DeveloperDocsContent({ publicView = false }: { publicView?: boolean }) {
  const currencies = useListSupportedCurrencies();
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState<ReadEndpoint>('merchant');
  const [reference, setReference] = useState('');
  const [page, setPage] = useState('1');
  const [perPage, setPerPage] = useState('20');
  const [fxAmount, setFxAmount] = useState('100');
  const [fxFrom, setFxFrom] = useState('USD');
  const [fxTo, setFxTo] = useState('KES');
  const [mutationEnabled, setMutationEnabled] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('10');
  const [paymentCurrency, setPaymentCurrency] = useState('USD');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [result, setResult] = useState<CallResult>(null);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState('');
  const paymentCurrencyOption = currencies.data?.items.find((item) => item.code === paymentCurrency);
  const paymentMethods = paymentCurrencyOption?.paymentMethods ?? [];
  const selectedPaymentMethod = paymentMethods.find((method) => method.id === paymentMethodId && method.ready)
    ?? paymentMethods.find((method) => method.ready);

  async function send(path: string, method: 'GET' | 'POST', kind: 'read' | 'payment', body?: Record<string, unknown>, idempotency?: string) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    const url = new URL(`${API_ORIGIN}${path}`, window.location.origin);
    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin',
      redirect: 'error',
    });
    const raw = (await response.text()).slice(0, 30_000);
    let formatted = raw;
    try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* Keep a bounded plain-text error body. */ }
    setResult({ kind, status: response.status, body: redactKey(formatted, apiKey.trim()) });
  }

  async function runRead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError('');
    setResult(null);
    if (endpoint !== 'public-status' && endpoint !== 'public-fx-rates' && !apiKey.trim()) { setRequestError('Enter a developer API key. It is used only in this page memory.'); return; }
    if (endpoint === 'transaction' && !reference.trim()) { setRequestError('Enter the transaction reference to read.'); return; }
    if (endpoint === 'fx-quote' && !(Number(fxAmount) > 0)) { setRequestError('Enter an FX quote amount greater than zero.'); return; }
    setBusy(true);
    try {
      await send(makeReadPath(endpoint, reference, page, perPage, fxAmount, fxFrom, fxTo), 'GET', 'read');
    } catch {
      setRequestError('The read-only request did not complete. Check your connection, key, and read scope; the key was not logged or saved.');
    } finally {
      setBusy(false);
    }
  }

  async function runPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError('');
    setResult(null);
    if (!apiKey.trim()) { setRequestError('Enter a developer API key. It is used only in this page memory.'); return; }
    if (!mutationEnabled || confirmPhrase !== PAYMENT_CONFIRMATION) {
      setRequestError(`Payment requests are locked until you enable them and type: ${PAYMENT_CONFIRMATION}`);
      return;
    }
    const amount = Number(paymentAmount);
    if (!hasCollectionAmountPrecision(amount, paymentCurrency)) {
      const minorUnits = COLLECTION_CURRENCIES.find(({ code }) => code === paymentCurrency)?.minorUnits ?? 2;
      setRequestError(`${paymentCurrency} amounts must use ${minorUnits === 0 ? 'whole units' : `at most ${minorUnits} fractional digits`}.`);
      return;
    }
    if (!paymentCurrencyOption?.collectionReady || !selectedPaymentMethod) {
      setRequestError(paymentCurrencyOption?.comingSoon
        ? `${paymentCurrency} collections are coming soon. Choose another currency.`
        : `No payment method is currently available for ${paymentCurrency}. Refresh the currency catalog or choose another currency.`);
      return;
    }
    if (!customerEmail.trim()) { setRequestError('Enter the customer email required by this payment request.'); return; }
    if (idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 128) {
      setRequestError('Idempotency-Key must be 8 to 128 characters.');
      return;
    }
    setBusy(true);
    try {
      await send('/v1/transactions', 'POST', 'payment', {
        amount,
        currency: paymentCurrency,
        paymentMethod: selectedPaymentMethod.id,
        customerEmail: customerEmail.trim(),
        ...(customerPhone.trim() ? { customerPhone: customerPhone.trim() } : {}),
      }, idempotencyKey.trim());
    } catch {
      setRequestError('The payment request did not complete. Reconcile its idempotency key before retrying; this playground never retries automatically.');
    } finally {
      setBusy(false);
    }
  }

  return <div className={`form-stack${publicView ? ' public-api-docs-content' : ''}`}>
    <Heading
      eyebrow={publicView ? 'PUBLIC DEVELOPER DOCUMENTATION' : 'DEVELOPER REFERENCE'}
      title={publicView ? 'Greenpay API documentation' : 'API docs & safe playground'}
      subtitle={publicView
        ? 'Integration guide, supported currency catalog, payment flows, webhooks, and payout availability.'
        : "Greenpay's merchant API reference, currency catalog, and same-origin request console."}
      action={publicView
        ? <a className="btn btn-secondary" href="/sign-up">Get API access</a>
        : <a className="btn btn-secondary" href="/developers"><ArrowLeft size={14} />API access</a>}
    />

    {publicView
      ? <Note tone="warn">This reference is public. API keys are created after sign-in; keep them in trusted server-side secret storage and never publish them in browser or mobile code.</Note>
      : <Note tone="warn">The playground keeps a bearer key in component memory only. It is not written to local storage, query caches, browser URLs, or logs. Clear the field or leave this page to discard it. Only fixed same-origin Greenpay paths are available.</Note>}

    <Card title="Base URL and authentication" subtitle="All merchant API requests use this deployment's API host.">
      <div className="form-stack">
        <pre className="code">{`Base URL: ${window.location.origin}${API_ORIGIN}
Authentication: Authorization: Bearer <merchant API key>
Content type: application/json
Environment: this Greenpay deployment; there is no separate Greenpay sandbox hostname.`}</pre>
        <p>Use an API key created in <a href={publicView ? '/sign-in' : '/developers'}>API access</a>. Greenpay currently issues a <code>gp_live_</code>-prefixed key; do not interpret that prefix as proof of a test or live payment environment. Payment requests use the credentials configured for the selected currency route. Until an operator configures test-mode credentials, treat a confirmed payment request as potentially real.</p>
        <p>Keys are shown once at creation. Store them in a trusted server-side secret manager, rotate or revoke them from API access, and never ship a secret key in browser or mobile application code.{!publicView && ' The playground key input is temporary and exists to make direct merchant-scoped read requests possible.'}</p>
      </div>
    </Card>

    <Card title="Scopes and available endpoints" subtitle="Keys have least-privilege scopes; all records are restricted to the key's merchant.">
      <div className="table-wrap"><table className="dt"><thead><tr><th>Scope</th><th>Allowed requests</th></tr></thead><tbody>
        <tr><td><code>read</code></td><td><code>GET /v1/merchant</code>, <code>/v1/payment-links</code>, <code>/v1/transactions</code>, <code>/v1/transactions/:reference</code>, <code>/v1/fx-quote</code>, <code>/v1/fees</code></td></tr>
        <tr><td><code>payment_links:write</code></td><td><code>POST /v1/payment-links</code> — creates a merchant-owned payment link.</td></tr>
        <tr><td><code>payments:write</code></td><td><code>POST /v1/transactions</code> — starts a payment; requires an <code>Idempotency-Key</code>. <code>POST /v1/transactions/:reference/verify</code> refreshes provider status.</td></tr>
        <tr><td><code>none</code></td><td><code>GET /public/transactions/:reference</code> for customer-safe payment status and <code>GET /public/fx-rates</code> for public USD reference rates; neither requires a bearer key.</td></tr>
      </tbody></table></div>
      <p>Keys are bound to one merchant. The API rejects requests when the key is missing, revoked, lacks the required scope, or the merchant/API feature is inactive. Verification checks do not declare a payment successful unless provider-confirmed reference, amount, and currency evidence matches. The public status endpoint returns only reference, status, amount, currency, timestamps, and the merchant's public shop identity; it does not expose customer contact or internal provider data.</p>
    </Card>

    <Card title="Request and response behavior">
      <ul>
        <li>Errors are JSON, generally <code>{'{ "error": "..." }'}</code>. <code>400</code> means invalid input; <code>401</code> missing/invalid key; <code>403</code> inactive access or missing scope; <code>404</code> merchant-owned record not found; <code>409</code> idempotency conflict/in-flight request; <code>429</code> request limit; <code>502</code> upstream confirmation/initiation problem; <code>503</code> disabled or unconfigured service.</li>
        <li>Developer-key requests are limited to 120 requests per key per minute; rate-limited responses include <code>Retry-After</code>. Respect the header and use webhooks instead of frequent polling.</li>
        <li><code>GET /v1/transactions</code> accepts <code>page</code> (default 1) and <code>perPage</code> (default 25, maximum 100); its response contains <code>items</code>, <code>total</code>, <code>page</code>, and <code>perPage</code>. Payment-link lists are returned as <code>items</code>.</li>
        <li>Use an 8–128 character <code>Idempotency-Key</code> for every payment creation. Reuse it only for the same logical request: matching completed requests replay the saved result, changed payloads conflict, and uncertain requests must be reconciled before retrying with a new key.</li>
        <li><code>GET /public/transactions/:reference</code> does not require authentication and returns <code>pending</code>, <code>success</code>, <code>failed</code>, <code>cancelled</code>, or <code>refunded</code>. A pending lookup may ask the provider for an updated status, so use signed webhooks rather than rapid polling.</li>
        <li><code>POST /v1/payment-links</code> creates a shareable link but does not itself charge a customer. The response includes its public <code>url</code>; the link can be paused later with <code>PUT /v1/payment-links/:id</code>.</li>
      </ul>
    </Card>

    <div id="supported-collection-currencies" className="currency-section-anchor">
    <Card title="Supported collection currencies" subtitle="Readiness is deployment-specific and never exposes route/provider names.">
      <Async q={currencies} empty={!currencies.data?.items.length} emptyTitle="Currency readiness is unavailable" emptyBody="The catalog request returned no supported collection currencies. Retry the page before selecting a currency.">
        <div className="currency-table-wrap table-wrap">
          <table className="dt currency-readiness-table">
            <thead><tr><th>Currency</th><th>Code</th><th>Fraction digits</th><th>Payment methods</th><th>Launch state</th><th>Collection readiness</th></tr></thead>
            <tbody>
              {(currencies.data?.items ?? []).map((item) => <tr key={item.code}>
                <td>{item.name}</td>
                <td><code className="currency-code">{item.code}</code>{item.code === 'SLL' && <span className="sub">Greenpay preserves the SLL API value and labels it SLL pending denomination-scale confirmation.</span>}</td>
                <td>{item.minorUnits}</td>
                <td>{item.paymentMethods.length ? item.paymentMethods.map((method) => <span key={method.id}>{method.label}{method.requiresPhone ? ' · phone required' : ''}{method.ready ? '' : item.comingSoon ? ' · Coming soon' : ' · unavailable'}</span>) : 'No method available'}</td>
                <td>{item.comingSoon ? 'Coming soon' : 'Active'}</td>
                <td>{item.comingSoon ? 'Not launched' : item.collectionReady ? 'Ready on this deployment' : 'Provider/tier not configured or disabled'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="currency-mobile-list" role="list" aria-label="Supported collection currencies">
          {(currencies.data?.items ?? []).map((item) => <article className="currency-mobile-card" role="listitem" key={`mobile-${item.code}`}>
            <header className="currency-mobile-card-header">
              <strong>{item.name}</strong>
              <code className="currency-code">{item.code}</code>
            </header>
            {item.code === 'SLL' && <p className="currency-mobile-sll-note">Greenpay preserves the SLL API value and labels it SLL pending denomination-scale confirmation.</p>}
            <div className="currency-mobile-detail">
              <span>Payment methods</span>
              <div className="currency-mobile-methods">
                {item.paymentMethods.length
                  ? item.paymentMethods.map((method) => <span className="currency-mobile-method" key={method.id}>
                    {method.label}{method.requiresPhone ? ' · phone required' : ''}{method.ready ? '' : item.comingSoon ? ' · Coming soon' : ' · unavailable'}
                  </span>)
                  : <span className="currency-mobile-method">No method available</span>}
              </div>
            </div>
            <dl className="currency-mobile-facts">
              <div><dt>Fraction digits</dt><dd>{item.minorUnits}</dd></div>
              <div><dt>Launch state</dt><dd>{item.comingSoon ? 'Coming soon' : 'Active'}</dd></div>
              <div><dt>Collection readiness</dt><dd>{item.comingSoon ? 'Not launched' : item.collectionReady ? 'Ready on this deployment' : 'Provider/tier not configured or disabled'}</dd></div>
            </dl>
          </article>)}
        </div>
      </Async>
       <p>The currency catalog explicitly distinguishes an administrator launch state of “Coming soon” from provider or verification-tier unavailability. A Coming soon currency cannot initiate collections, though payment links can remain visible and editable. For active currencies, payment-method readiness and collection readiness still reflect the configured provider route and applicable verification limits. Check the catalog before collecting.</p>
      <p>Payzaapi's official currency reference lists KES, NGN, GHS, TZS, XOF, USD, RWF, UGX, ZMW, MWK, SLL, CDF, MZN, and XAF. Greenpay keeps its existing USD and KES route behavior and adds the documented codes. KES collections are whole-shilling only; XOF, RWF, UGX, and XAF accept whole units. Check live readiness before collecting—catalog support does not mean provider credentials are configured.</p>
      <p>Payzaapi's documentation says to send <code>SLL</code> in API requests and label displayed amounts <code>SLE</code>, noting the 2022 redenomination and that <code>SLE</code> is rejected as a request code. It does not specify the numeric denomination or conversion scale of API amount values (including whether an SLL-labelled value is already in modern SLE units). Greenpay therefore preserves both the amount and the explicit <code>SLL</code> label until the value scale is confirmed; no 1,000:1 conversion is applied.</p>
      <p>Payzaapi's published minima are KES 1, NGN 100, GHS 1, TZS 500, XOF 100, and USD 0.50; its reference says network-set minimums apply to RWF, UGX, ZMW, MWK, SLL, CDF, MZN, and XAF. These are Payzaapi-published values, not a promise that a particular Greenpay route is enabled or uses identical commercial limits.</p>
      <p><a href="https://payzaapi.co.ke/docs#currencies" target="_blank" rel="noreferrer">Payzaapi official currencies and methods reference</a></p>
    </Card>
    </div>

    <Card title="Payout requests and currency availability" subtitle="Payouts are not a promise of arbitrary-currency or cryptocurrency support.">
      <div className="form-stack">
        <p>Payout requests are handled in the signed-in merchant workspace, not with a developer API bearer key. Currency must be one of Greenpay's supported three-letter currency codes, and the payout provider must return that currency as available. Provider methods, minimum withdrawals, and fees can vary by currency and deployment.</p>
        <h3>Check current payout methods (signed-in merchant session)</h3>
        <pre className="code">{`GET ${window.location.origin}/api/wallets/payout-methods?currency=KES`}</pre>
        <h3>Request a payout from an approved destination</h3>
        <pre className="code">{`POST ${window.location.origin}/api/wallets/payout-requests
Idempotency-Key: payout-request-1042
Content-Type: application/json

{"amount":25,"currency":"KES","destinationId":123}`}</pre>
        <p>The request reserves funded wallet money and enters administrator review; it is not an instant payout guarantee. The currency must match the saved destination. Use a unique 8–128 character idempotency key and check <code>GET /api/wallets/payout-requests</code> for status.</p>
        <p>The current currency catalog contains fiat currency codes only. No cryptocurrency asset or blockchain payout network is represented in the current payout flow, so Greenpay cannot claim payouts in every currency or crypto at this time.</p>
      </div>
    </Card>

    <Card title="Signed webhooks" subtitle="Use webhooks for payment state changes; treat deliveries as at-least-once.">
      <div className="form-stack">
        <p>Configure a destination from <a href={publicView ? '/sign-in' : '/developers'}>API access</a>. Greenpay sends <code>payment.success</code>, <code>payment.failed</code>, or <code>payment.refunded</code> with <code>X-Greenpay-Event</code>, a unique <code>X-Greenpay-Delivery</code>, and <code>X-Greenpay-Signature: sha256=&lt;hex HMAC-SHA256&gt;</code>. The signature is computed over the exact raw UTF-8 JSON body using the webhook signing secret shown once when the destination is created.</p>
        <p>Read the raw bytes before JSON parsing, compute HMAC-SHA256, compare the signature in constant time, then parse the payload. Return a 2xx quickly; duplicate deliveries can occur, so deduplicate by delivery ID/event and fulfil only once. Check reference, amount, currency, and confirmed status before fulfilment. Non-2xx/timeouts are retried with bounded exponential backoff.</p>
        <pre className="code">{`// Node.js / Express: verify the exact raw body before parsing it
import { createHmac, timingSafeEqual } from 'node:crypto';

function validGreenpaySignature(rawBody, header, secret) {
  const received = (header || '').replace(/^sha256=/, '');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

app.post('/webhooks/greenpay', express.raw({ type: 'application/json' }), (req, res) => {
  if (!validGreenpaySignature(req.body, req.get('X-Greenpay-Signature'), process.env.GREENPAY_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // Deduplicate X-Greenpay-Delivery before applying event.data.
  res.sendStatus(200);
});`}</pre>
        <p>Current event shape: <code>{'{ id, type, createdAt, data: { reference, amount, currency, status, paymentLinkId } }'}</code>.</p>
      </div>
    </Card>

    <Card title="Examples" subtitle="Run these examples from a trusted website backend or server terminal—not from browser JavaScript.">
      <div className="form-stack">
        <Note tone="warn">For a website integration, keep <code>GREENPAY_API_KEY</code> in your server-side secret manager. The browser should call your own backend, which attaches the key when it calls Greenpay. Never put the key in browser JavaScript, HTML, a public build-time environment variable, or a mobile app.{!publicView && ' The built-in playground is a temporary, explicit same-origin tool—not a production integration pattern.'}</Note>
        <h3>Read the merchant and a paginated transaction list</h3>
        <pre className="code">{`curl "${window.location.origin}/api/v1/merchant" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY"

curl "${window.location.origin}/api/v1/transactions?page=1&perPage=25" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY"`}</pre>
        <h3>Read a transaction or calculate a quote</h3>
        <pre className="code">{`curl "${window.location.origin}/api/v1/transactions/TRANSACTION_REFERENCE" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY"

curl "${window.location.origin}/api/v1/fx-quote?amount=100&from=USD&to=KES" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY"`}</pre>
        <h3>Create a payment (money-moving; opt-in required)</h3>
        <pre className="code">{`curl -X POST "${window.location.origin}/api/v1/transactions" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY" \\
  -H "Idempotency-Key: order-1042-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":10,"currency":"USD","paymentMethod":"hosted_checkout","customerEmail":"buyer@example.com"}'`}</pre>
        <p>The response contains <code>transaction</code> and <code>checkoutUrl</code>. A hosted checkout session is not a card-only guarantee: the provider checkout displays the methods it actually supports. For USD, Greenpay currently offers hosted checkout; do not describe it as card-only unless the provider contract enforces that.</p>
        <h3>Create a payment link</h3>
        <pre className="code">{`curl -X POST "${window.location.origin}/api/v1/payment-links" \\
  -H "Authorization: Bearer $GREENPAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Invoice 1042","amountType":"fixed","amount":10,"currency":"USD","description":"Invoice 1042"}'`}</pre>
        <p>Use <code>amountType: "customer_choice"</code> when the customer chooses the amount; omit <code>amount</code> in that case. The response includes the shareable link URL.</p>
        <h3>Check payment status after checkout</h3>
        <pre className="code">{`curl "${window.location.origin}/api/public/transactions/TRANSACTION_REFERENCE"`}</pre>
        <p>This public endpoint needs no API key and returns a customer-safe status payload. It may refresh pending provider status; prefer the signed webhook flow above for ongoing updates.</p>
        <Note tone="warn">Do not use a live payment request as a connectivity test. A request can initiate a real collection when live upstream credentials are active. The API does not offer a distinct public sandbox hostname.</Note>
      </div>
    </Card>

    {!publicView && <>
    <Card title="Read-only API playground" subtitle="Calls only this Greenpay deployment. The available GET endpoints are fixed; no custom URL, host, or path is accepted.">
      <form className="form-stack" onSubmit={runRead}>
        <Field label="Merchant API key" hint={endpoint === 'public-status' || endpoint === 'public-fx-rates' ? 'Optional for this public endpoint; otherwise held in memory only.' : 'Held in memory for this page only; it is never stored or logged.'}><input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste a scoped merchant API key" data-testid="input-playground-api-key" /></Field>
        <Field label="Read-only endpoint"><select value={endpoint} onChange={(event) => setEndpoint(event.target.value as ReadEndpoint)} data-testid="select-playground-endpoint">
          <option value="merchant">GET /v1/merchant</option>
          <option value="payment-links">GET /v1/payment-links</option>
          <option value="transactions">GET /v1/transactions (paginated)</option>
          <option value="transaction">GET /v1/transactions/:reference</option>
          <option value="public-status">GET /public/transactions/:reference (public status)</option>
          <option value="public-fx-rates">GET /public/fx-rates (public USD rates)</option>
          <option value="fees">GET /v1/fees</option>
          <option value="fx-quote">GET /v1/fx-quote</option>
        </select></Field>
        {(endpoint === 'transaction' || endpoint === 'public-status') && <Field label="Transaction reference"><input value={reference} onChange={(event) => setReference(event.target.value)} required /></Field>}
        {endpoint === 'transactions' && <div className="form-grid"><Field label="Page"><input type="number" min="1" value={page} onChange={(event) => setPage(event.target.value)} /></Field><Field label="Per page (max 100)"><input type="number" min="1" max="100" value={perPage} onChange={(event) => setPerPage(event.target.value)} /></Field></div>}
        {endpoint === 'fx-quote' && <div className="form-grid"><Field label="Amount"><input type="number" min="0.01" step="0.01" value={fxAmount} onChange={(event) => setFxAmount(event.target.value)} /></Field><Field label="From"><select value={fxFrom} onChange={(event) => setFxFrom(event.target.value)}>{CURRENCIES.map((code) => <option key={code}>{code}</option>)}</select></Field><Field label="To"><select value={fxTo} onChange={(event) => setFxTo(event.target.value)}>{CURRENCIES.map((code) => <option key={code}>{code}</option>)}</select></Field></div>}
        {requestError && <Err error={requestError} />}
        <Btn type="submit" disabled={busy} testId="button-playground-read">{busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}Run read-only request</Btn>
      </form>
      {result?.kind === 'read' && <div className="form-stack"><h3>HTTP {result.status}</h3><pre className="code" aria-live="polite">{result.body}</pre></div>}
    </Card>

    <Card title="Payment request playground — disabled by default" subtitle="Only POST /v1/transactions is offered. Sending it can start a collection; there is no automatic retry.">
      <form className="form-stack" onSubmit={runPayment}>
        <label className="chip"><input type="checkbox" checked={mutationEnabled} onChange={(event) => { setMutationEnabled(event.target.checked); setConfirmPhrase(''); }} />I understand this can initiate a real payment</label>
        <Note tone="danger"><ShieldCheck size={15} /> Before enabling: the API key must have <code>payments:write</code>; currency routes may be connected to live payment credentials. This is not a sandbox/test-payment guarantee.</Note>
          <div className="form-grid"><Field label="Amount"><input type="number" min={paymentCurrency === 'KES' || COLLECTION_CURRENCIES.find(({ code }) => code === paymentCurrency)?.minorUnits === 0 ? '1' : '0.01'} step={COLLECTION_CURRENCIES.find(({ code }) => code === paymentCurrency)?.minorUnits === 0 ? '1' : '0.01'} value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} disabled={!mutationEnabled} required /></Field><Field label="Currency"><select value={paymentCurrency} onChange={(event) => { setPaymentCurrency(event.target.value); setPaymentMethodId(''); }}>{(currencies.data?.items ?? []).map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}{item.comingSoon ? ' · Coming soon' : item.collectionReady ? '' : ' · unavailable'}</option>)}</select></Field></div>
          {paymentCurrencyOption?.comingSoon && <Note tone="warn">Coming soon: collections in {paymentCurrency} are disabled by an administrator.</Note>}
          <Field label="Payment method"><select value={selectedPaymentMethod?.id ?? ''} onChange={(event) => setPaymentMethodId(event.target.value)} disabled={!paymentMethods.some((method) => method.ready)}>{!selectedPaymentMethod && <option value="">{paymentCurrencyOption?.comingSoon ? 'Coming soon' : paymentCurrencyOption?.collectionReady ? 'No payment method available' : 'No payment method available right now'}</option>}{paymentMethods.map((method) => <option key={method.id} value={method.id} disabled={!method.ready}>{method.label}{method.requiresPhone ? ' · phone required' : ''}{method.ready ? '' : paymentCurrencyOption?.comingSoon ? ' · Coming soon' : ' · unavailable'}</option>)}</select></Field>
        <Field label="Customer email"><input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} disabled={!mutationEnabled} required /></Field>
         {selectedPaymentMethod?.requiresPhone && <Field label="Customer phone (required for this method)"><input type="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} disabled={!mutationEnabled} required /></Field>}
        <Field label="Idempotency-Key" hint="This key stays in page memory. Do not retry the same uncertain request with a different key until you reconcile it."><input minLength={8} maxLength={128} value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} disabled={!mutationEnabled} required /></Field>
        {mutationEnabled && <Field label={`Type exactly: ${PAYMENT_CONFIRMATION}`}><input value={confirmPhrase} onChange={(event) => setConfirmPhrase(event.target.value)} autoComplete="off" /></Field>}
        {requestError && <Err error={requestError} />}
         {mutationEnabled && <Btn variant="danger" type="submit" disabled={busy || confirmPhrase !== PAYMENT_CONFIRMATION || !paymentCurrencyOption?.collectionReady || !selectedPaymentMethod} testId="button-playground-confirm-payment">Confirm payment request</Btn>}
      </form>
      {result?.kind === 'payment' && <div className="form-stack"><h3>HTTP {result.status}</h3><pre className="code" aria-live="polite">{result.body}</pre></div>}
    </Card>
    </>}
  </div>;
}
