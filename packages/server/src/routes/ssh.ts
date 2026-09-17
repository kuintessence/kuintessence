import { randomUUID } from "node:crypto";
import { auditLog as auditLogTable, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import {
  AppError,
  authorizeResourceAccess,
  createLogger,
  ErrorCode,
  hasRole,
  Role,
  type RoleName,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type AgentProviderOrgResolver,
  agentResourceFromProviderOrg,
  createAgentProviderOrgResolver,
} from "../auth/ownership";
import { RESOLVED_CLIENT_IP_HEADER } from "../auth/trusted-proxy";
import { authenticateWs } from "../auth/ws-token";
import {
  sshSessionAgentTuple,
  sshSessionOpenerTuple,
  sshSessionPlatformTuple,
} from "../authz/projection";
import type { AuthzService } from "../authz/service";
import { recordIdentityFallback } from "../observability/identity-fallback";
import { resolveActorOrgId } from "../services/audit-log-writer";
import type { TokenPayload } from "../services/auth";
import {
  type SshAuditEvent,
  type SshCredentials,
  type SshGateway,
  SshLimitError,
} from "../services/ssh-gateway";

const logger = createLogger("ssh-routes");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// Route deps
// -----------------------------------------------------------------------------

interface WSContextLike {
  send(data: string | ArrayBufferView | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
}

type WSEvents = {
  onOpen?: (evt: Event, ws: WSContextLike) => void;
  onMessage?: (evt: MessageEvent<unknown>, ws: WSContextLike) => void;
  onClose?: (evt: CloseEvent, ws: WSContextLike) => void;
  onError?: (evt: Event, ws: WSContextLike) => void;
};
type UpgradeWebSocketFn = (
  createEvents: (c: Context) => WSEvents | Promise<WSEvents>,
) => MiddlewareHandler;

export interface SshRoutesDeps {
  db: PgDb;
  jwtSecret: string;
  gateway: SshGateway;
  /** Bun adapter helper. Production: `import { upgradeWebSocket } from "hono/bun"`. */
  upgrade?: UpgradeWebSocketFn;
  /**
   * Resolve cluster credentials for the given agent. Production injects the
   * encrypted vault resolver (`makeVaultResolver` over the `ssh_credentials`
   * table — see `auth/ssh-credential-vault.ts` / `ssh-credential-store.ts`).
   * When omitted, this falls back to {@link envCredentialResolver}, a dev-only
   * `SSH_CRED_<AGENT_ID>` env mock.
   */
  resolveCredentials?: (agentId: string) => SshCredentials | null | Promise<SshCredentials | null>;
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  resolveUserOrgIds?: (actor: ResolvedSshActor | null, user: TokenPayload) => Promise<string[]>;
  resolveUserProviderAdminOrgIds?: (
    actor: ResolvedSshActor | null,
    user: TokenPayload,
  ) => Promise<string[]>;
  authz?: AuthzService;
}

/**
 * RBAC for `/api/ssh/sessions/:agentId`:
 *
 *   - super_admin / platform_admin → any registered agent
 *   - org_admin                    → agents owned by its provider org
 *   - user / guest                 → DENIED
 *
 * SSH access is a privileged operation — we deliberately do not let
 * regular users open shells on cluster login nodes from the Web UI.
 * `kq ssh` will inherit the same gate when wired up.
 */
function authorizeSshAccess(
  actor: ResolvedSshActor | null,
  providerAdminMembership: boolean,
): asserts actor is ResolvedSshActor {
  if (!actor || (!hasTechnicalSshRole(actor) && !providerAdminMembership)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "SSH access requires org_admin or provider owner/admin membership",
      403,
    );
  }
}

export type ResolvedSshActor = { userId: string; role: RoleName; email: string };

async function defaultUserOrgIds(db: PgDb, actor: ResolvedSshActor | null): Promise<string[]> {
  if (!actor) return [];
  try {
    const rows = await db
      .select({ orgId: userOrgMemberships.orgId })
      .from(userOrgMemberships)
      .where(eq(userOrgMemberships.userId, actor.userId))
      .limit(1000);
    return [...new Set(rows.map((row) => row.orgId))];
  } catch {
    return [];
  }
}

async function defaultUserProviderAdminOrgIds(
  db: PgDb,
  actor: ResolvedSshActor | null,
): Promise<string[]> {
  if (!actor) return [];
  try {
    const rows = await db
      .select({ orgId: userOrgMemberships.orgId, role: userOrgMemberships.role })
      .from(userOrgMemberships)
      .where(eq(userOrgMemberships.userId, actor.userId))
      .limit(1000);
    return [
      ...new Set(
        rows.filter(({ role }) => role === "owner" || role === "admin").map(({ orgId }) => orgId),
      ),
    ];
  } catch {
    return [];
  }
}

interface LocalSshAccess {
  allowed: boolean;
  error?: AppError;
}

async function evaluateLocalSshAgentAccess(
  actor: ResolvedSshActor | null,
  agentId: string,
  resolveAgentProviderOrg: AgentProviderOrgResolver,
  userOrgIds: string[],
  providerAdminOrgIds: string[],
): Promise<LocalSshAccess> {
  if (!actor || (!hasTechnicalSshRole(actor) && providerAdminOrgIds.length === 0)) {
    try {
      authorizeSshAccess(actor, false);
    } catch (err) {
      if (err instanceof AppError) return { allowed: false, error: err };
      throw err;
    }
  }
  const providerOrgId = await resolveAgentProviderOrg(agentId);
  const providerAdminMembership =
    typeof providerOrgId === "string" && providerAdminOrgIds.includes(providerOrgId);
  try {
    authorizeSshAccess(actor, providerAdminMembership);
  } catch (err) {
    if (err instanceof AppError) return { allowed: false, error: err };
    throw err;
  }
  const resource = agentResourceFromProviderOrg(agentId, "agent", providerOrgId);
  if (!resource) {
    return {
      allowed: false,
      error: new AppError(ErrorCode.NOT_FOUND, `agent ${agentId} not found`, 404),
    };
  }
  if (providerAdminMembership && !hasTechnicalSshRole(actor)) return { allowed: true };
  const decision = authorizeResourceAccess(
    {
      sub: actor.userId,
      role: actor.role as RoleName,
      email: actor.email,
      userId: actor.userId,
      orgIds: userOrgIds,
    },
    resource,
    "read",
  );
  if (!decision.allowed) {
    return {
      allowed: false,
      error: new AppError(ErrorCode.NOT_FOUND, `agent ${agentId} not found`, 404),
    };
  }
  return { allowed: true };
}

function hasTechnicalSshRole(actor: ResolvedSshActor): boolean {
  return (
    hasRole(actor.role, Role.ORG_ADMIN) ||
    hasRole(actor.role, Role.PLATFORM_ADMIN) ||
    hasRole(actor.role, Role.SUPER_ADMIN)
  );
}

// -----------------------------------------------------------------------------
// Default credential resolver — env-driven mock
// -----------------------------------------------------------------------------

/**
 * Mock credential vault. Reads `SSH_CRED_<AGENT_ID>` (uppercased, dashes
 * replaced with underscores) as a JSON blob. Returns null when the env
 * var is missing or malformed — the route then closes the WS with 4404.
 *
 * **NOT FOR PRODUCTION** — a real vault must encrypt credentials at rest,
 * rotate them, scope them per-agent, and audit every read. The production
 * resolver (`makeVaultResolver` over `ssh_credentials`) does exactly that;
 * this mock exists only for local dev when no vault row is configured.
 */
export function envCredentialResolver(agentId: string): SshCredentials | null {
  const key = `SSH_CRED_${agentId.toUpperCase().replace(/-/g, "_")}`;
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.username !== "string"
    ) {
      logger.warn({ key }, "SSH credential env is missing host/port/username");
      return null;
    }
    return {
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: typeof parsed.password === "string" ? parsed.password : undefined,
      privateKey: typeof parsed.privateKey === "string" ? parsed.privateKey : undefined,
      passphrase: typeof parsed.passphrase === "string" ? parsed.passphrase : undefined,
    };
  } catch (err) {
    logger.warn({ err, key }, "SSH credential env is not valid JSON");
    return null;
  }
}

