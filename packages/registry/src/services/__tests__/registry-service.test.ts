// registry-service unit tests focused on the rules the route
// layer cannot easily express: tag immutability, manifest digest
// derivation, and audit-port wiring.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, ociRepository, ociUploadSession, type PgDb } from "@kuintessence/db";
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
        layers: [{ digest: `sha256:${"a".repeat(64)}`, mediaType: "x", size: 1 }],
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
        layers: [{ digest: `sha256:${"b".repeat(64)}`, mediaType: "x", size: 1 }],
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

    await capped.appendChunk(uploadId, new Uint8Array(4)); // 4 ≤ 8, ok

    // 4 + 8 = 12 > 8 → reject with 413 and drop the slot.
    let caught: unknown;
    try {
      await capped.appendChunk(uploadId, new Uint8Array(8));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe("BLOB_UPLOAD_INVALID");
    expect((caught as RegistryError).status).toBe(413);

    // Slot evicted: a follow-up append is now UNKNOWN (404), and the session row is gone.
    await expect(capped.appendChunk(uploadId, new Uint8Array(1))).rejects.toThrow(
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
    await swept.appendChunk(uploadId, new Uint8Array(2)); // still usable

    // Advance the clock past the idle window → evicted, row deleted.
    expect(await swept.sweepStaleUploads(now + 5000)).toBe(1);
    await expect(swept.appendChunk(uploadId, new Uint8Array(1))).rejects.toThrow(/unknown upload/i);
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
    await limited.cancelUpload(first.uploadId);
  });

  test("cancels an upload that would exceed the global incomplete byte quota", async () => {
    const limited = new RegistryService(db, new InMemoryBlobStore(), new NoopAuditPort(), {
      maxUploadBytes: 8,
      maxIncompleteUploadBytes: 4,
    });
    const repo = await limited.ensureRepository(NS, PRINCIPAL);
    const { uploadId } = await limited.startUpload(repo.id);
    await expect(limited.appendChunk(uploadId, new Uint8Array(5))).rejects.toMatchObject({
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
