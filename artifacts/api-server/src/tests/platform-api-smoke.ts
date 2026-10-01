/**
 * Development-only API contract smoke check.
 * Requires a running development API and PAYRAIL_SMOKE_API_URL ending in /api.
 * Uses temporary merchant/key/link fixtures and removes them even on failure.
 * Does not initiate payments, refunds, payouts, or verification-provider calls.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db, pool, merchantsTable, merchantApiKeysTable, merchantInvoicesTable, paymentLinksTable, transactionsTable,
} from "@workspace/db";
import { DEFAULT_MERCHANT_ACTION_CONTROLS } from "../lib/merchant-access-policy";

const url = process.env.PAYRAIL_SMOKE_API_URL;
if (!url || process.env.NODE_ENV === "production") {
  throw new Error("Provide a development PAYRAIL_SMOKE_API_URL; production is forbidden.");
}
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) && !target.hostname.endsWith(".replit.dev")) {
  throw new Error("The smoke test only permits localhost or a Replit development URL.");
}
const base = target.toString().replace(/\/$/, "");
const fixtureIds: number[] = [];
const marker = `smoke_${randomUUID()}`;
let checks = 0;

async function request(secret: string, path: string, method = "GET", data?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as {
    merchant?: { id: number };
    items?: Array<{ id: number; name: string }>;
    id?: number;
    error?: string;
    schedule?: unknown;
  };
  return { status: response.status, body };
}

async function publicRequest(path: string, method = "GET", data?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : target.origin,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { status: response.status, body };
}

function check(actual: unknown, expected: unknown, description: string) {
  assert.deepEqual(actual, expected, description);
  checks += 1;
  console.log(`PASS ${description}`);
}

async function makeKey(merchantId: number, scopes: string[]) {
  const secret = `gp_live_${randomBytes(32).toString("hex")}`;
  const [key] = await db.insert(merchantApiKeysTable).values({
    merchantId,
    name: marker,
    prefix: secret.slice(0, 16),
    secretHash: createHash("sha256").update(secret).digest("hex"),
    scopes,
  }).returning({ id: merchantApiKeysTable.id });
  return { secret, id: key.id };
}

async function main() {
  const fixtures = await db.insert(merchantsTable).values([
    { ownerClerkId: `${marker}_a`, businessName: `${marker} A`, country: "KE", baseCurrency: "USD", status: "active", kycStatus: "approved" },
    { ownerClerkId: `${marker}_b`, businessName: `${marker} B`, country: "KE", baseCurrency: "USD", status: "active", kycStatus: "approved" },
  ]).returning({ id: merchantsTable.id });
  fixtureIds.push(...fixtures.map((merchant) => merchant.id));
  const [a, b] = fixtures;
  const keyA = await makeKey(a.id, ["read", "payment_links:write", "payments:write"]);
  const keyB = await makeKey(b.id, ["read", "payment_links:write"]);
  const readOnlyB = await makeKey(b.id, ["read"]);

  const invoiceReference = `${marker}_invoice`;
  const pendingReference = `${marker}_pending_invoice`;
  const [invoiceLink] = await db.insert(paymentLinksTable).values({
    slug: `${marker}_invoice_link`,
    name: `${marker} invoice link`,
    amountType: "fixed",
    amount: 100,
    currency: "USD",
    merchantId: a.id,
    status: "active",
  }).returning({ id: paymentLinksTable.id, slug: paymentLinksTable.slug });
  await db.insert(merchantInvoicesTable).values({
    merchantId: a.id,
    reference: invoiceReference,
    customerName: "Smoke Test Customer",
    customerEmail: "smoke@example.test",
    currency: "USD",
    dueDate: "2030-01-01",
    lines: [{ description: "Smoke invoice", quantity: 1, unitAmount: 100, total: 100 }],
    subtotal: 100,
    total: 100,
    paymentLinkAmount: 100,
    status: "sent",
    paymentLinkId: invoiceLink.id,
  });
  await db.insert(transactionsTable).values({
    reference: pendingReference,
    provider: "paystack",
    amount: 100,
    currency: "USD",
    customerEmail: "smoke@example.test",
    merchantId: a.id,
    paymentLinkId: invoiceLink.id,
    status: "pending",
  });
  const invoicePage = await publicRequest(`/public/payment-links/${invoiceLink.slug}`);
  check(invoicePage.status, 200, "an invoice link remains readable while an existing collection awaits confirmation");
  check(invoicePage.body?.invoiceOutstandingAmount, 100,
    "invoice checkout exposes the outstanding amount even while a prior collection is pending");
  const duplicateInvoiceCheckout = await publicRequest(`/public/payment-links/${invoiceLink.slug}/checkout`, "POST", {
    customerEmail: "smoke@example.test", amount: 25,
  });
  check(duplicateInvoiceCheckout.status, 409,
    `a pending invoice collection blocks duplicate checkout before any provider call (${duplicateInvoiceCheckout.body?.error ?? "no error"})`);

  const profile = await request(keyA.secret, "/v1/merchant");
  check(profile.status, 200, "developer key authenticates without a Clerk session");
  check(profile.body.merchant?.id, a.id, "profile belongs to the key's merchant");

  const linkA = await request(keyA.secret, "/v1/payment-links", "POST", {
    name: `${marker} link A`, amountType: "fixed", amount: 10, currency: "USD",
  });
  const linkB = await request(keyB.secret, "/v1/payment-links", "POST", {
    name: `${marker} link B`, amountType: "fixed", amount: 20, currency: "USD",
  });
  check(linkA.status, 201, "merchant A can create a real persisted link");
  check(linkB.status, 201, "merchant B can create a real persisted link");

  const listA = await request(keyA.secret, "/v1/payment-links");
  const listB = await request(keyB.secret, "/v1/payment-links");
  check(listA.body.items?.map((link) => link.id), [linkA.body.id, invoiceLink.id],
    "merchant A reads its own invoice and payment links but cannot read merchant B or legacy links");
  check(listB.body.items?.map((link) => link.id), [linkB.body.id], "merchant B cannot read merchant A or legacy links");
  const stored = await db.select({ merchantId: paymentLinksTable.merchantId })
    .from(paymentLinksTable).where(eq(paymentLinksTable.id, linkA.body.id!));
  check(stored[0]?.merchantId, a.id, "link ownership is persisted by the server");

  const denied = await request(readOnlyB.secret, "/v1/payment-links", "POST", {
    name: `${marker} prohibited`, amountType: "fixed", amount: 5, currency: "USD",
  });
  check(denied.status, 403, "read-only keys cannot create links");
  await db.update(merchantsTable).set({
    merchantActionControls: { ...DEFAULT_MERCHANT_ACTION_CONTROLS, createLinks: false },
  }).where(eq(merchantsTable.id, b.id));
  const granularDenied = await request(keyB.secret, "/v1/payment-links", "POST", {
    name: `${marker} action-disabled`, amountType: "fixed", amount: 5, currency: "USD",
  });
  check(granularDenied.status, 403, "direct API requests cannot bypass a disabled per-merchant create-links action");
  check((await request(keyB.secret, "/v1/payment-links")).status, 200,
    "disabled create-links actions preserve historical read access");
  await db.update(merchantsTable).set({
    merchantActionControls: { ...DEFAULT_MERCHANT_ACTION_CONTROLS, createLinks: true },
    paymentsEnabled: false,
  }).where(eq(merchantsTable.id, b.id));
  check((await request(keyB.secret, "/v1/payment-links", "POST", {
    name: `${marker} legacy-flag-disabled`, amountType: "fixed", amount: 5, currency: "USD",
  })).status, 403, "a granular allow cannot bypass the legacy merchant payments switch");
  await db.update(merchantsTable).set({ paymentsEnabled: true }).where(eq(merchantsTable.id, b.id));
  check((await request(readOnlyB.secret, "/v1/transactions/nonexistent/verify", "POST")).status, 403,
    "provider verification requires payment-write scope");
  check((await request(keyA.secret, "/v1/transactions/nonexistent")).status, 404,
    "unknown payments do not expose another merchant's data");
  check((await request(keyA.secret, "/v1/fees")).status, 200, "merchant pricing is readable through the API");
  check((await request(keyA.secret, "/v1/fx-quote?amount=-1&from=USD&to=KES")).status, 400,
    "invalid FX inputs are rejected");

  await db.update(merchantsTable).set({ apiAccessEnabled: false }).where(eq(merchantsTable.id, b.id));
  check((await request(keyB.secret, "/v1/merchant")).status, 403, "merchant API switch is enforced");
  await db.update(merchantsTable).set({ apiAccessEnabled: true, status: "suspended" }).where(eq(merchantsTable.id, b.id));
  check((await request(keyB.secret, "/v1/merchant")).status, 403, "suspended merchants cannot use developer keys");
  await db.update(merchantApiKeysTable).set({ revokedAt: new Date() }).where(eq(merchantApiKeysTable.id, keyA.id));
  check((await request(keyA.secret, "/v1/merchant")).status, 401, "key revocation takes effect immediately");
  console.log(`${checks} development API checks passed; no provider money operations were called.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "API smoke check failed.");
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (fixtureIds.length) {
      await db.delete(transactionsTable).where(eq(transactionsTable.reference, `${marker}_pending_invoice`));
      await db.delete(merchantInvoicesTable).where(eq(merchantInvoicesTable.reference, `${marker}_invoice`));
      await db.delete(paymentLinksTable).where(inArray(paymentLinksTable.merchantId, fixtureIds));
      await db.delete(merchantApiKeysTable).where(inArray(merchantApiKeysTable.merchantId, fixtureIds));
      await db.delete(merchantsTable).where(inArray(merchantsTable.id, fixtureIds));
    }
    console.log("Temporary smoke fixtures removed.");
  } finally {
    await pool.end();
  }
});