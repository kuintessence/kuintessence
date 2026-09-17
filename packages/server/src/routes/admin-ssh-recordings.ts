/**
 * SSH session recording retrieval (PRD F17 audit follow-up).
 *
 * Recordings live in object storage at a deterministic key
 * (`ssh-recordings/<agentId>/<sessionId>.cast`); the `ssh_recordings` index
 * table backs browsing. Platform-wide admins can access all recordings;
 * provider org admins can access recordings for agents their org owns.
 * Every retrieval is itself audit-logged.
 *
 *   GET    /api/admin/ssh-recordings                       — list (metadata)
 *   GET    /api/admin/ssh-recordings/:agentId/:sessionId   — presigned cast URL
 *   DELETE /api/admin/ssh-recordings/:agentId/:sessionId   — delete blob + row
 *
 * The cast replays in any asciinema player; the web Settings → "SSH session
 * playback" view (SshRecordingPlayer) drives these endpoints.
 */
import type { PgDb } from "@kuintessence/db";
import { AppError, authorizeResourceAccess, ErrorCode } from "@kuintessence/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type AgentProviderOrgResolver,
  agentResourceFromProviderOrg,
  createAgentProviderOrgResolver,
  isPlatformPrincipal,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import {
  deleteRecordingRow,
  listRecordings,
  listRecordingsBySessionIds,
} from "../auth/ssh-recording-store";
import type { AuthzService } from "../authz/service";
import { type BoundPrincipal, hasAuditReadonlyCapability } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { resolveActorUserId, writeAudit } from "../services/audit-log-writer";
import { recordingKeyFor } from "../services/ssh-recording";

/** Minimal object-store surface the retrieval route needs. */
export interface RecordingRetrievalStore {
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  presignDownload(key: string, expiresInSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface AdminSshRecordingRouteOptions {
  /** Presigned-URL lifetime. Default 300s — long enough to open, short enough
   *  that the link is not a durable credential. */
  expiresSec?: number;
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  authz?: AuthzService;
}

export function createAdminSshRecordingRoutes(
  db: PgDb,
  store: RecordingRetrievalStore,
  opts: AdminSshRecordingRouteOptions = {},
): Hono {
  const expiresSec = opts.expiresSec ?? 300;
  const r = new Hono();
  const resolveAgentProviderOrg =
    opts.resolveAgentProviderOrg ?? createAgentProviderOrgResolver(db);

  async function recordingLocalAllowed(
    c: Context,
    agentId: string,
    action: "read" | "delete",
  ): Promise<boolean> {
    if (action === "read" && isAuditRecordingReader(c)) return true;
    const resource = agentResourceFromProviderOrg(
      agentId,
      "ssh_recording",
      await resolveAgentProviderOrg(agentId),
    );
    if (!resource) throw new AppError(ErrorCode.NOT_FOUND, "No recording for that session", 404);
    return authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, action).allowed;
  }

  r.get("/admin/ssh-recordings", async (c) => {
    assertLocalAdminSurface(c, opts.authz, "read");
    const actorUserId = requireCanonicalSshRecordingAdminActor(c);
    if (opts.authz?.mode === "enforce") {
      const visibleIds = await lookupSshRecordingIds(opts.authz, actorUserId);
      return c.json({ recordings: await listRecordingsBySessionIds(db, visibleIds) });
    }
    const recordings = await listRecordings(db);
    const visible: typeof recordings = [];
    for (const recording of recordings) {
      const resource = agentResourceFromProviderOrg(
        recording.agentId,
        "ssh_recording",
        await resolveAgentProviderOrg(recording.agentId),
      );
      if (!resource) continue;
      const localAllowed =
        isAuditRecordingReader(c) ||
        authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, "read").allowed;
      if (
        await checkSshRecordingPermission(c, opts.authz, recording.sessionId, "view", localAllowed)
      ) {
        visible.push(recording);
      }
    }
    return c.json({ recordings: visible });
  });

  r.get("/admin/ssh-recordings/:agentId/:sessionId", async (c) => {
    assertLocalAdminSurface(c, opts.authz, "read");
    const agentId = c.req.param("agentId");
    const sessionId = c.req.param("sessionId");
    if (!agentId || !sessionId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing agentId/sessionId", 400);
    }
    const actor = requireCanonicalSshRecordingAdminActor(c);

    const key = recordingKeyFor(agentId, sessionId);
    const stat = await store.head(key);
    if (!stat) {
      throw new AppError(ErrorCode.NOT_FOUND, "No recording for that session", 404);
    }
    const localAllowed = await recordingLocalAllowed(c, agentId, "read");
    await requireSshRecordingPermission(c, opts.authz, sessionId, "view", localAllowed);
    const url = await store.presignDownload(key, expiresSec);

    await writeAudit(db, {
      actor,
      action: "ssh.recording.access",
      target: `agent:${agentId}`,
      diff: { after: { sessionId, sizeBytes: stat.size } },
    });

    return c.json({ url, sizeBytes: stat.size, contentType: stat.contentType, expiresSec });
  });

  r.delete("/admin/ssh-recordings/:agentId/:sessionId", async (c) => {
    assertLocalAdminSurface(c, opts.authz, "delete");
    const agentId = c.req.param("agentId");
    const sessionId = c.req.param("sessionId");
    if (!agentId || !sessionId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing agentId/sessionId", 400);
    }
    const actor = requireCanonicalSshRecordingAdminActor(c);
    const key = recordingKeyFor(agentId, sessionId);
    const stat = await store.head(key);
    if (!stat) {
      throw new AppError(ErrorCode.NOT_FOUND, "No recording for that session", 404);
    }
    const localAllowed = await recordingLocalAllowed(c, agentId, "delete");
    await requireSshRecordingPermission(c, opts.authz, sessionId, "delete", localAllowed);
    await store.delete(key);
    await deleteRecordingRow(db, agentId, sessionId, {
      authz: opts.authz,
      resolveActorUserId: (actor) => resolveActorUserId(db, actor),
    });
    await writeAudit(db, {
      actor,
      action: "ssh.recording.delete",
      target: `agent:${agentId}`,
      diff: { after: { sessionId } },
    });
    return c.json({ ok: true }, 200);
  });

  return r;
}

async function lookupSshRecordingIds(authz: AuthzService, actorUserId: string): Promise<string[]> {
  try {
    return await authz.lookupResources({
      resourceType: "ssh_recording",
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

function assertLocalAdminSurface(
  c: Context,
  authz: AuthzService | undefined,
  action: "read" | "delete",
): void {
  if (authz?.mode === "enforce") return;
  if (action === "read" && isAuditRecordingReader(c)) return;
  assertRole(c, "org_admin");
}

function isAuditRecordingReader(c: Context): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return principal?.role === "operator" || hasAuditReadonlyCapability(principal);
}

function requireCanonicalSshRecordingAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function requireSshRecordingPermission(
  c: Context,
  authz: AuthzService | undefined,
  sessionId: string,
  permission: "view" | "delete",
  localAllowed: boolean,
): Promise<void> {
  if (authz?.mode !== "enforce" && !localAllowed) {
    throw new AppError(ErrorCode.NOT_FOUND, "Resource not found", 404);
  }
  if (!(await checkSshRecordingPermission(c, authz, sessionId, permission, localAllowed))) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
  }
}

async function checkSshRecordingPermission(
  c: Context,
  authz: AuthzService | undefined,
  sessionId: string,
  permission: "view" | "delete",
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
    resource: { type: "ssh_recording", id: sessionId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { route: `ssh_recording#${permission}` },
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
