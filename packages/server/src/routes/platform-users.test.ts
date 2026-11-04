import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  auditLog,
  authSessions,
  createPgDb,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createBrowserSession, isBrowserSessionActive } from "../auth/session-ledger";
import { authMiddleware } from "../middleware/auth";
import { createErrorHandler } from "../middleware/error-handler";
import { signToken } from "../services/auth";
import { canManagePlatformUser, createPlatformUserRoutes } from "./platform-users";

const actorId = "a3600000-0000-4000-8000-000000000001";
const userId = "a3600000-0000-4000-8000-000000000002";
const adminId = "a3600000-0000-4000-8000-000000000003";
const orgId = "a3600000-0000-4000-8000-000000000004";
const sessionId = "a3600000-0000-4000-8000-000000000005";

test("user status management cannot lock out self, peers, administrators, or unknown roles", () => {
  const actor = { userId: actorId, role: "operator" };
  for (const role of ["user", "org_admin", "guest"])
    expect(canManagePlatformUser(actor, { id: userId, role })).toBe(true);
  for (const role of ["operator", "platform_admin", "super_admin", "unknown"])
    expect(canManagePlatformUser(actor, { id: userId, role })).toBe(false);
  expect(canManagePlatformUser(actor, { id: actorId, role: "user" })).toBe(false);
  expect(
    canManagePlatformUser({ userId: actorId, role: "org_admin" }, { id: userId, role: "user" }),
  ).toBe(false);
});

describe("platform user operations", () => {
  const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
  function app(role = "operator", id = actorId) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, {
        userId: id,
        sub: id,
        role,
        email: "ops-platform@test.invalid",
        orgId: null,
        orgIds: [],
        memberships: [],
      });
      await next();
    });
    r.route("/api", createPlatformUserRoutes(db));
    return r;
  }
  function status(id: string, suspended: boolean, role = "operator", reason = "Access review") {
    return app(role).request(`/api/platform/users/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suspended, reason }),
    });
  }
  beforeAll(async () => {
    await db.insert(orgs).values({ id: orgId, name: "Platform operations test provider" });
    await db.insert(users).values([
      { id: actorId, role: "operator", email: "ops-platform@test.invalid" },
      { id: userId, role: "user", email: "ops-user@test.invalid" },
      { id: adminId, role: "platform_admin", email: "ops-admin@test.invalid" },
    ]);
    await db.insert(userOrgMemberships).values({ userId, orgId, role: "member" });
  });
  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.actor, actorId));
    await db.delete(authSessions).where(inArray(authSessions.userId, [actorId, userId, adminId]));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, orgId));
    await db.delete(users).where(inArray(users.id, [actorId, userId, adminId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  });
  test("global list preserves provider filters and denies providers and users", async () => {
    const response = await app().request("/api/platform/users", {
      headers: { "X-KQ-Active-Organization": orgId },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: userId, canManage: true, organizations: [{ id: orgId }] }],
    });
    for (const role of ["org_admin", "user"])
      expect((await app(role).request("/api/platform/users")).status).toBe(403);
    expect((await status(userId, true, "org_admin")).status).toBe(403);
    expect((await status(actorId, true)).status).toBe(403);
    expect((await status(adminId, true)).status).toBe(403);
    expect((await status(userId, true, "operator", " ")).status).toBe(400);
  });
  test("suspension revokes sessions, blocks existing tokens and new sessions, and is audited; enable permits a new login", async () => {
    const input = {
      sessionId,
      familyId: crypto.randomUUID(),
      userId,
      refreshTokenId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await createBrowserSession(db, input);
    const secret = "platform-operations-test-secret";
    const token = await signToken(
      { sub: userId, role: "user", email: "ops-user@test.invalid" },
      secret,
      60,
    );
    const secured = new Hono();
    secured.onError(createErrorHandler(pino({ level: "silent" })));
    secured.use("*", authMiddleware(secret, db));
    secured.get("/check", (c) => c.json({ ok: true }));
    const request = () =>
      secured.request("/check", { headers: { Authorization: `Bearer ${token}` } });
    expect((await request()).status).toBe(200);
    expect((await status(userId, true)).status).toBe(200);
    expect(await isBrowserSessionActive(db, { sessionId, userId })).toBe(false);
    expect((await request()).status).toBe(401);
    await expect(
      createBrowserSession(db, {
        ...input,
        sessionId: crypto.randomUUID(),
        refreshTokenId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Account suspended");
    const entries = await db
      .select({ diff: auditLog.diff })
      .from(auditLog)
      .where(and(eq(auditLog.actor, actorId), eq(auditLog.target, userId)));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.diff).toMatchObject({
      before: { suspended: false },
      after: { suspended: true, reason: "Access review" },
    });
    expect((await status(userId, false)).status).toBe(200);
    expect(await isBrowserSessionActive(db, { sessionId, userId })).toBe(false);
    await createBrowserSession(db, {
      ...input,
      sessionId: crypto.randomUUID(),
      refreshTokenId: crypto.randomUUID(),
    });
  });
});
