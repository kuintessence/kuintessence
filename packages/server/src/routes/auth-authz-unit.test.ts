import { describe, expect, test } from "bun:test";
import {
  authzOutbox,
  orgs,
  type PgDb,
  ssoConfig,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { verifyToken } from "../services/auth";
import { createAuthRoutes } from "./auth";

const SECRET = "test-secret-at-least-32-chars-long!!";
const SSO_KEY = "test-sso-wrapping-key-at-least-32-chars!";

interface InsertCapture {
  table: unknown;
  value: unknown;
  inTransaction: boolean;
}

function fakeAuthDb(
  captures: InsertCapture[],
  options: {
    existingUser?: { id: string; role: string };
    existingOrg?: { id: string };
    existingMembership?: { role: string };
  } = {},
): PgDb {
  let inTransaction = false;

  const makeDb = (): Record<string, unknown> => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: async () => {
            if (table === userOrgMemberships) {
              return [{ orgId: options.existingOrg?.id ?? "org-authz-seed" }];
            }
            return [];
          },
          limit: async () => {
            if (table === ssoConfig) return [];
            if (table === users) return options.existingUser ? [options.existingUser] : [];
            if (table === orgs) return options.existingOrg ? [options.existingOrg] : [];
            if (table === userOrgMemberships) {
              return options.existingMembership ? [options.existingMembership] : [];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        captures.push({ table, value, inTransaction });
        return {
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (table === users) return [{ id: "user-authz-seed" }];
              return [];
            },
          }),
          returning: async () => {
            if (table === orgs) return [{ id: "org-authz-seed" }];
            return [];
          },
        };
      },
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

describe("auth route authz seed projection", () => {
  test("writes user membership and authz outbox in one transaction", async () => {
    const captures: InsertCapture[] = [];
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.route(
      "/api",
      createAuthRoutes(SECRET, fakeAuthDb(captures), {
        ssoSecretWrappingKey: SSO_KEY,
        authz: { mode: "enforce" } as AuthzService,
      }),
    );

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "seed@example.test", role: "platform_admin" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const principal = await verifyToken(body.token, SECRET);
    expect(principal.orgIds).toEqual(["org-authz-seed"]);
    const transactionalTables = captures
      .filter((capture) => capture.inTransaction)
      .map((capture) => capture.table);
    expect(transactionalTables).toContain(users);
    expect(transactionalTables).toContain(orgs);
    expect(transactionalTables).toContain(userOrgMemberships);
    expect(transactionalTables).toContain(authzOutbox);

    const outboxCapture = captures.find((capture) => capture.table === authzOutbox);
    const outboxRows = outboxCapture?.value as Array<Record<string, unknown>>;
    expect(outboxRows).toHaveLength(12);
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "organization",
      resourceId: "org-authz-seed",
      relation: "platform",
      subjectType: "platform",
      subjectId: "root",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "provider",
      resourceId: "org-authz-seed",
      relation: "org",
      subjectType: "organization",
      subjectId: "org-authz-seed",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "provider",
      resourceId: "org-authz-seed",
      relation: "platform",
      subjectType: "platform",
      subjectId: "root",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "platform",
      resourceId: "root",
      relation: "member",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "platform",
      resourceId: "root",
      relation: "admin",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
  });

  test("projects platform operator during dev auth seed", async () => {
    const captures: InsertCapture[] = [];
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.route(
      "/api",
      createAuthRoutes(SECRET, fakeAuthDb(captures), {
        ssoSecretWrappingKey: SSO_KEY,
        authz: { mode: "enforce" } as AuthzService,
      }),
    );

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "operator@example.test", role: "operator" }),
    });

    expect(res.status).toBe(200);
    const outboxCapture = captures.find((capture) => capture.table === authzOutbox);
    const outboxRows = outboxCapture?.value as Array<Record<string, unknown>>;
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "platform",
      resourceId: "root",
      relation: "operator",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).not.toContainEqual({
      operation: "create",
      resourceType: "platform",
      resourceId: "root",
      relation: "admin",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
  });

  test("re-seeds authz outbox even when the Server user and membership already exist", async () => {
    const captures: InsertCapture[] = [];
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.route(
      "/api",
      createAuthRoutes(
        SECRET,
        fakeAuthDb(captures, {
          existingUser: { id: "user-authz-seed", role: "platform_admin" },
          existingOrg: { id: "org-authz-seed" },
          existingMembership: { role: "admin" },
        }),
        {
          ssoSecretWrappingKey: SSO_KEY,
          authz: { mode: "enforce" } as AuthzService,
        },
      ),
    );

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "seed@example.test", role: "platform_admin" }),
    });

    expect(res.status).toBe(200);
    const outboxCapture = captures.find((capture) => capture.table === authzOutbox);
    const outboxRows = outboxCapture?.value as Array<Record<string, unknown>>;
    expect(outboxRows).toHaveLength(12);
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "platform",
      resourceId: "root",
      relation: "member",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
    expect(outboxRows).toContainEqual({
      operation: "create",
      resourceType: "organization",
      resourceId: "org-authz-seed",
      relation: "admin",
      subjectType: "user",
      subjectId: "user-authz-seed",
      subjectRelation: null,
      payload: {},
    });
  });
});
