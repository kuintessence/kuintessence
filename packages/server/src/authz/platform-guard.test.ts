import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { localPlatformRole, requirePlatformPermission } from "./platform-guard";
import type { AuthzCheck, AuthzService } from "./service";

function appFor(
  authz: AuthzService | undefined,
  principalUserId: string | null = "user-1",
  role = "platform_admin",
  principalRole = role,
  permission: "view" | "manage" = "manage",
  emails: { tokenEmail?: string; principalEmail?: string } = {},
  options: { source?: string } = {},
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const tokenEmail = emails.tokenEmail ?? "platform@example.com";
    const principalEmail = emails.principalEmail ?? tokenEmail;
    c.set("user" as never, {
      sub: "platform-sub",
      email: tokenEmail,
      role,
    });
    if (principalUserId) {
      c.set("principal" as never, {
        sub: "platform-sub",
        role: principalRole,
        email: principalEmail,
        userId: principalUserId,
        orgId: null,
        orgIds: [],
        memberships: [],
      });
    }
    await next();
  });
  app.get("/check", async (c) => {
    await requirePlatformPermission(c, authz, permission, options.source ?? "test-route");
    return c.json({ ok: true });
  });
  return app;
}

describe("requirePlatformPermission", () => {
  test("keeps the local platform-admin gate when authz is off", async () => {
    const res = await appFor(undefined, "user-1", "user").request("/check");

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Need platform_admin" },
    });
  });

  test("allows platform operator to read platform resources in local mode", async () => {
    const res = await appFor(undefined, "user-1", "operator", "operator", "view").request("/check");

    expect(res.status).toBe(200);
  });

  test("does not allow platform operator to manage platform resources in local mode", async () => {
    const res = await appFor(undefined, "user-1", "operator", "operator", "manage").request(
      "/check",
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Need platform_admin" },
    });
  });

  test("records platform operator view as locally allowed in shadow mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "operator", "operator", "view").request("/check");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "platform@example.com",
        resource: { type: "platform", id: "root" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true, source: "test-route" },
        localAllowed: true,
      },
    ]);
  });

  test("records a platform permission shadow check", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    const res = await appFor(authz).request("/check");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "platform@example.com",
        resource: { type: "platform", id: "root" },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true, source: "test-route" },
        localAllowed: true,
      },
    ]);
  });

  test("uses bound principal email instead of token email for platform check actor display", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "platform_admin", "platform_admin", "manage", {
      tokenEmail: "stale-token@example.com",
      principalEmail: "bound-user@example.com",
    }).request("/check");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({
        actorUserId: "user-1",
        actorEmail: "bound-user@example.com",
        subject: { type: "user", id: "user-1" },
      }),
    ]);
  });

  test("records shadow diff inputs but keeps local denial authoritative in shadow mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return false;
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "user").request("/check");

    expect(res.status).toBe(403);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "platform@example.com",
        resource: { type: "platform", id: "root" },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, source: "test-route" },
        localAllowed: false,
      },
    ]);
  });

  test("uses the bound principal role instead of the JWT role for local platform fallback", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        calls.push({ input, isPlatformAdmin });
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "platform_admin", "user").request("/check");

    expect(res.status).toBe(403);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: "user-1",
          actorEmail: "platform@example.com",
          resource: { type: "platform", id: "root" },
          permission: "manage",
          subject: { type: "user", id: "user-1" },
          context: { localAllowed: false, source: "test-route" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("does not trust stale JWT platform role without a bound principal", async () => {
    expect(localPlatformRole(undefined)).toBe("guest");

    const res = await appFor(undefined, null, "platform_admin").request("/check");

    expect(res.status).toBe(403);
  });

  test("lets SpiceDB authorize platform access in enforce mode", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        calls.push({ input: input as AuthzCheck & { localAllowed: boolean }, isPlatformAdmin });
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "user").request("/check");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: "user-1",
          actorEmail: "platform@example.com",
          resource: { type: "platform", id: "root" },
          permission: "manage",
          subject: { type: "user", id: "user-1" },
          context: { localAllowed: false, source: "test-route" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("does not use platform operator as degraded fallback when SpiceDB is unavailable", async () => {
    const calls: Array<{
      input: AuthzCheck & { localAllowed: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        calls.push({ input: input as AuthzCheck & { localAllowed: boolean }, isPlatformAdmin });
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization unavailable: spicedb down", 403);
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, "user-1", "operator", "operator", "view").request("/check");

    expect(res.status).toBe(403);
    expect(calls).toEqual([
      {
        input: {
          actorUserId: "user-1",
          actorEmail: "platform@example.com",
          resource: { type: "platform", id: "root" },
          permission: "view",
          subject: { type: "user", id: "user-1" },
          context: { localAllowed: true, source: "test-route" },
          localAllowed: true,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("propagates enforce denial", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;

    const res = await appFor(authz).request("/check");

    expect(res.status).toBe(403);
  });

  test("fails closed in enforce mode when canonical principal is missing", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => undefined,
    } as unknown as AuthzService;

    const res = await appFor(authz, null).request("/check");

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Authorization principal is not bound" },
    });
  });

  test("fails closed in shadow mode when canonical principal is missing", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;

    const res = await appFor(authz, null).request("/check");

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Authorization principal is not bound" },
    });
    expect(calls).toEqual([]);
  });
});
