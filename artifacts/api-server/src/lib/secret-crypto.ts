import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-error";

function encryptionKey(): Buffer {
  const explicit = process.env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  const session = process.env.SESSION_SECRET?.trim();
  if (!explicit && !session) throw new ApiError(503, "Credential encryption is unavailable. Configure CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(explicit || session!, "utf8"), Buffer.from("greenpay-credential-vault"), Buffer.from("AES-256-GCM"), 32));
}

export function credentialVaultReady(): boolean {
  return Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY?.trim() || process.env.SESSION_SECRET?.trim());
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(serialized: string): string {
  const [ivText, tagText, ciphertextText] = serialized.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new ApiError(503, "Stored credential data is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError(503, "Stored credentials cannot be decrypted with the configured vault key.");
  }
}

export function apiKeyHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function equalSignature(expectedHex: string, receivedHex: string): boolean {
  if (!/^[\da-f]{64}$/i.test(receivedHex) || !/^[\da-f]{64}$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}