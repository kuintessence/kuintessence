import { describe, expect, test } from "bun:test";
import { hasRole, Role, type RoleName } from "./roles";

describe("hasRole", () => {
  test("super_admin satisfies all roles", () => {
    expect(hasRole(Role.SUPER_ADMIN, Role.GUEST)).toBe(true);
    expect(hasRole(Role.SUPER_ADMIN, Role.USER)).toBe(true);
    expect(hasRole(Role.SUPER_ADMIN, Role.ORG_ADMIN)).toBe(true);
    expect(hasRole(Role.SUPER_ADMIN, Role.OPERATOR)).toBe(true);
    expect(hasRole(Role.SUPER_ADMIN, Role.PLATFORM_ADMIN)).toBe(true);
    expect(hasRole(Role.SUPER_ADMIN, Role.SUPER_ADMIN)).toBe(true);
  });

  test("guest does not satisfy any higher role", () => {
    expect(hasRole(Role.GUEST, Role.USER)).toBe(false);
    expect(hasRole(Role.GUEST, Role.ORG_ADMIN)).toBe(false);
    expect(hasRole(Role.GUEST, Role.OPERATOR)).toBe(false);
    expect(hasRole(Role.GUEST, Role.SUPER_ADMIN)).toBe(false);
  });

  test("equal roles are satisfied", () => {
    expect(hasRole(Role.GUEST, Role.GUEST)).toBe(true);
    expect(hasRole(Role.USER, Role.USER)).toBe(true);
    expect(hasRole(Role.ORG_ADMIN, Role.ORG_ADMIN)).toBe(true);
    expect(hasRole(Role.OPERATOR, Role.OPERATOR)).toBe(true);
  });

  test("user satisfies guest but not org_admin", () => {
    expect(hasRole(Role.USER, Role.GUEST)).toBe(true);
    expect(hasRole(Role.USER, Role.ORG_ADMIN)).toBe(false);
  });

  test("org_admin satisfies user but not platform_admin", () => {
    expect(hasRole(Role.ORG_ADMIN, Role.USER)).toBe(true);
    expect(hasRole(Role.ORG_ADMIN, Role.OPERATOR)).toBe(false);
    expect(hasRole(Role.ORG_ADMIN, Role.PLATFORM_ADMIN)).toBe(false);
  });

  test("operator and org_admin are parallel roles with a shared user baseline", () => {
    expect(hasRole(Role.OPERATOR, Role.USER)).toBe(true);
    expect(hasRole(Role.OPERATOR, Role.ORG_ADMIN)).toBe(false);
    expect(hasRole(Role.OPERATOR, Role.PLATFORM_ADMIN)).toBe(false);
    expect(hasRole(Role.ORG_ADMIN, Role.OPERATOR)).toBe(false);
  });

  test("platform roles cover both organization and operator branches", () => {
    for (const role of [Role.PLATFORM_ADMIN, Role.SUPER_ADMIN]) {
      expect(hasRole(role, Role.ORG_ADMIN)).toBe(true);
      expect(hasRole(role, Role.OPERATOR)).toBe(true);
    }
  });

  test("unrecognized roles fail closed", () => {
    expect(hasRole("unknown" as RoleName, Role.USER)).toBe(false);
  });
});
