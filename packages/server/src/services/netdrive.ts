import {
  netdriveFiles,
  netdriveReplicas,
  netdriveTransferLog,
  type PgDb,
  userOrgMemberships,
} from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  type NetDriveCommitRequest,
  type NetDriveFile,
  type NetDriveListPartsRequest,
  type NetDriveListPartsResponse,
  type NetDriveMultipartAbortRequest,
  type NetDriveMultipartCompleteRequest,
  type NetDriveMultipartInitRequest,
  type NetDrivePartUrlsRequest,
  type NetDrivePartUrlsResponse,
  type NetDriveUploadUrlRequest,
} from "@kuintessence/shared";
import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import * as jose from "jose";
import type { Logger } from "pino";
import type { MinioBackend } from "../storage/minio-client";
import { lockCloudWrites, StorageQuotaService } from "./storage-quota";

/**
 * NetDrive metadata service.
 *
 * Owns the file-metadata side of the NetDrive split:
 *
 *   1. `mintUploadUrl(ownerId, req)` allocates a synthetic storage key,
 *      asks the MinIO wrapper for a presigned PUT URL, and returns a
 *      `commitToken` that hashes (storage_key, owner_id, intended size,
 *      optional sha256). The token uses HS256 with `commitSecret`.
 *
 *   2. The client uploads bytes directly to MinIO via the presigned URL.
 *
 *   3. `commitFile(ownerId, req)` verifies the commit token, sanity-checks
 *      the actual blob via `head()`, and inserts a `netdrive_files` row.
 *
 *   4. `mintDownloadUrl(ownerId, fileId)` issues a presigned GET URL.
 *
 *   5. `softDelete(ownerId, fileId)` tombstones the row and queues an
 *      object-store delete (best-effort; final consistency is acceptable
 *      for the foundation slice).
 *
 * RBAC is enforced at the route layer; the service trusts the `ownerId`
 * argument it receives. Per-owner rows are scoped by `ownerId IS owner OR
 * caller has admin override` — the override is the route's responsibility.
 */

const STORAGE_PREFIX = "netdrive";
const DEFAULT_UPLOAD_TTL_SEC = 15 * 60;
const DEFAULT_DOWNLOAD_TTL_SEC = 15 * 60;
const DEFAULT_MULTIPART_PART_SIZE = 64 * 1024 * 1024;
const MIN_S3_PART_SIZE = 5 * 1024 * 1024;

export interface NetDriveServiceOptions {
  /** HS256 signing secret for the commit token. Distinct from JWT_SECRET. */
  commitSecret: string;
  /** Override TTLs — primarily for tests. */
  uploadTtlSec?: number;
  downloadTtlSec?: number;
  /**
   * Presign window for multipart init/part URLs. Isolated from `uploadTtlSec`
   * so the (longer) multipart TTL never widens the single-shot upload window.
   */
  multipartTtlSec?: number;
  /** Part size (bytes) for multipart uploads. Defaults to 64 MiB. Min 5 MiB (S3 rule). */
  multipartPartSize?: number;
  /**
   * Optional clock override for deterministic tests. Returns Date.now()
   * by default.
   */
  now?: () => number;
  /**
   * Optional logger. When omitted, the service builds its own pino logger
   * scoped to `netdrive-service` so failed best-effort transfer-log inserts
   * still surface in JSON logs without forcing every caller to wire one up.
   */
  logger?: Logger;
  /** Enforces the owner's current logical storage quota before bytes are accepted. */
  quotaGuard?: (ownerId: string, path: string, size: number) => Promise<void>;
}

/**
 * Internal shape of a single transfer-log entry. `mirror` direction is
 * reserved; there is no call site that produces one.
 */
type TransferDirection = "upload" | "download" | "mirror";
export type NetDriveReplicaStatus = "pending" | "syncing" | "available" | "failed";

interface RecordTransferInput {
  fileId: string | null;
  actorId: string | null;
  direction: TransferDirection;
  bytes: number;
  siteId?: string;
  context?: NetDriveTransferContext;
}

export interface NetDriveTransferContext {
  jobId?: string;
  workflowRunId?: string;
  netdriveFileIds?: string[];
}

export interface NetDriveCommitResult {
  file: NetDriveFile;
  replacedFiles: NetDriveFile[];
}

