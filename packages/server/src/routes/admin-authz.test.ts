import { describe, expect, test } from "bun:test";
import {
  auditLog,
  authzOutbox,
  authzShadowDiffs,
  type PgDb,
  userCapabilities,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService, AuthzTuple } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminAuthzRoutes } from "./admin-authz";

function createMockAuthzLookupRows<T extends object = { orgId: string }>(
  rows: T[] = [],
): {
  from: (source?: unknown) => unknown;
} {
  const withLimit = async (_limit?: number) => rows;
  const rowsWithChain = rows as Array<T> & {
    where: (clause?: unknown) => Array<T>;
    innerJoin: (table?: unknown) => { where: (clause?: unknown) => Array<T> };
    orderBy: (clause?: unknown) => { limit: (limit?: number) => Promise<T[]> };
    limit: (limit?: number) => Promise<T[]>;
  };
  rowsWithChain.where = () => rowsWithChain;
  rowsWithChain.innerJoin = () => ({ where: () => rowsWithChain });
  rowsWithChain.orderBy = () => ({ limit: withLimit });
  rowsWithChain.limit = withLimit;
  return {
    from: () => rowsWithChain,
  };
}

function fakeDb(): { db: PgDb; audits: Record<string, unknown>[] } {
  const audits: Record<string, unknown>[] = [];
  const selectRows = createMockAuthzLookupRows();
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        audits.push(row);
      },
    }),
    select: () => selectRows,
  } as unknown as PgDb;
  return { db, audits };
}

function fakeReadinessDb(counts: number[]): PgDb {
  return {
    select: () => ({
      from: () => {
        const row = { count: counts.shift() ?? 0 };
        return createMockAuthzLookupRows([row]).from();
      },
    }),
  } as unknown as PgDb;
}

function fakeEmptyRebuildDb(audits: Record<string, unknown>[] = []): PgDb {
  const selectRows = createMockAuthzLookupRows();
  return {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        audits.push(row);
      },
    }),
    select: () => selectRows,
  } as unknown as PgDb;
}

function fakeOutboxRetryDb(
  row: Record<string, unknown> | null,
  captures: Record<string, unknown>[],
): PgDb {
  const rowIfAny = row ? [row] : [];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rowIfAny,
          orderBy: () => ({ limit: async () => rowIfAny }),
        }),
        orderBy: () => ({ limit: async () => rowIfAny }),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            captures.push({ operation: "update", value });
            if (row?.status !== "dead") return [];
            return [{ ...row, ...value }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        captures.push({ operation: "insert", value });
      },
    }),
  } as unknown as PgDb;
}

function fakeShadowDiffClearDb(count: number, captures: DbCapture[]): PgDb {
  const selectRows = createMockAuthzLookupRows();
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === authzShadowDiffs) return [{ count }];
        return selectRows;
      },
    }),
    delete: (table: unknown) => {
      captures.push({ operation: "delete", table, inTransaction: false });
      return Promise.resolve();
    },
    insert: (table: unknown) => ({
      values: async (value: unknown) => {
        captures.push({ operation: "insert", table, value, inTransaction: false });
      },
    }),
  } as unknown as PgDb;
}

interface DbCapture {
  operation: "insert" | "delete";
  table: unknown;
  value?: unknown;
  inTransaction: boolean;
}

function fakeMembershipDb(captures: DbCapture[]): PgDb {
  let inTransaction = false;
  const selectRows = createMockAuthzLookupRows();
  const makeDb = (): Record<string, unknown> => ({
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        captures.push({ operation: "insert", table, value, inTransaction });
        return {
          onConflictDoUpdate: async () => undefined,
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        captures.push({ operation: "delete", table, inTransaction });
      },
    }),
    select: () => selectRows,
    transaction: async <T>(callback: (tx: Record<string, unknown>) => Promise<T>) => {
      inTransaction = true;
      try {
        return await callback(makeDb());
      } finally {
        inTransaction = false;
      }
    },
  });
  return makeDb() as unknown as PgDb;
}

