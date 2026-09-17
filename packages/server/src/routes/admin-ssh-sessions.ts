/**
 * live SSH session monitoring (PRD F17 audit follow-up).
 *
 * Platform-wide admins can see all live SSH sessions; provider org admins can
 * see and force-close sessions on agents their org owns. No secrets or
 * transcript bytes are exposed — only the connection metadata the gateway
 * already tracks. Every force-disconnect is audit-logged.
 *
 *   GET    /api/admin/ssh-sessions             — live sessions
 *   DELETE /api/admin/ssh-sessions/:sessionId  — force-close one
 */
import type { PgDb } from "@kuintessence/db";
import { AppError, authorizeResourceAccess, ErrorCode } from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import {
  type AgentProviderOrgResolver,
  agentResourceFromProviderOrg,
  createAgentProviderOrgResolver,
  isPlatformPrincipal,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { writeAudit } from "../services/audit-log-writer";
import type { SshGateway } from "../services/ssh-gateway";

export interface AdminSshSessionRouteOptions {
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  authz?: AuthzService;
}

export function createAdminSshSessionRoutes(
  db: PgDb,
  gateway: SshGateway,
  opts: AdminSshSessionRouteOptions = {},
): Hono {
  const r = new Hono();
  const resolveAgentProviderOrg =
    opts.resolveAgentProviderOrg ?? createAgentProviderOrgResolver(db);

  r.get("/admin/ssh-sessions", async (c) => {
    assertLocalAdminSurface(c, opts.authz);
    const actorUserId = requireCanonicalSshSessionAdminActor(c);
    if (opts.authz?.mode === "enforce") {
      const visibleIds = await lookupSshSessionIds(opts.authz, actorUserId);
      if (visibleIds.length === 0) return c.json({ sessions: [] });
      const visible = new Set(visibleIds);
      return c.json({
        sessions: gateway.listSessions().filter((session) => visible.has(session.sessionId)),
      });
    }
    const sessions = gateway.listSessions();
    const visible = [];
    for (const session of sessions) {
      const resource = agentResourceFromProviderOrg(
        session.agentId,
        "ssh_session",
        await resolveAgentProviderOrg(session.agentId),
      );
      if (!resource) continue;
      const localAllowed = authorizeResourceAccess(
        ownershipPrincipalFromContext(c),
        resource,
        "read",
      ).allowed;
      if (await checkSshSessionPermission(c, opts.authz, session.sessionId, "view", localAllowed)) {
        visible.push(session);
      }
    }
    return c.json({ sessions: visible });
  });

  r.delete("/admin/ssh-sessions/:sessionId", async (c) => {
    assertLocalAdminSurface(c, opts.authz);
    const actorUserId = requireCanonicalSshSessionAdminActor(c);
    const sessionId = c.req.param("sessionId");
    if (!sessionId) throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing sessionId", 400);
    const session = gateway.listSessions().find((s) => s.sessionId === sessionId);
    if (!session) {
      throw new AppError(ErrorCode.NOT_FOUND, "No such active session", 404);
    }
    const resource = agentResourceFromProviderOrg(
      session.agentId,
      "ssh_session",
      await resolveAgentProviderOrg(session.agentId),
    );
    if (!resource) throw new AppError(ErrorCode.NOT_FOUND, "No such active session", 404);
    const localAllowed = authorizeResourceAccess(
      ownershipPrincipalFromContext(c),
      resource,
      "close",
    ).allowed;
    await requireSshSessionPermission(c, opts.authz, sessionId, "close", localAllowed);

    gateway.closeSession(sessionId, `force-closed by ${actorUserId}`);
    await writeAudit(db, {
      actor: actorUserId,
      action: "ssh.session.force_close",
      target: `session:${sessionId}`,
      diff: { after: { forcedBy: actorUserId } },
    });
    return c.json({ ok: true }, 200);
  });

  return r;
}

async function lookupSshSessionIds(authz: AuthzService, actorUserId: string): Promise<string[]> {
  try {
    return await authz.lookupResources({
      resourceType: "ssh_session",
      permission: "view",
      subject: { type: "user", id: actorUserId },
    });
  } catch (err) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
      403,
    );
  }
}

function requireCanonicalSshSessionAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

function assertLocalAdminSurface(c: Context, authz: AuthzService | undefined): void {
  if (authz?.mode === "enforce") return;
  assertRole(c, "org_admin");
}

async function requireSshSessionPermission(
  c: Context,
  authz: AuthzService | undefined,
  sessionId: string,
  permission: "view" | "close",
  localAllowed: boolean,
): Promise<void> {
  if (authz?.mode !== "enforce" && !localAllowed) {
    throw new AppError(ErrorCode.NOT_FOUND, "Resource not found", 404);
  }
  if (!(await checkSshSessionPermission(c, authz, sessionId, permission, localAllowed))) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
  }
}

async function checkSshSessionPermission(
  c: Context,
  authz: AuthzService | undefined,
  sessionId: string,
  permission: "view" | "close",
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = principal?.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: subjectId,
    actorEmail: principal.email,
    resource: { type: "ssh_session", id: sessionId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { route: `ssh_session#${permission}` },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
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
