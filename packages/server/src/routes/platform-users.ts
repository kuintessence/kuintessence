import {
  auditLog,
  authSessions,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, asc, count, eq, exists, ilike, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";

const Query = z.object({
  search: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const Decision = z.strictObject({
  suspended: z.boolean(),
  reason: z.string().trim().min(1).max(500),
});

export function canManagePlatformUser(
  actor: { userId: string | null; role: string },
  target: { id: string; role: string },
): boolean {
  if (actor.userId === target.id) return false;
  const rank: Record<string, number> = {
    guest: 0,
    user: 0,
    org_admin: 1,
    operator: 2,
    platform_admin: 3,
    super_admin: 4,
  };
  return (rank[actor.role] ?? -1) >= 2 && (rank[actor.role] ?? -1) > (rank[target.role] ?? 4);
}

export function createPlatformUserRoutes(db: PgDb, authz?: AuthzService) {
  const r = new Hono();
  r.use("/platform/users/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "operate", "platform-users");
    await next();
  });
  r.get("/platform/users", async (c) => {
    await requirePlatformPermission(c, authz, "operate", "platform-users");
    const q = Query.parse(c.req.query());
    const orgId = z.string().uuid().optional().parse(c.req.header("x-kq-active-organization"));
    const filter = and(
      q.search
        ? or(ilike(users.email, `%${q.search}%`), ilike(users.displayName, `%${q.search}%`))
        : undefined,
      orgId
        ? exists(
            db
              .select({ id: userOrgMemberships.userId })
              .from(userOrgMemberships)
              .where(
                and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, orgId)),
              ),
          )
        : undefined,
    );
    const [rows, totals] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          suspended: users.suspended,
        })
        .from(users)
        .where(filter)
        .orderBy(asc(users.email), asc(users.id))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(users).where(filter),
    ]);
    const memberships = rows.length
      ? await db
          .select({ userId: userOrgMemberships.userId, id: orgs.id, name: orgs.name })
          .from(userOrgMemberships)
          .innerJoin(orgs, eq(userOrgMemberships.orgId, orgs.id))
          .where(
            inArray(
              userOrgMemberships.userId,
              rows.map((row) => row.id),
            ),
          )
      : [];
    const actor = c.get("principal" as never) as BoundPrincipal;
    return c.json({
      items: rows.map((row) => ({
        ...row,
        canManage: canManagePlatformUser(actor, row),
        organizations: memberships
          .filter((m) => m.userId === row.id)
          .map(({ id, name }) => ({ id, name })),
      })),
      total: totals[0]?.total ?? 0,
    });
  });
  r.patch("/platform/users/:id/status", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = Decision.parse(await c.req.json());
    const actor = c.get("principal" as never) as BoundPrincipal;
    if (!actor.userId) throw new AppError(ErrorCode.FORBIDDEN, "Bound principal required", 403);
    const actorId = actor.userId;
    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, role: users.role, suspended: users.suspended })
        .from(users)
        .where(eq(users.id, id))
        .for("update");
      if (!target) throw new AppError(ErrorCode.NOT_FOUND, "User not found", 404);
      if (!canManagePlatformUser(actor, target))
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "Cannot change your own account or an account with equal or higher privileges",
          403,
        );
      await tx.update(users).set({ suspended: body.suspended }).where(eq(users.id, id));
      if (body.suspended)
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date(), revokedReason: "admin" })
          .where(and(eq(authSessions.userId, id), isNull(authSessions.revokedAt)));
      await tx.insert(auditLog).values({
        actor: actorId,
        action: "platform.user.status",
        target: id,
        diff: { before: { suspended: target.suspended }, after: body },
      });
      return { id, suspended: body.suspended };
    });
    return c.json(result);
  });
  return r;
}
