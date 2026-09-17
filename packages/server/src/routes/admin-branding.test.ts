import { describe, expect, test } from "bun:test";
import { auditLog, type PgDb } from "@kuintessence/db";
import type { PlatformBranding } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminBrandingRoutes } from "./admin-branding";

const ROUTE_USER_ID = "00000000-0000-4000-8000-00000000b001";
const silent = pino({ level: "silent" });

interface FakeBrandingRow {
  singletonId: string;
  locales: PlatformBranding["locales"];
  logoUrl: string;
  faviconUrl: string;
  updatedAt: Date;
  updatedBy: string | null;
}

interface FakeState {
  row: FakeBrandingRow | null;
  audits: Array<Record<string, unknown>>;
  locks: number;
  selects: number;
}

interface FakeDb {
  select: () => {
    from: (table: unknown) => {
      where: (clause: unknown) => { limit: (count: number) => Promise<FakeBrandingRow[]> };
    };
  };
  insert: (table: unknown) => {
    values: (
      value: Record<string, unknown>,
    ) => Promise<void> | { onConflictDoUpdate: (config: unknown) => Promise<void> };
  };
  execute: (query: unknown) => Promise<void>;
  transaction: <T>(callback: (tx: FakeDb) => Promise<T>) => Promise<T>;
}

function fakeDb(initialRow: FakeBrandingRow | null = null): { db: PgDb; state: FakeState } {
  const state: FakeState = { row: initialRow, audits: [], locks: 0, selects: 0 };

  function makeDb(): FakeDb {
    return {
      select: () => ({
        from: (_table) => ({
          where: (_clause) => ({
            limit: async (_count) => {
              state.selects += 1;
              return state.row ? [state.row] : [];
            },
          }),
        }),
      }),
      insert: (table) => ({
        values: (value) => {
          if (table === auditLog) {
            return Promise.resolve().then(() => {
              state.audits.push(value);
            });
          }
          return {
            onConflictDoUpdate: async (_config) => {
              state.row = {
                singletonId: String(value.singletonId),
                locales: value.locales as PlatformBranding["locales"],
                logoUrl: String(value.logoUrl),
                faviconUrl: String(value.faviconUrl),
                updatedAt: value.updatedAt as Date,
                updatedBy: (value.updatedBy as string | null | undefined) ?? null,
              };
            },
          };
        },
      }),
      execute: async (_query) => {
        state.locks += 1;
      },
      transaction: async <T>(callback: (tx: FakeDb) => Promise<T>) => callback(makeDb()),
    };
  }

  return { db: makeDb() as unknown as PgDb, state };
}

function makeApp(
  role: string,
  db: PgDb,
  options: {
    principalUserId?: string | null;
    authz?: AuthzService;
  } = {},
) {
  const app = new Hono();
  app.onError(createErrorHandler(silent));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: `${role}@branding.test`,
      role,
      email: `${role}@branding.test`,
      userId: options.principalUserId === undefined ? ROUTE_USER_ID : options.principalUserId,
      orgId: null,
      orgIds: [],
      memberships: [],
    });
    await next();
  });
  app.route("/api", createAdminBrandingRoutes(db, { authz: options.authz }));
  return app;
}

const brandingPayload: PlatformBranding = {
  locales: {
    zh: {
      name: "示例算力网",
      title: "登录示例算力网",
      subtitle: "面向科研用户的统一算力入口",
      welcome: "欢迎使用平台",
    },
    en: {
      name: "Example Compute",
      title: "Sign in to Example Compute",
      subtitle: "A unified compute entry point for researchers",
      welcome: "Welcome to the platform",
    },
  },
  logoUrl: "https://assets.example.test/logo.svg",
  faviconUrl: "/branding/favicon.svg",
};

describe("admin platform branding routes", () => {
  test("allows platform viewers to read an empty singleton with safe defaults", async () => {
    const { db, state } = fakeDb();
    const response = await makeApp("operator", db).request("/api/admin/branding");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      locales: {
        zh: { name: "", title: "", subtitle: "", welcome: "" },
        en: { name: "", title: "", subtitle: "", welcome: "" },
      },
      logoUrl: "",
      faviconUrl: "",
      updatedAt: null,
      updatedBy: null,
    });
    expect(state.selects).toBe(1);
  });

  test("rejects non-platform users before reading or writing branding", async () => {
    const { db, state } = fakeDb();
    const getResponse = await makeApp("user", db).request("/api/admin/branding");
    const putResponse = await makeApp("operator", db).request("/api/admin/branding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brandingPayload),
    });

    expect(getResponse.status).toBe(403);
    expect(putResponse.status).toBe(403);
    expect(state.selects).toBe(0);
    expect(state.row).toBeNull();
    expect(state.audits).toHaveLength(0);
  });

  test("persists the canonical actor, serializes a safe view, locks, and audits the change", async () => {
    const { db, state } = fakeDb();
    const response = await makeApp("platform_admin", db).request("/api/admin/branding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brandingPayload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      locales: brandingPayload.locales,
      logoUrl: brandingPayload.logoUrl,
      faviconUrl: brandingPayload.faviconUrl,
      updatedBy: ROUTE_USER_ID,
    });
    expect(state.row).toMatchObject({
      singletonId: "default",
      locales: brandingPayload.locales,
      logoUrl: brandingPayload.logoUrl,
      faviconUrl: brandingPayload.faviconUrl,
      updatedBy: ROUTE_USER_ID,
    });
    expect(state.locks).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      actor: ROUTE_USER_ID,
      action: "platform.branding.update",
      target: "platform_branding",
      diff: { after: brandingPayload },
    });
  });

  test("rejects unsafe or unavailable local image URLs and does not enter the transaction", async () => {
    const { db, state } = fakeDb();
    for (const logoUrl of ["javascript:alert(1)", "/assets/logo.svg"]) {
      const response = await makeApp("platform_admin", db).request("/api/admin/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...brandingPayload, logoUrl }),
      });

      expect(response.status).toBe(400);
    }
    expect(state.locks).toBe(0);
    expect(state.row).toBeNull();
    expect(state.audits).toHaveLength(0);
  });

  test("does not trust a JWT role without a canonical principal", async () => {
    const { db, state } = fakeDb();
    const response = await makeApp("platform_admin", db, { principalUserId: null }).request(
      "/api/admin/branding",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brandingPayload),
      },
    );

    expect(response.status).toBe(403);
    expect(state.locks).toBe(0);
    expect(state.row).toBeNull();
  });

  test("passes the platform permission check to the configured AuthZ service", async () => {
    const { db } = fakeDb();
    const checks: Array<{
      check: AuthzCheck & { localAllowed: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck, isPlatformAdmin: boolean) => {
        checks.push({
          check: check as AuthzCheck & { localAllowed: boolean },
          isPlatformAdmin,
        });
      },
    } as unknown as AuthzService;

    const response = await makeApp("user", db, { authz }).request("/api/admin/branding");

    expect(response.status).toBe(200);
    expect(checks).toEqual([
      {
        check: {
          actorUserId: ROUTE_USER_ID,
          actorEmail: "user@branding.test",
          resource: { type: "platform", id: "root" },
          permission: "view",
          subject: { type: "user", id: ROUTE_USER_ID },
          context: { localAllowed: false, source: "admin-branding" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });
});
