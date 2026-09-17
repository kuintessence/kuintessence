import {
  dataAssetFiles,
  dataAssetManifestEntries,
  dataAssetVersions,
  dataLocations,
  dataUploadSessions,
  type PgDb,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import type { MinioBackend, ObjectStat } from "../storage/minio-client";
import type { DataAssetVersion, DataUploadPort, DataUploadSession } from "./data-market";

const DEFAULT_UPLOAD_TTL_SEC = 15 * 60;

export interface StoredDataUploadSession {
  id: string;
  assetId: string;
  version: string;
  ownerUserId: string;
  locationKind: "platform-object" | "user-private-object";
  objectPath: string;
  storageKey: string;
  expectedSizeBytes: number;
  expectedContentType: string;
  status: "pending" | "completed" | "expired" | "failed";
  expiresAt: Date;
  committedVersionId: string | null;
  committedSha256: string | null;
}

export interface DataMarketObjectUploadRepository {
  createSession(
    input: Omit<
      StoredDataUploadSession,
      "id" | "status" | "committedVersionId" | "committedSha256"
    >,
  ): Promise<StoredDataUploadSession>;
  getSession(sessionId: string): Promise<StoredDataUploadSession | null>;
  expireSession(sessionId: string): Promise<void>;
  failSession(sessionId: string): Promise<void>;
  completeSession(input: {
    sessionId: string;
    ownerUserId: string;
    sha256: string;
    stat: ObjectStat;
    committedStorageKey: string;
    objectVersionId?: string;
    objectLock: { mode: "COMPLIANCE"; retainUntil: Date };
    committedAt: Date;
  }): Promise<DataAssetVersion>;
}

export interface DataMarketObjectUploadServiceOptions {
  uploadTtlSec?: number;
  immutableRetentionDays?: number;
  now?: () => Date;
}

export class DataMarketObjectUploadService implements DataUploadPort {
  private readonly uploadTtlSec: number;
  private readonly immutableRetentionDays: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: DataMarketObjectUploadRepository,
    private readonly minio: Pick<
      MinioBackend,
      | "copyStagingToImmutable"
      | "deleteStaging"
      | "headImmutable"
      | "headStaging"
      | "presignStagingUpload"
      | "sha256Immutable"
      | "sha256Staging"
    >,
    options: DataMarketObjectUploadServiceOptions = {},
  ) {
    this.uploadTtlSec = options.uploadTtlSec ?? DEFAULT_UPLOAD_TTL_SEC;
    this.immutableRetentionDays = options.immutableRetentionDays ?? 365;
    this.now = options.now ?? (() => new Date());
  }

  async createUploadSession(input: {
    assetId: string;
    version: string;
    ownerUserId: string;
    locationKind: "platform-object" | "user-private-object";
    objectPath: string;
    sizeBytes: number;
    mediaType: string;
  }): Promise<DataUploadSession> {
    const now = this.now();
    const storageKey = this.storageKey(input);
    const expiresAt = new Date(now.getTime() + this.uploadTtlSec * 1000);
    const session = await this.repository.createSession({
      assetId: input.assetId,
      version: input.version,
      ownerUserId: input.ownerUserId,
      locationKind: input.locationKind,
      objectPath: input.objectPath,
      storageKey,
      expectedSizeBytes: input.sizeBytes,
      expectedContentType: input.mediaType,
      expiresAt,
    });
    const uploadUrl = await this.minio.presignStagingUpload(
      storageKey,
      this.uploadTtlSec,
      input.mediaType,
    );
    return {
      id: session.id,
      assetId: session.assetId,
      version: session.version,
      locationKind: session.locationKind,
      objectKey: session.storageKey,
      uploadUrl,
      expiresAt: session.expiresAt,
    };
  }

  async getUploadSessionAsset(input: { sessionId: string; ownerUserId: string }): Promise<string> {
    const session = await this.repository.getSession(input.sessionId);
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, "Data upload session not found", 404);
    if (session.ownerUserId !== input.ownerUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Data upload session owner mismatch", 403);
    }
    if (session.status !== "pending" && session.status !== "completed") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Data upload session is not usable", 409);
    }
    return session.assetId;
  }

  async commitUploadSession(input: {
    sessionId: string;
    ownerUserId: string;
    sha256?: string;
  }): Promise<DataAssetVersion> {
    if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid object sha256", 400);
    }
    const session = await this.repository.getSession(input.sessionId);
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, "Data upload session not found", 404);
    if (session.ownerUserId !== input.ownerUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Data upload session owner mismatch", 403);
    }
    if (session.status === "completed") {
      if (input.sha256 && session.committedSha256 !== input.sha256.toLowerCase()) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Upload session was already committed", 409);
      }
      const version = await this.repository.completeSession({
        sessionId: input.sessionId,
        ownerUserId: input.ownerUserId,
        sha256: session.committedSha256 ?? "",
        stat: {
          size: session.expectedSizeBytes,
          contentType: session.expectedContentType,
          etag: "",
          lastModified: this.now(),
        },
        committedStorageKey: immutableStorageKey(session.committedSha256 ?? ""),
        objectLock: this.committedObjectLock(),
        committedAt: this.now(),
      });
      await this.minio.deleteStaging(session.storageKey);
      return version;
    }
    if (session.status !== "pending") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Data upload session is not usable", 409);
    }
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      await this.repository.expireSession(session.id);
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Data upload session has expired", 410);
    }
    const sourceStatBefore = await this.minio.headStaging(session.storageKey);
    if (!sourceStatBefore) {
      await this.repository.failSession(session.id);
      throw new AppError(ErrorCode.NOT_FOUND, "Uploaded object was not found", 404);
    }
    if (
      sourceStatBefore.size !== session.expectedSizeBytes ||
      sourceStatBefore.contentType !== session.expectedContentType
    ) {
      await this.repository.failSession(session.id);
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Uploaded object metadata does not match",
        400,
      );
    }
    const actualSha256 = await this.minio.sha256Staging(session.storageKey);
    if (!actualSha256) {
      await this.repository.failSession(session.id);
      throw new AppError(ErrorCode.NOT_FOUND, "Uploaded object was not found", 404);
    }
    if (input.sha256 && actualSha256 !== input.sha256.toLowerCase()) {
      await this.repository.failSession(session.id);
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Uploaded object sha256 does not match", 400);
    }
    const sourceStatAfter = await this.minio.headStaging(session.storageKey);
    if (!sourceStatAfter || !sameObject(sourceStatBefore, sourceStatAfter)) {
      await this.repository.failSession(session.id);
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Uploaded object changed during commit", 409);
    }
    const committedStorageKey = immutableStorageKey(actualSha256);
    const committed = await this.ensureImmutableObject({
      sourceKey: session.storageKey,
      targetKey: committedStorageKey,
      sourceStat: sourceStatAfter,
      sha256: actualSha256,
    });
    const version = await this.repository.completeSession({
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      sha256: actualSha256,
      stat: committed.stat,
      committedStorageKey,
      objectVersionId: committed.objectVersionId,
      objectLock: committed.objectLock,
      committedAt: this.now(),
    });
    await this.minio.deleteStaging(session.storageKey);
    return version;
  }

  private storageKey(_input: {
    assetId: string;
    ownerUserId: string;
    locationKind: "platform-object" | "user-private-object";
  }): string {
    return `data-market/staging/${crypto.randomUUID()}`;
  }

  private async ensureImmutableObject(input: {
    sourceKey: string;
    targetKey: string;
    sourceStat: ObjectStat;
    sha256: string;
  }): Promise<{
    stat: ObjectStat;
    objectVersionId?: string;
    objectLock: { mode: "COMPLIANCE"; retainUntil: Date };
  }> {
    const objectLock = this.committedObjectLock();
    const copied = await this.minio.copyStagingToImmutable(input.sourceKey, input.targetKey, {
      sourceEtag: input.sourceStat.etag,
      contentType: input.sourceStat.contentType,
      retainUntil: objectLock.retainUntil,
    });
    if (!copied.versionId) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Immutable object copy did not return a version ID",
        503,
      );
    }
    const committed = await this.minio.headImmutable(input.targetKey, copied.versionId);
    if (!committed) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Immutable object copy version was not visible",
        503,
      );
    }
    await this.assertImmutableObject(committed, input.targetKey, input.sha256, copied.versionId);
    return { stat: committed, objectVersionId: copied.versionId, objectLock: copied.lock };
  }

  private async assertImmutableObject(
    stat: ObjectStat,
    storageKey: string,
    expectedSha256: string,
    expectedVersionId: string,
  ): Promise<void> {
    if (stat.versionId !== expectedVersionId) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Immutable object version changed", 503);
    }
    if (stat.size <= 0) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Immutable object verification failed", 503);
    }
    const actualSha256 = await this.minio.sha256Immutable(storageKey, expectedVersionId);
    if (!actualSha256 || actualSha256 !== expectedSha256) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Immutable object digest collision", 409);
    }
  }

  private committedObjectLock(): { mode: "COMPLIANCE"; retainUntil: Date } {
    return {
      mode: "COMPLIANCE",
      retainUntil: new Date(this.now().getTime() + this.immutableRetentionDays * 86_400_000),
    };
  }
}