function fakeAuditCapabilityDb(userId: string, captures: DbCapture[]): PgDb {
  let inTransaction = false;
  let granted = false;
  const chainRows = <T extends object>(rows: T[]) => {
    const chain = rows as T[] & {
      limit: () => Promise<T[]>;
      orderBy: () => unknown;
      where: () => unknown;
    };
    chain.limit = async () => rows;
    chain.orderBy = () => chain;
    chain.where = () => chain;
    return chain;
  };
  const makeDb = (): Record<string, unknown> => ({
    select: () => ({
      from: (table: unknown) => {
        if (table === users) {
          return chainRows([{ id: userId, email: "auditor@example.test", role: "user" }]);
        }
        if (table === userCapabilities) {
          return chainRows(
            granted
              ? [
                  {
                    userId,
                    grantedBy: "00000000-0000-4000-8000-00000000a001",
                    grantedAt: new Date(),
                  },
                ]
              : [],
          );
        }
        return chainRows([]);
      },
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        captures.push({ operation: "insert", table, value, inTransaction });
        if (table === userCapabilities) {
          return {
            onConflictDoNothing: () => ({
              returning: async () => {
                if (granted) return [];
                granted = true;
                return [{ id: "00000000-0000-4000-8000-00000000c001" }];
              },
            }),
          };
        }
        return Promise.resolve();
      },
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: async () => {
          captures.push({ operation: "delete", table, inTransaction });
          if (!granted) return [];
          granted = false;
          return [{ id: "00000000-0000-4000-8000-00000000c001" }];
        },
      }),
    }),
    transaction: async <T>(callback: (tx: Record<string, unknown>) => Promise<T>) => {
      inTransaction = true;
      try {
        return await callback(makeDb());
      } finally {
        inTransaction = false;
      }
    },
  });
  return makeDb() as unknown as PgDb;
}

function fakeAuthz(input?: { health?: Awaited<ReturnType<AuthzService["health"]>> }): {
  authz: AuthzService;
  tuples: AuthzTuple[];
  replacements: AuthzTuple[][];
  checks: unknown[];
  requireChecks: Array<{ check: unknown; isPlatformAdmin: boolean }>;
  processCalls: Array<{ batchSize: number; forcePending: boolean }>;
} {
  const tuples: AuthzTuple[] = [];
  const replacements: AuthzTuple[][] = [];
  const checks: unknown[] = [];
  const requireChecks: Array<{ check: unknown; isPlatformAdmin: boolean }> = [];
  const processCalls: Array<{ batchSize: number; forcePending: boolean }> = [];
  const authz = {
    mode: input?.health?.mode ?? "off",
    health: async () =>
      input?.health ?? {
        mode: "shadow",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    enqueue: async (tuple: AuthzTuple) => {
      tuples.push(tuple);
    },
    replaceAllRelationships: async (replacementTuples: AuthzTuple[]) => {
      replacements.push(replacementTuples);
      return {
        purgedResourceTypes: ["platform", "organization"],
        tupleCount: replacementTuples.length,
      };
    },
    shadowCheck: async (check: unknown) => {
      checks.push(check);
      return true;
    },
    requirePermission: async (check: unknown, isPlatformAdmin: boolean) => {
      requireChecks.push({ check, isPlatformAdmin });
    },
    processOutbox: async (batchSize: number, options?: { forcePending?: boolean }) => {
      processCalls.push({ batchSize, forcePending: options?.forcePending ?? false });
      return { processed: 3, dead: 1 };
    },
  } as unknown as AuthzService;
  return { authz, tuples, replacements, checks, requireChecks, processCalls };
}

function makeApp(input: {
  db: PgDb;
  authz: AuthzService;
  rawTupleAdminEnabled: boolean;
  role?: string;
  jwtSub?: string;
  principalUserId?: string | null;
}): Hono {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const role = input.role ?? "platform_admin";
    const sub = input.jwtSub ?? `${role}@authz.test`;
    const userId =
      input.principalUserId === undefined
        ? "00000000-0000-4000-8000-00000000a001"
        : input.principalUserId;
    c.set("user" as never, { sub, role, email: `${role}@authz.test` });
    if (userId !== null) {
      c.set("principal" as never, {
        sub,
        email: `${role}@authz.test`,
        role,
        userId,
        orgId: null,
        orgIds: [],
        memberships: [],
        platformRelations: role === "platform_admin" ? ["admin"] : [],
      });
    }
    await next();
  });
  app.route(
    "/api",
    createAdminAuthzRoutes(input.db, {
      authz: input.authz,
      rawTupleAdminEnabled: input.rawTupleAdminEnabled,
    }),
  );
  return app;
}

