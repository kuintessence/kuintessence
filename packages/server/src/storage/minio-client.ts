import { createHash } from "node:crypto";

/**
 * minimal MinIO/S3 client wrapper for the NetDrive foundation.
 *
 * The wrapper exposes ONLY the surface the netdrive service needs
 * (`putBlob`, `getBlob`, `presignUpload`, `presignDownload`, `head`,
 * `delete`, `healthCheck`). Tests inject a mock `MinioBackend` that
 * matches the same interface so unit tests do NOT require a live MinIO
 * — see `minio-client.test.ts` for the in-memory fake.
 *
 * The real backend is the `minio` npm package — added to
 * `packages/server/package.json` but loaded LAZILY (dynamic import inside
 * `createRealMinioBackend`) so the rest of the Server keeps starting in
 * environments where the package isn't installed yet, e.g. CI before
 * `bun install` lands or developer machines that disable NetDrive via
 * `NETDRIVE_ENABLED=false`.
 */

export interface MinioBackendConfig {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region?: string;
  /** Mutable bucket for ordinary NetDrive objects. */
  bucket: string;
  /** Short-lived, deleteable bucket used only by Data Market upload sessions. */
  dataMarketStagingBucket: string;
  /** Versioned Object Lock bucket for committed Data Market content. */
  dataMarketImmutableBucket: string;
  immutableRetentionDays: number;
  /**
   * Optional public URL (e.g. http://localhost:9000) used to rewrite the
   * scheme + host of presigned URLs the SDK builds with the internal
   * endpoint. When unset, presigned URLs reach back via `endpoint:port`
   * which only works when client and Server share the same network.
   */
  publicUrl?: string;
}

export interface ObjectStat {
  size: number;
  etag: string;
  versionId?: string;
  contentType: string;
  lastModified: Date;
}

export interface UploadPartRef {
  partNumber: number;
  etag: string;
}

/**
 * Backend abstraction so the netdrive service can be tested against a
 * pure-TS in-memory implementation without booting MinIO.
 */
export interface MinioBackend {
  bucket: string;
  dataMarketStagingBucket: string;
  dataMarketImmutableBucket: string;
  putBlob(key: string, body: Buffer | Uint8Array, contentType: string): Promise<{ etag: string }>;
  getBlob(key: string): Promise<Buffer>;
  sha256(key: string, versionId?: string): Promise<string | null>;
  presignStagingUpload(key: string, expiresInSec: number, contentType?: string): Promise<string>;
  headStaging(key: string): Promise<ObjectStat | null>;
  sha256Staging(key: string): Promise<string | null>;
  deleteStaging(key: string): Promise<void>;
  copyStagingToImmutable(
    sourceKey: string,
    targetKey: string,
    options: {
      sourceEtag: string;
      contentType: string;
      retainUntil: Date;
    },
  ): Promise<ImmutableObjectCommit>;
  headImmutable(key: string, versionId?: string): Promise<ObjectStat | null>;
  sha256Immutable(key: string, versionId?: string): Promise<string | null>;
  presignUpload(key: string, expiresInSec: number, contentType?: string): Promise<string>;
  presignDownload(
    key: string,
    expiresInSec: number,
    filename?: string,
    versionId?: string,
  ): Promise<string>;
  /** Presigns an exact committed Data Market object version from the immutable bucket. */
  presignImmutableDownload(
    key: string,
    expiresInSec: number,
    versionId: string,
    filename?: string,
  ): Promise<string>;
  head(key: string, versionId?: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  /** Throws on failure; resolves quietly on a healthy bucket. */
  healthCheck(): Promise<void>;
  /** Verifies the bucket controls required by immutable Data Market commits. */
  assertDataMarketImmutability(): Promise<void>;
  /** Verifies staging is physically separate and does not have Object Lock enabled. */
  assertDataMarketStagingSafety(): Promise<void>;
  /** Begin an S3 multipart upload; returns the server-assigned uploadId. */
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  /** Presigned PUT URL for a single part (`?partNumber=N&uploadId=…`). */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSec: number,
  ): Promise<string>;
  /** List the parts MinIO has so far (recovery when the client sidecar is lost). */
  listUploadParts(key: string, uploadId: string): Promise<UploadPartRef[]>;
  /** Assemble the uploaded parts into the final object. */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPartRef[],
  ): Promise<{ etag: string }>;
  /** Discard an in-flight multipart upload and its staged parts. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export interface ImmutableObjectCommit {
  etag: string;
  versionId?: string;
  lock: {
    mode: "COMPLIANCE";
    retainUntil: Date;
  };
}

/**
 * Lazy-loaded real backend backed by the `minio` npm package.
 *
 * Returns a `MinioBackend` shaped object. The dynamic import means the
 * rest of the Server continues to type-check and boot even when the
 * `minio` package is absent from `node_modules` in deployments without MinIO.
 */
