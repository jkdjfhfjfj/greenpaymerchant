import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECTION_CURRENCIES,
  hasCollectionAmountPrecision,
  ListSupportedCurrenciesResponse,
} from "@workspace/api-zod";
import { assertCollectionAmountPrecision } from "./greenpay-collection";
import {
  assertSupportedCurrency,
  collectionPaymentMethodsForCurrency,
  providerForCurrency,
  resolveCollectionPaymentMethod,
} from "./greenpay-provider";

test("the collection catalog preserves documented Payzaapi codes plus existing USD and KES routes", () => {
  assert.deepEqual(COLLECTION_CURRENCIES.map(({ code }) => code), [
    "USD", "KES", "NGN", "GHS", "TZS", "XOF", "RWF", "UGX", "ZMW",
    "MWK", "SLL", "CDF", "MZN", "XAF",
  ]);
  assert.deepEqual(COLLECTION_CURRENCIES.filter(({ minorUnits }) => minorUnits === 0).map(({ code }) => code), [
    "KES", "XOF", "RWF", "UGX", "XAF",
  ]);
});

test("currency routing is explicit and unknown codes cannot fall through to Payzaapi", () => {
  assert.equal(providerForCurrency("usd"), "paystack");
  assert.equal(providerForCurrency("KES"), "payhero");
  for (const { code } of COLLECTION_CURRENCIES.filter(({ code }) => code !== "USD" && code !== "KES")) {
    assert.equal(providerForCurrency(code), "payzaapi");
  }
  assert.throws(() => providerForCurrency("SLE"), /does not currently support SLE/);
  assert.throws(() => assertSupportedCurrency("ZAR"), /does not currently support ZAR/);
});

test("the public currency contract exposes amount precision and readiness, not route names", () => {
  const response = ListSupportedCurrenciesResponse.parse({
    items: COLLECTION_CURRENCIES.map(({ code, name, minorUnits }) => ({
      code, name, minorUnits, collectionReady: false,
      paymentMethods: collectionPaymentMethodsForCurrency(code, false),
    })),
  });
  assert.equal(response.items.length, 14);
  assert.equal(response.items.some((item) => "provider" in item || "gateway" in item), false);
  assert.equal(response.items.every((item) =>
    item.paymentMethods.length === 1 && item.paymentMethods[0]?.ready === item.collectionReady,
  ), true);
  assert.deepEqual(response.items.find((item) => item.code === "KES")?.paymentMethods[0], {
    id: "mobile_prompt",
    label: "Mobile money prompt",
    ready: false,
    requiresPhone: true,
    nextAction: "mobile_prompt",
  });
  assert.deepEqual(response.items.find((item) => item.code === "USD")?.paymentMethods[0], {
    id: "hosted_checkout",
    label: "Secure hosted checkout",
    ready: false,
    requiresPhone: false,
    nextAction: "redirect",
  });
});

test("payment-method selection stays currency-bound and does not disclose a gateway", () => {
  for (const { code } of COLLECTION_CURRENCIES) {
    const method = resolveCollectionPaymentMethod(code);
    assert.equal(method.id, code === "KES" ? "mobile_prompt" : "hosted_checkout");
    assert.throws(
      () => resolveCollectionPaymentMethod(code, code === "KES" ? "hosted_checkout" : "mobile_prompt"),
      /not available for this currency/,
    );
  }
  assert.throws(() => resolveCollectionPaymentMethod("KES", "payhero"), /not available/);
  assert.throws(() => resolveCollectionPaymentMethod("USD", "paystack"), /not available/);
});

test("collection amount precision accepts only allowed digits, including whole KES", () => {
  assert.equal(hasCollectionAmountPrecision(10, "KES"), true);
  assert.equal(hasCollectionAmountPrecision(10.01, "KES"), false);
  assert.equal(hasCollectionAmountPrecision(10.5, "USD"), true);
  assert.equal(hasCollectionAmountPrecision(10.001, "USD"), false);
  assert.equal(hasCollectionAmountPrecision(10, "XOF"), true);
  assert.equal(hasCollectionAmountPrecision(10.01, "XOF"), false);
  assert.equal(hasCollectionAmountPrecision(10, "RWF"), true);
  assert.equal(hasCollectionAmountPrecision(10.1, "RWF"), false);
  assert.throws(() => assertCollectionAmountPrecision(10.25, "KES"), /whole units/);
  assert.throws(() => assertCollectionAmountPrecision(10.01, "XAF"), /whole units/);
  assert.doesNotThrow(() => assertCollectionAmountPrecision(10.25, "USD"));
});