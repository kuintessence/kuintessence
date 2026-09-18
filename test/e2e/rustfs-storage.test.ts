import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "minio";
import {
  createRealMinioBackend,
  type MinioBackend,
} from "../../packages/server/src/storage/minio-client";
import {
  COMMITTER_ACCESS_KEY,
  COMMITTER_SECRET_KEY,
  DATA_MARKET_IMMUTABLE_BUCKET,
  DATA_MARKET_STAGING_BUCKET,
  NETDRIVE_BUCKET,
  startObjectStorage,
} from "./fixtures/object-storage";

let storage: Awaited<ReturnType<typeof startObjectStorage>>;
let backend: MinioBackend;
let client: Client;

beforeAll(async () => {
  storage = await startObjectStorage();
  const connection = {
    endPoint: storage.endpoint,
    port: storage.port,
    useSSL: false,
    accessKey: COMMITTER_ACCESS_KEY,
    secretKey: COMMITTER_SECRET_KEY,
  };
  client = new Client(connection);
  backend = await createRealMinioBackend({
    endpoint: storage.endpoint,
    ...connection,
    bucket: NETDRIVE_BUCKET,
    dataMarketStagingBucket: DATA_MARKET_STAGING_BUCKET,
    dataMarketImmutableBucket: DATA_MARKET_IMMUTABLE_BUCKET,
    immutableRetentionDays: 365,
  });
}, 180_000);

afterAll(async () => {
  await storage?.stop();
});

describe("RustFS storage with the deployment bootstrap and ordinary IAM credentials", () => {
  test("enforces versioned COMPLIANCE copies without direct writes or deletes", async () => {
    await backend.healthCheck();
    await backend.assertDataMarketStagingSafety();
    await backend.assertDataMarketImmutability();
    const bytes = Buffer.from("immutable fixture\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sourceKey = `data-market/staging/${crypto.randomUUID()}`;
    const targetKey = `data-market/immutable/sha256/${digest}`;
    const upload = await fetch(await backend.presignStagingUpload(sourceKey, 300), {
      method: "PUT",
      body: bytes,
    });
    expect(upload.status).toBe(200);
    const source = await backend.headStaging(sourceKey);
    expect(source?.etag).toBeTruthy();
    const committed = await backend.copyStagingToImmutable(sourceKey, targetKey, {
      sourceEtag: source?.etag ?? "",
      contentType: "text/plain",
      retainUntil: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000),
    });
    const versionId = committed.versionId;
    expect(versionId).toBeTruthy();
    if (!versionId) throw new Error("RustFS copy did not return a version ID");
    expect(await backend.sha256Immutable(targetKey, versionId)).toBe(digest);
    const retention = await client.getObjectRetention(DATA_MARKET_IMMUTABLE_BUCKET, targetKey, {
      versionId,
    });
    expect(retention?.mode).toBe("COMPLIANCE");
    await expect(
      client.putObject(DATA_MARKET_IMMUTABLE_BUCKET, targetKey, Buffer.from("overwrite")),
    ).rejects.toMatchObject({ code: "AccessDenied" });
    await expect(
      client.removeObject(DATA_MARKET_IMMUTABLE_BUCKET, targetKey, { versionId }),
    ).rejects.toMatchObject({ code: "AccessDenied" });
    const root = new Client({
      endPoint: storage.endpoint,
      port: storage.port,
      useSSL: false,
      accessKey: "rustfsadmin",
      secretKey: "rustfsadmin",
    });
    await expect(
      root.removeObject(DATA_MARKET_IMMUTABLE_BUCKET, targetKey, { versionId }),
    ).rejects.toMatchObject({ code: "AccessDenied" });
    await backend.deleteStaging(sourceKey);
    expect(await backend.headStaging(sourceKey)).toBeNull();
    expect(await backend.sha256Immutable(targetKey, versionId)).toBe(digest);
  }, 60_000);

  test("roundtrips multipart uploads and ranged downloads", async () => {
    const key = `multipart/${crypto.randomUUID()}`;
    const { uploadId } = await backend.createMultipartUpload(key, "application/octet-stream");
    const parts = [Buffer.alloc(5 * 1024 * 1024, 0x41), Buffer.from("TAIL")];
    const uploaded: { partNumber: number; etag: string }[] = [];
    for (const [index, body] of parts.entries()) {
      const partNumber = index + 1;
      const url = await backend.presignUploadPart(key, uploadId, partNumber, 300);
      const response = await fetch(url, { method: "PUT", body });
      expect(response.status).toBe(200);
      const etag = response.headers.get("etag")?.replaceAll('"', "") ?? "";
      expect(etag).not.toBe("");
      uploaded.push({ partNumber, etag });
    }
    expect(await backend.listUploadParts(key, uploadId)).toHaveLength(2);
    await backend.completeMultipartUpload(key, uploadId, uploaded);
    expect((await backend.head(key))?.size).toBe(5 * 1024 * 1024 + 4);
    const range = await fetch(await backend.presignDownload(key, 300), {
      headers: { Range: "bytes=-4" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("TAIL");
    await backend.delete(key);
  }, 60_000);

  test("bootstrap reruns safely and rotates the ordinary user secret", async () => {
    await storage.bootstrap();
    await backend.healthCheck();
    const rotatedSecret = "rotated-e2e-committer-secret";
    await storage.bootstrap(rotatedSecret);
    const rotated = new Client({
      endPoint: storage.endpoint,
      port: storage.port,
      useSSL: false,
      accessKey: COMMITTER_ACCESS_KEY,
      secretKey: rotatedSecret,
    });
    expect(await rotated.bucketExists(NETDRIVE_BUCKET)).toBe(true);
    await expect(client.bucketExists(NETDRIVE_BUCKET)).rejects.toThrow();
  }, 180_000);
});
