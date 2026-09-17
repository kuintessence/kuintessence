import type { PgDb } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type RoleName,
  StorageQuotaGrantCreateSchema,
  StorageQuotaPolicyInputSchema,
  StorageQuotaRequestCreateSchema,
  StorageQuotaRequestDecisionSchema,
  StorageScopeSchema,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import { writeAudit } from "../services/audit-log-writer";
import type { ClusterFileRootService } from "../services/cluster-file-root";
import type { StorageQuotaService } from "../services/storage-quota";

const ScopeQuerySchema = z
  .object({
    scope: StorageScopeSchema.default("cloud"),
    scopeId: z.string().min(1).max(255).default("global"),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "cloud" && value.scopeId !== "global") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "Cloud storage scopeId must be global",
      });
    }
  });

export interface StorageRoutesDeps {
  db: PgDb;
  service: StorageQuotaService;
  clusterFileRootService: ClusterFileRootService;
  authz?: AuthzService;
}

export function createStorageRoutes(deps: StorageRoutesDeps): Hono {
  const routes = new Hono();

  routes.get(
    "/storage/summary",
    kqValidator("query", ScopeQuerySchema, "Invalid storage scope"),
    async (c) => {
      const actor = requireActor(c);
      const query = c.req.valid("query");
      await requireScopeAccess(c, deps, query.scope, query.scopeId, "use");
      return c.json(await deps.service.getSummary(actor.userId, query.scope, query.scopeId));
    },
  );

  routes.get("/storage/quota-requests", async (c) => {
    const actor = requireActor(c);
    return c.json({ requests: await deps.service.listUserRequests(actor.userId) });
  });

  routes.post(
    "/storage/quota-requests",
    kqValidator("json", StorageQuotaRequestCreateSchema, "Invalid storage quota request"),
    async (c) => {
      const actor = requireActor(c);
      const input = c.req.valid("json");
      await requireScopeAccess(c, deps, input.scope, input.scopeId, "use");
      const request = await deps.service.createRequest(actor.userId, input);
      await writeAudit(deps.db, {
        actor: actor.userId,
        action: "storage.quota.request.create",
        target: request.id,
        diff: { after: input },
      });
      return c.json(request, 201);
    },
  );

  routes.get("/admin/storage/overview", async (c) => {
    await requirePlatformPermission(c, deps.authz, "manage", "storage-quota");
    return c.json(await deps.service.getCloudOverview());
  });

  routes.get(
    "/admin/storage/policy",
    kqValidator("query", ScopeQuerySchema, "Invalid storage scope"),
    async (c) => {
      const query = c.req.valid("query");
      await requireScopeAccess(c, deps, query.scope, query.scopeId, "manage");
      const policy = await deps.service.getPolicy(query.scope, query.scopeId);
      const actor = requireActor(c);
      const summary = await deps.service.getSummary(actor.userId, query.scope, query.scopeId);
      return c.json({ policy, effectivePolicy: summary.policy });
    },
  );

  routes.put(
    "/admin/storage/policy",
    kqValidator("json", StorageQuotaPolicyInputSchema, "Invalid storage quota policy"),
    async (c) => {
      const actor = requireActor(c);
      const input = c.req.valid("json");
      await requireScopeAccess(c, deps, input.scope, input.scopeId, "manage");
      const policy = await deps.service.upsertPolicy(actor.userId, input);
      await writeAudit(deps.db, {
        actor: actor.userId,
        action: "storage.quota.policy.update",
        target: `${input.scope}:${input.scopeId}`,
        diff: { after: input },
      });
      return c.json(policy);
    },
  );

  routes.get(
    "/admin/storage/quota-requests",
    kqValidator("query", ScopeQuerySchema, "Invalid storage scope"),
    async (c) => {
      const query = c.req.valid("query");
      await requireScopeAccess(c, deps, query.scope, query.scopeId, "manage");
      return c.json({ requests: await deps.service.listRequests(query.scope, query.scopeId) });
    },
  );

  routes.post(
    "/admin/storage/quota-requests/:id/decision",
    kqValidator("json", StorageQuotaRequestDecisionSchema, "Invalid quota decision"),
    async (c) => {
      const actor = requireActor(c);
      const requestId = c.req.param("id");
      const input = c.req.valid("json");
      const pendingRequest = await deps.service.getRequest(requestId);
      if (!pendingRequest) {
        throw new AppError(ErrorCode.NOT_FOUND, "Storage quota request not found", 404);
      }
      await requireScopeAccess(
        c,
        deps,
        StorageScopeSchema.parse(pendingRequest.scope),
        pendingRequest.scopeId,
        "manage",
      );
      const request = await deps.service.decideRequest(requestId, actor.userId, input);
      if (!request) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Quota request decision failed", 500);
      }
      await writeAudit(deps.db, {
        actor: actor.userId,
        action: `storage.quota.request.${input.decision}`,
        target: requestId,
        diff: { after: input },
      });
      return c.json(request);
    },
  );

  routes.post(
    "/admin/storage/grants",
    kqValidator("json", StorageQuotaGrantCreateSchema, "Invalid storage quota grant"),
    async (c) => {
      const actor = requireActor(c);
      const input = c.req.valid("json");
      await requireScopeAccess(c, deps, input.scope, input.scopeId, "manage");
      const grant = await deps.service.createGrant(actor.userId, input);
      await writeAudit(deps.db, {
        actor: actor.userId,
        action: "storage.quota.grant.create",
        target: grant.id,
        diff: { after: input },
      });
      return c.json(grant, 201);
    },
  );

  return routes;
}

function requireActor(c: Context): { userId: string; orgId: string | null } {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return { userId: principal.userId, orgId: principal.orgId ?? null };
}

async function requireScopeAccess(
  c: Context,
  deps: StorageRoutesDeps,
  scope: "cloud" | "cluster_root",
  scopeId: string,
  permission: "use" | "manage",
): Promise<void> {
  if (scope === "cloud") {
    if (permission === "manage") {
      await requirePlatformPermission(c, deps.authz, "manage", "storage-quota");
    }
    return;
  }
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const context = {
    role: principal.role as RoleName,
    orgId: principal.orgId,
    orgIds: principal.orgIds,
    userId: principal.userId,
    email: principal.email,
    sub: principal.sub,
  };
  if (permission === "manage") {
    await deps.clusterFileRootService.getAdmin(scopeId, context);
    return;
  }
  const allowed = await deps.clusterFileRootService.resolveAllowedRootPaths(context);
  if (!allowed.roots?.some((root) => root.id === scopeId)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Cannot use this cluster storage root", 403);
  }
}
