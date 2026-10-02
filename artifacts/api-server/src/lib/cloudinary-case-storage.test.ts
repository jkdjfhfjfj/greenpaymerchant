import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  createPrivateCaseUpload,
  deletePrivateCaseObject,
  getPrivateCaseObject,
  verifyPrivateCaseObject,
  type CaseUploadMetadata,
} from "./cloudinary-case-storage";

const environment = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
};
const fixedNow = 1_735_689_600_000;
const input: CaseUploadMetadata = {
  objectPath: "cloudinary:raw:authenticated:greenpay/case-evidence/m7/c9/123e4567-e89b-12d3-a456-426614174000.pdf",
  name: "evidence.pdf",
  size: Buffer.byteLength("%PDF-AAAAAA"),
  contentType: "application/pdf",
};

function signatureFor(parameters: Record<string, string>, secret: string): string {
  const payload = Object.entries(parameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${payload}${secret}`, "utf8").digest("hex");
}

async function readFile(file: { createReadStream(): Readable }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("case uploads use one-time signed authenticated raw Cloudinary assets", async () => {
  const upload = await createPrivateCaseUpload(7, 9, "application/pdf", {
    environment,
    now: () => fixedNow,
  });
  const publicId = upload.objectPath.replace("cloudinary:raw:authenticated:", "");
  const signedParameters = {
    overwrite: "false",
    public_id: publicId,
    timestamp: String(Math.floor(fixedNow / 1000)),
    type: "authenticated",
  };
  assert.equal(upload.uploadURL, "https://api.cloudinary.com/v1_1/test-cloud/raw/upload");
  assert.equal(upload.uploadParameters.public_id, publicId);
  assert.equal(upload.uploadParameters.type, "authenticated");
  assert.equal(upload.uploadParameters.overwrite, "false");
  assert.equal(upload.uploadParameters.signature, signatureFor(signedParameters, environment.CLOUDINARY_API_SECRET));
  assert.equal(upload.expiresAt.getTime(), fixedNow + 10 * 60_000);
});

test("uploaded evidence is downloaded privately and checked for its declared size and file signature", async () => {
  const bytes = Buffer.from("%PDF-AAAAAA");
  let requestedUrl: URL | undefined;
  const fetcher: typeof fetch = async (inputUrl) => {
    requestedUrl = new URL(String(inputUrl));
    return new Response(bytes, { status: 200 });
  };

  const verified = await verifyPrivateCaseObject(input, {
    environment,
    fetcher,
    now: () => fixedNow,
  });
  assert.equal(verified.objectPath, input.objectPath);
  assert.equal(verified.size, bytes.length);
  assert.equal(verified.contentType, "application/pdf");
  assert.equal(verified.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(requestedUrl?.pathname ?? "", /\/v1_1\/test-cloud\/raw\/download$/);
  assert.equal(requestedUrl?.searchParams.get("type"), "authenticated");
  assert.equal(requestedUrl?.searchParams.get("format"), "pdf");
  assert.equal(requestedUrl?.searchParams.get("public_id"), input.objectPath.replace("cloudinary:raw:authenticated:", ""));
  assert.equal(
    requestedUrl?.searchParams.get("signature"),
    signatureFor({
      expires_at: String(Math.floor(fixedNow / 1000) + 120),
      format: "pdf",
      public_id: input.objectPath.replace("cloudinary:raw:authenticated:", ""),
      timestamp: String(Math.floor(fixedNow / 1000)),
      type: "authenticated",
    }, environment.CLOUDINARY_API_SECRET),
  );
});

test("authenticated downloads re-check the stored digest before streaming bytes", async () => {
  const bytes = Buffer.from("%PDF-AAAAAA");
  const fetcher: typeof fetch = async () => new Response(bytes, { status: 200 });
  const download = await getPrivateCaseObject(input.objectPath, {
    size: bytes.length,
    contentType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, { environment, fetcher, now: () => fixedNow });
  assert.deepEqual(await readFile(download), bytes);

  await assert.rejects(
    getPrivateCaseObject(input.objectPath, {
      size: bytes.length,
      contentType: "application/pdf",
      sha256: "0".repeat(64),
    }, { environment, fetcher, now: () => fixedNow }),
    /bytes no longer match their validated record/,
  );
});

test("private storage rejects forged file contents and mismatched sizes", async () => {
  const badBytes = Buffer.from("not a pdf!!");
  const fetcher: typeof fetch = async () => new Response(badBytes, { status: 200 });
  await assert.rejects(
    verifyPrivateCaseObject({ ...input, size: badBytes.length }, {
      environment, fetcher, now: () => fixedNow,
    }),
    /do not match the allowed PDF/,
  );
  await assert.rejects(
    verifyPrivateCaseObject(input, {
      environment,
      fetcher: async () => new Response(Buffer.from("%PDF-TOO-LARGE"), { status: 200 }),
      now: () => fixedNow,
    }),
    /exceeded its validated size/,
  );
});

test("cleanup uses a signed authenticated raw asset destroy request", async () => {
  let requestedUrl: URL | undefined;
  let submitted: URLSearchParams | undefined;
  const fetcher: typeof fetch = async (inputUrl, init) => {
    requestedUrl = new URL(String(inputUrl));
    submitted = new URLSearchParams(init?.body as URLSearchParams);
    return new Response(JSON.stringify({ result: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  await deletePrivateCaseObject(input.objectPath, {
    environment, fetcher, now: () => fixedNow,
  });
  assert.match(requestedUrl?.pathname ?? "", /\/v1_1\/test-cloud\/raw\/destroy$/);
  assert.equal(submitted?.get("type"), "authenticated");
  assert.equal(submitted?.get("public_id"), input.objectPath.replace("cloudinary:raw:authenticated:", ""));
  assert.equal(submitted?.get("signature"), signatureFor({
    public_id: input.objectPath.replace("cloudinary:raw:authenticated:", ""),
    timestamp: String(Math.floor(fixedNow / 1000)),
    type: "authenticated",
  }, environment.CLOUDINARY_API_SECRET));
});