describe("admin authz routes", () => {
  test("admin authz routes check platform#manage in shadow mode", async () => {
    const { authz, checks } = fakeAuthz({
      health: {
        mode: "shadow",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0, 0]),
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/readiness");

    expect(res.status).toBe(200);
    expect(checks).toEqual([
      {
        actorUserId: "00000000-0000-4000-8000-00000000a001",
        actorEmail: "platform_admin@authz.test",
        resource: { type: "platform", id: "root" },
        permission: "manage",
        subject: { type: "user", id: "00000000-0000-4000-8000-00000000a001" },
        context: { localAllowed: true, source: "admin-authz" },
        localAllowed: true,
      },
    ]);
  });

  test("readiness reports enforce-ready when SpiceDB is healthy and queues are clean", async () => {
    const { authz } = fakeAuthz();
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0, 0]),
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/readiness");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { enforceReady: boolean; blockers: string[]; externalSmokeRequired: boolean };
    };
    expect(body.data.enforceReady).toBe(true);
    expect(body.data.blockers).toEqual([]);
    expect(body.data.externalSmokeRequired).toBe(true);
  });

  test("readiness blocks enforce when the SpiceDB schema differs from disk", async () => {
    const { authz } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: false,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0, 0]),
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/readiness");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { enforceReady: boolean; blockers: string[]; schemaMatches: boolean };
    };
    expect(body.data.enforceReady).toBe(false);
    expect(body.data.schemaMatches).toBe(false);
    expect(body.data.blockers).toContain("SpiceDB schema differs from AUTHZ_SCHEMA_PATH");
  });

  test("health reports exact outbox pending, processing, and dead counts", async () => {
    const { authz } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([7, 2, 3]),
      authz,
      rawTupleAdminEnabled: true,
      role: "super_admin",
    }).request("/api/admin/authz/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        outbox: { pending: number; processing: number; dead: number };
        rawTupleAdminEnabled: boolean;
      };
    };
    expect(body.data.outbox).toEqual({ pending: 7, processing: 2, dead: 3 });
    expect(body.data.rawTupleAdminEnabled).toBe(true);
  });

  test("health hides raw tuple availability from platform_admin", async () => {
    const { authz } = fakeAuthz();
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0]),
      authz,
      rawTupleAdminEnabled: true,
      role: "platform_admin",
    }).request("/api/admin/authz/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rawTupleAdminEnabled: boolean } };
    expect(body.data.rawTupleAdminEnabled).toBe(false);
  });

  test("dead authz outbox rows can be retried with canonical audit", async () => {
    const captures: Record<string, unknown>[] = [];
    const { authz } = fakeAuthz();
    const rowId = "00000000-0000-4000-8000-000000000701";
    const actorUserId = "00000000-0000-4000-8000-00000000a077";
    const res = await makeApp({
      db: fakeOutboxRetryDb(
        {
          id: rowId,
          status: "dead",
          attempts: 5,
          lastError: "spicedb unavailable",
        },
        captures,
      ),
      authz,
      rawTupleAdminEnabled: false,
      principalUserId: actorUserId,
    }).request(`/api/admin/authz/outbox/${rowId}/retry`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(captures).toContainEqual({
      operation: "update",
      value: expect.objectContaining({
        status: "pending",
        processedAt: null,
      }),
    });
    const retryUpdate = captures.find((capture) => capture.operation === "update");
    expect(retryUpdate?.value).toMatchObject({ attempts: 0 });
    expect(retryUpdate?.value).not.toHaveProperty("lastError");
    expect(captures).toContainEqual({
      operation: "insert",
      value: expect.objectContaining({
        actor: actorUserId,
        action: "authz.outbox.retry",
        target: `authz_outbox:${rowId}`,
        diff: {
          before: { status: "dead", attempts: 5, lastError: "spicedb unavailable" },
          after: { status: "pending", attempts: 0, lastError: "spicedb unavailable" },
        },
      }),
    });
  });

  test("non-dead authz outbox rows cannot be retried", async () => {
    const captures: Record<string, unknown>[] = [];
    const { authz } = fakeAuthz();
    const rowId = "00000000-0000-4000-8000-000000000702";
    const res = await makeApp({
      db: fakeOutboxRetryDb({ id: rowId, status: "pending", attempts: 1 }, captures),
      authz,
      rawTupleAdminEnabled: false,
    }).request(`/api/admin/authz/outbox/${rowId}/retry`, { method: "POST" });

    expect(res.status).toBe(400);
    expect(captures).toEqual([]);
  });

  test("authz outbox can be processed manually with canonical audit", async () => {
    const { db, audits } = fakeDb();
    const { authz, processCalls } = fakeAuthz();
    const actorUserId = "00000000-0000-4000-8000-00000000a089";
    const res = await makeApp({
      db,
      authz,
      rawTupleAdminEnabled: false,
      jwtSub: "casdoor-process-outbox-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/authz/outbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchSize: 42 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { processed: number; dead: number } };
    expect(body.data).toEqual({ processed: 3, dead: 1 });
    expect(processCalls).toEqual([{ batchSize: 42, forcePending: true }]);
    expect(audits).toContainEqual({
      actor: actorUserId,
      orgId: null,
      action: "authz.outbox.process",
      target: "authz_outbox",
      diff: { after: { batchSize: 42, processed: 3, dead: 1 } },
    });
  });

  test("manual authz outbox processing clamps batch size", async () => {
    const { db, audits } = fakeDb();
    const { authz, processCalls } = fakeAuthz();
    const res = await makeApp({
      db,
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/outbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchSize: 501 }),
    });

    expect(res.status).toBe(400);
    expect(processCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("reviewed shadow diffs can be cleared with canonical audit", async () => {
    const captures: DbCapture[] = [];
    const { authz } = fakeAuthz();
    const actorUserId = "00000000-0000-4000-8000-00000000a088";
    const res = await makeApp({
      db: fakeShadowDiffClearDb(4, captures),
      authz,
      rawTupleAdminEnabled: false,
      jwtSub: "casdoor-shadow-clear-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/authz/shadow-diffs/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm: "I reviewed and accept clearing authorization shadow diffs",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cleared: number } };
    expect(body.data.cleared).toBe(4);
    expect(captures).toContainEqual({
      operation: "delete",
      table: authzShadowDiffs,
      inTransaction: false,
    });
    expect(captures).toContainEqual({
      operation: "insert",
      table: auditLog,
      value: expect.objectContaining({
        actor: actorUserId,
        action: "authz.shadow_diff.clear",
        target: "authz_shadow_diffs",
        diff: { before: { count: 4 }, after: { count: 0 } },
      }),
      inTransaction: false,
    });
  });

  test("shadow diff clear requires explicit confirmation", async () => {
    const captures: DbCapture[] = [];
    const { authz } = fakeAuthz();
    const res = await makeApp({
      db: fakeShadowDiffClearDb(4, captures),
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/shadow-diffs/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "clear" }),
    });

    expect(res.status).toBe(400);
    expect(captures).toEqual([]);
  });

  test("rebuild replaces managed SpiceDB relationships instead of enqueueing stale-preserving touches", async () => {
    const { authz, replacements, tuples } = fakeAuthz();
    const audits: Record<string, unknown>[] = [];
    const actorUserId = "00000000-0000-4000-8000-00000000a099";
    const res = await makeApp({
      db: fakeEmptyRebuildDb(audits),
      authz,
      rawTupleAdminEnabled: false,
      jwtSub: "casdoor-rebuild-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/authz/rebuild", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tupleCount: number; purgedResourceTypes: string[]; counts: Record<string, number> };
    };
    expect(replacements).toEqual([[]]);
    expect(tuples).toEqual([]);
    expect(body.data).toEqual({
      tupleCount: 0,
      purgedResourceTypes: ["platform", "organization"],
      counts: {},
    });
    expect(audits).toContainEqual({
      actor: actorUserId,
      orgId: null,
      action: "authz.rebuild",
      target: "spicedb:relationships",
      diff: {
        after: {
          tupleCount: 0,
          purgedResourceTypes: ["platform", "organization"],
          counts: {},
        },
      },
    });
  });

  test("SpiceDB platform#manage can authorize a non-platform bound user", async () => {
    const { authz, requireChecks } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0, 0]),
      authz,
      rawTupleAdminEnabled: false,
      role: "user",
      principalUserId: "00000000-0000-4000-8000-00000000a002",
    }).request("/api/admin/authz/readiness");

    expect(res.status).toBe(200);
    expect(requireChecks).toEqual([
      {
        check: {
          actorUserId: "00000000-0000-4000-8000-00000000a002",
          actorEmail: "user@authz.test",
          resource: { type: "platform", id: "root" },
          permission: "manage",
          subject: { type: "user", id: "00000000-0000-4000-8000-00000000a002" },
          context: { localAllowed: false, source: "admin-authz" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("admin authz routes do not trust JWT platform_admin without a bound principal", async () => {
    const { authz, requireChecks } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([0, 0, 0, 0]),
      authz,
      rawTupleAdminEnabled: false,
      role: "platform_admin",
      principalUserId: null,
    }).request("/api/admin/authz/readiness");

    expect(res.status).toBe(403);
    expect(requireChecks).toEqual([]);
  });

  test("membership upsert writes membership, outbox rows, and canonical audit", async () => {
    const captures: DbCapture[] = [];
    const { authz, tuples } = fakeAuthz();
    const actorUserId = "00000000-0000-4000-8000-00000000a001";
    const res = await makeApp({
      db: fakeMembershipDb(captures),
      authz,
      rawTupleAdminEnabled: false,
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/authz/memberships", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000101",
        orgId: "00000000-0000-4000-8000-000000000201",
        role: "admin",
      }),
    });

    expect(res.status).toBe(200);
    expect(tuples).toHaveLength(0);
    expect(captures).toContainEqual({
      operation: "insert",
      table: userOrgMemberships,
      value: {
        userId: "00000000-0000-4000-8000-000000000101",
        orgId: "00000000-0000-4000-8000-000000000201",
        role: "admin",
      },
      inTransaction: true,
    });
    const outbox = captures.find((capture) => capture.table === authzOutbox);
    expect(outbox?.inTransaction).toBe(true);
    expect(outbox?.value).toHaveLength(8);
    expect(outbox?.value).toContainEqual(
      expect.objectContaining({
        operation: "create",
        resourceType: "organization",
        resourceId: "00000000-0000-4000-8000-000000000201",
        relation: "platform",
        subjectType: "platform",
        subjectId: "root",
      }),
    );
    expect(outbox?.value).toContainEqual(
      expect.objectContaining({
        operation: "create",
        resourceType: "provider",
        resourceId: "00000000-0000-4000-8000-000000000201",
        relation: "org",
        subjectType: "organization",
        subjectId: "00000000-0000-4000-8000-000000000201",
      }),
    );
    expect(outbox?.value).toContainEqual(
      expect.objectContaining({
        operation: "create",
        resourceType: "provider",
        resourceId: "00000000-0000-4000-8000-000000000201",
        relation: "platform",
        subjectType: "platform",
        subjectId: "root",
      }),
    );
    const audit = captures.find((capture) => capture.table === auditLog);
    expect(audit?.inTransaction).toBe(false);
    expect(audit?.value).toMatchObject({
      actor: actorUserId,
      action: "authz.membership.upsert",
      target:
        "organization:00000000-0000-4000-8000-000000000201#admin@user:00000000-0000-4000-8000-000000000101",
    });
  });

  test("membership delete writes delete, outbox rows, and canonical audit", async () => {
    const captures: DbCapture[] = [];
    const { authz, tuples } = fakeAuthz();
    const actorUserId = "00000000-0000-4000-8000-00000000a001";
    const res = await makeApp({
      db: fakeMembershipDb(captures),
      authz,
      rawTupleAdminEnabled: false,
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request(
      "/api/admin/authz/memberships/00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201",
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(tuples).toHaveLength(0);
    expect(captures).toContainEqual({
      operation: "delete",
      table: userOrgMemberships,
      inTransaction: true,
    });
    const outbox = captures.find((capture) => capture.table === authzOutbox);
    expect(outbox?.inTransaction).toBe(true);
    expect(outbox?.value).toHaveLength(5);
    const audit = captures.find((capture) => capture.table === auditLog);
    expect(audit?.inTransaction).toBe(false);
    expect(audit?.value).toMatchObject({
      actor: actorUserId,
      action: "authz.membership.delete",
      target:
        "organization:00000000-0000-4000-8000-000000000201#membership@user:00000000-0000-4000-8000-000000000101",
    });
  });

  test("audit capability grant, read, revoke, and enforce refresh form a governance loop", async () => {
    const captures: DbCapture[] = [];
    const targetUserId = "00000000-0000-4000-8000-000000000301";
    const { authz, processCalls } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const app = makeApp({
      db: fakeAuditCapabilityDb(targetUserId, captures),
      authz,
      rawTupleAdminEnabled: false,
    });

    const initial = await app.request("/api/admin/authz/audit-capabilities");
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      data: Array<{ auditReadonly: boolean }>;
    };
    expect(initialBody.data[0]?.auditReadonly).toBe(false);

    const granted = await app.request(`/api/admin/authz/audit-capabilities/${targetUserId}`, {
      method: "PUT",
    });
    expect(granted.status).toBe(200);
    const grantedBody = (await granted.json()) as { data: { changed: boolean } };
    expect(grantedBody.data.changed).toBe(true);

    const afterGrant = await app.request("/api/admin/authz/audit-capabilities");
    const afterGrantBody = (await afterGrant.json()) as {
      data: Array<{ auditReadonly: boolean }>;
    };
    expect(afterGrantBody.data[0]?.auditReadonly).toBe(true);

    const revoked = await app.request(`/api/admin/authz/audit-capabilities/${targetUserId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as { data: { changed: boolean } };
    expect(revokedBody.data.changed).toBe(true);

    const afterRevoke = await app.request("/api/admin/authz/audit-capabilities");
    const afterRevokeBody = (await afterRevoke.json()) as {
      data: Array<{ auditReadonly: boolean }>;
    };
    expect(afterRevokeBody.data[0]?.auditReadonly).toBe(false);
    expect(processCalls).toEqual([
      { batchSize: 100, forcePending: true },
      { batchSize: 100, forcePending: true },
    ]);
    expect(
      captures.filter((capture) => capture.table === authzOutbox && capture.inTransaction),
    ).toHaveLength(2);
    expect(
      captures.filter((capture) => capture.table === auditLog && capture.inTransaction),
    ).toHaveLength(2);
  });

  test("non-platform roles cannot manage audit capabilities even when SpiceDB manage allows", async () => {
    const captures: DbCapture[] = [];
    const targetUserId = "00000000-0000-4000-8000-000000000302";
    const { authz } = fakeAuthz({
      health: {
        mode: "enforce",
        configured: true,
        healthy: true,
        schemaWritten: true,
        schemaMatches: true,
        error: null,
      },
    });
    const res = await makeApp({
      db: fakeAuditCapabilityDb(targetUserId, captures),
      authz,
      rawTupleAdminEnabled: false,
      role: "user",
    }).request(`/api/admin/authz/audit-capabilities/${targetUserId}`, {
      method: "PUT",
    });

    expect(res.status).toBe(403);
    expect(captures).toEqual([]);
  });

  test("readiness reports blockers for dirty shadow state", async () => {
    const { authz } = fakeAuthz({
      health: {
        mode: "shadow",
        configured: true,
        healthy: false,
        schemaWritten: false,
        schemaMatches: false,
        error: "connection refused",
      },
    });
    const res = await makeApp({
      db: fakeReadinessDb([2, 1, 3, 4]),
      authz,
      rawTupleAdminEnabled: false,
    }).request("/api/admin/authz/readiness");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enforceReady: boolean; blockers: string[] } };
    expect(body.data.enforceReady).toBe(false);
    expect(body.data.blockers).toContain("connection refused");
    expect(body.data.blockers).toContain("SpiceDB schema has not been written by this Server");
    expect(body.data.blockers).toContain("2 authz outbox rows are pending");
    expect(body.data.blockers).toContain("1 authz outbox rows are still processing");
    expect(body.data.blockers).toContain("3 authz outbox rows are dead-lettered");
    expect(body.data.blockers).toContain("4 shadow authorization diffs remain");
  });

  test("raw tuple break-glass writes canonical Server user id before enqueueing tuple", async () => {
    const { db, audits } = fakeDb();
    const { authz, tuples } = fakeAuthz();
    const actorUserId = "00000000-0000-4000-8000-00000000b001";
    const res = await makeApp({
      db,
      authz,
      rawTupleAdminEnabled: true,
      role: "super_admin",
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/authz/raw-tuples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "create",
        resource: { type: "queue", id: "q-1" },
        relation: "submitter",
        subject: { type: "user", id: "u-1" },
        confirm: "I understand this bypasses Server business constraints",
      }),
    });
    expect(res.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(actorUserId);
    expect(audits[0]?.action).toBe("authz.raw_tuple.break_glass");
    expect(audits[0]?.target).toBe("queue:q-1#submitter");
    expect(JSON.stringify(audits[0]?.diff)).toContain("u-1");
    expect(tuples).toEqual([
      {
        operation: "create",
        resource: { type: "queue", id: "q-1" },
        relation: "submitter",
        subject: { type: "user", id: "u-1" },
        payload: { breakGlass: true, actor: actorUserId },
      },
    ]);
  });

  test("raw tuple break-glass fails closed without a canonical Server user id", async () => {
    const { db, audits } = fakeDb();
    const { authz, tuples } = fakeAuthz();
    const res = await makeApp({
      db,
      authz,
      rawTupleAdminEnabled: true,
      role: "super_admin",
      principalUserId: null,
    }).request("/api/admin/authz/raw-tuples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "create",
        resource: { type: "queue", id: "q-1" },
        relation: "submitter",
        subject: { type: "user", id: "u-1" },
        confirm: "I understand this bypasses Server business constraints",
      }),
    });

    expect(res.status).toBe(403);
    expect(audits).toHaveLength(0);
    expect(tuples).toHaveLength(0);
  });

  test("raw tuple break-glass rejects platform_admin even when enabled", async () => {
    const { db, audits } = fakeDb();
    const { authz, tuples } = fakeAuthz();
    const res = await makeApp({
      db,
      authz,
      rawTupleAdminEnabled: true,
      role: "platform_admin",
    }).request("/api/admin/authz/raw-tuples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "create",
        resource: { type: "queue", id: "q-1" },
        relation: "submitter",
        subject: { type: "user", id: "u-1" },
        confirm: "I understand this bypasses Server business constraints",
      }),
    });

    expect(res.status).toBe(403);
    expect(audits).toHaveLength(0);
    expect(tuples).toHaveLength(0);
  });

  test("raw tuple break-glass is disabled by default", async () => {
    const { db, audits } = fakeDb();
    const { authz, tuples } = fakeAuthz();
    const res = await makeApp({ db, authz, rawTupleAdminEnabled: false }).request(
      "/api/admin/authz/raw-tuples",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "delete",
          resource: { type: "queue", id: "q-1" },
          relation: "submitter",
          subject: { type: "user", id: "u-1" },
          confirm: "I understand this bypasses Server business constraints",
        }),
      },
    );
    expect(res.status).toBe(403);
    expect(audits).toHaveLength(0);
    expect(tuples).toHaveLength(0);
  });
});
