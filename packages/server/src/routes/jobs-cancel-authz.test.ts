/**
 * Authz regression — POST /api/jobs/:id/cancel is a state mutation and must be
 * restricted to the job owner (or platform_admin). Before this, any
 * authenticated user could cancel ANY job by id (a write/DoS IDOR).
 *
 * Test isolation: emails "cancelauthz-*@kuintessence.test", org
 * "cancelauthz-org", job names prefixed "test-cancelauthz-".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, jobs, orgs, type PgDb, users } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { JobService } from "../services/job-service";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createJobRoutes } from "./jobs";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const OWNER_EMAIL = "cancelauthz-owner@kuintessence.test";
const OTHER_EMAIL = "cancelauthz-other@kuintessence.test";
const UNBOUND_EMAIL = "cancelauthz-unbound@kuintessence.test";

describe("Job cancel authz", () => {
  let db: PgDb;
  let testOrgId: string;
  let ownerId: string;
  let otherId: string;

  function makeApp(
    asEmail: string,
    role: string,
    authz?: AuthzService,
    principalRole: string = role,
    principalEmail: string = asEmail,
  ) {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, { sub: asEmail, role, email: asEmail });
      c.set("principal" as never, {
        sub: asEmail,
        role: principalRole,
        email: principalEmail,
        userId: asEmail === OWNER_EMAIL ? ownerId : asEmail === OTHER_EMAIL ? otherId : null,
      });
      await next();
    });
    const service = new JobService(db);
    const stubOrch: PlacementOrchestrator = {
      validateSchedulingIntent: async () => null,
      placeAndDispatch: async () => ({ selectedAgentId: null, rejections: [], dispatched: false }),
    } as unknown as PlacementOrchestrator;
    app.route("/api", createJobRoutes(service, db, stubOrch, { authz }));
    return app;
  }

  function fakeEnforceAuthz() {
    const checks: Array<{ input: AuthzCheck; isPlatformAdmin: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        checks.push({ input, isPlatformAdmin });
      },
    } as unknown as AuthzService;
    return { authz, checks };
  }

  async function makeJob(): Promise<string> {
    const [job] = await db
      .insert(jobs)
      .values({
        name: "test-cancelauthz-job",
        command: "sleep 100",
        cpus: 1,
        memoryMb: 1024,
        submittedBy: ownerId,
      })
      .returning();
    if (!job) throw new Error("failed to create job");
    return job.id;
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    const [org] = await db.insert(orgs).values({ name: "cancelauthz-org" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;

    await db
      .insert(users)
      .values([
        { email: OWNER_EMAIL, role: "user", orgId: testOrgId },
        { email: OTHER_EMAIL, role: "user", orgId: testOrgId },
      ])
      .onConflictDoNothing();
    const [owner] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL)).limit(1);
    if (!owner) throw new Error("failed to fetch owner");
    ownerId = owner.id;
    const [other] = await db.select().from(users).where(eq(users.email, OTHER_EMAIL)).limit(1);
    if (!other) throw new Error("failed to fetch other user");
    otherId = other.id;
  });

  afterAll(async () => {
    await db.delete(jobs).where(like(jobs.name, "test-cancelauthz-%"));
    await db.delete(users).where(eq(users.email, OWNER_EMAIL));
    await db.delete(users).where(eq(users.email, OTHER_EMAIL));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("a non-owner cannot cancel another user's job (403) and status is unchanged", async () => {
    const jobId = await makeJob();
    const res = await makeApp(OTHER_EMAIL, "user").request(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(403);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(row?.status).not.toBe("cancelled");
  });

  test("the owner can cancel their own job (200 → cancelled)", async () => {
    const jobId = await makeJob();
    const res = await makeApp(OWNER_EMAIL, "user").request(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });

  test("a platform_admin can cancel any job (200 → cancelled)", async () => {
    const jobId = await makeJob();
    const res = await makeApp(OTHER_EMAIL, "platform_admin").request(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });

  test("stale JWT platform_admin cannot cancel another user's job in local mode", async () => {
    const jobId = await makeJob();
    const res = await makeApp(OTHER_EMAIL, "platform_admin", undefined, "user").request(
      `/api/jobs/${jobId}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(403);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(row?.status).not.toBe("cancelled");
  });

  test("SpiceDB job#cancel can authorize a non-owner in enforce mode", async () => {
    const jobId = await makeJob();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(
      OTHER_EMAIL,
      "user",
      fake.authz,
      "user",
      "bound-cancel@kuintessence.test",
    ).request(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
    expect(fake.checks).toEqual([
      {
        input: {
          actorUserId: otherId,
          actorEmail: "bound-cancel@kuintessence.test",
          resource: { type: "job", id: jobId },
          permission: "cancel",
          subject: { type: "user", id: otherId },
          context: { route: "POST /jobs/:id/cancel" },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("job#view fails closed in enforce mode without canonical user id", async () => {
    const jobId = await makeJob();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(UNBOUND_EMAIL, "user", fake.authz).request(`/api/jobs/${jobId}`);

    expect(res.status).toBe(403);
    expect(fake.checks).toEqual([]);
  });

  test("job#cancel fails closed in enforce mode without canonical user id", async () => {
    const jobId = await makeJob();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(UNBOUND_EMAIL, "user", fake.authz).request(
      `/api/jobs/${jobId}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(403);
    expect(fake.checks).toEqual([]);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(row?.status).not.toBe("cancelled");
  });

  test("job#cancel degraded fallback uses bound principal role", async () => {
    const jobId = await makeJob();
    const fake = fakeEnforceAuthz();
    const res = await makeApp(OTHER_EMAIL, "platform_admin", fake.authz, "user").request(
      `/api/jobs/${jobId}/cancel`,
      {
        method: "POST",
      },
    );

    expect(res.status).toBe(200);
    expect(fake.checks[0]?.isPlatformAdmin).toBe(false);
  });
});
