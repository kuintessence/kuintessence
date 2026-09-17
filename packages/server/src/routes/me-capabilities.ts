import {
  DEFAULT_REGISTRY_PUBLISHER_ROLES,
  hasRole,
  type MeCapabilities,
  MeCapabilitiesSchema,
  type PlatformCapability,
  type RegistryRole,
  Role,
  type RoleName,
} from "@kuintessence/shared";
import { Hono } from "hono";
import {
  type BoundPrincipal,
  hasAuditReadonlyCapability,
  type OrgMembershipRole,
} from "../middleware/principal-binder";

const PLATFORM_VIEW_ROLES: ReadonlySet<string> = new Set([
  Role.OPERATOR,
  Role.PLATFORM_ADMIN,
  Role.SUPER_ADMIN,
]);
const PLATFORM_MANAGE_ROLES: ReadonlySet<string> = new Set([Role.PLATFORM_ADMIN, Role.SUPER_ADMIN]);
const PROVIDER_VIEW_ROLES: ReadonlySet<string> = new Set([Role.PLATFORM_ADMIN, Role.SUPER_ADMIN]);
const PROVIDER_MANAGE_ROLES: ReadonlySet<string> = new Set([
  Role.ORG_ADMIN,
  Role.PLATFORM_ADMIN,
  Role.SUPER_ADMIN,
]);
const PROVIDER_VIEW_MEMBERSHIPS = new Set<OrgMembershipRole>(["owner", "admin", "operator"]);
const PROVIDER_MANAGE_MEMBERSHIPS = new Set<OrgMembershipRole>(["owner", "admin"]);
const TERMINAL_ROLES: ReadonlySet<string> = new Set([
  Role.ORG_ADMIN,
  Role.OPERATOR,
  Role.PLATFORM_ADMIN,
  Role.SUPER_ADMIN,
]);

export function deriveMeCapabilities(
  principal: BoundPrincipal,
  softwarePublisherRoles: readonly RegistryRole[] = DEFAULT_REGISTRY_PUBLISHER_ROLES,
): MeCapabilities {
  const capabilities = new Set<PlatformCapability>(["workspace.ecosystem.view"]);
  if (hasRole(principal.role as RoleName, Role.USER)) {
    capabilities.add("workspace.consumer.access");
    capabilities.add("workspace.personal.access");
    capabilities.add("workflow.submit");
    capabilities.add("storage.request");
  }
  const activeProviderMemberships = principal.orgId
    ? principal.memberships.filter((membership) => membership.orgId === principal.orgId)
    : principal.memberships.length === 1
      ? principal.memberships
      : [];
  const viewsProviderMembership = (
    principal.orgId ? activeProviderMemberships : principal.memberships
  ).some((membership) => PROVIDER_VIEW_MEMBERSHIPS.has(membership.role));
  const managesProviderMembership = activeProviderMemberships.some((membership) =>
    PROVIDER_MANAGE_MEMBERSHIPS.has(membership.role),
  );
  const hasAuditRead =
    PLATFORM_VIEW_ROLES.has(principal.role) || hasAuditReadonlyCapability(principal);

  if (viewsProviderMembership || PROVIDER_VIEW_ROLES.has(principal.role)) {
    capabilities.add("workspace.provider.view");
  }
  if (managesProviderMembership || PROVIDER_MANAGE_ROLES.has(principal.role)) {
    capabilities.add("workspace.provider.manage");
  }
  if (PLATFORM_VIEW_ROLES.has(principal.role)) {
    capabilities.add("workspace.platform.view");
  }
  if (hasAuditRead) {
    capabilities.add("workspace.audit.view");
    capabilities.add("audit.view");
    capabilities.add("audit.recording.view");
    capabilities.add("metering.report.view");
  }
  if (PLATFORM_MANAGE_ROLES.has(principal.role)) {
    capabilities.add("workspace.platform.manage");
  }
  if (PROVIDER_MANAGE_ROLES.has(principal.role) || managesProviderMembership) {
    capabilities.add("workspace.ecosystem.publish");
  }
  if (softwarePublisherRoles.some((role) => role === principal.role)) {
    capabilities.add("software.publish");
  }
  if (TERMINAL_ROLES.has(principal.role) || managesProviderMembership) {
    capabilities.add("terminal.open");
  }

  const organizationContexts = principal.memberships.map((membership) => ({
    id: `organization:${membership.orgId}` as const,
    type: "organization" as const,
    organizationId: membership.orgId,
    membershipRole: membership.role,
  }));
  const contexts: MeCapabilities["contexts"] = [
    { id: "personal", type: "personal" },
    ...(capabilities.has("workspace.platform.view")
      ? ([{ id: "platform", type: "platform" }] as const)
      : []),
    ...(capabilities.has("workspace.audit.view")
      ? ([{ id: "audit", type: "audit" }] as const)
      : []),
    ...organizationContexts,
  ];
  const activeOrganizationContext = principal.orgId
    ? organizationContexts.find((context) => context.organizationId === principal.orgId)
    : undefined;
  const activeContextId =
    activeOrganizationContext?.id ??
    (capabilities.has("workspace.platform.view")
      ? "platform"
      : capabilities.has("workspace.audit.view")
        ? "audit"
        : (organizationContexts[0]?.id ?? "personal"));

  return MeCapabilitiesSchema.parse({
    principal: {
      userId: principal.userId,
      email: principal.email,
      role: principal.role,
    },
    capabilities: [...capabilities],
    contexts,
    activeContextId,
    devicePolicy: {
      highRiskMutations: "desktop-only",
      mobileMode: "observe-approve",
    },
  });
}

export function createMeCapabilityRoutes(
  options: { softwarePublisherRoles?: RegistryRole[] } = {},
) {
  const routes = new Hono();
  routes.get("/me/capabilities", (c) => {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal) {
      return c.json({ error: { code: "FORBIDDEN", message: "Principal is not bound" } }, 403);
    }
    return c.json(deriveMeCapabilities(principal, options.softwarePublisherRoles));
  });
  return routes;
}
