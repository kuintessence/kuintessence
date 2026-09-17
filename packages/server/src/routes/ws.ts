import { jobs, type PgDb, userOrgMemberships, users, workflowRuns } from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  hasRole,
  Role,
  type RoleName,
} from "@kuintessence/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { resolveJobReadScope } from "../auth/job-access";
import { authenticateWs } from "../auth/ws-token";
import type { AuthzService } from "../authz/service";
import type {
  EventBus,
  JobStatusChangedEvent,
  WorkflowStateChangedEvent,
} from "../events/event-bus";
import { parseUuidParam } from "../middleware/uuid-param";
import { recordIdentityFallback } from "../observability/identity-fallback";
import type { TokenPayload } from "../services/auth";

const logger = createLogger("ws-routes");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dependencies the WS routes need. Kept narrow so tests can swap them.
 *
 * `upgrade` is the Bun adapter helper (`upgradeWebSocket` from `hono/bun`).
 * It's optional because, in unit tests, we don't run a real Bun server — the
 * route's auth/RBAC checks must still execute and reject before the upgrade
 * is ever attempted. The production wire-up in `index.ts` injects it.
 */
export interface WsAuthDependencies {
  db: PgDb;
  jwtSecret: string;
  bus: EventBus;
  authz?: AuthzService;
  /** Bun adapter helper. Production: `import { upgradeWebSocket } from "hono/bun"`. */
  upgrade?: UpgradeWebSocketFn;
}

// Hono's `upgradeWebSocket` from the bun adapter, narrowed so we don't depend
// on the helper at unit-test time.
import type { Context, MiddlewareHandler } from "hono";

type WSEvents = {
  onOpen?: (evt: Event, ws: WSContextLike) => void;
  onMessage?: (evt: MessageEvent<unknown>, ws: WSContextLike) => void;
  onClose?: (evt: CloseEvent, ws: WSContextLike) => void;
  onError?: (evt: Event, ws: WSContextLike) => void;
};
interface WSContextLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
type UpgradeWebSocketFn = (
  createEvents: (c: Context) => WSEvents | Promise<WSEvents>,
) => MiddlewareHandler;

/**
 * Resolve the caller's user UUID. Tokens carry the EMAIL in `sub` (see
 * auth.ts signToken), but ownership columns store the user UUID — so we look it
 * up by email, mirroring the REST job/workflow routes. Returns null if the JWT
 * subject has no matching user row.
 */
async function resolveCaller(
  db: PgDb,
  user: TokenPayload,
): Promise<{
  id: string;
  role: string;
  email: string;
} | null> {
  if (!UUID_RE.test(user.sub)) {
    recordIdentityFallback("jobs_workflows_ws");
  }
  const lookupKey = wsActorLookupKey(user);
  const [row] = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(UUID_RE.test(lookupKey) ? eq(users.id, lookupKey) : eq(users.email, lookupKey))
    .limit(1);
  return row ?? null;
}

export function wsActorLookupKey(user: Pick<TokenPayload, "sub" | "email">): string {
  return UUID_RE.test(user.sub) ? user.sub : user.email;
}

/**
 * Returns the row for downstream callers; throws AppError on rejection.
 */
async function authorizeJobAccess(
  db: PgDb,
  user: TokenPayload,
  jobId: string,
  mode: AuthzService["mode"] | "off" = "off",
): Promise<{
  submittedBy: string | null;
  callerId: string | null;
  callerRole: string | null;
  callerEmail: string | null;
  localAllowed: boolean;
}> {
  const [row] = await db
    .select({
      submittedBy: jobs.submittedBy,
      orgId: jobs.orgId,
      providerOrgId: jobs.providerOrgId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
  }
  const caller = await resolveCaller(db, user);
  const callerId = caller?.id ?? null;
  const callerRole = caller?.role ?? null;
  if (mode === "enforce") {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole,
      callerEmail: caller?.email ?? null,
      localAllowed: await localJobSubscriptionAllowed(db, callerId, callerRole, row),
    };
  }
  const localAllowed = await localJobSubscriptionAllowed(db, callerId, callerRole, row);
  if (localAllowed) {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole: caller?.role ?? null,
      callerEmail: caller?.email ?? null,
      localAllowed,
    };
  }
  if (mode === "shadow") {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole: caller?.role ?? null,
      callerEmail: caller?.email ?? null,
      localAllowed,
    };
  }
  throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to subscribe to this job", 403);
}

