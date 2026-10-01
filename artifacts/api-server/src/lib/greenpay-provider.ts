import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionRecord } from "@workspace/db";

export type ProviderName = "paystack" | "payhero" | "payzaapi";
export type PaymentStatus = "pending" | "success" | "failed" | "cancelled";
type JsonObject = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export const PAYZA_CURRENCIES = [
  "NGN", "GHS", "TZS", "XOF", "RWF", "UGX",
  "ZMW", "MWK", "SLL", "CDF", "MZN", "XAF",
] as const;

export function providerForCurrency(currency: string): ProviderName {
  const normalized = currency.toUpperCase();
  if (normalized === "USD") return "paystack";
  if (normalized === "KES") return "payhero";
  return "payzaapi";
}

export function assertSupportedCurrency(currency: string): void {
  const normalized = currency.toUpperCase();
  if (normalized !== "USD" && normalized !== "KES" && !PAYZA_CURRENCIES.includes(normalized as (typeof PAYZA_CURRENCIES)[number])) {
    throw new ApiError(400, `Greenpay does not currently support ${normalized}.`);
  }
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function getPublicAppUrl(): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  const domain =
    configured ||
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN?.trim();
  if (!domain) {
    throw new ApiError(503, "Hosted checkout is unavailable until the public app URL is configured.");
  }
  const url = domain.includes("://") ? domain : `https://${domain}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("HTTPS required");
    }
    return parsed.origin;
  } catch {
    throw new ApiError(503, "The configured public app URL is invalid.");
  }
}

export function providerConfigured(provider: ProviderName): boolean {
  if (provider === "paystack") return Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());
  if (provider === "payhero") {
    return Boolean(process.env.PAYHERO_AUTH_TOKEN?.trim()) &&
      Number.isInteger(Number(process.env.PAYHERO_CHANNEL_ID)) &&
      Number(process.env.PAYHERO_CHANNEL_ID) > 0;
  }
  return Boolean(process.env.PAYZA_PUBLIC_KEY?.trim() && process.env.PAYZA_SECRET_KEY?.trim());
}

export function getProviderStatuses() {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";
  const payzaKey = process.env.PAYZA_PUBLIC_KEY?.trim() ?? "";
  const payheroReady = providerConfigured("payhero");
  const payzaReady = providerConfigured("payzaapi");
  const paystackReady = providerConfigured("paystack");
  return [
    {
      provider: "paystack" as const,
      configured: paystackReady,
      mode: paystackKey.startsWith("sk_test_") ? "test" as const : paystackKey.startsWith("sk_live_") ? "live" as const : paystackReady ? "unknown" as const : "unknown" as const,
      currencies: ["USD"],
      collectionsEnabled: paystackReady,
      payoutsEnabled: false,
      note: paystackReady ? "USD collections are routed here. Configure the provider webhook to call /api/webhooks/paystack." : "Add PAYSTACK_SECRET_KEY to enable USD collections.",
    },
    {
      provider: "payhero" as const,
      configured: payheroReady,
      mode: "unknown" as const,
      currencies: ["KES"],
      collectionsEnabled: payheroReady,
      payoutsEnabled: false,
      note: payheroReady ? "KES uses an M-Pesa prompt. Callbacks are verified through PayHero before updating payment status." : "Add PAYHERO_AUTH_TOKEN and PAYHERO_CHANNEL_ID to enable KES collections.",
    },
    {
      provider: "payzaapi" as const,
      configured: payzaReady,
      mode: payzaKey.startsWith("pk_test_") ? "test" as const : payzaKey.startsWith("pk_live_") ? "live" as const : payzaReady ? "unknown" as const : "unknown" as const,
      currencies: [...PAYZA_CURRENCIES],
      collectionsEnabled: payzaReady,
      payoutsEnabled: payzaReady,
      note: payzaReady
        ? process.env.PAYZA_WEBHOOK_SECRET?.trim()
          ? "Other supported currencies and payouts use Payzaapi. Refunds adjust the Payza wallet; they do not return money to the customer."
          : "Add PAYZA_WEBHOOK_SECRET to verify callbacks. Other currencies and payouts use Payzaapi."
        : "Add PAYZA_PUBLIC_KEY and PAYZA_SECRET_KEY to enable other currencies and payouts.",
    },
  ];
}

export async function fetchProviderJson(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new ApiError(502, `${provider} could not be reached. Try again shortly.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, `${provider} returned an unreadable response.`);
  }
  if (!response.ok) {
    const message = stringValue(asObject(payload).message);
    throw new ApiError(502, message ? `${provider}: ${message}` : `${provider} rejected the request.`);
  }
  return asObject(payload);
}