// -----------------------------------------------------------------------------
// Audit-log adapter
// -----------------------------------------------------------------------------

function makeAuditLogger(db: PgDb) {
  return async (event: SshAuditEvent): Promise<void> => {
    const action = event.kind === "session_open" ? "ssh.session_open" : "ssh.session_close";
    const target = `agent:${event.agentId}`;
    const diff: Record<string, unknown> = {
      after: {
        sessionId: event.sessionId,
        ...(event.kind === "session_open" ? { sourceIp: event.sourceIp } : null),
        ...(event.kind === "session_close"
          ? { reason: event.reason, durationMs: event.durationMs }
          : null),
      },
    };
    await db.insert(auditLogTable).values({
      actor: event.user,
      orgId: await resolveActorOrgId(db, event.user),
      action,
      target,
      diff,
    });
  };
}

// -----------------------------------------------------------------------------
// Route
// -----------------------------------------------------------------------------

/**
 * Build /api/ssh/sessions/:agentId.
 *
 * Auth + RBAC + agent-online check run synchronously BEFORE the upgrade
 * is attempted. The audit-log SESSION_OPEN row is written before the WS
 * upgrade so we capture intent even when the upgrade itself fails.
 */
export function createSshRoutes(deps: SshRoutesDeps) {
  const r = new Hono();
  const resolve = deps.resolveCredentials ?? envCredentialResolver;
  const resolveAgentProviderOrg =
    deps.resolveAgentProviderOrg ?? createAgentProviderOrgResolver(deps.db);
  const resolveUserOrgIds =
    deps.resolveUserOrgIds ?? ((actor) => defaultUserOrgIds(deps.db, actor));
  const resolveUserProviderAdminOrgIds =
    deps.resolveUserProviderAdminOrgIds ??
    ((actor) => defaultUserProviderAdminOrgIds(deps.db, actor));
  const audit = makeAuditLogger(deps.db);

  r.get("/sessions/:agentId", async (c, next) => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing agentId", 400);
    }
    const user = await authenticateWs(c, deps.jwtSecret, deps.db);
    const boundActor = await resolveSshActor(deps.db, user);
    const [boundOrgIds, providerAdminOrgIds] = await Promise.all([
      resolveUserOrgIds(boundActor, user),
      resolveUserProviderAdminOrgIds(boundActor, user),
    ]);
    const localAccess = await evaluateLocalSshAgentAccess(
      boundActor,
      agentId,
      resolveAgentProviderOrg,
      boundOrgIds,
      providerAdminOrgIds,
    );
    const actorUserId = boundActor?.userId ?? null;
    const auditActor = canonicalSshAuditActor(actorUserId);
    const authorizedSessionId = randomUUID();
    let provisionalAuthorization = false;
    if (deps.authz) {
      await authorizeSshThroughSpice(
        deps.authz,
        user,
        actorUserId,
        agentId,
        authorizedSessionId,
        localAccess.allowed,
        boundActor?.role ?? null,
        boundActor?.email ?? null,
      );
      provisionalAuthorization = deps.authz.mode !== "off";
    }
    let creds: SshCredentials | null;
    try {
      if (deps.authz?.mode !== "enforce" && !localAccess.allowed) {
        throw localAccess.error ?? new AppError(ErrorCode.FORBIDDEN, "SSH access denied", 403);
      }
      try {
        creds = await resolve(agentId);
      } catch (err) {
        logger.error(
          { err, agentId },
          "Failed to resolve SSH credentials (decryption failure? key rotated?)",
        );
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `SSH credentials for agent ${agentId} could not be decrypted — re-enter them if the wrapping key was rotated`,
          502,
        );
      }
      if (!creds) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          `No SSH credentials configured for agent ${agentId}`,
          404,
        );
      }
    } catch (err) {
      if (provisionalAuthorization) {
        try {
          await cleanupSshSessionAuthorization(deps.authz, authorizedSessionId, agentId);
        } catch (cleanupErr) {
          logger.warn(
            { err: cleanupErr, sessionId: authorizedSessionId },
            "Failed to cleanup provisional SSH authorization",
          );
        }
      }
      throw err;
    }
    if (!deps.upgrade) {
      // Test path — the gate accepted the caller; in production Bun
      // upgrades. We still try-open the session against the gateway so
      // tests can assert the dispatcher push happens, then immediately
      // close so we don't leak.
      try {
        const sessionId = deps.gateway.openSession({
          sessionId: authorizedSessionId,
          agentId,
          ws: createNoopWs(),
          credentials: creds,
          user: auditActor,
          actorUserId,
          sourceIp: extractSourceIp(c),
        });
        await enqueueSshSessionTuples(deps.authz, sessionId, agentId, actorUserId);
        // Write the audit-log row here too — it's normally written
        // inside the gateway's auditLog hook, but the test path bypasses
        // that hook to keep DB writes deterministic. We mirror it here.
        await audit({
          kind: "session_open",
          sessionId,
          agentId,
          user: auditActor,
          sourceIp: extractSourceIp(c),
          ts: new Date(),
        });
        deps.gateway.closeSession(sessionId, "test-path");
        return c.body(null, 200);
      } catch (err) {
        await cleanupSshSessionAuthorization(deps.authz, authorizedSessionId, agentId);
        if (err instanceof SshLimitError) {
          throw new AppError(ErrorCode.RATE_LIMITED, err.message, 429);
        }
        if (err instanceof Error && err.message.includes("not online")) {
          throw new AppError(ErrorCode.NOT_FOUND, `agent ${agentId} is offline`, 404);
        }
        throw err;
      }
    }

    const handler = deps.upgrade((_ctx) => {
      let sessionId: string | null = null;
      const sourceIp = extractSourceIp(c);
      return {
        onOpen: (_evt, ws) => {
          try {
            sessionId = deps.gateway.openSession({
              sessionId: authorizedSessionId,
              agentId,
              ws,
              credentials: creds,
              user: auditActor,
              actorUserId,
              sourceIp,
            });
            enqueueSshSessionTuples(deps.authz, sessionId, agentId, actorUserId).catch((err) => {
              logger.warn({ err, sessionId }, "Failed to enqueue SpiceDB SSH session tuples");
            });
            audit({
              kind: "session_open",
              sessionId,
              agentId,
              user: auditActor,
              sourceIp,
              ts: new Date(),
            }).catch((err) => {
              logger.error({ err, sessionId }, "Failed to audit-log session_open");
            });
          } catch (err) {
            cleanupSshSessionAuthorization(deps.authz, authorizedSessionId, agentId).catch(
              (cleanupErr) => {
                logger.warn(
                  { err: cleanupErr, sessionId: authorizedSessionId },
                  "Failed to cleanup SpiceDB SSH session authorization tuple",
                );
              },
            );
            logger.warn({ err, agentId }, "Failed to open SSH session — closing WS");
            const code = err instanceof SshLimitError ? 4429 : 4404;
            ws.close(code, err instanceof Error ? err.message : "open failed");
          }
        },
        onMessage: (evt, _ws) => {
          if (!sessionId) return;
          // A JSON text frame `{type:"resize",cols,rows}` is a control message;
          // everything else (the browser sends keystrokes as binary frames) is
          // raw stdin forwarded verbatim.
          const resize = parseResizeFrame(evt.data);
          if (resize) {
            deps.gateway.forwardResize(sessionId, resize.cols, resize.rows);
            return;
          }
          const data = coerceWsBytes(evt.data);
          if (data) deps.gateway.forwardClientData(sessionId, data);
        },
        onClose: () => {
          if (sessionId) {
            deps.gateway.closeSession(sessionId, "client closed");
            sessionId = null;
          }
        },
        onError: () => {
          if (sessionId) {
            deps.gateway.closeSession(sessionId, "ws error");
            sessionId = null;
          }
        },
      };
    });
    return handler(c, next);
  });

  return r;
}

