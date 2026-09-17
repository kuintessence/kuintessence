import {
  AppError,
  hasRole,
  Role,
  type RoleName,
  type RunResult,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { parseUuidParam } from "../middleware/uuid-param";
import type { PlacementPlanService } from "../services/placement-plan";
import { registerWorkflowAuthorization } from "../services/workflow-authorization";
import type { WorkflowAsyncRunner } from "../workflow/async-runner";
import type { WorkflowDraftService } from "../workflow/draft-service";
import type { WorkflowRunListOptions, WorkflowRunRegistry } from "../workflow/run-registry";

interface JsonBody {
  yaml?: string;
  plannerMode?: unknown;
  defaultExecutionIdentity?: unknown;
  budgetCap?: unknown;
  placementConstraint?: unknown;
  subgraphPlacementConstraints?: unknown;
  nodePlacementConstraints?: unknown;
}

export interface WorkflowRouteDeps {
  /** @deprecated Workflow authz uses principal.userId; retained for older tests/wiring. */
  resolveUser: (email: string) => Promise<string | null>;
  /** Build a runner bound to the submitting user. Threads submittedBy AND the
   *  Server-bound role into job submission so placement sees the same local role
   *  used by SpiceDB degraded fallback. */
  makeRunner: (
    submittedBy: string,
    role: RoleName,
  ) => (yaml: string) => Promise<RunResult & { runId?: string }>;
  /** Run persistence for list/detail reads. */
  registry: WorkflowRunRegistry;
  /** In-process executor for production submit: creates a run row and returns immediately. */
  asyncRunner: WorkflowAsyncRunner;
  drafts?: WorkflowDraftService;
  placementPlans?: PlacementPlanService;
  authz?: AuthzService;
  syncRunEnabled?: boolean;
}

const WorkflowDraftBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  yaml: z.string().min(1),
  placementConfig: WorkflowPlacementConfigSchema.optional().transform((value) =>
    WorkflowPlacementConfigSchema.parse(value ?? {}),
  ),
});

const WorkflowListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["active", "completed", "failed", "cancelled"]).optional(),
  q: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((value) => value || undefined),
});

type AuthUser = { email?: string; role?: string };

class RunFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Workflow routes for the control-flow DSL.
 *
 * Canonical surface (consumed by the CLI/TUI remote backend):
 *   POST /workflows        — submit a workflow YAML asynchronously; returns `{ runId, ... }`.
 *   GET  /workflows        — list runs (own runs unless platform_admin).
 *   GET  /workflows/:runId — single run detail (own run unless platform_admin).
 *
 * Synchronous debugging endpoint:
 *   POST /workflows/run   — returns raw per-node result when enabled.
 *
 * Canonical submit validates and stores the run, then execution continues in a
 * Server in-process background worker. The synchronous endpoint orchestrates
 * inside the request for debugging.
 */
