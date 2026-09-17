import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { Hono } from "hono";
import {
  type BoundPrincipal,
  principalActorLookupKey,
  principalBinder,
  resolveActiveOrganization,
} from "./principal-binder";

function fakeDb(): PgDb {
  return {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          "id" in selection
            ? {
                limit: async () => [
                  { id: "user-db-id", role: "user", email: "canonical@example.com" },
                ],
              }
            : Promise.resolve([{ orgId: "org-a", role: "admin" }]),
      }),
    }),
  } as unknown as PgDb;
}

function fakeDbWithoutUser(): PgDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as PgDb;
}

function fakeDbWithLookupFailure(): PgDb {
  return {
    select: () => {
      throw new Error("db unavailable");
    },
  } as unknown as PgDb;
}

describe("principalBinder", () => {
  test("uses the DB user role instead of the JWT role for a bound principal", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "opaque-idp-sub",
        email: "admin@example.com",
        role: "platform_admin",
      });
      await next();
    });
    app.use("*", principalBinder(fakeDb()));
    app.get("/principal", (c) => c.json(c.get("principal" as never) as BoundPrincipal));

    const res = await app.request("/principal");
    const principal = (await res.json()) as BoundPrincipal;

    expect(principal.userId).toBe("user-db-id");
    expect(principal.role).toBe("user");
    expect(principal.email).toBe("canonical@example.com");
    expect(principal.memberships).toEqual([{ orgId: "org-a", role: "admin" }]);
  });

  test("does not copy JWT role when the Server user is not bound", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "opaque-idp-sub",
        email: "missing@example.com",
        role: "platform_admin",
      });
      await next();
    });
    app.use("*", principalBinder(fakeDbWithoutUser()));
    app.get("/principal", (c) => c.json(c.get("principal" as never) as BoundPrincipal));

    const res = await app.request("/principal");
    const principal = (await res.json()) as BoundPrincipal;

    expect(principal.userId).toBeNull();
    expect(principal.role).toBe("guest");
    expect(principal.memberships).toEqual([]);
  });

  test("falls back to guest when the Server lookup fails", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "opaque-idp-sub",
        email: "admin@example.com",
        role: "super_admin",
      });
      await next();
    });
    app.use("*", principalBinder(fakeDbWithLookupFailure()));
    app.get("/principal", (c) => c.json(c.get("principal" as never) as BoundPrincipal));

    const res = await app.request("/principal");
    const principal = (await res.json()) as BoundPrincipal;

    expect(principal.userId).toBeNull();
    expect(principal.role).toBe("guest");
    expect(principal.memberships).toEqual([]);
  });
});

describe("principalActorLookupKey", () => {
  test("uses UUID sub when email may be stale", () => {
    expect(
      principalActorLookupKey({
        sub: "00000000-0000-4000-8000-000000000111",
        email: "stale@example.com",
      }),
    ).toBe("00000000-0000-4000-8000-000000000111");
  });

  test("uses email for opaque OIDC subjects", () => {
    expect(
      principalActorLookupKey({ sub: "casdoor:opaque-subject", email: "current@example.com" }),
    ).toBe("current@example.com");
  });
});

describe("resolveActiveOrganization", () => {
  test("keeps a platform-selected organization without requiring membership", () => {
    expect(resolveActiveOrganization("platform_admin", "org-b", [])).toBe("org-b");
    expect(resolveActiveOrganization("super_admin", "org-b", [])).toBe("org-b");
  });

  test("keeps ordinary users inside their membership scope", () => {
    expect(resolveActiveOrganization("user", "org-a", ["org-a"])).toBe("org-a");
    expect(resolveActiveOrganization("user", "org-b", ["org-a"])).toBeNull();
  });
});
