import {
  auditLog,
  authSessions,
  dataAccessRequests,
  dataAssetImports,
  dataUploadSessions,
  fileTransfers,
  netdriveFiles,
  orgs,
  type PgDb,
  storageQuotaGrants,
  storageQuotaRequests,
  userClusterAccountMappings,
  userOrgMemberships,
  users,
  workflowDrafts,
} from "@kuintessence/db";
import { AppError, ErrorCode, hasRole, Role, type RoleName } from "@kuintessence/shared";
import { and, asc, count, desc, eq, exists, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { insertAuthzOutboxRows } from "../authz/enqueue";
import { requirePlatformPermission } from "../authz/platform-guard";
import {
  organizationMembershipDeleteTuples,
  organizationMembershipTuple,
  platformAuditorTuple,
  platformMemberTuple,
  platformRoleDeleteTuples,
} from "../authz/projection";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";

const Query = z.object({
  search: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["member", "organization", "role", "status"]).optional(),
  direction: z.enum(["asc", "desc"]).default("asc"),
  role: z
    .enum(["guest", "user", "org_admin", "operator", "platform_admin", "super_admin"])
    .optional(),
  status: z.enum(["enabled", "suspended"]).optional(),
});
const Decision = z.strictObject({
  suspended: z.boolean(),
  reason: z.string().trim().min(1).max(500),
});

const DisplayName = z
  .string()
  .trim()
  .max(255)
  .transform((name) => name || null);
const Create = z.strictObject({
  email: z.string().trim().max(255).email(),
  displayName: DisplayName,
});
const Edit = z.strictObject({ displayName: DisplayName });
const OrgId = z.string().uuid().optional();

function canProvisionUsers(actor: BoundPrincipal): boolean {
  return !!actor.userId && hasRole(actor.role as RoleName, Role.PLATFORM_ADMIN);
}

function boundActor(c: Context) {
  const actor = c.get("principal" as never) as BoundPrincipal;
  if (!actor.userId) throw new AppError(ErrorCode.FORBIDDEN, "Bound principal required", 403);
  return { ...actor, userId: actor.userId };
}

async function lockTarget(db: Pick<PgDb, "select">, id: string, actor: BoundPrincipal) {
  const [target] = await db
    .select({
      id: users.id,
      role: users.role,
      suspended: users.suspended,
      serviceAccount: users.serviceAccount,
    })
    .from(users)
    .where(eq(users.id, id))
    .for("update");
  if (!target) throw new AppError(ErrorCode.NOT_FOUND, "User not found", 404);
  if (!canManagePlatformUser(actor, target)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Cannot change your own account or an account with equal or higher privileges",
      403,
    );
  }
  return target;
}

async function hasCascadingUserHistory(db: Pick<PgDb, "select">, id: string): Promise<boolean> {
  const historyOwners = [
    workflowDrafts.ownerId,
    netdriveFiles.ownerId,
    fileTransfers.userId,
    dataAssetImports.requesterUserId,
    dataUploadSessions.ownerUserId,
    dataAccessRequests.requesterUserId,
    storageQuotaRequests.userId,
    storageQuotaGrants.userId,
    userClusterAccountMappings.userId,
  ];
  const linked = or(
    ...historyOwners.map((column) =>
      exists(db.select({ userId: column }).from(column.table).where(eq(column, id))),
    ),
  );
  const [row] = await db
    .select({ linked: sql<boolean>`${linked}` })
    .from(users)
    .where(eq(users.id, id));
  return row?.linked === true;
}

function linkedUserConflict() {
  return userConflict(
    "USER_HAS_HISTORY",
    "This user is linked to existing records. Disable the account instead.",
  );
}

function pgCode(error: unknown): unknown {
  if (error instanceof Error && error.cause) return pgCode(error.cause);
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function userConflict(reason: "EMAIL_IN_USE" | "USER_HAS_HISTORY", message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, 409, { reason });
}