export interface RecordReplicaInput {
  ownerId: string;
  fileId: string;
  siteId: string;
  status?: NetDriveReplicaStatus;
  errorMessage?: string;
  context?: NetDriveTransferContext;
}

export type NetDriveCommitDb = Pick<PgDb, "select" | "insert" | "update" | "execute">;

interface CommitTokenPayload extends jose.JWTPayload {
  path?: string;
  ownerId: string;
  storageKey: string;
  intendedSize: number;
  sha256?: string;
  /** Present only on multipart tokens; guards against cross-endpoint replay. */
  kind?: "multipart";
  uploadId?: string;
  partSize?: number;
}

export class NetDriveService {
  private readonly db: PgDb;
  private readonly minio: MinioBackend;
  private readonly commitSecret: Uint8Array;
  private readonly uploadTtlSec: number;
  private readonly downloadTtlSec: number;
  private readonly multipartTtlSec: number;
  private readonly multipartPartSize: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly quotaGuard?: NetDriveServiceOptions["quotaGuard"];

  constructor(db: PgDb, minio: MinioBackend, opts: NetDriveServiceOptions) {
    this.db = db;
    this.minio = minio;
    this.commitSecret = new TextEncoder().encode(opts.commitSecret);
    this.uploadTtlSec = opts.uploadTtlSec ?? DEFAULT_UPLOAD_TTL_SEC;
    this.downloadTtlSec = opts.downloadTtlSec ?? DEFAULT_DOWNLOAD_TTL_SEC;
    this.multipartTtlSec = opts.multipartTtlSec ?? DEFAULT_UPLOAD_TTL_SEC;
    this.multipartPartSize = Math.max(
      opts.multipartPartSize ?? DEFAULT_MULTIPART_PART_SIZE,
      MIN_S3_PART_SIZE,
    );
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? createLogger("netdrive-service");
    this.quotaGuard = opts.quotaGuard;
  }

  /** Mint a presigned PUT URL + commit token. */
  async mintUploadUrl(
    ownerId: string,
    req: NetDriveUploadUrlRequest,
  ): Promise<{
    uploadUrl: string;
    storageKey: string;
    commitToken: string;
    expiresAt: string;
  }> {
    await this.quotaGuard?.(ownerId, req.path, req.size);
    // Presigned URLs can cross institutions; object keys must not contain the owner identity.
    const storageKey = `${STORAGE_PREFIX}/objects/${crypto.randomUUID()}`;
    const contentType = req.contentType ?? "application/octet-stream";
    const uploadUrl = await this.minio.presignUpload(storageKey, this.uploadTtlSec, contentType);
    const expiresAt = new Date(this.now() + this.uploadTtlSec * 1000).toISOString();

    const tokenPayload: CommitTokenPayload = {
      ownerId,
      storageKey,
      intendedSize: req.size,
    };
    if (req.sha256) tokenPayload.sha256 = req.sha256;
    const commitToken = await new jose.SignJWT(tokenPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(this.now() / 1000) + this.uploadTtlSec)
      .sign(this.commitSecret);

    return { uploadUrl, storageKey, commitToken, expiresAt };
  }

  /** Begin a resumable multipart upload; returns uploadId + a multipart commit token. */
  async initiateMultipart(
    ownerId: string,
    req: NetDriveMultipartInitRequest,
  ): Promise<{
    storageKey: string;
    uploadId: string;
    commitToken: string;
    partSize: number;
    expiresAt: string;
  }> {
    if (req.size > 0) {
      await this.quotaGuard?.(ownerId, req.path, req.size);
    }
    const storageKey = `${STORAGE_PREFIX}/objects/${crypto.randomUUID()}`;
    const contentType = req.contentType ?? "application/octet-stream";
    const { uploadId } = await this.minio.createMultipartUpload(storageKey, contentType);
    const expiresAt = new Date(this.now() + this.multipartTtlSec * 1000).toISOString();

    const tokenPayload: CommitTokenPayload = {
      kind: "multipart",
      path: req.path,
      ownerId,
      storageKey,
      uploadId,
      intendedSize: req.size,
      partSize: this.multipartPartSize,
    };
    const commitToken = await new jose.SignJWT(tokenPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(this.now() / 1000) + this.multipartTtlSec)
      .sign(this.commitSecret);

    return { storageKey, uploadId, commitToken, partSize: this.multipartPartSize, expiresAt };
  }

