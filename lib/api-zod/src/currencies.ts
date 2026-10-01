/**
 * Collection amount increments accepted by Greenpay's currently supported
 * collection routes. Payzaapi documents the collection currencies on
 * https://payzaapi.co.ke/docs#currencies; USD and KES are also retained for
 * Greenpay's existing routes. Payzaapi says to send SLL and display as SLE,
 * but does not document the numeric denomination/scale of API amounts.
 *
 * KES is intentionally whole-shilling only in Greenpay, even though ISO 4217
 * assigns it two minor units, because the configured M-Pesa collection route
 * accepts whole shillings.
 */
export const COLLECTION_CURRENCIES = [
  { code: "USD", name: "US Dollar", minorUnits: 2 },
  { code: "KES", name: "Kenyan Shilling", minorUnits: 0 },
  { code: "NGN", name: "Nigerian Naira", minorUnits: 2 },
  { code: "GHS", name: "Ghanaian Cedi", minorUnits: 2 },
  { code: "TZS", name: "Tanzanian Shilling", minorUnits: 2 },
  { code: "XOF", name: "West African CFA Franc", minorUnits: 0 },
  { code: "RWF", name: "Rwandan Franc", minorUnits: 0 },
  { code: "UGX", name: "Ugandan Shilling", minorUnits: 0 },
  { code: "ZMW", name: "Zambian Kwacha", minorUnits: 2 },
  { code: "MWK", name: "Malawian Kwacha", minorUnits: 2 },
  { code: "SLL", name: "Sierra Leonean Leone", minorUnits: 2 },
  { code: "CDF", name: "Congolese Franc", minorUnits: 2 },
  { code: "MZN", name: "Mozambican Metical", minorUnits: 2 },
  { code: "XAF", name: "Central African CFA Franc", minorUnits: 0 },
] as const;

export type CollectionCurrencyCode = (typeof COLLECTION_CURRENCIES)[number]["code"];

export function collectionCurrency(currency: string) {
  const code = currency.trim().toUpperCase();
  return COLLECTION_CURRENCIES.find((item) => item.code === code);
}

export function isSupportedCollectionCurrency(currency: string): boolean {
  return collectionCurrency(currency) !== undefined;
}

export function hasCollectionAmountPrecision(amount: number, currency: string): boolean {
  const item = collectionCurrency(currency);
  if (!item || !Number.isFinite(amount) || amount <= 0) return false;
  const scaled = amount * (10 ** item.minorUnits);
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
}

export function normalizeCollectionAmount(amount: number, currency: string): number {
  const item = collectionCurrency(currency);
  if (!item || !hasCollectionAmountPrecision(amount, currency)) {
    throw new RangeError(`Amount must be positive and use at most ${item?.minorUnits ?? 0} fractional digits for ${currency.toUpperCase()}.`);
  }
  const scale = 10 ** item.minorUnits;
  return Math.round(amount * scale) / scale;
}