export function canManagePlatformUser(
  actor: { userId: string | null; role: string },
  target: { id: string; role: string },
): boolean {
  if (!actor.userId || actor.userId === target.id) return false;
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
  async function requireProvisioning(c: Context) {
    await requirePlatformPermission(c, authz, "manage", "platform-users");
    const actor = boundActor(c);
    if (!canProvisionUsers(actor))
      throw new AppError(ErrorCode.FORBIDDEN, "Need platform_admin", 403);
    return actor;
  }
  r.use("/platform/users/*", async (c, next) => {
    await requirePlatformPermission(c, authz, "operate", "platform-users");
    await next();
  });
  r.get("/platform/users", async (c) => {
    await requirePlatformPermission(c, authz, "operate", "platform-users");
    const q = Query.parse(c.req.query());
    const orgId = OrgId.parse(c.req.header("x-kq-active-organization"));
    const filter = and(
      q.role ? eq(users.role, q.role) : undefined,
      q.status ? eq(users.suspended, q.status === "suspended") : undefined,
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
    const sortColumn =
      q.sort === "member"
        ? sql`lower(coalesce(nullif(${users.displayName}, ''), ${users.email}))`
        : q.sort === "organization"
          ? sql`coalesce((select min(${orgs.name}) from ${userOrgMemberships}
          join ${orgs} on ${orgs.id} = ${userOrgMemberships.orgId}
          where ${userOrgMemberships.userId} = ${users.id}), '')`
          : q.sort === "role"
            ? users.role
            : q.sort === "status"
              ? users.suspended
              : users.email;
    const order = q.direction === "desc" ? desc(sortColumn) : asc(sortColumn);
    const [rows, totals] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          suspended: users.suspended,
          serviceAccount: users.serviceAccount,
        })
        .from(users)
        .where(filter)
        .orderBy(order, asc(users.id))
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
          .orderBy(asc(orgs.name), asc(orgs.id))
      : [];
    const actor = c.get("principal" as never) as BoundPrincipal;
    return c.json({
      items: rows.map((row) => ({
        ...row,
        canManage: canManagePlatformUser(actor, row),
        canEdit:
          canProvisionUsers(actor) && !row.serviceAccount && canManagePlatformUser(actor, row),
        organizations: memberships
          .filter((m) => m.userId === row.id)
          .map(({ id, name }) => ({ id, name })),
      })),
      total: totals[0]?.total ?? 0,
      canCreate: canProvisionUsers(actor),
    });
  });
  r.post("/platform/users", async (c) => {
    const actor = await requireProvisioning(c);
    const body = Create.parse(await c.req.json());
    const orgId = OrgId.parse(c.req.header("x-kq-active-organization"));
    const created = await db.transaction(async (tx) => {
      if (orgId) {
        const [org] = await tx
          .select({ id: orgs.id })
          .from(orgs)
          .where(eq(orgs.id, orgId))
          .for("key share");
        if (!org) throw new AppError(ErrorCode.NOT_FOUND, "Organization not found", 404);
      }
      const [user] = await tx
        .insert(users)
        .values({ ...body, role: Role.USER, orgId })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (!user) throw userConflict("EMAIL_IN_USE", "A user already has this email address");
      if (orgId)
        await tx.insert(userOrgMemberships).values({ userId: user.id, orgId, role: "member" });
      if (authz && authz.mode !== "off") {
        await insertAuthzOutboxRows(tx, [
          platformMemberTuple(user.id),
          ...(orgId
            ? [organizationMembershipTuple({ userId: user.id, orgId, role: "member" })]
            : []),
        ]);
      }
      await tx.insert(auditLog).values({
        actor: actor.userId,
        action: "platform.user.create",
        target: user.id,
        diff: { after: { organizationId: orgId ?? null } },
      });
      return user;
    });
    return c.json(created, 201);
  });
  r.patch("/platform/users/:id", async (c) => {
    const actor = await requireProvisioning(c);
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = Edit.parse(await c.req.json());
    await db.transaction(async (tx) => {
      const target = await lockTarget(tx, id, actor);
      if (target.serviceAccount)
        throw new AppError(ErrorCode.FORBIDDEN, "Service accounts use automation credentials", 403);
      await tx
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        action: "platform.user.update",
        target: id,
        diff: { after: { fields: ["displayName"] } },
      });
    });
    return c.json({ id, ...body });
  });
  r.delete("/platform/users/:id", async (c) => {
    const actor = await requireProvisioning(c);
    const id = z.string().uuid().parse(c.req.param("id"));
    try {
      await db.transaction(async (tx) => {
        const target = await lockTarget(tx, id, actor);
        if (target.serviceAccount)
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Service accounts use automation credentials",
            403,
          );
        // Check business records that would otherwise cascade on user deletion.
        if (await hasCascadingUserHistory(tx, id)) throw linkedUserConflict();
        if (authz && authz.mode !== "off") {
          const memberships = await tx
            .select({ orgId: userOrgMemberships.orgId })
            .from(userOrgMemberships)
            .where(eq(userOrgMemberships.userId, id));
          await insertAuthzOutboxRows(tx, [
            { ...platformMemberTuple(id), operation: "delete" },
            { ...platformAuditorTuple(id), operation: "delete" },
            ...platformRoleDeleteTuples(id),
            ...memberships.flatMap(({ orgId }) =>
              organizationMembershipDeleteTuples({ orgId, userId: id }),
            ),
          ]);
        }
        await tx.delete(users).where(eq(users.id, id));
        await tx
          .insert(auditLog)
          .values({ actor: actor.userId, action: "platform.user.delete", target: id });
      });
    } catch (error) {
      if (pgCode(error) === "23503") throw linkedUserConflict();
      throw error;
    }
    return c.json({ id });
  });
  r.patch("/platform/users/:id/status", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = Decision.parse(await c.req.json());
    const actor = boundActor(c);
    const result = await db.transaction(async (tx) => {
      const target = await lockTarget(tx, id, actor);
      await tx.update(users).set({ suspended: body.suspended }).where(eq(users.id, id));
      if (body.suspended)
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date(), revokedReason: "admin" })
          .where(and(eq(authSessions.userId, id), isNull(authSessions.revokedAt)));
      await tx.insert(auditLog).values({
        actor: actor.userId,
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
