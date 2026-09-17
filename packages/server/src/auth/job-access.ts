import { hasRole, type RoleName } from "@kuintessence/shared";
import type { BoundOrgMembership } from "../middleware/principal-binder";

export type JobReadScope = "owner" | "consumer_admin" | "provider_operator" | "platform";

export interface JobAccessPrincipal {
  userId: string;
  role: RoleName;
  memberships: BoundOrgMembership[];
}

export interface JobAccessResource {
  submittedBy: string | null;
  consumerOrgId: string | null;
  providerOrgId: string | null;
}

const CONSUMER_ADMIN_ROLES = new Set(["owner", "admin"]);
const PROVIDER_OPERATOR_ROLES = new Set(["owner", "admin", "operator"]);

export function resolveJobReadScope(
  principal: JobAccessPrincipal,
  resource: JobAccessResource,
): JobReadScope | null {
  if (resource.submittedBy === principal.userId) return "owner";
  if (hasRole(principal.role, "platform_admin")) return "platform";
  if (
    resource.consumerOrgId &&
    principal.memberships.some(
      (membership) =>
        membership.orgId === resource.consumerOrgId && CONSUMER_ADMIN_ROLES.has(membership.role),
    )
  ) {
    return "consumer_admin";
  }
  if (
    resource.providerOrgId &&
    principal.memberships.some(
      (membership) =>
        membership.orgId === resource.providerOrgId && PROVIDER_OPERATOR_ROLES.has(membership.role),
    )
  ) {
    return "provider_operator";
  }
  return null;
}

export function jobVisibilityOrgScopes(memberships: BoundOrgMembership[]): {
  consumerAdminOrgIds: string[];
  providerOperatorOrgIds: string[];
} {
  return {
    consumerAdminOrgIds: memberships
      .filter((membership) => CONSUMER_ADMIN_ROLES.has(membership.role))
      .map((membership) => membership.orgId),
    providerOperatorOrgIds: memberships
      .filter((membership) => PROVIDER_OPERATOR_ROLES.has(membership.role))
      .map((membership) => membership.orgId),
  };
}