async function localJobSubscriptionAllowed(
  db: PgDb,
  callerId: string | null,
  callerRole: string | null,
  row: { submittedBy: string | null; orgId: string | null; providerOrgId: string | null },
): Promise<boolean> {
  if (!callerId) return false;
  const memberships = await db
    .select({ orgId: userOrgMemberships.orgId, role: userOrgMemberships.role })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, callerId));
  return (
    resolveJobReadScope(
      {
        userId: callerId,
        role: (callerRole ?? "guest") as RoleName,
        memberships: memberships.map((membership) => ({
          orgId: membership.orgId,
          role: membership.role as "owner" | "admin" | "operator" | "member" | "viewer",
        })),
      },
      {
        submittedBy: row.submittedBy,
        consumerOrgId: row.orgId,
        providerOrgId: row.providerOrgId,
      },
    ) !== null
  );
}

function realtimeSubscriptionDeniedMessage(resourceType: "job" | "workflow"): string {
  if (resourceType === "job") {
    return "Not authorized to subscribe to this job";
  }
  return "Not authorized to subscribe to this run";
}

async function localWorkflowSubscriptionAllowed(
  db: PgDb,
  callerId: string | null,
  callerRole: string | null,
  submittedBy: string | null,
): Promise<boolean> {
  if (callerRole && hasRole(callerRole as RoleName, Role.PLATFORM_ADMIN)) return true;
  if (!callerId) return false;
  if (submittedBy === callerId) return true;
  if (
    submittedBy &&
    hasRole((callerRole ?? "guest") as RoleName, Role.ORG_ADMIN) &&
    (await usersShareOrganization(db, callerId, submittedBy))
  ) {
    return true;
  }
  return false;
}

async function authorizeWorkflowAccess(
  db: PgDb,
  user: TokenPayload,
  runId: string,
  mode: AuthzService["mode"] | "off" = "off",
): Promise<{
  submittedBy: string | null;
  callerId: string | null;
  callerRole: string | null;
  callerEmail: string | null;
  localAllowed: boolean;
}> {
  const [row] = await db
    .select({ submittedBy: workflowRuns.submittedBy })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "Workflow run not found", 404);
  }
  const caller = await resolveCaller(db, user);
  const callerId = caller?.id ?? null;
  const callerRole = caller?.role ?? null;
  if (mode === "enforce") {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole,
      callerEmail: caller?.email ?? null,
      localAllowed: await localWorkflowSubscriptionAllowed(
        db,
        callerId,
        callerRole,
        row.submittedBy,
      ),
    };
  }
  const localAllowed = await localWorkflowSubscriptionAllowed(
    db,
    callerId,
    callerRole,
    row.submittedBy,
  );
  if (localAllowed) {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole: caller?.role ?? null,
      callerEmail: caller?.email ?? null,
      localAllowed,
    };
  }
  if (mode === "shadow") {
    return {
      submittedBy: row.submittedBy,
      callerId,
      callerRole: caller?.role ?? null,
      callerEmail: caller?.email ?? null,
      localAllowed,
    };
  }
  throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to subscribe to this run", 403);
}

async function usersShareOrganization(
  db: PgDb,
  callerId: string,
  ownerId: string,
  ownerOrgSnapshot?: string | null,
): Promise<boolean> {
  const callerMemberships = await db
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, callerId));
  const callerOrgIds = callerMemberships.map((membership) => membership.orgId);
  if (callerOrgIds.length === 0) return false;
  if (ownerOrgSnapshot) return callerOrgIds.includes(ownerOrgSnapshot);
  const ownerMemberships = await db
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(
      and(eq(userOrgMemberships.userId, ownerId), inArray(userOrgMemberships.orgId, callerOrgIds)),
    );
  return ownerMemberships.length > 0;
}

export async function authorizeRealtimeSubscription(
  authz: AuthzService | undefined,
  input: {
    actorUserId: string | null;
    actorEmail: string | null;
    resourceType: "job" | "workflow";
    resourceId: string;
    boundRole?: string | null;
    localAllowed: boolean;
  },
): Promise<void> {
  if (!authz || authz.mode === "off") return;
  const subjectId = input.actorUserId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    resource: { type: input.resourceType, id: input.resourceId },
    permission: "view",
    subject: { type: "user", id: subjectId },
    context: { source: "ws-subscription" },
  };
  if (authz.mode === "shadow") {
    const localAllowed = input.localAllowed;
    await authz.shadowCheck({ ...check, localAllowed });
    if (!localAllowed) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        realtimeSubscriptionDeniedMessage(input.resourceType),
        403,
      );
    }
    return;
  }
  await authz.requirePermission(
    check,
    hasRole((input.boundRole ?? "guest") as RoleName, Role.PLATFORM_ADMIN),
  );
}

