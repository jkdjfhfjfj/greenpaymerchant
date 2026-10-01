import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePublicCheckoutAmount } from "./public-payment-policy";

test("invoice checkout defaults to the outstanding balance or allows a smaller partial amount", () => {
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "fixed",
    fixedAmount: 250,
    invoiceOutstandingAmount: 250,
  }), { amount: 250 });
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "fixed",
    fixedAmount: 250,
    requestedAmount: 45,
    invoiceOutstandingAmount: 250,
  }), { amount: 45 });
});

test("invoice checkout rejects nonpositive amounts and amounts above the current outstanding balance", () => {
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "fixed",
    fixedAmount: 250,
    requestedAmount: 0,
    invoiceOutstandingAmount: 250,
  }), { error: "positive_amount_required" });
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "fixed",
    fixedAmount: 250,
    requestedAmount: 251,
    invoiceOutstandingAmount: 250,
  }), { error: "amount_exceeds_invoice_balance" });
});

test("ordinary fixed links retain their stored amount regardless of an optional request amount", () => {
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "fixed",
    fixedAmount: 120,
    requestedAmount: 20,
    invoiceOutstandingAmount: null,
  }), { amount: 120 });
});

test("ordinary customer-choice links continue to use the customer amount", () => {
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "customer_choice",
    fixedAmount: null,
    requestedAmount: 37,
    invoiceOutstandingAmount: null,
  }), { amount: 37 });
  assert.deepEqual(resolvePublicCheckoutAmount({
    amountType: "customer_choice",
    fixedAmount: null,
    invoiceOutstandingAmount: null,
  }), { error: "positive_amount_required" });
});