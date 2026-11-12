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

import { randomUUID } from "node:crypto";
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
  spackPackage,
} from "@kuintessence/db";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
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
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 = 400,
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
  manifestUrl: string;
  sizeBytes: number | null;
}

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
  recordPush(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
    forced?: boolean;
  }): Promise<void>;
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
  async recordPush(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
    forced?: boolean;
  }): Promise<void> {
    await this.db.insert(auditRelease).values({
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
  private readonly uploadOperations = new Map<string, Promise<void>>();

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

  private async uploadSession(repositoryId: string, uploadId: string) {
    const [session] = await this.db
      .select()
      .from(ociUploadSession)
      .where(
        and(
          eq(ociUploadSession.uuidToken, uploadId),
          eq(ociUploadSession.repositoryId, repositoryId),
        ),
      )
      .limit(1);
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
    return this.serializeUpload("registry", async () => {
      const [usage] = await this.db
        .select({
          active: sql<number>`count(*)::int`,
          repositoryActive: sql<number>`count(*) filter (where ${ociUploadSession.repositoryId} = ${repoId})::int`,
        })
        .from(ociUploadSession);
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
      await this.blobs.startUpload(uuid);
      try {
        await this.db.insert(ociUploadSession).values({
          repositoryId: repoId,
          uuidToken: uuid,
          totalUploaded: 0,
          storageKey,
        });
      } catch (error) {
        await this.blobs.cancelUpload(uuid);
        throw error;
      }
      return { uploadId: uuid };
    });
  }

  async appendChunk(
    repositoryId: string,
    uploadId: string,
    chunk: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ totalUploaded: number }> {
    return this.serializeUpload(uploadId, () =>
      this.appendChunkUnlocked(repositoryId, uploadId, chunk),
    );
  }

  private async appendChunkUnlocked(
    repositoryId: string,
    uploadId: string,
    chunk: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ totalUploaded: number }> {
    const session = await this.uploadSession(repositoryId, uploadId);
    let newSize: number;
    try {
      newSize = await this.blobs.appendUpload(uploadId, chunk, this.limits.maxUploadBytes);
    } catch (error) {
      if (!(error instanceof BlobUploadTooLargeError)) throw error;
      await this.cancelUploadUnlocked(uploadId);
      throw new RegistryError(
        "BLOB_UPLOAD_INVALID",
        `upload ${uploadId} exceeds maxUploadBytes (${this.limits.maxUploadBytes})`,
        413,
      );
    }
    const [usage] = await this.db
      .select({ totalUploaded: sql<number>`coalesce(sum(${ociUploadSession.totalUploaded}), 0)` })
      .from(ociUploadSession);
    const projectedBytes = Number(usage?.totalUploaded ?? 0) - session.totalUploaded + newSize;
    if (projectedBytes > this.limits.maxIncompleteUploadBytes) {
      await this.cancelUploadUnlocked(uploadId);
      throw new RegistryError(
        "BLOB_UPLOAD_INVALID",
        "registry incomplete upload byte quota exceeded",
        413,
      );
    }
    await this.db
      .update(ociUploadSession)
      .set({ totalUploaded: newSize, createdAt: new Date() })
      .where(eq(ociUploadSession.uuidToken, uploadId));
    return { totalUploaded: newSize };
  }

  async completeUpload(
    repositoryId: string,
    uploadId: string,
    expectedDigest: string,
    finalChunk?: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ digest: string; size: number }> {
    return this.serializeUpload(uploadId, async () => {
      assertDigest(expectedDigest);
      await this.uploadSession(repositoryId, uploadId);
      await this.initializeRepositoryScope(repositoryId);
      if (finalChunk) await this.appendChunkUnlocked(repositoryId, uploadId, finalChunk);
      let stored: { digest: string; size: number };
      try {
        stored = await this.blobs.completeUpload(uploadId, expectedDigest);
      } catch (e) {
        if (e instanceof BlobDigestMismatchError) {
          throw new RegistryError("DIGEST_INVALID", `expected ${e.expected} got ${e.actual}`, 400);
        }
        throw e;
      }
      await this.db.transaction(async (tx) => {
        await tx
          .insert(ociBlob)
          .values({
            digest: stored.digest,
            size: stored.size,
            storageKey: digestToStorageKey(stored.digest),
          })
          .onConflictDoNothing();
        await tx
          .insert(ociRepositoryBlob)
          .values({ repositoryId, digest: stored.digest })
          .onConflictDoNothing();
        await tx
          .delete(ociUploadSession)
          .where(
            and(
              eq(ociUploadSession.uuidToken, uploadId),
              eq(ociUploadSession.repositoryId, repositoryId),
            ),
          );
      });
      return stored;
    });
  }

  async cancelUpload(repositoryId: string, uploadId: string): Promise<void> {
    await this.serializeUpload(uploadId, async () => {
      await this.uploadSession(repositoryId, uploadId);
      await this.cancelUploadUnlocked(uploadId);
    });
  }

  private async cancelUploadUnlocked(uploadId: string): Promise<void> {
    await this.blobs.cancelUpload(uploadId);
    await this.db.delete(ociUploadSession).where(eq(ociUploadSession.uuidToken, uploadId));
  }

  private async serializeUpload<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadOperations.get(uploadId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.uploadOperations.set(uploadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadOperations.get(uploadId) === tail) this.uploadOperations.delete(uploadId);
    }
  }

  /**
   * Drop upload sessions idle longer than `uploadIdleMs`. Returns the count
   * swept. Bounds staging storage against abandoned `docker push` sessions that never
   * reach PUT or DELETE. `nowMs` is injectable for deterministic tests.
   */
  async sweepStaleUploads(nowMs: number = Date.now()): Promise<number> {
    const stale = await this.db
      .select({
        uuidToken: ociUploadSession.uuidToken,
        repositoryId: ociUploadSession.repositoryId,
      })
      .from(ociUploadSession)
      .where(lt(ociUploadSession.createdAt, new Date(nowMs - this.limits.uploadIdleMs)));
    for (const session of stale) {
      await this.cancelUpload(session.repositoryId, session.uuidToken);
    }
    return stale.length;
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
    await this.db
      .insert(ociRepositoryBlob)
      .values({ repositoryId: repo.id, digest: input.digest })
      .onConflictDoNothing();
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
    const digest = url.startsWith("blob:") ? url.slice("blob:".length) : null;
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
    const blob = await this.blobs.put(input.body);
    const buildcacheUrl = `blob:${blob.digest}`;
    const manifestUrl = `blob:${blob.digest}`;
    const existing = await this.findSpackRow(input.ns, input.package, input.hash);
    const previousDigests = existing
      ? new Set(
          [existing.buildcacheUrl, existing.manifestUrl]
            .map(blobDigestFromUrl)
            .filter((digest): digest is string => digest !== null),
        )
      : new Set<string>();
    if (existing) {
      await this.db
        .update(spackPackage)
        .set({
          spec: input.spec,
          arch: input.arch,
          buildcacheUrl,
          manifestUrl,
          sizeBytes: blob.size,
          uploadedBy: input.principal.sub,
          uploadedAt: new Date(),
        })
        .where(eq(spackPackage.id, existing.id));
    } else {
      await this.db.insert(spackPackage).values({
        namespaceKind: input.ns.kind,
        namespaceOwner: input.ns.owner,
        spec: input.spec,
        hash: input.hash,
        arch: input.arch,
        buildcacheUrl,
        manifestUrl,
        sizeBytes: blob.size,
        uploadedBy: input.principal.sub,
      });
    }
    const row = await this.findSpackRow(input.ns, input.package, input.hash);
    if (!row) {
      throw new RegistryError("MANIFEST_UNKNOWN", "spack row missing after write", 500 as 400);
    }
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

  async deleteSpackArtifact(input: {
    ns: ParsedNamespace;
    package: string;
    hash: string;
    principal: RbacPrincipal;
  }): Promise<void> {
    const row = await this.findSpackRow(input.ns, input.package, input.hash);
    if (!row) {
      throw new RegistryError("MANIFEST_UNKNOWN", `spack hash ${input.hash} not found`, 404);
    }
    const digests = new Set(
      [row.buildcacheUrl, row.manifestUrl]
        .map(blobDigestFromUrl)
        .filter((digest): digest is string => digest !== null),
    );
    await this.db.delete(spackPackage).where(eq(spackPackage.id, row.id));
    for (const digest of digests) {
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

  private async hasLegacyRepositories(): Promise<boolean> {
    const rows = await this.db
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
    if (await this.hasLegacyRepositories()) return;
    const associations = await this.db
      .select()
      .from(ociRepositoryBlob)
      .where(eq(ociRepositoryBlob.digest, digest))
      .limit(1);
    if (associations.length > 0) return;
    const manifests = await this.db
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
    const packages = await this.db
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
    await this.db.delete(ociBlob).where(eq(ociBlob.digest, digest));
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

  private async findSpackRow(ns: ParsedNamespace, packageName: string, hash: string) {
    const rows = await this.db
      .select()
      .from(spackPackage)
      .where(
        and(
          eq(spackPackage.namespaceKind, ns.kind),
          ns.owner == null
            ? sql`${spackPackage.namespaceOwner} IS NULL`
            : eq(spackPackage.namespaceOwner, ns.owner),
          eq(spackPackage.hash, hash),
        ),
      );
    return rows.find((row) => spackPackageName(row.spec) === packageName);
  }
}

function blobDigestFromUrl(url: string): string | null {
  return url.startsWith("blob:") ? url.slice("blob:".length) : null;
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
