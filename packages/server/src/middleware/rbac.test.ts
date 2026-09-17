import { describe, expect, test } from "bun:test";
import { Role, type RoleName } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { TokenPayload } from "../services/auth";
import { createErrorHandler } from "./error-handler";
import type { BoundPrincipal } from "./principal-binder";
import { requireRole } from "./rbac";

const testLogger = pino({ level: "silent" });

function makeApp(role: RoleName, principal: Partial<BoundPrincipal> | null = { role }) {
  const app = new Hono();
  app.onError(createErrorHandler(testLogger));
  app.use("*", async (c, next) => {
    c.set("user", { sub: "u1", role, email: "u1@test.com" } as TokenPayload);
    if (principal) {
      c.set("principal" as never, {
        sub: "u1",
        role: "guest",
        email: "u1@test.com",
        userId: "user-1",
        orgId: null,
        orgIds: [],
        memberships: [],
        ...principal,
      });
    }
    await next();
  });
  app.get("/admin", requireRole(Role.ORG_ADMIN), (c) => c.text("ok"));
  return app;
}

describe("requireRole middleware", () => {
  test("allows user with sufficient role", async () => {
    const res = await makeApp(Role.PLATFORM_ADMIN).request("/admin");
    expect(res.status).toBe(200);
  });

  test("rejects user with insufficient role", async () => {
    const res = await makeApp(Role.USER).request("/admin");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("allows user with exact role", async () => {
    const res = await makeApp(Role.ORG_ADMIN).request("/admin");
    expect(res.status).toBe(200);
  });

  test("uses bound principal role instead of stale JWT role", async () => {
    const res = await makeApp(Role.PLATFORM_ADMIN, { role: Role.USER }).request("/admin");
    expect(res.status).toBe(403);
  });

  test("does not recover role from JWT when principal is missing", async () => {
    const res = await makeApp(Role.PLATFORM_ADMIN, null).request("/admin");
    expect(res.status).toBe(403);
  });

  test("allows organization operators through bound memberships", async () => {
    const res = await makeApp(Role.USER, {
      role: Role.USER,
      memberships: [{ orgId: "org-1", role: "operator" }],
    }).request("/admin");
    expect(res.status).toBe(200);
  });
});