/** Format the wire envelope sent over the WebSocket. */
function jobEventEnvelope(evt: JobStatusChangedEvent): string {
  return JSON.stringify({
    type: "job.status",
    jobId: evt.jobId,
    status: evt.status,
    schedulerJobId: evt.schedulerJobId ?? null,
    agentId: evt.agentId ?? null,
    ts: new Date().toISOString(),
  });
}

function workflowEventEnvelope(evt: WorkflowStateChangedEvent): string {
  return JSON.stringify({
    type: "workflow.step",
    runId: evt.runId,
    stepId: evt.stepId,
    jobId: evt.jobId,
    status: evt.status,
    ts: new Date().toISOString(),
  });
}

/**
 * Build /ws/jobs/:id and /ws/workflows/:runId routes.
 *
 * Auth/RBAC runs synchronously before upgrade. If `upgrade` is omitted (unit
 * tests), the route returns a synthetic 200 once the gate has passed so tests
 * can verify the gate without spinning up Bun.serve.
 */
export function createWsRoutes(deps: WsAuthDependencies) {
  const r = new Hono();

  r.get("/jobs/:id", async (c, next) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const user = await authenticateWs(c, deps.jwtSecret, deps.db);
    const access = await authorizeJobAccess(deps.db, user, id, deps.authz?.mode ?? "off");
    await authorizeRealtimeSubscription(deps.authz, {
      actorUserId: access.callerId,
      actorEmail: access.callerEmail,
      boundRole: access.callerRole,
      localAllowed: access.localAllowed,
      resourceType: "job",
      resourceId: id,
    });

    if (!deps.upgrade) {
      // Test path — the gate accepted the caller; in production Bun upgrades.
      return c.body(null, 200);
    }

    const handler = deps.upgrade((_ctx) => {
      let unsubscribe: (() => void) | null = null;
      return {
        onOpen: (_evt, ws) => {
          // Snapshot current status when the connection opens so the client
          // doesn't have to do a separate REST call to render.
          // Actual snapshot fetch happens lazily on the next event — the
          // client's REST query already provides the initial state.
          unsubscribe = deps.bus.subscribeJob(id, (evt) => {
            try {
              ws.send(jobEventEnvelope(evt));
            } catch (err) {
              logger.warn({ jobId: id, err }, "WS send failed");
            }
          });
          logger.debug({ jobId: id, sub: user.sub }, "WS job subscribed");
        },
        onClose: () => {
          if (unsubscribe) unsubscribe();
          unsubscribe = null;
          logger.debug({ jobId: id, sub: user.sub }, "WS job unsubscribed");
        },
        onError: () => {
          if (unsubscribe) unsubscribe();
          unsubscribe = null;
        },
      };
    });
    return handler(c, next);
  });

  r.get("/workflows/:runId", async (c, next) => {
    const runId = parseUuidParam(c.req.param("runId"), "run id");
    const user = await authenticateWs(c, deps.jwtSecret, deps.db);
    const access = await authorizeWorkflowAccess(deps.db, user, runId, deps.authz?.mode ?? "off");
    await authorizeRealtimeSubscription(deps.authz, {
      actorUserId: access.callerId,
      actorEmail: access.callerEmail,
      boundRole: access.callerRole,
      localAllowed: access.localAllowed,
      resourceType: "workflow",
      resourceId: runId,
    });

    if (!deps.upgrade) {
      return c.body(null, 200);
    }

    const handler = deps.upgrade((_ctx) => {
      let unsubscribe: (() => void) | null = null;
      return {
        onOpen: (_evt, ws) => {
          unsubscribe = deps.bus.subscribeWorkflow(runId, (evt) => {
            try {
              ws.send(workflowEventEnvelope(evt));
            } catch (err) {
              logger.warn({ runId, err }, "WS send failed");
            }
          });
          logger.debug({ runId, sub: user.sub }, "WS workflow subscribed");
        },
        onClose: () => {
          if (unsubscribe) unsubscribe();
          unsubscribe = null;
          logger.debug({ runId, sub: user.sub }, "WS workflow unsubscribed");
        },
        onError: () => {
          if (unsubscribe) unsubscribe();
          unsubscribe = null;
        },
      };
    });
    return handler(c, next);
  });

  return r;
}
