import type { PgDb } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  QueueIdSchema,
  QueueRegistryCreateSchema,
  QueueRegistryUpdateSchema,
  type RoleName,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { kqValidator } from "../middleware/validator";
import type { QueueAccessContext, QueueRegistryService } from "../services/queue-registry";

async function resolveQueueContext(
  _db: PgDb,
  principal: BoundPrincipal | undefined,
  requestedOrganizationId: string | undefined,
): Promise<QueueAccessContext> {
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const requestedOrgId = requestedOrganizationId?.trim() || null;
  const isPlatformWide = principal.role === "platform_admin" || principal.role === "super_admin";
  if (requestedOrgId && !isUuid(requestedOrgId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Active organization must be a UUID", 400);
  }
  if (requestedOrgId && !isPlatformWide && !principal.orgIds.includes(requestedOrgId)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Selected organization is not available to this user",
      403,
    );
  }
  const activeOrgId = requestedOrgId ?? principal.orgId;
  if (!isPlatformWide && !activeOrgId && principal.orgIds.length > 1) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Select an active organization before reading queues",
      409,
    );
  }
  const orgIds = activeOrgId ? [activeOrgId] : principal.orgIds;
  return {
    role: principal.role as RoleName,
    orgId: activeOrgId ?? orgIds[0] ?? null,
    orgIds,
    userId: principal.userId,
    email: principal.email,
    sub: principal.sub,
  };
}

export interface QueueRouteOptions {
  authz?: AuthzService;
}

export function createQueueRoutes(
  service: QueueRegistryService,
  db: PgDb,
  options: QueueRouteOptions = {},
) {
  const routes = new Hono();

  routes.get("/queues/visible", async (c) => {
    const ctx = await resolveQueueContext(
      db,
      c.get("principal" as never) as BoundPrincipal | undefined,
      c.req.header("x-kq-active-organization"),
    );
    const queues = await service.listVisible(ctx);
    return c.json({ queues });
  });

  routes.get("/admin/queues", async (c) => {
    assertQueueAdminRouteAccess(c, options);
    const ctx = await resolveQueueContext(
      db,
      c.get("principal" as never) as BoundPrincipal | undefined,
      c.req.header("x-kq-active-organization"),
    );
    const queues = await service.listAdmin(ctx);
    return c.json({ queues });
  });

  routes.get("/admin/agents/:agentId/queue-inventory", async (c) => {
    assertQueueAdminRouteAccess(c, options);
    const agentId = QueueIdSchema.parse(c.req.param("agentId"));
    const ctx = await resolveQueueContext(
      db,
      c.get("principal" as never) as BoundPrincipal | undefined,
      c.req.header("x-kq-active-organization"),
    );
    const inventory = await service.getAgentInventoryForAdmin(agentId, ctx);
    return c.json(inventory);
  });

  routes.post(
    "/admin/queues",
    kqValidator("json", QueueRegistryCreateSchema, "Invalid queue body"),
    async (c) => {
      assertQueueAdminRouteAccess(c, options);
      const ctx = await resolveQueueContext(
        db,
        c.get("principal" as never) as BoundPrincipal | undefined,
        c.req.header("x-kq-active-organization"),
      );
      const queue = await service.create(c.req.valid("json"), ctx);
      return c.json(queue, 201);
    },
  );

  routes.patch(
    "/admin/queues/:queueId",
    kqValidator("json", QueueRegistryUpdateSchema, "Invalid queue patch body"),
    async (c) => {
      assertQueueAdminRouteAccess(c, options);
      const queueId = QueueIdSchema.parse(c.req.param("queueId"));
      const ctx = await resolveQueueContext(
        db,
        c.get("principal" as never) as BoundPrincipal | undefined,
        c.req.header("x-kq-active-organization"),
      );
      const queue = await service.update(queueId, c.req.valid("json"), ctx);
      return c.json(queue);
    },
  );

  return routes;
}

function assertQueueAdminRouteAccess(c: Context, options: QueueRouteOptions): void {
  if (options.authz?.mode === "enforce") return;
  assertRole(c, "org_admin");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
