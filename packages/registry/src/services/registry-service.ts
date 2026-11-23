// domain layer for the OCI v2 registry + Spack buildcache.
//
// The HTTP routers (oci.ts, buildcache.ts) speak the Distribution API
// dialect. Everything below — namespace lookup, repository upsert,
// chunked upload tracking, manifest content-addressing, tag immutability,
// audit logging — is the registry service's job.
//
// Persistence model:
//   - oci_repository / oci_tag / oci_manifest / oci_blob /
//     oci_upload_session — Drizzle tables landed in migration 0011.
//   - audit_release — append-only audit log; written on every push,
//     force-push, pull, delete.
//
// Streaming chunked uploads stage bytes into the BlobStore under a
// throwaway "session key", then atomically promote them to a
// content-addressed blob on PUT (?digest=…). The session row is
// retained for diagnostics and removed on DELETE.

import { createHash, randomUUID } from "node:crypto";
import {
  auditRelease,
  ociBlob,
  ociManifest,
  ociRepository,
  ociRepositoryBlob,
  ociRepositoryManifest,
  ociRepositoryScope,
  ociTag,
  ociUploadSession,
  type PgDb,
  type PgTransaction,
  spackPackage,
} from "@kuintessence/db";
import type { SpackMaterialBlob } from "@kuintessence/shared";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  BlobDigestMismatchError,
  BlobNotFoundError,
  type BlobStore,
  BlobUploadTooLargeError,
} from "./blob-store";
import { type ParsedNamespace, type RbacPrincipal, validateTag } from "./namespace";

