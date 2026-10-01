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
  db, pool, merchantsTable, merchantApiKeysTable, paymentLinksTable,
} from "@workspace/db";

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
  check(listA.body.items?.map((link) => link.id), [linkA.body.id], "merchant A cannot read merchant B or legacy links");
  check(listB.body.items?.map((link) => link.id), [linkB.body.id], "merchant B cannot read merchant A or legacy links");
  const stored = await db.select({ merchantId: paymentLinksTable.merchantId })
    .from(paymentLinksTable).where(eq(paymentLinksTable.id, linkA.body.id!));
  check(stored[0]?.merchantId, a.id, "link ownership is persisted by the server");

  const denied = await request(readOnlyB.secret, "/v1/payment-links", "POST", {
    name: `${marker} prohibited`, amountType: "fixed", amount: 5, currency: "USD",
  });
  check(denied.status, 403, "read-only keys cannot create links");
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
      await db.delete(paymentLinksTable).where(inArray(paymentLinksTable.merchantId, fixtureIds));
      await db.delete(merchantApiKeysTable).where(inArray(merchantApiKeysTable.merchantId, fixtureIds));
      await db.delete(merchantsTable).where(inArray(merchantsTable.id, fixtureIds));
    }
    console.log("Temporary smoke fixtures removed.");
  } finally {
    await pool.end();
  }
});