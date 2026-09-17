import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agents,
  auditLog,
  clusterExecutionAccounts,
  createPgDb,
  orgs,
  type PgDb,
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

function makeApp(db: PgDb, orgIds: string[]) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: ADMIN_ID,
      role: "org_admin",
      email: "sandbox-account-admin@example.test",
      userId: ADMIN_ID,
      orgId: orgIds[0] ?? null,
      orgIds,
      memberships: [],
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
      .delete(auditLog)
      .where(eq(auditLog.action, "sandbox.execution-account.allowed-queues.update"));
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
      .delete(auditLog)
      .where(eq(auditLog.action, "sandbox.execution-account.allowed-queues.update"));
    await db.delete(clusterExecutionAccounts).where(eq(clusterExecutionAccounts.id, ACCOUNT_ID));
    await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
    await db.delete(users).where(eq(users.id, ADMIN_ID));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_ORG_ID));
    await db.delete(orgs).where(eq(orgs.id, OTHER_ORG_ID));
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
