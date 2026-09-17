import { hasRole, type RoleName } from "../constants/roles";

export type OwnershipAction = "read" | "use" | "manage" | "delete" | "close";

export type OwnedResourceType =
  | "agent"
  | "queue"
  | "ssh_credential"
  | "ssh_session"
  | "ssh_recording"
  | "cluster_file_root"
  | "software_policy"
  | "job"
  | "workflow"
  | "file";

export interface OwnershipPrincipal {
  sub: string;
  role: RoleName;
  email?: string;
  userId?: string | null;
  orgId?: string | null;
  orgIds?: string[];
}

export interface OwnedResource {
  resourceType: OwnedResourceType;
  resourceId: string;
  providerOrgId?: string | null;
  consumerOrgId?: string | null;
  ownerUserId?: string | null;
  ownerEmail?: string | null;
  allowedOrgIds?: string[];
  allowedUserIds?: string[];
  agentId?: string | null;
}

export type OwnershipDenyReason =
  | "UNAUTHENTICATED"
  | "ROLE_FORBIDDEN"
  | "RESOURCE_NOT_VISIBLE"
  | "ACTION_FORBIDDEN";

export interface OwnershipDecision {
  allowed: boolean;
  reason?: OwnershipDenyReason;
  conceal?: boolean;
}

const PROVIDER_ADMIN_RESOURCES = new Set<OwnedResourceType>([
  "agent",
  "queue",
  "ssh_credential",
  "cluster_file_root",
  "software_policy",
]);

const OWNER_READ_RESOURCES = new Set<OwnedResourceType>(["job", "workflow", "file", "ssh_session"]);

export function authorizeResourceAccess(
  principal: OwnershipPrincipal | undefined | null,
  resource: OwnedResource,
  action: OwnershipAction,
): OwnershipDecision {
  if (!principal) return deny("UNAUTHENTICATED");
  if (isPlatformWide(principal)) return allow();

  if (action === "manage" || action === "delete") {
    return canProviderAdmin(principal, resource)
      ? allow()
      : deny(
          hasVisibleRelationship(principal, resource) ? "ACTION_FORBIDDEN" : "RESOURCE_NOT_VISIBLE",
          true,
        );
  }

  if (action === "close") {
    if (isOwner(principal, resource) || canProviderAdmin(principal, resource)) return allow();
    return deny(
      hasVisibleRelationship(principal, resource) ? "ACTION_FORBIDDEN" : "RESOURCE_NOT_VISIBLE",
      true,
    );
  }

  if (action === "use") {
    if (hasAllowedUser(principal, resource) || hasAllowedOrg(principal, resource)) return allow();
    if (resource.consumerOrgId && principalOrgIds(principal).includes(resource.consumerOrgId)) {
      return allow();
    }
  }

  if (PROVIDER_ADMIN_RESOURCES.has(resource.resourceType)) {
    if (canProviderAdmin(principal, resource)) return allow();
    if (resource.providerOrgId == null && hasRole(principal.role, "org_admin")) return allow();
    return deny(
      hasVisibleRelationship(principal, resource) ? "ACTION_FORBIDDEN" : "RESOURCE_NOT_VISIBLE",
      true,
    );
  }

  if (OWNER_READ_RESOURCES.has(resource.resourceType) && isOwner(principal, resource))
    return allow();
  if (hasAllowedUser(principal, resource)) return allow();
  if (hasAllowedOrg(principal, resource)) return allow();
  if (resource.consumerOrgId && principalOrgIds(principal).includes(resource.consumerOrgId)) {
    return allow();
  }
  if (canProviderAdmin(principal, resource)) return allow();

  return deny("RESOURCE_NOT_VISIBLE", true);
}

export function ownershipHttpStatus(decision: OwnershipDecision): 401 | 403 | 404 {
  if (decision.allowed) return 403;
  if (decision.reason === "UNAUTHENTICATED") return 401;
  if (decision.conceal || decision.reason === "RESOURCE_NOT_VISIBLE") return 404;
  return 403;
}

export function principalOrgIds(principal: OwnershipPrincipal): string[] {
  const ids = principal.orgIds ?? (principal.orgId ? [principal.orgId] : []);
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function isPlatformWide(principal: OwnershipPrincipal): boolean {
  return hasRole(principal.role, "platform_admin");
}

function canProviderAdmin(principal: OwnershipPrincipal, resource: OwnedResource): boolean {
  if (!hasRole(principal.role, "org_admin")) return false;
  return !!resource.providerOrgId && principalOrgIds(principal).includes(resource.providerOrgId);
}

function hasVisibleRelationship(principal: OwnershipPrincipal, resource: OwnedResource): boolean {
  return (
    isOwner(principal, resource) ||
    hasAllowedUser(principal, resource) ||
    hasAllowedOrg(principal, resource) ||
    (!!resource.consumerOrgId && principalOrgIds(principal).includes(resource.consumerOrgId)) ||
    canProviderAdmin(principal, resource)
  );
}

function isOwner(principal: OwnershipPrincipal, resource: OwnedResource): boolean {
  return !!resource.ownerUserId && principal.userId === resource.ownerUserId;
}

function hasAllowedUser(principal: OwnershipPrincipal, resource: OwnedResource): boolean {
  return !!principal.userId && (resource.allowedUserIds ?? []).includes(principal.userId);
}

function hasAllowedOrg(principal: OwnershipPrincipal, resource: OwnedResource): boolean {
  const orgIds = principalOrgIds(principal);
  return (resource.allowedOrgIds ?? []).some((orgId) => orgIds.includes(orgId));
}

function allow(): OwnershipDecision {
  return { allowed: true };
}

function deny(reason: OwnershipDenyReason, conceal = false): OwnershipDecision {
  return { allowed: false, reason, conceal };
}
