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
  ociTag,
  ociUploadSession,
  type PgDb,
  spackPackage,
} from "@kuintessence/db";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
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
    uploadId: string,
    chunk: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ totalUploaded: number }> {
    return this.serializeUpload(uploadId, () => this.appendChunkUnlocked(uploadId, chunk));
  }

  private async appendChunkUnlocked(
    uploadId: string,
    chunk: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ totalUploaded: number }> {
    const [session] = await this.db
      .select({
        uuidToken: ociUploadSession.uuidToken,
        totalUploaded: ociUploadSession.totalUploaded,
      })
      .from(ociUploadSession)
      .where(eq(ociUploadSession.uuidToken, uploadId))
      .limit(1);
    if (!session) {
      throw new RegistryError("BLOB_UPLOAD_UNKNOWN", `unknown upload ${uploadId}`, 404);
    }
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
    uploadId: string,
    expectedDigest: string,
    finalChunk?: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ digest: string; size: number }> {
    return this.serializeUpload(uploadId, async () => {
      assertDigest(expectedDigest);
      if (finalChunk) await this.appendChunkUnlocked(uploadId, finalChunk);
      let stored: { digest: string; size: number };
      try {
        stored = await this.blobs.completeUpload(uploadId, expectedDigest);
      } catch (e) {
        if (e instanceof BlobDigestMismatchError) {
          throw new RegistryError("DIGEST_INVALID", `expected ${e.expected} got ${e.actual}`, 400);
        }
        throw e;
      }
      await this.db
        .insert(ociBlob)
        .values({
          digest: stored.digest,
          size: stored.size,
          storageKey: digestToStorageKey(stored.digest),
        })
        .onConflictDoNothing();
      await this.db.delete(ociUploadSession).where(eq(ociUploadSession.uuidToken, uploadId));
      return stored;
    });
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await this.serializeUpload(uploadId, () => this.cancelUploadUnlocked(uploadId));
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
      .select({ uuidToken: ociUploadSession.uuidToken })
      .from(ociUploadSession)
      .where(lt(ociUploadSession.createdAt, new Date(nowMs - this.limits.uploadIdleMs)));
    for (const session of stale) {
      await this.cancelUpload(session.uuidToken);
    }
    return stale.length;
  }

  /**
   * Distribution v2 §6.5.2 cross-repo blob mount.
   *
   * The data plane is content-addressed globally (`oci_blob` keys by digest,
   * `BlobStore` keys by digest), so "mount" reduces to:
   *
   *   1. The blob already exists in the registry (i.e. some prior upload
   *      promoted it from a session into `oci_blob` AND the configured
   *      BlobStore can serve the bytes).
   *   2. The destination repository row exists or can be created.
   *   3. Audit a 'push' row carrying mount semantics so an operator can
   *      reconstruct cross-repo provenance from the audit log alone.
   *
   * RBAC across the source/destination namespaces is the route layer's
   * responsibility — this service entry point only refuses the mount when
   * the underlying blob is not present.
   */
  async tryMountBlob(input: {
    dstNs: ParsedNamespace;
    srcNs?: ParsedNamespace;
    digest: string;
    principal: RbacPrincipal;
  }): Promise<{ mounted: true; repo: RegistryRepository } | { mounted: false }> {
    assertDigest(input.digest);
    const meta = await this.db
      .select()
      .from(ociBlob)
      .where(eq(ociBlob.digest, input.digest))
      .limit(1);
    if (!meta[0]) return { mounted: false };
    const present = await this.blobs.exists(input.digest);
    if (!present) return { mounted: false };
    const repo = await this.ensureRepository(input.dstNs, input.principal);
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
    void repoId; // blobs are content-addressed globally; repo scoping is for audit only
    const meta = await this.db.select().from(ociBlob).where(eq(ociBlob.digest, digest)).limit(1);
    const row = meta[0];
    if (row) return { size: row.size };
    const stat = await this.blobs.head(digest);
    if (!stat) throw new RegistryError("BLOB_UNKNOWN", `blob ${digest} not found`, 404);
    return { size: stat.size };
  }

  async getBlob(
    repoId: string,
    digest: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    assertDigest(digest);
    void repoId;
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
    let parsed: {
      config?: { digest?: string };
      layers?: Array<{ digest: string; mediaType: string; size: number }>;
    };
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed;
    } catch {
      throw new RegistryError("MANIFEST_INVALID", "manifest body is not valid JSON");
    }
    const digest = `sha256:${await sha256Hex(body)}`;

    // Insert content-addressed manifest row idempotently.
    await this.db
      .insert(ociManifest)
      .values({
        digest,
        mediaType,
        configDigest: parsed.config?.digest ?? null,
        layers: parsed.layers ?? [],
        size: body.byteLength,
        body,
      })
      .onConflictDoNothing();

    // Resolve the ref:
    //  - sha256:<hex> ref must equal the computed digest (no-op tag write).
    //  - tag ref must pass `validateTag` and obey immutability.
    const isDigestRef = SHA_RE.test(ref);
    if (isDigestRef) {
      if (ref !== digest) {
        throw new RegistryError(
          "DIGEST_INVALID",
          `body digest ${digest} does not match ref ${ref}`,
        );
      }
      await this.audit.recordPush({
        actor: principal.sub,
        resourceKind: "oci-tag",
        resourceId: repo.id,
        metadata: { kind: "manifest-only", digest },
      });
      return { digest };
    }

    const tagCheck = validateTag(ref);
    if (!tagCheck.ok) {
      throw new RegistryError("TAG_INVALID", tagCheck.reason);
    }

    const existing = await this.db
      .select()
      .from(ociTag)
      .where(and(eq(ociTag.repositoryId, repo.id), eq(ociTag.tag, ref)))
      .limit(1);
    const prior = existing[0];
    if (prior && !tagCheck.mutable && prior.manifestDigest !== digest) {
      throw new RegistryError(
        "TAG_IMMUTABLE",
        `tag ${ref} is immutable; existing digest ${prior.manifestDigest}`,
        409,
      );
    }
    if (prior) {
      await this.db
        .update(ociTag)
        .set({ manifestDigest: digest, pushedBy: principal.sub })
        .where(eq(ociTag.id, prior.id));
    } else {
      await this.db.insert(ociTag).values({
        repositoryId: repo.id,
        tag: ref,
        manifestDigest: digest,
        pushedBy: principal.sub,
      });
    }
    await this.audit.recordPush({
      actor: principal.sub,
      resourceKind: "oci-tag",
      resourceId: repo.id,
      metadata: { tag: ref, digest, previousDigest: prior?.manifestDigest ?? null },
      forced: prior?.manifestDigest != null && prior.manifestDigest !== digest && tagCheck.mutable,
    });
    if (prior?.manifestDigest && prior.manifestDigest !== digest) {
      await this.pruneManifestIfUnreferenced(prior.manifestDigest);
    }
    return { digest };
  }

  async getManifestByRef(repoId: string, ref: string): Promise<ManifestRecord> {
    const digest = SHA_RE.test(ref) ? ref : await this.resolveTagToDigest(repoId, ref);
    const rows = await this.db
      .select()
      .from(ociManifest)
      .where(eq(ociManifest.digest, digest))
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
    let digest: string;
    let metadata: Record<string, unknown>;
    if (SHA_RE.test(ref)) {
      // Delete every tag pointing at this digest in this repo.
      const tags = await this.db
        .select()
        .from(ociTag)
        .where(and(eq(ociTag.repositoryId, repo.id), eq(ociTag.manifestDigest, ref)));
      if (tags.length === 0) {
        throw new RegistryError("MANIFEST_UNKNOWN", `manifest ${ref} not found`, 404);
      }
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
    await this.pruneManifestIfUnreferenced(digest);
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

  private async pruneManifestIfUnreferenced(digest: string): Promise<void> {
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
