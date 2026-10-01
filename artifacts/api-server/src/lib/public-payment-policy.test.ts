import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicCheckoutFailure,
  resolvePublicCheckoutAmount,
  resolvePublicCheckoutCurrency,
} from "./public-payment-policy";

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

test("customer-choice links accept supported customer-selected currencies without converting", () => {
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "USD",
    amountType: "customer_choice",
    isInvoice: false,
    requestedCurrency: "ngn",
  }), { currency: "NGN" });
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "KES",
    amountType: "customer_choice",
    isInvoice: false,
  }), { currency: "KES" });
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "USD",
    amountType: "customer_choice",
    isInvoice: false,
    requestedCurrency: "ZAR",
  }), { error: "unsupported_currency" });
});

test("fixed-price and invoice links reject a currency different from their listed currency", () => {
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "USD",
    amountType: "fixed",
    isInvoice: false,
    requestedCurrency: "KES",
  }), { error: "fixed_currency_immutable" });
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "USD",
    amountType: "customer_choice",
    isInvoice: true,
    requestedCurrency: "KES",
  }), { error: "fixed_currency_immutable" });
  assert.deepEqual(resolvePublicCheckoutCurrency({
    linkCurrency: "USD",
    amountType: "fixed",
    isInvoice: false,
    requestedCurrency: "usd",
  }), { currency: "USD" });
});

test("public checkout distinguishes payer validation errors from hidden payment-route failures", () => {
  assert.deepEqual(publicCheckoutFailure(400, "Enter a valid phone number."), {
    status: 400,
    error: "Enter a valid phone number.",
  });
  assert.deepEqual(publicCheckoutFailure(409, "This link is no longer current."), {
    status: 409,
    error: "This link is no longer current.",
  });
  const unavailable = publicCheckoutFailure(502, "A private adapter error.");
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.error, /Payments are unavailable for the selected currency/);
  assert.doesNotMatch(unavailable.error, /private|adapter/i);
});