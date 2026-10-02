import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { eq } from "drizzle-orm";
import { db, providerCredentialsTable } from "@workspace/db";
import { ApiError } from "./api-error";
import { apiKeyHash, credentialVaultReady, decryptSecret, encryptSecret, equalSignature } from "./secret-crypto";
import { isPrivateAddress } from "./network-safety";
export { apiKeyHash, credentialVaultReady, decryptApiKeySecret, decryptSecret, encryptSecret, equalSignature } from "./secret-crypto";
export { isPrivateAddress } from "./network-safety";

export async function encryptProviderCredentials(provider: string, credentials: Record<string, string>, enabled: boolean, updatedBy: string) {
  const plaintext = JSON.stringify(credentials);
  const encryptedCredentials = encryptSecret(plaintext);
  const [row] = await db.insert(providerCredentialsTable).values({
    provider,
    encryptedCredentials,
    enabled,
  }).onConflictDoUpdate({
    target: providerCredentialsTable.provider,
    set: { encryptedCredentials, enabled, updatedAt: new Date() },
  }).returning();
  void updatedBy;
  return row;
}

export async function readProviderCredentials(provider: string): Promise<{ credentials: Record<string, string>; enabled: boolean; updatedAt: Date } | null> {
  const [row] = await db.select().from(providerCredentialsTable)
    .where(eq(providerCredentialsTable.provider, provider)).limit(1);
  if (!row) return null;
  const decoded: unknown = JSON.parse(decryptSecret(row.encryptedCredentials));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ApiError(503, "Stored provider credentials are invalid.");
  }
  return { credentials: decoded as Record<string, string>, enabled: row.enabled, updatedAt: row.updatedAt };
}

export async function resolvePublicWebhookUrl(value: string): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "Webhook URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port === "80") {
    throw new ApiError(400, "Webhook destinations must use HTTPS without embedded credentials.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ApiError(400, "Webhook destination host is not publicly routable.");
  }
  let addresses: LookupAddress[];
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ApiError(400, "Webhook destination host is not publicly routable.");
    addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw new ApiError(400, "Webhook destination hostname could not be resolved."); }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new ApiError(400, "Webhook destination must resolve only to public IP addresses.");
    }
  }
  return { url, addresses };
}

export async function validateWebhookUrl(value: string): Promise<URL> {
  return (await resolvePublicWebhookUrl(value)).url;
}
