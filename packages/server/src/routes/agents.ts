import {
  AppError,
  authorizeResourceAccess,
  ErrorCode,
  hasRole,
  type RoleName,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import {
  agentResourceFromProviderOrg,
  assertOwnedResourceAccess,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import type { AuthzCheck, AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { AgentManager } from "../services/agent-manager";

export interface AgentRouteOptions {
  authz?: AuthzService;
}

interface AgentAuthzTarget {
  agentId: string;
  providerOrgId: string | null;
}

export function createAgentRoutes(agentManager: AgentManager, options: AgentRouteOptions = {}) {
  const routes = new Hono();

  routes.get("/agents", async (c) => {
    const principal = requireAgentPrincipal(c);
    if (options.authz?.mode === "enforce") {
      let visibleIds: string[];
      try {
        visibleIds = await options.authz.lookupResources({
          resourceType: "agent",
          permission: "view",
          subject: { type: "user", id: principal.userId },
        });
      } catch (err) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
          403,
        );
      }
      return c.json({ agents: await agentManager.listByIds(visibleIds) });
    }
    const list = await agentManager.list();
    const visible: typeof list = [];
    for (const agent of list) {
      const resource = agentResourceFromProviderOrg(agent.agentId, "agent", agent.providerOrgId);
      const localAllowed = resource
        ? authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, "read").allowed
        : false;
      if (options.authz?.mode === "shadow") {
        await options.authz.shadowCheck(agentViewCheck(c, agent, localAllowed));
      }
      if (localAllowed) visible.push(agent);
    }
    return c.json({ agents: visible });
  });

  routes.get("/agents/:id", async (c) => {
    requireAgentPrincipal(c);
    const id = c.req.param("id");
    const agent = await agentManager.getById(id);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    const resource = agentResourceFromProviderOrg(agent.agentId, "agent", agent.providerOrgId);
    if (!resource) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    const localAllowed = authorizeResourceAccess(
      ownershipPrincipalFromContext(c),
      resource,
      "read",
    ).allowed;
    if (options.authz?.mode !== "enforce") {
      assertOwnedResourceAccess(c, resource, "read");
    }
    if (!(await checkAgentThroughSpice(options.authz, c, agent, localAllowed))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this agent", 403);
    }
    return c.json(agent);
  });

  return routes;
}

async function checkAgentThroughSpice(
  authz: AuthzService | undefined,
  c: Context,
  agent: AgentAuthzTarget,
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const check = agentViewCheck(c, agent, localAllowed);
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, isPlatformPrincipal(c));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

function agentViewCheck(
  c: Context,
  agent: AgentAuthzTarget,
  localAllowed: boolean,
): AuthzCheck & { localAllowed: boolean } {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = subjectIdForAgentAuthz(principal);
  return {
    actorUserId: principal?.userId ?? null,
    actorEmail: principal?.email ?? null,
    resource: { type: "agent", id: agent.agentId },
    permission: "view",
    subject: { type: "user", id: subjectId },
    context: { localAllowed, providerOrgId: agent.providerOrgId },
    localAllowed,
  };
}

function subjectIdForAgentAuthz(principal: BoundPrincipal | undefined): string {
  if (principal?.userId) return principal.userId;
  throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
}

function requireAgentPrincipal(c: Context): BoundPrincipal & { userId: string } {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!hasCanonicalUserId(principal)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal;
}

function hasCanonicalUserId(
  principal: BoundPrincipal | undefined,
): principal is BoundPrincipal & { userId: string } {
  return Boolean(principal?.userId);
}

function isPlatformPrincipal(c: Context): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return hasRole((principal?.role ?? "guest") as RoleName, "platform_admin");
}
