const hiddenPayoutProviderPattern = /payza[\s._-]*api/gi;

export function hidePayoutProviderName(value: string): string {
  return value.replace(hiddenPayoutProviderPattern, "External payout service");
}

export function payoutDisplayLabel(value?: string | null): string {
  const display = (value || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return hidePayoutProviderName(display);
}