function payzaHeaders(): HeadersInit {
  const publicKey = process.env.PAYZA_PUBLIC_KEY?.trim();
  const secretKey = process.env.PAYZA_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) throw new ApiError(503, "Payzaapi is not configured.");
  return { "X-Public-Key": publicKey, "X-Secret-Key": secretKey, "Content-Type": "application/json" };
}

function payheroHeaders(): HeadersInit {
  const token = process.env.PAYHERO_AUTH_TOKEN?.trim();
  if (!token || !providerConfigured("payhero")) throw new ApiError(503, "PayHero is not configured.");
  return { Authorization: token.toLowerCase().startsWith("basic ") ? token : `Basic ${token}`, "Content-Type": "application/json" };
}

export interface StartPaymentInput {
  reference: string;
  provider: ProviderName;
  amount: number;
  currency: string;
  customerEmail: string;
  customerName: string | null;
  customerPhone: string | null;
  description: string | null;
  paymentLinkSlug: string | null;
}

export interface StartPaymentResult {
  providerReference: string | null;
  paymentUrl: string | null;
}

function normalizeKenyanPhone(phone: string | null): string {
  if (!phone) throw new ApiError(400, "A phone number is required for a KES M-Pesa prompt.");
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("0") && digits.length === 10) digits = `254${digits.slice(1)}`;
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) digits = `254${digits}`;
  if (!/^254[17]\d{8}$/.test(digits)) throw new ApiError(400, "Enter a valid Kenyan mobile number.");
  return digits;
}

export async function startProviderPayment(input: StartPaymentInput): Promise<StartPaymentResult> {
  if (!providerConfigured(input.provider)) throw new ApiError(503, `${input.provider} is not configured.`);
  const appUrl = getPublicAppUrl();
  const statusUrl = input.paymentLinkSlug
    ? `${appUrl}/pay/${encodeURIComponent(input.paymentLinkSlug)}`
    : `${appUrl}/status/${encodeURIComponent(input.reference)}`;

  if (input.provider === "paystack") {
    const response = await fetchProviderJson("Paystack", "https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.customerEmail,
        amount: Math.round(input.amount * 100),
        currency: input.currency,
        reference: input.reference,
        callback_url: statusUrl,
        metadata: { greenpay_reference: input.reference },
      }),
    });
    const data = asObject(response.data);
    if (response.status !== true || !stringValue(data.authorization_url)) {
      throw new ApiError(502, stringValue(response.message) ?? "Paystack did not return a checkout URL.");
    }
    return {
      providerReference: stringValue(data.reference) ?? input.reference,
      paymentUrl: stringValue(data.authorization_url) ?? null,
    };
  }

  if (input.provider === "payhero") {
    if (!Number.isInteger(input.amount)) {
      throw new ApiError(400, "KES M-Pesa collections must use whole shillings.");
    }
    const response = await fetchProviderJson("PayHero", "https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: payheroHeaders(),
      body: JSON.stringify({
        amount: input.amount,
        phone_number: normalizeKenyanPhone(input.customerPhone),
        channel_id: Number(process.env.PAYHERO_CHANNEL_ID),
        provider: "m-pesa",
        external_reference: input.reference,
        customer_name: input.customerName ?? undefined,
        callback_url: `${appUrl}/api/webhooks/payhero`,
      }),
    });
    if (response.success !== true) {
      throw new ApiError(502, stringValue(response.message) ?? "PayHero did not accept the M-Pesa request.");
    }
    return { providerReference: stringValue(response.reference) ?? null, paymentUrl: null };
  }

  const response = await fetchProviderJson("Payzaapi", "https://payzaapi.co.ke/api/v1/pay", {
    method: "POST",
    headers: payzaHeaders(),
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
      customer: {
        email: input.customerEmail,
        name: input.customerName ?? undefined,
        phone: input.customerPhone ?? undefined,
      },
      description: input.description ?? undefined,
      callback_url: `${appUrl}/api/webhooks/payzaapi`,
      redirect_url: `${statusUrl}?reference=${encodeURIComponent(input.reference)}`,
    }),
  });
  const data = asObject(response.data);
  const paymentUrl = stringValue(data.payment_url) ?? stringValue(response.payment_url);
  if (response.success !== true || !paymentUrl) {
    throw new ApiError(502, stringValue(response.message) ?? "Payzaapi did not return a hosted checkout URL.");
  }
  return { providerReference: input.reference, paymentUrl };
}

export interface PaymentVerification {
  status: PaymentStatus;
  fee: number | null;
  netAmount: number | null;
  paidAt: Date | null;
}

