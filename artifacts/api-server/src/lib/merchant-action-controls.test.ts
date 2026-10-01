import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MERCHANT_ACTION_CONTROLS,
  MERCHANT_ACTION_KEYS,
  merchantActionPolicyDenial,
  merchantActionRoleAllowed,
  normalizeMerchantActionControls,
  normalizePayoutSafetySettings,
  requiresManualPayoutReview,
  roleCanAccess,
} from "./merchant-access-policy";

const activeMerchant = {
  status: "active",
  paymentsEnabled: true,
  payoutsEnabled: true,
  refundsEnabled: true,
  apiAccessEnabled: true,
};
const enabledPlatform = {
  paymentsEnabled: true,
  payoutsEnabled: true,
  refundsEnabled: true,
  apiAccessEnabled: true,
};

test("all absent legacy controls preserve enabled behavior and explicitly expose every action", () => {
  const controls = normalizeMerchantActionControls(null);
  assert.deepEqual(controls, DEFAULT_MERCHANT_ACTION_CONTROLS);
  assert.equal(Object.keys(controls).length, MERCHANT_ACTION_KEYS.length);
  for (const action of MERCHANT_ACTION_KEYS) {
    assert.equal(merchantActionPolicyDenial({
      action, controls: null, merchant: activeMerchant, platform: enabledPlatform,
    }), undefined);
  }
});

test("granular controls compose with merchant and platform flags without bypassing them", () => {
  assert.match(merchantActionPolicyDenial({
    action: "createLinks",
    controls: { createLinks: false },
    merchant: activeMerchant,
    platform: enabledPlatform,
  }) ?? "", /disabled createLinks/);
  assert.match(merchantActionPolicyDenial({
    action: "collect",
    controls: { collect: true },
    merchant: { ...activeMerchant, paymentsEnabled: false },
    platform: enabledPlatform,
  }) ?? "", /disabled for this merchant/);
  assert.match(merchantActionPolicyDenial({
    action: "payoutRequests",
    controls: { payoutRequests: true },
    merchant: activeMerchant,
    platform: { ...enabledPlatform, payoutsEnabled: false },
  }) ?? "", /currently disabled/);
});

test("suspended merchants cannot mutate while accountant historical reads stay allowed", () => {
  assert.match(merchantActionPolicyDenial({
    action: "refundRequests",
    controls: DEFAULT_MERCHANT_ACTION_CONTROLS,
    merchant: { ...activeMerchant, status: "suspended" },
    platform: enabledPlatform,
  }) ?? "", /not active/);
  assert.equal(roleCanAccess("viewer", "read"), true);
  assert.equal(roleCanAccess("viewer", "finance"), false);
  assert.equal(merchantActionRoleAllowed("viewer", "invoices"), false);
  assert.equal(merchantActionRoleAllowed("finance", "invoices"), true);
  assert.equal(merchantActionRoleAllowed("finance", "destinationChanges"), true);
  assert.equal(merchantActionRoleAllowed("finance", "teamManagement"), false);
});

test("missing payout policy uses manual-review safety and mandatory destination approval", () => {
  const defaults = normalizePayoutSafetySettings(null);
  assert.deepEqual(defaults.largePayoutThresholds, {});
  assert.equal(defaults.dualApprovalEnabled, true);
  assert.equal(defaults.destinationChangeRequiresDualApproval, true);
  assert.equal(requiresManualPayoutReview(defaults, "USD", 1), true);
  assert.equal(requiresManualPayoutReview({
    ...defaults, largePayoutThresholds: { USD: 100 },
  }, "USD", 99), false);
  assert.equal(requiresManualPayoutReview({
    ...defaults, largePayoutThresholds: { USD: 100 },
  }, "USD", 100), true);
  assert.equal(requiresManualPayoutReview({
    ...defaults, largePayoutThresholds: { USD: 100 },
  }, "KES", 5), true);
  assert.equal(normalizePayoutSafetySettings({
    destinationChangeRequiresDualApproval: false,
  }).destinationChangeRequiresDualApproval, true);
});