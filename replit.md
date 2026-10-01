# Greenpay / Payrail

A merchant payment collection and platform-administration console for African
payment rails.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (managed `PORT`)
- `pnpm run typecheck` — full typecheck across all packages
- Use artifact-specific builds with their `PORT`/`BASE_PATH` configuration;
  workspace-wide builds also include the separately configured canvas sandbox
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/payrail-console` — React merchant/admin console and public checkout
- `artifacts/api-server` — Express routes, provider adapters, and authorization
- `lib/db` — existing PostgreSQL schema and Drizzle connection
- `lib/api-spec/openapi.yaml` — API source of truth; regenerate clients after edits
- `README.md` — setup, credential fields, API use, and financial boundaries

## Architecture decisions

- Preserve the imported payment providers and existing database; do not replace
  the database or silently reassign legacy records to new merchants.
- Didit browser callbacks are navigation only. Verification requires a signed
  webhook or server-fetched provider decision; never let a UI status approve KYC.
- Administrator-managed FX rates support quotes only until an execution and
  liquidity provider is deliberately integrated. Do not fabricate trades,
  wallet credits, or completed settlements.
- Provider credentials entered by admins belong in the encrypted vault, never
  plaintext responses/logs. The stable vault master secret remains server
  configuration, not an admin-editable provider setting.

## Product

Merchant onboarding and verification, owned payment links and transaction
history, developer keys/webhooks, pricing and FX quotes, plus administrator
controls for merchants, providers, fees, rates, feature availability, and audit
history.

## Gotchas

- `ADMIN_EMAILS` authorizes verified Clerk accounts. Empty configuration must
  fail closed; never grant administrator access to the first signup.
- Database schema push is development-only. Production migrations require a
  separate reviewed deployment step.
- T+3 settlement dates are forecasts rather than guarantees.
- Changing the vault master secret requires a rotation migration or provider
  credential re-entry.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
