import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { BoundPrincipal } from "./principal-binder";

export function requireRole(...roles: RoleName[]) {
  return createMiddleware(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Not authenticated", 401);
    }
    const allowed = roles.some((required) => hasEffectiveRole(c, required));
    if (!allowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Insufficient permissions", 403);
    }
    await next();
  });
}

/**
 * In-handler RBAC guard for routes whose role check is conditional or nested
 * and therefore cannot be expressed as route middleware. Throws the same
 * 401/403 `AppError`s as {@link requireRole}.
 */
export function assertRole(c: Context, ...roles: RoleName[]): void {
  const user = c.get("user");
  if (!user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, "Not authenticated", 401);
  }
  if (!roles.some((required) => hasEffectiveRole(c, required))) {
    throw new AppError(ErrorCode.FORBIDDEN, "Insufficient permissions", 403);
  }
}

function hasEffectiveRole(c: Context, requiredRole: RoleName): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const boundRole = (principal?.role ?? "guest") as RoleName;
  if (hasRole(boundRole, requiredRole)) return true;
  if (requiredRole !== "org_admin") return false;
  return (principal?.memberships ?? []).some((membership) =>
    ["owner", "admin", "operator"].includes(membership.role),
  );
}
