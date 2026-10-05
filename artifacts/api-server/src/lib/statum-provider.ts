import { createHash } from "node:crypto";
import { ApiError } from "./api-error";
import { providerCredential, providerEnabled } from "./credential-runtime";
import { getPublicAppUrl, normalizeKenyanPhone } from "./greenpay-provider";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseKesMinor(value: unknown): bigint | undefined {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) :
    typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return undefined;
  try {
    return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  } catch {
    return undefined;
  }
}

async function statumCredentials() {
  if (!await providerEnabled("statum")) throw new ApiError(503, "Statum airtime is disabled.");
  const [consumerKey, consumerSecret, callbackToken] = await Promise.all([
    providerCredential("statum", "STATUM_CONSUMER_KEY"),
    providerCredential("statum", "STATUM_CONSUMER_SECRET"),
    providerCredential("statum", "STATUM_CALLBACK_TOKEN"),
  ]);
  if (!consumerKey || !consumerSecret || !callbackToken) {
    throw new ApiError(503, "Statum credentials and a callback token must be configured by a platform administrator.");
  }
  return { consumerKey, consumerSecret, callbackToken };
}

export async function isStatumConfigured(): Promise<boolean> {
  try {
    await statumCredentials();
    return true;
  } catch {
    return false;
  }
}

async function statumHeaders(): Promise<Record<string, string>> {
  const { consumerKey, consumerSecret } = await statumCredentials();
  const authorization = Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64");
  return { Authorization: `Basic ${authorization}`, Accept: "application/json", "Content-Type": "application/json" };
}

async function fetchStatum(url: string, init: RequestInit = {}): Promise<{ response: Response; body: JsonObject }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ApiError(502, "Statum could not be reached. The request outcome may be unknown.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, "Statum returned an unreadable response. The request outcome may be unknown.");
  }
  return { response, body: object(payload) };
}

export type StatumSubmission =
  | { kind: "accepted"; requestId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; reason: string };

export async function submitStatumAirtime(input: { phoneNumber: string; amountKes: number }): Promise<StatumSubmission> {
  const phone = normalizeKenyanPhone(input.phoneNumber);
  const { response, body } = await fetchStatum("https://api.statum.co.ke/api/v2/airtime", {
    method: "POST",
    headers: await statumHeaders(),
    body: JSON.stringify({ phone_number: phone, amount: String(input.amountKes) }),
  });
  const requestId = text(body.request_id);
  if (requestId) return { kind: "accepted", requestId };
  const providerCode = Number(body.status_code);
  const reason = text(body.result_desc) ?? text(body.message) ?? "Statum did not return an airtime request ID.";
  if (response.status >= 500 || response.status === 429 || providerCode >= 500) {
    return { kind: "unknown", reason };
  }
  if (!response.ok || (Number.isFinite(providerCode) && providerCode >= 400)) {
    return { kind: "rejected", reason };
  }
  return { kind: "unknown", reason };
}

export async function statumAccountDetails() {
  const { callbackToken } = await statumCredentials();
  const { response, body } = await fetchStatum("https://api.statum.co.ke/api/v2/account-details", {
    headers: await statumHeaders(),
  });
  const data = object(body.data);
  const providerCode = Number(body.status_code);
  if (!response.ok || (Number.isFinite(providerCode) && providerCode >= 400)) {
    throw new ApiError(502, "Statum account details could not be loaded.");
  }
  const balance = parseKesMinor(data.available_balance ?? data.account_balance ?? data.balance ??
    body.available_balance ?? body.account_balance ?? body.balance);
  if (balance === undefined) throw new ApiError(502, "Statum account details did not include a valid KES balance.");
  const topupCode = text(data.topup_code ?? data.mpesa_topup_code ?? data.paybill ??
    body.topup_code ?? body.mpesa_topup_code ?? body.paybill) ?? null;
  return {
    balance: Number(balance) / 100,
    topupCode,
    checkedAt: new Date(),
    callbackUrl: `${getPublicAppUrl()}/api/webhooks/statum?token=${encodeURIComponent(callbackToken)}`,
  };
}

export async function statumCallbackToken(): Promise<string> {
  return (await statumCredentials()).callbackToken;
}

export function statumCallbackTokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
