import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKeyHash, decryptSecret, encryptSecret } from "./secret-crypto";
import { calculateFxQuote } from "./fx-math";
import {
  featureIsEnabled, hasRequiredScope, merchantCapabilityIsEnabled,
  ownsMerchantRecord, timestampIsFresh, developerApiStatusAllowed,
  paymentTransitionAllowed, diditCanonicalStatus,
} from "./security-policy";
import {
  CUSTOMER_REIMBURSED_REFUND_STATUSES,
  idempotencyDisposition,
  paystackRefundOutcome,
  providerPaymentEvidenceMatches,
  remainingRefundableAmount,
} from "./payment-safety";
import { createPinnedWebhookLookup, isPrivateAddress } from "./network-safety";
import { isVersionedApiPath, mutationRequiresSameOrigin, originIsAllowed } from "./origin-policy";

test("API keys are represented by a SHA-256 digest, not the bearer value", () => {
  const bearer = "gp_live_0123456789012345678901234567890123456789";
  const digest = apiKeyHash(bearer);
  assert.equal(digest.length, 64);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, bearer);
});

test("vault encryption authenticates ciphertext and fails closed without a valid tag", () => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = "unit-test-only-key";
  const serialized = encryptSecret("provider-private-value");
  assert.notEqual(serialized, "provider-private-value");
  assert.equal(decryptSecret(serialized), "provider-private-value");
  const [iv, tag, encrypted] = serialized.split(".");
  assert.throws(() => decryptSecret(`${iv}.${tag}.${encrypted.slice(0, -2)}AA`));
});

test("Didit timestamp freshness accepts only recent epoch seconds or milliseconds", () => {
  const now = 1_700_000_000_000;
  assert.equal(timestampIsFresh(String(now / 1000), now), true);
  assert.equal(timestampIsFresh(String(now - 300_001), now), false);
  assert.equal(timestampIsFresh("not-a-timestamp", now), false);
});

test("FX quote applies manual rate, markup, percentage, and flat platform fee", () => {
  const quote = calculateFxQuote(100, 1.2, 2, 1, 100);
  assert.equal(quote.effectiveRate, 1.188);
  assert.equal(quote.platformFee, 3.38);
  assert.equal(quote.convertedAmount, 115.42);
});

test("scope, tenant and feature guards fail closed", () => {
  assert.equal(hasRequiredScope(["read"], "read"), true);
  assert.equal(hasRequiredScope(["read"], "payments:write"), false);
  assert.equal(ownsMerchantRecord(7, 7), true);
  assert.equal(ownsMerchantRecord(null, 7), false);
  assert.equal(ownsMerchantRecord(8, 7), false);
  assert.equal(featureIsEnabled({ paymentsEnabled: true }, "paymentsEnabled"), true);
  assert.equal(featureIsEnabled({}, "paymentsEnabled"), false);
  assert.equal(merchantCapabilityIsEnabled({ refundsEnabled: false }, "refundsEnabled"), false);
});

test("route policy never treats a bearer header as a cookie-CSRF exemption", () => {
  assert.equal(mutationRequiresSameOrigin("POST", "/public/checkout"), true);
  assert.equal(mutationRequiresSameOrigin("POST", "/merchant/profile"), true);
  assert.equal(mutationRequiresSameOrigin("POST", "/v1/transactions"), false);
  assert.equal(mutationRequiresSameOrigin("POST", "/v10/transactions"), true);
  assert.equal(isVersionedApiPath("/v1"), true);
  assert.equal(isVersionedApiPath("/v1evil"), false);
});

test("CORS and cookie mutations accept only exact configured origins", () => {
  const allowed = ["https://merchant.example", "https://app.example:8443"];
  assert.equal(originIsAllowed("https://merchant.example", allowed), true);
  assert.equal(originIsAllowed("https://merchant.example.attacker.invalid", allowed), false);
  assert.equal(originIsAllowed("https://merchant.example/evil", allowed), false);
  assert.equal(originIsAllowed("null", allowed), false);
  assert.equal(originIsAllowed(undefined, allowed), false);
});

test("developer route access blocks non-active merchant states centrally", () => {
  assert.equal(developerApiStatusAllowed("active"), true);
  for (const status of ["pending", "suspended", "closed", "rejected"]) {
    assert.equal(developerApiStatusAllowed(status), false);
  }
});

