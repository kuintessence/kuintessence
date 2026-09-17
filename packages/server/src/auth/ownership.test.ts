import { describe, expect, test } from "bun:test";
import { authorizeResourceAccess, type OwnedResource } from "@kuintessence/shared";
import type { Context } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { ownershipPrincipalFromContext } from "./ownership";

const boundPrincipal = (overrides: Partial<BoundPrincipal> = {}): BoundPrincipal => ({
  sub: "casdoor-subject",
  role: "user",
  email: "user-a@example.com",
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "org-a",
  orgIds: ["org-a"],
  memberships: [{ orgId: "org-a", role: "member" }],
  capabilities: [],
  ...overrides,
});

const contextWithPrincipal = (principal: BoundPrincipal): Context =>
  ({
    get: (key: string) => (key === "principal" ? principal : undefined),
  }) as unknown as Context;

const contextWithUserOnly = (): Context =>
  ({
    get: (key: string) =>
      key === "user"
        ? { sub: "jwt-subject", role: "platform_admin", email: "admin@example.com" }
        : undefined,
  }) as unknown as Context;

describe("ownershipPrincipalFromContext", () => {
  test("preserves canonical user id for local ownership fallback", () => {
    const principal = ownershipPrincipalFromContext(contextWithPrincipal(boundPrincipal()));
    const resource: OwnedResource = {
      resourceType: "ssh_session",
      resourceId: "ssh_session:session-a",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      ownerEmail: "different@example.com",
    };

    expect(principal?.userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(authorizeResourceAccess(principal, resource, "read").allowed).toBe(true);
  });

  test("does not recover ownership identity from JWT without a bound principal", () => {
    expect(ownershipPrincipalFromContext(contextWithUserOnly())).toBeNull();
  });
});
