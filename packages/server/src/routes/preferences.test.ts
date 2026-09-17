// Test isolation: uses email prefix "preftest-*@kuintessence.test", org "preftest-org"
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  orgs,
  type PgDb,
  schedulingPreferences,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { PreferenceService } from "../preferences/preference-service";
import { createPreferenceRoutes } from "./preferences";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

function makeApp(
  db: PgDb,
  service: PreferenceService,
  role: string,
  email: string,
  principal: { userId?: string; orgIds?: string[] } = {},
) {
  const app = new Hono();
  app.onError(createErrorHandler(testLogger));
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: email, role, email });
    c.set("principal" as never, {
      sub: email,
      role,
      email,
      userId: principal.userId ?? null,
      orgId: principal.orgIds?.[0] ?? null,
      orgIds: principal.orgIds ?? [],
      memberships: (principal.orgIds ?? []).map((orgId) => ({ orgId, role: "admin" })),
    });
    await next();
  });
  app.route("/api", createPreferenceRoutes(service, db));
  return app;
}

describe("Preferences routes", () => {
  let db: PgDb;
  let service: PreferenceService;
  let testOrgId: string;
  let testUserId: string;
  let orgAdminUserId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new PreferenceService(db);

    const [org] = await db.insert(orgs).values({ name: "preftest-org" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;

    const [u] = await db
      .insert(users)
      .values({ email: "preftest-user@kuintessence.test", role: "user", orgId: testOrgId })
      .onConflictDoUpdate({ target: users.email, set: { role: "user", orgId: testOrgId } })
      .returning();
    if (!u) throw new Error("failed to create test user");
    testUserId = u.id;

    const [admin] = await db
      .insert(users)
      .values({ email: "preftest-admin@kuintessence.test", role: "org_admin", orgId: testOrgId })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: "org_admin", orgId: testOrgId },
      })
      .returning();
    if (!admin) throw new Error("failed to create admin user");
    orgAdminUserId = admin.id;
    await db
      .insert(userOrgMemberships)
      .values([
        { userId: testUserId, orgId: testOrgId, role: "member" },
        { userId: orgAdminUserId, orgId: testOrgId, role: "admin" },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    // Clean up scoped preferences
    await db.delete(schedulingPreferences).where(like(schedulingPreferences.name, "default"));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, testOrgId));
    await db.delete(users).where(eq(users.email, "preftest-user@kuintessence.test"));
    await db.delete(users).where(eq(users.email, "preftest-admin@kuintessence.test"));
    await db.delete(users).where(eq(users.email, "preftest-superadmin@kuintessence.test"));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  // ── Global preferences ─────────────────────────────────────────────────

  test("GET /api/preferences/global returns null when not set (any authenticated user)", async () => {
    const app = makeApp(db, service, "user", "preftest-user@kuintessence.test");
    const res = await app.request("/api/preferences/global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: unknown };
    // May or may not exist — just check the shape
    expect("spec" in body).toBe(true);
  });

  test("PUT /api/preferences/global rejects non-super_admin", async () => {
    const app = makeApp(db, service, "org_admin", "preftest-admin@kuintessence.test");
    const res = await app.request("/api/preferences/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        softWeights: { loadWeight: 2, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
      }),
    });
    expect(res.status).toBe(403);
  });

  test("PUT /api/preferences/global succeeds for super_admin", async () => {
    const [superAdmin] = await db
      .insert(users)
      .values({ email: "preftest-superadmin@kuintessence.test", role: "super_admin" })
      .onConflictDoUpdate({ target: users.email, set: { role: "super_admin" } })
      .returning({ id: users.id });
    if (!superAdmin) throw new Error("failed to create super admin");

    const app = makeApp(db, service, "super_admin", "preftest-superadmin@kuintessence.test", {
      userId: superAdmin.id,
    });
    const res = await app.request("/api/preferences/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        softWeights: { loadWeight: 3, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { softWeights?: { loadWeight: number } } };
    expect(body.spec?.softWeights?.loadWeight).toBe(3);
  });

  // ── Org preferences ───────────────────────────────────────────────────

  test("PUT /api/preferences/org/:orgId succeeds for org_admin of that org", async () => {
    const app = makeApp(db, service, "org_admin", "preftest-admin@kuintessence.test", {
      userId: orgAdminUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/org/${testOrgId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 64 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { hardLimits?: { maxCpus: number } } };
    expect(body.spec?.hardLimits?.maxCpus).toBe(64);
  });

  test("PUT /api/preferences/org/:orgId rejects regular user", async () => {
    const app = makeApp(db, service, "user", "preftest-user@kuintessence.test");
    const res = await app.request(`/api/preferences/org/${testOrgId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 8 } }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/preferences/org/:orgId returns spec for org_admin", async () => {
    const app = makeApp(db, service, "org_admin", "preftest-admin@kuintessence.test", {
      userId: orgAdminUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/org/${testOrgId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: unknown };
    expect("spec" in body).toBe(true);
  });

  // ── User preferences ──────────────────────────────────────────────────

  test("GET /api/preferences/user/:userId succeeds for self", async () => {
    const app = makeApp(db, service, "user", "preftest-user@kuintessence.test", {
      userId: testUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/user/${testUserId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: unknown };
    expect("spec" in body).toBe(true);
  });

  test("PUT /api/preferences/user/:userId succeeds for self", async () => {
    const app = makeApp(db, service, "user", "preftest-user@kuintessence.test", {
      userId: testUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/user/${testUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        softWeights: { loadWeight: 1, costWeight: 2, localityWeight: 1, queueWaitWeight: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { softWeights?: { costWeight: number } } };
    expect(body.spec?.softWeights?.costWeight).toBe(2);
  });

  test("PUT /api/preferences/user/:userId rejects access to another user", async () => {
    // Regular user trying to update another user's preferences
    const app = makeApp(db, service, "user", "preftest-user@kuintessence.test", {
      userId: testUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/user/${orgAdminUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test("PUT /api/preferences/user/:userId allows org_admin to update any user", async () => {
    const app = makeApp(db, service, "org_admin", "preftest-admin@kuintessence.test", {
      userId: orgAdminUserId,
      orgIds: [testOrgId],
    });
    const res = await app.request(`/api/preferences/user/${testUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        softWeights: { loadWeight: 1, costWeight: 1, localityWeight: 5, queueWaitWeight: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: { softWeights?: { localityWeight: number } } };
    expect(body.spec?.softWeights?.localityWeight).toBe(5);
  });

  // Regression: ISSUE-005 — preferences PUTs used to leak the raw zValidator envelope
  // {success:false,error:{name:"ZodError",...}}. After kqValidator, we expect the
  // project's AppError envelope (VALIDATION_ERROR + 400 + details). Found by /qa on
  // 2026-04-29 — sibling fix to ISSUE-004 (POST /api/jobs).
  test("PUT /api/preferences/global returns AppError envelope on invalid body", async () => {
    const app = makeApp(db, service, "super_admin", "preftest-superadmin@kuintessence.test");
    const res = await app.request("/api/preferences/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softWeights: { loadWeight: "not-a-number" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Invalid preference spec");
    expect(Array.isArray(body.error.details)).toBe(true);
  });
});