export function createWorkflowRoutes(deps: WorkflowRouteDeps) {
  const r = new Hono();
  const syncRunEnabled = deps.syncRunEnabled ?? true;

  async function readSubmit(c: Context): Promise<{
    yaml: string;
    placementConfig: WorkflowPlacementConfig;
  }> {
    const ct = c.req.header("Content-Type") ?? "";
    if (ct.includes("yaml")) {
      return {
        yaml: await c.req.text(),
        placementConfig: WorkflowPlacementConfigSchema.parse({}),
      };
    }
    const body = (await c.req.json().catch(() => ({}))) as JsonBody;
    if (typeof body.yaml !== "string" || body.yaml.length === 0) {
      throw new RunFailure(400, "Missing 'yaml' field, or set Content-Type to application/yaml");
    }
    return {
      yaml: body.yaml,
      placementConfig: WorkflowPlacementConfigSchema.parse({
        plannerMode: body.plannerMode,
        defaultExecutionIdentity: body.defaultExecutionIdentity,
        budgetCap: body.budgetCap,
        runConstraint: body.placementConstraint,
        subgraphConstraints: body.subgraphPlacementConstraints,
        nodeConstraints: body.nodePlacementConstraints,
      }),
    };
  }

  async function readYaml(c: Context): Promise<string> {
    return (await readSubmit(c)).yaml;
  }

  async function resolveSubmitter(
    c: Context,
  ): Promise<{ submittedBy: string; role: RoleName; principal: BoundPrincipal }> {
    const { actorId } = requireWorkflowPrincipal(c);
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId) {
      throw new RunFailure(403, "Canonical workflow principal is required");
    }
    const role = (principal?.role ?? "guest") as RoleName;
    if (!hasRole(role, Role.USER)) {
      throw new RunFailure(403, "Workflow access requires a user role");
    }
    return { submittedBy: actorId, role, principal };
  }

  async function runYaml(c: Context): Promise<RunResult & { runId?: string }> {
    const { submittedBy, role } = await resolveSubmitter(c);
    const yaml = await readYaml(c);
    try {
      return await deps.makeRunner(submittedBy, role)(yaml);
    } catch (err) {
      throw new RunFailure(400, err instanceof Error ? err.message : "invalid workflow");
    }
  }

  // Canonical submit. Returns immediately with a runId; clients should use
  // GET /workflows/:runId and the workflow WS stream for progress.
  r.post("/workflows", async (c) => {
    try {
      const { submittedBy, role, principal } = await resolveSubmitter(c);
      const { yaml, placementConfig } = await readSubmit(c);
      const result = await deps.asyncRunner.submit({
        yaml,
        submittedBy,
        role,
        principal,
        placementConfig,
        authorizeRun: (runId) =>
          registerWorkflowAuthorization(deps.authz, runId, submittedBy, primaryOrgId(c)),
      });
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500);
      }
      if (err instanceof Error) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Production requires an explicit opt-in for synchronous debugging.
  r.post("/workflows/run", async (c) => {
    if (!syncRunEnabled) {
      return c.json({ error: "Workflow synchronous run endpoint is disabled" }, 404);
    }
    try {
      return c.json(await runYaml(c));
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Non-admins are scoped to their own runs — without this any user could list
  // any other user's run (and its result values) by id (IDOR).
  r.get("/workflows", async (c) => {
    try {
      const { actorId, isAdmin } = requireWorkflowPrincipal(c);
      const query = WorkflowListQuerySchema.parse({
        limit: c.req.query("limit"),
        offset: c.req.query("offset"),
        status: c.req.query("status"),
        q: c.req.query("q"),
      });
      const options: WorkflowRunListOptions = { limit: query.limit, offset: query.offset };
      if (query.status) options.status = query.status;
      if (query.q) options.query = query.q;
      if (deps.authz?.mode === "enforce") {
        const subjectId = subjectIdForWorkflowAuthz(deps.authz, actorId);
        if (!subjectId) throw new RunFailure(403, "Authorization principal is not bound");
        try {
          options.ids = await deps.authz.lookupResources({
            resourceType: "workflow",
            permission: "view",
            subject: { type: "user", id: subjectId },
          });
        } catch (err) {
          throw new RunFailure(
            403,
            `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (!isAdmin) {
        options.submittedBy = actorId;
      }
      const page = await deps.registry.listPage(options);
      return c.json({
        ...page,
        runs: await filterWorkflowRunsThroughSpice(c, deps.authz, page.runs, actorId),
        limit: query.limit,
        offset: query.offset,
      });
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues[0]?.message ?? "Invalid workflow list query" }, 400);
      }
      throw err;
    }
  });

  r.get("/workflows/drafts", async (c) => {
    try {
      const { actorId } = requireWorkflowPrincipal(c);
      if (!deps.drafts) return c.json({ error: "Workflow drafts are unavailable" }, 503);
      return c.json({ drafts: await deps.drafts.listOwned(actorId) });
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  r.post("/workflows/drafts", async (c) => {
    try {
      const { actorId } = requireWorkflowPrincipal(c);
      if (!deps.drafts) return c.json({ error: "Workflow drafts are unavailable" }, 503);
      const body = WorkflowDraftBodySchema.parse(await c.req.json());
      return c.json(await deps.drafts.create(actorId, body), 201);
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      if (err instanceof z.ZodError)
        return c.json({ error: err.issues[0]?.message ?? "Invalid draft" }, 400);
      throw err;
    }
  });

  r.get("/workflows/drafts/:draftId", async (c) => {
    try {
      const { actorId } = requireWorkflowPrincipal(c);
      if (!deps.drafts) return c.json({ error: "Workflow drafts are unavailable" }, 503);
      const draftId = parseUuidParam(c.req.param("draftId"), "workflow draft id");
      const draft = await deps.drafts.getOwned(draftId, actorId);
      return draft ? c.json(draft) : c.json({ error: "Workflow draft not found" }, 404);
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  r.put("/workflows/drafts/:draftId", async (c) => {
    try {
      const { actorId } = requireWorkflowPrincipal(c);
      if (!deps.drafts) return c.json({ error: "Workflow drafts are unavailable" }, 503);
      const draftId = parseUuidParam(c.req.param("draftId"), "workflow draft id");
      const body = WorkflowDraftBodySchema.parse(await c.req.json());
      const draft = await deps.drafts.updateOwned(draftId, actorId, body);
      return draft ? c.json(draft) : c.json({ error: "Workflow draft not found" }, 404);
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      if (err instanceof z.ZodError)
        return c.json({ error: err.issues[0]?.message ?? "Invalid draft" }, 400);
      throw err;
    }
  });

  r.delete("/workflows/drafts/:draftId", async (c) => {
    try {
      const { actorId } = requireWorkflowPrincipal(c);
      if (!deps.drafts) return c.json({ error: "Workflow drafts are unavailable" }, 503);
      const draftId = parseUuidParam(c.req.param("draftId"), "workflow draft id");
      const deleted = await deps.drafts.deleteOwned(draftId, actorId);
      return deleted ? c.json({ ok: true }) : c.json({ error: "Workflow draft not found" }, 404);
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  r.get("/workflows/:runId", async (c) => {
    const runId = parseUuidParam(c.req.param("runId"), "run id");
    let actorId: string;
    let isAdmin: boolean;
    try {
      ({ actorId, isAdmin } = requireWorkflowPrincipal(c));
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const run = await deps.registry.getById(runId);
    const localAllowed = isAdmin || run?.submittedBy === actorId;
    // 404 (not 403) when the run belongs to someone else — don't leak existence.
    if (!run || (deps.authz?.mode !== "enforce" && !localAllowed)) {
      return c.json({ error: "Workflow run not found" }, 404);
    }
    if (!(await checkWorkflowPermission(c, deps.authz, runId, "view", actorId, localAllowed))) {
      return c.json({ error: "Not authorized to view this workflow run" }, 403);
    }
    // The Web run view consumes `graph` (node/edge projection) to render the
    // DAG. Return it explicitly as part of the WorkflowRunDetail contract.
    return c.json({ ...run, graph: run.graph });
  });

  r.post("/workflows/:runId/cancel", async (c) => {
    const runId = parseUuidParam(c.req.param("runId"), "run id");
    let actorId: string;
    let isAdmin: boolean;
    try {
      ({ actorId, isAdmin } = requireWorkflowPrincipal(c));
    } catch (err) {
      if (err instanceof RunFailure) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const run = await deps.registry.getById(runId);
    const localAllowed = isAdmin || run?.submittedBy === actorId;
    if (!run || (deps.authz?.mode !== "enforce" && !localAllowed)) {
      return c.json({ error: "Workflow run not found" }, 404);
    }
    if (!(await checkWorkflowPermission(c, deps.authz, runId, "cancel", actorId, localAllowed))) {
      return c.json({ error: "Not authorized to cancel this workflow run" }, 403);
    }
    const status = await deps.asyncRunner.cancel(runId);
    if (!status) {
      return c.json({ error: "Workflow run not found" }, 404);
    }
    return c.json({ runId, status });
  });

  r.get("/workflows/:runId/placement-plans", async (c) => {
    if (!deps.placementPlans) return c.json({ error: "Placement planner is unavailable" }, 503);
    const access = await requireRunAccess(c, deps, "view");
    if (access.response) return access.response;
    return c.json({ plans: await deps.placementPlans.list(access.runId) });
  });

  r.post("/workflows/:runId/replan", async (c) => {
    if (!deps.placementPlans) return c.json({ error: "Placement planner is unavailable" }, 503);
    const access = await requireRunAccess(c, deps, "cancel");
    if (access.response) return access.response;
    try {
      return c.json(await deps.placementPlans.replan(access.runId, "user-replan"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Placement replan failed" }, 409);
    }
  });

  r.post("/workflows/:runId/placement-plans/:planId/approve", async (c) => {
    if (!deps.placementPlans) return c.json({ error: "Placement planner is unavailable" }, 503);
    const access = await requireRunAccess(c, deps, "cancel");
    if (access.response) return access.response;
    const planId = parseUuidParam(c.req.param("planId"), "placement plan id");
    const plan = await deps.placementPlans.approve(access.runId, planId);
    if (!plan) return c.json({ error: "Placement plan is not awaiting approval" }, 409);
    const status = await deps.asyncRunner.resumeAfterApproval(access.runId);
    return c.json({ plan, runId: access.runId, status });
  });

  return r;
}

async function requireRunAccess(
  c: Context,
  deps: WorkflowRouteDeps,
  permission: "view" | "cancel",
): Promise<{ runId: string; response?: Response }> {
  const runId = parseUuidParam(c.req.param("runId"), "run id");
  let actorId: string;
  let isAdmin: boolean;
  try {
    ({ actorId, isAdmin } = requireWorkflowPrincipal(c));
  } catch (err) {
    if (err instanceof RunFailure) {
      return { runId, response: c.json({ error: err.message }, err.status) };
    }
    throw err;
  }
  const run = await deps.registry.getById(runId);
  const localAllowed = isAdmin || run?.submittedBy === actorId;
  if (!run || (deps.authz?.mode !== "enforce" && !localAllowed)) {
    return { runId, response: c.json({ error: "Workflow run not found" }, 404) };
  }
  if (!(await checkWorkflowPermission(c, deps.authz, runId, permission, actorId, localAllowed))) {
    return { runId, response: c.json({ error: "Not authorized for this workflow run" }, 403) };
  }
  return { runId };
}

function primaryOrgId(c: Context): string | null {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return principal?.orgId ?? principal?.orgIds[0] ?? null;
}

function canonicalWorkflowActorId(c: Context): string | null {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return principal?.userId ?? null;
}

function requireWorkflowPrincipal(c: Context): { actorId: string; isAdmin: boolean } {
  const user = c.get("user") as AuthUser | undefined;
  if (!user?.email) {
    throw new RunFailure(401, "Unauthenticated");
  }
  const actorId = canonicalWorkflowActorId(c);
  if (!actorId) {
    throw new RunFailure(403, "Authorization principal is not bound");
  }
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!hasRole((principal?.role ?? Role.GUEST) as RoleName, Role.USER)) {
    throw new RunFailure(403, "Workflow access requires a user role");
  }
  return { actorId, isAdmin: isPlatformFallbackPrincipal(c) };
}

async function filterWorkflowRunsThroughSpice<
  T extends { id: string; submittedBy?: string | null },
>(c: Context, authz: AuthzService | undefined, runs: T[], actorId: string | null): Promise<T[]> {
  const visible: T[] = [];
  const isAdmin = isPlatformFallbackPrincipal(c);
  for (const run of runs) {
    const localAllowed = isAdmin || (actorId != null && run.submittedBy === actorId);
    if (await checkWorkflowPermission(c, authz, run.id, "view", actorId, localAllowed)) {
      visible.push(run);
    }
  }
  return visible;
}

async function checkWorkflowPermission(
  c: Context,
  authz: AuthzService | undefined,
  runId: string,
  permission: "view" | "cancel",
  actorId: string | null,
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = subjectIdForWorkflowAuthz(authz, actorId);
  if (!subjectId) return false;
  const check = {
    actorUserId: actorId,
    actorEmail: principal?.email ?? null,
    resource: { type: "workflow", id: runId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { route: `workflow#${permission}` },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, isPlatformFallbackPrincipal(c));
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === "Authorization denied") return false;
    throw err;
  }
}

function isPlatformFallbackPrincipal(c: Context): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return hasRole((principal?.role ?? "guest") as RoleName, "platform_admin");
}

export function subjectIdForWorkflowAuthz(
  authz: AuthzService | undefined,
  actorUserId: string | null,
): string | null {
  if (!authz || authz.mode === "off") {
    return actorUserId;
  }
  return actorUserId;
}
