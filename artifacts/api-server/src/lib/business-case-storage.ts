import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Storage, type File } from "@google-cloud/storage";

const SIDECAR = "http://127.0.0.1:1106";
export const CASE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CASE_FILE_TYPES = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
} as const;

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export type CaseFileType = keyof typeof CASE_FILE_TYPES;
export type CaseUploadMetadata = { objectPath: string; name: string; size: number; contentType: CaseFileType };
export type VerifiedCaseObject = CaseUploadMetadata & { sha256: string; generation: string; file: File };
export type ExpectedCaseObject = { size: number; contentType: CaseFileType; sha256: string };

function privatePrefix(): string {
  const configured = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!configured) throw new Error("Private App Storage is not configured.");
  return configured.replace(/^\/+|\/+$/g, "");
}

function fileForObjectPath(objectPath: string, storageClient: Storage = storage, generation?: string | number): File {
  if (!objectPath.startsWith("/objects/") || objectPath.includes("..")) {
    throw new Error("Invalid private object path.");
  }
  const configured = privatePrefix();
  const entityName = objectPath.slice("/objects/".length);
  const [bucketName, ...privateParts] = configured.split("/");
  const expectedPrefix = `${privateParts.join("/")}/`.replace(/^\/+/, "");
  if (!bucketName || !entityName.startsWith(expectedPrefix)) throw new Error("Object is outside the private App Storage directory.");
  return storageClient.bucket(bucketName).file(entityName, generation === undefined ? undefined : { generation });
}

