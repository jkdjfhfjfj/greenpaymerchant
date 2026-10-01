import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveCloudinaryEnvironment } from "./cloudinary-credentials";
import { cloudinaryUploadStatus, createCloudinaryUploadSignature } from "./cloudinary-upload";

const testEnvironment = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
};

test("Cloudinary environment resolves only its three provider credentials", async () => {
  const requested: string[] = [];
  const environment = await resolveCloudinaryEnvironment(async (provider, key) => {
    requested.push(`${provider}:${key}`);
    return testEnvironment[key as keyof typeof testEnvironment] ?? null;
  });

  assert.deepEqual(environment, testEnvironment);
  assert.deepEqual(requested, [
    "cloudinary:CLOUDINARY_CLOUD_NAME",
    "cloudinary:CLOUDINARY_API_KEY",
    "cloudinary:CLOUDINARY_API_SECRET",
  ]);
});

test("Cloudinary upload signatures cover the sorted folder and timestamp parameters", () => {
  const signature = createCloudinaryUploadSignature(
    "greenpay/platform",
    1_735_689_600,
    testEnvironment,
  );
  const expected = createHash("sha1")
    .update("folder=greenpay/platform&timestamp=1735689600test-api-secret", "utf8")
    .digest("hex");

  assert.deepEqual(signature, {
    cloudName: "test-cloud",
    apiKey: "test-api-key",
    timestamp: 1_735_689_600,
    signature: expected,
    folder: "greenpay/platform",
  });
});

test("Cloudinary upload signatures fail closed when any credential is absent", () => {
  assert.equal(
    cloudinaryUploadStatus({ ...testEnvironment, CLOUDINARY_API_SECRET: "" }).configured,
    false,
  );
  assert.throws(
    () => createCloudinaryUploadSignature("greenpay/platform", 1, {
      ...testEnvironment,
      CLOUDINARY_API_SECRET: "",
    }),
    /Cloudinary uploads are not configured/,
  );
});