import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckoutPaymentLinkResponse,
  GetPublicPaymentLinkResponse,
  GetPublicTransactionStatusResponse,
  GetTransactionResponse,
} from "@workspace/api-zod";

const createdAt = "2026-10-01T00:00:00.000Z";

test("public payment links omit processing partners", () => {
  const result = GetPublicPaymentLinkResponse.parse({
    slug: "example-link",
    name: "Payment request",
    amountType: "fixed",
    amount: 10,
    currency: "USD",
    provider: "paystack",
    providerReference: "internal-reference",
  });
  assert.equal("provider" in result, false);
  assert.equal("providerReference" in result, false);
  assert.equal(result.amount, 10);
  assert.equal(result.currency, "USD");
});

test("public checkout sessions contain only customer instructions", () => {
  const result = CheckoutPaymentLinkResponse.parse({
    reference: "greenpay-reference",
    checkoutUrl: "https://payments.example.test/checkout",
    nextAction: "redirect",
    transaction: { provider: "paystack", customerEmail: "private@example.test" },
  });
  assert.deepEqual(result, {
    reference: "greenpay-reference",
    checkoutUrl: "https://payments.example.test/checkout",
    nextAction: "redirect",
  });
});

test("checkout instructions support mobile prompts and status checks without a gateway name", () => {
  for (const nextAction of ["mobile_prompt", "check_status"]) {
    const result = CheckoutPaymentLinkResponse.parse({
      reference: "greenpay-reference",
      checkoutUrl: null,
      nextAction,
    });
    assert.equal(result.nextAction, nextAction);
  }
  assert.equal(CheckoutPaymentLinkResponse.safeParse({
    reference: "greenpay-reference",
    checkoutUrl: null,
    nextAction: "payhero",
  }).success, false);
});

test("public payment status preserves payment facts but omits internal routing", () => {
  const result = GetPublicTransactionStatusResponse.parse({
    reference: "greenpay-reference",
    status: "success",
    amount: 10,
    currency: "USD",
    provider: "paystack",
    providerReference: "internal-reference",
    createdAt,
    paidAt: createdAt,
  });
  assert.equal("provider" in result, false);
  assert.equal("providerReference" in result, false);
  assert.equal(result.status, "success");
  assert.equal(result.amount, 10);
});

test("administrative transaction contracts retain provider information", () => {
  const result = GetTransactionResponse.parse({
    id: 1,
    reference: "greenpay-reference",
    status: "pending",
    amount: 10,
    currency: "USD",
    provider: "paystack",
    customerEmail: "customer@example.test",
    settlementStatus: "pending",
    createdAt,
  });
  assert.equal(result.provider, "paystack");
});