function normalizeStatus(value: unknown): PaymentStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["success", "successful", "paid", "completed"].includes(status)) return "success";
  if (["failed", "failure", "declined"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return "pending";
}

function verifyAmountCurrency(
  data: JsonObject,
  transaction: TransactionRecord,
  amountDivisor: number,
): void {
  const providerAmount = numberValue(data.amount);
  const providerCurrency = stringValue(data.currency)?.toUpperCase();
  if (providerAmount !== undefined && Math.abs(providerAmount / amountDivisor - transaction.amount) > 0.011) {
    throw new ApiError(502, "The provider verification amount does not match the Greenpay transaction.");
  }
  if (providerCurrency && providerCurrency !== transaction.currency.toUpperCase()) {
    throw new ApiError(502, "The provider verification currency does not match the Greenpay transaction.");
  }
}

export async function verifyProviderPayment(transaction: TransactionRecord): Promise<PaymentVerification> {
  if (!transaction.providerReference && transaction.provider === "payhero") {
    throw new ApiError(409, "PayHero has not returned a transaction reference yet.");
  }
  let data: JsonObject;
  let amountDivisor = 1;

  if (transaction.provider === "paystack") {
    if (!providerConfigured("paystack")) throw new ApiError(503, "Paystack is not configured.");
    const response = await fetchProviderJson(
      "Paystack",
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(transaction.providerReference ?? transaction.reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
    );
    data = asObject(response.data);
    if (response.status !== true) throw new ApiError(502, "Paystack could not verify this transaction.");
    amountDivisor = 100;
  } else if (transaction.provider === "payhero") {
    const response = await fetchProviderJson(
      "PayHero",
      `https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(transaction.providerReference ?? "")}`,
      { headers: payheroHeaders() },
    );
    const providerReference = stringValue(response.reference);
    if (providerReference && providerReference !== transaction.providerReference) {
      throw new ApiError(502, "PayHero returned a different transaction reference.");
    }
    data = response;
  } else {
    const response = await fetchProviderJson(
      "Payzaapi",
      `https://payzaapi.co.ke/api/v1/verify/${encodeURIComponent(transaction.reference)}`,
      { headers: payzaHeaders() },
    );
    data = asObject(response.data);
    if (response.success !== true) throw new ApiError(502, "Payzaapi could not verify this transaction.");
  }

  verifyAmountCurrency(data, transaction, amountDivisor);
  const feeValue = numberValue(data.fees) ?? numberValue(data.fee);
  const fee = feeValue === undefined ? null : feeValue / amountDivisor;
  const status = normalizeStatus(data.status);
  const dateString = stringValue(data.paid_at) ?? stringValue(data.transaction_date);
  const paidAt = dateString ? new Date(dateString) : null;
  return {
    status,
    fee,
    netAmount: fee === null ? null : Math.max(0, transaction.amount - fee),
    paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
  };
}

export function verifyWebhookSignature(
  provider: "paystack" | "payzaapi",
  rawBody: Buffer,
  received: string | undefined,
): boolean {
  if (!received) return false;
  const secret = provider === "paystack"
    ? process.env.PAYSTACK_SECRET_KEY
    : process.env.PAYZA_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = createHmac("sha" + (provider === "paystack" ? "512" : "256"), secret)
    .update(rawBody)
    .digest("hex");
  if (!/^[\da-f]+$/i.test(received) || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export async function payzaApiRequest(path: string, init: RequestInit = {}): Promise<JsonObject> {
  return fetchProviderJson("Payzaapi", `https://payzaapi.co.ke/api/v1${path}`, {
    ...init,
    headers: { ...payzaHeaders(), ...init.headers },
  });
}

export async function payzaPayoutMethods(currency: string) {
  const response = await payzaApiRequest(`/payout-methods?currency=${encodeURIComponent(currency.toUpperCase())}`);
  const item = asObject(response.payout_methods);
  if (response.success !== true) throw new ApiError(502, "Payzaapi could not load payout methods.");
  const fee = asObject(item.fee);
  const methods = Array.isArray(item.methods) ? item.methods : [];
  return {
    currency: stringValue(item.currency) ?? currency.toUpperCase(),
    available: item.available === true,
    minimumWithdrawal: numberValue(item.minimum_withdrawal) ?? 0,
    fee: {
      type: fee.type === "percent" ? "percent" as const : "flat" as const,
      amount: numberValue(fee.amount) ?? 0,
      percent: numberValue(fee.percent) ?? null,
      floor: numberValue(fee.floor) ?? null,
    },
    methods: methods.filter(isObject).map((method) => ({
      value: stringValue(method.value) ?? "",
      label: stringValue(method.label) ?? stringValue(method.value) ?? "Payout method",
      requiresBankFields: method.requires_bank_fields === true,
    })).filter((method) => method.value.length > 0),
  };
}