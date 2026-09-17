import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import type { Context } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { AuthzService } from "./service";

export async function requirePlatformPermission(
  c: Context,
  authz: AuthzService | undefined,
  permission: "view" | "manage",
  source: string,
): Promise<void> {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const localRole = localPlatformRole(principal);
  const localAllowed = localPlatformPermissionAllowed(localRole, permission);
  const degradedFallbackAllowed = hasRole(localRole, "platform_admin");
  if (!authz || authz.mode === "off") {
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, platformPermissionMessage(permission), 403);
    }
    return;
  }
  const subjectId = principal?.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: subjectId,
    actorEmail: principal.email,
    resource: { type: "platform", id: "root" },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, platformPermissionMessage(permission), 403);
    }
    return;
  }
  await authz.requirePermission(check, degradedFallbackAllowed);
}

export function localPlatformRole(principal: Pick<BoundPrincipal, "role"> | undefined): RoleName {
  return (principal?.role ?? "guest") as RoleName;
}

function localPlatformPermissionAllowed(role: RoleName, permission: "view" | "manage"): boolean {
  if (permission === "view") return hasRole(role, "operator");
  return hasRole(role, "platform_admin");
}

function platformPermissionMessage(permission: "view" | "manage"): string {
  return permission === "view" ? "Need platform view permission" : "Need platform_admin";
}
