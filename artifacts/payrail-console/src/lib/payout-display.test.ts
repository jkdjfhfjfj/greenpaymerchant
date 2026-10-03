import assert from "node:assert/strict";
import { test } from "node:test";
import { hidePayoutProviderName, payoutDisplayLabel } from "./payout-display";

test("payout display labels hide the configured provider brand", () => {
  assert.equal(payoutDisplayLabel("payzaapi"), "External payout service");
  assert.equal(payoutDisplayLabel("PAYZA_API"), "External payout service");
  assert.equal(payoutDisplayLabel("bank_transfer"), "Bank Transfer");
});

test("payout error copy hides the configured provider brand without changing other text", () => {
  assert.equal(
    hidePayoutProviderName("PAYZAAPI transfer failed"),
    "External payout service transfer failed",
  );
  assert.equal(hidePayoutProviderName("Invalid account number"), "Invalid account number");
});