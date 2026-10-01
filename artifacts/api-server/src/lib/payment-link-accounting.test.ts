import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentLinkCurrencyTotals } from "./payment-link-accounting";

test("payment-link scalar totals only include the link currency and retain separate currency totals", () => {
  const totals = paymentLinkCurrencyTotals("usd", [
    { currency: "NGN", amount: "12500.00" },
    { currency: "KES", amount: 800 },
    { currency: "USD", amount: "29.95" },
  ]);
  assert.equal(totals.totalPaid, 29.95);
  assert.deepEqual(totals.totalPaidByCurrency, [
    { currency: "USD", amount: 29.95 },
    { currency: "KES", amount: 800 },
    { currency: "NGN", amount: 12500 },
  ]);
  assert.notEqual(totals.totalPaid, 29.95 + 800 + 12500);
});

test("payment-link totals default the native currency scalar to zero and merge duplicate currency rows", () => {
  assert.deepEqual(paymentLinkCurrencyTotals("GHS", [
    { currency: "ngn", amount: 0.1 },
    { currency: "NGN", amount: 0.2 },
  ]), {
    totalPaid: 0,
    totalPaidByCurrency: [{ currency: "NGN", amount: 0.3 }],
  });
  assert.deepEqual(paymentLinkCurrencyTotals("KES", []), {
    totalPaid: 0,
    totalPaidByCurrency: [],
  });
});

test("payment-link accounting rejects malformed monetary totals", () => {
  assert.throws(() => paymentLinkCurrencyTotals("USD", [{ currency: "", amount: 1 }]), /currency code/);
  assert.throws(() => paymentLinkCurrencyTotals("USD", [{ currency: "USD", amount: Number.NaN }]), /finite non-negative/);
  assert.throws(() => paymentLinkCurrencyTotals("USD", [{ currency: "USD", amount: -1 }]), /finite non-negative/);
});