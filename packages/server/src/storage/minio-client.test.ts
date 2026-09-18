import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertDataMarketImmutableBucketControls,
  assertDataMarketStagingBucketControls,
  assertDataMarketStagingBucketSeparation,
  copyResultVersionId,
  type ImmutableObjectCommit,
  loadMinioConfigFromEnv,
  type MinioBackend,
  type ObjectStat,
} from "./minio-client";

/**
 * In-memory MinIO fake used by every NetDrive unit test. Implements
 * the `MinioBackend` interface so the netdrive service can be exercised
 * without a live object store. This file also serves as the canonical
 * reference test for the wrapper config loader.
 */
export class FakeMinioBackend implements MinioBackend {
  readonly bucket: string;
  readonly dataMarketStagingBucket: string;
  readonly dataMarketImmutableBucket: string;
  private readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
  >();
  private readonly stagingObjects = new Map<
    string,
    { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
  >();
  private readonly immutableObjects = new Map<
    string,
    { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
  >();
  private readonly immutableVersions = new Map<
    string,
    Map<string, { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }>
  >();
  private readonly uploads = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, { body: Buffer; etag: string }> }
  >();
  /** Toggle to make `healthCheck` reject — used to test bootstrap failure. */
  public healthy = true;
  public immutableControlsReady = true;
  public stagingControlsReady = true;
  readonly copyAttempts: string[] = [];
  private version = 0;

  constructor(bucket = "netdrive-test") {
    this.bucket = bucket;
    this.dataMarketStagingBucket = "data-market-staging-test";
    this.dataMarketImmutableBucket = "data-market-immutable-test";
  }

  async putBlob(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<{ etag: string }> {
    const buf = body instanceof Buffer ? body : Buffer.from(body);
    const etag = simpleEtag(buf);
    this.objects.set(key, {
      body: buf,
      contentType,
      etag,
      mtime: new Date(),
      versionId: this.nextVersionId(),
    });
    return { etag };
  }

  async getBlob(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NotFound: ${key}`);
    return o.body;
  }

  async sha256(key: string, versionId?: string): Promise<string | null> {
    const object = this.objects.get(key);
    if (versionId && object?.versionId !== versionId) return null;
    return object ? createHash("sha256").update(object.body).digest("hex") : null;
  }

  async presignStagingUpload(
    key: string,
    expiresInSec: number,
    _contentType?: string,
  ): Promise<string> {
    return `https://fake-minio.test/staging/${encodeURIComponent(key)}?expires=${expiresInSec}`;
  }

  async putStagingBlob(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<{ etag: string }> {
    return this.putObject(this.stagingObjects, key, body, contentType);
  }

  async getImmutableBlob(key: string): Promise<Buffer> {
    const object = this.immutableObjects.get(key);
    if (!object) throw new Error(`NotFound: ${key}`);
    return object.body;
  }

  async headStaging(key: string): Promise<ObjectStat | null> {
    return this.headObject(this.stagingObjects, key);
  }

  async sha256Staging(key: string): Promise<string | null> {
    return this.sha256Object(this.stagingObjects, key);
  }

  async deleteStaging(key: string): Promise<void> {
    this.stagingObjects.delete(key);
  }

  async copyStagingToImmutable(
    sourceKey: string,
    targetKey: string,
    options: {
      sourceEtag: string;
      contentType: string;
      retainUntil: Date;
    },
  ): Promise<ImmutableObjectCommit> {
    const source = this.stagingObjects.get(sourceKey);
    if (!source) throw new Error(`NotFound: ${sourceKey}`);
    if (source.etag !== options.sourceEtag) throw new Error("PreconditionFailed");
    if (source.contentType !== options.contentType) throw new Error("InvalidContentType");
    this.copyAttempts.push(targetKey);
    const body = Buffer.from(source.body);
    const etag = simpleEtag(body);
    const versionId = this.nextVersionId();
    const object = {
      body,
      contentType: source.contentType,
      etag,
      mtime: new Date(),
      versionId,
    };
    this.immutableObjects.set(targetKey, object);
    const versions = this.immutableVersions.get(targetKey) ?? new Map();
    versions.set(versionId, object);
    this.immutableVersions.set(targetKey, versions);
    return {
      etag,
      versionId,
      lock: { mode: "COMPLIANCE", retainUntil: options.retainUntil },
    };
  }

  async headImmutable(key: string, versionId?: string): Promise<ObjectStat | null> {
    if (versionId) {
      const object = this.immutableVersions.get(key)?.get(versionId);
      return object ? this.objectStat(object) : null;
    }
    return this.headObject(this.immutableObjects, key, versionId);
  }

  async sha256Immutable(key: string, versionId?: string): Promise<string | null> {
    if (versionId) {
      const object = this.immutableVersions.get(key)?.get(versionId);
      return object ? createHash("sha256").update(object.body).digest("hex") : null;
    }
    return this.sha256Object(this.immutableObjects, key, versionId);
  }

  async presignUpload(key: string, expiresInSec: number, _contentType?: string): Promise<string> {
    return `https://fake-minio.test/upload/${encodeURIComponent(key)}?expires=${expiresInSec}`;
  }

  async presignDownload(
    key: string,
    expiresInSec: number,
    filename?: string,
    versionId?: string,
  ): Promise<string> {
    const params = new URLSearchParams({ expires: String(expiresInSec) });
    if (filename) {
      params.set("response-content-disposition", `attachment; filename="${filename}"`);
    }
    if (versionId) params.set("versionId", versionId);
    return `https://fake-minio.test/download/${encodeURIComponent(key)}?${params.toString()}`;
  }

  async presignImmutableDownload(
    key: string,
    expiresInSec: number,
    versionId: string,
    filename?: string,
  ): Promise<string> {
    const params = new URLSearchParams({ expires: String(expiresInSec), versionId });
    if (filename) {
      params.set("response-content-disposition", `attachment; filename="${filename}"`);
    }
    return `https://fake-minio.test/immutable-download/${encodeURIComponent(key)}?${params.toString()}`;
  }

  async head(key: string, versionId?: string): Promise<ObjectStat | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    if (versionId && o.versionId !== versionId) return null;
    return {
      size: o.body.length,
      etag: o.etag,
      contentType: o.contentType,
      lastModified: o.mtime,
      versionId: o.versionId,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async healthCheck(): Promise<void> {
    if (!this.healthy) throw new Error("Fake bucket unhealthy");
  }

  async assertDataMarketImmutability(): Promise<void> {
    if (!this.immutableControlsReady) throw new Error("Immutable bucket controls unavailable");
  }

  async assertDataMarketStagingSafety(): Promise<void> {
    if (!this.stagingControlsReady) throw new Error("Staging bucket must not enable Object Lock");
  }

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const uploadId = `fake-upload-${this.uploads.size + 1}-${key}`;
    this.uploads.set(uploadId, { key, contentType, parts: new Map() });
    return { uploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSec: number,
  ): Promise<string> {
    return `https://fake-minio.test/part/${encodeURIComponent(key)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&expires=${expiresInSec}`;
  }

  /** Test-only: simulate the client PUTting a part directly to the store. */
  async putUploadedPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<{ etag: string }> {
    const up = this.uploads.get(uploadId);
    if (!up || up.key !== key) throw new Error(`NoSuchUpload: ${uploadId}`);
    const etag = simpleEtag(body);
    up.parts.set(partNumber, { body, etag });
    return { etag };
  }

  async listUploadParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; etag: string }[]> {
    const up = this.uploads.get(uploadId);
    if (!up || up.key !== key) throw new Error(`NoSuchUpload: ${uploadId}`);
    return [...up.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, p]) => ({ partNumber, etag: p.etag }));
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<{ etag: string }> {
    const up = this.uploads.get(uploadId);
    if (!up || up.key !== key) throw new Error(`NoSuchUpload: ${uploadId}`);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];
    for (const ref of ordered) {
      const staged = up.parts.get(ref.partNumber);
      if (!staged) throw new Error(`NoSuchPart: ${ref.partNumber}`);
      if (staged.etag !== ref.etag) {
        throw new Error(`Part ${ref.partNumber} etag mismatch: ${ref.etag} != ${staged.etag}`);
      }
      buffers.push(staged.body);
    }
    const body = Buffer.concat(buffers);
    const etag = `${simpleEtag(body)}-${ordered.length}`;
    this.objects.set(key, {
      body,
      contentType: up.contentType,
      etag,
      mtime: new Date(),
      versionId: this.nextVersionId(),
    });
    this.uploads.delete(uploadId);
    return { etag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const up = this.uploads.get(uploadId);
    if (up && up.key === key) this.uploads.delete(uploadId);
  }

  /** Test helper — peek at object count. */
  size(): number {
    return this.objects.size;
  }

  private nextVersionId(): string {
    this.version += 1;
    return `version-${this.version}`;
  }

  private putObject(
    objects: Map<
      string,
      { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
    >,
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): { etag: string } {
    const buf = body instanceof Buffer ? body : Buffer.from(body);
    const etag = simpleEtag(buf);
    objects.set(key, {
      body: buf,
      contentType,
      etag,
      mtime: new Date(),
      versionId: this.nextVersionId(),
    });
    return { etag };
  }

  private headObject(
    objects: Map<
      string,
      { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
    >,
    key: string,
    versionId?: string,
  ): ObjectStat | null {
    const object = objects.get(key);
    if (!object || (versionId && object.versionId !== versionId)) return null;
    return this.objectStat(object);
  }

  private objectStat(object: {
    body: Buffer;
    contentType: string;
    etag: string;
    mtime: Date;
    versionId: string;
  }): ObjectStat {
    return {
      size: object.body.length,
      etag: object.etag,
      contentType: object.contentType,
      lastModified: object.mtime,
      versionId: object.versionId,
    };
  }

  private sha256Object(
    objects: Map<
      string,
      { body: Buffer; contentType: string; etag: string; mtime: Date; versionId: string }
    >,
    key: string,
    versionId?: string,
  ): string | null {
    const object = objects.get(key);
    if (!object || (versionId && object.versionId !== versionId)) return null;
    return createHash("sha256").update(object.body).digest("hex");
  }
}

function simpleEtag(buf: Buffer): string {
  // Cheap deterministic etag for tests; not a real MD5.
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i] ?? 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("loadMinioConfigFromEnv", () => {
  test("parses a fully-specified env", () => {
    const cfg = loadMinioConfigFromEnv({
      NETDRIVE_ENDPOINT: "minio.example.com",
      NETDRIVE_PORT: "9100",
      NETDRIVE_USE_SSL: "true",
      NETDRIVE_ACCESS_KEY: "ak",
      NETDRIVE_SECRET_KEY: "sk",
      NETDRIVE_BUCKET: "kq-netdrive",
      DATA_MARKET_STAGING_BUCKET: "kq-data-market-staging",
      DATA_MARKET_IMMUTABLE_BUCKET: "kq-data-market-immutable",
      DATA_MARKET_COMMITTER_ACCESS_KEY: "ak",
      NETDRIVE_REGION: "cn-east-1",
    });
    expect(cfg.endpoint).toBe("minio.example.com");
    expect(cfg.port).toBe(9100);
    expect(cfg.useSSL).toBe(true);
    expect(cfg.accessKey).toBe("ak");
    expect(cfg.secretKey).toBe("sk");
    expect(cfg.bucket).toBe("kq-netdrive");
    expect(cfg.dataMarketStagingBucket).toBe("kq-data-market-staging");
    expect(cfg.dataMarketImmutableBucket).toBe("kq-data-market-immutable");
    expect(cfg.region).toBe("cn-east-1");
  });

  test("defaults port=9000 and useSSL=false when omitted", () => {
    const cfg = loadMinioConfigFromEnv({
      NETDRIVE_ENDPOINT: "h",
      NETDRIVE_ACCESS_KEY: "ak",
      NETDRIVE_SECRET_KEY: "sk",
      NETDRIVE_BUCKET: "b",
      DATA_MARKET_STAGING_BUCKET: "staging",
      DATA_MARKET_IMMUTABLE_BUCKET: "immutable",
      DATA_MARKET_COMMITTER_ACCESS_KEY: "ak",
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.useSSL).toBe(false);
  });

  test("throws with each missing var listed", () => {
    expect(() => loadMinioConfigFromEnv({})).toThrow(/NETDRIVE_ENDPOINT/);
    expect(() => loadMinioConfigFromEnv({})).toThrow(/NETDRIVE_BUCKET/);
    expect(() => loadMinioConfigFromEnv({})).toThrow(/DATA_MARKET_STAGING_BUCKET/);
  });

  test("rejects a non-positive immutable retention period", () => {
    expect(() =>
      loadMinioConfigFromEnv({
        NETDRIVE_ENDPOINT: "h",
        NETDRIVE_ACCESS_KEY: "ak",
        NETDRIVE_SECRET_KEY: "sk",
        NETDRIVE_BUCKET: "b",
        DATA_MARKET_STAGING_BUCKET: "staging",
        DATA_MARKET_IMMUTABLE_BUCKET: "immutable",
        DATA_MARKET_COMMITTER_ACCESS_KEY: "ak",
        DATA_MARKET_IMMUTABLE_RETENTION_DAYS: "0",
      }),
    ).toThrow(/DATA_MARKET_IMMUTABLE_RETENTION_DAYS/);
  });

  test("rejects root credentials or a mismatched committer identity", () => {
    const base = {
      NETDRIVE_ENDPOINT: "h",
      NETDRIVE_ACCESS_KEY: "committer",
      NETDRIVE_SECRET_KEY: "sk",
      NETDRIVE_BUCKET: "b",
      DATA_MARKET_STAGING_BUCKET: "staging",
      DATA_MARKET_IMMUTABLE_BUCKET: "immutable",
    };
    expect(() =>
      loadMinioConfigFromEnv({ ...base, DATA_MARKET_COMMITTER_ACCESS_KEY: "other" }),
    ).toThrow(/DATA_MARKET_COMMITTER_ACCESS_KEY/);
    expect(() =>
      loadMinioConfigFromEnv({
        ...base,
        DATA_MARKET_COMMITTER_ACCESS_KEY: "committer",
        MINIO_ROOT_USER: "committer",
      }),
    ).toThrow(/MINIO_ROOT_USER/);
    expect(() =>
      loadMinioConfigFromEnv({
        ...base,
        DATA_MARKET_COMMITTER_ACCESS_KEY: "committer",
        RUSTFS_ACCESS_KEY: "committer",
      }),
    ).toThrow(/RUSTFS_ACCESS_KEY/);
  });
});

describe("Data Market immutable bucket controls", () => {
  const objectLock = {
    objectLockEnabled: "Enabled",
    mode: "COMPLIANCE",
    unit: "DAYS",
    validity: 365,
  };

  test("accepts versioning with default COMPLIANCE retention", () => {
    expect(() =>
      assertDataMarketImmutableBucketControls({
        bucket: "kq-data-market-immutable",
        immutableRetentionDays: 365,
        versioning: { Status: "Enabled" },
        objectLock,
      }),
    ).not.toThrow();
  });

  test("rejects a default retention period below the configured minimum", () => {
    expect(() =>
      assertDataMarketImmutableBucketControls({
        bucket: "kq-data-market-immutable",
        immutableRetentionDays: 365,
        versioning: { Status: "Enabled" },
        objectLock: { ...objectLock, validity: 364 },
      }),
    ).toThrow(/default COMPLIANCE/);
  });

  test("rejects an immutable bucket that has not enabled Object Lock", () => {
    expect(() =>
      assertDataMarketImmutableBucketControls({
        bucket: "kq-data-market-immutable",
        immutableRetentionDays: 365,
        versioning: { Status: "Enabled" },
        objectLock: {},
      }),
    ).toThrow(/Object Lock Enabled/);
  });

  test("rejects a non-COMPLIANCE default retention mode", () => {
    expect(() =>
      assertDataMarketImmutableBucketControls({
        bucket: "kq-data-market-immutable",
        immutableRetentionDays: 365,
        versioning: { Status: "Enabled" },
        objectLock: { ...objectLock, mode: "GOVERNANCE" },
      }),
    ).toThrow(/default COMPLIANCE/);
  });
});

describe("MinIO immutable copy version IDs", () => {
  test("prefers the SDK's VersionId while supporting legacy lowercase results", () => {
    expect(copyResultVersionId({ VersionId: "committed-version" })).toBe("committed-version");
    expect(copyResultVersionId({ versionId: "legacy-version" })).toBe("legacy-version");
    expect(copyResultVersionId({ VersionId: null, versionId: null })).toBeUndefined();
  });
});

describe("Data Market staging bucket controls", () => {
  test("requires staging and immutable buckets to be distinct", () => {
    expect(() =>
      assertDataMarketStagingBucketSeparation({
        stagingBucket: "kq-data-market",
        immutableBucket: "kq-data-market",
      }),
    ).toThrow(/must differ/);
  });

  test("rejects Object Lock on staging", () => {
    expect(() => assertDataMarketStagingBucketControls({ objectLockEnabled: "Enabled" })).toThrow(
      /must not enable Object Lock/,
    );
    expect(() => assertDataMarketStagingBucketControls({})).not.toThrow();
  });
});

describe("FakeMinioBackend", () => {
  test("putBlob -> getBlob roundtrip preserves bytes", async () => {
    const backend = new FakeMinioBackend();
    const body = Buffer.from("hello netdrive");
    const { etag } = await backend.putBlob("k1", body, "text/plain");
    expect(etag).toMatch(/^[0-9a-f]{8}$/);
    const got = await backend.getBlob("k1");
    expect(got.toString()).toBe("hello netdrive");
  });

  test("head returns null for missing key", async () => {
    const backend = new FakeMinioBackend();
    expect(await backend.head("missing")).toBeNull();
  });

  test("sha256 streams the stored object digest", async () => {
    const backend = new FakeMinioBackend();
    await backend.putBlob("digest", Buffer.from("abc"), "text/plain");
    expect(await backend.sha256("digest")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await backend.sha256("missing")).toBeNull();
  });

  test("head returns metadata after putBlob", async () => {
    const backend = new FakeMinioBackend();
    await backend.putBlob("k2", Buffer.from("abc"), "application/octet-stream");
    const stat = await backend.head("k2");
    expect(stat?.size).toBe(3);
    expect(stat?.contentType).toBe("application/octet-stream");
  });

  test("presignUpload / presignDownload return distinct URLs", async () => {
    const backend = new FakeMinioBackend();
    const up = await backend.presignUpload("k3", 60);
    const down = await backend.presignDownload("k3", 60);
    expect(up).toContain("/upload/");
    expect(down).toContain("/download/");
    expect(up).not.toBe(down);
  });

  test("presignDownload can request a browser download filename", async () => {
    const backend = new FakeMinioBackend();
    const down = await backend.presignDownload("object-uuid", 60, "chunks_a.txt", "version-7");
    const url = new URL(down);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="chunks_a.txt"',
    );
    expect(url.searchParams.get("versionId")).toBe("version-7");
  });

  test("presignImmutableDownload is bucket-scoped and requires an exact version", async () => {
    const backend = new FakeMinioBackend();
    const down = await backend.presignImmutableDownload(
      "data-market/immutable/sha256/key",
      60,
      "v1",
    );
    const url = new URL(down);
    expect(url.pathname).toContain("/immutable-download/");
    expect(url.searchParams.get("versionId")).toBe("v1");
  });

  test("delete removes the object", async () => {
    const backend = new FakeMinioBackend();
    await backend.putBlob("k4", Buffer.from("x"), "text/plain");
    await backend.delete("k4");
    expect(await backend.head("k4")).toBeNull();
  });

  test("immutable copy returns a new fixed version for each committed copy", async () => {
    const backend = new FakeMinioBackend();
    await backend.putStagingBlob("uploads/one", Buffer.from("first"), "text/plain");
    const first = await backend.copyStagingToImmutable(
      "uploads/one",
      "data-market/immutable/sha256/key",
      {
        sourceEtag: (await backend.headStaging("uploads/one"))?.etag ?? "",
        contentType: "text/plain",
        retainUntil: new Date("2027-01-01T00:00:00.000Z"),
      },
    );
    await backend.putStagingBlob("uploads/two", Buffer.from("second"), "text/plain");
    const second = await backend.copyStagingToImmutable(
      "uploads/two",
      "data-market/immutable/sha256/key",
      {
        sourceEtag: (await backend.headStaging("uploads/two"))?.etag ?? "",
        contentType: "text/plain",
        retainUntil: new Date("2027-01-01T00:00:00.000Z"),
      },
    );
    expect(second.versionId).not.toBe(first.versionId);
    expect(first.lock).toEqual({
      mode: "COMPLIANCE",
      retainUntil: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  test("healthCheck rejects when unhealthy=true and resolves otherwise", async () => {
    const backend = new FakeMinioBackend();
    await backend.healthCheck();
    backend.healthy = false;
    await expect(backend.healthCheck()).rejects.toThrow();
  });

  test("multipart roundtrip assembles parts in order", async () => {
    const backend = new FakeMinioBackend();
    const { uploadId } = await backend.createMultipartUpload("mp1", "application/octet-stream");
    expect(uploadId).toMatch(/.+/);
    const url1 = await backend.presignUploadPart("mp1", uploadId, 1, 60);
    const url2 = await backend.presignUploadPart("mp1", uploadId, 2, 60);
    expect(url1).not.toBe(url2);
    // Simulate the client PUTting each part directly to the fake store.
    const e1 = await backend.putUploadedPart("mp1", uploadId, 1, Buffer.from("AAAA"));
    const e2 = await backend.putUploadedPart("mp1", uploadId, 2, Buffer.from("BB"));
    const parts = await backend.listUploadParts("mp1", uploadId);
    expect(parts).toEqual([
      { partNumber: 1, etag: e1.etag },
      { partNumber: 2, etag: e2.etag },
    ]);
    const { etag } = await backend.completeMultipartUpload("mp1", uploadId, [
      { partNumber: 2, etag: e2.etag },
      { partNumber: 1, etag: e1.etag },
    ]);
    expect(etag).toMatch(/.+/);
    const got = await backend.getBlob("mp1");
    expect(got.toString()).toBe("AAAABB"); // ordered by partNumber, not call order
    const stat = await backend.head("mp1");
    expect(stat?.size).toBe(6);
  });

  test("abortMultipartUpload discards staged parts and leaves no object", async () => {
    const backend = new FakeMinioBackend();
    const { uploadId } = await backend.createMultipartUpload("mp2", "text/plain");
    await backend.putUploadedPart("mp2", uploadId, 1, Buffer.from("xxxxx"));
    await backend.abortMultipartUpload("mp2", uploadId);
    expect(await backend.head("mp2")).toBeNull();
    await expect(backend.listUploadParts("mp2", uploadId)).rejects.toThrow(/NoSuchUpload/);
  });

  test("completeMultipartUpload rejects an unknown part etag", async () => {
    const backend = new FakeMinioBackend();
    const { uploadId } = await backend.createMultipartUpload("mp3", "text/plain");
    const e1 = await backend.putUploadedPart("mp3", uploadId, 1, Buffer.from("data"));
    await expect(
      backend.completeMultipartUpload("mp3", uploadId, [{ partNumber: 1, etag: "deadbeef" }]),
    ).rejects.toThrow(/etag/i);
    expect(e1.etag).toMatch(/^[0-9a-f]{8}$/);
  });
});
