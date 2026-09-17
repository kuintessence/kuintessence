import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { auditLog, createPgDb, fileTransferAuditConfig, type PgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminFileTransferAuditConfigRoutes } from "./admin-file-transfer-audit-config";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000034";
const db: PgDb = createPgDb(TEST_DB_URL);

function makeApp(role: string) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: ACTOR_USER_ID,
      role,
      email: `${role}@file-transfer-audit.test`,
      userId: ACTOR_USER_ID,
      orgId: null,
      orgIds: [],
      memberships: [],
    });
    await next();
  });
  app.route("/api", createAdminFileTransferAuditConfigRoutes(db));
  return app;
}

async function clearAll() {
  await db.delete(fileTransferAuditConfig);
  await db.delete(auditLog).where(eq(auditLog.action, "file_transfer_audit.config.update"));
}

beforeEach(clearAll);
afterAll(clearAll);

describe("GET /admin/file-transfer-audit/config", () => {
  test("returns safe defaults to platform viewers", async () => {
    const response = await makeApp("operator").request("/api/admin/file-transfer-audit/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userPlatformRetentionDays: 365,
      platformClusterRetentionDays: 180,
      downloadEvidenceMode: "controlled_gateway",
      policyVersion: 1,
      updatedAt: null,
      updatedBy: null,
    });
  });

  test("rejects regular users", async () => {
    const response = await makeApp("user").request("/api/admin/file-transfer-audit/config");
    expect(response.status).toBe(403);
  });
});

describe("PUT /admin/file-transfer-audit/config", () => {
  test("persists a versioned policy and its audited reason", async () => {
    const response = await makeApp("platform_admin").request(
      "/api/admin/file-transfer-audit/config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPlatformRetentionDays: 730,
          platformClusterRetentionDays: 365,
          downloadEvidenceMode: "direct_authorization_only",
          changeReason: "演练期间临时延长追溯窗口",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userPlatformRetentionDays: 730,
      platformClusterRetentionDays: 365,
      downloadEvidenceMode: "direct_authorization_only",
      policyVersion: 2,
      updatedBy: ACTOR_USER_ID,
    });

    const [stored] = await db.select().from(fileTransferAuditConfig);
    expect(stored?.policyVersion).toBe(2);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "file_transfer_audit.config.update"));
    expect(audit?.actor).toBe(ACTOR_USER_ID);
    expect(audit?.diff).toMatchObject({
      after: {
        policyVersion: 2,
        changeReason: "演练期间临时延长追溯窗口",
      },
    });
  });

  test("rejects read-only operators and invalid retention", async () => {
    const input = {
      userPlatformRetentionDays: 0,
      platformClusterRetentionDays: 180,
      downloadEvidenceMode: "controlled_gateway",
      changeReason: "无效策略测试",
    };
    const denied = await makeApp("operator").request("/api/admin/file-transfer-audit/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, userPlatformRetentionDays: 365 }),
    });
    expect(denied.status).toBe(403);

    const invalid = await makeApp("platform_admin").request(
      "/api/admin/file-transfer-audit/config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    expect(invalid.status).toBe(400);
  });

  test("does not create a new version for an unchanged default policy", async () => {
    const response = await makeApp("platform_admin").request(
      "/api/admin/file-transfer-audit/config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPlatformRetentionDays: 365,
          platformClusterRetentionDays: 180,
          downloadEvidenceMode: "controlled_gateway",
          changeReason: "确认当前默认策略",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await db.select().from(fileTransferAuditConfig)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "file_transfer_audit.config.update")),
    ).toHaveLength(0);
  });
});
