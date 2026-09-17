// cpRbac middleware + deriveCpScope tests.
import { describe, expect, it } from "bun:test";
import { CpRbacError, deriveCpScope } from "../cp-rbac";

describe("deriveCpScope", () => {
  it("rejects missing principal", () => {
    expect(() => deriveCpScope(undefined)).toThrow(CpRbacError);
  });

  it("rejects users without elevated role", () => {
    expect(() => deriveCpScope({ sub: "u-1", role: "user", orgId: "o-A" })).toThrow(
      "no CP org membership",
    );
  });

  it("rejects guests", () => {
    expect(() => deriveCpScope({ sub: "u-1", role: "guest" })).toThrow("no CP org membership");
  });

  it("accepts legacy org_admin with at least one org", () => {
    const s = deriveCpScope({ sub: "u-1", role: "org_admin", orgId: "o-A" });
    expect(s.orgIds).toEqual(["o-A"]);
    expect(s.isPlatformWide).toBe(false);
  });

  it("rejects org_admin without org membership", () => {
    expect(() => deriveCpScope({ sub: "u-1", role: "org_admin" })).toThrow("no CP org membership");
  });

  it("can defer missing local CP membership to an external authorizer", () => {
    const s = deriveCpScope({ sub: "u-1", role: "user" }, { allowEmptyScope: true });
    expect(s.orgIds).toEqual([]);
    expect(s.isPlatformWide).toBe(false);
    expect(s.localAllowed).toBe(false);
  });

  it("accepts user with CP-eligible membership", () => {
    const s = deriveCpScope({
      sub: "u-1",
      role: "user",
      memberships: [{ orgId: "o-A", role: "operator" }],
    });
    expect(s.orgIds).toEqual(["o-A"]);
    expect(s.isPlatformWide).toBe(false);
  });

  it("separates provider operator view from owner and administrator management", () => {
    const operator = deriveCpScope({
      sub: "u-operator",
      role: "user",
      memberships: [{ orgId: "o-A", role: "operator" }],
    });
    const owner = deriveCpScope({
      sub: "u-owner",
      role: "user",
      memberships: [{ orgId: "o-A", role: "owner" }],
    });

    expect(operator.canManage).toBe(false);
    expect(owner.canManage).toBe(true);
  });

  it("accepts platform_admin with platform-wide reach", () => {
    const s = deriveCpScope({ sub: "u-1", role: "platform_admin" });
    expect(s.isPlatformWide).toBe(true);
  });

  it("lets a platform administrator narrow to any provider organization", () => {
    const scope = deriveCpScope(
      { sub: "u-1", role: "platform_admin" },
      { activeOrganizationId: "o-provider" },
    );

    expect(scope.orgIds).toEqual(["o-provider"]);
    expect(scope.isPlatformWide).toBe(false);
    expect(scope.activeOrganizationId).toBe("o-provider");
  });

  it("accepts super_admin with platform-wide reach", () => {
    const s = deriveCpScope({ sub: "u-1", role: "super_admin" });
    expect(s.isPlatformWide).toBe(true);
  });

  it("preserves multi-org membership", () => {
    const s = deriveCpScope({ sub: "u-1", role: "org_admin", orgIds: ["o-A", "o-B"] });
    expect(s.orgIds).toEqual(["o-A", "o-B"]);
  });

  it("narrows the CP scope to the selected organization", () => {
    const s = deriveCpScope(
      {
        sub: "u-1",
        role: "user",
        memberships: [
          { orgId: "o-A", role: "operator" },
          { orgId: "o-B", role: "operator" },
        ],
      },
      { activeOrganizationId: "o-B" },
    );
    expect(s.orgIds).toEqual(["o-B"]);
    expect(s.activeOrganizationId).toBe("o-B");
  });

  it("does not carry management rights into an operator-only active organization", () => {
    const scope = deriveCpScope(
      {
        sub: "u-mixed",
        role: "user",
        memberships: [
          { orgId: "o-A", role: "owner" },
          { orgId: "o-B", role: "operator" },
        ],
      },
      { activeOrganizationId: "o-B" },
    );

    expect(scope.orgIds).toEqual(["o-B"]);
    expect(scope.canManage).toBe(false);
  });

  it("rejects an active organization outside the CP memberships", () => {
    expect(() =>
      deriveCpScope(
        { sub: "u-1", role: "user", memberships: [{ orgId: "o-A", role: "operator" }] },
        { activeOrganizationId: "o-B" },
      ),
    ).toThrow("selected organization is not available");
  });
});
