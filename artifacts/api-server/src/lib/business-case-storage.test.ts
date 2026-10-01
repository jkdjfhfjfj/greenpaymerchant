import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { File, Storage } from "@google-cloud/storage";
import {
  getPrivateCaseObject,
  verifyPrivateCaseObject,
  type CaseUploadMetadata,
} from "./business-case-storage";

type MockVersion = { generation: string; bytes: Buffer; contentType: string };
type MockObject = { current: string; versions: Map<string, MockVersion> };

function createMockStorage() {
  const objects = new Map<string, MockObject>();
  const copyCalls: Array<{ sourceGeneration: string | number | undefined; destinationCondition: number | string | undefined }> = [];
  let nextGeneration = 1;
  let afterNextUnpinnedMetadata: (() => void) | undefined;

  const put = (name: string, bytes: Buffer, contentType: string): MockVersion => {
    const generation = String(nextGeneration++);
    const version = { generation, bytes: Buffer.from(bytes), contentType };
    const object = objects.get(name) ?? { current: generation, versions: new Map<string, MockVersion>() };
    object.current = generation;
    object.versions.set(generation, version);
    objects.set(name, object);
    return version;
  };

  const makeFile = (name: string, requestedGeneration?: string | number): File => {
    const selectedVersion = (): MockVersion => {
      const object = objects.get(name);
      const version = object?.versions.get(
        requestedGeneration === undefined ? object.current : String(requestedGeneration),
      );
      if (!version) throw new Error(`Object generation unavailable: ${name}@${String(requestedGeneration)}`);
      return version;
    };

    const file = {
      generation: requestedGeneration,
      name,
      async getMetadata() {
        const version = selectedVersion();
        const metadata = {
          name,
          generation: version.generation,
          size: String(version.bytes.length),
          contentType: version.contentType,
        };
        if (requestedGeneration === undefined && afterNextUnpinnedMetadata) {
          const replace = afterNextUnpinnedMetadata;
          afterNextUnpinnedMetadata = undefined;
          replace();
        }
        return [metadata];
      },
      createReadStream() {
        return Readable.from([Buffer.from(selectedVersion().bytes)]);
      },
      async copy(destination: File, options?: { preconditionOpts?: { ifGenerationMatch?: number | string } }) {
        const source = selectedVersion();
        const destinationName = (destination as unknown as { name: string }).name;
        copyCalls.push({
          sourceGeneration: requestedGeneration,
          destinationCondition: options?.preconditionOpts?.ifGenerationMatch,
        });
        const prior = objects.get(destinationName);
        if (options?.preconditionOpts?.ifGenerationMatch === 0 && prior) {
          throw new Error("Precondition failed: destination exists.");
        }
        put(destinationName, source.bytes, source.contentType);
        return [destination, {}];
      },
      async exists() {
        return [objects.has(name)];
      },
      async delete() {
        objects.delete(name);
      },
    };
    return file as unknown as File;
  };

  const storageClient = {
    bucket(bucketName: string) {
      return {
        file(name: string, options?: { generation?: number | string }) {
          return makeFile(`${bucketName}/${name}`, options?.generation);
        },
      };
    },
  } as unknown as Storage;

  return {
    storageClient,
    copyCalls,
    seed: (name: string, bytes: Buffer, contentType: string) => put(name, bytes, contentType),
    overwrite: (name: string, bytes: Buffer, contentType: string) => put(name, bytes, contentType),
    replaceAfterNextUnpinnedMetadata(callback: () => void) {
      afterNextUnpinnedMetadata = callback;
    },
  };
}

const input: CaseUploadMetadata = {
  objectPath: "/objects/private/merchant-cases/7/9/upload.pdf",
  name: "evidence.pdf",
  size: Buffer.byteLength("%PDF-AAAAAA"),
  contentType: "application/pdf",
};

async function readFile(file: File): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("finalized evidence uses a new generation-bound object that survives source URL overwrites", async () => {
  const previousPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "case-bucket/private";
  try {
    const mock = createMockStorage();
    const original = Buffer.from("%PDF-AAAAAA");
    const replacement = Buffer.from("%PDF-BBBBBB");
    mock.seed("case-bucket/private/merchant-cases/7/9/upload.pdf", original, input.contentType);

    const verified = await verifyPrivateCaseObject(input, mock.storageClient);
    assert.notEqual(verified.objectPath, input.objectPath);
    assert.equal(verified.size, original.length);
    assert.equal(verified.contentType, input.contentType);
    assert.equal(verified.sha256, createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(mock.copyCalls, [{ sourceGeneration: "1", destinationCondition: 0 }]);

    mock.overwrite("case-bucket/private/merchant-cases/7/9/upload.pdf", replacement, input.contentType);
    const downloadFile = await getPrivateCaseObject(verified.objectPath, {
      size: verified.size,
      contentType: verified.contentType,
      sha256: verified.sha256,
    }, mock.storageClient);
    assert.deepEqual(await readFile(downloadFile), original);
  } finally {
    if (previousPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previousPrivateDir;
  }
});

test("replacement during validation cannot change the metadata, bytes, or generation copied", async () => {
  const previousPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "case-bucket/private";
  try {
    const mock = createMockStorage();
    const original = Buffer.from("%PDF-AAAAAA");
    const replacement = Buffer.from("%PDF-BBBBBB");
    const sourceName = "case-bucket/private/merchant-cases/7/9/upload.pdf";
    mock.seed(sourceName, original, input.contentType);
    mock.replaceAfterNextUnpinnedMetadata(() => mock.overwrite(sourceName, replacement, input.contentType));

    const verified = await verifyPrivateCaseObject(input, mock.storageClient);
    assert.equal(verified.sha256, createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(mock.copyCalls, [{ sourceGeneration: "1", destinationCondition: 0 }]);
    assert.deepEqual(await readFile(verified.file), original);
  } finally {
    if (previousPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previousPrivateDir;
  }
});

test("download rejects same-size and same-type changes to the immutable evidence object", async () => {
  const previousPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "case-bucket/private";
  try {
    const mock = createMockStorage();
    const original = Buffer.from("%PDF-AAAAAA");
    const replacement = Buffer.from("%PDF-BBBBBB");
    mock.seed("case-bucket/private/merchant-cases/7/9/upload.pdf", original, input.contentType);
    const verified = await verifyPrivateCaseObject(input, mock.storageClient);
    const destinationName = verified.objectPath.slice("/objects/".length);
    mock.overwrite(`case-bucket/${destinationName}`, replacement, input.contentType);

    await assert.rejects(
      getPrivateCaseObject(verified.objectPath, {
        size: verified.size,
        contentType: verified.contentType,
        sha256: verified.sha256,
      }, mock.storageClient),
      /bytes no longer match their validated record/,
    );
  } finally {
    if (previousPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previousPrivateDir;
  }
});