test("concurrent success and failure callbacks can produce only one terminal transition", async () => {
  let state = "pending";
  const attempt = async (next: string) => {
    await Promise.resolve();
    if (!paymentTransitionAllowed(state, next)) return false;
    state = next;
    return true;
  };
  const winners = await Promise.all([attempt("success"), attempt("failed")]);
  assert.equal(winners.filter(Boolean).length, 1);
  assert.ok(["success", "failed"].includes(state));
  assert.equal(paymentTransitionAllowed(state, state === "success" ? "failed" : "success"), false);
});

test("canonical Didit state can revoke approval when the authoritative decision changes", () => {
  assert.equal(diditCanonicalStatus("Approved"), "approved");
  assert.equal(diditCanonicalStatus("Expired"), "expired");
  assert.equal(diditCanonicalStatus("Declined"), "declined");
  assert.equal(diditCanonicalStatus("unknown"), undefined);
});

test("provider success requires matching reference, amount, and currency evidence", () => {
  const evidence = {
    expectedReference: "GP-123",
    reportedReference: "GP-123",
    expectedAmount: 10,
    reportedAmount: 1000,
    amountDivisor: 100,
    expectedCurrency: "USD",
    reportedCurrency: "usd",
  };
  assert.equal(providerPaymentEvidenceMatches(evidence), true);
  assert.equal(providerPaymentEvidenceMatches({ ...evidence, reportedAmount: undefined }), false);
  assert.equal(providerPaymentEvidenceMatches({ ...evidence, reportedCurrency: undefined }), false);
  assert.equal(providerPaymentEvidenceMatches({ ...evidence, reportedReference: "other" }), false);
});

test("refund accounting counts only customer-reimbursed terminal states", () => {
  assert.deepEqual(CUSTOMER_REIMBURSED_REFUND_STATUSES, ["success", "completed", "processed"]);
  assert.equal(paystackRefundOutcome({
    status: "processing", reportedAmount: 1000, requestedAmount: 10,
    reportedCurrency: "USD", expectedCurrency: "USD",
  }), "pending");
  assert.equal(paystackRefundOutcome({
    status: "processed", reportedAmount: 1000, requestedAmount: 10,
    reportedCurrency: "USD", expectedCurrency: "USD",
  }), "success");
  assert.equal(paystackRefundOutcome({
    status: "processed", reportedAmount: 1000, requestedAmount: 10,
    reportedCurrency: undefined, expectedCurrency: "USD",
  }), "pending");
  assert.equal(paystackRefundOutcome({
    status: "processed", reportedAmount: 900, requestedAmount: 10,
    reportedCurrency: "USD", expectedCurrency: "USD",
  }), "pending");
  assert.equal(remainingRefundableAmount(100, 98), 2);
  assert.equal(remainingRefundableAmount(100, 105), 0);
});

test("idempotency disposition replays only saved compatible outcomes", () => {
  assert.equal(idempotencyDisposition({
    status: "completed", requestHashMatches: false, hasResponse: true,
  }), "mismatch");
  assert.equal(idempotencyDisposition({
    status: "completed", requestHashMatches: true, hasResponse: true,
  }), "replay");
  assert.equal(idempotencyDisposition({
    status: "in_flight", requestHashMatches: true, hasResponse: false,
  }), "in_flight");
  assert.equal(idempotencyDisposition({
    status: "uncertain", requestHashMatches: true, hasResponse: false,
  }), "uncertain");
});

test("webhook destination checks reject private IPv4, IPv6, and mapped addresses", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fe90::1"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.1.10"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
});

test("webhook connection lookup stays pinned to the DNS-validated address", async () => {
  const lookup = createPinnedWebhookLookup({ address: "93.184.216.34", family: 4 });
  const resolve = lookup as unknown as (
    hostname: string,
    options: { all?: boolean },
    callback: (...values: unknown[]) => void,
  ) => void;
  const result = await new Promise<unknown[]>((done) => {
    resolve("attacker.example", { all: false }, (...values) => done(values));
  });
  assert.deepEqual(result, [null, "93.184.216.34", 4]);
});