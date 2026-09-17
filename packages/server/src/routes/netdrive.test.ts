// Test isolation: token email "netdrive-routes@test", canonical owner UUID,
// all rows cleaned up at the end. The audit_log assertions filter on action
// prefixes so other suites' rows are ignored.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auditLog, createPgDb, netdriveFiles, orgs, type PgDb, users } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type {
  AuthzCheck,
  AuthzService,
  AuthzTuple,
  PendingRelationshipLookup,
} from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { NetDriveService } from "../services/netdrive";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { createNetDriveRoutes } from "./netdrive";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const COMMIT_SECRET = "netdrive-routes-test-commit-secret-please-rotate-in-prod";
const OWNER_ID = "00000000-0000-0000-0000-00000000c3b0";
const ADMIN_ID = "00000000-0000-0000-0000-00000000c3b1";
const ORG_ID = "00000000-0000-0000-0000-00000000c3c0";
const ACTOR_EMAIL = "netdrive-routes@test";

interface UserStub {
  sub: string;
  role: string;
  email: string;
}

interface CapturedLookup {
  resourceType: string;
  permission: string;
  subject: { type: string; id: string };
}

function fakeNetDriveAuthz(input: {
  visibleFileIds: string[];
  checks: AuthzCheck[];
  lookups: CapturedLookup[];
  enqueued?: AuthzTuple[];
  fallbackDecisions?: boolean[];
  denyPermission?: boolean;
  usableFileIds?: string[];
  pendingFileIds?: string[];
  pendingLookups?: PendingRelationshipLookup[];
}): AuthzService {
  return {
    mode: "enforce",
    requirePermission: async (check: AuthzCheck, isPlatformAdmin: boolean) => {
      input.checks.push(check);
      input.fallbackDecisions?.push(isPlatformAdmin);
      if (input.denyPermission) {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      }
    },
    lookupResources: async (lookup: CapturedLookup) => {
      input.lookups.push(lookup);
      return input.visibleFileIds;
    },
    checkBulk: async (checks: AuthzCheck[]) => {
      input.checks.push(...checks);
      return checks.map((check) => input.usableFileIds?.includes(check.resource.id) ?? true);
    },
    enqueueMany: async (tuples: AuthzTuple[]) => {
      input.enqueued?.push(...tuples);
    },
    lookupPendingRelationshipResources: async (lookup: PendingRelationshipLookup) => {
      input.pendingLookups?.push(lookup);
      return input.pendingFileIds ?? [];
    },
    hasPendingRelationship: async (tuple: AuthzTuple) =>
      input.pendingFileIds?.includes(tuple.resource.id) ?? false,
  } as unknown as AuthzService;
}

function makeApp(
  currentUser: UserStub,
  authz?: AuthzService,
  principalUserId = currentUser.sub,
  principalRole = currentUser.role,
  bindPrincipal = true,
  principalOrgId: string | null = null,
  principalEmail = currentUser.email,
) {
  const db = createPgDb(TEST_DB_URL);
  const minio = new FakeMinioBackend();
  const service = new NetDriveService(db, minio, { commitSecret: COMMIT_SECRET });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, currentUser);
    if (bindPrincipal) {
      c.set("principal" as never, {
        sub: currentUser.sub,
        role: principalRole,
        email: principalEmail,
        userId: principalUserId,
        orgId: principalOrgId,
        orgIds: principalOrgId ? [principalOrgId] : [],
        memberships: principalOrgId
          ? [{ orgId: principalOrgId, role: "member", status: "active" }]
          : [],
      });
    }
    await next();
  });
  app.route("/api", createNetDriveRoutes({ db, service, authz }));
  return { app, db, minio, service };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureUsers(db: PgDb): Promise<void> {
  await db.insert(orgs).values({ id: ORG_ID, name: "netdrive-routes-test" }).onConflictDoNothing();
  for (const id of [OWNER_ID, ADMIN_ID]) {
    await db
      .insert(users)
      .values({ id, email: `${id}@test`, displayName: "netdrive-routes-test", role: "user" })
      .onConflictDoNothing();
  }
}

async function reset(db: PgDb): Promise<void> {
  await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OWNER_ID));
  await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, ADMIN_ID));
  await db.delete(auditLog).where(eq(auditLog.actor, ACTOR_EMAIL));
  await db.delete(auditLog).where(like(auditLog.action, "netdrive.%"));
}

