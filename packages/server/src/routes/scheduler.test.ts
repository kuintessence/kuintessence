import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, orgs, type PgDb, users } from "@kuintessence/db";
import { AppError, ErrorCode, type PlacementTrace } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createSchedulerRoutes } from "./scheduler";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

describe("Scheduler routes — POST /api/scheduler/preview-placement", () => {
  let db: PgDb;
  let app: Hono;
  let testOrgId: string;
  let testUserId: string;
  const TEST_EMAIL = "scheduler-route-test@kuintessence.test";

  let lastInputUserId = "";
  let lastInputUserRole = "";
  let lastInputPreview: boolean | undefined;

  const fakeTrace: PlacementTrace = {
    generatedAt: "2026-05-01T00:00:00.000Z",
    preview: true,
    candidateCount: 2,
    stages: [
      {
        name: "permission",
        inputCount: 2,
        passed: [{ agentId: "good", siteName: "site-good" }],
        rejected: [{ agent: { agentId: "bad", siteName: "site-bad" }, reason: "guest role" }],
      },
      {
        name: "queue",
        inputCount: 1,
        passed: [{ agentId: "good", siteName: "site-good" }],
        rejected: [],
      },
      {
        name: "software",
        inputCount: 1,
        passed: [{ agentId: "good", siteName: "site-good" }],
        rejected: [],
      },
      { name: "billing", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "load", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "urgency", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "install-rights", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "manual", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "auto", inputCount: 1, passed: [{ agentId: "good", score: 90 }], rejected: [] },
    ],
    finalDecision: { agentId: "good", score: 90 },
  };

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);

    const [org] = await db.insert(orgs).values({ name: "test-org-scheduler" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;

    await db
      .insert(users)
      .values({ email: TEST_EMAIL, role: "user", orgId: testOrgId })
      .onConflictDoNothing();
    const [testUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, TEST_EMAIL));
    if (!testUser) throw new Error("failed to create test user");
    testUserId = testUser.id;

    const stubOrchestrator: PlacementOrchestrator = {
      runWithTrace: async (input: { userId: string; userRole: string; preview: boolean }) => {
        lastInputUserId = input.userId;
        lastInputUserRole = input.userRole;
        lastInputPreview = input.preview;
        return fakeTrace;
      },
    } as unknown as PlacementOrchestrator;

    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.use("*", async (c, next) => {
      c.set("user" as never, { sub: TEST_EMAIL, role: "user", email: TEST_EMAIL });
      c.set("principal" as never, {
        sub: TEST_EMAIL,
        role: "user",
        email: TEST_EMAIL,
        userId: testUserId,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: "member" }],
      });
      await next();
    });
    app.route("/api", createSchedulerRoutes(stubOrchestrator, db));
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, TEST_EMAIL));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("returns the trace produced by orchestrator.runWithTrace and propagates user identity", async () => {
    const res = await app.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "preview-job",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlacementTrace;
    expect(body.stages).toHaveLength(9);
    expect(body.finalDecision?.agentId).toBe("good");
    expect(body.preview).toBe(true);

    // Orchestrator was called with the right preview flag and user role.
    expect(lastInputPreview).toBe(true);
    expect(lastInputUserRole).toBe("user");
    expect(lastInputUserId).toBeTruthy();
  });

  test("rejects an invalid job spec with VALIDATION_ERROR envelope", async () => {
    const res = await app.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "missing-resources" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Invalid job preview body");
  });

  test("returns 403 when the canonical principal is missing", async () => {
    const fresh = new Hono();
    fresh.onError(createErrorHandler(testLogger));
    fresh.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "ghost@kuintessence.test",
        role: "user",
        email: "ghost@kuintessence.test",
      });
      await next();
    });
    fresh.route(
      "/api",
      createSchedulerRoutes(
        {
          runWithTrace: async () => fakeTrace,
        } as unknown as PlacementOrchestrator,
        db,
      ),
    );
    const res = await fresh.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ghost-preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects queue preview when SpiceDB denies queue submit", async () => {
    const deniedChecks: AuthzCheck[] = [];
    let validateCalls = 0;
    let runCalls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck) => {
        deniedChecks.push(check);
        throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
      },
      shadowCheck: async () => undefined,
    } as unknown as AuthzService;
    const fresh = new Hono();
    fresh.onError(createErrorHandler(testLogger));
    fresh.use("*", async (c, next) => {
      c.set("user" as never, { sub: TEST_EMAIL, role: "user", email: TEST_EMAIL });
      c.set("principal" as never, {
        sub: TEST_EMAIL,
        role: "user",
        email: TEST_EMAIL,
        userId: testUserId,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: "member" }],
      });
      await next();
    });
    fresh.route(
      "/api",
      createSchedulerRoutes(
        {
          validateSchedulingIntent: async () => {
            validateCalls += 1;
            return null;
          },
          runWithTrace: async () => {
            runCalls += 1;
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        db,
        { authz },
      ),
    );

    const res = await fresh.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "denied-preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-denied" },
      }),
    });

    expect(res.status).toBe(403);
    expect(validateCalls).toBe(1);
    expect(runCalls).toBe(0);
    expect(deniedChecks).toHaveLength(1);
    expect(deniedChecks[0]?.resource).toEqual({ type: "queue", id: "queue-denied" });
    expect(deniedChecks[0]?.permission).toBe("submit");
    expect(deniedChecks[0]?.subject.id).toBe(testUserId);
    expect(deniedChecks[0]?.context?.route).toBe("POST /scheduler/preview-placement");
  });

  test("validates queue intent before SpiceDB queue submit check", async () => {
    let authzCalls = 0;
    let runCalls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        authzCalls += 1;
      },
      shadowCheck: async () => undefined,
    } as unknown as AuthzService;
    const fresh = new Hono();
    fresh.onError(createErrorHandler(testLogger));
    fresh.use("*", async (c, next) => {
      c.set("user" as never, { sub: TEST_EMAIL, role: "user", email: TEST_EMAIL });
      c.set("principal" as never, {
        sub: TEST_EMAIL,
        role: "user",
        email: TEST_EMAIL,
        userId: testUserId,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: "member" }],
      });
      await next();
    });
    fresh.route(
      "/api",
      createSchedulerRoutes(
        {
          validateSchedulingIntent: async () => {
            throw new AppError(ErrorCode.VALIDATION_ERROR, "Queue queue-disabled is disabled", 400);
          },
          runWithTrace: async () => {
            runCalls += 1;
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        db,
        { authz },
      ),
    );

    const res = await fresh.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "disabled-preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-disabled" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Queue queue-disabled is disabled");
    expect(authzCalls).toBe(0);
    expect(runCalls).toBe(0);
  });

  test("queue preview degraded fallback uses bound Server role", async () => {
    const fallbackDecisions: boolean[] = [];
    const userRoles: string[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (_check: AuthzCheck, isPlatformAdmin: boolean) => {
        fallbackDecisions.push(isPlatformAdmin);
      },
      shadowCheck: async () => undefined,
    } as unknown as AuthzService;
    const fresh = new Hono();
    fresh.onError(createErrorHandler(testLogger));
    fresh.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: TEST_EMAIL,
        role: "platform_admin",
        email: TEST_EMAIL,
      });
      c.set("principal" as never, {
        sub: TEST_EMAIL,
        role: "user",
        email: TEST_EMAIL,
        userId: testUserId,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: "member" }],
      });
      await next();
    });
    fresh.route(
      "/api",
      createSchedulerRoutes(
        {
          validateSchedulingIntent: async () => null,
          runWithTrace: async (input: { userRole: string }) => {
            userRoles.push(input.userRole);
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        db,
        { authz },
      ),
    );

    const res = await fresh.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "stale-jwt-preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-allowed" },
      }),
    });

    expect(res.status).toBe(200);
    expect(fallbackDecisions).toEqual([false]);
    expect(userRoles).toEqual(["user"]);
  });

  test("queue preview fails closed in shadow mode without a bound canonical principal", async () => {
    const shadowChecks: ShadowCheckInput[] = [];
    let runCalls = 0;
    const authz = {
      mode: "shadow",
      shadowCheck: async (check: ShadowCheckInput) => {
        shadowChecks.push(check);
        return check.localAllowed ?? false;
      },
    } as unknown as AuthzService;
    const fresh = new Hono();
    fresh.onError(createErrorHandler(testLogger));
    fresh.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: TEST_EMAIL,
        role: "platform_admin",
        email: TEST_EMAIL,
      });
      await next();
    });
    fresh.route(
      "/api",
      createSchedulerRoutes(
        {
          runWithTrace: async () => {
            runCalls += 1;
            return fakeTrace;
          },
        } as unknown as PlacementOrchestrator,
        db,
        { authz },
      ),
    );

    const res = await fresh.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "shadow-unbound-preview",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "queue-shadow" },
      }),
    });

    expect(res.status).toBe(403);
    expect(runCalls).toBe(0);
    expect(shadowChecks).toEqual([]);
  });

  test("returned shape contains all canonical stages in order", async () => {
    const res = await app.request("/api/scheduler/preview-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "shape-check",
        command: "true",
        resources: { cpus: 2, memoryMb: 2048 },
      }),
    });
    const body = (await res.json()) as PlacementTrace;
    expect(body.stages.map((s) => s.name)).toEqual([
      "permission",
      "queue",
      "software",
      "billing",
      "load",
      "urgency",
      "install-rights",
      "manual",
      "auto",
    ]);
  });
});