export class PgDataMarketObjectUploadRepository implements DataMarketObjectUploadRepository {
  constructor(
    private readonly db: PgDb,
    private readonly bucket: string,
  ) {}

  async createSession(
    input: Omit<
      StoredDataUploadSession,
      "id" | "status" | "committedVersionId" | "committedSha256"
    >,
  ): Promise<StoredDataUploadSession> {
    const [row] = await this.db
      .insert(dataUploadSessions)
      .values({
        dataAssetId: input.assetId,
        targetVersion: input.version,
        ownerUserId: input.ownerUserId,
        locationKind: input.locationKind,
        objectPath: input.objectPath,
        storageKey: input.storageKey,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedContentType: input.expectedContentType,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Data upload session insert failed", 500);
    return toStoredSession(row);
  }

  async getSession(sessionId: string): Promise<StoredDataUploadSession | null> {
    const [row] = await this.db
      .select()
      .from(dataUploadSessions)
      .where(eq(dataUploadSessions.id, sessionId))
      .limit(1);
    return row ? toStoredSession(row) : null;
  }

  async expireSession(sessionId: string): Promise<void> {
    await this.db
      .update(dataUploadSessions)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(dataUploadSessions.id, sessionId), eq(dataUploadSessions.status, "pending")));
  }

  async failSession(sessionId: string): Promise<void> {
    await this.db
      .update(dataUploadSessions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(dataUploadSessions.id, sessionId), eq(dataUploadSessions.status, "pending")));
  }

  async completeSession(input: {
    sessionId: string;
    ownerUserId: string;
    sha256: string;
    stat: ObjectStat;
    committedStorageKey: string;
    objectVersionId?: string;
    objectLock: { mode: "COMPLIANCE"; retainUntil: Date };
    committedAt: Date;
  }): Promise<DataAssetVersion> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(dataUploadSessions)
        .where(eq(dataUploadSessions.id, input.sessionId))
        .for("update")
        .limit(1);
      if (!session) throw new AppError(ErrorCode.NOT_FOUND, "Data upload session not found", 404);
      if (session.ownerUserId !== input.ownerUserId) {
        throw new AppError(ErrorCode.FORBIDDEN, "Data upload session owner mismatch", 403);
      }
      if (session.status === "completed" && session.committedVersionId) {
        if (session.committedSha256 !== input.sha256.toLowerCase()) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Upload session was already committed",
            409,
          );
        }
        const [version] = await tx
          .select()
          .from(dataAssetVersions)
          .where(eq(dataAssetVersions.id, session.committedVersionId))
          .limit(1);
        if (!version)
          throw new AppError(ErrorCode.INTERNAL_ERROR, "Committed version is missing", 500);
        return toVersion(version);
      }
      if (
        session.status !== "pending" ||
        session.expiresAt.getTime() <= input.committedAt.getTime()
      ) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Data upload session is not usable", 409);
      }
      if (
        input.stat.size !== session.expectedSizeBytes ||
        input.stat.contentType !== session.expectedContentType
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Uploaded object metadata does not match",
          400,
        );
      }
      const [existing] = await tx
        .select({ id: dataAssetVersions.id })
        .from(dataAssetVersions)
        .where(
          and(
            eq(dataAssetVersions.dataAssetId, session.dataAssetId),
            eq(dataAssetVersions.version, session.targetVersion),
          ),
        )
        .limit(1);
      if (existing)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Data asset version already exists", 409);
      const digest = input.sha256.toLowerCase();
      const manifest = {
        checksum: digest,
        sizeBytes: input.stat.size,
        mediaType: input.stat.contentType,
        source: session.locationKind,
      };
      const [version] = await tx
        .insert(dataAssetVersions)
        .values({
          dataAssetId: session.dataAssetId,
          version: session.targetVersion,
          status: "ready",
          contentHash: digest,
          manifestDigest: digest,
          sizeBytes: input.stat.size,
          format: input.stat.contentType,
          manifest,
          immutableAt: input.committedAt,
          createdBy: session.ownerUserId,
          updatedAt: input.committedAt,
        })
        .returning();
      if (!version) throw new AppError(ErrorCode.INTERNAL_ERROR, "Data version insert failed", 500);
      const [location] = await tx
        .insert(dataLocations)
        .values({
          dataAssetVersionId: version.id,
          kind: session.locationKind,
          uri: `s3://${this.bucket}/${input.committedStorageKey}`,
          status: "available",
          metadata: {
            storageKey: input.committedStorageKey,
            objectVersionId: input.objectVersionId ?? null,
            objectLock: input.objectLock,
          },
          updatedAt: input.committedAt,
        })
        .returning();
      if (!location)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data location insert failed", 500);
      const [file] = await tx
        .insert(dataAssetFiles)
        .values({
          dataAssetVersionId: version.id,
          locationId: location.id,
          path: session.objectPath,
          digest,
          sizeBytes: input.stat.size,
          mediaType: input.stat.contentType,
          metadata: {
            objectKey: input.committedStorageKey,
            objectVersionId: input.objectVersionId ?? null,
            objectLock: input.objectLock,
          },
        })
        .returning();
      if (!file) throw new AppError(ErrorCode.INTERNAL_ERROR, "Data file insert failed", 500);
      await tx.insert(dataAssetManifestEntries).values({
        dataAssetVersionId: version.id,
        dataAssetFileId: file.id,
        entryPath: session.objectPath,
        digest,
        sizeBytes: input.stat.size,
        mediaType: input.stat.contentType,
      });
      await tx
        .update(dataUploadSessions)
        .set({
          status: "completed",
          committedVersionId: version.id,
          committedSha256: digest,
          committedEtag: input.stat.etag,
          commitMetadata: {
            sizeBytes: input.stat.size,
            contentType: input.stat.contentType,
            immutableObjectKey: input.committedStorageKey,
            objectVersionId: input.objectVersionId ?? null,
            objectLock: input.objectLock,
          },
          committedAt: input.committedAt,
          updatedAt: input.committedAt,
        })
        .where(eq(dataUploadSessions.id, session.id));
      return toVersion(version);
    });
  }
}

function immutableStorageKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid committed object sha256", 409);
  }
  return `data-market/immutable/sha256/${sha256.toLowerCase()}`;
}

function sameObject(before: ObjectStat, after: ObjectStat): boolean {
  return (
    before.etag === after.etag &&
    before.versionId === after.versionId &&
    before.size === after.size &&
    before.contentType === after.contentType
  );
}

export class UnavailableDataMarketUploadPort implements DataUploadPort {
  async createUploadSession(): Promise<DataUploadSession> {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "DATA_MARKET_UPLOAD_UNAVAILABLE: object storage is not configured",
      503,
    );
  }

  async getUploadSessionAsset(): Promise<string> {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "DATA_MARKET_UPLOAD_UNAVAILABLE: object storage is not configured",
      503,
    );
  }

  async commitUploadSession(): Promise<DataAssetVersion> {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "DATA_MARKET_UPLOAD_UNAVAILABLE: object storage is not configured",
      503,
    );
  }
}

function toStoredSession(row: typeof dataUploadSessions.$inferSelect): StoredDataUploadSession {
  return {
    id: row.id,
    assetId: row.dataAssetId,
    version: row.targetVersion,
    ownerUserId: row.ownerUserId,
    locationKind: row.locationKind as StoredDataUploadSession["locationKind"],
    objectPath: row.objectPath,
    storageKey: row.storageKey,
    expectedSizeBytes: row.expectedSizeBytes,
    expectedContentType: row.expectedContentType,
    status: row.status as StoredDataUploadSession["status"],
    expiresAt: row.expiresAt,
    committedVersionId: row.committedVersionId,
    committedSha256: row.committedSha256,
  };
}

function toVersion(row: typeof dataAssetVersions.$inferSelect): DataAssetVersion {
  return {
    id: row.id,
    assetId: row.dataAssetId,
    version: row.version,
    status: row.status as DataAssetVersion["status"],
    manifestDigest: row.manifestDigest,
    manifest: row.manifest,
    immutableAt: row.immutableAt,
    createdBy: row.createdBy ?? "",
    createdAt: row.createdAt,
  };
}