export async function createRealMinioBackend(cfg: MinioBackendConfig): Promise<MinioBackend> {
  // A runtime import keeps MinIO optional for deployments that disable NetDrive.
  const importer = (specifier: string): Promise<unknown> =>
    Function("s", "return import(s)")(specifier) as Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: minio sdk types pull in S3 surface we don't use; we narrow per-call.
  const mod: any = await importer("minio").catch((err) => {
    throw new Error(
      `NETDRIVE_ENABLED requires the 'minio' npm package. Install it via 'bun install' or set NETDRIVE_ENABLED=false. Underlying error: ${(err as Error).message}`,
    );
  });
  // biome-ignore lint/suspicious/noExplicitAny: minio sdk Client constructor isn't usefully typed for our subset.
  const Client: any = mod.Client;
  const client = new Client({
    endPoint: cfg.endpoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
  });

  // When NETDRIVE_PUBLIC_URL is set we construct a second client bound to
  // the public endpoint so SigV4 signs URLs with the host browsers can
  // actually reach. We never call put/get/head/healthcheck through it —
  // only presignedPutObject / presignedGetObject.
  // biome-ignore lint/suspicious/noExplicitAny: same untyped Client surface.
  let presignClient: any = client;
  if (cfg.publicUrl) {
    try {
      const pub = new URL(cfg.publicUrl);
      presignClient = new Client({
        endPoint: pub.hostname,
        port: pub.port ? Number(pub.port) : pub.protocol === "https:" ? 443 : 80,
        useSSL: pub.protocol === "https:",
        accessKey: cfg.accessKey,
        secretKey: cfg.secretKey,
        region: cfg.region,
      });
    } catch {
      presignClient = client;
    }
  }

  const backend: MinioBackend = {
    bucket: cfg.bucket,
    dataMarketStagingBucket: cfg.dataMarketStagingBucket,
    dataMarketImmutableBucket: cfg.dataMarketImmutableBucket,

    async putBlob(key, body, contentType) {
      const buf = body instanceof Buffer ? body : Buffer.from(body);
      const meta: Record<string, string> = { "Content-Type": contentType };
      const result = await client.putObject(cfg.bucket, key, buf, buf.length, meta);
      return { etag: stripQuotes(result.etag ?? "") };
    },

    async getBlob(key) {
      const stream = await client.getObject(cfg.bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async sha256(key, versionId) {
      try {
        const stream = await client.getObject(
          cfg.bucket,
          key,
          versionId ? { versionId } : undefined,
        );
        const hash = createHash("sha256");
        for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
        return hash.digest("hex");
      } catch (err) {
        if ((err as { code?: string }).code === "NotFound") return null;
        throw err;
      }
    },

    async presignStagingUpload(key, expiresInSec, _contentType) {
      return await presignClient.presignedPutObject(cfg.dataMarketStagingBucket, key, expiresInSec);
    },

    async headStaging(key) {
      return await statObject(client, cfg.dataMarketStagingBucket, key);
    },

    async sha256Staging(key) {
      return await sha256Object(client, cfg.dataMarketStagingBucket, key);
    },

    async deleteStaging(key) {
      await client.removeObject(cfg.dataMarketStagingBucket, key);
    },

    async copyStagingToImmutable(sourceKey, targetKey, options) {
      const source = new mod.CopySourceOptions({
        Bucket: cfg.dataMarketStagingBucket,
        Object: sourceKey,
        MatchETag: options.sourceEtag,
      });
      const target = new mod.CopyDestinationOptions({
        Bucket: cfg.dataMarketImmutableBucket,
        Object: targetKey,
        Headers: {
          "Content-Type": options.contentType,
        },
        MetadataDirective: "REPLACE",
        Mode: "COMPLIANCE",
        RetainUntilDate: options.retainUntil.toISOString(),
      });
      const result = await client.copyObject(source, target);
      return {
        etag: stripQuotes(result.Etag ?? ""),
        versionId: copyResultVersionId(result),
        lock: { mode: "COMPLIANCE", retainUntil: options.retainUntil },
      };
    },

    async headImmutable(key, versionId) {
      return await statObject(client, cfg.dataMarketImmutableBucket, key, versionId);
    },

    async sha256Immutable(key, versionId) {
      return await sha256Object(client, cfg.dataMarketImmutableBucket, key, versionId);
    },

    async presignUpload(key, expiresInSec, _contentType) {
      return await presignClient.presignedPutObject(cfg.bucket, key, expiresInSec);
    },

    async presignDownload(key, expiresInSec, filename, versionId) {
      const params: Record<string, string> = {};
      if (filename) {
        params["response-content-disposition"] = contentDispositionForDownload(filename);
      }
      if (versionId) params.versionId = versionId;
      return await presignClient.presignedUrl("GET", cfg.bucket, key, expiresInSec, params);
    },

    async presignImmutableDownload(key, expiresInSec, versionId, filename) {
      const params: Record<string, string> = { versionId };
      if (filename) {
        params["response-content-disposition"] = contentDispositionForDownload(filename);
      }
      return await presignClient.presignedUrl(
        "GET",
        cfg.dataMarketImmutableBucket,
        key,
        expiresInSec,
        params,
      );
    },

    async head(key, versionId) {
      try {
        const stat = await client.statObject(
          cfg.bucket,
          key,
          versionId ? { versionId } : undefined,
        );
        return {
          size: stat.size,
          etag: stripQuotes(stat.etag ?? ""),
          versionId: stat.versionId,
          contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
          lastModified: stat.lastModified ?? new Date(),
        };
      } catch (err) {
        // The minio sdk throws an Error with `code === 'NotFound'` for
        // 404. Anything else (auth, network) we surface as-is.
        if ((err as { code?: string }).code === "NotFound") return null;
        throw err;
      }
    },

    async delete(key) {
      await client.removeObject(cfg.bucket, key);
    },

    async createMultipartUpload(key, contentType) {
      const uploadId = await client.initiateNewMultipartUpload(cfg.bucket, key, {
        "Content-Type": contentType,
      });
      return { uploadId };
    },

    async presignUploadPart(key, uploadId, partNumber, expiresInSec) {
      // S3 UploadPart is `PUT …?partNumber=N&uploadId=…`; minio threads
      // reqParams straight into the signed query string.
      return await presignClient.presignedUrl("PUT", cfg.bucket, key, expiresInSec, {
        partNumber: String(partNumber),
        uploadId,
      });
    },

    async listUploadParts(key, uploadId) {
      // `listParts` is marked protected in minio-js' typings but exists at
      // runtime; we reach it through the untyped client the rest of this
      // wrapper already uses. Returns the parts MinIO has accepted so far.
      const parts = (await client.listParts(cfg.bucket, key, uploadId)) as Array<{
        part: number;
        etag: string;
      }>;
      return parts.map((p) => ({ partNumber: p.part, etag: stripQuotes(p.etag ?? "") }));
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const etags = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ part: p.partNumber, etag: p.etag }));
      const result = await client.completeMultipartUpload(cfg.bucket, key, uploadId, etags);
      return { etag: stripQuotes(result.etag ?? "") };
    },

    async abortMultipartUpload(key, uploadId) {
      await client.abortMultipartUpload(cfg.bucket, key, uploadId);
    },

    async healthCheck() {
      const buckets = [cfg.bucket, cfg.dataMarketStagingBucket, cfg.dataMarketImmutableBucket];
      const checks = await Promise.all(buckets.map((bucket) => client.bucketExists(bucket)));
      const missing = buckets.filter((_, index) => !checks[index]);
      if (missing.length > 0) {
        throw new Error(
          `Object storage bucket(s) ${missing.join(", ")} do not exist on ${cfg.endpoint}:${cfg.port}`,
        );
      }
    },

    async assertDataMarketImmutability() {
      const [versioning, objectLock] = await Promise.all([
        client.getBucketVersioning(cfg.dataMarketImmutableBucket),
        client.getObjectLockConfig(cfg.dataMarketImmutableBucket),
      ]);
      assertDataMarketImmutableBucketControls({
        bucket: cfg.dataMarketImmutableBucket,
        immutableRetentionDays: cfg.immutableRetentionDays,
        versioning,
        objectLock,
      });
    },

    async assertDataMarketStagingSafety() {
      assertDataMarketStagingBucketSeparation({
        stagingBucket: cfg.dataMarketStagingBucket,
        immutableBucket: cfg.dataMarketImmutableBucket,
      });
      try {
        const lock = await client.getObjectLockConfig(cfg.dataMarketStagingBucket);
        assertDataMarketStagingBucketControls(lock);
      } catch (error) {
        if (!isMissingObjectLockConfiguration(error)) throw error;
      }
    },
  };

  return backend;
}

