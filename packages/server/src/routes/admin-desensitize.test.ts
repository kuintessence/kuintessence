/**
 * admin alias-export endpoint integration tests (PRD F22.15).
 *
 * Verifies:
 *   1. Only platform_admin (or higher) can call the endpoint.
 *   2. Existing aliases resolve to their original values.
 *   3. Unknown aliases are reported as not-found in the body but the
 *      request still returns 200 (partial export is OK).
 *   4. The response is a JWT signed with the dedicated short-TTL key,
 *      NOT the regular Server JWT secret.
 *   5. An audit-log row is written with who/when/which aliases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  auditLog,
  createPgDb,
  desensitizeAliasMap,
  desensitizeConfig,
  type PgDb,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import * as jose from "jose";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminDesensitizeRoutes } from "./admin-desensitize";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const EXPORT_KEY = "test-export-key-32-chars-min-len-required-for-jose";
const ALIAS_A = "b5alias-export-aaa1";
const ALIAS_B = "b5alias-export-bbb2";
const TEST_ALIASES = [ALIAS_A, ALIAS_B];
const TEST_AUDIT_ACTORS = [
  "platform_admin-desensitize-user",
  "00000000-0000-4000-8000-00000000d001",
  "00000000-0000-4000-8000-00000000d002",
  "00000000-0000-4000-8000-00000000d003",
  "00000000-0000-4000-8000-00000000d004",
  "desensitize-user-1",
];

describe("Admin desensitize export route", () => {
  let db: PgDb;
  let originalConfigRows: Array<typeof desensitizeConfig.$inferSelect> = [];

  function makeApp(
    role: string,
    options: {
      authz?: AuthzService;
      jwtSub?: string;
      principalRole?: string | null;
      principalUserId?: string | null;
      exportKey?: string | null;
    } = {},
  ) {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      const sub = options.jwtSub ?? `${role}@kuintessence.test`;
      c.set("user" as never, {
        sub,
        role,
        email: `${role}@kuintessence.test`,
      });
      const principalUserId =
        options.principalUserId === undefined
          ? `${role}-desensitize-user`
          : options.principalUserId;
      if (principalUserId) {
        c.set("principal" as never, {
          sub,
          role: options.principalRole === undefined ? role : options.principalRole,
          email: `${role}@kuintessence.test`,
          userId: principalUserId,
          orgId: null,
          orgIds: [],
          memberships: [],
        });
      }
      await next();
    });
    app.route(
      "/api",
      createAdminDesensitizeRoutes(db, {
        exportKey: options.exportKey === null ? undefined : EXPORT_KEY,
        ttlSec: 600,
        authz: options.authz,
      }),
    );
    return app;
  }

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    originalConfigRows = await db.select().from(desensitizeConfig);
    await db
      .insert(desensitizeAliasMap)
      .values([
        {
          aliasId: ALIAS_A,
          salt: "kq-export-test",
          originalValue: "alice@example.com",
        },
        {
          aliasId: ALIAS_B,
          salt: "kq-export-test",
          originalValue: "bob@example.com",
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(desensitizeAliasMap).where(inArray(desensitizeAliasMap.aliasId, TEST_ALIASES));
    await db.delete(desensitizeConfig);
    if (originalConfigRows.length > 0)
      await db.insert(desensitizeConfig).values(originalConfigRows);
    await db
      .delete(auditLog)
      .where(
        and(
          inArray(auditLog.action, ["desensitize.export", "desensitize.config.update"]),
          inArray(auditLog.actor, TEST_AUDIT_ACTORS),
        ),
      );
  });

  test("platform_admin can read and atomically replace desensitization config", async () => {
    const app = makeApp("platform_admin");
    const initial = await app.request("/api/admin/desensitize/config");
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { exportEnabled: boolean }).toMatchObject({
      exportEnabled: true,
    });

    const update = await app.request("/api/admin/desensitize/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        globalEnabled: true,
        rules: [
          { scope: "global", scopeId: null, fieldPath: "actor", action: "alias" },
          {
            scope: "provider",
            scopeId: "provider-test",
            fieldPath: "diff",
            action: "redact",
          },
        ],
      }),
    });

    expect(update.status).toBe(200);
    const body = (await update.json()) as {
      globalEnabled: boolean;
      rules: Array<{ fieldPath: string }>;
    };
    expect(body.globalEnabled).toBe(true);
    expect(body.rules.map((rule) => rule.fieldPath)).toEqual(["actor", "diff"]);

    const rows = await db.select().from(desensitizeConfig);
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.fieldPath === "__enabled__")).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "desensitize.config.update"),
          eq(auditLog.actor, "platform_admin-desensitize-user"),
        ),
      );
    expect(audit?.actor).toBe("platform_admin-desensitize-user");
  });

  test("config remains manageable when alias export is not configured", async () => {
    const app = makeApp("platform_admin", { exportKey: null });
    const config = await app.request("/api/admin/desensitize/config");
    expect(config.status).toBe(200);
    expect((await config.json()) as { exportEnabled: boolean }).toMatchObject({
      exportEnabled: false,
    });
    const exported = await app.request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: [ALIAS_A] }),
    });
    expect(exported.status).toBe(404);
  });

  test("config management rejects regular users and ambiguous rules", async () => {
    expect((await makeApp("user").request("/api/admin/desensitize/config")).status).toBe(403);
    const response = await makeApp("platform_admin").request("/api/admin/desensitize/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        globalEnabled: true,
        rules: [
          { scope: "global", scopeId: null, fieldPath: "actor", action: "alias" },
          { scope: "global", scopeId: null, fieldPath: "actor", action: "redact" },
        ],
      }),
    });
    expect(response.status).toBe(400);
  });

  test("concurrent config replacements leave one complete payload and a coherent audit chain", async () => {
    const firstActor = "00000000-0000-4000-8000-00000000d003";
    const secondActor = "00000000-0000-4000-8000-00000000d004";
    const payload = (fieldPath: string) => ({
      globalEnabled: true,
      rules: [{ scope: "global", scopeId: null, fieldPath, action: "alias" }],
    });
    const request = (actor: string, fieldPath: string) =>
      makeApp("platform_admin", { principalUserId: actor }).request(
        "/api/admin/desensitize/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload(fieldPath)),
        },
      );

    const responses = await Promise.all([
      request(firstActor, "concurrent-first"),
      request(secondActor, "concurrent-second"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const finalRows = (await db.select().from(desensitizeConfig)).filter(
      (row) => row.fieldPath !== "__enabled__",
    );
    expect(finalRows).toHaveLength(1);
    const finalField = finalRows[0]?.fieldPath;
    if (!finalField) throw new Error("Concurrent replacement did not persist a rule");
    expect(["concurrent-first", "concurrent-second"]).toContain(finalField);

    const audits = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.actor, [firstActor, secondActor]));
    expect(audits).toHaveLength(2);
    const finalAudit = audits.find((entry) => {
      const diff = entry.diff as { after?: { rules?: Array<{ fieldPath?: string }> } } | null;
      return diff?.after?.rules?.[0]?.fieldPath === finalField;
    });
    const previousAudit = audits.find((entry) => entry.id !== finalAudit?.id);
    const finalDiff = finalAudit?.diff as {
      before?: { rules?: Array<{ fieldPath?: string }> };
    } | null;
    const previousDiff = previousAudit?.diff as {
      after?: { rules?: Array<{ fieldPath?: string }> };
    } | null;
    expect(finalDiff?.before?.rules?.[0]?.fieldPath).toBe(
      previousDiff?.after?.rules?.[0]?.fieldPath,
    );
  });

  test("rejects regular user with 403", async () => {
    const res = await makeApp("user").request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: TEST_ALIASES }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects org_admin with 403 (platform_admin gate)", async () => {
    const res = await makeApp("org_admin").request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: TEST_ALIASES }),
    });
    expect(res.status).toBe(403);
  });

  test("validates body — empty aliasIds array → 400", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("platform_admin gets a signed JWT containing all requested aliases", async () => {
    const actorUserId = "00000000-0000-4000-8000-00000000d001";
    const res = await makeApp("platform_admin", {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: TEST_ALIASES }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number };
    expect(typeof body.token).toBe("string");
    expect(body.expiresIn).toBe(600);

    // Verify with the dedicated export key (NOT the regular Server JWT secret).
    const { payload } = await jose.jwtVerify(body.token, new TextEncoder().encode(EXPORT_KEY));
    expect(payload.purpose).toBe("desensitize-alias-export");
    expect(payload.requestedBy).toBe(actorUserId);
    const records = payload.records as Array<{ aliasId: string; originalValue: string | null }>;
    expect(records).toHaveLength(2);
    const alice = records.find((r) => r.aliasId === ALIAS_A);
    const bob = records.find((r) => r.aliasId === ALIAS_B);
    expect(alice?.originalValue).toBe("alice@example.com");
    expect(bob?.originalValue).toBe("bob@example.com");
  });

  test("SpiceDB platform#manage can authorize a non-platform bound user", async () => {
    const calls: Array<AuthzCheck & { localAllowed: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck) => {
        calls.push(check as AuthzCheck & { localAllowed: boolean });
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", {
      authz,
      principalUserId: "desensitize-user-1",
    }).request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: [ALIAS_A] }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "desensitize-user-1",
        actorEmail: "user@kuintessence.test",
        resource: { type: "platform", id: "root" },
        permission: "manage",
        subject: { type: "user", id: "desensitize-user-1" },
        context: { localAllowed: false, source: "admin-desensitize" },
        localAllowed: false,
      },
    ]);
  });

  test("SpiceDB denial prevents alias export", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;

    const res = await makeApp("platform_admin", { authz }).request(
      "/api/admin/desensitize/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliasIds: [ALIAS_A] }),
      },
    );

    expect(res.status).toBe(403);
  });

  test("does not trust JWT platform_admin without a bound principal", async () => {
    const res = await makeApp("platform_admin", { principalUserId: null }).request(
      "/api/admin/desensitize/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliasIds: [ALIAS_A] }),
      },
    );

    expect(res.status).toBe(403);
  });

  test("token is NOT verifiable with a different key", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: TEST_ALIASES }),
    });
    const body = (await res.json()) as { token: string };
    await expect(
      jose.jwtVerify(body.token, new TextEncoder().encode("wrong-key-must-be-32-chars-len-here!")),
    ).rejects.toThrow();
  });

  test("unknown aliasIds return originalValue=null (partial export OK)", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: ["b5alias-export-nonexistent"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const { payload } = await jose.jwtVerify(body.token, new TextEncoder().encode(EXPORT_KEY));
    const records = payload.records as Array<{ aliasId: string; originalValue: string | null }>;
    expect(records[0]?.originalValue).toBeNull();
  });

  test("writes a canonical audit-log actor with action=desensitize.export", async () => {
    const actorUserId = "00000000-0000-4000-8000-00000000d002";
    await makeApp("platform_admin", {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/desensitize/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliasIds: TEST_ALIASES }),
    });

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "desensitize.export"));
    expect(entries.length).toBeGreaterThan(0);
    const latest = entries[entries.length - 1];
    expect(latest?.actor).toBe(actorUserId);
    const diff = latest?.diff as { after?: { aliasIds?: string[] } } | null;
    expect(Array.isArray(diff?.after?.aliasIds)).toBe(true);
    expect(diff?.after?.aliasIds).toEqual(TEST_ALIASES);
  });
});
