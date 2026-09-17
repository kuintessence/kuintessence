/**
 * integration test — verifies that the audit-log route honors
 * desensitize_config rows when globalEnabled is on, and remains a no-op
 * when off.
 *
 * Test isolation: this suite uses actor prefix "test-b5-audit-" and the
 * synthetic '__enabled__' flag row plus a unique field path so it does not
 * collide with the parallel config-loader suite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, desensitizeConfig as cfgTable, createPgDb, type PgDb } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createAuditLogRoutes } from "./audit-log";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const ACTOR_PREFIX = "test-b5-audit-";

describe("Audit log routes — desensitize integration", () => {
  let db: PgDb;

  function makeApp() {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "x",
        role: "platform_admin",
        email: "x@test",
      });
      c.set("principal" as never, {
        sub: "x",
        role: "platform_admin",
        email: "x@test",
        userId: "audit-desensitize-user",
        orgId: null,
        orgIds: [],
        memberships: [],
      });
      await next();
    });
    app.route("/api", createAuditLogRoutes(db));
    return app;
  }

  async function clearAllB5Config(): Promise<void> {
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "__enabled__"));
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "actor"));
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await clearAllB5Config();
    await db.insert(auditLog).values({
      actor: `${ACTOR_PREFIX}alice@example.com`,
      action: "test_login",
      target: "session",
    });
  });

  afterEach(async () => {
    await clearAllB5Config();
  });

  afterAll(async () => {
    await db.delete(auditLog).where(like(auditLog.actor, `${ACTOR_PREFIX}%`));
    await clearAllB5Config();
  });

  test("default OFF: actor field is returned in cleartext", async () => {
    const res = await makeApp().request("/api/audit-log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ actor: string }> };
    expect(body.entries.some((e) => e.actor === `${ACTOR_PREFIX}alice@example.com`)).toBe(true);
  });

  test("ON + global redact rule: actor returns ***", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "redact" },
      { scope: "global", fieldPath: "actor", action: "redact" },
    ]);

    const res = await makeApp().request("/api/audit-log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ actor: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.actor).toBe("***");
    }
  });

  test("ON + global hash rule: actor returns 12-hex digest", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "hash" },
      { scope: "global", fieldPath: "actor", action: "hash" },
    ]);

    const res = await makeApp().request("/api/audit-log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ actor: string }> };
    for (const entry of body.entries) {
      expect(entry.actor).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test("ON + global hide rule: actor field is omitted from response", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "__enabled__", action: "hide" },
      { scope: "global", fieldPath: "actor", action: "hide" },
    ]);

    const res = await makeApp().request("/api/audit-log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    for (const entry of body.entries) {
      expect("actor" in entry).toBe(false);
    }
  });
});
