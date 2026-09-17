import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, createPgDb, type PgDb } from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { auditLogViewerRole, createAuditLogRoutes } from "./audit-log";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("Audit log routes", () => {
  let db: PgDb;

  function makeApp(
    role: string,
    options: {
      authz?: AuthzService;
      principalRole?: string | null;
      principalUserId?: string | null;
    } = {},
  ) {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("user" as never, { sub: "x", role, email: "x@test" });
      const principalUserId =
        options.principalUserId === undefined ? "audit-test-user" : options.principalUserId;
      if (principalUserId) {
        c.set("principal" as never, {
          sub: "x",
          role: options.principalRole === undefined ? role : options.principalRole,
          email: "x@test",
          userId: principalUserId,
          orgId: null,
          orgIds: [],
          memberships: [],
        });
      }
      await next();
    });
    app.route("/api", createAuditLogRoutes(db, { authz: options.authz }));
    return app;
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await db.insert(auditLog).values({
      actor: "audit-test-actor",
      action: "test_action",
      target: "test_target",
    });
  });

  afterAll(async () => {
    const { eq } = await import("drizzle-orm");
    await db.delete(auditLog).where(eq(auditLog.actor, "audit-test-actor"));
  });

  test("rejects regular user", async () => {
    const res = await makeApp("user").request("/api/audit-log");
    expect(res.status).toBe(403);
  });

  test("platform_admin can read entries", async () => {
    const res = await makeApp("platform_admin").request("/api/audit-log?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ actor: string }> };
    expect(body.entries).toBeInstanceOf(Array);
    expect(body.entries.some((e) => e.actor === "audit-test-actor")).toBe(true);
  });

  test("super_admin also allowed", async () => {
    const res = await makeApp("super_admin").request("/api/audit-log");
    expect(res.status).toBe(200);
  });

  test("operator can read entries through platform view permission", async () => {
    const res = await makeApp("operator").request("/api/audit-log");
    expect(res.status).toBe(200);
  });

  test("SpiceDB platform#view can authorize a non-platform bound user", async () => {
    const calls: Array<AuthzCheck & { localAllowed: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck) => {
        calls.push(check as AuthzCheck & { localAllowed: boolean });
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", { authz, principalUserId: "audit-viewer-1" }).request(
      "/api/audit-log",
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "audit-viewer-1",
        actorEmail: "x@test",
        resource: { type: "platform", id: "root" },
        permission: "audit_read",
        subject: { type: "user", id: "audit-viewer-1" },
        context: { localAllowed: false, source: "audit-log" },
        localAllowed: false,
      },
    ]);
  });

  test("does not trust JWT platform_admin without a bound principal", async () => {
    const res = await makeApp("platform_admin", { principalUserId: null }).request(
      "/api/audit-log",
    );
    expect(res.status).toBe(403);
  });

  test("desensitization viewer role prefers the bound Server role over stale JWT role", () => {
    expect(
      auditLogViewerRole(
        { role: "platform_admin" },
        {
          role: "user",
        },
      ),
    ).toBe("user");
  });

  test("desensitization viewer role does not trust JWT role without a bound principal", () => {
    expect(auditLogViewerRole({ role: "platform_admin" }, undefined)).toBe("guest");
  });
});
