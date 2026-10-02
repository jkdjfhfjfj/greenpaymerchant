import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { providerCredential } from "./credential-runtime";
import { resolveCloudinaryEnvironment } from "./cloudinary-credentials";
import type { CloudinaryEnvironment } from "./cloudinary-upload";

export const CASE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CASE_FILE_TYPES = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
} as const;

const OBJECT_PATH_PREFIX = "cloudinary:raw:authenticated:";
const UPLOAD_INTENT_TTL_MS = 10 * 60_000;
const DOWNLOAD_URL_TTL_SECONDS = 120;
const CLOUDINARY_API_ORIGIN = "https://api.cloudinary.com/v1_1";

export type CaseFileType = keyof typeof CASE_FILE_TYPES;
export type CaseUploadMetadata = {
  objectPath: string;
  name: string;
  size: number;
  contentType: CaseFileType;
};
export type VerifiedCaseObject = CaseUploadMetadata & { sha256: string };
export type ExpectedCaseObject = { size: number; contentType: CaseFileType; sha256: string };
export type CaseStorageFile = { createReadStream(): Readable };

type CaseStorageOptions = {
  environment?: CloudinaryEnvironment;
  fetcher?: typeof fetch;
  now?: () => number;
};

type CloudinaryCredentials = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

type CloudinaryAsset = { publicId: string; format: string };

async function getCredentials(environment?: CloudinaryEnvironment): Promise<CloudinaryCredentials> {
  const configured = environment ?? await resolveCloudinaryEnvironment(providerCredential);
  const cloudName = configured.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = configured.CLOUDINARY_API_KEY?.trim();
  const apiSecret = configured.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !/^[a-zA-Z0-9_-]+$/.test(cloudName) || !apiKey || !apiSecret) {
    throw new Error("Cloudinary private evidence storage is not configured.");
  }
  return { cloudName, apiKey, apiSecret };
}

function cloudinaryApiUrl(credentials: CloudinaryCredentials, action: "upload" | "download" | "destroy"): string {
  return `${CLOUDINARY_API_ORIGIN}/${encodeURIComponent(credentials.cloudName)}/raw/${action}`;
}

