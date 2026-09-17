import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { PreferenceService } from "../preferences/preference-service";
import { createPreferenceRoutes, localPreferenceRole } from "./preferences";

interface CapturedPreferenceAuthzCheck extends AuthzCheck {
  localAllowed: boolean;
}

function fakePreferenceService(): PreferenceService {
  return {
    loadGlobal: async () => undefined,
    upsertGlobal: async () => undefined,
    loadScoped: async () => undefined,
    upsertScoped: async () => undefined,
  } as unknown as PreferenceService;
}

function fakePreferenceServiceWithWrites(writes: Array<{ scopeId: string; spec: unknown }>) {
  return {
    loadGlobal: async () => undefined,
    upsertGlobal: async (spec: unknown) => {
      writes.push({ scopeId: "global", spec });
    },
    loadScoped: async () => undefined,
    upsertScoped: async (_scope: "org" | "user", scopeId: string, spec: unknown) => {
      writes.push({ scopeId, spec });
    },
  } as unknown as PreferenceService;
}

function appWithAuthz(
  authz: AuthzService,
  options: {
    principalEmail?: string;
    service?: PreferenceService;
    userEmail?: string;
    principalOrgIds?: string[];
    principalUserId?: string | null;
    principalRole?: string;
    role?: string;
  } = {},
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const principalOrgIds = options.principalOrgIds ?? ["org-1"];
    const role = options.role ?? "org_admin";
    const userEmail = options.userEmail ?? "admin@example.com";
    const principalEmail = options.principalEmail ?? userEmail;
    c.set("user" as never, {
      sub: userEmail,
      role,
      email: userEmail,
    });
    c.set("principal" as never, {
      sub: userEmail,
      role: options.principalRole ?? role,
      email: principalEmail,
      userId: options.principalUserId === undefined ? "user-1" : options.principalUserId,
      orgId: principalOrgIds[0] ?? null,
      orgIds: principalOrgIds,
      memberships: principalOrgIds.map((orgId) => ({ orgId, role: "admin" })),
    });
    await next();
  });
  app.route(
    "/api",
    createPreferenceRoutes(options.service ?? fakePreferenceService(), {} as PgDb, { authz }),
  );
  return app;
}

function appWithoutPrincipal(role: string) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, {
      sub: "stale-admin@example.com",
      role,
      email: "stale-admin@example.com",
    });
    await next();
  });
  app.route("/api", createPreferenceRoutes(fakePreferenceService(), {} as PgDb));
  return app;
}

function fakeEnforceAuthz(calls: CapturedPreferenceAuthzCheck[]): AuthzService {
  return {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck) => {
      calls.push(input as CapturedPreferenceAuthzCheck);
    },
  } as unknown as AuthzService;
}

function fakeEnforceAuthzWithFallback(
  calls: Array<{ input: CapturedPreferenceAuthzCheck; isPlatformAdmin: boolean }>,
): AuthzService {
  return {
    mode: "enforce",
    requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
      calls.push({ input: input as CapturedPreferenceAuthzCheck, isPlatformAdmin });
    },
  } as unknown as AuthzService;
}

