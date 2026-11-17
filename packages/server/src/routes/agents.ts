import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentUpdateRequestSchema,
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
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzCheck, AuthzService } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { AgentManager } from "../services/agent-manager";
import type { AgentUpdateService } from "../services/agent-update";
import { siteReleaseSchema } from "./site-releases";

export interface AgentRouteOptions {
  authz?: AuthzService;
  updates?: Pick<AgentUpdateService, "list" | "request">;
  dispatcher?: Pick<AgentDispatcher, "getChannel">;
  siteReleasesDir?: string;
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
        ? principal.role === "operator" ||
          authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, "read").allowed
        : false;
      if (options.authz?.mode === "shadow") {
        await options.authz.shadowCheck(agentViewCheck(c, agent, localAllowed));
      }
      if (localAllowed) visible.push(agent);
    }
    return c.json({ agents: visible });
  });

  routes.get("/agents/:id", async (c) => {
    const principal = requireAgentPrincipal(c);
    const id = c.req.param("id");
    const agent = await agentManager.getById(id);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    const resource = agentResourceFromProviderOrg(agent.agentId, "agent", agent.providerOrgId);
    if (!resource) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    const localAllowed =
      principal.role === "operator" ||
      authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, "read").allowed;
    if (options.authz?.mode !== "enforce" && principal.role !== "operator") {
      assertOwnedResourceAccess(c, resource, "read");
    }
    if (!(await checkAgentThroughSpice(options.authz, c, agent, localAllowed))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this agent", 403);
    }
    return c.json(agent);
  });

  routes.get("/agents/:id/updates", async (c) => {
    const agent = await updateTarget(c, "read");
    return c.json({
      requests: ((await options.updates?.list(agent.agentId)) ?? []).map((entry) => ({
        requestId: entry.requestId,
        kind: entry.kind,
        release: entry.release,
        message: entry.message,
        state: entry.state,
        createdAt: entry.createdAt.toISOString(),
      })),
      supported: options.dispatcher?.getChannel(agent.agentId)?.agentUpdateV1 ?? false,
    });
  });

  routes.post("/agents/:id/updates", async (c) => {
    const agent = await updateTarget(c, "manage");
    const principal = requireAgentPrincipal(c);
    const body = AgentUpdateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid update request", 400);
    if (body.data.kind === "notice")
      await requirePlatformPermission(c, options.authz, "operate", "agent-update-notice");
    if (!options.updates || !options.siteReleasesDir)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Site release updates are unavailable", 409);
    const raw = await readFile(
      join(options.siteReleasesDir, "releases", body.data.release, "manifest.json"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    let valid = false;
    if (raw && raw.length <= 131072) {
      try {
        valid = siteReleaseSchema.safeParse(JSON.parse(raw.toString())).success;
      } catch {
        valid = false;
      }
    }
    if (
      !raw ||
      raw.length > 131072 ||
      createHash("sha256").update(raw).digest("hex") !== body.data.release ||
      !valid
    )
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Published site release is unavailable", 400);
    const request = await options.updates.request(agent.agentId, principal.userId, body.data);
    return c.json(request, 202);
  });

  async function updateTarget(c: Context, action: "read" | "manage") {
    const principal = requireAgentPrincipal(c);
    const agent = await agentManager.getById(c.req.param("id") ?? "");
    const resource =
      agent && agentResourceFromProviderOrg(agent.agentId, "agent", agent.providerOrgId);
    if (!agent || !resource) throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    if (hasRole(principal.role as RoleName, "operator")) {
      await requirePlatformPermission(c, options.authz, "operate", "agent-update");
    } else {
      assertOwnedResourceAccess(c, resource, action);
      if (
        !(await checkAgentThroughSpice(
          options.authz,
          c,
          agent,
          true,
          action === "manage" ? "manage" : "view",
        ))
      )
        throw new AppError(ErrorCode.FORBIDDEN, "Agent access denied", 403);
    }
    return agent;
  }

  return routes;
}

async function checkAgentThroughSpice(
  authz: AuthzService | undefined,
  c: Context,
  agent: AgentAuthzTarget,
  localAllowed: boolean,
  permission: "view" | "manage" = "view",
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const check = agentViewCheck(c, agent, localAllowed);
  check.permission = permission;
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
