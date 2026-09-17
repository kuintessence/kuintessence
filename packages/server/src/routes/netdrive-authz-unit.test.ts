import { describe, expect, test } from "bun:test";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { netDriveActorFromPrincipal } from "./netdrive";

describe("netdrive canonical actor binding", () => {
  const principal: BoundPrincipal = {
    sub: "casdoor-opaque-subject",
    role: "user",
    email: "user@example.com",
    userId: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    orgIds: ["22222222-2222-4222-8222-222222222222"],
    memberships: [{ orgId: "22222222-2222-4222-8222-222222222222", role: "member" }],
    capabilities: [],
  };

  test("uses canonical users.id instead of OIDC sub for owner id", () => {
    expect(netDriveActorFromPrincipal(principal)).toEqual({
      ownerId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("fails closed when canonical users.id is missing", () => {
    expect(() => netDriveActorFromPrincipal({ ...principal, userId: null })).toThrow(
      "Authorization principal is not bound",
    );
  });

  test("does not infer an organization when the primary org is absent", () => {
    expect(netDriveActorFromPrincipal({ ...principal, orgId: null })).toEqual({
      ownerId: "11111111-1111-4111-8111-111111111111",
      orgId: null,
    });
  });
});