async function statObject(
  client: {
    statObject(
      bucket: string,
      key: string,
      options?: { versionId: string },
    ): Promise<{
      size: number;
      etag: string;
      versionId?: string;
      metaData?: Record<string, string>;
      lastModified?: Date;
    }>;
  },
  bucket: string,
  key: string,
  versionId?: string,
): Promise<ObjectStat | null> {
  try {
    const stat = await client.statObject(bucket, key, versionId ? { versionId } : undefined);
    return {
      size: stat.size,
      etag: stripQuotes(stat.etag ?? ""),
      versionId: stat.versionId,
      contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
      lastModified: stat.lastModified ?? new Date(),
    };
  } catch (error) {
    if ((error as { code?: string }).code === "NotFound") return null;
    throw error;
  }
}

async function sha256Object(
  client: {
    getObject(
      bucket: string,
      key: string,
      options?: { versionId: string },
    ): Promise<AsyncIterable<Buffer>>;
  },
  bucket: string,
  key: string,
  versionId?: string,
): Promise<string | null> {
  try {
    const stream = await client.getObject(bucket, key, versionId ? { versionId } : undefined);
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as { code?: string }).code === "NotFound") return null;
    throw error;
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function contentDispositionForDownload(filename: string): string {
  return `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`;
}

/**
 * Convenience env loader so callers don't have to build the config
 * object by hand. Reads `NETDRIVE_*` env vars; throws when required
 * fields are missing.
 *
 * The Server config schema deliberately does NOT include these vars
 * (avoids enlarging the Server's startup contract during the C3 rollout);
 * the netdrive bootstrap reads them on-demand and surfaces a clean
 * error if the deployment hasn't configured MinIO yet.
 */
