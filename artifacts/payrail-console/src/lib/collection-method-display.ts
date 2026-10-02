const PAYMENT_OPTIONS_BY_CURRENCY: Record<string, string[]> = {
  USD: ['Global USD payments'],
  NGN: ['Card', 'Bank transfer', 'OPay'],
  GHS: ['Mobile money'],
  TZS: ['Mobile money'],
  XOF: ['Mobile money', 'Orange', 'MTN', 'Wave', 'Free'],
  RWF: ['Mobile money', 'MTN', 'Airtel'],
  UGX: ['Mobile money', 'MTN', 'Airtel'],
  ZMW: ['Mobile money', 'Airtel', 'MTN', 'Zamtel'],
  MWK: ['Mobile money', 'Airtel', 'TNM'],
  SLL: ['Mobile money', 'Orange'],
  CDF: ['Mobile money', 'Airtel', 'MTN', 'Orange'],
  MZN: ['Mobile money'],
  XAF: ['Mobile money', 'MTN', 'Orange'],
};

export function collectionMethodDisplayOptions(currency: string, methodId: string): string[] {
  if (methodId === 'mobile_prompt') return ['M-Pesa prompt'];
  return PAYMENT_OPTIONS_BY_CURRENCY[currency.toUpperCase()] ?? ['Local payment options'];
}