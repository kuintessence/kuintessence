// Real-MinIO integration test for the multipart upload path. Unlike the
// in-memory `FakeMinioBackend` unit tests, this exercises the ACTUAL
// `createRealMinioBackend` against a live MinIO — the only place the presigned
// part-URL signing, `initiateNewMultipartUpload`, `listParts`, and
// `completeMultipartUpload` wiring is verified end-to-end.
//
// Gated on `NETDRIVE_ENDPOINT`: skipped by default so `bun test` stays green
// without infra. Run with a live MinIO, e.g.:
//   NETDRIVE_ENDPOINT=localhost NETDRIVE_ACCESS_KEY=minioadmin \
//   NETDRIVE_SECRET_KEY=minioadmin NETDRIVE_BUCKET=kq-netdrive \
//   bun test packages/server/src/storage/minio-client.integration.test.ts
import { describe, expect, test } from "bun:test";
import { createRealMinioBackend, type MinioBackendConfig } from "./minio-client";

const ENDPOINT = process.env.NETDRIVE_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

// S3/MinIO require every part except the last to be >= 5 MiB.
const MIN_PART = 5 * 1024 * 1024;

function testConfig(): MinioBackendConfig {
  return {
    endpoint: ENDPOINT ?? "localhost",
    port: Number.parseInt(process.env.NETDRIVE_PORT ?? "9000", 10),
    useSSL: (process.env.NETDRIVE_USE_SSL ?? "false").toLowerCase() === "true",
    accessKey: process.env.NETDRIVE_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.NETDRIVE_SECRET_KEY ?? "minioadmin",
    bucket: process.env.NETDRIVE_BUCKET ?? "kq-netdrive",
    dataMarketStagingBucket: process.env.DATA_MARKET_STAGING_BUCKET ?? "kq-data-market-staging",
    dataMarketImmutableBucket:
      process.env.DATA_MARKET_IMMUTABLE_BUCKET ?? "kq-data-market-immutable",
    immutableRetentionDays: 365,
  };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

suite("createRealMinioBackend multipart (real MinIO)", () => {
  test("multipart roundtrip via presigned part URLs assembles the object", async () => {
    const backend = await createRealMinioBackend(testConfig());
    const key = `test/multipart-${crypto.randomUUID()}.bin`;

    const { uploadId } = await backend.createMultipartUpload(key, "application/octet-stream");
    expect(uploadId.length).toBeGreaterThan(0);

    const part1 = Buffer.alloc(MIN_PART, 0x41); // 5 MiB of 'A'
    const part2 = Buffer.from("TAIL");
    const etags: { partNumber: number; etag: string }[] = [];

    for (const [partNumber, body] of [
      [1, part1],
      [2, part2],
    ] as const) {
      const url = await backend.presignUploadPart(key, uploadId, partNumber, 300);
      const res = await fetch(url, { method: "PUT", body });
      expect(res.ok).toBe(true);
      const etag = stripQuotes(res.headers.get("etag") ?? "");
      expect(etag.length).toBeGreaterThan(0);
      etags.push({ partNumber, etag });
    }

    // listUploadParts (the sidecar-loss recovery path) must reflect both parts.
    const listed = await backend.listUploadParts(key, uploadId);
    expect(listed.map((p) => p.partNumber).sort()).toEqual([1, 2]);

    const completed = await backend.completeMultipartUpload(key, uploadId, etags);
    expect(completed.etag.length).toBeGreaterThan(0);

    const stat = await backend.head(key);
    expect(stat?.size).toBe(MIN_PART + part2.length);

    const blob = await backend.getBlob(key);
    expect(blob.length).toBe(MIN_PART + part2.length);
    expect(blob.subarray(MIN_PART).toString()).toBe("TAIL");

    await backend.delete(key);
    expect(await backend.head(key)).toBeNull();
  });

  test("abortMultipartUpload discards an in-flight upload", async () => {
    const backend = await createRealMinioBackend(testConfig());
    const key = `test/multipart-abort-${crypto.randomUUID()}.bin`;

    const { uploadId } = await backend.createMultipartUpload(key, "application/octet-stream");
    const url = await backend.presignUploadPart(key, uploadId, 1, 300);
    const res = await fetch(url, { method: "PUT", body: Buffer.alloc(MIN_PART, 0x42) });
    expect(res.ok).toBe(true);

    await backend.abortMultipartUpload(key, uploadId);

    // The object was never assembled, so it must not exist.
    expect(await backend.head(key)).toBeNull();
  });
});
