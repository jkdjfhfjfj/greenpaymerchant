# Greenpay / Payrail

Merchant payment collection and platform operations built with React, Express,
PostgreSQL, Drizzle, Clerk, and a generated OpenAPI client.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/payrail-console run dev
```

The API and console already have managed Replit workflows. Use those workflows
rather than starting a second server on the same port. Database schema push is
for **development only**; never apply it to production without reviewing the
migration.

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run build
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/payrail-console run build
```

The console is root-mounted. The `PORT` above is a build-time value only;
managed workflows supply the real development port. Workspace-wide builds
include the separate canvas sandbox and also need its service environment.

## Access and configuration

- Clerk handles merchant signup and login. Its tenant and canonical keys are
  provisioned through Replit authentication setup.
- `ADMIN_EMAILS` is a comma-separated administrator allowlist. Only authenticated
  users with verified matching email addresses receive platform-admin access.
  An empty allowlist grants nobody admin access. Never make the first signup an
  administrator automatically.
- `DATABASE_URL` is the existing PostgreSQL connection.
- Store server configuration in Replit Secrets/environment configuration, not
  in source control or frontend variables.

### Encrypted provider credential manager

Authorized admins can manage provider credentials in the console. Credential
values are encrypted at rest and never returned by list/read APIs.

The vault uses `CREDENTIALS_ENCRYPTION_KEY`, or derives its key from
`SESSION_SECRET` when a dedicated key is absent. Keep that master secret stable:
changing it without a rotation migration makes existing ciphertext unreadable.
It is not a provider credential and must not be editable through the credential
manager.

| Provider | Credential/configuration fields |
| --- | --- |
| Paystack | `PAYSTACK_SECRET_KEY` |
| PayHero | `PAYHERO_BASIC_AUTH` (existing `PAYHERO_AUTH_TOKEN` is an alias), `PAYHERO_CHANNEL_ID` |
| Payzaapi | `PAYZA_PUBLIC_KEY`, `PAYZA_SECRET_KEY` / `PAYZAAPI_API_KEY`, optional `PAYZA_WEBHOOK_SECRET` |
| Didit | `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, optional `DIDIT_KYB_WORKFLOW_ID` |

Credentials may also be provided through server environment configuration.
Missing or disabled providers fail explicitly; the app does not simulate
successful verification, collection, or payout.

### Didit verification

1. Create and publish KYC and, if needed, KYB workflows in Didit. Workflow
   settings determine the required identity, liveness, address, AML, business,
   and beneficial-owner checks.
2. Save the workflow identifiers and application API key through the admin
   credential manager or server configuration.
3. Optionally configure the production webhook destination as
   `https://greenpay.co.ke/api/webhooks/didit`. No webhook signing secret is
   needed by Greenpay: the notification only identifies a session, and the
   server confirms every status through Didit's authenticated decision API
   before changing KYC state.
4. Session creation sets the browser return URL to
   `PUBLIC_APP_URL/merchant/kyc` automatically. This is separate from the
   webhook URL; development preview URLs are not production URLs.

Didit's `callback` is the browser return URL. Its query-string status is **not**
proof of approval. Only a server-verified provider decision may update verified
KYC status. The application retains status/session metadata rather than
copying identity documents or biometrics into the database. The KYC page also
polls Didit's decision API while open and when the merchant returns.

## Developer API

Create scoped API keys in the merchant developer portal. The full secret is
displayed once; only a hash is retained. Revoke a lost key and issue another.

Use `Authorization: Bearer YOUR_MERCHANT_KEY` with the API:

| Operation | Endpoint |
| --- | --- |
| Merchant profile | `GET /api/v1/merchant` |
| Payment links | `GET /api/v1/payment-links`, `POST /api/v1/payment-links` |
| Payments | `GET /api/v1/transactions`, `POST /api/v1/transactions` |
| Payment detail | `GET /api/v1/transactions/{reference}` |
| Provider verification | `POST /api/v1/transactions/{reference}/verify` |
| FX quote | `GET /api/v1/fx-quote?amount=100&from=USD&to=KES` |
| Fee schedule | `GET /api/v1/fees` |

Payment initiation requires a unique `Idempotency-Key` header of 8–128
characters. Reuse the same key and identical input when checking an uncertain
request; never retry the same intended payment with a new key.

Available scopes are `read`, `payment_links:write`, and `payments:write`.
Every keyed request is restricted to that key's merchant. Account suspension,
verification requirements, feature controls, and revocation are enforced
server-side, not just by hiding buttons.

Merchant webhook signing secrets are also shown once. Webhook destinations must
be public HTTPS endpoints. Treat delivery retries as possible and deduplicate
events in the receiving application.

The API contract lives in `lib/api-spec/openapi.yaml`. Run codegen after every
contract change; do not hand-edit generated clients or validation schemas.

## Financial boundaries

- FX uses effective, expiring administrator-managed rates and merchant markup.
  It calculates quotes; it does **not** execute a currency trade, create a wallet
  balance, or guarantee liquidity.
- Platform fees and provider fees are separate. A configured platform fee must
  not be represented as a provider-confirmed deduction.
- T+3 settlement dates are expected dates, not provider-confirmed settlements.
- Legacy platform records without merchant ownership must never be exposed to
  a merchant. Platform operations remain administrator-only.
- Payouts are administrator-operated and may be attributed to a merchant.
  Merchant payout history is read-only: it does not imply a funded wallet or
  permit automatic withdrawal.

## Development API smoke checks

`artifacts/api-server/src/tests/platform-api-smoke.ts` exercises developer-key
authentication, ownership, link persistence, scopes, feature controls, suspension,
and revocation against a running development API. Set `PAYRAIL_SMOKE_API_URL` to
the development API URL ending in `/api`. For example:

```sh
pnpm --filter @workspace/api-server exec esbuild src/tests/platform-api-smoke.ts --bundle --platform=node --format=cjs --outfile=/tmp/payrail-api-smoke.cjs
PAYRAIL_SMOKE_API_URL="https://${REPLIT_DEV_DOMAIN}/api" node /tmp/payrail-api-smoke.cjs
```

The
script refuses production hosts, creates temporary fixtures, removes them in a
`finally` block, and never calls a provider money operation.

## Before accepting live payments

Configure the administrator allowlist, provider credentials, Didit workflows
and signed webhook destination, published callback URLs, and a stable vault
master key. Exercise the provider sandbox success/failure/retry paths and
reconcile provider fees and settlements before enabling live collection.
