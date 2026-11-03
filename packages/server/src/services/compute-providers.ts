import {
  agents,
  auditLog,
  computeCenters,
  orgs,
  type PgDb,
  userOrgMemberships,
} from "@kuintessence/db";
import {
  AppError,
  type ComputeProvider,
  type ComputeProviderInput,
  ErrorCode,
  ProviderProfileSchema,
} from "@kuintessence/shared";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import type { OrganizationResourceScope } from "../middleware/organization-resource-scope";

function allowed(scope: OrganizationResourceScope, id: string) {
  if (scope.orgIds !== null && !scope.orgIds.includes(id))
    throw new AppError(ErrorCode.FORBIDDEN, "无权访问该提供者", 403);
}
function missing(): never {
  throw new AppError(ErrorCode.NOT_FOUND, "提供者不存在", 404);
}
export class ComputeProviderService {
  constructor(private db: PgDb) {}

  async list(scope: OrganizationResourceScope, search: string, page: number) {
    const where = and(
      scope.orgIds === null ? undefined : inArray(orgs.id, scope.orgIds),
      search ? ilike(orgs.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
    );
    return this.db.transaction(
      async (tx) => {
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(orgs)
          .where(where);
        const rows = await tx
          .select({
            id: orgs.id,
            name: orgs.name,
            profile: orgs.profile,
            createdAt: orgs.createdAt,
            updatedAt: orgs.updatedAt,
            // Drizzle unqualifies interpolated columns in single-table selections; keep the outer ID explicit.
            centerCount: sql<number>`(select count(*)::int from ${computeCenters} where ${computeCenters.orgId} = "orgs"."id")`,
            agentCount: sql<number>`(select count(*)::int from ${agents} where ${agents.providerOrgId} = "orgs"."id")`,
            memberCount: sql<number>`(select count(*)::int from ${userOrgMemberships} where ${userOrgMemberships.orgId} = "orgs"."id")`,
          })
          .from(orgs)
          .where(where)
          .orderBy(orgs.name, orgs.id)
          .limit(20)
          .offset((page - 1) * 20);
        const items: ComputeProvider[] = rows.map((r) => ({
          ...r,
          profile: ProviderProfileSchema.parse(r.profile),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }));
        return { items, total: count?.total ?? 0, canManage: scope.canManage };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async save(scope: OrganizationResourceScope, id: string | null, input: ComputeProviderInput) {
    if (!scope.canManage || (!id && scope.orgIds !== null))
      throw new AppError(ErrorCode.FORBIDDEN, "无权维护提供者", 403);
    if (id) allowed(scope, id);
    return this.db.transaction(async (tx) => {
      const [before] = id ? await tx.select().from(orgs).where(eq(orgs.id, id)).for("update") : [];
      if (id && !before) missing();
      const [after] = id
        ? await tx
            .update(orgs)
            .set({ ...input, updatedAt: new Date() })
            .where(eq(orgs.id, id))
            .returning()
        : await tx.insert(orgs).values(input).returning();
      if (!after) missing();
      await tx.insert(auditLog).values({
        actor: scope.userId,
        action: `compute-provider.${id ? "update" : "create"}`,
        target: after.id,
        diff: { before, after },
      });
      return { id: after.id };
    });
  }

  async remove(scope: OrganizationResourceScope, id: string) {
    if (!scope.canManage || scope.orgIds !== null)
      throw new AppError(ErrorCode.FORBIDDEN, "仅平台管理员可以删除提供者", 403);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(orgs).where(eq(orgs.id, id)).for("update");
      if (!before) missing();
      // Lock the parent before checking every FK, including CASCADE and SET NULL, to preserve dependent data.
      const references = await tx.execute<{ schema: string; table: string; column: string }>(sql`
        select ns.nspname as schema, tbl.relname as table, attr.attname as column
        from pg_constraint c
        join pg_class tbl on tbl.oid = c.conrelid
        join pg_namespace ns on ns.oid = tbl.relnamespace
        join pg_attribute attr on attr.attrelid = c.conrelid and attr.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'orgs'::regclass
      `);
      for (const reference of references) {
        const found = await tx.execute(
          sql`select 1 from ${sql.identifier(reference.schema)}.${sql.identifier(reference.table)} where ${sql.identifier(reference.column)} = ${id} limit 1`,
        );
        if (found.length)
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "该提供者仍有关联成员、资源或历史业务记录，不能删除",
            409,
          );
      }
      await tx.delete(orgs).where(eq(orgs.id, id));
      await tx.insert(auditLog).values({
        actor: scope.userId,
        action: "compute-provider.delete",
        target: id,
        diff: { before },
      });
      return { deleted: true };
    });
  }
}
