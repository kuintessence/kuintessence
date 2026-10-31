import {
  AppError,
  CenterInputSchema,
  ClusterInputSchema,
  ErrorCode,
  hasRole,
  LinkInputSchema,
  MapViewSchema,
  type RoleName,
} from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import { CpRbacError, deriveCpScope } from "../middleware/cp-rbac";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { InterconnectScope, InterconnectService } from "../services/interconnect";

export function createInterconnectRoutes(service: InterconnectService, authz?: AuthzService) {
  const r = new Hono<{ Variables: { interconnectScope: InterconnectScope } }>();
  r.use("/:view/*", async (c, next) => {
    const view = c.req.param("view");
    if (view !== "provider" && view !== "operator")
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Unknown dashboard", 404);
    const p = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!p?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
    const mutation = c.req.method !== "GET" && !c.req.path.endsWith("/default-view");
    let scope: InterconnectScope;
    if (view === "operator") {
      await requirePlatformPermission(c, authz, mutation ? "manage" : "view", "interconnect");
      let canManage = false;
      try {
        await requirePlatformPermission(c, authz, "manage", "interconnect");
        canManage = true;
      } catch (error) {
        if (!(error instanceof AppError && error.statusCode === 403)) throw error;
      }
      scope = { orgIds: null, userId: p.userId, key: "operator", canManage };
    } else {
      const activeOrganizationId = c.req.header("x-kq-active-organization");
      if (activeOrganizationId && !z.string().uuid().safeParse(activeOrganizationId).success)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid active organization", 400);
      let cp: ReturnType<typeof deriveCpScope>;
      try {
        cp = deriveCpScope(p, { activeOrganizationId });
      } catch (error) {
        if (error instanceof CpRbacError)
          throw new AppError(ErrorCode.FORBIDDEN, error.message, error.status);
        throw error;
      }
      let canManage = cp.canManage === true && cp.orgIds.length === 1 && !cp.isPlatformWide;
      if (cp.isPlatformWide)
        await requirePlatformPermission(c, authz, "view", "interconnect-provider");
      if (authz && authz.mode !== "off") {
        for (const orgId of cp.orgIds) {
          const check = {
            actorUserId: p.userId,
            actorEmail: p.email,
            resource: { type: "organization", id: orgId },
            permission: mutation ? "manage" : "view",
            subject: { type: "user", id: p.userId },
            context: { source: "interconnect" },
            localAllowed: mutation ? canManage : true,
          };
          if (authz.mode === "shadow") await authz.shadowCheck(check);
          else {
            await authz.requirePermission(check, hasRole(p.role as RoleName, "platform_admin"));
            if (!mutation && canManage) {
              try {
                await authz.requirePermission(
                  { ...check, permission: "manage" },
                  hasRole(p.role as RoleName, "platform_admin"),
                );
              } catch (error) {
                if (!(error instanceof AppError && error.statusCode === 403)) throw error;
                canManage = false;
              }
            }
          }
        }
      }
      if (mutation && !canManage)
        throw new AppError(ErrorCode.FORBIDDEN, "请选择有管理权限的提供者组织", 403);
      scope = {
        orgIds: cp.isPlatformWide ? null : cp.orgIds,
        userId: p.userId,
        key: `provider:${!cp.isPlatformWide && cp.orgIds.length === 1 ? cp.orgIds[0] : "all"}`,
        canManage,
      };
    }
    c.set("interconnectScope", scope);
    await next();
  });
  r.get("/:view/snapshot", async (c) => c.json(await service.snapshot(c.get("interconnectScope"))));
  r.put("/:view/default-view", kqValidator("json", MapViewSchema), async (c) => {
    await service.saveView(c.get("interconnectScope"), c.req.valid("json"));
    return c.json({ saved: true });
  });
  const idValidator = kqValidator("param", z.object({ id: z.string().uuid() }));
  r.post("/:view/centers", kqValidator("json", CenterInputSchema), async (c) =>
    c.json(await service.saveCenter(c.get("interconnectScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/centers/:id", idValidator, kqValidator("json", CenterInputSchema), async (c) =>
    c.json(
      await service.saveCenter(
        c.get("interconnectScope"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
  r.post("/:view/clusters", kqValidator("json", ClusterInputSchema), async (c) =>
    c.json(await service.saveCluster(c.get("interconnectScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/clusters/:id", idValidator, kqValidator("json", ClusterInputSchema), async (c) =>
    c.json(
      await service.saveCluster(
        c.get("interconnectScope"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
  r.post("/:view/links", kqValidator("json", LinkInputSchema), async (c) =>
    c.json(await service.saveLink(c.get("interconnectScope"), null, c.req.valid("json")), 201),
  );
  r.put("/:view/links/:id", idValidator, kqValidator("json", LinkInputSchema), async (c) =>
    c.json(
      await service.saveLink(
        c.get("interconnectScope"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
  for (const [path, kind] of [
    ["centers", "center"],
    ["clusters", "cluster"],
    ["links", "link"],
  ] as const) {
    r.delete(`/:view/${path}/:id`, idValidator, async (c) =>
      c.json(await service.remove(c.get("interconnectScope"), kind, c.req.valid("param").id)),
    );
  }
  return r;
}
