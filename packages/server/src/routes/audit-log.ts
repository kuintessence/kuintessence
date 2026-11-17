import { auditLog, type PgDb } from "@kuintessence/db";
import { and, count, desc, gte, ilike, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuditReadPermission } from "../authz/audit-read-guard";
import type { AuthzService } from "../authz/service";
import { makeAliasRecorder } from "../desensitize/alias-recorder";
import { loadDesensitizeConfig } from "../desensitize/config-loader";
import { decideAction } from "../desensitize/decision";
import { applyDesensitizationToBody } from "../middleware/desensitize";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { AuditLogQuerySchema, auditSearchPattern } from "./audit-log-query";

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
    const q = AuditLogQuerySchema.parse(c.req.query());
    const config = await loadDesensitizeConfig(db);
    // Searching hidden raw values would reveal them through matching counts.
    const match = (field: "action" | "actor" | "target", value: string) =>
      decideAction(config, { fieldPath: field }) === "passthrough"
        ? ilike(auditLog[field], auditSearchPattern(value))
        : sql`false`;
    const filter = and(
      q.search
        ? or(match("action", q.search), match("actor", q.search), match("target", q.search))
        : undefined,
      q.action ? match("action", q.action) : undefined,
      q.actor ? match("actor", q.actor) : undefined,
      q.target ? match("target", q.target) : undefined,
      q.from
        ? decideAction(config, { fieldPath: "createdAt" }) === "passthrough"
          ? gte(auditLog.createdAt, new Date(q.from))
          : sql`false`
        : undefined,
      q.to
        ? decideAction(config, { fieldPath: "createdAt" }) === "passthrough"
          ? lte(auditLog.createdAt, new Date(q.to))
          : sql`false`
        : undefined,
    );
    const { list, total } = await db.transaction(
      async (tx) => {
        const list = await tx
          .select()
          .from(auditLog)
          .where(filter)
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(q.limit)
          .offset(q.offset);
        const [totals] = await tx.select({ total: count() }).from(auditLog).where(filter);
        return { list, total: totals?.total ?? 0 };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    // apply desensitization. Compliance-driven default: when global
    // switch is OFF the body comes back unchanged (no behavioral regression).
    // When ON, operators can redact actor / diff (or any future field) via
    // rows in `desensitize_config`.
    const body = await applyDesensitizationToBody(
      config,
      { entries: list, total, limit: q.limit, offset: q.offset },
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
