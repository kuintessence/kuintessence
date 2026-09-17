import {
  auditLog,
  authzOutbox,
  authzShadowDiffs,
  type PgDb,
  userCapabilities,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import {
  organizationBaselineTuples,
  organizationMembershipDeleteTuples,
  organizationMembershipReplacementTuples,
  platformAuditorTuple,
} from "../authz/projection";
import { buildAuthzRebuildPlan } from "../authz/rebuild";
import type { AuthzService, AuthzTuple } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import { writeAudit } from "../services/audit-log-writer";

const MembershipRoleSchema = z.enum(["owner", "admin", "operator", "member", "viewer"]);

const MembershipUpsertSchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  role: MembershipRoleSchema,
});

const RawTupleSchema = z.object({
  operation: z.enum(["create", "delete"]),
  resource: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  relation: z.string().min(1),
  subject: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    relation: z.string().min(1).optional(),
  }),
  confirm: z.literal("I understand this bypasses Server business constraints"),
});

const ShadowDiffClearSchema = z.object({
  confirm: z.literal("I reviewed and accept clearing authorization shadow diffs"),
});

const OutboxProcessSchema = z.object({
  batchSize: z.number().int().min(1).max(500).default(100),
});

export interface AdminAuthzRouteOptions {
  authz: AuthzService;
  rawTupleAdminEnabled: boolean;
}

