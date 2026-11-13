// registry-service unit tests focused on the rules the route
// layer cannot easily express: tag immutability, manifest digest
// derivation, and audit-port wiring.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  auditRelease,
  createPgDb,
  ociBlob,
  ociManifest,
  ociRepository,
  ociRepositoryBlob,
  ociRepositoryManifest,
  ociTag,
  ociUploadSession,
  type PgDb,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { InMemoryBlobStore } from "../blob-store";
import type { ParsedNamespace, RbacPrincipal } from "../namespace";
import { type AuditPort, NoopAuditPort, RegistryError, RegistryService } from "../registry-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

const PRINCIPAL: RbacPrincipal = {
  sub: "00000000-0000-0000-0000-000000000099",
  role: "platform_admin",
  orgIds: [],
};

const NS: ParsedNamespace = { kind: "public", owner: null, name: "regtest-svc" };

class RecordingAuditPort implements AuditPort {
  pushes: Array<{ resourceKind: string; metadata: Record<string, unknown>; forced?: boolean }> = [];
  deletes: Array<{ resourceKind: string; metadata: Record<string, unknown> }> = [];
  async recordPush(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
    forced?: boolean;
  }): Promise<void> {
    this.pushes.push({
      resourceKind: input.resourceKind,
      metadata: input.metadata,
      forced: input.forced,
    });
  }
  async recordDelete(input: {
    actor: string;
    resourceKind: "oci-tag" | "spack-package" | "oci-repository";
    resourceId: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.deletes.push({ resourceKind: input.resourceKind, metadata: input.metadata });
  }
}

