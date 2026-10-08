import type { MeCapabilities } from "@kuintessence/shared/browser";

export function canManageSpackInstallBinding(
  scope: string,
  access: {
    canManage: boolean;
    organizationId: string | null;
    capabilities: MeCapabilities | null;
  },
): boolean {
  const { canManage, organizationId, capabilities } = access;
  if (!canManage || !capabilities) return false;
  const role = capabilities.principal.role;
  const platformAdmin = role === "platform_admin" || role === "super_admin";
  if (scope === "platform") return platformAdmin;
  if (!organizationId || scope !== organizationId) return false;
  const contexts = capabilities.contexts.filter((context) => context.type === "organization");
  const active = contexts.find((context) => context.organizationId === organizationId);
  if (!active) return false;
  if (platformAdmin) return true;
  if (!capabilities.capabilities.includes("workspace.provider.manage")) return false;
  if (active.membershipRole === "owner" || active.membershipRole === "admin") return true;
  // Concrete CP memberships take precedence over the legacy global org_admin role.
  const hasScopedMembership = contexts.some((context) =>
    ["owner", "admin", "operator"].includes(context.membershipRole),
  );
  return role === "org_admin" && !hasScopedMembership;
}
