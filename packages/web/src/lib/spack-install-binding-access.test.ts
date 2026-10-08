import type { MeCapabilities } from "@kuintessence/shared/browser";
import { expect, test } from "vitest";
import { canManageSpackInstallBinding } from "./spack-install-binding-access";

const organizationId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const otherOrganizationId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
type MembershipRole = "owner" | "admin" | "operator" | "member" | "viewer";

function context(role: MembershipRole, orgId = organizationId) {
  return {
    id: `organization:${orgId}`,
    type: "organization" as const,
    organizationId: orgId,
    membershipRole: role,
  };
}

function access(role = "user", membershipRole: MembershipRole = "admin") {
  const capabilities: MeCapabilities = {
    principal: {
      userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      email: "admin@example.test",
      role,
    },
    capabilities: ["workspace.provider.manage"],
    contexts: [context(membershipRole)],
    activeContextId: `organization:${organizationId}`,
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
  };
  return { canManage: true, organizationId, capabilities };
}

test.each([
  "owner",
  "admin",
] as const)("current organization %s with global user role does not need software.publish", (role) => {
  const current = access("user", role);
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(true);
  expect(canManageSpackInstallBinding("platform", current)).toBe(false);
  expect(canManageSpackInstallBinding(otherOrganizationId, current)).toBe(false);
});

test.each([
  "platform_admin",
  "super_admin",
])("%s does not require publishing or provider capabilities", (role) => {
  const current = access(role, "viewer");
  current.capabilities.capabilities = [];
  expect(canManageSpackInstallBinding("platform", current)).toBe(true);
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(true);
  expect(canManageSpackInstallBinding(otherOrganizationId, current)).toBe(false);
  expect(canManageSpackInstallBinding("platform", { ...current, canManage: false })).toBe(false);
  current.capabilities.contexts = [];
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
});

test.each([
  "operator",
  "member",
  "viewer",
] as const)("provider capability alone cannot elevate a user with %s membership", (role) => {
  expect(canManageSpackInstallBinding(organizationId, access("user", role))).toBe(false);
});

test.each([
  "member",
  "viewer",
] as const)("legacy org_admin fallback requires a verified %s context and provider capability", (role) => {
  const current = access("org_admin", role);
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(true);
  current.capabilities.capabilities = ["software.publish"];
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
});

test.each([
  "owner",
  "admin",
  "operator",
] as const)("a concrete %s membership elsewhere prevents global org_admin fallback", (role) => {
  const current = access("org_admin", "member");
  current.capabilities.contexts.push(context(role, otherOrganizationId));
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
  expect(canManageSpackInstallBinding(otherOrganizationId, current)).toBe(false);
});

test("global org_admin cannot override a concrete current operator membership", () => {
  expect(canManageSpackInstallBinding(organizationId, access("org_admin", "operator"))).toBe(false);
});

test("missing capabilities, active organization or verified context fail closed", () => {
  const current = access();
  expect(canManageSpackInstallBinding(organizationId, { ...current, capabilities: null })).toBe(
    false,
  );
  expect(canManageSpackInstallBinding(organizationId, { ...current, canManage: false })).toBe(
    false,
  );
  expect(canManageSpackInstallBinding(organizationId, { ...current, organizationId: null })).toBe(
    false,
  );
  current.capabilities.capabilities = ["software.publish"];
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
  current.capabilities.capabilities = ["workspace.provider.manage"];
  current.capabilities.contexts = [context("admin", otherOrganizationId)];
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
  current.capabilities.contexts = [];
  current.capabilities.principal.role = "org_admin";
  expect(canManageSpackInstallBinding(organizationId, current)).toBe(false);
});
