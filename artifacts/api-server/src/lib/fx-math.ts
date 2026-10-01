export interface FxCalculation {
  effectiveRate: number;
  platformFee: number;
  convertedAmount: number;
}

export function calculateFxQuote(
  amount: number,
  rate: number,
  percentage: number,
  flatAmount: number,
  markupBps: number,
): FxCalculation {
  if (![amount, rate, percentage, flatAmount, markupBps].every(Number.isFinite) ||
      amount <= 0 || rate <= 0 || percentage < 0 || percentage > 100 ||
      flatAmount < 0 || markupBps < 0 || markupBps > 10_000) {
    throw new Error("Invalid FX quote calculation input.");
  }
  const effectiveRate = rate * (1 - markupBps / 10_000);
  const gross = amount * effectiveRate;
  const platformFee = gross * percentage / 100 + flatAmount;
  return {
    effectiveRate,
    platformFee: Math.round(platformFee * 100) / 100,
    convertedAmount: Math.max(0, Math.round((gross - platformFee) * 100) / 100),
  };
}