export function loadMinioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MinioBackendConfig {
  const endpoint = env.NETDRIVE_ENDPOINT;
  const accessKey = env.NETDRIVE_ACCESS_KEY;
  const secretKey = env.NETDRIVE_SECRET_KEY;
  const bucket = env.NETDRIVE_BUCKET;
  const dataMarketStagingBucket = env.DATA_MARKET_STAGING_BUCKET;
  const dataMarketImmutableBucket = env.DATA_MARKET_IMMUTABLE_BUCKET;
  const committerAccessKey = env.DATA_MARKET_COMMITTER_ACCESS_KEY ?? "kq-data-market-committer";
  const missing: string[] = [];
  if (!endpoint) missing.push("NETDRIVE_ENDPOINT");
  if (!accessKey) missing.push("NETDRIVE_ACCESS_KEY");
  if (!secretKey) missing.push("NETDRIVE_SECRET_KEY");
  if (!bucket) missing.push("NETDRIVE_BUCKET");
  if (!dataMarketStagingBucket) missing.push("DATA_MARKET_STAGING_BUCKET");
  if (!dataMarketImmutableBucket) missing.push("DATA_MARKET_IMMUTABLE_BUCKET");
  if (missing.length > 0) {
    throw new Error(`NetDrive configuration missing: ${missing.join(", ")}`);
  }
  if (accessKey !== committerAccessKey) {
    throw new Error("NETDRIVE_ACCESS_KEY must match DATA_MARKET_COMMITTER_ACCESS_KEY");
  }
  if (env.MINIO_ROOT_USER && accessKey === env.MINIO_ROOT_USER) {
    throw new Error("NETDRIVE_ACCESS_KEY must not use MINIO_ROOT_USER");
  }
  if (env.RUSTFS_ACCESS_KEY && accessKey === env.RUSTFS_ACCESS_KEY) {
    throw new Error("NETDRIVE_ACCESS_KEY must not use RUSTFS_ACCESS_KEY");
  }
  const immutableRetentionRaw = env.DATA_MARKET_IMMUTABLE_RETENTION_DAYS ?? "365";
  const immutableRetentionDays = Number(immutableRetentionRaw);
  if (!/^[1-9]\d*$/.test(immutableRetentionRaw) || !Number.isSafeInteger(immutableRetentionDays)) {
    throw new Error("DATA_MARKET_IMMUTABLE_RETENTION_DAYS must be a positive integer");
  }
  assertDataMarketStagingBucketSeparation({
    stagingBucket: dataMarketStagingBucket as string,
    immutableBucket: dataMarketImmutableBucket as string,
  });
  return {
    endpoint: endpoint as string,
    port: Number.parseInt(env.NETDRIVE_PORT ?? "9000", 10),
    useSSL: (env.NETDRIVE_USE_SSL ?? "false").toLowerCase() === "true",
    accessKey: accessKey as string,
    secretKey: secretKey as string,
    region: env.NETDRIVE_REGION,
    bucket: bucket as string,
    dataMarketStagingBucket: dataMarketStagingBucket as string,
    dataMarketImmutableBucket: dataMarketImmutableBucket as string,
    immutableRetentionDays,
    publicUrl: env.NETDRIVE_PUBLIC_URL,
  };
}

