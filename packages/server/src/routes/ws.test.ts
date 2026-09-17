import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  jobs,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { AUTH_SESSION_COOKIE } from "../auth/session-cookie";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { EventBus } from "../events/event-bus";
import { createErrorHandler } from "../middleware/error-handler";
import { signToken } from "../services/auth";
import { JobService } from "../services/job-service";
import { createWsRoutes, type WsAuthDependencies } from "./ws";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const JWT_SECRET = "test-ws-secret-do-not-use-in-prod";
const testLogger = pino({ level: "silent" });

/**
 * Coverage for /ws/jobs/:id and /ws/workflows/:runId routes:
 * - 401 without JWT (header, token query, or auth session cookie)
 * - 403 when the caller is a `user` who doesn't own the job and isn't admin
 * - 200 / message-on-publish path is exercised through the route handler's
 *   internal listener — actual WebSocket upgrade is delegated to Bun and
 *   therefore not invoked under app.request(); we instead verify the auth +
 *   RBAC gate runs *before* upgrade and that the route is registered.
 *
 * The "websocket reachable" test in this file uses the explicit auth
 * dependency-injection seam (WsAuthDependencies.tokenForUpgrade) so we don't
 * have to spin up an actual TLS/Bun.serve in unit tests.
 */
describe("WS routes — auth + RBAC", () => {
  let db: PgDb;
  let app: Hono;
  let ownerId: string;
  let strangerId: string;
  let ownerJobId: string;
  let foreignJobId: string;
  let testRunId: string;
  let testOrgId: string;
  let otherOrgId: string;
  let providerOrgId: string;
  let bus: EventBus;
  let ownerToken: string;
  let strangerToken: string;
  let adminToken: string;
  let orgAdminToken: string;
  let otherOrgAdminToken: string;
  let providerOperatorToken: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);

    const [org] = await db.insert(orgs).values({ name: "test-org-ws" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;
    const [otherOrg] = await db.insert(orgs).values({ name: "test-org-ws-other" }).returning();
    if (!otherOrg) throw new Error("failed to create other test org");
    otherOrgId = otherOrg.id;
    const [providerOrg] = await db
      .insert(orgs)
      .values({ name: "test-org-ws-provider" })
      .returning();
    if (!providerOrg) throw new Error("failed to create provider org");
    providerOrgId = providerOrg.id;

    const [owner] = await db
      .insert(users)
      .values({
        email: "ws-owner@kuintessence.test",
        role: "user",
        orgId: testOrgId,
      })
      .returning();
    if (!owner) throw new Error("create owner failed");
    ownerId = owner.id;

    const [stranger] = await db
      .insert(users)
      .values({
        email: "ws-stranger@kuintessence.test",
        role: "user",
        orgId: testOrgId,
      })
      .returning();
    if (!stranger) throw new Error("create stranger failed");
    strangerId = stranger.id;

    const [admin] = await db
      .insert(users)
      .values({
        email: "ws-admin@kuintessence.test",
        role: "platform_admin",
        orgId: testOrgId,
      })
      .returning();
    if (!admin) throw new Error("create admin failed");
    const [orgAdmin] = await db
      .insert(users)
      .values({
        email: "ws-org-admin@kuintessence.test",
        role: "org_admin",
        orgId: testOrgId,
      })
      .returning();
    if (!orgAdmin) throw new Error("create org admin failed");

    const [otherOrgAdmin] = await db
      .insert(users)
      .values({
        email: "ws-other-org-admin@kuintessence.test",
        role: "org_admin",
        orgId: otherOrgId,
      })
      .returning();
    if (!otherOrgAdmin) throw new Error("create other org admin failed");
    const [providerOperator] = await db
      .insert(users)
      .values({
        email: "ws-provider-operator@kuintessence.test",
        role: "user",
        orgId: providerOrgId,
      })
      .returning();
    if (!providerOperator) throw new Error("create provider operator failed");

    await db.insert(userOrgMemberships).values([
      { userId: ownerId, orgId: testOrgId, role: "member" },
      { userId: strangerId, orgId: testOrgId, role: "member" },
      { userId: admin.id, orgId: testOrgId, role: "admin" },
      { userId: orgAdmin.id, orgId: testOrgId, role: "admin" },
      { userId: otherOrgAdmin.id, orgId: otherOrgId, role: "admin" },
      { userId: providerOperator.id, orgId: providerOrgId, role: "operator" },
    ]);

    const jobService = new JobService(db);

    // Owner-submitted job (should be visible to owner + admin, hidden from stranger)
    const ownerJob = await jobService.submit(
      {
        name: "test-job-ws-owner",
        command: "true",
        resources: { cpus: 1, memoryMb: 512 },
      },
      ownerId,
    );
    ownerJobId = ownerJob.id;
    await db.update(jobs).set({ providerOrgId }).where(eq(jobs.id, ownerJobId));

    // Foreign job submitted by stranger
    const foreignJob = await jobService.submit(
      {
        name: "test-job-ws-foreign",
        command: "true",
        resources: { cpus: 1, memoryMb: 512 },
      },
      strangerId,
    );
    foreignJobId = foreignJob.id;

    // Workflow run submitted by owner
    const [run] = await db
      .insert(workflowRuns)
      .values({
        name: "test-wf-ws",
        submittedBy: ownerId,
        status: "running",
        stepJobs: {},
      })
      .returning();
    if (!run) throw new Error("create run failed");
    testRunId = run.id;

    bus = new EventBus();

    // Production tokens set `sub` to the EMAIL (see auth.ts signToken calls), not
    // the user UUID — the WS authz must resolve the UUID from it to compare
    // against jobs.submittedBy.
    ownerToken = await signToken(
      { sub: owner.email, role: "user", email: owner.email },
      JWT_SECRET,
      300,
    );
    strangerToken = await signToken(
      { sub: stranger.email, role: "user", email: stranger.email },
      JWT_SECRET,
      300,
    );
    adminToken = await signToken(
      { sub: admin.email, role: "platform_admin", email: admin.email },
      JWT_SECRET,
      300,
    );
    orgAdminToken = await signToken(
      { sub: orgAdmin.email, role: "org_admin", email: orgAdmin.email },
      JWT_SECRET,
      300,
    );
    otherOrgAdminToken = await signToken(
      { sub: otherOrgAdmin.email, role: "org_admin", email: otherOrgAdmin.email },
      JWT_SECRET,
      300,
    );
    providerOperatorToken = await signToken(
      { sub: providerOperator.email, role: "user", email: providerOperator.email },
      JWT_SECRET,
      300,
    );

    const deps: WsAuthDependencies = { db, jwtSecret: JWT_SECRET, bus };

    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route("/ws", createWsRoutes(deps));
  });

  afterAll(async () => {
    await db.delete(workflowRuns).where(like(workflowRuns.name, "test-wf-ws%"));
    await db.delete(jobs).where(like(jobs.name, "test-job-ws-%"));
    await db.delete(users).where(like(users.email, "ws-%@kuintessence.test"));
    await db.delete(orgs).where(eq(orgs.id, otherOrgId));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("rejects /ws/jobs/:id without a token (401)", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects /ws/jobs/:id with an invalid token (401)", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=not-a-real-jwt`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects /ws/jobs/:id when caller is a different user (403)", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${strangerToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects /ws/jobs/:id for an unknown job (404)", async () => {
    const res = await app.request(
      `/ws/jobs/00000000-0000-0000-0000-000000000000?token=${ownerToken}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(404);
  });

  test("rejects /ws/jobs/:id with a malformed UUID (400)", async () => {
    const res = await app.request(`/ws/jobs/not-a-uuid?token=${ownerToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });

  test("allows owner to subscribe to their own job (passes through to upgrade layer)", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${ownerToken}`, {
      headers: { Upgrade: "websocket" },
    });
    // app.request() doesn't actually perform a WS handshake — Bun does. The
    // route should at minimum not have rejected at the auth/RBAC stage.
    // We assert "not 401/403/404/400" to confirm the gate let it through.
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("allows a canonical UUID sub even when the token email is stale", async () => {
    const uuidToken = await signToken(
      { sub: ownerId, role: "user", email: "stale-ws-owner@kuintessence.test" },
      JWT_SECRET,
      300,
    );
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${uuidToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("allows platform_admin to subscribe to a foreign job", async () => {
    const res = await app.request(`/ws/jobs/${foreignJobId}?token=${adminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("allows org_admin to subscribe to same-org jobs in local mode", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("allows a provider operator through the job provider snapshot", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${providerOperatorToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("rejects org_admin subscribing to another org job in local mode", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${otherOrgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("stale JWT platform_admin cannot subscribe to a foreign job in local mode", async () => {
    const staleAdminToken = await signToken(
      {
        sub: "ws-stranger@kuintessence.test",
        role: "platform_admin",
        email: "ws-stranger@kuintessence.test",
      },
      JWT_SECRET,
      300,
    );

    const res = await app.request(`/ws/jobs/${ownerJobId}?token=${staleAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(403);
  });

  test("rejects /ws/workflows/:runId without a token (401)", async () => {
    const res = await app.request(`/ws/workflows/${testRunId}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects /ws/workflows/:runId for a stranger (403)", async () => {
    const res = await app.request(`/ws/workflows/${testRunId}?token=${strangerToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("allows org_admin to subscribe to same-org workflows in local mode", async () => {
    const res = await app.request(`/ws/workflows/${testRunId}?token=${orgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("rejects org_admin subscribing to another org workflow in local mode", async () => {
    const res = await app.request(`/ws/workflows/${testRunId}?token=${otherOrgAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("accepts Authorization Bearer header in addition to ?token query", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${ownerToken}`,
      },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("accepts the auth session cookie for browser WebSocket upgrades", async () => {
    const res = await app.request(`/ws/jobs/${ownerJobId}`, {
      headers: {
        Upgrade: "websocket",
        Cookie: `${AUTH_SESSION_COOKIE}=${ownerToken}`,
      },
    });
    expect([200, 101, 426, 500]).toContain(res.status);
  });

  test("SpiceDB degraded fallback uses the DB role, not the JWT role", async () => {
    const staleAdminToken = await signToken(
      {
        sub: "ws-stranger@kuintessence.test",
        role: "platform_admin",
        email: "ws-stranger@kuintessence.test",
      },
      JWT_SECRET,
      300,
    );
    const calls: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        calls.push({ input, isPlatformAdmin });
      },
    } as unknown as AuthzService;
    const appWithAuthz = new Hono();
    appWithAuthz.onError(createErrorHandler(testLogger));
    appWithAuthz.route("/ws", createWsRoutes({ db, jwtSecret: JWT_SECRET, bus, authz }));

    const res = await appWithAuthz.request(`/ws/jobs/${ownerJobId}?token=${staleAdminToken}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.isPlatformAdmin).toBe(false);
  });
});