export function createAdminAuthzRoutes(db: PgDb, options: AdminAuthzRouteOptions): Hono {
  const r = new Hono();

  r.use("/admin/authz/*", async (c, next) => {
    await requirePlatformPermission(c, options.authz, "manage", "admin-authz");
    await next();
  });

  r.get("/admin/authz/health", async (c) => {
    const [health, pending, processing, dead] = await Promise.all([
      options.authz.health(),
      countAuthzOutbox(db, "pending"),
      countAuthzOutbox(db, "processing"),
      countAuthzOutbox(db, "dead"),
    ]);
    return c.json({
      success: true,
      data: {
        ...health,
        outbox: { pending, processing, dead },
        rawTupleAdminEnabled: options.rawTupleAdminEnabled && isCanonicalSuperAdmin(c),
      },
    });
  });

  r.get("/admin/authz/readiness", async (c) => {
    const [health, pending, processing, dead, shadowDiffs] = await Promise.all([
      options.authz.health(),
      countAuthzOutbox(db, "pending"),
      countAuthzOutbox(db, "processing"),
      countAuthzOutbox(db, "dead"),
      countShadowDiffs(db),
    ]);
    const blockers: string[] = [];
    if (health.mode === "off") blockers.push("AUTHZ_MODE is off");
    if (!health.configured) blockers.push("SpiceDB client is not configured");
    if (!health.healthy) blockers.push(health.error ?? "SpiceDB health check failed");
    if (!health.schemaWritten) blockers.push("SpiceDB schema has not been written by this Server");
    if (health.healthy && !health.schemaMatches) {
      blockers.push("SpiceDB schema differs from AUTHZ_SCHEMA_PATH");
    }
    if (pending > 0) blockers.push(`${pending} authz outbox rows are pending`);
    if (processing > 0) blockers.push(`${processing} authz outbox rows are still processing`);
    if (dead > 0) blockers.push(`${dead} authz outbox rows are dead-lettered`);
    if (shadowDiffs > 0) blockers.push(`${shadowDiffs} shadow authorization diffs remain`);
    return c.json({
      success: true,
      data: {
        mode: health.mode,
        healthy: health.healthy,
        schemaWritten: health.schemaWritten,
        schemaMatches: health.schemaMatches,
        outbox: { pending, processing, dead },
        shadowDiffs,
        enforceReady: blockers.length === 0,
        blockers,
        externalSmokeRequired: true,
      },
    });
  });

  r.get("/admin/authz/shadow-diffs", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = await db
      .select()
      .from(authzShadowDiffs)
      .orderBy(desc(authzShadowDiffs.createdAt))
      .limit(limit);
    return c.json({ success: true, data: rows });
  });

  r.post(
    "/admin/authz/shadow-diffs/clear",
    kqValidator("json", ShadowDiffClearSchema, "Invalid shadow diff clear body"),
    async (c) => {
      const count = await countShadowDiffs(db);
      const actorUserId = requireCanonicalAuthzAdminActor(c);
      await db.delete(authzShadowDiffs);
      await writeAudit(db, {
        actor: actorUserId,
        action: "authz.shadow_diff.clear",
        target: "authz_shadow_diffs",
        diff: { before: { count }, after: { count: 0 } },
      });
      return c.json({ success: true, data: { cleared: count } });
    },
  );

  r.get("/admin/authz/outbox", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = await db
      .select()
      .from(authzOutbox)
      .orderBy(desc(authzOutbox.createdAt))
      .limit(limit);
    return c.json({ success: true, data: rows });
  });

  r.post(
    "/admin/authz/outbox/process",
    kqValidator("json", OutboxProcessSchema, "Invalid outbox process body"),
    async (c) => {
      const body = c.req.valid("json");
      const actorUserId = requireCanonicalAuthzAdminActor(c);
      const result = await options.authz.processOutbox(body.batchSize, { forcePending: true });
      await writeAudit(db, {
        actor: actorUserId,
        action: "authz.outbox.process",
        target: "authz_outbox",
        diff: { after: { batchSize: body.batchSize, ...result } },
      });
      return c.json({ success: true, data: result });
    },
  );

  r.post("/admin/authz/outbox/:id/retry", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const [row] = await db.select().from(authzOutbox).where(eq(authzOutbox.id, id)).limit(1);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, "Authz outbox row not found", 404);
    }
    if (row.status !== "dead") {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Only dead authz outbox rows can be retried",
        400,
      );
    }
    const actorUserId = requireCanonicalAuthzAdminActor(c);
    const [updated] = await db
      .update(authzOutbox)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        processedAt: null,
      })
      .where(and(eq(authzOutbox.id, id), eq(authzOutbox.status, "dead")))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Authz outbox row is no longer dead", 400);
    }
    await writeAudit(db, {
      actor: actorUserId,
      action: "authz.outbox.retry",
      target: `authz_outbox:${id}`,
      diff: {
        before: { status: row.status, attempts: row.attempts, lastError: row.lastError },
        after: {
          status: "pending",
          attempts: 0,
          lastError: row.lastError,
        },
      },
    });
    return c.json({ success: true, data: updated });
  });

  r.get("/admin/authz/memberships", async (c) => {
    const rows = await db
      .select({
        id: userOrgMemberships.id,
        userId: userOrgMemberships.userId,
        email: users.email,
        orgId: userOrgMemberships.orgId,
        role: userOrgMemberships.role,
        updatedAt: userOrgMemberships.updatedAt,
      })
      .from(userOrgMemberships)
      .leftJoin(users, eq(users.id, userOrgMemberships.userId))
      .orderBy(desc(userOrgMemberships.updatedAt))
      .limit(500);
    return c.json({ success: true, data: rows });
  });

  r.get("/admin/authz/audit-capabilities", async (c) => {
    requireAuditCapabilityAdmin(c);
    const [userRows, capabilityRows] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
        })
        .from(users)
        .orderBy(users.email)
        .limit(500),
      db
        .select({
          userId: userCapabilities.userId,
          grantedBy: userCapabilities.grantedBy,
          grantedAt: userCapabilities.grantedAt,
        })
        .from(userCapabilities)
        .where(eq(userCapabilities.capability, "audit_readonly")),
    ]);
    const capabilityByUserId = new Map(capabilityRows.map((row) => [row.userId, row]));
    return c.json({
      success: true,
      data: userRows.map((user) => ({
        ...user,
        auditReadonly: capabilityByUserId.has(user.id),
        grantedBy: capabilityByUserId.get(user.id)?.grantedBy ?? null,
        grantedAt: capabilityByUserId.get(user.id)?.grantedAt ?? null,
      })),
    });
  });

  r.put("/admin/authz/audit-capabilities/:userId", async (c) => {
    requireAuditCapabilityAdmin(c);
    const userId = z.string().uuid().parse(c.req.param("userId"));
    const actorUserId = requireCanonicalAuthzAdminActor(c);
    const changed = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target) throw new AppError(ErrorCode.NOT_FOUND, "User not found", 404);
      const [inserted] = await tx
        .insert(userCapabilities)
        .values({
          userId,
          capability: "audit_readonly",
          grantedBy: actorUserId,
        })
        .onConflictDoNothing()
        .returning({ id: userCapabilities.id });
      if (!inserted) return false;
      await insertAuthzOutboxRows(tx, [platformAuditorTuple(userId)]);
      await tx.insert(auditLog).values({
        actor: actorUserId,
        action: "authz.audit_capability.grant",
        target: `user:${userId}#audit_readonly`,
        diff: { after: { userId, capability: "audit_readonly" } },
      });
      return true;
    });
    await processCapabilityOutboxImmediately(options.authz, changed);
    return c.json({ success: true, data: { changed } });
  });

  r.delete("/admin/authz/audit-capabilities/:userId", async (c) => {
    requireAuditCapabilityAdmin(c);
    const userId = z.string().uuid().parse(c.req.param("userId"));
    const actorUserId = requireCanonicalAuthzAdminActor(c);
    const changed = await db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(userCapabilities)
        .where(
          and(
            eq(userCapabilities.userId, userId),
            eq(userCapabilities.capability, "audit_readonly"),
          ),
        )
        .returning({ id: userCapabilities.id });
      if (!deleted) return false;
      await insertAuthzOutboxRows(tx, [{ ...platformAuditorTuple(userId), operation: "delete" }]);
      await tx.insert(auditLog).values({
        actor: actorUserId,
        action: "authz.audit_capability.revoke",
        target: `user:${userId}#audit_readonly`,
        diff: { before: { userId, capability: "audit_readonly" } },
      });
      return true;
    });
    await processCapabilityOutboxImmediately(options.authz, changed);
    return c.json({ success: true, data: { changed } });
  });

  r.post("/admin/authz/rebuild", async (c) => {
    const plan = await buildAuthzRebuildPlan(db);
    const replaceResult = await options.authz.replaceAllRelationships(plan.tuples);
    const actorUserId = requireCanonicalAuthzAdminActor(c);
    await writeAudit(db, {
      actor: actorUserId,
      action: "authz.rebuild",
      target: "spicedb:relationships",
      diff: {
        after: {
          tupleCount: replaceResult.tupleCount,
          purgedResourceTypes: replaceResult.purgedResourceTypes,
          counts: plan.counts,
        },
      },
    });
    return c.json({
      success: true,
      data: {
        tupleCount: replaceResult.tupleCount,
        purgedResourceTypes: replaceResult.purgedResourceTypes,
        counts: plan.counts,
      },
    });
  });

  r.put(
    "/admin/authz/memberships",
    kqValidator("json", MembershipUpsertSchema, "Invalid membership body"),
    async (c) => {
      const body = c.req.valid("json");
      const actorUserId = requireCanonicalAuthzAdminActor(c);
      await db.transaction(async (tx) => {
        await tx
          .insert(userOrgMemberships)
          .values(body)
          .onConflictDoUpdate({
            target: [userOrgMemberships.userId, userOrgMemberships.orgId],
            set: { role: body.role, updatedAt: new Date() },
          });
        await insertAuthzOutboxRows(tx, [
          ...organizationBaselineTuples(body.orgId),
          ...organizationMembershipReplacementTuples({
            userId: body.userId,
            orgId: body.orgId,
            role: body.role,
          }),
        ]);
      });
      await writeAudit(db, {
        actor: actorUserId,
        action: "authz.membership.upsert",
        target: `organization:${body.orgId}#${body.role}@user:${body.userId}`,
        diff: { after: { userId: body.userId, orgId: body.orgId, role: body.role } },
      });
      return c.json({ success: true });
    },
  );

  r.delete("/admin/authz/memberships/:userId/:orgId", async (c) => {
    const userId = c.req.param("userId");
    const orgId = c.req.param("orgId");
    const actorUserId = requireCanonicalAuthzAdminActor(c);
    await db.transaction(async (tx) => {
      await tx
        .delete(userOrgMemberships)
        .where(and(eq(userOrgMemberships.userId, userId), eq(userOrgMemberships.orgId, orgId)));
      await insertAuthzOutboxRows(tx, organizationMembershipDeleteTuples({ userId, orgId }));
    });
    await writeAudit(db, {
      actor: actorUserId,
      action: "authz.membership.delete",
      target: `organization:${orgId}#membership@user:${userId}`,
      diff: { before: { userId, orgId } },
    });
    return c.json({ success: true });
  });

  r.post(
    "/admin/authz/raw-tuples",
    kqValidator("json", RawTupleSchema, "Invalid raw tuple body"),
    async (c) => {
      if (!options.rawTupleAdminEnabled) {
        throw new AppError(ErrorCode.FORBIDDEN, "Raw tuple admin is disabled", 403);
      }
      const body = c.req.valid("json");
      const actorUserId = requireCanonicalAuthzSuperAdminActor(c);
      await writeAudit(db, {
        actor: actorUserId,
        action: "authz.raw_tuple.break_glass",
        target: `${body.resource.type}:${body.resource.id}#${body.relation}`,
        diff: {
          after: {
            operation: body.operation,
            subject: body.subject,
          },
        },
      });
      await options.authz.enqueue({
        operation: body.operation,
        resource: body.resource,
        relation: body.relation,
        subject: body.subject,
        payload: { breakGlass: true, actor: actorUserId },
      });
      return c.json({ success: true });
    },
  );

  return r;
}

function requireCanonicalAuthzAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

function requireCanonicalAuthzSuperAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!isCanonicalSuperAdmin(c) || !principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Need super_admin", 403);
  }
  return principal.userId;
}

function isCanonicalSuperAdmin(c: Context): boolean {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return principal?.role === "super_admin";
}

function requireAuditCapabilityAdmin(c: Context): void {
  const user = c.get("user" as never) as { role?: string } | undefined;
  if (user?.role !== "platform_admin" && user?.role !== "super_admin") {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Only platform administrators can manage audit capabilities",
      403,
    );
  }
}

async function processCapabilityOutboxImmediately(
  authz: AuthzService,
  changed: boolean,
): Promise<void> {
  if (changed && authz.mode === "enforce") {
    await authz.processOutbox(100, { forcePending: true });
  }
}

type AuthzOutboxDb = Pick<PgDb, "insert">;

async function insertAuthzOutboxRows(db: AuthzOutboxDb, tuples: AuthzTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await db.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}

function clampLimit(value: string | undefined): number {
  const parsed = Number(value ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

async function countAuthzOutbox(db: PgDb, status: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(authzOutbox)
    .where(eq(authzOutbox.status, status));
  return row?.count ?? 0;
}

async function countShadowDiffs(db: PgDb): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(authzShadowDiffs);
  return row?.count ?? 0;
}