export async function authorizeSshThroughSpice(
  authz: AuthzService | undefined,
  _user: TokenPayload,
  actorUserId: string | null,
  agentId: string,
  sessionId: string,
  localAllowed: boolean,
  platformFallbackRole: string | null = null,
  actorEmail: string | null = null,
): Promise<void> {
  if (!authz || authz.mode === "off") return;
  const subjectId = subjectIdForSshOpenAuthz(actorUserId);
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId,
    actorEmail,
    resource: { type: "ssh_session", id: sessionId },
    permission: "open",
    subject: { type: "user", id: subjectId },
    context: { route: "GET /ssh/sessions/:agentId" },
  };
  try {
    await authz.writeRelationships([
      sshSessionAgentTuple({ sessionId, agentId }),
      sshSessionPlatformTuple(sessionId),
    ]);
  } catch (err) {
    if (authz.mode === "shadow") {
      await authz.recordDiff({ ...check, localAllowed }, false, errorMessage(err));
      return;
    }
    throw new AppError(ErrorCode.FORBIDDEN, `Authorization unavailable: ${errorMessage(err)}`, 403);
  }
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return;
  }
  try {
    await authz.requirePermission(
      check,
      hasRole((platformFallbackRole ?? "guest") as RoleName, "platform_admin"),
    );
  } catch (err) {
    await cleanupSshSessionAuthorization(authz, sessionId, agentId);
    throw err;
  }
}

