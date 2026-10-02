import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateWalletConversion,
  canApplyWalletRefundAdjustment,
  canReserveWalletFunds,
  decimalToMinor,
  eligibleSettlementFunding,
  payoutProviderOutcome,
  payoutNeedsSecondApproval,
  proportionalNetRefundReversal,
  shouldReleasePayoutHold,
} from "./wallet-math";

test("wallet money conversion uses integer minor units without binary rounding", () => {
  assert.equal(decimalToMinor("0.10"), 10n);
  assert.equal(decimalToMinor("125.01"), 12_501n);
  assert.throws(() => decimalToMinor("1.001"), /decimal places/);
  const converted = calculateWalletConversion({
    sourceMinor: 10_000n,
    sourceRate: "1.234500000000",
    markupBps: 100,
    feePercentage: "1.25",
    flatFeeMinor: 25n,
  });
  assert.equal(converted.grossTargetMinor, 12_222n);
  assert.equal(converted.feeMinor, 178n);
  assert.equal(converted.targetMinor, 12_044n);
});

test("wallet conversion separates system margin, schedule markup, fees, and net credit exactly", () => {
  const converted = calculateWalletConversion({
    sourceMinor: 10_000n,
    sourceRate: "2.000000000000",
    markupBps: 300,
    systemMarginBps: 200,
    feePercentage: "1",
    flatFeeMinor: 25n,
  });
  assert.equal(converted.marketTargetMinor, 20_000n);
  assert.equal(converted.totalMarkupMinor, 600n);
  assert.equal(converted.systemMarginMinor, 400n);
  assert.equal(converted.scheduleMarkupMinor, 200n);
  assert.equal(converted.feeMinor, 219n);
  assert.equal(converted.targetMinor, 19_181n);
  assert.equal(
    converted.systemMarginMinor + converted.scheduleMarkupMinor + converted.feeMinor + converted.targetMinor,
    converted.marketTargetMinor,
  );
});

test("pre- and post-funding refunds use the same proportional reversal against eligible net", () => {
  assert.equal(eligibleSettlementFunding({
    confirmedNetMinor: 8_000n, confirmedRefundMinor: 1_000n,
    originalAmountMinor: 10_000n, previouslyFundedMinor: 0n,
  }), 7_200n);
  const prefundingReversal = proportionalNetRefundReversal(8_000n, 1_000n, 10_000n);
  const postfundingTarget = proportionalNetRefundReversal(8_000n, 2_000n, 10_000n);
  assert.equal(prefundingReversal, 800n);
  assert.equal(postfundingTarget - prefundingReversal, 800n);
  assert.equal(eligibleSettlementFunding({
    confirmedNetMinor: 1_000n, confirmedRefundMinor: 7_000n,
    originalAmountMinor: 10_000n, previouslyFundedMinor: 500n,
  }), 0n);
});

test("atomic wallet reservations must cover the entire hold", () => {
  assert.equal(canReserveWalletFunds(10_000n, 5_000n), true);
  assert.equal(canReserveWalletFunds(4_999n, 5_000n), false);
  assert.equal(canReserveWalletFunds(10_000n, 0n), false);
});

test("large payout approval threshold is per currency, fail-closed when missing, and retains cents", () => {
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("50.01"),
    largePayoutThresholdMinor: decimalToMinor("50.00"),
    thresholdConfigured: true,
    destinationIsApproved: true,
  }), true);
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("50.00"),
    largePayoutThresholdMinor: decimalToMinor("50.00"),
    thresholdConfigured: true,
    destinationIsApproved: true,
  }), true);
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("49.99"),
    largePayoutThresholdMinor: decimalToMinor("50.00"),
    thresholdConfigured: true,
    destinationIsApproved: true,
  }), false);
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("1.00"),
    largePayoutThresholdMinor: decimalToMinor("50.00"),
    thresholdConfigured: true,
    destinationIsApproved: true,
    dualApprovalEnabled: true,
  }), true);
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("0.01"),
    largePayoutThresholdMinor: null,
    thresholdConfigured: false,
    destinationIsApproved: true,
  }), true);
  assert.equal(payoutNeedsSecondApproval({
    amountMinor: decimalToMinor("0.01"),
    largePayoutThresholdMinor: decimalToMinor("500.00"),
    thresholdConfigured: true,
    destinationIsApproved: false,
  }), true);
});

test("provider payout uncertainty retains the hold and is never treated as a rejection", () => {
  assert.equal(payoutProviderOutcome({ accepted: undefined, providerReference: "P-UNKNOWN" }), "uncertain");
  assert.equal(payoutProviderOutcome({ accepted: true, providerReference: null }), "uncertain");
  assert.equal(payoutProviderOutcome({ accepted: true, providerReference: "P-1", providerStatus: "pending" }), "processing");
  assert.equal(payoutProviderOutcome({ accepted: true, providerReference: "P-1", providerStatus: "completed" }), "completed");
  assert.equal(payoutProviderOutcome({ accepted: false }), "failed");
  assert.equal(shouldReleasePayoutHold("uncertain"), false);
  assert.equal(shouldReleasePayoutHold("processing"), false);
  assert.equal(shouldReleasePayoutHold("failed"), true);
});

test("credited refund amounts cannot exceed funds still available to reverse", () => {
  assert.equal(canApplyWalletRefundAdjustment(2_500n, 2_500n), true);
  assert.equal(canApplyWalletRefundAdjustment(2_499n, 2_500n), false);
});