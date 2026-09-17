import { describe, expect, test } from "bun:test";
import type { RoleName } from "@kuintessence/shared";
import type { OrgMembershipRole } from "../middleware/principal-binder";
import { jobVisibilityOrgScopes, resolveJobReadScope } from "./job-access";

const resource = {
  submittedBy: "owner-user",
  consumerOrgId: "consumer-org",
  providerOrgId: "provider-org",
};

function principal(
  userId: string,
  role: RoleName = "user",
  memberships: Array<{ orgId: string; role: OrgMembershipRole }> = [],
) {
  return { userId, role, memberships };
}

describe("resolveJobReadScope", () => {
  test("allows the job owner", () => {
    expect(resolveJobReadScope(principal("owner-user"), resource)).toBe("owner");
  });

  test.each(["owner", "admin"] as const)("allows consumer organization %s membership", (role) => {
    expect(
      resolveJobReadScope(
        principal("consumer-admin", "user", [{ orgId: "consumer-org", role }]),
        resource,
      ),
    ).toBe("consumer_admin");
  });

  test.each([
    "member",
    "viewer",
    "operator",
  ] as const)("rejects consumer organization %s membership", (role) => {
    expect(
      resolveJobReadScope(
        principal("consumer-user", "user", [{ orgId: "consumer-org", role }]),
        resource,
      ),
    ).toBeNull();
  });

  test.each([
    "owner",
    "admin",
    "operator",
  ] as const)("allows provider organization %s membership", (role) => {
    expect(
      resolveJobReadScope(
        principal("provider-operator", "user", [{ orgId: "provider-org", role }]),
        resource,
      ),
    ).toBe("provider_operator");
  });

  test.each([
    "member",
    "viewer",
  ] as const)("rejects provider organization %s membership", (role) => {
    expect(
      resolveJobReadScope(
        principal("provider-user", "user", [{ orgId: "provider-org", role }]),
        resource,
      ),
    ).toBeNull();
  });

  test("allows platform administrators without organization membership", () => {
    expect(resolveJobReadScope(principal("platform-user", "platform_admin"), resource)).toBe(
      "platform",
    );
  });
});

describe("jobVisibilityOrgScopes", () => {
  test("splits consumer-admin and provider-operator organization ids", () => {
    expect(
      jobVisibilityOrgScopes([
        { orgId: "owner-org", role: "owner" },
        { orgId: "admin-org", role: "admin" },
        { orgId: "operator-org", role: "operator" },
        { orgId: "member-org", role: "member" },
      ]),
    ).toEqual({
      consumerAdminOrgIds: ["owner-org", "admin-org"],
      providerOperatorOrgIds: ["owner-org", "admin-org", "operator-org"],
    });
  });
});