  /** Internal only: called after restoring an owner-bound, reauthorized database transfer session. */
  async restoreMultipartSession(
    ownerId: string,
    session: {
      storageKey: string;
      uploadId: string;
      partSize: number;
      size: number;
      target: string;
    },
  ) {
    if (
      !session.storageKey.startsWith(`${STORAGE_PREFIX}/${ownerId}/`) ||
      !session.uploadId ||
      !Number.isSafeInteger(session.partSize) ||
      session.partSize < MIN_S3_PART_SIZE
    )
      throw new Error("Invalid persisted multipart session");
    const commitToken = await new jose.SignJWT({
      kind: "multipart",
      path: session.target,
      ownerId,
      storageKey: session.storageKey,
      uploadId: session.uploadId,
      intendedSize: session.size,
      partSize: session.partSize,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(this.now() / 1000) + this.multipartTtlSec)
      .sign(this.commitSecret);
    return {
      storageKey: session.storageKey,
      uploadId: session.uploadId,
      partSize: session.partSize,
      commitToken,
    };
  }

  /** Verify the commit token and persist a `netdrive_files` row. */
  async commitFile(
    ownerId: string,
    req: NetDriveCommitRequest,
    context?: NetDriveTransferContext,
  ): Promise<NetDriveFile> {
    return (await this.commitFileWithReplacements(ownerId, req, context)).file;
  }

  async commitFileWithReplacements(
    ownerId: string,
    req: NetDriveCommitRequest,
    context?: NetDriveTransferContext,
  ): Promise<NetDriveCommitResult> {
    await this.quotaGuard?.(ownerId, req.path, req.size);
    let payload: CommitTokenPayload;
    try {
      const verified = await jose.jwtVerify<CommitTokenPayload>(req.commitToken, this.commitSecret);
      payload = verified.payload;
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid or expired commit token", 400);
    }

    if (payload.ownerId !== ownerId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Commit token owner mismatch", 403);
    }
    if (payload.storageKey !== req.storageKey) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token storage key mismatch", 400);
    }
    if (payload.intendedSize !== req.size) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token size mismatch", 400);
    }
    if (payload.sha256 && payload.sha256.toLowerCase() !== req.sha256.toLowerCase()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token sha256 mismatch", 400);
    }

