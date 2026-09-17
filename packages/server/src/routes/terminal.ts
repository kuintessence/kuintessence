import {
  AppError,
  authorizeResourceAccess,
  ErrorCode,
  hasRole,
  type RoleName,
  TerminalExecSchema,
  TerminalResizeSchema,
  TerminalSessionCreateSchema,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import {
  type AgentProviderOrgResolver,
  agentResourceFromProviderOrg,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import type { AuthzCheck, AuthzService } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { ShellExecRegistry } from "../services/shell-exec-registry";
import type { TerminalService } from "../services/terminal-service";

export interface TerminalRoutesDeps {
  dispatcher?: AgentDispatcher;
  shellExecRegistry?: ShellExecRegistry;
  authz?: AuthzService;
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  shellExecTimeoutMs?: number;
}

export function createTerminalRoutes(service: TerminalService, deps: TerminalRoutesDeps = {}) {
  const routes = new Hono();
  const { dispatcher, shellExecRegistry } = deps;

  routes.get("/terminal/sessions", (c) => {
    const actorUserId = requireTerminalActorUserId(c);
    return c.json({ sessions: service.list(actorUserId) });
  });

  routes.post(
    "/terminal/sessions",
    kqValidator("json", TerminalSessionCreateSchema, "Invalid terminal session body"),
    async (c) => {
      const data = c.req.valid("json");
      const actorUserId = requireTerminalActorUserId(c);
      const localAccess = await resolveLocalAgentAccess(c, deps, data.agentId);
      await requireAgentOperate(
        c,
        deps.authz,
        data.agentId,
        "terminal-session-create",
        localAccess,
      );
      assertAgentOnline(dispatcher, data.agentId);
      const session = service.create(actorUserId, data);
      return c.json(session, 201);
    },
  );

  routes.get("/terminal/sessions/:id", (c) => {
    const actorUserId = requireTerminalActorUserId(c);
    return c.json(service.get(actorUserId, c.req.param("id")));
  });

  routes.delete("/terminal/sessions/:id", (c) => {
    const actorUserId = requireTerminalActorUserId(c);
    return c.json(service.close(actorUserId, c.req.param("id")));
  });

  routes.get("/terminal/sessions/:id/audit", (c) => {
    const actorUserId = requireTerminalActorUserId(c);
    return c.json({ frames: service.audit(actorUserId, c.req.param("id")) });
  });

  routes.post(
    "/terminal/sessions/:id/exec",
    kqValidator("json", TerminalExecSchema, "Invalid terminal exec body"),
    async (c) => {
      const actorUserId = requireTerminalActorUserId(c);
      const { input } = c.req.valid("json");
      const sessionId = c.req.param("id");
      const session = service.get(actorUserId, sessionId);
      const localAccess = await resolveLocalAgentAccess(c, deps, session.agentId);
      await requireAgentOperate(c, deps.authz, session.agentId, "terminal-exec", localAccess);
      assertAgentOnline(dispatcher, session.agentId);

      const trimmed = input.replace(/\r?\n$/, "");
      if (trimmed.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Terminal command must not be empty", 400);
      }
      if (!dispatcher || !shellExecRegistry) throwTerminalUnavailable(session.agentId);

      const requestId = crypto.randomUUID();
      const timeoutMs = deps.shellExecTimeoutMs ?? 30_000;
      const pending = shellExecRegistry.await(requestId, timeoutMs);
      const queued = dispatcher.pushShellExec(session.agentId, requestId, trimmed, 30);
      if (!queued) {
        shellExecRegistry.discard(requestId);
        throwTerminalUnavailable(session.agentId);
      }

      try {
        const result = await pending;
        const realOutput = `${result.stdout}${result.stderr}`;
        return c.json(service.recordExec(actorUserId, sessionId, input, realOutput));
      } catch {
        throw new AppError(ErrorCode.AGENT_OFFLINE, "Terminal command did not complete", 504, {
          reason: "TERMINAL_EXEC_TIMEOUT",
          agentId: session.agentId,
        });
      }
    },
  );

  routes.post(
    "/terminal/sessions/:id/resize",
    kqValidator("json", TerminalResizeSchema, "Invalid terminal resize body"),
    (c) => {
      const actorUserId = requireTerminalActorUserId(c);
      const { cols, rows } = c.req.valid("json");
      return c.json(service.resize(actorUserId, c.req.param("id"), cols, rows));
    },
  );

  // This terminal uses HTTP execution; interactive SSH has a separate endpoint.
  routes.get("/terminal/ws/:id", () => {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "WebSocket terminal streaming is unavailable; use POST /terminal/sessions/:id/exec",
      501,
    );
  });

  return routes;
}

function assertAgentOnline(dispatcher: AgentDispatcher | undefined, agentId: string): void {
  if (!dispatcher?.isOnline(agentId)) {
    throwTerminalUnavailable(agentId);
  }
}

function throwTerminalUnavailable(agentId: string): never {
  throw new AppError(ErrorCode.AGENT_OFFLINE, `Agent ${agentId} is not online`, 503, {
    reason: "TERMINAL_AGENT_UNAVAILABLE",
    agentId,
  });
}

function requireTerminalActorUserId(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function requireAgentOperate(
  c: Context,
  authz: AuthzService | undefined,
  agentId: string,
  source: string,
  localAccess: LocalAgentAccess,
): Promise<void> {
  const check = agentOperateCheck(c, agentId, source, localAccess.allowed);
  if (!check) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  if (!authz || authz.mode === "off") {
    assertLocalAgentAccess(localAccess);
    return;
  }
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    assertLocalAgentAccess(localAccess);
    return;
  }
  await authz.requirePermission(check, isPlatformPrincipal(c));
  if (!localAccess.exists) {
    throw new AppError(ErrorCode.NOT_FOUND, `Agent ${agentId} not found`, 404);
  }
}

interface LocalAgentAccess {
  allowed: boolean;
  exists: boolean;
}

async function resolveLocalAgentAccess(
  c: Context,
  deps: TerminalRoutesDeps,
  agentId: string,
): Promise<LocalAgentAccess> {
  if (!deps.resolveAgentProviderOrg) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Terminal authorization is unavailable", 503);
  }
  const providerOrgId = await deps.resolveAgentProviderOrg(agentId);
  const resource = agentResourceFromProviderOrg(agentId, "agent", providerOrgId);
  if (!resource) return { allowed: false, exists: false };
  return {
    allowed: authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, "manage").allowed,
    exists: true,
  };
}

function assertLocalAgentAccess(access: LocalAgentAccess): void {
  if (!access.exists || !access.allowed) {
    throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
  }
}

function agentOperateCheck(
  c: Context,
  agentId: string,
  source: string,
  localAllowed: boolean,
): (AuthzCheck & { localAllowed: boolean }) | null {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = principal?.userId;
  if (!subjectId) return null;
  return {
    actorUserId: subjectId,
    actorEmail: principal?.email ?? null,
    resource: { type: "agent", id: agentId },
    permission: "operate",
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source },
    localAllowed,
  };
}

function isPlatformPrincipal(c: Context): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return hasRole((principal?.role ?? "guest") as RoleName, "platform_admin");
}