function signCloudinaryParameters(parameters: Record<string, string>, apiSecret: string): string {
  const payload = Object.entries(parameters)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${payload}${apiSecret}`, "utf8").digest("hex");
}

function parseCloudinaryObjectPath(objectPath: string): CloudinaryAsset {
  if (!objectPath.startsWith(OBJECT_PATH_PREFIX)) throw new Error("Invalid Cloudinary case evidence reference.");
  const publicId = objectPath.slice(OBJECT_PATH_PREFIX.length);
  const match = /^greenpay\/case-evidence\/m[1-9]\d*\/c[1-9]\d*\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(pdf|png|jpg)$/.exec(publicId);
  if (!match) throw new Error("Invalid Cloudinary case evidence reference.");
  return { publicId, format: match[2] };
}

function formatForContentType(contentType: CaseFileType): string {
  const extension = CASE_FILE_TYPES[contentType];
  if (!extension) throw new Error("Unsupported private evidence file type.");
  return extension.slice(1);
}

export async function createPrivateCaseUpload(
  merchantId: number,
  caseId: number,
  contentType: CaseFileType,
  options: CaseStorageOptions = {},
) {
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || !Number.isSafeInteger(caseId) || caseId < 1) {
    throw new Error("Invalid private evidence owner.");
  }
  const format = formatForContentType(contentType);
  const credentials = await getCredentials(options.environment);
  const now = options.now?.() ?? Date.now();
  const timestamp = Math.floor(now / 1000);
  const publicId = `greenpay/case-evidence/m${merchantId}/c${caseId}/${randomUUID()}.${format}`;
  const signedParameters = {
    overwrite: "false",
    public_id: publicId,
    timestamp: String(timestamp),
    type: "authenticated",
  };
  const uploadParameters = {
    ...signedParameters,
    api_key: credentials.apiKey,
    signature: signCloudinaryParameters(signedParameters, credentials.apiSecret),
  };
  return {
    uploadURL: cloudinaryApiUrl(credentials, "upload"),
    uploadParameters,
    objectPath: `${OBJECT_PATH_PREFIX}${publicId}`,
    expiresAt: new Date(now + UPLOAD_INTENT_TTL_MS),
    contentType,
  };
}

function magicMatches(contentType: CaseFileType, prefix: Buffer): boolean {
  if (contentType === "application/pdf") return prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  if (contentType === "image/png") return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  return false;
}

function privateDownloadUrl(
  asset: CloudinaryAsset,
  credentials: CloudinaryCredentials,
  now: number,
): string {
  const timestamp = Math.floor(now / 1000);
  const signedParameters = {
    expires_at: String(timestamp + DOWNLOAD_URL_TTL_SECONDS),
    format: asset.format,
    public_id: asset.publicId,
    timestamp: String(timestamp),
    type: "authenticated",
  };
  const query = new URLSearchParams({
    ...signedParameters,
    api_key: credentials.apiKey,
    signature: signCloudinaryParameters(signedParameters, credentials.apiSecret),
  });
  return `${cloudinaryApiUrl(credentials, "download")}?${query.toString()}`;
}

async function readAndValidateAsset(
  body: ReadableStream<Uint8Array> | null,
  expectedSize: number,
  contentType: CaseFileType,
): Promise<{ bytes: Buffer; sha256: string }> {
  if (!body) throw new Error("Cloudinary returned no private evidence bytes.");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let prefix = Buffer.alloc(0);
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytesRead += chunk.length;
      if (bytesRead > CASE_FILE_MAX_BYTES || bytesRead > expectedSize) {
        await reader.cancel();
        throw new Error("Uploaded file exceeded its validated size.");
      }
      if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (bytesRead !== expectedSize) throw new Error("Uploaded file size does not match the declared size.");
  if (!magicMatches(contentType, prefix)) {
    throw new Error("Uploaded file bytes do not match the allowed PDF, PNG, or JPEG format.");
  }
  return { bytes: Buffer.concat(chunks, bytesRead), sha256: hash.digest("hex") };
}

async function downloadAndValidateAsset(
  objectPath: string,
  expectedSize: number,
  contentType: CaseFileType,
  options: CaseStorageOptions,
): Promise<{ bytes: Buffer; sha256: string }> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > CASE_FILE_MAX_BYTES) {
    throw new Error("Uploaded file size is outside the allowed range.");
  }
  const asset = parseCloudinaryObjectPath(objectPath);
  if (`.${asset.format}` !== CASE_FILE_TYPES[contentType]) {
    throw new Error("Uploaded file type does not match its private storage reference.");
  }
  const credentials = await getCredentials(options.environment);
  const response = await (options.fetcher ?? fetch)(
    privateDownloadUrl(asset, credentials, options.now?.() ?? Date.now()),
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Cloudinary private evidence asset is unavailable.");
  }
  return readAndValidateAsset(response.body, expectedSize, contentType);
}

export async function verifyPrivateCaseObject(
  expected: CaseUploadMetadata,
  options: CaseStorageOptions = {},
): Promise<VerifiedCaseObject> {
  const { sha256 } = await downloadAndValidateAsset(
    expected.objectPath,
    expected.size,
    expected.contentType,
    options,
  );
  return { ...expected, sha256 };
}

export async function getPrivateCaseObject(
  objectPath: string,
  expected: ExpectedCaseObject,
  options: CaseStorageOptions = {},
): Promise<CaseStorageFile> {
  const { bytes, sha256 } = await downloadAndValidateAsset(
    objectPath,
    expected.size,
    expected.contentType,
    options,
  );
  if (sha256 !== expected.sha256) {
    throw new Error("Supporting file bytes no longer match their validated record.");
  }
  return { createReadStream: () => Readable.from([bytes]) };
}

export async function deletePrivateCaseObject(
  objectPath: string,
  options: CaseStorageOptions = {},
): Promise<void> {
  try {
    const asset = parseCloudinaryObjectPath(objectPath);
    const credentials = await getCredentials(options.environment);
    const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
    const signedParameters = {
      public_id: asset.publicId,
      timestamp,
      type: "authenticated",
    };
    const form = new URLSearchParams({
      ...signedParameters,
      api_key: credentials.apiKey,
      signature: signCloudinaryParameters(signedParameters, credentials.apiSecret),
    });
    const response = await (options.fetcher ?? fetch)(cloudinaryApiUrl(credentials, "destroy"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Cloudinary could not delete the private evidence asset.");
  } catch {
    // Cleanup failures must not hide the original validation or transaction error.
  }
}