    // Verify the blob actually landed in MinIO before we commit metadata.
    // Without this a malicious client could record a path it never uploaded.
    const stat = await this.minio.head(req.storageKey);
    if (!stat) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        "Blob not found in object store — upload before commit",
        404,
      );
    }
    if (stat.size !== req.size) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Blob size ${stat.size} does not match committed size ${req.size}`,
        400,
      );
    }

    const contentType = req.contentType ?? "application/octet-stream";
    return this.persistCommittedFile(
      ownerId,
      {
        path: req.path,
        size: req.size,
        sha256: req.sha256,
        contentType,
        etag: req.etag ?? stat.etag,
        storageKey: req.storageKey,
        storageVersionId: stat.versionId === "null" ? null : (stat.versionId ?? null),
      },
      context,
    );
  }

  /**
   * Shared commit tail: tombstone any live (owner, path) row, insert the new
   * netdrive_files row, and best-effort record the upload bytes. Used by both
   * single-shot `commitFile` and `completeMultipart`.
   */
  private async persistCommittedFile(
    ownerId: string,
    args: {
      path: string;
      size: number;
      sha256: string;
      contentType: string;
      etag: string | null;
      storageKey: string;
      storageVersionId?: string | null;
    },
    context?: NetDriveTransferContext,
    db: NetDriveCommitDb = this.db,
    recordUpload = true,
  ): Promise<NetDriveCommitResult> {
    const persist = async (tx: NetDriveCommitDb) => {
      await lockCloudWrites(tx, ownerId);
      await new StorageQuotaService(tx, () => new Date(this.now())).assertCloudWriteAllowed(
        ownerId,
        args.path,
        args.size,
      );
      // Soft-delete-aware uniqueness: we allow the same `(owner_id, path)`
      // to be re-uploaded as long as the prior row is tombstoned. To keep
      // active uniqueness we tombstone any existing live row first.
      const replacedRows = await tx
        .select()
        .from(netdriveFiles)
        .where(
          and(
            eq(netdriveFiles.ownerId, ownerId),
            eq(netdriveFiles.path, args.path),
            isNull(netdriveFiles.deletedAt),
          ),
        );
      await tx
        .update(netdriveFiles)
        .set({ deletedAt: new Date(this.now()) })
        .where(
          and(
            eq(netdriveFiles.ownerId, ownerId),
            eq(netdriveFiles.path, args.path),
            isNull(netdriveFiles.deletedAt),
          ),
        );

      const [row] = await tx
        .insert(netdriveFiles)
        .values({
          ownerId,
          path: args.path,
          size: args.size,
          sha256: args.sha256.toLowerCase(),
          contentType: args.contentType,
          etag: args.etag,
          storageKey: args.storageKey,
          storageVersionId: args.storageVersionId,
          mtime: new Date(this.now()),
        })
        .returning();

      if (!row) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Failed to insert netdrive_files row", 500);
      }

      return { row, replacedRows };
    };
    const { row, replacedRows } =
      db === this.db ? await this.db.transaction(persist) : await persist(db);

    // record real upload bytes against the transfer log so the
    // CP Console reads from a per-event ledger rather than approximating
    // bytes-transferred via `sum(netdrive_files.size)`. Best-effort: a
    // failed insert here must not poison the user-facing commit.
    if (recordUpload)
      await this.recordTransfer({
        fileId: row.id,
        actorId: ownerId,
        direction: "upload",
        bytes: row.size,
        context: {
          ...context,
          netdriveFileIds: context?.netdriveFileIds ?? [row.id],
        },
      });

    return { file: rowToFile(row), replacedFiles: replacedRows.map(rowToFile) };
  }

  /** Owner-scoped file lookup (returns null when missing or tombstoned). */
  async getFile(ownerId: string, fileId: string): Promise<NetDriveFile | null> {
    const [row] = await this.db
      .select()
      .from(netdriveFiles)
      .where(
        and(
          eq(netdriveFiles.id, fileId),
          eq(netdriveFiles.ownerId, ownerId),
          isNull(netdriveFiles.deletedAt),
        ),
      )
      .limit(1);
    return row ? rowToFile(row) : null;
  }

  async findFilesByPath(ownerId: string, path: string, limit = 2): Promise<NetDriveFile[]> {
    const rows = await this.db
      .select()
      .from(netdriveFiles)
      .where(
        and(
          eq(netdriveFiles.ownerId, ownerId),
          eq(netdriveFiles.path, path),
          isNull(netdriveFiles.deletedAt),
        ),
      )
      .orderBy(desc(netdriveFiles.createdAt), desc(netdriveFiles.id))
      .limit(limit);
    return rows.map(rowToFile);
  }

  /** Authorization-scoped lookup by id. Callers must check access before returning it. */
  async getFileById(fileId: string): Promise<NetDriveFile | null> {
    const [row] = await this.db
      .select()
      .from(netdriveFiles)
      .where(and(eq(netdriveFiles.id, fileId), isNull(netdriveFiles.deletedAt)))
      .limit(1);
    return row ? rowToFile(row) : null;
  }

  /** Owner-scoped, prefix-filtered, paginated listing. */
  async listFiles(
    ownerId: string,
    opts: { prefix?: string; limit: number; offset: number },
  ): Promise<{ files: NetDriveFile[]; total: number }> {
    const filters = [eq(netdriveFiles.ownerId, ownerId), isNull(netdriveFiles.deletedAt)];
    if (opts.prefix) {
      // ESCAPE the like-meta chars so a user can list `dir%suspicious/` without
      // accidentally matching every other prefix. Drizzle's `like()` does not
      // do this for us.
      const escaped = opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      filters.push(like(netdriveFiles.path, `${escaped}%`));
    }
    const where = and(...filters);

    const rows = await this.db
      .select()
      .from(netdriveFiles)
      .where(where)
      .orderBy(desc(netdriveFiles.createdAt), desc(netdriveFiles.id))
      .limit(opts.limit)
      .offset(opts.offset);

    const totalRow = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(netdriveFiles)
      .where(where);
    const total = totalRow[0]?.count ?? 0;

    return { files: rows.map(rowToFile), total };
  }

  async listFilesByIds(
    fileIds: string[],
    opts: { prefix?: string; limit: number; offset: number },
  ): Promise<{ files: NetDriveFile[]; total: number }> {
    if (fileIds.length === 0) return { files: [], total: 0 };
    const filters = [inArray(netdriveFiles.id, fileIds), isNull(netdriveFiles.deletedAt)];
    if (opts.prefix) {
      const escaped = opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      filters.push(like(netdriveFiles.path, `${escaped}%`));
    }
    const where = and(...filters);
    const rows = await this.db
      .select()
      .from(netdriveFiles)
      .where(where)
      .orderBy(desc(netdriveFiles.createdAt), desc(netdriveFiles.id))
      .limit(opts.limit)
      .offset(opts.offset);
    const totalRow = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(netdriveFiles)
      .where(where);
    return { files: rows.map(rowToFile), total: totalRow[0]?.count ?? 0 };
  }

  /** Mint a presigned GET URL for a previously committed file. */
  async mintDownloadUrl(
    ownerId: string,
    fileId: string,
    context?: NetDriveTransferContext,
  ): Promise<{ downloadUrl: string; expiresAt: string }> {
    const file = await this.requireOwnedFile(ownerId, fileId);
    return this.mintDownloadUrlForAuthorizedFile(ownerId, file, context);
  }

  async mintDownloadUrlForAuthorizedFile(
    actorId: string,
    file: NetDriveFile,
    context?: NetDriveTransferContext,
  ): Promise<{ downloadUrl: string; expiresAt: string }> {
    const url = await this.minio.presignDownload(
      file.storageKey,
      this.downloadTtlSec,
      filenameFromPath(file.path),
      file.storageVersionId ?? undefined,
    );
    const expiresAt = new Date(this.now() + this.downloadTtlSec * 1000).toISOString();

    // minting the download URL is the latest authoritative point
    // before bytes leave the platform; we count the file's full size as the
    // download payload. The presigned URL could theoretically be unused, but
    // the dashboard treats this as "the user asked to pull bytes" which is
    // the right granularity for CP-side accounting. Best-effort insert.
    await this.recordTransfer({
      fileId: file.id,
      actorId,
      direction: "download",
      bytes: file.size,
      context: {
        ...context,
        netdriveFileIds: context?.netdriveFileIds ?? [file.id],
      },
    });

    return { downloadUrl: url, expiresAt };
  }

  async recordReplica(input: RecordReplicaInput): Promise<void> {
    const siteId = input.siteId.trim();
    if (!siteId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Replica siteId is required", 400);
    }
    const file = await this.requireOwnedFile(input.ownerId, input.fileId);
    const status = input.status ?? "available";
    const now = new Date(this.now());

    await this.db
      .insert(netdriveReplicas)
      .values({
        fileId: file.id,
        siteId,
        status,
        size: file.size,
        sha256: file.sha256,
        errorMessage: input.errorMessage ?? null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [netdriveReplicas.fileId, netdriveReplicas.siteId],
        set: {
          status,
          size: file.size,
          sha256: file.sha256,
          errorMessage: input.errorMessage ?? null,
          lastSeenAt: now,
          updatedAt: now,
        },
      });

    if (status !== "available") return;
    await this.recordTransfer({
      fileId: file.id,
      actorId: input.ownerId,
      direction: "mirror",
      bytes: file.size,
      siteId,
      context: {
        ...input.context,
        netdriveFileIds: input.context?.netdriveFileIds ?? [file.id],
      },
    });
  }

  /**
   * Hard-tombstone the metadata row and best-effort delete the blob.
   *
   * Returns the tombstoned `NetDriveFile` so the caller can audit-log it.
   * Idempotent — calling twice returns the original tombstoned row.
   */
  async deleteFile(ownerId: string, fileId: string): Promise<NetDriveFile> {
    const file = await this.requireOwnedFile(ownerId, fileId);
    const deletedAt = new Date(this.now());
    await this.db.update(netdriveFiles).set({ deletedAt }).where(eq(netdriveFiles.id, fileId));
    // Best-effort blob delete. We swallow errors here because the row is
    // already tombstoned; a future reaper job can clean up MinIO if this
    // fails. TODO: emit a structured event so the reaper has work to do.
    try {
      await this.minio.delete(file.storageKey);
    } catch {
      // intentional no-op
    }
    return { ...file, mtime: deletedAt.toISOString() };
  }

  /**
   * Verify a multipart commit token against the supplied (ownerId, storageKey,
   * uploadId). Throws AppError on any mismatch. Returns the decoded payload.
   */
  private async verifyMultipartToken(
    ownerId: string,
    commitToken: string,
    storageKey: string,
    uploadId: string,
  ): Promise<CommitTokenPayload> {
    let payload: CommitTokenPayload;
    try {
      const verified = await jose.jwtVerify<CommitTokenPayload>(commitToken, this.commitSecret);
      payload = verified.payload;
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid or expired commit token", 400);
    }
    if (payload.kind !== "multipart") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Not a multipart commit token", 400);
    }
    if (payload.ownerId !== ownerId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Commit token owner mismatch", 403);
    }
    if (payload.storageKey !== storageKey) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token storage key mismatch", 400);
    }
    if (payload.uploadId !== uploadId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token uploadId mismatch", 400);
    }
    return payload;
  }

  /** Presign PUT URLs for the requested part numbers. */
  async mintPartUrls(
    ownerId: string,
    req: NetDrivePartUrlsRequest,
  ): Promise<NetDrivePartUrlsResponse> {
    await this.verifyMultipartToken(ownerId, req.commitToken, req.storageKey, req.uploadId);
    const urls = await Promise.all(
      req.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.minio.presignUploadPart(
          req.storageKey,
          req.uploadId,
          partNumber,
          this.multipartTtlSec,
        ),
      })),
    );
    return { urls };
  }

  /** List the parts MinIO has accepted so far (sidecar-loss recovery). */
  async listUploadParts(
    ownerId: string,
    req: NetDriveListPartsRequest,
  ): Promise<NetDriveListPartsResponse> {
    await this.verifyMultipartToken(ownerId, req.commitToken, req.storageKey, req.uploadId);
    const parts = await this.minio.listUploadParts(req.storageKey, req.uploadId);
    return { parts };
  }

  /** Assemble a multipart upload, verify size, and persist the file row. */
  async completeMultipart(
    ownerId: string,
    req: NetDriveMultipartCompleteRequest,
    context?: NetDriveTransferContext,
  ): Promise<NetDriveFile> {
    return (await this.completeMultipartWithReplacements(ownerId, req, context)).file;
  }

  async completeMultipartWithReplacements(
    ownerId: string,
    req: NetDriveMultipartCompleteRequest,
    context?: NetDriveTransferContext,
    onCommit?: (result: NetDriveCommitResult, db: NetDriveCommitDb) => Promise<void>,
  ): Promise<NetDriveCommitResult> {
    const token = await this.verifyMultipartToken(
      ownerId,
      req.commitToken,
      req.storageKey,
      req.uploadId,
    );
    if (token.path !== req.path || (token.intendedSize !== 0 && token.intendedSize !== req.size)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Commit token path or size mismatch", 400);
    }
    if (!/^[a-f0-9]{64}$/i.test(req.sha256) || (token.sha256 && token.sha256 !== req.sha256)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid multipart sha256", 400);
    }
    const contentType = req.contentType ?? "application/octet-stream";
    let inserted = false;
    const committed = await this.db.transaction(async (tx) => {
      // Serializes retries across Server processes; rolled-back commits leave no receipt or grants.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${req.storageKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.storageKey, req.storageKey))
        .limit(1);
      if (existing) {
        if (
          existing.ownerId !== ownerId ||
          existing.path !== req.path ||
          existing.size !== req.size ||
          existing.sha256 !== req.sha256.toLowerCase() ||
          existing.contentType !== contentType ||
          existing.deletedAt
        ) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Multipart commit binding changed", 400);
        }
        return { file: rowToFile(existing), replacedFiles: [] };
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${ownerId}/${req.path}`}, 0))`,
      );
      await this.quotaGuard?.(ownerId, req.path, req.size);
      // Complete may have succeeded before the response was lost or this transaction rolled back.
      let stat = await this.minio.head(req.storageKey);
      if (!stat) {
        try {
          await this.minio.completeMultipartUpload(req.storageKey, req.uploadId, req.parts);
        } catch (err) {
          stat = await this.minio.head(req.storageKey);
          if (!stat) throw err;
        }
        stat ??= await this.minio.head(req.storageKey);
      }
      if (!stat)
        throw new AppError(ErrorCode.NOT_FOUND, "Assembled object not found after complete", 404);
      if (stat.size !== req.size) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Assembled size ${stat.size} does not match committed size ${req.size}`,
          400,
        );
      }
      if ((await this.minio.sha256(req.storageKey))?.toLowerCase() !== req.sha256.toLowerCase()) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Assembled object sha256 mismatch", 400);
      }
      const result = await this.persistCommittedFile(
        ownerId,
        {
          path: req.path,
          size: req.size,
          sha256: req.sha256,
          contentType,
          etag: stat.etag,
          storageKey: req.storageKey,
          storageVersionId: stat.versionId === "null" ? null : (stat.versionId ?? null),
        },
        context,
        tx,
        false,
      );
      await onCommit?.(result, tx);
      inserted = true;
      return result;
    });
    if (inserted)
      await this.recordTransfer({
        fileId: committed.file.id,
        actorId: ownerId,
        direction: "upload",
        bytes: committed.file.size,
        context,
      });
    return committed;
  }

  /** Cancel an in-flight multipart upload (client gave up / restart). */
  async abortMultipart(ownerId: string, req: NetDriveMultipartAbortRequest): Promise<void> {
    await this.verifyMultipartToken(ownerId, req.commitToken, req.storageKey, req.uploadId);
    await this.minio.abortMultipartUpload(req.storageKey, req.uploadId);
  }

  private async requireOwnedFile(ownerId: string, fileId: string): Promise<NetDriveFile> {
    const file = await this.getFile(ownerId, fileId);
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
    }
    return file;
  }

  /**
   * Append one row to `netdrive_transfer_log`. Org-id is resolved from the
   * actor's primary membership so the CP Console can scope by org without forcing every
   * caller (route layer, future replicator) to know it.
   *
   * Best-effort: this method NEVER throws. A failed insert is logged and
   * swallowed so that a transient DB blip cannot mask a successful upload
   * or download from the user. The trade-off is byte-accounting under
   * recovery is "at-most-once" — acceptable for a dashboard ledger; a
   * future billing layer that needs at-least-once should subscribe to a
   * dedicated event stream instead.
   */
  private async recordTransfer(input: RecordTransferInput): Promise<void> {
    try {
      let orgId: string | null = null;
      if (input.actorId) {
        const [actor] = await this.db
          .select({ orgId: userOrgMemberships.orgId })
          .from(userOrgMemberships)
          .where(eq(userOrgMemberships.userId, input.actorId))
          .orderBy(asc(userOrgMemberships.createdAt))
          .limit(1);
        orgId = actor?.orgId ?? null;
      }
      await this.db.insert(netdriveTransferLog).values({
        fileId: input.fileId,
        actorId: input.actorId,
        orgId,
        direction: input.direction,
        bytes: input.bytes,
        siteId: input.siteId ?? null,
        jobId: input.context?.jobId ?? null,
        workflowRunId: input.context?.workflowRunId ?? null,
        netdriveFileIds: input.context?.netdriveFileIds ?? (input.fileId ? [input.fileId] : []),
        occurredAt: new Date(this.now()),
      });
    } catch (err) {
      this.logger.warn(
        {
          err,
          direction: input.direction,
          fileId: input.fileId,
          actorId: input.actorId,
          bytes: input.bytes,
        },
        "netdrive_transfer_log insert failed; user-facing op already succeeded",
      );
    }
  }
}

function filenameFromPath(path: string): string | undefined {
  const name = path.split("/").filter(Boolean).pop()?.trim();
  if (!name) return undefined;
  return name;
}

interface NetDriveFileRow {
  id: string;
  ownerId: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  etag: string | null;
  storageKey: string;
  storageVersionId?: string | null;
  mtime: Date;
  createdAt: Date;
}

function rowToFile(r: NetDriveFileRow): NetDriveFile {
  return {
    id: r.id,
    ownerId: r.ownerId,
    path: r.path,
    size: r.size,
    sha256: r.sha256,
    contentType: r.contentType,
    etag: r.etag,
    storageKey: r.storageKey,
    storageVersionId: r.storageVersionId ?? null,
    mtime: r.mtime.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}