describe("preference route SpiceDB authorization", () => {
  test("allows canonical super_admin global writes after platform#manage authorization", async () => {
    const calls: CapturedPreferenceAuthzCheck[] = [];
    const writes: Array<{ scopeId: string; spec: unknown }> = [];

    const res = await appWithAuthz(fakeEnforceAuthz(calls), {
      principalRole: "super_admin",
      role: "platform_admin",
      service: fakePreferenceServiceWithWrites(writes),
    }).request("/api/preferences/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 64 } }),
    });

    expect(res.status).toBe(200);
    expect(writes).toEqual([{ scopeId: "global", spec: { hardLimits: { maxCpus: 64 } } }]);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "admin@example.com",
        resource: { type: "platform", id: "root" },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true, source: "preferences" },
        localAllowed: true,
      },
    ]);
  });

  test("rejects platform_admin global writes before the SpiceDB check", async () => {
    const calls: CapturedPreferenceAuthzCheck[] = [];
    const writes: Array<{ scopeId: string; spec: unknown }> = [];

    const res = await appWithAuthz(fakeEnforceAuthz(calls), {
      principalRole: "platform_admin",
      role: "super_admin",
      service: fakePreferenceServiceWithWrites(writes),
    }).request("/api/preferences/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 64 } }),
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("checks organization#view for org preference reads", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz, {
      principalEmail: "bound-preferences@example.com",
      userEmail: "stale-token-preferences@example.com",
    }).request("/api/preferences/org/org-1");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "bound-preferences@example.com",
        resource: { type: "organization", id: "org-1" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true, source: "preferences" },
        localAllowed: true,
      },
    ]);
  });

  test("rejects org preference writes denied by organization#manage", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz).request("/api/preferences/org/org-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 32 } }),
    });

    expect(res.status).toBe(403);
  });

  test("org preference degraded fallback uses bound principal role", async () => {
    const calls: Array<{ input: CapturedPreferenceAuthzCheck; isPlatformAdmin: boolean }> = [];

    const res = await appWithAuthz(fakeEnforceAuthzWithFallback(calls), {
      role: "platform_admin",
      principalRole: "user",
      principalOrgIds: [],
    }).request("/api/preferences/org/org-1");

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.isPlatformAdmin).toBe(false);
    expect(calls[0]?.input.localAllowed).toBe(false);
  });

  test("fails closed for org preference checks without canonical user id in enforce mode", async () => {
    const calls: CapturedPreferenceAuthzCheck[] = [];

    const res = await appWithAuthz(fakeEnforceAuthz(calls), {
      principalUserId: null,
    }).request("/api/preferences/org/org-2");

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("fails closed for org preference checks without canonical user id in shadow mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    const res = await appWithAuthz(authz, {
      principalUserId: null,
    }).request("/api/preferences/org/org-1");

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("allows org preference reads authorized by organization#view in enforce mode", async () => {
    const calls: CapturedPreferenceAuthzCheck[] = [];

    const res = await appWithAuthz(fakeEnforceAuthz(calls), {
      principalEmail: "bound-preferences@example.com",
      principalOrgIds: ["org-1"],
      userEmail: "stale-token-preferences@example.com",
    }).request("/api/preferences/org/org-2");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "bound-preferences@example.com",
        resource: { type: "organization", id: "org-2" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, source: "preferences" },
        localAllowed: false,
      },
    ]);
  });

  test("allows org preference writes authorized by organization#manage in enforce mode", async () => {
    const calls: CapturedPreferenceAuthzCheck[] = [];
    const writes: Array<{ scopeId: string; spec: unknown }> = [];

    const res = await appWithAuthz(fakeEnforceAuthz(calls), {
      principalEmail: "bound-preferences@example.com",
      principalOrgIds: ["org-1"],
      service: fakePreferenceServiceWithWrites(writes),
      userEmail: "stale-token-preferences@example.com",
    }).request("/api/preferences/org/org-2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardLimits: { maxCpus: 32 } }),
    });

    expect(res.status).toBe(200);
    expect(writes).toEqual([{ scopeId: "org-2", spec: { hardLimits: { maxCpus: 32 } } }]);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "bound-preferences@example.com",
        resource: { type: "organization", id: "org-2" },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, source: "preferences" },
        localAllowed: false,
      },
    ]);
  });

  test("rejects user preference self access without canonical user id", async () => {
    const res = await appWithAuthz({ mode: "off" } as AuthzService, {
      role: "user",
      principalUserId: null,
      principalOrgIds: [],
    }).request("/api/preferences/user/user-1");

    expect(res.status).toBe(403);
  });

  test("local preference role does not trust stale JWT role without a bound principal", async () => {
    expect(localPreferenceRole({ role: "platform_admin" }, undefined)).toBe("guest");

    const res = await appWithoutPrincipal("org_admin").request("/api/preferences/org/org-1");

    expect(res.status).toBe(403);
  });
});