async function resolveSshActor(
  db: PgDb,
  user: Pick<TokenPayload, "sub" | "email">,
): Promise<ResolvedSshActor | null> {
  if (!UUID_RE.test(user.sub)) {
    recordIdentityFallback("ssh_ws");
  }
  const lookupKey = sshActorLookupKey(user);
  const [row] = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(UUID_RE.test(lookupKey) ? eq(users.id, lookupKey) : eq(users.email, lookupKey))
    .limit(1);
  return row ? { userId: row.id, role: row.role as RoleName, email: row.email } : null;
}

function canonicalSshAuditActor(actorUserId: string | null): string {
  if (!actorUserId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return actorUserId;
}

async function cleanupSshSessionAuthorization(
  authz: AuthzService | undefined,
  sessionId: string,
  agentId: string,
): Promise<void> {
  if (!authz || authz.mode === "off") return;
  await authz.writeRelationships([
    { ...sshSessionAgentTuple({ sessionId, agentId }), operation: "delete" },
    { ...sshSessionPlatformTuple(sessionId), operation: "delete" },
  ]);
}

async function enqueueSshSessionTuples(
  authz: AuthzService | undefined,
  sessionId: string,
  agentId: string,
  actorUserId: string | null,
): Promise<void> {
  if (!authz || !actorUserId) return;
  await authz.enqueueMany([
    sshSessionAgentTuple({ sessionId, agentId }),
    sshSessionOpenerTuple({ sessionId, userId: actorUserId }),
    sshSessionPlatformTuple(sessionId),
  ]);
}

export function sshActorLookupKey(user: Pick<TokenPayload, "sub" | "email">): string {
  return UUID_RE.test(user.sub) ? user.sub : user.email;
}

function subjectIdForSshOpenAuthz(actorUserId: string | null): string | null {
  return actorUserId;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractSourceIp(c: Context): string | undefined {
  return c.req.header(RESOLVED_CLIENT_IP_HEADER) ?? undefined;
}

/**
 * Recognise a PTY resize control frame: a JSON *string* of the shape
 * `{ "type": "resize", "cols": <int>, "rows": <int> }`. Returns null for
 * anything else (binary stdin, malformed JSON, out-of-range dims) so the
 * caller falls through to forwarding raw bytes. Bounds keep a hostile client
 * from sending absurd window sizes to the remote PTY.
 */
export function parseResizeFrame(data: unknown): { cols: number; rows: number } | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.type !== "resize") return null;
  const { cols, rows } = o;
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return null;
  return { cols, rows };
}

function coerceWsBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data && typeof data === "object" && "buffer" in (data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function createNoopWs(): WSContextLike {
  return {
    send: () => {},
    close: () => {},
  };
}
