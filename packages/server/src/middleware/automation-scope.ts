import { auditLog, jobs, netdriveFiles, type PgDb, workflowRuns } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AutomationScope } from "../auth/automation-credentials";

const UUID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const rules: {
  method: string;
  path: RegExp;
  scope: AutomationScope;
  owner?: "workflow" | "job" | "file";
}[] = [
  { method: "GET", path: /^\/api\/agents$/, scope: "agents:read" },
  {
    method: "GET",
    path: /^\/api\/software\/agents\/[a-zA-Z0-9_.-]+\/installed$/,
    scope: "software:read",
  },
  { method: "GET", path: /^\/api\/queues\/visible$/, scope: "queues:read" },
  { method: "POST", path: /^\/api\/workflows$/, scope: "workflows:submit" },
  {
    method: "GET",
    path: new RegExp(`^/api/workflows/${UUID}$`),
    scope: "workflows:read",
    owner: "workflow",
  },
  {
    method: "POST",
    path: new RegExp(`^/api/workflows/${UUID}/cancel$`),
    scope: "workflows:cancel",
    owner: "workflow",
  },
  {
    method: "GET",
    path: new RegExp(`^/api/jobs/${UUID}(?:/logs)?$`),
    scope: "jobs:read",
    owner: "job",
  },
  {
    method: "GET",
    path: new RegExp(`^/api/netdrive/files/${UUID}(?:/download-url)?$`),
    scope: "files:read",
    owner: "file",
  },
];

export function automationScopeMiddleware(db: PgDb) {
  return createMiddleware(async (c, next) => {
    const identity = c.get("automation");
    if (!identity) return next();
    const rule = rules.find((r) => r.method === c.req.method && r.path.test(c.req.path));
    let status = 403;
    try {
      if (!rule || !identity.scopes.includes(rule.scope)) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "Automation credential scope does not allow this operation",
          403,
        );
      }
      const id = rule.path.exec(c.req.path)?.[1];
      if (rule.owner && id) {
        const owned =
          rule.owner === "workflow"
            ? await db
                .select({ id: workflowRuns.id })
                .from(workflowRuns)
                .where(and(eq(workflowRuns.id, id), eq(workflowRuns.submittedBy, identity.userId)))
                .limit(1)
            : rule.owner === "job"
              ? await db
                  .select({ id: jobs.id })
                  .from(jobs)
                  .where(
                    and(
                      eq(jobs.id, id),
                      eq(jobs.submittedBy, identity.userId),
                      eq(jobs.orgId, identity.orgId),
                    ),
                  )
                  .limit(1)
              : await db
                  .select({ id: netdriveFiles.id })
                  .from(netdriveFiles)
                  .where(and(eq(netdriveFiles.id, id), eq(netdriveFiles.ownerId, identity.userId)))
                  .limit(1);
        if (!owned.length) {
          status = 404;
          throw new AppError(ErrorCode.NOT_FOUND, "Resource not found", 404);
        }
      }
      await next();
      status = c.res.status;
    } finally {
      await db.insert(auditLog).values({
        actor: identity.userId,
        orgId: identity.orgId,
        action: "automation.credential.use",
        target: `automation_credential:${identity.id}`,
        diff: {
          after: {
            method: c.req.method,
            scope: rule?.scope ?? null,
            resourceId: rule?.path.exec(c.req.path)?.[1] ?? null,
            status,
          },
        },
      });
    }
  });
}