export async function createPrivateCaseUpload(merchantId: number, caseId: number, contentType: CaseFileType) {
  const [bucketName, ...privateParts] = privatePrefix().split("/");
  if (!bucketName) throw new Error("Private App Storage bucket is not configured.");
  const objectName = [...privateParts, "merchant-cases", String(merchantId), String(caseId), randomUUID()].filter(Boolean).join("/");
  const objectPath = `/objects/${objectName}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "PUT",
      expires_at: expiresAt.toISOString(),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Private App Storage could not issue an upload URL.");
  const result = await response.json() as { signed_url?: unknown };
  let signedUrl: URL | null = null;
  try { signedUrl = typeof result.signed_url === "string" ? new URL(result.signed_url) : null; }
  catch { signedUrl = null; }
  if (!signedUrl || signedUrl.protocol !== "https:" ||
      !(signedUrl.hostname === "storage.googleapis.com" || signedUrl.hostname.endsWith(".storage.googleapis.com"))) {
    throw new Error("Private App Storage returned an invalid upload URL.");
  }
  return { uploadURL: signedUrl.toString(), objectPath, expiresAt, contentType };
}

function magicMatches(contentType: CaseFileType, prefix: Buffer): boolean {
  if (contentType === "application/pdf") return prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  if (contentType === "image/png") return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  return false;
}

async function hashValidatedFile(
  file: File,
  actualSize: number,
  contentType: CaseFileType,
): Promise<{ sha256: string }> {
  const hash = createHash("sha256");
  let bytesRead = 0;
  let prefix = Buffer.alloc(0);
  const stream = file.createReadStream();
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      if (bytesRead > CASE_FILE_MAX_BYTES || bytesRead > actualSize) {
        stream.destroy();
        throw new Error("Uploaded file exceeded its validated size.");
      }
      if (prefix.length < 16) prefix = Buffer.concat([prefix, buffer.subarray(0, 16 - prefix.length)]);
      hash.update(buffer);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (bytesRead !== actualSize || !magicMatches(contentType, prefix)) {
    throw new Error("Uploaded file bytes do not match the allowed PDF, PNG, or JPEG format.");
  }
  return { sha256: hash.digest("hex") };
}

function validateSnapshotMetadata(
  metadata: { size?: string | number; contentType?: string; generation?: string | number },
  expectedSize: number,
  expectedType: CaseFileType,
): { size: number; contentType: CaseFileType; generation: string } {
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > CASE_FILE_MAX_BYTES || size !== expectedSize) {
    throw new Error("Uploaded file size does not match the declared, allowed size.");
  }
  const contentType = String(metadata.contentType ?? "").toLowerCase();
  if (contentType !== expectedType || !Object.hasOwn(CASE_FILE_TYPES, contentType)) {
    throw new Error("Uploaded file content type does not match an allowed file type.");
  }
  const generation = metadata.generation === undefined ? "" : String(metadata.generation);
  if (!/^\d+$/.test(generation)) throw new Error("Uploaded file has no valid storage generation.");
  return { size, contentType: contentType as CaseFileType, generation };
}

export async function verifyPrivateCaseObject(
  expected: CaseUploadMetadata,
  storageClient: Storage = storage,
): Promise<VerifiedCaseObject> {
  const source = fileForObjectPath(expected.objectPath, storageClient);
  const [latestMetadata] = await source.getMetadata();
  const sourceGeneration = latestMetadata.generation === undefined ? "" : String(latestMetadata.generation);
  if (!/^\d+$/.test(sourceGeneration)) throw new Error("Uploaded file has no valid storage generation.");

  // Pin validation and copying to the generation observed in this metadata snapshot.
  const sourceSnapshot = fileForObjectPath(expected.objectPath, storageClient, sourceGeneration);
  const [sourceMetadata] = await sourceSnapshot.getMetadata();
  const validatedSource = validateSnapshotMetadata(sourceMetadata, expected.size, expected.contentType);
  if (validatedSource.generation !== sourceGeneration) {
    throw new Error("Uploaded file changed while its storage generation was being validated.");
  }
  const sourceDigest = await hashValidatedFile(sourceSnapshot, validatedSource.size, validatedSource.contentType);

  const [bucketName, ...privateParts] = privatePrefix().split("/");
  if (!bucketName) throw new Error("Private App Storage bucket is not configured.");
  const destinationName = [...privateParts, "merchant-cases", "verified", randomUUID()].filter(Boolean).join("/");
  const destinationPath = `/objects/${destinationName}`;
  const destination = storageClient.bucket(bucketName).file(destinationName);

  // FileOptions.generation pins the source; copy's supported preconditionOpts
  // sets destination ifGenerationMatch=0, so an existing object cannot be replaced.
  await sourceSnapshot.copy(destination, { preconditionOpts: { ifGenerationMatch: 0 } });

  const [destinationMetadata] = await destination.getMetadata();
  const validatedDestination = validateSnapshotMetadata(
    destinationMetadata,
    validatedSource.size,
    validatedSource.contentType,
  );
  const destinationSnapshot = fileForObjectPath(destinationPath, storageClient, validatedDestination.generation);
  const destinationDigest = await hashValidatedFile(
    destinationSnapshot,
    validatedDestination.size,
    validatedDestination.contentType,
  );
  if (destinationDigest.sha256 !== sourceDigest.sha256) {
    await deletePrivateCaseObject(destinationPath, storageClient);
    throw new Error("Copied file bytes do not match the validated upload snapshot.");
  }

  return {
    ...expected,
    objectPath: destinationPath,
    size: validatedDestination.size,
    contentType: validatedDestination.contentType,
    sha256: destinationDigest.sha256,
    generation: validatedDestination.generation,
    file: destinationSnapshot,
  };
}

export async function getPrivateCaseObject(
  objectPath: string,
  expected: ExpectedCaseObject,
  storageClient: Storage = storage,
): Promise<File> {
  const latest = fileForObjectPath(objectPath, storageClient);
  const [metadata] = await latest.getMetadata();
  const generation = metadata.generation === undefined ? "" : String(metadata.generation);
  if (!/^\d+$/.test(generation)) throw new Error("Supporting file has no valid storage generation.");
  const snapshot = fileForObjectPath(objectPath, storageClient, generation);
  const [snapshotMetadata] = await snapshot.getMetadata();
  const validated = validateSnapshotMetadata(snapshotMetadata, expected.size, expected.contentType);
  if (validated.generation !== generation) throw new Error("Supporting file changed while being checked for download.");
  const digest = await hashValidatedFile(snapshot, validated.size, validated.contentType);
  if (digest.sha256 !== expected.sha256) {
    throw new Error("Supporting file bytes no longer match their validated record.");
  }
  return snapshot;
}

export async function deletePrivateCaseObject(objectPath: string, storageClient: Storage = storage): Promise<void> {
  try {
    await fileForObjectPath(objectPath, storageClient).delete({ ignoreNotFound: true });
  } catch {
    // A failed cleanup must not hide the validation failure; object paths are never exposed.
  }
}

export function streamPrivateCaseObject(file: File) {
  return Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
}