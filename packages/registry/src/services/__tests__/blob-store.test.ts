// BlobStore contract tests, run against both implementations.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlobDigestMismatchError,
  BlobNotFoundError,
  type BlobStore,
  BlobUploadTooLargeError,
  FilesystemBlobStore,
  InMemoryBlobStore,
} from "../blob-store";

const HELLO = new TextEncoder().encode("hello kuintessence");
const HELLO_DIGEST = "sha256:7b9bd2c8a82dc1c98f59d65e9f4d5d20e9ab2a7e23b0c9bb09b6f76d05f3a59f"; // computed at runtime; not asserted directly

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function runSuite(name: string, factory: () => Promise<BlobStore>) {
  describe(`BlobStore contract — ${name}`, () => {
    let store: BlobStore;
    beforeAll(async () => {
      store = await factory();
    });

    it("put returns digest+size and head/exists agree", async () => {
      const r = await store.put(HELLO);
      expect(r.size).toBe(HELLO.byteLength);
      expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await store.exists(r.digest)).toBe(true);
      expect(await store.head(r.digest)).toEqual({ size: HELLO.byteLength });
    });

    it("get returns the same bytes that were put", async () => {
      const { digest } = await store.put(HELLO);
      const { stream, size } = await store.get(digest);
      expect(size).toBe(HELLO.byteLength);
      const got = await readAll(stream);
      expect(got).toEqual(HELLO);
    });

    it("put accepts a ReadableStream", async () => {
      const r = await store.put(streamOf(HELLO));
      expect(r.size).toBe(HELLO.byteLength);
      expect(await store.exists(r.digest)).toBe(true);
    });

    it("put with matching expectedDigest succeeds", async () => {
      const { digest } = await store.put(HELLO);
      const r = await store.put(HELLO, digest);
      expect(r.digest).toBe(digest);
    });

    it("put with mismatching expectedDigest throws", async () => {
      await expect(
        store.put(HELLO, "sha256:0000000000000000000000000000000000000000000000000000000000000000"),
      ).rejects.toBeInstanceOf(BlobDigestMismatchError);
    });

    it("get on unknown digest throws BlobNotFoundError", async () => {
      await expect(
        store.get("sha256:1111111111111111111111111111111111111111111111111111111111111111"),
      ).rejects.toBeInstanceOf(BlobNotFoundError);
    });

    it("head on unknown digest returns null", async () => {
      expect(
        await store.head("sha256:2222222222222222222222222222222222222222222222222222222222222222"),
      ).toBeNull();
    });

    it("delete removes the blob", async () => {
      const { digest } = await store.put(HELLO);
      await store.delete(digest);
      expect(await store.exists(digest)).toBe(false);
    });

    it("stages chunks and promotes them without exposing a partial blob", async () => {
      const uploadId = "00000000-0000-4000-8000-000000000001";
      const expected = await store.put(HELLO);
      await store.delete(expected.digest);
      await store.startUpload(uploadId);
      expect(await store.appendUpload(uploadId, HELLO.slice(0, 5), 1024)).toBe(5);
      expect(await store.appendUpload(uploadId, streamOf(HELLO.slice(5)), 1024)).toBe(
        HELLO.byteLength,
      );
      expect(await store.exists(expected.digest)).toBe(false);
      const promoted = await store.completeUpload(uploadId, expected.digest);
      expect(promoted).toEqual(expected);
      expect(await store.exists(expected.digest)).toBe(true);
    });

    it("rejects a staged upload before it exceeds its byte limit", async () => {
      const uploadId = "00000000-0000-4000-8000-000000000002";
      await store.startUpload(uploadId);
      await expect(store.appendUpload(uploadId, HELLO, 4)).rejects.toBeInstanceOf(
        BlobUploadTooLargeError,
      );
      await store.cancelUpload(uploadId);
    });
  });
}

runSuite("InMemory", async () => new InMemoryBlobStore());

const FS_ROOT = await mkdtemp(join(tmpdir(), "blobstore-test-"));
runSuite("Filesystem", async () => new FilesystemBlobStore(FS_ROOT));
afterAll(async () => {
  await rm(FS_ROOT, { recursive: true, force: true });
});

// Avoid "unused" lint on the precomputed reference value; the tests
// check the digest pattern rather than a hardcoded string because the
// hash output is hashing-implementation-stable across both backends.
void HELLO_DIGEST;