describe("RegistryService", () => {
  let db: PgDb;
  let svc: RegistryService;
  let audit: RecordingAuditPort;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    audit = new RecordingAuditPort();
    svc = new RegistryService(db, new InMemoryBlobStore(), audit);
  });

  afterAll(async () => {
    await db.delete(ociRepository).where(like(ociRepository.name, "regtest-%"));
  });

  test("ensureRepository is idempotent", async () => {
    const a = await svc.ensureRepository(NS, PRINCIPAL);
    const b = await svc.ensureRepository(NS, PRINCIPAL);
    expect(a.id).toBe(b.id);
  });

  test("putManifest computes a sha256:hex digest from the body bytes", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    const r = await svc.putManifest({
      repo,
      ref: "1.0.0",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      body,
      principal: PRINCIPAL,
    });
    expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("immutable tag re-PUT with different body throws TAG_IMMUTABLE", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    const m1 = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    const m2 = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        layers: [],
        annotations: { revision: "second" },
      }),
    );
    await svc.putManifest({ repo, ref: "2.0.0", mediaType: "x", body: m1, principal: PRINCIPAL });
    await expect(
      svc.putManifest({ repo, ref: "2.0.0", mediaType: "x", body: m2, principal: PRINCIPAL }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  test("'latest' tag is mutable", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    const m1 = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    const m2 = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        layers: [],
        annotations: { revision: "second" },
      }),
    );
    await svc.putManifest({ repo, ref: "latest", mediaType: "x", body: m1, principal: PRINCIPAL });
    const r = await svc.putManifest({
      repo,
      ref: "latest",
      mediaType: "x",
      body: m2,
      principal: PRINCIPAL,
    });
    expect(r.digest).toMatch(/^sha256:/);
  });

  test("rejects non-semver, non-latest tag", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    await expect(
      svc.putManifest({ repo, ref: "main", mediaType: "x", body, principal: PRINCIPAL }),
    ).rejects.toMatchObject({ code: "TAG_INVALID" });
  });

  test("rejects digest ref that does not match body", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    await expect(
      svc.putManifest({
        repo,
        ref: `sha256:${"0".repeat(64)}`,
        mediaType: "x",
        body,
        principal: PRINCIPAL,
      }),
    ).rejects.toMatchObject({ code: "DIGEST_INVALID" });
  });

  test("audit port receives push events on manifest put", async () => {
    const repo = await svc.ensureRepository(NS, PRINCIPAL);
    audit.pushes = [];
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [] }));
    await svc.putManifest({ repo, ref: "3.0.0", mediaType: "x", body, principal: PRINCIPAL });
    expect(audit.pushes.length).toBeGreaterThanOrEqual(1);
    expect(audit.pushes[0]?.resourceKind).toBe("oci-tag");
  });

  test("repository ownership survives restart and rejects global blob and manifest digest substitution", async () => {
    const blobs = new InMemoryBlobStore();
    const scoped = new RegistryService(db, blobs, new NoopAuditPort());
    const owner = await scoped.ensureRepository(
      { ...NS, name: "regtest-isolation-owner" },
      PRINCIPAL,
    );
    const unrelated = await scoped.ensureRepository(
      { ...NS, name: "regtest-isolation-unrelated" },
      PRINCIPAL,
    );
    const bytes = new TextEncoder().encode("private layer");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const { uploadId } = await scoped.startUpload(owner.id);
    await expect(scoped.appendChunk(unrelated.id, uploadId, bytes)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_UNKNOWN",
    });
    await expect(
      scoped.completeUpload(unrelated.id, uploadId, digest, bytes),
    ).rejects.toMatchObject({ code: "BLOB_UPLOAD_UNKNOWN" });
    await expect(scoped.cancelUpload(unrelated.id, uploadId)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_UNKNOWN",
    });
    await scoped.completeUpload(owner.id, uploadId, digest, bytes);
    const body = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        layers: [{ digest, size: bytes.length, mediaType: "x" }],
      }),
    );
    const manifest = await scoped.putManifest({
      repo: owner,
      ref: "1.0.0",
      mediaType: "x",
      body,
      principal: PRINCIPAL,
    });
    const restarted = new RegistryService(db, blobs, new NoopAuditPort());
    expect((await restarted.headBlob(owner.id, digest)).size).toBe(bytes.length);
    expect((await restarted.getManifestByRef(owner.id, manifest.digest)).digest).toBe(
      manifest.digest,
    );
    await expect(restarted.headBlob(unrelated.id, digest)).rejects.toMatchObject({
      code: "BLOB_UNKNOWN",
    });
    await expect(restarted.getBlob(unrelated.id, digest)).rejects.toMatchObject({
      code: "BLOB_UNKNOWN",
    });
    await expect(restarted.getManifestByRef(unrelated.id, manifest.digest)).rejects.toMatchObject({
      code: "MANIFEST_UNKNOWN",
    });
    await expect(
      restarted.putManifest({
        repo: unrelated,
        ref: "1.0.0",
        mediaType: "x",
        body,
        principal: PRINCIPAL,
      }),
    ).rejects.toMatchObject({ code: "BLOB_UNKNOWN" });
    const deniedMount = await restarted.tryMountBlob({
      dstNs: { ...NS, name: unrelated.name },
      srcNs: { ...NS, name: unrelated.name },
      digest,
      principal: PRINCIPAL,
    });
    expect(deniedMount.mounted).toBe(false);
    expect(
      (
        await restarted.tryMountBlob({
          dstNs: { ...NS, name: unrelated.name },
          digest,
          principal: PRINCIPAL,
        })
      ).mounted,
    ).toBe(false);
    expect(
      (
        await restarted.tryMountBlob({
          dstNs: { ...NS, name: unrelated.name },
          srcNs: { ...NS, name: owner.name },
          digest,
          principal: PRINCIPAL,
        })
      ).mounted,
    ).toBe(true);
    expect((await restarted.headBlob(unrelated.id, digest)).size).toBe(bytes.length);
    await restarted.putManifest({
      repo: owner,
      ref: manifest.digest,
      mediaType: "x",
      body,
      principal: PRINCIPAL,
    });
    await restarted.deleteManifest({ repo: owner, ref: "1.0.0", principal: PRINCIPAL });
    expect((await restarted.getManifestByRef(owner.id, manifest.digest)).digest).toBe(
      manifest.digest,
    );
    await restarted.deleteManifest({ repo: owner, ref: manifest.digest, principal: PRINCIPAL });
    await expect(restarted.getManifestByRef(owner.id, manifest.digest)).rejects.toMatchObject({
      code: "MANIFEST_UNKNOWN",
    });
  });

  test("legacy backfill trusts tagged descriptors once and never resurrects revoked associations", async () => {
    const blobs = new InMemoryBlobStore();
    const legacy = new RegistryService(db, blobs, new NoopAuditPort());
    const repo = await legacy.ensureRepository(
      { ...NS, name: "regtest-legacy-backfill" },
      PRINCIPAL,
    );
    const bytes = new TextEncoder().encode("legacy tagged layer");
    const blob = await blobs.put(bytes);
    const secret = await blobs.put(new TextEncoder().encode("unreferenced legacy secret"));
    const late = await blobs.put(new TextEncoder().encode("uploaded after legacy manifest"));
    for (const item of [blob, secret])
      await db
        .insert(ociBlob)
        .values({
          digest: item.digest,
          size: item.size,
          storageKey: item.digest,
          uploadedAt: new Date(1000),
        })
        .onConflictDoNothing();
    await db.insert(ociBlob).values({
      digest: late.digest,
      size: late.size,
      storageKey: late.digest,
      uploadedAt: new Date(3000),
    });
    const layers = [blob, late].map((item) => ({
      digest: item.digest,
      size: item.size,
      mediaType: "x",
    }));
    const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers }));
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    await db
      .insert(ociManifest)
      .values({
        digest,
        body,
        size: body.length,
        mediaType: "x",
        layers,
        createdAt: new Date(2000),
      })
      .onConflictDoNothing();
    await db.insert(ociTag).values({ repositoryId: repo.id, tag: "1.0.0", manifestDigest: digest });
    expect((await legacy.headBlob(repo.id, blob.digest)).size).toBe(blob.size);
    expect((await legacy.getManifestByRef(repo.id, digest)).digest).toBe(digest);
    await expect(legacy.headBlob(repo.id, secret.digest)).rejects.toMatchObject({
      code: "BLOB_UNKNOWN",
    });
    await expect(legacy.headBlob(repo.id, late.digest)).rejects.toMatchObject({
      code: "BLOB_UNKNOWN",
    });
    await db.delete(ociRepositoryBlob).where(eq(ociRepositoryBlob.repositoryId, repo.id));
    await db.delete(ociRepositoryManifest).where(eq(ociRepositoryManifest.repositoryId, repo.id));
    const restarted = new RegistryService(db, blobs, new NoopAuditPort());
    await expect(restarted.headBlob(repo.id, blob.digest)).rejects.toMatchObject({
      code: "BLOB_UNKNOWN",
    });
    await expect(restarted.getManifestByRef(repo.id, digest)).rejects.toMatchObject({
      code: "MANIFEST_UNKNOWN",
    });
  });

  test("legacy digest-only backfill requires a successful publication not followed by deletion", async () => {
    const scoped = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort());
    const owner = await scoped.ensureRepository(
      { ...NS, name: "regtest-legacy-audit-owner" },
      PRINCIPAL,
    );
    const revoked = await scoped.ensureRepository(
      { ...NS, name: "regtest-legacy-audit-revoked" },
      PRINCIPAL,
    );
    const body = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 2, layers: [], annotations: { revision: "legacy-audit" } }),
    );
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    await db
      .insert(ociManifest)
      .values({ digest, body, size: body.length, mediaType: "x", layers: [] })
      .onConflictDoNothing();
    for (const repo of [owner, revoked])
      await db.insert(auditRelease).values({
        action: "push",
        resourceKind: "oci-tag",
        resourceId: repo.id,
        actor: PRINCIPAL.sub,
        metadata: { kind: "manifest-only", digest },
        occurredAt: new Date(1000),
      });
    await db.insert(auditRelease).values({
      action: "delete",
      resourceKind: "oci-tag",
      resourceId: revoked.id,
      actor: PRINCIPAL.sub,
      metadata: { digest },
      occurredAt: new Date(2000),
    });
    expect((await scoped.getManifestByRef(owner.id, digest)).digest).toBe(digest);
    await expect(scoped.getManifestByRef(revoked.id, digest)).rejects.toMatchObject({
      code: "MANIFEST_UNKNOWN",
    });
    await scoped.putManifest({
      repo: owner,
      ref: "2.0.0",
      mediaType: "x",
      principal: PRINCIPAL,
      body: new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          layers: [],
          annotations: { revision: "keep-repository" },
        }),
      ),
    });
    await scoped.deleteManifest({ repo: owner, ref: digest, principal: PRINCIPAL });
    const restarted = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort());
    await expect(restarted.getManifestByRef(owner.id, digest)).rejects.toMatchObject({
      code: "MANIFEST_UNKNOWN",
    });
  });

  test("NoopAuditPort is silent and never throws", async () => {
    const port = new NoopAuditPort();
    const r1 = await port.recordPush({
      actor: "x",
      resourceKind: "oci-tag",
      resourceId: "00000000-0000-0000-0000-000000000000",
      metadata: {},
    });
    expect(r1).toBeUndefined();
    const r2 = await port.recordDelete({
      actor: "x",
      resourceKind: "oci-tag",
      resourceId: "00000000-0000-0000-0000-000000000000",
      metadata: {},
    });
    expect(r2).toBeUndefined();
  });

  test("appendChunk refuses to grow a slot past maxUploadBytes and evicts it (413)", async () => {
    const capped = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort(), {
      maxUploadBytes: 8,
    });
    const repo = await capped.ensureRepository(NS, PRINCIPAL);
    const { uploadId } = await capped.startUpload(repo.id);

    await capped.appendChunk(repo.id, uploadId, new Uint8Array(4)); // 4 ≤ 8, ok

    // 4 + 8 = 12 > 8 → reject with 413 and drop the slot.
    let caught: unknown;
    try {
      await capped.appendChunk(repo.id, uploadId, new Uint8Array(8));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe("BLOB_UPLOAD_INVALID");
    expect((caught as RegistryError).status).toBe(413);

    // Slot evicted: a follow-up append is now UNKNOWN (404), and the session row is gone.
    await expect(capped.appendChunk(repo.id, uploadId, new Uint8Array(1))).rejects.toThrow(
      /unknown upload/i,
    );
    const rows = await db
      .select()
      .from(ociUploadSession)
      .where(eq(ociUploadSession.uuidToken, uploadId));
    expect(rows.length).toBe(0);
  });

  test("sweepStaleUploads evicts idle sessions but keeps fresh ones", async () => {
    const swept = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort(), {
      uploadIdleMs: 1000,
    });
    const repo = await swept.ensureRepository(NS, PRINCIPAL);
    const { uploadId } = await swept.startUpload(repo.id);

    // Fresh upload: a sweep at "now" must not touch it.
    const now = Date.now();
    expect(await swept.sweepStaleUploads(now)).toBe(0);
    await swept.appendChunk(repo.id, uploadId, new Uint8Array(2)); // still usable

    // Advance the clock past the idle window → evicted, row deleted.
    expect(await swept.sweepStaleUploads(now + 5000)).toBe(1);
    await expect(swept.appendChunk(repo.id, uploadId, new Uint8Array(1))).rejects.toThrow(
      /unknown upload/i,
    );
    const rows = await db
      .select()
      .from(ociUploadSession)
      .where(eq(ociUploadSession.uuidToken, uploadId));
    expect(rows.length).toBe(0);
  });

  test("limits active uploads per repository", async () => {
    const limited = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort(), {
      maxActiveUploadsPerRepository: 1,
    });
    const repo = await limited.ensureRepository(NS, PRINCIPAL);
    const first = await limited.startUpload(repo.id);
    await expect(limited.startUpload(repo.id)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_INVALID",
      status: 429,
    });
    await limited.cancelUpload(repo.id, first.uploadId);
  });

  test("cancels an upload that would exceed the global incomplete byte quota", async () => {
    const limited = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort(), {
      maxUploadBytes: 8,
      maxIncompleteUploadBytes: 4,
    });
    const repo = await limited.ensureRepository(NS, PRINCIPAL);
    const { uploadId } = await limited.startUpload(repo.id);
    await expect(limited.appendChunk(repo.id, uploadId, new Uint8Array(5))).rejects.toMatchObject({
      code: "BLOB_UPLOAD_INVALID",
      status: 413,
    });
    const rows = await db
      .select()
      .from(ociUploadSession)
      .where(eq(ociUploadSession.uuidToken, uploadId));
    expect(rows).toHaveLength(0);
  });
});
