export const WALLET_RATE_SCALE = 1_000_000_000_000n;
const WALLET_PERCENT_SCALE = 10_000n;

export function decimalToMinor(value: number | string, fractionDigits = 2): bigint {
  const text = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length ?? 0) > fractionDigits) {
    throw new Error(`Enter a non-negative amount with no more than ${fractionDigits} decimal places.`);
  }
  const scale = 10n ** BigInt(fractionDigits);
  const fraction = (match[2] ?? "").padEnd(fractionDigits, "0");
  return BigInt(match[1]) * scale + BigInt(fraction || "0");
}

export function minorToDecimal(minor: bigint, fractionDigits = 2): string {
  const negative = minor < 0n;
  const value = negative ? -minor : minor;
  const scale = 10n ** BigInt(fractionDigits);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(fractionDigits, "0");
  return `${negative ? "-" : ""}${whole}${fractionDigits ? `.${fraction}` : ""}`;
}

export function minorToNumber(minor: bigint, fractionDigits = 2): number {
  return Number(minorToDecimal(minor, fractionDigits));
}

export function decimalToScaled(value: number | string, scaleDigits: number): bigint {
  const text = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length ?? 0) > scaleDigits) {
    throw new Error("The provider returned an invalid exchange rate.");
  }
  return BigInt(match[1]) * 10n ** BigInt(scaleDigits) +
    BigInt((match[2] ?? "").padEnd(scaleDigits, "0") || "0");
}

export function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error("Invalid money calculation.");
  return (numerator + denominator / 2n) / denominator;
}

export function calculateWalletConversion(input: {
  sourceMinor: bigint;
  sourceRate: number | string;
  markupBps: number;
  feePercentage: number | string;
  flatFeeMinor: bigint;
}) {
  if (input.sourceMinor <= 0n || !Number.isInteger(input.markupBps) ||
      input.markupBps < 0 || input.markupBps > 10_000 || input.flatFeeMinor < 0n) {
    throw new Error("Invalid wallet conversion inputs.");
  }
  const sourceRateScaled = decimalToScaled(input.sourceRate, 12);
  const percentageScaled = decimalToScaled(input.feePercentage, 4);
  if (sourceRateScaled <= 0n || percentageScaled > 1_000_000n) {
    throw new Error("Invalid wallet conversion rate or fee schedule.");
  }
  const effectiveRateScaled = roundDivide(
    sourceRateScaled * BigInt(10_000 - input.markupBps),
    10_000n,
  );
  const grossTargetMinor = roundDivide(input.sourceMinor * effectiveRateScaled, WALLET_RATE_SCALE);
  const feeMinor = roundDivide(grossTargetMinor * percentageScaled, 100n * WALLET_PERCENT_SCALE) +
    input.flatFeeMinor;
  const targetMinor = grossTargetMinor - feeMinor;
  if (targetMinor <= 0n) throw new Error("The conversion fees consume the entire quoted amount.");
  return { effectiveRateScaled, grossTargetMinor, feeMinor, targetMinor };
}

export function eligibleSettlementFunding(input: {
  confirmedNetMinor: bigint;
  confirmedRefundMinor: bigint;
  originalAmountMinor: bigint;
  previouslyFundedMinor: bigint;
}): bigint {
  const refundReversal = proportionalNetRefundReversal(
    input.confirmedNetMinor, input.confirmedRefundMinor, input.originalAmountMinor,
  );
  const remaining = input.confirmedNetMinor - refundReversal - input.previouslyFundedMinor;
  return remaining > 0n ? remaining : 0n;
}

export function proportionalNetRefundReversal(
  eligibleNetMinor: bigint,
  refundedGrossMinor: bigint,
  originalGrossMinor: bigint,
): bigint {
  if (eligibleNetMinor < 0n || refundedGrossMinor < 0n || originalGrossMinor <= 0n) {
    throw new Error("Invalid proportional wallet refund inputs.");
  }
  const boundedRefund = refundedGrossMinor > originalGrossMinor ? originalGrossMinor : refundedGrossMinor;
  return roundDivide(eligibleNetMinor * boundedRefund, originalGrossMinor);
}

export function canReserveWalletFunds(availableMinor: bigint, holdMinor: bigint): boolean {
  return availableMinor >= 0n && holdMinor > 0n && availableMinor >= holdMinor;
}

export function shouldReleasePayoutHold(status: string): boolean {
  return status === "failed" || status === "rejected";
}

export function payoutProviderOutcome(input: {
  accepted: boolean | undefined;
  providerReference?: string | null;
  providerStatus?: string | null;
}): "uncertain" | "failed" | "processing" | "completed" | "rejected" {
  if (input.accepted === false) return "failed";
  if (input.accepted !== true) return "uncertain";
  if (!input.providerReference) return "uncertain";
  const status = input.providerStatus?.toLowerCase();
  if (status === "completed") return "completed";
  if (status === "rejected" || status === "failed") return "rejected";
  return "processing";
}

export function canApplyWalletRefundAdjustment(availableMinor: bigint, refundMinor: bigint): boolean {
  return refundMinor > 0n && availableMinor >= refundMinor;
}