export interface ImmutableBucketControls {
  bucket: string;
  immutableRetentionDays: number;
  versioning: { Status?: string };
  objectLock: unknown;
}

export function copyResultVersionId(result: {
  VersionId?: string | null;
  versionId?: string | null;
}): string | undefined {
  return result.VersionId ?? result.versionId ?? undefined;
}

export function assertDataMarketImmutableBucketControls(input: ImmutableBucketControls): void {
  if (input.versioning.Status !== "Enabled") {
    throw new Error("Data Market immutable objects require bucket versioning Status=Enabled");
  }
  if (!hasObjectLockEnabled(input.objectLock)) {
    throw new Error("Data Market immutable objects require Object Lock Enabled");
  }
  if (!hasDefaultComplianceRetention(input.objectLock, input.immutableRetentionDays)) {
    throw new Error(
      "Data Market immutable objects require default COMPLIANCE Object Lock retention",
    );
  }
}

export function assertDataMarketStagingBucketSeparation(input: {
  stagingBucket: string;
  immutableBucket: string;
}): void {
  if (input.stagingBucket === input.immutableBucket) {
    throw new Error("DATA_MARKET_STAGING_BUCKET must differ from DATA_MARKET_IMMUTABLE_BUCKET");
  }
}

export function assertDataMarketStagingBucketControls(objectLock: unknown): void {
  if (hasObjectLockEnabled(objectLock)) {
    throw new Error("Data Market staging bucket must not enable Object Lock");
  }
}

function hasObjectLockEnabled(value: unknown): boolean {
  return isRecord(value) && value.objectLockEnabled === "Enabled";
}

function hasDefaultComplianceRetention(value: unknown, minimumDays: number): boolean {
  if (!isRecord(value)) return false;
  const mode = typeof value.mode === "string" ? value.mode.toUpperCase() : "";
  const validity =
    typeof value.validity === "number" || typeof value.validity === "string"
      ? Number(value.validity)
      : Number.NaN;
  const unit = typeof value.unit === "string" ? value.unit.toUpperCase() : "";
  if (mode !== "COMPLIANCE" || !Number.isFinite(validity)) {
    return false;
  }
  if (unit === "DAYS") return validity >= minimumDays;
  if (unit === "YEARS") return validity * 365 >= minimumDays;
  return false;
}

function isMissingObjectLockConfiguration(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "ObjectLockConfigurationNotFoundError" || code === "NoSuchObjectLockConfiguration"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
