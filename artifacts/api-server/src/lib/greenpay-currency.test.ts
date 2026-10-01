import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECTION_CURRENCIES,
  hasCollectionAmountPrecision,
  ListSupportedCurrenciesResponse,
} from "@workspace/api-zod";
import { assertCollectionAmountPrecision } from "./greenpay-collection";
import { assertSupportedCurrency, providerForCurrency } from "./greenpay-provider";

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
    })),
  });
  assert.equal(response.items.length, 14);
  assert.equal(response.items.some((item) => "provider" in item || "gateway" in item), false);
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