import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import { CpRbacError, deriveCpScope } from "./cp-rbac";
import type { BoundPrincipal } from "./principal-binder";

export type OrganizationResourceScope = {
  orgIds: string[] | null;
  userId: string;
  key: string;
  canManage: boolean;
};
export type ResourceScopeEnv = { Variables: { resourceScope: OrganizationResourceScope } };
export function organizationResourceScope(
  authz?: AuthzService,
): MiddlewareHandler<ResourceScopeEnv> {
  return async (c, next) => {
    const view = c.req.param("view");
    if (view !== "provider" && view !== "operator")
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Unknown dashboard", 404);
    const p = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!p?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
    const mutation = c.req.method !== "GET" && !c.req.path.endsWith("/default-view");
    let scope: OrganizationResourceScope;
    if (view === "operator") {
      await requirePlatformPermission(
        c,
        authz,
        mutation ? "operate" : "view",
        "organization-resource",
      );
      let canManage = false;
      try {
        await requirePlatformPermission(c, authz, "operate", "organization-resource");
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
        await requirePlatformPermission(c, authz, "view", "organization-resource-provider");
      if (hasRole(p.role as RoleName, "operator")) {
        await requirePlatformPermission(
          c,
          authz,
          mutation ? "operate" : "view",
          "organization-resource-provider",
        );
      } else if (authz && authz.mode !== "off") {
        for (const orgId of cp.orgIds) {
          const check = {
            actorUserId: p.userId,
            actorEmail: p.email,
            resource: { type: "organization", id: orgId },
            permission: mutation ? "manage" : "view",
            subject: { type: "user", id: p.userId },
            context: { source: "organization-resource" },
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
    c.set("resourceScope", scope);
    await next();
  };
}
