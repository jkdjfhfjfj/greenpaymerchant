import assert from "node:assert/strict";
import { test } from "node:test";
import { developerTransactionRequestFingerprint, idempotencyDisposition } from "./payment-safety";
import { resolveCollectionPaymentMethod } from "./greenpay-provider";

test("developer collection fingerprints include the effective payment method and normalize omitted defaults", () => {
  const input = {
    amount: 24.5,
    currency: "usd",
    customerEmail: " payer@example.test ",
  };
  const defaultMethod = resolveCollectionPaymentMethod(input.currency).id;
  const explicitDefaultMethod = resolveCollectionPaymentMethod(input.currency, "hosted_checkout").id;
  const defaultFingerprint = developerTransactionRequestFingerprint({
    ...input, paymentMethod: defaultMethod,
  });
  const explicitFingerprint = developerTransactionRequestFingerprint({
    ...input, paymentMethod: explicitDefaultMethod,
  });
  const otherMethodFingerprint = developerTransactionRequestFingerprint({
    ...input, paymentMethod: "mobile_prompt",
  });

  assert.equal(defaultFingerprint, explicitFingerprint);
  assert.notEqual(defaultFingerprint, otherMethodFingerprint);
  assert.equal(idempotencyDisposition({
    status: "completed",
    requestHashMatches: defaultFingerprint === explicitFingerprint,
    hasResponse: true,
  }), "replay");
  assert.equal(idempotencyDisposition({
    status: "completed",
    requestHashMatches: defaultFingerprint === otherMethodFingerprint,
    hasResponse: true,
  }), "mismatch");
});

test("developer collections reject an unsupported currency/method pair before it can be fingerprinted", () => {
  assert.throws(
    () => resolveCollectionPaymentMethod("USD", "mobile_prompt"),
    /not available for this currency/,
  );
  assert.throws(
    () => resolveCollectionPaymentMethod("KES", "hosted_checkout"),
    /not available for this currency/,
  );
});