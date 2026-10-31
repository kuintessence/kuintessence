import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  accountAssignmentDelegations,
  agents,
  auditLog,
  clusterExecutionAccounts,
  createPgDb,
  orgs,
  type PgDb,
  userClusterAccountMappings,
  users,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createSandboxAccountRoutes } from "./sandbox-accounts";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PROVIDER_ORG_ID = "d402ba30-d962-4aa1-b725-39a46d9dd101";
const OTHER_ORG_ID = "d402ba30-d962-4aa1-b725-39a46d9dd102";
const ADMIN_ID = "d402ba30-d962-4aa1-b725-39a46d9dd103";
const ACCOUNT_ID = "d402ba30-d962-4aa1-b725-39a46d9dd104";
const AGENT_ID = "sandbox-account-route-agent";

function makeApp(
  db: PgDb,
  orgIds: string[],
  role = "org_admin",
  memberships: Array<{ orgId: string; role: string }> = [],
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: ADMIN_ID,
      role,
      email: "sandbox-account-admin@example.test",
      userId: ADMIN_ID,
      orgId: orgIds[0] ?? null,
      orgIds,
      memberships,
    });
    await next();
  });
  app.route("/api", createSandboxAccountRoutes({ db }));
  return app;
}

describe("sandbox execution account routes", () => {
  let db: PgDb;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await db
      .insert(orgs)
      .values([
        { id: PROVIDER_ORG_ID, name: "Sandbox account route provider" },
        { id: OTHER_ORG_ID, name: "Sandbox account route other" },
      ])
      .onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: ADMIN_ID, email: "sandbox-account-admin@example.test", role: "org_admin" })
      .onConflictDoNothing();
    await db
      .insert(agents)
      .values({
        agentId: AGENT_ID,
        siteName: "Sandbox account route site",
        providerOrgId: PROVIDER_ORG_ID,
        siteId: "sandbox-account-route-site",
        clusterId: "sandbox-account-route-cluster",
        topology: {},
        schedulerType: "slurm",
        schedulerVersion: "23.11.4",
        status: "online",
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    await db
      .delete(userClusterAccountMappings)
      .where(eq(userClusterAccountMappings.userId, ADMIN_ID));
    await db
      .delete(accountAssignmentDelegations)
      .where(eq(accountAssignmentDelegations.providerOrgId, PROVIDER_ORG_ID));
    await db.delete(auditLog).where(eq(auditLog.actor, ADMIN_ID));
    await db
      .insert(clusterExecutionAccounts)
      .values({
        id: ACCOUNT_ID,
        providerOrgId: PROVIDER_ORG_ID,
        agentId: AGENT_ID,
        displayName: "Sandbox account route Unix account",
        backendType: "unix",
        username: "sandbox-route-user",
        uid: 2101,
        gid: 2101,
        allowedQueues: [],
        createdBy: ADMIN_ID,
      })
      .onConflictDoUpdate({
        target: clusterExecutionAccounts.id,
        set: { allowedQueues: [] },
      });
  });

  afterAll(async () => {
    await db
      .delete(userClusterAccountMappings)
      .where(eq(userClusterAccountMappings.userId, ADMIN_ID));
    await db
      .delete(accountAssignmentDelegations)
      .where(eq(accountAssignmentDelegations.providerOrgId, PROVIDER_ORG_ID));
    await db.delete(auditLog).where(eq(auditLog.actor, ADMIN_ID));
    await db.delete(clusterExecutionAccounts).where(eq(clusterExecutionAccounts.id, ACCOUNT_ID));
    await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
    await db.delete(users).where(eq(users.id, ADMIN_ID));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_ORG_ID));
    await db.delete(orgs).where(eq(orgs.id, OTHER_ORG_ID));
  });

  test("an admin without organizations cannot read all execution accounts", async () => {
    const app = makeApp(db, []);
    expect((await app.request("/api/sandbox/accounts")).status).toBe(403);
    expect((await app.request("/api/sandbox/account-mapping-review-queue")).status).toBe(403);
  });

  test("organization admins can review by membership and see applicant identity", async () => {
    const [mapping] = await db
      .insert(userClusterAccountMappings)
      .values({
        userId: ADMIN_ID,
        accountId: ACCOUNT_ID,
        status: "pending",
      })
      .returning();
    const app = makeApp(db, [PROVIDER_ORG_ID], "user", [{ orgId: PROVIDER_ORG_ID, role: "admin" }]);
    expect((await app.request("/api/sandbox/accounts")).status).toBe(200);
    const response = await app.request("/api/sandbox/account-mapping-review-queue");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        {
          mapping: { id: mapping?.id },
          applicant: { email: "sandbox-account-admin@example.test" },
          canReview: true,
        },
      ],
    });
    const review = await app.request(`/api/sandbox/account-mappings/${mapping?.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(review.status).toBe(200);
    expect(
      (
        await makeApp(db, [PROVIDER_ORG_ID], "user", [
          { orgId: PROVIDER_ORG_ID, role: "member" },
        ]).request("/api/sandbox/accounts")
      ).status,
    ).toBe(403);
  });

  test("selected organizations constrain both lists and unauthorized filters are rejected", async () => {
    await db
      .insert(userClusterAccountMappings)
      .values({ userId: ADMIN_ID, accountId: ACCOUNT_ID, status: "pending" });
    const app = makeApp(db, [PROVIDER_ORG_ID, OTHER_ORG_ID]);
    for (const path of ["/api/sandbox/accounts", "/api/sandbox/account-mapping-review-queue"]) {
      const response = await app.request(path, {
        headers: { "X-KQ-Active-Organization": OTHER_ORG_ID },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: [] });
      expect(
        (
          await makeApp(db, [PROVIDER_ORG_ID]).request(path, {
            headers: { "X-KQ-Active-Organization": OTHER_ORG_ID },
          })
        ).status,
      ).toBe(403);
    }
  });

  test("platform review still requires provider delegation", async () => {
    const [mapping] = await db
      .insert(userClusterAccountMappings)
      .values({
        userId: ADMIN_ID,
        accountId: ACCOUNT_ID,
        status: "pending",
      })
      .returning();
    const app = makeApp(db, [PROVIDER_ORG_ID], "super_admin", [
      { orgId: PROVIDER_ORG_ID, role: "member" },
    ]);
    const pending = await app.request("/api/sandbox/account-mapping-review-queue");
    expect(await pending.json()).toMatchObject({ data: [{ canReview: false }] });
    const review = () =>
      app.request(`/api/sandbox/account-mappings/${mapping?.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
    expect((await review()).status).toBe(403);
    await db
      .insert(accountAssignmentDelegations)
      .values({ providerOrgId: PROVIDER_ORG_ID, delegated: true, updatedBy: ADMIN_ID });
    expect(
      await (await app.request("/api/sandbox/account-mapping-review-queue")).json(),
    ).toMatchObject({ data: [{ canReview: true }] });
    expect((await review()).status).toBe(200);
  });

  test("expired approvals can be renewed without demoting a valid approval", async () => {
    const [mapping] = await db
      .insert(userClusterAccountMappings)
      .values({
        userId: ADMIN_ID,
        accountId: ACCOUNT_ID,
        status: "approved",
        isDefault: true,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      })
      .returning();
    expect(mapping).toBeDefined();
    if (!mapping) throw new Error("Missing test mapping");
    const app = makeApp(db, [PROVIDER_ORG_ID]);
    expect(await (await app.request("/api/sandbox/account-mappings")).json()).toMatchObject({
      data: [{ mapping: { status: "expired" } }],
    });
    const request = () =>
      app.request("/api/sandbox/account-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: ACCOUNT_ID }),
      });
    expect((await request()).status).toBe(201);
    await db
      .update(userClusterAccountMappings)
      .set({ status: "approved", expiresAt: null, isDefault: true })
      .where(eq(userClusterAccountMappings.id, mapping.id));
    expect((await request()).status).toBe(409);
    expect(await (await app.request("/api/sandbox/account-mappings")).json()).toMatchObject({
      data: [{ mapping: { status: "approved", isDefault: true } }],
    });
  });

  test("provider admin updates the queue allowlist and records before/after audit facts", async () => {
    const response = await makeApp(db, [PROVIDER_ORG_ID]).request(
      `/api/sandbox/accounts/${ACCOUNT_ID}/allowed-queues`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedQueues: ["slurm23-debug"] }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { allowedQueues: string[] } };
    expect(body.data.allowedQueues).toEqual(["slurm23-debug"]);
    const [account] = await db
      .select({ allowedQueues: clusterExecutionAccounts.allowedQueues })
      .from(clusterExecutionAccounts)
      .where(eq(clusterExecutionAccounts.id, ACCOUNT_ID));
    expect(account?.allowedQueues).toEqual(["slurm23-debug"]);
    const [audit] = await db
      .select({ actor: auditLog.actor, target: auditLog.target, diff: auditLog.diff })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "sandbox.execution-account.allowed-queues.update"),
          eq(auditLog.target, ACCOUNT_ID),
        ),
      );
    expect(audit).toEqual({
      actor: ADMIN_ID,
      target: ACCOUNT_ID,
      diff: {
        before: { allowedQueues: [] },
        after: { allowedQueues: ["slurm23-debug"] },
      },
    });
  });

  test("admin outside the provider cannot update the queue allowlist", async () => {
    const response = await makeApp(db, [OTHER_ORG_ID]).request(
      `/api/sandbox/accounts/${ACCOUNT_ID}/allowed-queues`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedQueues: ["slurm23-debug"] }),
      },
    );

    expect(response.status).toBe(403);
    const [account] = await db
      .select({ allowedQueues: clusterExecutionAccounts.allowedQueues })
      .from(clusterExecutionAccounts)
      .where(eq(clusterExecutionAccounts.id, ACCOUNT_ID));
    expect(account?.allowedQueues).toEqual([]);
  });

  test("rejects duplicate queue names without mutating the account", async () => {
    const response = await makeApp(db, [PROVIDER_ORG_ID]).request(
      `/api/sandbox/accounts/${ACCOUNT_ID}/allowed-queues`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedQueues: ["slurm23-debug", "slurm23-debug"] }),
      },
    );

    expect(response.status).toBe(400);
    const [account] = await db
      .select({ allowedQueues: clusterExecutionAccounts.allowedQueues })
      .from(clusterExecutionAccounts)
      .where(eq(clusterExecutionAccounts.id, ACCOUNT_ID));
    expect(account?.allowedQueues).toEqual([]);
  });
});
