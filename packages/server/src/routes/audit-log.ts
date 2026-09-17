import { auditLog, type PgDb } from "@kuintessence/db";
import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuditReadPermission } from "../authz/audit-read-guard";
import type { AuthzService } from "../authz/service";
import { makeAliasRecorder } from "../desensitize/alias-recorder";
import { loadDesensitizeConfig } from "../desensitize/config-loader";
import { applyDesensitizationToBody } from "../middleware/desensitize";
import type { BoundPrincipal } from "../middleware/principal-binder";

export interface AuditLogRouteOptions {
  /** Stable salt used by the `alias` action. Default: "kq-audit-v1". */
  aliasSalt?: string;
  authz?: AuthzService;
}

export function createAuditLogRoutes(db: PgDb, opts: AuditLogRouteOptions = {}) {
  const r = new Hono();
  const aliasSalt = opts.aliasSalt ?? "kq-audit-v1";
  const recordAlias = makeAliasRecorder(db);

  r.get("/audit-log", async (c) => {
    const user = c.get("user");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    await requireAuditReadPermission(c, opts.authz, "audit_read", "audit-log");
    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(Number.parseInt(limitParam ?? "100", 10), 1), 1000);
    const list = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);

    // apply desensitization. Compliance-driven default: when global
    // switch is OFF the body comes back unchanged (no behavioral regression).
    // When ON, operators can redact actor / diff (or any future field) via
    // rows in `desensitize_config`.
    const config = await loadDesensitizeConfig(db);
    const body = await applyDesensitizationToBody(
      config,
      { entries: list },
      {
        resourceType: "audit-log-entry",
        viewerRole: auditLogViewerRole(user, principal),
        viewerOrgId: null,
        resourceOwnerId: null,
        aliasSalt,
        recordAlias,
      },
    );
    return c.json(body);
  });

  return r;
}

export function auditLogViewerRole(
  _user: { role: string },
  principal: Pick<BoundPrincipal, "role"> | undefined,
): string {
  return principal?.role ?? "guest";
}