export class RegistryError extends Error {
  constructor(
    public readonly code:
      | "NAME_INVALID"
      | "NAME_UNKNOWN"
      | "BLOB_UNKNOWN"
      | "BLOB_UPLOAD_INVALID"
      | "BLOB_UPLOAD_UNKNOWN"
      | "DIGEST_INVALID"
      | "MANIFEST_UNKNOWN"
      | "MANIFEST_INVALID"
      | "TAG_INVALID"
      | "TAG_IMMUTABLE"
      | "DENIED",
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 429 = 400,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryRepository {
  id: string;
  namespaceKind: "public" | "org" | "user";
  namespaceOwner: string | null;
  name: string;
}

export interface ManifestRecord {
  body: Uint8Array;
  digest: string;
  mediaType: string;
}

export interface TagListPage {
  name: string;
  tags: string[];
  /** True iff more tags exist after the returned slice — used to drive `Link: rel="next"`. */
  hasMore: boolean;
}

export interface CatalogPage {
  repositories: string[];
  /** True iff more repositories exist after the returned slice — used to drive `Link: rel="next"`. */
  hasMore: boolean;
}

export interface SpackIndexEntry {
  spec: string;
  hash: string;
  arch: string;
  buildcacheUrl: string;
  manifestUrl: string | null;
  sizeBytes: number | null;
}

export const nativeSpackMetadataSchema = z.object({
  spec: z.object({
    nodes: z.array(z.looseObject({ name: z.string(), hash: z.string() })).min(1),
  }),
  binary_cache_checksum: z.object({
    hash_algorithm: z.literal("sha256"),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const manifestBodySchema = z.object({
  config: z.object({ digest: z.string().regex(SHA_RE) }).optional(),
  layers: z
    .array(
      z.object({
        digest: z.string().regex(SHA_RE),
        mediaType: z.string(),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .default([]),
  manifests: z.array(z.object({ digest: z.string().regex(SHA_RE) })).optional(),
});

function assertDigest(digest: string): void {
  if (!SHA_RE.test(digest)) {
    throw new RegistryError("DIGEST_INVALID", `digest '${digest}' is not a valid sha256:<hex>`);
  }
}

function digestToStorageKey(digest: string): string {
  // sha256:abc -> sha256/ab/abc — kept aligned with FilesystemBlobStore.
  const hex = digest.slice("sha256:".length);
  return `sha256/${hex.slice(0, 2)}/${hex}`;
}

function repoFullName(ns: ParsedNamespace): string {
  if (ns.kind === "public") return `public/${ns.name}`;
  return `${ns.kind}/${ns.owner}/${ns.name}`;
}

export interface AuditPort {
  recordPush(
    input: {
      actor: string;
      resourceKind: "oci-tag" | "spack-package" | "oci-repository";
      resourceId: string;
      metadata: Record<string, unknown>;
      forced?: boolean;
    },
    transaction?: PgTransaction,
  ): Promise<void>;
  recordDelete(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Default Drizzle-backed audit port. Routes can swap in a no-op port for
 * tests that don't care about audit semantics.
 */
export class DrizzleAuditPort implements AuditPort {
  constructor(private readonly db: PgDb) {}
  async recordPush(
    input: {
      actor: string;
      resourceKind: "oci-tag" | "spack-package" | "oci-repository";
      resourceId: string;
      metadata: Record<string, unknown>;
      forced?: boolean;
    },
    transaction?: PgTransaction,
  ): Promise<void> {
    await (transaction ?? this.db).insert(auditRelease).values({
      action: input.forced ? "force-push" : "push",
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      actor: input.actor,
      metadata: input.metadata,
    });
  }
  async recordDelete(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditRelease).values({
      action: "delete",
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      actor: input.actor,
      metadata: input.metadata,
    });
  }
}

export class NoopAuditPort implements AuditPort {
  async recordPush(_input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
    forced?: boolean;
  }): Promise<void> {}
  async recordDelete(_input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {}
}

export interface UploadRange {
  start: number;
  end: number;
}

export interface UploadLimits {
  /** Hard ceiling on one staged upload. Exceeding it aborts the upload with 413. */
  maxUploadBytes: number;
  /** Idle window after which an unfinished upload session is swept. */
  uploadIdleMs: number;
  maxActiveUploads: number;
  maxActiveUploadsPerRepository: number;
  maxIncompleteUploadBytes: number;
}

const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxUploadBytes: 10 * 1024 * 1024 * 1024,
  uploadIdleMs: 60 * 60 * 1000,
  maxActiveUploads: 100,
  maxActiveUploadsPerRepository: 10,
  maxIncompleteUploadBytes: 40 * 1024 * 1024 * 1024,
};

/**
 * Domain service. Owns the schema-aware logic and is the only place tag
 * immutability + RBAC-meets-storage decisions live.
 */
export class RegistryService {
  private readonly limits: UploadLimits;

  constructor(
    private readonly db: PgDb,
    private readonly blobs: BlobStore,
    private readonly audit: AuditPort,
    limits?: Partial<UploadLimits>,
  ) {
    this.limits = { ...DEFAULT_UPLOAD_LIMITS, ...limits };
  }

  private async initializeRepositoryScope(repositoryId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [ready] = await tx
        .select()
        .from(ociRepositoryScope)
        .where(eq(ociRepositoryScope.repositoryId, repositoryId));
      if (ready) return;
      const [repo] = await tx
        .select({ id: ociRepository.id })
        .from(ociRepository)
        .where(eq(ociRepository.id, repositoryId))
        .for("update");
      if (!repo) throw new RegistryError("NAME_UNKNOWN", "repository not found", 404);
      const [lockedReady] = await tx
        .select()
        .from(ociRepositoryScope)
        .where(eq(ociRepositoryScope.repositoryId, repositoryId));
      if (lockedReady) return;
      // Existing tags and successful digest-only publications are provenance. Global presence and old mount claims are not.
      await tx.execute(sql`INSERT INTO oci_repository_manifest (repository_id, digest, explicit)
        SELECT DISTINCT t.repository_id, m.digest, false FROM oci_tag t JOIN oci_manifest m ON m.digest = t.manifest_digest
        WHERE t.repository_id = ${repositoryId} ON CONFLICT DO NOTHING`);
      await tx.execute(sql`INSERT INTO oci_repository_manifest (repository_id, digest, explicit)
        SELECT DISTINCT r.id, m.digest, true FROM audit_release a
        JOIN oci_repository r ON r.id = a.resource_id
        JOIN oci_manifest m ON m.digest = a.metadata->>'digest'
        WHERE r.id = ${repositoryId} AND a.resource_kind = 'oci-tag' AND a.action IN ('push','force-push')
          AND a.metadata->>'kind' = 'manifest-only'
          AND NOT EXISTS (SELECT 1 FROM audit_release d WHERE d.resource_id = a.resource_id AND d.resource_kind = 'oci-tag'
            AND d.action = 'delete' AND d.metadata->>'digest' = a.metadata->>'digest' AND d.occurred_at >= a.occurred_at)
        ON CONFLICT (repository_id, digest) DO UPDATE SET explicit = true`);
      await tx.execute(sql`INSERT INTO oci_repository_blob (repository_id, digest)
        SELECT DISTINCT rm.repository_id, b.digest FROM oci_repository_manifest rm JOIN oci_manifest m ON m.digest = rm.digest
        CROSS JOIN LATERAL (
          SELECT m.config_digest AS digest UNION ALL
          SELECT item->>'digest' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.layers) = 'array' THEN m.layers ELSE '[]'::jsonb END) AS descriptors(item)
        ) descriptor JOIN oci_blob b ON b.digest = descriptor.digest
        WHERE rm.repository_id = ${repositoryId} AND b.uploaded_at <= m.created_at ON CONFLICT DO NOTHING`);
      await tx.insert(ociRepositoryScope).values({ repositoryId }).onConflictDoNothing();
    });
  }

  async uploadStatus(repositoryId: string, uploadId: string) {
    const [session] = await this.db
      .select({ totalUploaded: ociUploadSession.totalUploaded })
      .from(ociUploadSession)
      .where(
        and(
          eq(ociUploadSession.repositoryId, repositoryId),
          eq(ociUploadSession.uuidToken, uploadId),
          isNull(ociUploadSession.completedDigest),
        ),
      );
    if (!session)
      throw new RegistryError("BLOB_UPLOAD_UNKNOWN", "unknown upload in repository", 404);
    return session;
  }

  // ---------- Repositories ----------

  async ensureRepository(
    ns: ParsedNamespace,
    _principal: RbacPrincipal,
  ): Promise<RegistryRepository> {
    // Read-or-create. Concurrent ensure on the same name is safe: the
    // unique index on (kind, owner, name) makes the second writer
    // collide and the next select returns the winning row.
    const existing = await this.findRepository(ns);
    if (existing) return existing;
    try {
      const [row] = await this.db
        .insert(ociRepository)
        .values({
          namespaceKind: ns.kind,
          namespaceOwner: ns.owner,
          name: ns.name,
        })
        .returning();
      if (!row) throw new RegistryError("NAME_INVALID", "insert returned no row", 500 as 400);
      return mapRepo(row);
    } catch {
      const after = await this.findRepository(ns);
      if (after) return after;
      throw new RegistryError("NAME_INVALID", `cannot create repository ${repoFullName(ns)}`);
    }
  }

  async findRepository(ns: ParsedNamespace): Promise<RegistryRepository | null> {
    const rows = await this.db
      .select()
      .from(ociRepository)
      .where(
        and(
          eq(ociRepository.namespaceKind, ns.kind),
          ns.owner == null
            ? sql`${ociRepository.namespaceOwner} IS NULL`
            : eq(ociRepository.namespaceOwner, ns.owner),
          eq(ociRepository.name, ns.name),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapRepo(row) : null;
  }

  async listRepositories(filter: {
    canRead: (kind: "public" | "org" | "user", owner: string | null) => boolean;
    last?: string;
    n?: number;
  }): Promise<CatalogPage> {
    const limit = Math.min(Math.max(filter.n ?? 100, 1), 1000);
    const rows = await this.db
      .select()
      .from(ociRepository)
      .orderBy(
        asc(ociRepository.namespaceKind),
        asc(ociRepository.namespaceOwner),
        asc(ociRepository.name),
      );
    const all = rows
      .filter((r) => filter.canRead(r.namespaceKind as "public" | "org" | "user", r.namespaceOwner))
      .map((r) =>
        repoFullName({ kind: r.namespaceKind as "public", owner: r.namespaceOwner, name: r.name }),
      );
    const startIdx = filter.last ? all.indexOf(filter.last) + 1 : 0;
    const items = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;
    return { repositories: items, hasMore };
  }

  // ---------- Blob uploads ----------

  async startUpload(repoId: string): Promise<{ uploadId: string }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('oci-upload-admission',0))`,
      );
      const [usage] = await tx
        .select({
          active: sql<number>`count(*)::int`,
          repositoryActive: sql<number>`count(*) filter (where ${ociUploadSession.repositoryId} = ${repoId})::int`,
        })
        .from(ociUploadSession)
        .where(isNull(ociUploadSession.completedDigest));
      if (Number(usage?.active ?? 0) >= this.limits.maxActiveUploads) {
        throw new RegistryError(
          "BLOB_UPLOAD_INVALID",
          "registry upload concurrency limit reached",
          429,
        );
      }
      if (Number(usage?.repositoryActive ?? 0) >= this.limits.maxActiveUploadsPerRepository) {
        throw new RegistryError(
          "BLOB_UPLOAD_INVALID",
          "repository upload concurrency limit reached",
          429,
        );
      }
      const uuid = randomUUID();
      const storageKey = `_uploads/${uuid}`;
      await tx
        .insert(ociUploadSession)
        .values({ repositoryId: repoId, uuidToken: uuid, totalUploaded: 0, storageKey });
      return { uploadId: uuid };
    });
  }

  async appendChunk(
    repositoryId: string,
    uploadId: string,
    chunk: ReadableStream<Uint8Array> | Uint8Array,
    range?: UploadRange,
  ) {
    const result = await this.writeUpload(repositoryId, uploadId, chunk, range);
    return { totalUploaded: result.size };
  }

  async completeUpload(
    repositoryId: string,
    uploadId: string,
    expectedDigest: string,
    finalChunk?: ReadableStream<Uint8Array> | Uint8Array,
    range?: UploadRange,
  ) {
    assertDigest(expectedDigest);
    await this.initializeRepositoryScope(repositoryId);
    const result = await this.writeUpload(
      repositoryId,
      uploadId,
      finalChunk ?? new Uint8Array(),
      range,
      expectedDigest,
    );
    // The completed receipt remains available for retry and the expiry worker also removes staging.
    await this.blobs.cancelUpload(uploadId);
    return { digest: expectedDigest, size: result.size };
  }

  private async writeUpload(
    repositoryId: string,
    uploadId: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    range?: UploadRange,
    digest?: string,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(ociUploadSession)
        .where(
          and(
            eq(ociUploadSession.uuidToken, uploadId),
            eq(ociUploadSession.repositoryId, repositoryId),
          ),
        )
        .for("update");
      if (!session)
        throw new RegistryError("BLOB_UPLOAD_UNKNOWN", "unknown upload in repository", 404);
      if (session.completedDigest) {
        if (digest === session.completedDigest) return { size: session.totalUploaded };
        throw new RegistryError("BLOB_UPLOAD_UNKNOWN", "upload already completed", 404);
      }
      const offset = session.totalUploaded;
      if (range && offset !== range.start)
        throw new RegistryError("BLOB_UPLOAD_INVALID", "unexpected upload offset", 416);
      try {
        const size = await this.blobs.appendUpload(
          uploadId,
          body,
          this.limits.maxUploadBytes,
          offset,
        );
        if (range && size !== range.end + 1)
          throw new RegistryError(
            "BLOB_UPLOAD_INVALID",
            "body length differs from Content-Range",
            416,
          );
        // Serialize quota accounting after the streamed body is staged; independent clients can send concurrently.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('oci-upload-quota',0))`);
        const [usage] = await tx
          .select({ bytes: sql<number>`coalesce(sum(${ociUploadSession.totalUploaded}),0)` })
          .from(ociUploadSession)
          .where(isNull(ociUploadSession.completedDigest));
        if (Number(usage?.bytes ?? 0) - offset + size > this.limits.maxIncompleteUploadBytes)
          return this.rejectOversize(
            tx,
            uploadId,
            "registry incomplete upload byte quota exceeded",
          );
        if (digest) {
          await lockBlob(tx, digest);
          await this.blobs.completeUpload(uploadId, digest, true);
          await tx
            .insert(ociBlob)
            .values({ digest, size, storageKey: digestToStorageKey(digest) })
            .onConflictDoNothing();
          await tx.insert(ociRepositoryBlob).values({ repositoryId, digest }).onConflictDoNothing();
        }
        await tx
          .update(ociUploadSession)
          .set({ totalUploaded: size, createdAt: new Date(), completedDigest: digest ?? null })
          .where(eq(ociUploadSession.id, session.id));
        return { size };
      } catch (error) {
        if (error instanceof BlobDigestMismatchError)
          throw new RegistryError("DIGEST_INVALID", error.message);
        if (error instanceof BlobUploadTooLargeError)
          return this.rejectOversize(tx, uploadId, error.message);
        throw error;
      }
    });
    if ("error" in result) throw new RegistryError("BLOB_UPLOAD_INVALID", result.error, 413);
    return result;
  }

  private async rejectOversize(tx: PgTransaction, uploadId: string, error: string) {
    await this.blobs.cancelUpload(uploadId);
    await tx.delete(ociUploadSession).where(eq(ociUploadSession.uuidToken, uploadId));
    return { error };
  }

  async cancelUpload(repositoryId: string, uploadId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(ociUploadSession)
        .where(
          and(
            eq(ociUploadSession.repositoryId, repositoryId),
            eq(ociUploadSession.uuidToken, uploadId),
            isNull(ociUploadSession.completedDigest),
          ),
        )
        .for("update");
      if (!row) throw new RegistryError("BLOB_UPLOAD_UNKNOWN", "unknown upload in repository", 404);
      await this.blobs.cancelUpload(uploadId);
      await tx.delete(ociUploadSession).where(eq(ociUploadSession.id, row.id));
    });
  }

  async sweepStaleUploads(nowMs = Date.now()): Promise<number> {
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select()
        .from(ociUploadSession)
        .where(lt(ociUploadSession.createdAt, new Date(nowMs - this.limits.uploadIdleMs)))
        .orderBy(asc(ociUploadSession.createdAt))
        .limit(100)
        .for("update", { skipLocked: true });
      for (const row of stale) {
        await this.blobs.cancelUpload(row.uuidToken);
        await tx.delete(ociUploadSession).where(eq(ociUploadSession.id, row.id));
      }
      return stale.filter((row) => !row.completedDigest).length;
    });
  }

  /** Mount only a blob owned by the authorized source repository, then persist destination reachability. */
  async tryMountBlob(input: {
    dstNs: ParsedNamespace;
    srcNs?: ParsedNamespace;
    digest: string;
    principal: RbacPrincipal;
  }): Promise<{ mounted: true; repo: RegistryRepository } | { mounted: false }> {
    assertDigest(input.digest);
    if (!input.srcNs) return { mounted: false };
    const source = await this.findRepository(input.srcNs);
    if (!source) return { mounted: false };
    try {
      await this.headBlob(source.id, input.digest);
    } catch (error) {
      if (error instanceof RegistryError && error.code === "BLOB_UNKNOWN")
        return { mounted: false };
      throw error;
    }
    const repo = await this.ensureRepository(input.dstNs, input.principal);
    await this.initializeRepositoryScope(repo.id);
    const mounted = await this.db.transaction(async (tx) => {
      await lockBlob(tx, input.digest);
      const [owned] = await tx
        .select({ digest: ociRepositoryBlob.digest })
        .from(ociRepositoryBlob)
        .where(
          and(
            eq(ociRepositoryBlob.repositoryId, source.id),
            eq(ociRepositoryBlob.digest, input.digest),
          ),
        )
        .for("share");
      if (!owned || !(await this.blobs.exists(input.digest))) return false;
      await tx
        .insert(ociRepositoryBlob)
        .values({ repositoryId: repo.id, digest: input.digest })
        .onConflictDoNothing();
      return true;
    });
    if (!mounted) return { mounted: false };
    await this.audit.recordPush({
      actor: input.principal.sub,
      resourceKind: "oci-repository",
      resourceId: repo.id,
      metadata: {
        kind: "blob-mount",
        digest: input.digest,
        source_repo: input.srcNs ? repoFullName(input.srcNs) : null,
        dest_repo: repoFullName(input.dstNs),
      },
    });
    return { mounted: true, repo };
  }

  async headBlob(repoId: string, digest: string): Promise<{ size: number }> {
    assertDigest(digest);
    await this.initializeRepositoryScope(repoId);
    const [row] = await this.db
      .select({ size: ociBlob.size })
      .from(ociRepositoryBlob)
      .innerJoin(ociBlob, eq(ociRepositoryBlob.digest, ociBlob.digest))
      .where(and(eq(ociRepositoryBlob.repositoryId, repoId), eq(ociRepositoryBlob.digest, digest)))
      .limit(1);
    if (!row || !(await this.blobs.exists(digest)))
      throw new RegistryError("BLOB_UNKNOWN", "blob not found in repository", 404);
    return { size: row.size };
  }

  async getBlob(
    repoId: string,
    digest: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    assertDigest(digest);
    await this.headBlob(repoId, digest);
    try {
      return await this.blobs.get(digest);
    } catch (e) {
      if (e instanceof BlobNotFoundError) {
        throw new RegistryError("BLOB_UNKNOWN", `blob ${digest} not found`, 404);
      }
      throw e;
    }
  }

  // ---------- Manifests + tags ----------

  async putManifest(input: {
    repo: RegistryRepository;
    ref: string;
    mediaType: string;
    body: Uint8Array;
    principal: RbacPrincipal;
  }): Promise<{ digest: string }> {
    const { repo, ref, mediaType, body, principal } = input;
    if (body.byteLength === 0) {
      throw new RegistryError("MANIFEST_INVALID", "manifest body is empty");
    }
    let parsed: z.infer<typeof manifestBodySchema>;
    try {
      parsed = manifestBodySchema.parse(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      throw new RegistryError("MANIFEST_INVALID", "manifest body or descriptors are invalid");
    }
    const digest = `sha256:${await sha256Hex(body)}`;
    const isDigestRef = SHA_RE.test(ref);
    if (isDigestRef && ref !== digest)
      throw new RegistryError("DIGEST_INVALID", "manifest digest differs from reference");
    const tagCheck = isDigestRef ? { ok: true as const, mutable: false } : validateTag(ref);
    if (!tagCheck.ok) throw new RegistryError("TAG_INVALID", tagCheck.reason);
    await this.initializeRepositoryScope(repo.id);
    for (const blob of [parsed.config?.digest, ...parsed.layers.map((layer) => layer.digest)]) {
      if (blob) await this.headBlob(repo.id, blob);
    }
    for (const child of parsed.manifests ?? []) await this.getManifestByRef(repo.id, child.digest);

    const prior = await this.db.transaction(async (tx) => {
      // Serialize tag immutability and reachability publication for this repository.
      await tx
        .select({ id: ociRepository.id })
        .from(ociRepository)
        .where(eq(ociRepository.id, repo.id))
        .for("update");
      const [existing] = isDigestRef
        ? []
        : await tx
            .select()
            .from(ociTag)
            .where(and(eq(ociTag.repositoryId, repo.id), eq(ociTag.tag, ref)))
            .limit(1);
      if (existing && !tagCheck.mutable && existing.manifestDigest !== digest)
        throw new RegistryError("TAG_IMMUTABLE", `tag ${ref} is immutable`, 409);
      await tx
        .insert(ociManifest)
        .values({
          digest,
          mediaType,
          configDigest: parsed.config?.digest ?? null,
          layers: parsed.layers,
          size: body.byteLength,
          body,
        })
        .onConflictDoNothing();
      if (isDigestRef) {
        await tx
          .insert(ociRepositoryManifest)
          .values({ repositoryId: repo.id, digest, explicit: true })
          .onConflictDoUpdate({
            target: [ociRepositoryManifest.repositoryId, ociRepositoryManifest.digest],
            set: { explicit: true },
          });
      } else {
        await tx
          .insert(ociRepositoryManifest)
          .values({ repositoryId: repo.id, digest })
          .onConflictDoNothing();
        if (existing)
          await tx
            .update(ociTag)
            .set({ manifestDigest: digest, pushedBy: principal.sub })
            .where(eq(ociTag.id, existing.id));
        else
          await tx.insert(ociTag).values({
            repositoryId: repo.id,
            tag: ref,
            manifestDigest: digest,
            pushedBy: principal.sub,
          });
      }
      return existing;
    });
    await this.audit.recordPush({
      actor: principal.sub,
      resourceKind: "oci-tag",
      resourceId: repo.id,
      metadata: isDigestRef
        ? { kind: "manifest-only", digest }
        : { tag: ref, digest, previousDigest: prior?.manifestDigest ?? null },
      forced: prior?.manifestDigest != null && prior.manifestDigest !== digest && tagCheck.mutable,
    });
    if (prior?.manifestDigest && prior.manifestDigest !== digest)
      await this.releaseManifestReference(repo.id, prior.manifestDigest);
    return { digest };
  }

  async getManifestByRef(repoId: string, ref: string): Promise<ManifestRecord> {
    await this.initializeRepositoryScope(repoId);
    const digest = SHA_RE.test(ref) ? ref : await this.resolveTagToDigest(repoId, ref);
    const rows = await this.db
      .select({
        body: ociManifest.body,
        digest: ociManifest.digest,
        mediaType: ociManifest.mediaType,
      })
      .from(ociManifest)
      .innerJoin(ociRepositoryManifest, eq(ociRepositoryManifest.digest, ociManifest.digest))
      .where(and(eq(ociManifest.digest, digest), eq(ociRepositoryManifest.repositoryId, repoId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new RegistryError("MANIFEST_UNKNOWN", `manifest ${ref} not found`, 404);
    return { body: row.body, digest: row.digest, mediaType: row.mediaType };
  }

  async deleteManifest(input: {
    repo: RegistryRepository;
    ref: string;
    principal: RbacPrincipal;
  }): Promise<void> {
    const { repo, ref, principal } = input;
    await this.initializeRepositoryScope(repo.id);
    let digest: string;
    let metadata: Record<string, unknown>;
    if (SHA_RE.test(ref)) {
      // Delete every tag pointing at this digest in this repo.
      const tags = await this.db
        .select()
        .from(ociTag)
        .where(and(eq(ociTag.repositoryId, repo.id), eq(ociTag.manifestDigest, ref)));
      await this.getManifestByRef(repo.id, ref);
      for (const t of tags) {
        await this.db.delete(ociTag).where(eq(ociTag.id, t.id));
      }
      digest = ref;
      metadata = { digest: ref, removedTags: tags.map((t) => t.tag) };
    } else {
      const tag = await this.db
        .select()
        .from(ociTag)
        .where(and(eq(ociTag.repositoryId, repo.id), eq(ociTag.tag, ref)))
        .limit(1);
      if (!tag[0]) throw new RegistryError("MANIFEST_UNKNOWN", `tag ${ref} not found`, 404);
      await this.db.delete(ociTag).where(eq(ociTag.id, tag[0].id));
      digest = tag[0].manifestDigest;
      metadata = { tag: ref, digest };
    }
    await this.releaseManifestReference(repo.id, digest, SHA_RE.test(ref));
    await this.pruneEmptyRepository(repo.id);
    await this.audit.recordDelete({
      actor: principal.sub,
      resourceKind: "oci-tag",
      resourceId: repo.id,
      metadata,
    });
  }

  async listTags(
    repo: RegistryRepository,
    opts: { n?: number; last?: string },
  ): Promise<TagListPage> {
    const limit = Math.min(Math.max(opts.n ?? 1000, 1), 5000);
    const tags = await this.db
      .select()
      .from(ociTag)
      .where(eq(ociTag.repositoryId, repo.id))
      .orderBy(asc(ociTag.tag));
    const names = tags.map((t) => t.tag);
    const startIdx = opts.last ? names.indexOf(opts.last) + 1 : 0;
    const slice = names.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < names.length;
    return {
      name: repoFullName({ kind: repo.namespaceKind, owner: repo.namespaceOwner, name: repo.name }),
      tags: slice,
      hasMore,
    };
  }

  private async resolveTagToDigest(repoId: string, tag: string): Promise<string> {
    const rows = await this.db
      .select()
      .from(ociTag)
      .where(and(eq(ociTag.repositoryId, repoId), eq(ociTag.tag, tag)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new RegistryError("MANIFEST_UNKNOWN", `tag ${tag} not found`, 404);
    return row.manifestDigest;
  }

  // ---------- Spack buildcache ----------

  async listSpackIndex(ns: ParsedNamespace): Promise<SpackIndexEntry[]> {
    const rows = await this.db
      .select()
      .from(spackPackage)
      .where(
        and(
          eq(spackPackage.namespaceKind, ns.kind),
          eq(spackPackage.repositoryName, ns.name),
          ns.owner == null
            ? sql`${spackPackage.namespaceOwner} IS NULL`
            : eq(spackPackage.namespaceOwner, ns.owner),
        ),
      )
      .orderBy(desc(spackPackage.uploadedAt));
    return rows.map((r) => ({
      spec: r.spec,
      hash: r.hash,
      arch: r.arch,
      buildcacheUrl: r.buildcacheUrl,
      manifestUrl: r.manifestUrl,
      sizeBytes: r.sizeBytes,
    }));
  }

  async getSpackArtifact(input: {
    ns: ParsedNamespace;
    package: string;
    hash: string;
    kind: "spec" | "tarball";
  }): Promise<{ stream: ReadableStream<Uint8Array>; size: number; contentType: string }> {
    const row = await this.findSpackRow(input.ns, input.package, input.hash);
    if (!row) {
      throw new RegistryError("MANIFEST_UNKNOWN", `spack hash ${input.hash} not found`, 404);
    }
    const url = input.kind === "spec" ? row.manifestUrl : row.buildcacheUrl;
    const digest = blobDigestFromUrl(url);
    if (!digest) {
      throw new RegistryError(
        "BLOB_UNKNOWN",
        `spack artifact for ${input.hash} is not blob-store backed`,
        404,
      );
    }
    const contentType = input.kind === "spec" ? "application/json" : "application/x-tar+gzip";
    const r = await this.blobs.get(digest);
    return { stream: r.stream, size: r.size, contentType };
  }

  async putSpackArtifact(input: {
    ns: ParsedNamespace;
    package: string;
    hash: string;
    arch: string;
    spec: string;
    body: Uint8Array;
    principal: RbacPrincipal;
  }): Promise<SpackIndexEntry> {
    if (spackPackageName(input.spec) !== input.package) {
      throw new RegistryError(
        "MANIFEST_INVALID",
        `filename package ${input.package} does not match spec ${input.spec}`,
      );
    }
    const { row, blob, previousDigests } = await this.db.transaction(async (tx) => {
      const prior = await this.lockSpackRow(tx, input.ns, input.package, input.hash);
      const blob = await this.storeSpackBlob(tx, input.body);
      const buildcacheUrl = `blob:${blob.digest}`;
      const values = {
        spec: input.spec,
        arch: input.arch,
        buildcacheUrl,
        sizeBytes: blob.size,
        uploadedBy: input.principal.sub,
      };
      const [row] = prior
        ? await tx
            .update(spackPackage)
            .set({
              ...values,
              manifestUrl: prior.buildcacheUrl === buildcacheUrl ? prior.manifestUrl : null,
              uploadedAt: new Date(),
            })
            .where(eq(spackPackage.id, prior.id))
            .returning()
        : await tx
            .insert(spackPackage)
            .values({
              ...values,
              namespaceKind: input.ns.kind,
              namespaceOwner: input.ns.owner,
              repositoryName: input.ns.name,
              hash: input.hash,
            })
            .returning();
      if (!row) throw new Error("Spack artifact write did not return a row");
      return { row, blob, previousDigests: prior ? spackDigests(prior) : [] };
    });
    await this.audit.recordPush({
      actor: input.principal.sub,
      resourceKind: "spack-package",
      resourceId: row.id,
      metadata: { hash: input.hash, arch: input.arch, spec: input.spec, digest: blob.digest },
    });
    for (const digest of previousDigests) {
      await this.pruneBlobIfUnreferenced(digest);
    }
    return {
      spec: row.spec,
      hash: row.hash,
      arch: row.arch,
      buildcacheUrl: row.buildcacheUrl,
      manifestUrl: row.manifestUrl,
      sizeBytes: row.sizeBytes,
    };
  }

  private async verifyStoredBinary(blob: SpackMaterialBlob): Promise<boolean> {
    let stored: Awaited<ReturnType<BlobStore["get"]>>;
    try {
      stored = await this.blobs.get(blob.digest);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of stored.stream) {
      size += bytes.byteLength;
      if (size > blob.size) break;
      hash.update(bytes);
    }
    if (size !== blob.size || `sha256:${hash.digest("hex")}` !== blob.digest)
      throw new RegistryError("DIGEST_INVALID", "Stored binary differs from its descriptor", 409);
    return true;
  }

  async verifyRepositoryBinary(repoId: string, blob: SpackMaterialBlob) {
    await this.headBlob(repoId, blob.digest);
    if (!(await this.verifyStoredBinary(blob)))
      throw new RegistryError("BLOB_UNKNOWN", "Binary is missing", 404);
  }

  async importSpackPair(input: {
    ns: ParsedNamespace;
    pkg: string;
    hash: string;
    spec: string;
    arch: string;
    archive: SpackMaterialBlob;
    metadata: Uint8Array;
    actor: RbacPrincipal;
    archiveStream?: ReadableStream<Uint8Array>;
  }) {
    const { ns, pkg, hash, spec, arch, archive, metadata, actor, archiveStream } = input;
    const metadataDigest = `sha256:${await sha256Hex(metadata)}`;
    const buildcacheUrl = `blob:${archive.digest}`;
    const manifestUrl = `blob:${metadataDigest}`;
    const receipt = { hash, spec, arch, buildcacheUrl, manifestUrl, sizeBytes: archive.size };
    const written = new Set<string>();
    try {
      return await this.db.transaction(async (tx) => {
        // Use the same lock as native PUT/DELETE, across all Registry processes.
        const prior = await this.lockSpackRow(tx, ns, undefined, hash);
        if (
          prior &&
          (prior.buildcacheUrl !== buildcacheUrl ||
            prior.sizeBytes !== archive.size ||
            (prior.manifestUrl && prior.manifestUrl !== manifestUrl) ||
            spackPackageName(prior.spec) !== pkg ||
            prior.arch !== arch ||
            prior.spec !== spec)
        )
          throw new RegistryError(
            "MANIFEST_INVALID",
            "Buildcache hash already has different content",
            409,
          );
        const existing =
          prior?.manifestUrl === manifestUrl &&
          (await this.verifyStoredBinary(archive)) &&
          (await this.verifyStoredBinary({ digest: metadataDigest, size: metadata.byteLength }));
        if (!archiveStream || existing) return { existing, receipt };
        for (const digest of [...new Set([archive.digest, metadataDigest])].sort())
          await lockBlob(tx, digest);
        if (!(await this.verifyStoredBinary(archive))) {
          await this.blobs.put(archiveStream, archive.digest);
          written.add(archive.digest);
        }
        if (
          !(await this.verifyStoredBinary({ digest: metadataDigest, size: metadata.byteLength }))
        ) {
          await this.blobs.put(metadata, metadataDigest);
          written.add(metadataDigest);
        }
        const values = { ...receipt, uploadedBy: actor.sub, uploadedAt: new Date() };
        const [saved] = prior
          ? await tx
              .update(spackPackage)
              .set(values)
              .where(eq(spackPackage.id, prior.id))
              .returning()
          : await tx
              .insert(spackPackage)
              .values({
                ...values,
                namespaceKind: ns.kind,
                namespaceOwner: ns.owner,
                repositoryName: ns.name,
              })
              .returning();
        if (!saved) throw new Error("Missing buildcache index row");
        await this.audit.recordPush(
          {
            actor: actor.sub,
            resourceKind: "spack-package",
            resourceId: saved.id,
            metadata: receipt,
          },
          tx,
        );
        return { existing: false, receipt };
      });
    } catch (error) {
      for (const digest of written) await this.pruneBlobIfUnreferenced(digest);
      throw error;
    }
  }

  async putSpackMetadata(
    ns: ParsedNamespace,
    pkg: string,
    hash: string,
    body: Uint8Array,
    principal: RbacPrincipal,
  ) {
    let metadata: z.infer<typeof nativeSpackMetadataSchema>;
    try {
      metadata = nativeSpackMetadataSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
    } catch {
      throw new RegistryError("MANIFEST_INVALID", "Invalid Spack buildcache metadata");
    }
    const node = metadata.spec.nodes[0];
    if (node?.name !== pkg || node.hash !== hash)
      throw new RegistryError("MANIFEST_INVALID", "Spec identity differs from filename");
    const { row, blob, manifestUrl } = await this.db.transaction(async (tx) => {
      const row = await this.lockSpackRow(tx, ns, pkg, hash);
      if (row?.buildcacheUrl !== `blob:sha256:${metadata.binary_cache_checksum.hash}`)
        throw new RegistryError("DIGEST_INVALID", "Matching binary is required", 409);
      const blob = await this.storeSpackBlob(tx, body);
      const manifestUrl = `blob:${blob.digest}`;
      await tx.update(spackPackage).set({ manifestUrl }).where(eq(spackPackage.id, row.id));
      return { row, blob, manifestUrl };
    });
    await this.audit.recordPush({
      actor: principal.sub,
      resourceKind: "spack-package",
      resourceId: row.id,
      metadata: { hash, digest: blob.digest },
    });
    const prior = blobDigestFromUrl(row.manifestUrl);
    if (prior && prior !== blob.digest) await this.pruneBlobIfUnreferenced(prior);
    return { hash, manifestUrl };
  }

  async deleteSpackArtifact(input: {
    ns: ParsedNamespace;
    package: string;
    hash: string;
    principal: RbacPrincipal;
  }): Promise<void> {
    const row = await this.db.transaction(async (tx) => {
      const row = await this.lockSpackRow(tx, input.ns, input.package, input.hash);
      if (!row)
        throw new RegistryError("MANIFEST_UNKNOWN", `spack hash ${input.hash} not found`, 404);
      await tx.delete(spackPackage).where(eq(spackPackage.id, row.id));
      return row;
    });
    for (const digest of spackDigests(row)) {
      await this.pruneBlobIfUnreferenced(digest);
    }
    await this.audit.recordDelete({
      actor: input.principal.sub,
      resourceKind: "spack-package",
      resourceId: row.id,
      metadata: { hash: row.hash, arch: row.arch },
    });
  }

  private async releaseManifestReference(
    repositoryId: string,
    digest: string,
    force = false,
  ): Promise<void> {
    const tags = await this.db
      .select({ id: ociTag.id })
      .from(ociTag)
      .where(and(eq(ociTag.repositoryId, repositoryId), eq(ociTag.manifestDigest, digest)))
      .limit(1);
    const [association] = await this.db
      .select()
      .from(ociRepositoryManifest)
      .where(
        and(
          eq(ociRepositoryManifest.repositoryId, repositoryId),
          eq(ociRepositoryManifest.digest, digest),
        ),
      );
    if (force || (tags.length === 0 && !association?.explicit)) {
      await this.db
        .delete(ociRepositoryManifest)
        .where(
          and(
            eq(ociRepositoryManifest.repositoryId, repositoryId),
            eq(ociRepositoryManifest.digest, digest),
          ),
        );
    }
    await this.pruneManifestIfUnreferenced(digest);
  }

  private async hasLegacyRepositories(db: PgDb | PgTransaction = this.db): Promise<boolean> {
    const rows = await db
      .select({ id: ociRepository.id })
      .from(ociRepository)
      .leftJoin(ociRepositoryScope, eq(ociRepositoryScope.repositoryId, ociRepository.id))
      .where(sql`${ociRepositoryScope.repositoryId} IS NULL`)
      .limit(1);
    return rows.length > 0;
  }

  private async pruneManifestIfUnreferenced(digest: string): Promise<void> {
    if (await this.hasLegacyRepositories()) return;
    const associations = await this.db
      .select()
      .from(ociRepositoryManifest)
      .where(eq(ociRepositoryManifest.digest, digest))
      .limit(1);
    if (associations.length > 0) return;
    const referencedTags = await this.db
      .select({ id: ociTag.id })
      .from(ociTag)
      .where(eq(ociTag.manifestDigest, digest))
      .limit(1);
    if (referencedTags.length > 0) return;

    const [manifest] = await this.db
      .select({
        digest: ociManifest.digest,
        configDigest: ociManifest.configDigest,
        layers: ociManifest.layers,
      })
      .from(ociManifest)
      .where(eq(ociManifest.digest, digest))
      .limit(1);
    if (!manifest) return;

    await this.db.delete(ociManifest).where(eq(ociManifest.digest, digest));
    const blobDigests = new Set<string>();
    if (manifest.configDigest && SHA_RE.test(manifest.configDigest)) {
      blobDigests.add(manifest.configDigest);
    }
    for (const layer of manifest.layers) {
      if (SHA_RE.test(layer.digest)) blobDigests.add(layer.digest);
    }
    for (const blobDigest of blobDigests) {
      await this.pruneBlobIfUnreferenced(blobDigest);
    }
  }

  private async pruneBlobIfUnreferenced(digest: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockBlob(tx, digest);
      if (await this.hasLegacyRepositories(tx)) return;
      const associations = await tx
        .select()
        .from(ociRepositoryBlob)
        .where(eq(ociRepositoryBlob.digest, digest))
        .limit(1);
      if (associations.length > 0) return;
      const manifests = await tx
        .select({ configDigest: ociManifest.configDigest, layers: ociManifest.layers })
        .from(ociManifest);
      if (
        manifests.some(
          (manifest) =>
            manifest.configDigest === digest ||
            manifest.layers.some((layer) => layer.digest === digest),
        )
      ) {
        return;
      }
      const packages = await tx
        .select({
          buildcacheUrl: spackPackage.buildcacheUrl,
          manifestUrl: spackPackage.manifestUrl,
        })
        .from(spackPackage);
      if (
        packages.some(
          (pkg) =>
            blobDigestFromUrl(pkg.buildcacheUrl) === digest ||
            blobDigestFromUrl(pkg.manifestUrl) === digest,
        )
      ) {
        return;
      }
      await this.blobs.delete(digest);
      await tx.delete(ociBlob).where(eq(ociBlob.digest, digest));
    });
  }

  private async pruneEmptyRepository(repositoryId: string): Promise<void> {
    const manifests = await this.db
      .select()
      .from(ociRepositoryManifest)
      .where(eq(ociRepositoryManifest.repositoryId, repositoryId))
      .limit(1);
    const blobs = await this.db
      .select()
      .from(ociRepositoryBlob)
      .where(eq(ociRepositoryBlob.repositoryId, repositoryId))
      .limit(1);
    if (manifests.length > 0 || blobs.length > 0) return;
    const tags = await this.db
      .select({ id: ociTag.id })
      .from(ociTag)
      .where(eq(ociTag.repositoryId, repositoryId))
      .limit(1);
    if (tags.length > 0) return;
    const uploads = await this.db
      .select({ id: ociUploadSession.id })
      .from(ociUploadSession)
      .where(eq(ociUploadSession.repositoryId, repositoryId))
      .limit(1);
    if (uploads.length === 0) {
      await this.db.delete(ociRepository).where(eq(ociRepository.id, repositoryId));
    }
  }

  private async lockSpackRow(
    tx: PgTransaction,
    ns: ParsedNamespace,
    pkg: string | undefined,
    hash: string,
  ) {
    const identity = JSON.stringify([ns.kind, ns.owner, ns.name, hash]);
    await tx.execute(sql`select pg_advisory_xact_lock(70401,hashtext(${identity}))`);
    return this.findSpackRow(ns, pkg, hash, tx);
  }

  private async storeSpackBlob(tx: PgTransaction, body: Uint8Array) {
    const digest = `sha256:${await sha256Hex(body)}`;
    await lockBlob(tx, digest);
    return this.blobs.put(body);
  }

  private async findSpackRow(
    ns: ParsedNamespace,
    packageName: string | undefined,
    hash: string,
    db: PgDb | PgTransaction = this.db,
  ) {
    const rows = await db
      .select()
      .from(spackPackage)
      .where(
        and(
          eq(spackPackage.namespaceKind, ns.kind),
          eq(spackPackage.repositoryName, ns.name),
          ns.owner == null
            ? sql`${spackPackage.namespaceOwner} IS NULL`
            : eq(spackPackage.namespaceOwner, ns.owner),
          eq(spackPackage.hash, hash),
        ),
      );
    return packageName === undefined
      ? rows[0]
      : rows.find((row) => spackPackageName(row.spec) === packageName);
  }
}

function blobDigestFromUrl(url: string | null): string | null {
  return url?.startsWith("blob:") ? url.slice("blob:".length) : null;
}

function spackPackageName(spec: string): string {
  return spec.split(/[\s@%+~^]/, 1)[0] ?? "";
}

function mapRepo(row: {
  id: string;
  namespaceKind: string;
  namespaceOwner: string | null;
  name: string;
}): RegistryRepository {
  return {
    id: row.id,
    namespaceKind: row.namespaceKind as "public" | "org" | "user",
    namespaceOwner: row.namespaceOwner,
    name: row.name,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Using node:crypto here keeps the code Bun + Node + Deno portable; the
  // integrator can swap to Bun.CryptoHasher for streaming if needed.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function lockBlob(tx: PgTransaction, digest: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(70402,hashtext(${digest}))`);
}
function spackDigests(row: typeof spackPackage.$inferSelect) {
  return new Set(
    [row.buildcacheUrl, row.manifestUrl]
      .map(blobDigestFromUrl)
      .filter((d): d is string => d !== null),
  );
}
