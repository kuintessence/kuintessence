import { agents, type PgDb } from "@kuintessence/db";
import {
  AppError,
  authorizeResourceAccess,
  ErrorCode,
  type OwnedResource,
  type OwnedResourceType,
  type OwnershipAction,
  type OwnershipPrincipal,
  ownershipHttpStatus,
  type RoleName,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";

export type AgentProviderOrgResolver = (agentId: string) => Promise<string | null | undefined>;

export function ownershipPrincipalFromContext(c: Context): OwnershipPrincipal | null {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (principal) {
    return {
      sub: principal.sub,
      role: principal.role as RoleName,
      email: principal.email,
      userId: principal.userId,
      orgId: principal.orgId,
      orgIds: principal.orgIds,
    };
  }
  return null;
}

export function isPlatformPrincipal(c: Context): boolean {
  const principal = ownershipPrincipalFromContext(c);
  return principal
    ? principal.role === "platform_admin" || principal.role === "super_admin"
    : false;
}

export function assertOwnedResourceAccess(
  c: Context,
  resource: OwnedResource,
  action: OwnershipAction,
): void {
  const decision = authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, action);
  if (decision.allowed) return;
  const status = ownershipHttpStatus(decision);
  const code =
    status === 401
      ? ErrorCode.UNAUTHORIZED
      : status === 404
        ? ErrorCode.NOT_FOUND
        : ErrorCode.FORBIDDEN;
  const message =
    decision.reason === "RESOURCE_NOT_VISIBLE" ? "Resource not found" : "Resource access denied";
  throw new AppError(code, message, status);
}

export function agentResourceFromProviderOrg(
  agentId: string,
  resourceType: OwnedResourceType,
  providerOrgId: string | null | undefined,
): OwnedResource | null {
  if (providerOrgId === undefined) return null;
  return {
    resourceType,
    resourceId: `${resourceType}:${agentId}`,
    providerOrgId,
    agentId,
  };
}

export async function agentOwnedResource(
  db: PgDb,
  agentId: string,
  resourceType: OwnedResourceType,
): Promise<OwnedResource | null> {
  const [row] = await db
    .select({ providerOrgId: agents.providerOrgId })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);
  return agentResourceFromProviderOrg(agentId, resourceType, row?.providerOrgId);
}

export function createAgentProviderOrgResolver(db: PgDb): AgentProviderOrgResolver {
  return async (agentId) => {
    const [row] = await db
      .select({ providerOrgId: agents.providerOrgId })
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    return row?.providerOrgId;
  };
}