describe("netdrive routes", () => {
  let dbHandle: PgDb;

  beforeAll(async () => {
    dbHandle = createPgDb(TEST_DB_URL);
    await ensureUsers(dbHandle);
    await reset(dbHandle);
  });

  beforeEach(async () => {
    await reset(dbHandle);
  });

  afterAll(async () => {
    await reset(dbHandle);
    await dbHandle.delete(users).where(eq(users.id, OWNER_ID));
    await dbHandle.delete(users).where(eq(users.id, ADMIN_ID));
    await dbHandle.delete(orgs).where(eq(orgs.id, ORG_ID));
  });

  test("POST /api/netdrive/upload-url returns commit token + audit-logs", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const res = await app.request("/api/netdrive/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "uploads/a.txt", size: 5, contentType: "text/plain" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { uploadUrl: string; storageKey: string; commitToken: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.commitToken.split(".")).toHaveLength(3);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.upload-url.mint"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
  });

  test("POST /api/netdrive/upload-url rejects POSIX-unsafe paths with 400", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const res = await app.request("/api/netdrive/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../etc/passwd", size: 1 }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/netdrive/files commits a previously-uploaded blob and audit-logs", async () => {
    const { app, minio } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const mintRes = await app.request("/api/netdrive/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "data/r.bin", size: 4 }),
    });
    const { data: mint } = (await mintRes.json()) as {
      data: { storageKey: string; commitToken: string };
    };
    await minio.putBlob(mint.storageKey, Buffer.from("abcd"), "application/octet-stream");
    const sha = await sha256Hex("abcd");

    const commitRes = await app.request("/api/netdrive/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "data/r.bin",
        size: 4,
        contentType: "application/octet-stream",
        sha256: sha,
        storageKey: mint.storageKey,
        commitToken: mint.commitToken,
      }),
    });
    expect(commitRes.status).toBe(201);
    const body = (await commitRes.json()) as {
      success: boolean;
      data: { id: string; sha256: string };
    };
    expect(body.data.sha256).toBe(sha);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.file.commit"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
  });

  test("POST /api/netdrive/files deletes replaced file relationships before creating the new file", async () => {
    const enqueued: AuthzTuple[] = [];
    const authz = fakeNetDriveAuthz({ visibleFileIds: [], checks: [], lookups: [], enqueued });
    const { app, minio } = makeApp(
      { sub: OWNER_ID, role: "user", email: ACTOR_EMAIL },
      authz,
      OWNER_ID,
      "user",
      true,
      ORG_ID,
    );

    const commit = async (value: string) => {
      const mintRes = await app.request("/api/netdrive/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "replace/path.bin", size: value.length }),
      });
      const { data: mint } = (await mintRes.json()) as {
        data: { storageKey: string; commitToken: string };
      };
      await minio.putBlob(mint.storageKey, Buffer.from(value), "application/octet-stream");
      const commitRes = await app.request("/api/netdrive/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "replace/path.bin",
          size: value.length,
          contentType: "application/octet-stream",
          sha256: await sha256Hex(value),
          storageKey: mint.storageKey,
          commitToken: mint.commitToken,
        }),
      });
      expect(commitRes.status).toBe(201);
      const body = (await commitRes.json()) as { data: { id: string } };
      return body.data.id;
    };

    const firstId = await commit("initial");
    enqueued.length = 0;
    const secondId = await commit("replacement");

    const expected: AuthzTuple[] = [
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: firstId },
        relation: "owner",
        subject: { type: "user", id: OWNER_ID },
      },
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: firstId },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: firstId },
        relation: "consumer_org",
        subject: { type: "organization", id: ORG_ID },
      },
      {
        operation: "create",
        resource: { type: "netdrive_file", id: secondId },
        relation: "owner",
        subject: { type: "user", id: OWNER_ID },
      },
      {
        operation: "create",
        resource: { type: "netdrive_file", id: secondId },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "create",
        resource: { type: "netdrive_file", id: secondId },
        relation: "consumer_org",
        subject: { type: "organization", id: ORG_ID },
      },
    ];
    expect(enqueued).toEqual(expected);
  });

  test("GET /api/netdrive/files lists owner-scoped rows and paginates", async () => {
    const { app, minio, service } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    for (const p of ["a.bin", "b.bin", "c.bin"]) {
      const m = await service.mintUploadUrl(OWNER_ID, { path: p, size: 1 });
      await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
      await service.commitFile(OWNER_ID, {
        path: p,
        size: 1,
        contentType: "application/octet-stream",
        sha256: await sha256Hex("x"),
        storageKey: m.storageKey,
        commitToken: m.commitToken,
      });
    }
    const res = await app.request("/api/netdrive/files?limit=2&offset=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        files: Array<{ path: string; canUse: boolean; canDelete: boolean }>;
        total: number;
        limit: number;
      };
    };
    expect(body.data.total).toBe(3);
    expect(body.data.files).toHaveLength(2);
    expect(body.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canUse: expect.any(Boolean),
          canDelete: expect.any(Boolean),
        }),
      ]),
    );
    expect(body.data.files.every((file) => file.canUse)).toBe(true);
    expect(body.data.files.every((file) => file.canDelete)).toBe(true);
  });

  test("GET /api/netdrive/files/:id 404 for someone else's file", async () => {
    const { service, minio } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const m = await service.mintUploadUrl(OWNER_ID, { path: "secret.bin", size: 1 });
    await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "secret.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: m.storageKey,
      commitToken: m.commitToken,
    });

    // Make a NEW app whose JWT subject is the admin user; default role
    // 'user' so cross-owner read is forbidden.
    const { app: appB } = makeApp({
      sub: ADMIN_ID,
      role: "user",
      email: "other@test",
    });
    const res = await appB.request(`/api/netdrive/files/${file.id}`);
    expect(res.status).toBe(404);
  });

  test("SpiceDB netdrive_file#view/use authorizes non-owner read paths in enforce mode", async () => {
    const { service, minio } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const m = await service.mintUploadUrl(OWNER_ID, { path: "shared.bin", size: 1 });
    await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "shared.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: m.storageKey,
      commitToken: m.commitToken,
    });
    const checks: AuthzCheck[] = [];
    const lookups: CapturedLookup[] = [];
    const authz = fakeNetDriveAuthz({
      visibleFileIds: [file.id],
      usableFileIds: [file.id],
      checks,
      lookups,
    });
    const { app: readerApp } = makeApp(
      {
        sub: ADMIN_ID,
        role: "user",
        email: "reader@test",
      },
      authz,
      ADMIN_ID,
      "user",
      true,
      null,
      "bound-reader@test",
    );

    const listRes = await readerApp.request("/api/netdrive/files");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: {
        files: Array<{ id: string; ownerId: string; canUse: boolean; canDelete: boolean }>;
        total: number;
      };
    };
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.files).toEqual([
      expect.objectContaining({
        id: file.id,
        ownerId: OWNER_ID,
        canUse: true,
        canDelete: false,
      }),
    ]);
    const listedFile = listBody.data.files[0];
    if (!listedFile) throw new Error("Expected the listed file to be present");
    expect(Object.hasOwn(listedFile, "canUse")).toBe(true);
    expect(Object.hasOwn(listedFile, "canDelete")).toBe(true);

    const detailRes = await readerApp.request(`/api/netdrive/files/${file.id}`);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { data: { id: string; ownerId: string } };
    expect(detailBody.data).toMatchObject({ id: file.id, ownerId: OWNER_ID });

    const downloadRes = await readerApp.request(`/api/netdrive/files/${file.id}/download-url`);
    expect(downloadRes.status).toBe(200);
    const downloadBody = (await downloadRes.json()) as { data: { downloadUrl: string } };
    expect(downloadBody.data.downloadUrl).toContain("/download/");

    expect(lookups).toEqual([
      {
        resourceType: "netdrive_file",
        permission: "view",
        subject: { type: "user", id: ADMIN_ID },
      },
    ]);
    expect(checks).toEqual([
      {
        actorUserId: ADMIN_ID,
        actorEmail: "bound-reader@test",
        resource: { type: "netdrive_file", id: file.id },
        permission: "use",
        subject: { type: "user", id: ADMIN_ID },
        context: { route: "netdrive_file#use" },
      },
      {
        actorUserId: ADMIN_ID,
        actorEmail: "bound-reader@test",
        resource: { type: "netdrive_file", id: file.id },
        permission: "view",
        subject: { type: "user", id: ADMIN_ID },
        context: { route: "netdrive_file#view" },
      },
      {
        actorUserId: ADMIN_ID,
        actorEmail: "bound-reader@test",
        resource: { type: "netdrive_file", id: file.id },
        permission: "use",
        subject: { type: "user", id: ADMIN_ID },
        context: { route: "netdrive_file#use" },
      },
    ]);
  });

  test("enforce-mode list exposes view-only files with canUse false", async () => {
    const { service, minio } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const minted = await service.mintUploadUrl(OWNER_ID, { path: "view-only.bin", size: 1 });
    await minio.putBlob(minted.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "view-only.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    const checks: AuthzCheck[] = [];
    const { app } = makeApp(
      { sub: ADMIN_ID, role: "user", email: "viewer@test" },
      fakeNetDriveAuthz({
        visibleFileIds: [file.id],
        usableFileIds: [],
        checks,
        lookups: [],
      }),
      ADMIN_ID,
    );

    const response = await app.request("/api/netdrive/files");
    const body = (await response.json()) as {
      data: { files: Array<{ id: string; canUse: boolean; canDelete: boolean }> };
    };

    expect(response.status).toBe(200);
    expect(body.data.files).toEqual([
      expect.objectContaining({ id: file.id, canUse: false, canDelete: false }),
    ]);
    expect(checks).toEqual([
      expect.objectContaining({
        resource: { type: "netdrive_file", id: file.id },
        permission: "use",
      }),
    ]);
  });

  test("enforce-mode list includes owner files before authorization projection catches up", async () => {
    const lookups: CapturedLookup[] = [];
    const pendingFileIds: string[] = [];
    const pendingLookups: PendingRelationshipLookup[] = [];
    const authz = fakeNetDriveAuthz({
      visibleFileIds: [],
      checks: [],
      lookups,
      pendingFileIds,
      pendingLookups,
    });
    const { app, service, minio } = makeApp(
      { sub: OWNER_ID, role: "user", email: ACTOR_EMAIL },
      authz,
      OWNER_ID,
    );
    const minted = await service.mintUploadUrl(OWNER_ID, { path: "fresh/upload.bin", size: 1 });
    await minio.putBlob(minted.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "fresh/upload.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    pendingFileIds.push(file.id);

    const res = await app.request("/api/netdrive/files?prefix=fresh/");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { files: Array<{ id: string; canUse: boolean; canDelete: boolean }>; total: number };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.files).toEqual([
      expect.objectContaining({ id: file.id, canUse: true, canDelete: true }),
    ]);
    expect(lookups).toHaveLength(1);
    expect(pendingLookups).toEqual([
      {
        operation: "create",
        resourceType: "netdrive_file",
        relation: "owner",
        subject: { type: "user", id: OWNER_ID },
      },
    ]);
  });

  test("enforce-mode list does not bypass a terminally absent owner relationship", async () => {
    const authz = fakeNetDriveAuthz({ visibleFileIds: [], checks: [], lookups: [] });
    const { app, service, minio } = makeApp(
      { sub: OWNER_ID, role: "user", email: ACTOR_EMAIL },
      authz,
      OWNER_ID,
    );
    const minted = await service.mintUploadUrl(OWNER_ID, { path: "terminal/missing.bin", size: 1 });
    await minio.putBlob(minted.storageKey, Buffer.from("x"), "application/octet-stream");
    await service.commitFile(OWNER_ID, {
      path: "terminal/missing.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });

    const res = await app.request("/api/netdrive/files?prefix=terminal/");
    const body = (await res.json()) as { data: { files: unknown[]; total: number } };

    expect(body.data).toEqual(expect.objectContaining({ files: [], total: 0 }));
  });

  test("GET /api/netdrive/files?asOwner=… requires platform_admin", async () => {
    const { app } = makeApp({ sub: ADMIN_ID, role: "user", email: "u@test" });
    const res = await app.request(`/api/netdrive/files?asOwner=${OWNER_ID}`);
    expect(res.status).toBe(403);

    const { app: adminApp } = makeApp({
      sub: ADMIN_ID,
      role: "platform_admin",
      email: "admin@test",
    });
    const adminRes = await adminApp.request(`/api/netdrive/files?asOwner=${OWNER_ID}`);
    expect(adminRes.status).toBe(200);
  });

  test("GET /api/netdrive/files?asOwner=… uses bound role instead of stale JWT role", async () => {
    const { app } = makeApp(
      {
        sub: ADMIN_ID,
        role: "platform_admin",
        email: "admin@test",
      },
      undefined,
      ADMIN_ID,
      "user",
    );

    const res = await app.request(`/api/netdrive/files?asOwner=${OWNER_ID}`);

    expect(res.status).toBe(403);
  });

  test("GET /api/netdrive/files?asOwner=… does not trust JWT role without a bound principal", async () => {
    const { app } = makeApp(
      {
        sub: ADMIN_ID,
        role: "platform_admin",
        email: "admin@test",
      },
      undefined,
      ADMIN_ID,
      "platform_admin",
      false,
    );

    const res = await app.request(`/api/netdrive/files?asOwner=${OWNER_ID}`);

    expect(res.status).toBe(403);
  });

  test("netdrive_file degraded fallback uses bound principal role", async () => {
    const checks: AuthzCheck[] = [];
    const fallbackDecisions: boolean[] = [];
    const { app, service, minio } = makeApp(
      {
        sub: OWNER_ID,
        role: "platform_admin",
        email: ACTOR_EMAIL,
      },
      fakeNetDriveAuthz({ visibleFileIds: [], checks, lookups: [], fallbackDecisions }),
      OWNER_ID,
      "user",
    );
    const m = await service.mintUploadUrl(OWNER_ID, { path: "fallback-role.bin", size: 1 });
    await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "fallback-role.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: m.storageKey,
      commitToken: m.commitToken,
    });

    const res = await app.request(`/api/netdrive/files/${file.id}`);

    expect(res.status).toBe(200);
    expect(checks).toHaveLength(1);
    expect(fallbackDecisions).toEqual([false]);
  });

  test("GET /api/netdrive/files/:id/download-url returns a presigned URL", async () => {
    const { app, service, minio } = makeApp({
      sub: OWNER_ID,
      role: "user",
      email: ACTOR_EMAIL,
    });
    const m = await service.mintUploadUrl(OWNER_ID, { path: "d.bin", size: 1 });
    await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "d.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: m.storageKey,
      commitToken: m.commitToken,
    });
    const res = await app.request(`/api/netdrive/files/${file.id}/download-url`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { downloadUrl: string } };
    expect(body.data.downloadUrl).toContain("/download/");
  });

  test("DELETE /api/netdrive/files/:id tombstones and audit-logs", async () => {
    const enqueued: AuthzTuple[] = [];
    const authz = fakeNetDriveAuthz({ visibleFileIds: [], checks: [], lookups: [], enqueued });
    const { app, service, minio } = makeApp(
      {
        sub: OWNER_ID,
        role: "user",
        email: ACTOR_EMAIL,
      },
      authz,
      OWNER_ID,
      "user",
      true,
      ORG_ID,
    );
    const m = await service.mintUploadUrl(OWNER_ID, { path: "del.bin", size: 1 });
    await minio.putBlob(m.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "del.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: m.storageKey,
      commitToken: m.commitToken,
    });
    const res = await app.request(`/api/netdrive/files/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = await app.request(`/api/netdrive/files/${file.id}`);
    expect(after.status).toBe(404);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.file.delete"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
    expect(enqueued).toEqual([
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: file.id },
        relation: "owner",
        subject: { type: "user", id: OWNER_ID },
      },
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: file.id },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "delete",
        resource: { type: "netdrive_file", id: file.id },
        relation: "consumer_org",
        subject: { type: "organization", id: ORG_ID },
      },
    ]);
  });

  test("DELETE /api/netdrive/files/:id preserves the file when authorization denies", async () => {
    const checks: AuthzCheck[] = [];
    const authz = fakeNetDriveAuthz({
      visibleFileIds: [],
      checks,
      lookups: [],
      denyPermission: true,
    });
    const { app, service, minio } = makeApp(
      { sub: OWNER_ID, role: "user", email: ACTOR_EMAIL },
      authz,
    );
    const minted = await service.mintUploadUrl(OWNER_ID, { path: "denied-delete.bin", size: 1 });
    await minio.putBlob(minted.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await service.commitFile(OWNER_ID, {
      path: "denied-delete.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });

    const response = await app.request(`/api/netdrive/files/${file.id}`, { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(await service.getFile(OWNER_ID, file.id)).not.toBeNull();
    expect(await minio.head(file.storageKey)).not.toBeNull();
    expect(checks).toEqual([
      expect.objectContaining({
        permission: "delete",
        resource: { type: "netdrive_file", id: file.id },
      }),
    ]);
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.file.delete"));
    expect(audit).toHaveLength(0);
  });

  test("DELETE /api/netdrive/files/:id does not honor cross-owner asOwner", async () => {
    const ownerApp = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const minted = await ownerApp.service.mintUploadUrl(OWNER_ID, {
      path: "cross-owner-delete.bin",
      size: 1,
    });
    await ownerApp.minio.putBlob(minted.storageKey, Buffer.from("x"), "application/octet-stream");
    const file = await ownerApp.service.commitFile(OWNER_ID, {
      path: "cross-owner-delete.bin",
      size: 1,
      contentType: "application/octet-stream",
      sha256: await sha256Hex("x"),
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
    });
    const { app } = makeApp(
      { sub: ADMIN_ID, role: "platform_admin", email: "admin@test" },
      undefined,
      ADMIN_ID,
      "platform_admin",
    );

    const response = await app.request(
      `/api/netdrive/files/${file.id}?asOwner=${encodeURIComponent(OWNER_ID)}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(await ownerApp.service.getFile(OWNER_ID, file.id)).not.toBeNull();
  });

  test("POST /api/netdrive/files rejects malformed JSON with 400", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const res = await app.request("/api/netdrive/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/netdrive/uploads/multipart returns uploadId + commitToken and audit-logs", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const res = await app.request("/api/netdrive/uploads/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "outputs/run1/big.dat", size: 5_000_000_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { uploadId: string; storageKey: string; commitToken: string; partSize: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.uploadId).toMatch(/.+/);
    expect(body.data.partSize).toBeGreaterThan(0);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.multipart.init"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
  });

  test("POST /api/netdrive/uploads/multipart/part-urls returns presigned URLs", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const initRes = await app.request("/api/netdrive/uploads/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "outputs/run1/p.dat", size: 100 }),
    });
    const init = (await initRes.json()) as {
      data: { storageKey: string; uploadId: string; commitToken: string };
    };
    const res = await app.request("/api/netdrive/uploads/multipart/part-urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey: init.data.storageKey,
        uploadId: init.data.uploadId,
        commitToken: init.data.commitToken,
        partNumbers: [1, 2],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { urls: unknown[] } };
    expect(body.data.urls).toHaveLength(2);
  });

  test("POST /api/netdrive/uploads/multipart/list-parts returns uploaded parts", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const initRes = await app.request("/api/netdrive/uploads/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "outputs/run1/l.dat", size: 100 }),
    });
    const init = (await initRes.json()) as {
      data: { storageKey: string; uploadId: string; commitToken: string };
    };
    const res = await app.request("/api/netdrive/uploads/multipart/list-parts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey: init.data.storageKey,
        uploadId: init.data.uploadId,
        commitToken: init.data.commitToken,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { parts: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.parts)).toBe(true);
  });

  test("POST /api/netdrive/uploads/multipart/complete commits and audit-logs canonical actor", async () => {
    const { app, minio } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const initRes = await app.request("/api/netdrive/uploads/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "outputs/run1/complete.dat", size: 6 }),
    });
    const init = (await initRes.json()) as {
      data: { storageKey: string; uploadId: string; commitToken: string };
    };
    const first = await minio.putUploadedPart(
      init.data.storageKey,
      init.data.uploadId,
      1,
      Buffer.from("abc"),
    );
    const second = await minio.putUploadedPart(
      init.data.storageKey,
      init.data.uploadId,
      2,
      Buffer.from("def"),
    );

    const res = await app.request("/api/netdrive/uploads/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "outputs/run1/complete.dat",
        size: 6,
        contentType: "application/octet-stream",
        sha256: await sha256Hex("abcdef"),
        storageKey: init.data.storageKey,
        uploadId: init.data.uploadId,
        commitToken: init.data.commitToken,
        parts: [
          { partNumber: 1, etag: first.etag },
          { partNumber: 2, etag: second.etag },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { path: string; size: number } };
    expect(body.data).toMatchObject({ path: "outputs/run1/complete.dat", size: 6 });
    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.multipart.complete"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
  });

  test("DELETE /api/netdrive/uploads/multipart aborts and audit-logs", async () => {
    const { app } = makeApp({ sub: OWNER_ID, role: "user", email: ACTOR_EMAIL });
    const initRes = await app.request("/api/netdrive/uploads/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "outputs/run1/a.dat", size: 100 }),
    });
    const init = (await initRes.json()) as {
      data: { storageKey: string; uploadId: string; commitToken: string };
    };
    const res = await app.request("/api/netdrive/uploads/multipart", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey: init.data.storageKey,
        uploadId: init.data.uploadId,
        commitToken: init.data.commitToken,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { aborted: boolean } };
    expect(body.data.aborted).toBe(true);

    const audit = await dbHandle
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "netdrive.multipart.abort"));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe(OWNER_ID);
  });
});
