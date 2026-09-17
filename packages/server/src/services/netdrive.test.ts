// Test isolation: every row inserted is keyed by `OWNER_ID` so the cleanup
// step at the bottom of each test removes only this suite's data.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPgDb,
  netdriveFiles,
  netdriveReplicas,
  netdriveTransferLog,
  type PgDb,
  users,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { NetDriveService } from "./netdrive";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const COMMIT_SECRET = "netdrive-service-test-commit-secret-please-rotate-in-prod";

// Two distinct owners so the test can assert per-owner scoping.
const OWNER_ID = "00000000-0000-0000-0000-00000000c303";
const OTHER_OWNER_ID = "00000000-0000-0000-0000-00000000c304";

async function seedUser(db: PgDb, id: string, email: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, email, displayName: "netdrive-test", role: "user" })
    .onConflictDoNothing();
}

function bytesOf(s: string): Buffer {
  return Buffer.from(s);
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("NetDriveService", () => {
  let db: PgDb;

  // Shared factory used by the multipart tests (Tasks 4-8). Returns the
  // service plus the `FakeMinioBackend` instance so tests can stage parts
  // directly via the backend's test-only helpers.
  function makeService(): { service: NetDriveService; backend: FakeMinioBackend } {
    const backend = new FakeMinioBackend();
    const service = new NetDriveService(db, backend, { commitSecret: COMMIT_SECRET });
    return { service, backend };
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await seedUser(db, OWNER_ID, `netdrive-${OWNER_ID}@test`);
    await seedUser(db, OTHER_OWNER_ID, `netdrive-${OTHER_OWNER_ID}@test`);
  });

  beforeEach(async () => {
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OWNER_ID));
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OTHER_OWNER_ID));
  });

  afterAll(async () => {
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OWNER_ID));
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OTHER_OWNER_ID));
    await db.delete(users).where(eq(users.id, OWNER_ID));
    await db.delete(users).where(eq(users.id, OTHER_OWNER_ID));
  });

  test("mintUploadUrl returns a signed commit token bound to ownerId/storageKey/size", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "uploads/x.txt",
      size: 12,
      contentType: "text/plain",
    });
    expect(minted.uploadUrl).toContain("/upload/");
    expect(minted.storageKey).toMatch(/^netdrive\//);
    expect(minted.commitToken.split(".")).toHaveLength(3); // JWS format
    expect(minted.expiresAt).toMatch(/Z$/);
  });

  test("mintUploadUrl checks the owner's current storage quota before presigning", async () => {
    const fake = new FakeMinioBackend();
    const checks: Array<{ ownerId: string; path: string; size: number }> = [];
    const svc = new NetDriveService(db, fake, {
      commitSecret: COMMIT_SECRET,
      quotaGuard: async (ownerId, path, size) => {
        checks.push({ ownerId, path, size });
      },
    });

    await svc.mintUploadUrl(OWNER_ID, {
      path: "uploads/quota-checked.bin",
      size: 4096,
    });

    expect(checks).toEqual([{ ownerId: OWNER_ID, path: "uploads/quota-checked.bin", size: 4096 }]);
  });

  test("mintUploadUrl does not issue a URL when the quota guard rejects the write", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, {
      commitSecret: COMMIT_SECRET,
      quotaGuard: async () => {
        throw new Error("quota exceeded");
      },
    });

    await expect(
      svc.mintUploadUrl(OWNER_ID, { path: "uploads/too-large.bin", size: 4096 }),
    ).rejects.toThrow("quota exceeded");
  });

  test("initiateMultipart mints an uploadId + a multipart-kind commit token", async () => {
    const { service } = makeService();
    const res = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/big.dat",
      size: 5_000_000_000,
    });
    expect(res.uploadId).toMatch(/.+/);
    expect(res.storageKey).toContain(`netdrive/${OWNER_ID}/`);
    expect(res.partSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(typeof res.commitToken).toBe("string");
    const verified = await jose.jwtVerify(res.commitToken, new TextEncoder().encode(COMMIT_SECRET));
    expect((verified.payload as { kind?: string }).kind).toBe("multipart");
    expect((verified.payload as { uploadId?: string }).uploadId).toBe(res.uploadId);
  });

  test("commitFile happy path inserts row and round-trips metadata", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const body = bytesOf("netdrive-rocks");
    const sha = await sha256Hex("netdrive-rocks");
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "data/r.bin",
      size: body.length,
      contentType: "application/octet-stream",
    });
    // Simulate the client uploading via the presigned URL.
    await fake.putBlob(minted.storageKey, body, "application/octet-stream");

    const file = await svc.commitFile(OWNER_ID, {
      path: "data/r.bin",
      size: body.length,
      contentType: "application/octet-stream",
      sha256: sha,
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    expect(file.path).toBe("data/r.bin");
    expect(file.size).toBe(body.length);
    expect(file.sha256).toBe(sha);
    expect(file.etag).toBeDefined();
  });

  test("recordReplica upserts replica status and records mirror transfer when available", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const body = bytesOf("replicated");
    const sha = await sha256Hex("replicated");
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "replica/input.bin",
      size: body.length,
    });
    await fake.putBlob(minted.storageKey, body, "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "replica/input.bin",
      size: body.length,
      contentType: "application/octet-stream",
      sha256: sha,
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });

    await svc.recordReplica({ ownerId: OWNER_ID, fileId: file.id, siteId: "site-alpha" });

    const [replica] = await db
      .select()
      .from(netdriveReplicas)
      .where(and(eq(netdriveReplicas.fileId, file.id), eq(netdriveReplicas.siteId, "site-alpha")))
      .limit(1);
    expect(replica?.status).toBe("available");
    expect(replica?.size).toBe(body.length);
    expect(replica?.sha256).toBe(sha);

    const mirrors = await db
      .select()
      .from(netdriveTransferLog)
      .where(
        and(
          eq(netdriveTransferLog.fileId, file.id),
          eq(netdriveTransferLog.direction, "mirror"),
          eq(netdriveTransferLog.siteId, "site-alpha"),
        ),
      );
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]?.bytes).toBe(body.length);
  });

  test("recordReplica updates failed status without adding mirror traffic", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const body = bytesOf("failed-replica");
    const sha = await sha256Hex("failed-replica");
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "replica/failed.bin",
      size: body.length,
    });
    await fake.putBlob(minted.storageKey, body, "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "replica/failed.bin",
      size: body.length,
      contentType: "application/octet-stream",
      sha256: sha,
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });

    await svc.recordReplica({
      ownerId: OWNER_ID,
      fileId: file.id,
      siteId: "site-beta",
      status: "failed",
      errorMessage: "copy failed",
    });

    const [replica] = await db
      .select()
      .from(netdriveReplicas)
      .where(and(eq(netdriveReplicas.fileId, file.id), eq(netdriveReplicas.siteId, "site-beta")))
      .limit(1);
    expect(replica?.status).toBe("failed");
    expect(replica?.errorMessage).toBe("copy failed");

    const mirrors = await db
      .select()
      .from(netdriveTransferLog)
      .where(
        and(
          eq(netdriveTransferLog.fileId, file.id),
          eq(netdriveTransferLog.direction, "mirror"),
          eq(netdriveTransferLog.siteId, "site-beta"),
        ),
      );
    expect(mirrors).toHaveLength(0);
  });

  test("commitFile rejects when token's ownerId mismatches caller", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const body = bytesOf("x");
    const sha = await sha256Hex("x");
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "a.bin",
      size: 1,
    });
    await fake.putBlob(minted.storageKey, body, "application/octet-stream");
    await expect(
      svc.commitFile(OTHER_OWNER_ID, {
        path: "a.bin",
        size: 1,
        contentType: "application/octet-stream",
        sha256: sha,
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("commitFile rejects when blob never landed in MinIO", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, { path: "noupload.bin", size: 5 });
    await expect(
      svc.commitFile(OWNER_ID, {
        path: "noupload.bin",
        size: 5,
        contentType: "application/octet-stream",
        sha256: await sha256Hex("xxxxx"),
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("commitFile rejects when blob size differs from committed size", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, { path: "wrong.bin", size: 4 });
    // Upload a 3-byte body even though we committed 4.
    await fake.putBlob(minted.storageKey, bytesOf("abc"), "application/octet-stream");
    await expect(
      svc.commitFile(OWNER_ID, {
        path: "wrong.bin",
        size: 4,
        contentType: "application/octet-stream",
        sha256: await sha256Hex("abc"),
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      }),
    ).rejects.toThrow(/does not match/);
  });

  test("commitFile rejects token-bound sha256 mismatch", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const sha = await sha256Hex("real");
    const wrongSha = await sha256Hex("fake");
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "shabound.bin",
      size: 4,
      sha256: sha,
    });
    await fake.putBlob(minted.storageKey, bytesOf("real"), "application/octet-stream");
    await expect(
      svc.commitFile(OWNER_ID, {
        path: "shabound.bin",
        size: 4,
        contentType: "application/octet-stream",
        sha256: wrongSha,
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      }),
    ).rejects.toThrow(/sha256/);
  });

  test("commitFile tombstones a prior live row at the same path", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const path = "overwrite.bin";
    for (const content of ["initial", "replacement"]) {
      const minted = await svc.mintUploadUrl(OWNER_ID, { path, size: content.length });
      await fake.putBlob(minted.storageKey, bytesOf(content), "application/octet-stream");
      await svc.commitFile(OWNER_ID, {
        path,
        size: content.length,
        contentType: "application/octet-stream",
        sha256: await sha256Hex(content),
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      });
    }
    const { files, total } = await svc.listFiles(OWNER_ID, { limit: 50, offset: 0 });
    const live = files.filter((f) => f.path === path);
    expect(live).toHaveLength(1);
    expect(total).toBe(1);
  });

  test("listFiles is per-owner scoped and supports prefix + paging", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    for (const p of ["a/1.bin", "a/2.bin", "b/3.bin"]) {
      const minted = await svc.mintUploadUrl(OWNER_ID, { path: p, size: 1 });
      await fake.putBlob(minted.storageKey, bytesOf("x"), "application/octet-stream");
      await svc.commitFile(OWNER_ID, {
        path: p,
        size: 1,
        contentType: "application/octet-stream",
        sha256: await sha256Hex("x"),
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      });
    }
    // Other owner gets a noisy file at the same prefix to verify scoping.
    const otherMinted = await svc.mintUploadUrl(OTHER_OWNER_ID, { path: "a/leak.bin", size: 1 });
    await fake.putBlob(otherMinted.storageKey, bytesOf("x"), "application/octet-stream");
    await svc.commitFile(OTHER_OWNER_ID, {
      path: "a/leak.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: otherMinted.storageKey,
      commitToken: otherMinted.commitToken,
    });

    const { files: prefixed, total } = await svc.listFiles(OWNER_ID, {
      prefix: "a/",
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(2);
    expect(prefixed.map((f) => f.path).sort()).toEqual(["a/1.bin", "a/2.bin"]);

    const { files: page1 } = await svc.listFiles(OWNER_ID, { limit: 1, offset: 0 });
    const { files: page2 } = await svc.listFiles(OWNER_ID, { limit: 1, offset: 1 });
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  test("getFile returns null for tombstoned rows and for other owners", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, { path: "g.bin", size: 1 });
    await fake.putBlob(minted.storageKey, bytesOf("x"), "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "g.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    expect(await svc.getFile(OWNER_ID, file.id)).not.toBeNull();
    expect(await svc.getFile(OTHER_OWNER_ID, file.id)).toBeNull();
    await svc.deleteFile(OWNER_ID, file.id);
    expect(await svc.getFile(OWNER_ID, file.id)).toBeNull();
  });

  test("findFilesByPath returns only live exact-path matches for the owner", async () => {
    const firstId = "00000000-0000-0000-0000-00000000c311";
    const secondId = "00000000-0000-0000-0000-00000000c312";
    await db.insert(netdriveFiles).values([
      {
        id: firstId,
        ownerId: OWNER_ID,
        path: "inputs/exact.dat",
        size: 1,
        sha256: "a".repeat(64),
        contentType: "application/octet-stream",
        storageKey: "netdrive/test/exact-a.dat",
      },
      {
        id: secondId,
        ownerId: OWNER_ID,
        path: "inputs/exact.dat",
        size: 1,
        sha256: "b".repeat(64),
        contentType: "application/octet-stream",
        storageKey: "netdrive/test/exact-b.dat",
      },
      {
        id: "00000000-0000-0000-0000-00000000c313",
        ownerId: OWNER_ID,
        path: "inputs/exact.dat.child",
        size: 1,
        sha256: "c".repeat(64),
        contentType: "application/octet-stream",
        storageKey: "netdrive/test/prefix-only.dat",
      },
    ]);
    const svc = new NetDriveService(db, new FakeMinioBackend(), {
      commitSecret: COMMIT_SECRET,
    });

    const matches = await svc.findFilesByPath(OWNER_ID, "inputs/exact.dat");

    expect(matches.map((file) => file.id).sort()).toEqual([firstId, secondId]);
    expect(await svc.findFilesByPath(OTHER_OWNER_ID, "inputs/exact.dat")).toEqual([]);
    await db
      .update(netdriveFiles)
      .set({ deletedAt: new Date() })
      .where(eq(netdriveFiles.id, firstId));
    expect(
      (await svc.findFilesByPath(OWNER_ID, "inputs/exact.dat")).map((file) => file.id),
    ).toEqual([secondId]);
  });

  test("mintDownloadUrl returns a presigned URL only for live owned rows", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, { path: "d.bin", size: 1 });
    await fake.putBlob(minted.storageKey, bytesOf("x"), "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "d.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    const dl = await svc.mintDownloadUrl(OWNER_ID, file.id);
    expect(dl.downloadUrl).toContain("/download/");
    await expect(svc.mintDownloadUrl(OTHER_OWNER_ID, file.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test("mintDownloadUrl requests a download filename from the NetDrive path basename", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, {
      path: "outputs/run-1/chunks_a.txt",
      size: 1,
    });
    await fake.putBlob(minted.storageKey, bytesOf("x"), "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "outputs/run-1/chunks_a.txt",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });

    const dl = await svc.mintDownloadUrl(OWNER_ID, file.id);
    const url = new URL(dl.downloadUrl);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="chunks_a.txt"',
    );
  });

  test("deleteFile is idempotent and tombstones once", async () => {
    const fake = new FakeMinioBackend();
    const svc = new NetDriveService(db, fake, { commitSecret: COMMIT_SECRET });
    const minted = await svc.mintUploadUrl(OWNER_ID, { path: "del.bin", size: 1 });
    await fake.putBlob(minted.storageKey, bytesOf("x"), "application/octet-stream");
    const file = await svc.commitFile(OWNER_ID, {
      path: "del.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    await svc.deleteFile(OWNER_ID, file.id);
    await expect(svc.deleteFile(OWNER_ID, file.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  test("mintPartUrls returns one presigned URL per requested part", async () => {
    const { service } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/big.dat",
      size: 5_000_000_000,
    });
    const res = await service.mintPartUrls(OWNER_ID, {
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
      partNumbers: [1, 2, 5],
    });
    expect(res.urls.map((u) => u.partNumber)).toEqual([1, 2, 5]);
    for (const u of res.urls) expect(u.url).toContain("partNumber=");
  });

  test("mintPartUrls rejects a single-shot (non-multipart) token", async () => {
    const { service } = makeService();
    const single = await service.mintUploadUrl(OWNER_ID, {
      path: "outputs/x.dat",
      size: 10,
    });
    await expect(
      service.mintPartUrls(OWNER_ID, {
        storageKey: single.storageKey,
        uploadId: "whatever",
        commitToken: single.commitToken,
        partNumbers: [1],
      }),
    ).rejects.toThrow(/multipart/i);
  });

  test("listUploadParts reflects parts staged in the backend", async () => {
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/big.dat",
      size: 100,
    });
    // Stage two parts directly via the fake backend's test helper.
    const e1 = await backend.putUploadedPart(
      init.storageKey,
      init.uploadId,
      1,
      Buffer.from("aaaa"),
    );
    const e2 = await backend.putUploadedPart(init.storageKey, init.uploadId, 2, Buffer.from("bb"));
    const res = await service.listUploadParts(OWNER_ID, {
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
    });
    expect(res.parts).toEqual([
      { partNumber: 1, etag: e1.etag },
      { partNumber: 2, etag: e2.etag },
    ]);
  });

  test("completeMultipart assembles parts, verifies size, and inserts a file row", async () => {
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/big.dat",
      size: 6,
    });
    const e1 = await backend.putUploadedPart(
      init.storageKey,
      init.uploadId,
      1,
      Buffer.from("AAAA"),
    );
    const e2 = await backend.putUploadedPart(init.storageKey, init.uploadId, 2, Buffer.from("BB"));
    const file = await service.completeMultipart(OWNER_ID, {
      path: "outputs/run1/big.dat",
      size: 6,
      sha256: "c".repeat(64),
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
      parts: [
        { partNumber: 1, etag: e1.etag },
        { partNumber: 2, etag: e2.etag },
      ],
    });
    expect(file.path).toBe("outputs/run1/big.dat");
    expect(file.size).toBe(6);
    expect(file.sha256).toBe("c".repeat(64));
    // The assembled object is now retrievable from the backend.
    expect((await backend.getBlob(init.storageKey)).toString()).toBe("AAAABB");
  });

  test("completeMultipart defers size check to head when intendedSize is 0", async () => {
    // Live cluster->cloud uploads do not know the size at initiateMultipart
    // time, so the token binds intendedSize=0. completeMultipart must skip the
    // token equality check in that case and rely on the authoritative MinIO
    // head size-check against the real assembled size.
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/unknown-size.dat",
      size: 0,
    });
    const e1 = await backend.putUploadedPart(
      init.storageKey,
      init.uploadId,
      1,
      Buffer.from("AAAA"),
    );
    const e2 = await backend.putUploadedPart(init.storageKey, init.uploadId, 2, Buffer.from("BB"));
    const assembledSize = 6;
    const file = await service.completeMultipart(OWNER_ID, {
      path: "outputs/run1/unknown-size.dat",
      size: assembledSize,
      sha256: "e".repeat(64),
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
      parts: [
        { partNumber: 1, etag: e1.etag },
        { partNumber: 2, etag: e2.etag },
      ],
    });
    expect(file.path).toBe("outputs/run1/unknown-size.dat");
    expect(file.size).toBe(assembledSize);
    expect((await backend.getBlob(init.storageKey)).toString()).toBe("AAAABB");
  });

  test("completeMultipart with intendedSize 0 still rejects a head-size mismatch", async () => {
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/lying-size.dat",
      size: 0,
    });
    const e1 = await backend.putUploadedPart(
      init.storageKey,
      init.uploadId,
      1,
      Buffer.from("AAAA"),
    );
    await expect(
      service.completeMultipart(OWNER_ID, {
        path: "outputs/run1/lying-size.dat",
        size: 999,
        sha256: "f".repeat(64),
        storageKey: init.storageKey,
        uploadId: init.uploadId,
        commitToken: init.commitToken,
        parts: [{ partNumber: 1, etag: e1.etag }],
      }),
    ).rejects.toThrow(/size/i);
  });

  test("completeMultipart rejects when assembled size != intended size", async () => {
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/wrong.dat",
      size: 999,
    });
    const e1 = await backend.putUploadedPart(
      init.storageKey,
      init.uploadId,
      1,
      Buffer.from("AAAA"),
    );
    await expect(
      service.completeMultipart(OWNER_ID, {
        path: "outputs/run1/wrong.dat",
        size: 999,
        sha256: "d".repeat(64),
        storageKey: init.storageKey,
        uploadId: init.uploadId,
        commitToken: init.commitToken,
        parts: [{ partNumber: 1, etag: e1.etag }],
      }),
    ).rejects.toThrow(/size/i);
  });

  test("abortMultipart discards the upload so list-parts then fails", async () => {
    const { service, backend } = makeService();
    const init = await service.initiateMultipart(OWNER_ID, {
      path: "outputs/run1/abort.dat",
      size: 10,
    });
    await backend.putUploadedPart(init.storageKey, init.uploadId, 1, Buffer.from("xxxxx"));
    await service.abortMultipart(OWNER_ID, {
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
    });
    await expect(
      service.listUploadParts(OWNER_ID, {
        storageKey: init.storageKey,
        uploadId: init.uploadId,
        commitToken: init.commitToken,
      }),
    ).rejects.toThrow(/NoSuchUpload/);
  });
});
