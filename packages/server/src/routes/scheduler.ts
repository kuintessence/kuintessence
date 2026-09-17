import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode, hasRole, JobSubmitSchema, type RoleName } from "@kuintessence/shared";
import { Hono } from "hono";
import type { AuthzCheck, AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";

/**
 * placement preview routes (PRD F11.x scheduler explainability).
 *
 * `POST /api/scheduler/preview-placement` runs the full placement
 * pipeline against a draft job spec without persisting anything. The Web
 * "Placement preview" panel uses it to show the user, before submission,
 * which agents would survive and why each rejected agent dropped out.
 *
 * The endpoint reuses the same orchestrator + filters + score sink as the
 * production dispatch path, so the preview cannot drift from real placement.
 */
export interface SchedulerRouteOptions {
  authz?: AuthzService;
}

export function createSchedulerRoutes(
  orchestrator: PlacementOrchestrator,
  _db: PgDb,
  opts: SchedulerRouteOptions = {},
) {
  const routes = new Hono();

  routes.post(
    "/scheduler/preview-placement",
    kqValidator("json", JobSubmitSchema, "Invalid job preview body"),
    async (c) => {
      const data = c.req.valid("json");
      const principal = c.get("principal" as never) as BoundPrincipal | undefined;
      const actor = requireBoundSchedulerPrincipal(principal);

      const queueId = data.schedulingStrategy?.queueId ?? null;
      if (queueId) {
        await orchestrator.validateSchedulingIntent({
          job: data,
          userId: actor.userId,
          userRole: actor.role,
          orgId: actor.orgId,
        });
        const canSubmit = await authorizeThroughSpice(opts.authz, actor.role, true, {
          actorUserId: actor.userId,
          actorEmail: actor.email,
          resource: { type: "queue", id: queueId },
          permission: "submit",
          subject: { type: "user", id: actor.userId },
          context: { route: "POST /scheduler/preview-placement" },
        });
        if (!canSubmit) {
          throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to submit to this queue", 403);
        }
      }

      const trace = await orchestrator.runWithTrace({
        job: data,
        userId: actor.userId,
        userRole: actor.role,
        orgId: actor.orgId,
        preview: true,
      });

      return c.json(trace);
    },
  );

  return routes;
}

function requireBoundSchedulerPrincipal(principal: BoundPrincipal | undefined): {
  userId: string;
  role: RoleName;
  orgId: string | null;
  email: string;
} {
  if (principal?.userId) {
    return {
      userId: principal.userId,
      role: (principal.role ?? "guest") as RoleName,
      orgId: principal.orgId ?? null,
      email: principal.email,
    };
  }
  throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
}

async function authorizeThroughSpice(
  authz: AuthzService | undefined,
  role: string,
  localAllowed: boolean,
  check: AuthzCheck,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, hasRole(role as RoleName, "platform_admin"));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}
