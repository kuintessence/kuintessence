/**
 * integration test — verifies that GET /api/jobs/:id desensitizes
 * `command` and `envVars` for non-owner viewers when global is on, and
 * always returns cleartext to the job owner / platform_admin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  desensitizeConfig as cfgTable,
  createPgDb,
  jobs,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq, inArray, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { JobService } from "../services/job-service";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createJobRoutes } from "./jobs";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const OWNER_EMAIL = "b5-owner@kuintessence.test";
const VIEWER_EMAIL = "b5-viewer@kuintessence.test";

describe("Job routes — desensitize integration", () => {
  let db: PgDb;
  let testOrgId: string;
  let legacyOrgId: string;
  let createdJobId: string;
  let ownerId: string;
  let viewerId: string;

  function makeApp(
    asEmail: string,
    role: string,
    principalRole = role,
    membershipRole = asEmail === VIEWER_EMAIL ? "admin" : "member",
  ) {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, { sub: asEmail, role, email: asEmail });
      c.set("principal" as never, {
        sub: asEmail,
        role: principalRole,
        email: asEmail,
        userId: asEmail === OWNER_EMAIL ? ownerId : asEmail === VIEWER_EMAIL ? viewerId : null,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: membershipRole }],
      });
      await next();
    });
    const service = new JobService(db);
    const stubOrch: PlacementOrchestrator = {
      validateSchedulingIntent: async () => null,
      placeAndDispatch: async () => ({ selectedAgentId: null, rejections: [], dispatched: false }),
    } as unknown as PlacementOrchestrator;
    app.route("/api", createJobRoutes(service, db, stubOrch));
    return app;
  }

  async function clearB5Config(): Promise<void> {
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "__enabled__"));
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "command"));
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "envVars"));
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);

    const [org] = await db.insert(orgs).values({ name: "test-org-b5-jobs" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;
    const [legacyOrg] = await db
      .insert(orgs)
      .values({ name: "test-org-b5-jobs-legacy-user-org" })
      .returning();
    if (!legacyOrg) throw new Error("failed to create legacy test org");
    legacyOrgId = legacyOrg.id;

    await db
      .insert(users)
      .values({ email: OWNER_EMAIL, role: "user", orgId: legacyOrgId })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: "user", orgId: legacyOrgId },
      });
    await db
      .insert(users)
      .values({ email: VIEWER_EMAIL, role: "user", orgId: legacyOrgId })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: "user", orgId: legacyOrgId },
      });

    const [owner] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL)).limit(1);
    if (!owner) throw new Error("failed to fetch owner");
    ownerId = owner.id;
    const [viewer] = await db.select().from(users).where(eq(users.email, VIEWER_EMAIL)).limit(1);
    if (!viewer) throw new Error("failed to fetch viewer");
    viewerId = viewer.id;
    await db
      .delete(userOrgMemberships)
      .where(inArray(userOrgMemberships.userId, [owner.id, viewer.id]));
    await db
      .insert(userOrgMemberships)
      .values([
        { userId: owner.id, orgId: testOrgId, role: "member" },
        { userId: viewer.id, orgId: testOrgId, role: "admin" },
      ])
      .onConflictDoNothing();

    // Create a job owned by `owner` with sensitive command + envVars.
    const [job] = await db
      .insert(jobs)
      .values({
        name: "test-b5-job-",
        command: "secret-command --token=abc123",
        cpus: 1,
        memoryMb: 1024,
        submittedBy: owner.id,
        orgId: testOrgId,
        envVars: { SECRET_KEY: "shhhh" } as Record<string, string>,
      })
      .returning();
    if (!job) throw new Error("failed to create job");
    createdJobId = job.id;

    await clearB5Config();
  });

  afterEach(async () => {
    await clearB5Config();
  });

  afterAll(async () => {
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, testOrgId));
    await db.delete(jobs).where(like(jobs.name, "test-b5-job-%"));
    await db.delete(users).where(eq(users.email, OWNER_EMAIL));
    await db.delete(users).where(eq(users.email, VIEWER_EMAIL));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
    await db.delete(orgs).where(eq(orgs.id, legacyOrgId));
    await clearB5Config();
  });

  test("default OFF: non-owner sees cleartext command and envVars", async () => {
    const res = await makeApp(VIEWER_EMAIL, "user").request(`/api/jobs/${createdJobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; envVars: Record<string, string> };
    expect(body.command).toBe("secret-command --token=abc123");
    expect(body.envVars.SECRET_KEY).toBe("shhhh");
  });

  test("default OFF: ordinary consumer organization members cannot view another user's job", async () => {
    const res = await makeApp(VIEWER_EMAIL, "user", "user", "member").request(
      `/api/jobs/${createdJobId}`,
    );
    expect(res.status).toBe(403);
  });

  test("ON + redact rules: non-owner sees redacted command and envVars", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "command", action: "redact" },
      { scope: "global", fieldPath: "envVars", action: "redact" },
    ]);

    const res = await makeApp(VIEWER_EMAIL, "user").request(`/api/jobs/${createdJobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; envVars: string };
    expect(body.command).toBe("***");
    // envVars is a non-string (object), so redact returns "[redacted]".
    expect(body.envVars).toBe("[redacted]");
  });

  test("ON + redact rules: the job LIST also redacts for a non-owner (no bypass)", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "command", action: "redact" },
    ]);
    const res = await makeApp(VIEWER_EMAIL, "user").request("/api/jobs");
    expect(res.status).toBe(200);
    const { jobs: list } = (await res.json()) as { jobs: Array<{ id: string; command: string }> };
    const seen = list.find((j) => j.id === createdJobId);
    expect(seen?.command).toBe("***");
  });

  test("ON + redact rules: owner still sees cleartext (bypass)", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "command", action: "redact" },
    ]);

    const res = await makeApp(OWNER_EMAIL, "user").request(`/api/jobs/${createdJobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string };
    expect(body.command).toBe("secret-command --token=abc123");
  });

  test("ON + redact rules: platform_admin sees cleartext (bypass)", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "command", action: "redact" },
    ]);

    const res = await makeApp(VIEWER_EMAIL, "platform_admin").request(`/api/jobs/${createdJobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string };
    expect(body.command).toBe("secret-command --token=abc123");
  });

  test("ON + redact rules: stale JWT platform_admin does not bypass desensitization", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "command", action: "redact" },
    ]);

    const res = await makeApp(VIEWER_EMAIL, "platform_admin", "user").request(
      `/api/jobs/${createdJobId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string };
    expect(body.command).toBe("***");
  });
});
