import { collectionCurrency } from "@workspace/api-zod";

export function supportedCollectionCurrencyCode(value: string): string | null {
  const match = collectionCurrency(value);
  return match?.code === value ? match.code : null;
}

export function collectionCurrencyAvailabilityAudit(
  actor: string,
  currency: string,
  enabled: boolean,
) {
  return {
    actor,
    action: "collection_currency.availability_updated",
    target: `collection-currency:${currency}`,
    details: `Collection launch state changed to ${enabled ? "active" : "coming soon"}.`,
  };
}