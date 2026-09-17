import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import type { Context } from "hono";
import { type BoundPrincipal, hasAuditReadonlyCapability } from "../middleware/principal-binder";
import type { AuthzService } from "./service";

export type AuditReadPermission = "audit_read" | "metering_read" | "recording_read";

export function hasAuditReadAccess(
  principal: Pick<BoundPrincipal, "role" | "capabilities"> | undefined,
): boolean {
  return (
    hasRole((principal?.role ?? "guest") as RoleName, "operator") ||
    hasAuditReadonlyCapability(principal)
  );
}

export async function requireAuditReadPermission(
  c: Context,
  authz: AuthzService | undefined,
  permission: AuditReadPermission,
  source: string,
): Promise<void> {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const localAllowed = hasAuditReadAccess(principal);
  if (!authz || authz.mode === "off") {
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Need audit read permission", 403);
    }
    return;
  }
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: principal.userId,
    actorEmail: principal.email,
    resource: { type: "platform", id: "root" },
    permission,
    subject: { type: "user", id: principal.userId },
    context: { localAllowed, source },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Need audit read permission", 403);
    }
    return;
  }
  await authz.requirePermission(check, hasRole(principal.role as RoleName, "platform_admin"));
}
