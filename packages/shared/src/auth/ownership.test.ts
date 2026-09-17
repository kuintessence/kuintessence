import { describe, expect, test } from "bun:test";
import {
  authorizeResourceAccess,
  type OwnedResource,
  type OwnershipPrincipal,
  ownershipHttpStatus,
} from "./ownership";

const resource = (overrides: Partial<OwnedResource> = {}): OwnedResource => ({
  resourceType: "ssh_credential",
  resourceId: "cred-agent-a",
  providerOrgId: "org-a",
  ...overrides,
});

const principal = (overrides: Partial<OwnershipPrincipal> = {}): OwnershipPrincipal => ({
  sub: "u-1",
  role: "user",
  email: "user-a@example.com",
  userId: "user-a",
  orgId: "org-a",
  orgIds: ["org-a"],
  ...overrides,
});

describe("authorizeResourceAccess", () => {
  test("allows platform-wide admins for every action", () => {
    const decision = authorizeResourceAccess(
      principal({ role: "platform_admin", orgIds: [] }),
      resource({ providerOrgId: "org-b" }),
      "manage",
    );
    expect(decision.allowed).toBe(true);
  });

  test("allows provider org admins to manage provider-owned resources", () => {
    const decision = authorizeResourceAccess(
      principal({ role: "org_admin" }),
      resource(),
      "manage",
    );
    expect(decision.allowed).toBe(true);
  });

  test("hides provider-owned resources from another org", () => {
    const decision = authorizeResourceAccess(
      principal({ role: "org_admin", orgId: "org-b", orgIds: ["org-b"] }),
      resource(),
      "manage",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("RESOURCE_NOT_VISIBLE");
    expect(ownershipHttpStatus(decision)).toBe(404);
  });

  test("lets a consumer org use an exposed resource without managing it", () => {
    const exposed = resource({ resourceType: "queue", allowedOrgIds: ["org-b"] });
    const consumer = principal({ orgId: "org-b", orgIds: ["org-b"] });
    expect(authorizeResourceAccess(consumer, exposed, "use").allowed).toBe(true);

    const manage = authorizeResourceAccess(consumer, exposed, "manage");
    expect(manage.allowed).toBe(false);
    expect(manage.reason).toBe("ACTION_FORBIDDEN");
    expect(ownershipHttpStatus(manage)).toBe(404);
  });

  test("lets resource owners read and close their own sessions", () => {
    const session = resource({
      resourceType: "ssh_session",
      ownerEmail: "user-a@example.com",
      ownerUserId: "user-a",
    });
    expect(authorizeResourceAccess(principal(), session, "read").allowed).toBe(true);
    expect(authorizeResourceAccess(principal(), session, "close").allowed).toBe(true);
  });

  test("does not treat matching owner email as ownership without canonical owner user id", () => {
    const session = resource({
      resourceType: "ssh_session",
      ownerEmail: "user-a@example.com",
      ownerUserId: "different-user",
    });
    const decision = authorizeResourceAccess(principal(), session, "read");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("RESOURCE_NOT_VISIBLE");
  });

  test("rejects unauthenticated access with 401 semantics", () => {
    const decision = authorizeResourceAccess(null, resource(), "read");
    expect(decision.reason).toBe("UNAUTHENTICATED");
    expect(ownershipHttpStatus(decision)).toBe(401);
  });

  test("keeps nullable provider ownership usable for migration by org admins only", () => {
    const legacy = resource({ providerOrgId: null });
    expect(authorizeResourceAccess(principal({ role: "org_admin" }), legacy, "read").allowed).toBe(
      true,
    );
    expect(authorizeResourceAccess(principal({ role: "user" }), legacy, "read").allowed).toBe(
      false,
    );
  });
});
