import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { providerCredential } from "./credential-runtime";

const ADDRESS_PROOF_TTL_MS = 10 * 60_000;
const GEOAPIFY_REVERSE_URL = "https://api.geoapify.com/v1/geocode/reverse";

type GeoapifyAddress = {
  formatted?: unknown;
};

type GeoapifyResponse = {
  results?: GeoapifyAddress[];
  features?: Array<{ properties?: GeoapifyAddress }>;
};

export type AddressVerificationErrorCode =
  | "provider_unconfigured"
  | "provider_unavailable"
  | "address_not_found"
  | "signing_unavailable";

export class AddressVerificationError extends Error {
  constructor(readonly code: AddressVerificationErrorCode) {
    super(code);
    this.name = "AddressVerificationError";
  }
}

function normalizedAddress(address: string): string {
  return address.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function addressDigest(address: string): string {
  return createHash("sha256").update(normalizedAddress(address), "utf8").digest("hex");
}

function proofSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new AddressVerificationError("signing_unavailable");
  return secret;
}

export function createAddressVerificationToken(
  userId: string,
  address: string,
  now = Date.now(),
): string {
  const payload = {
    version: 1,
    userId,
    addressDigest: addressDigest(address),
    issuedAt: now,
    expiresAt: now + ADDRESS_PROOF_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", proofSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyAddressVerificationToken(
  token: string,
  userId: string,
  address: string,
  now = Date.now(),
): boolean {
  try {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) return false;
    const expected = createHmac("sha256", proofSecret()).update(encoded).digest();
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      version?: unknown;
      userId?: unknown;
      addressDigest?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
    };
    return payload.version === 1 &&
      payload.userId === userId &&
      payload.addressDigest === addressDigest(address) &&
      typeof payload.issuedAt === "number" &&
      payload.issuedAt <= now + 30_000 &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > now &&
      payload.expiresAt - payload.issuedAt === ADDRESS_PROOF_TTL_MS;
  } catch {
    return false;
  }
}

export async function reverseGeocodeMerchantAddress(
  latitude: number,
  longitude: number,
  userId: string,
): Promise<{ address: string; verificationToken: string }> {
  const apiKey = await providerCredential("geoapify", "GEOAPIFY_API_KEY");
  if (!apiKey) throw new AddressVerificationError("provider_unconfigured");

  const url = new URL(GEOAPIFY_REVERSE_URL);
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", apiKey);

  let payload: GeoapifyResponse;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new AddressVerificationError("provider_unavailable");
    const result = await response.json() as unknown;
    if (typeof result !== "object" || result === null) {
      throw new AddressVerificationError("provider_unavailable");
    }
    payload = result as GeoapifyResponse;
  } catch (error) {
    if (error instanceof AddressVerificationError) throw error;
    throw new AddressVerificationError("provider_unavailable");
  }

  const first = payload.results?.[0] ?? payload.features?.[0]?.properties;
  const address = typeof first?.formatted === "string"
    ? first.formatted.trim().replace(/\s+/g, " ")
    : "";
  if (address.length < 5 || address.length > 500) {
    throw new AddressVerificationError("address_not_found");
  }

  return {
    address,
    verificationToken: createAddressVerificationToken(userId, address),
  };
}