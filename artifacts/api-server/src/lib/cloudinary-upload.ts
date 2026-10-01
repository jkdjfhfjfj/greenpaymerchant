import { createHash } from "node:crypto";

export type CloudinaryEnvironment = {
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
};

type CloudinaryCredentials = {
  cloudName: string | null;
  apiKey: string | null;
  apiSecret: string | null;
};

function readCredentials(env: CloudinaryEnvironment): CloudinaryCredentials {
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME?.trim() || null,
    apiKey: env.CLOUDINARY_API_KEY?.trim() || null,
    apiSecret: env.CLOUDINARY_API_SECRET?.trim() || null,
  };
}

export function cloudinaryUploadStatus(env: CloudinaryEnvironment = process.env) {
  const credentials = readCredentials(env);
  return {
    configured: Boolean(credentials.cloudName && credentials.apiKey && credentials.apiSecret),
    cloudName: credentials.cloudName,
  };
}

export function createCloudinaryUploadSignature(
  folder: string,
  timestamp = Math.floor(Date.now() / 1000),
  env: CloudinaryEnvironment = process.env,
) {
  const credentials = readCredentials(env);
  if (!credentials.cloudName || !credentials.apiKey || !credentials.apiSecret) {
    throw new Error("Cloudinary uploads are not configured.");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("Cloudinary upload timestamp is invalid.");
  }

  const signedParameters = { folder, timestamp: String(timestamp) };
  const payload = Object.entries(signedParameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signature = createHash("sha1")
    .update(`${payload}${credentials.apiSecret}`, "utf8")
    .digest("hex");

  return {
    cloudName: credentials.cloudName,
    apiKey: credentials.apiKey,
    timestamp,
    signature,
    folder,
  };
}