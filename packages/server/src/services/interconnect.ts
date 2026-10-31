import {
  agentInstalledSoftware,
  agents,
  auditLog,
  computeCenters,
  computeClusterAgents,
  computeClusters,
  computeInterconnects,
  interconnectMapViews,
  jobs,
  orgs,
  type PgDb,
} from "@kuintessence/db";
import {
  AppError,
  type CenterInput,
  type ClusterInput,
  ErrorCode,
  type InterconnectSnapshot,
  type LinkInput,
  type MapView,
} from "@kuintessence/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

type Db = Pick<PgDb, "select" | "insert" | "update" | "delete" | "execute">;
export type InterconnectScope = {
  orgIds: string[] | null;
  userId: string;
  key: string;
  canManage: boolean;
};
function fail(message: string, status = 400): never {
  throw new AppError(
    status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.VALIDATION_ERROR,
    message,
    status,
  );
}
export function assertInterconnectOrg(scope: InterconnectScope, orgId: string) {
  if (scope.orgIds !== null && !scope.orgIds.includes(orgId)) fail("无权访问该组织的算力资源", 403);
}
async function centerForScope(db: Db, scope: InterconnectScope, id: string) {
  const [center] = await db.select().from(computeCenters).where(eq(computeCenters.id, id));
  if (!center) fail("算力中心不存在或不可访问", 404);
  assertInterconnectOrg(scope, center.orgId);
  return center;
}

export class InterconnectService {
  constructor(private db: PgDb) {}

  async snapshot(scope: InterconnectScope): Promise<InterconnectSnapshot> {
    return this.db.transaction(
      async (tx) => {
        const centers = await tx
          .select()
          .from(computeCenters)
          .where(scope.orgIds === null ? undefined : inArray(computeCenters.orgId, scope.orgIds));
        const centerIds = centers.map((c) => c.id);
        const clusters = centerIds.length
          ? await tx
              .select()
              .from(computeClusters)
              .where(inArray(computeClusters.centerId, centerIds))
          : [];
        const clusterIds = clusters.map((c) => c.id);
        const bindings = clusterIds.length
          ? await tx
              .select()
              .from(computeClusterAgents)
              .where(inArray(computeClusterAgents.clusterId, clusterIds))
          : [];
        const visibleAgents = await tx
          .select({
            id: agents.agentId,
            name: agents.siteName,
            orgId: agents.providerOrgId,
            status: agents.status,
            observedAt: agents.lastHeartbeat,
          })
          .from(agents)
          .where(scope.orgIds === null ? undefined : inArray(agents.providerOrgId, scope.orgIds));
        // A revoked or reassigned Agent must not leak telemetry through an old binding.
        const centerById = new Map(centers.map((c) => [c.id, c]));
        const clusterById = new Map(clusters.map((c) => [c.id, c]));
        const visibleBindings = bindings.filter((b) =>
          visibleAgents.some(
            (a) =>
              a.id === b.agentId &&
              a.orgId === centerById.get(clusterById.get(b.clusterId)?.centerId ?? "")?.orgId,
          ),
        );
        const agentIds = visibleBindings.map((b) => b.agentId);
        const inventory = agentIds.length
          ? await tx
              .select()
              .from(agentInstalledSoftware)
              .where(inArray(agentInstalledSoftware.agentId, agentIds))
          : [];
        const generatedAt = new Date();
        const counts = agentIds.length
          ? await tx
              .select({
                agentId: jobs.agentId,
                status: jobs.status,
                count: sql<number>`count(*)::int`,
              })
              .from(jobs)
              .where(
                and(
                  inArray(jobs.agentId, agentIds),
                  gte(jobs.completedAt, new Date(generatedAt.getTime() - 86400_000)),
                  inArray(jobs.status, ["completed", "failed"]),
                ),
              )
              .groupBy(jobs.agentId, jobs.status)
          : [];
        const links = centerIds.length
          ? await tx
              .select()
              .from(computeInterconnects)
              .where(
                and(
                  inArray(computeInterconnects.fromCenterId, centerIds),
                  inArray(computeInterconnects.toCenterId, centerIds),
                ),
              )
          : [];
        const organizations = await tx
          .select({ id: orgs.id, name: orgs.name })
          .from(orgs)
          .where(scope.orgIds === null ? undefined : inArray(orgs.id, scope.orgIds));
        const [preference] = await tx
          .select()
          .from(interconnectMapViews)
          .where(
            and(
              eq(interconnectMapViews.userId, scope.userId),
              eq(interconnectMapViews.scope, scope.key),
            ),
          );
        return {
          centers: centers.map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })),
          clusters: clusters.map((c) => {
            const ids = new Set(
              visibleBindings.filter((b) => b.clusterId === c.id).map((b) => b.agentId),
            );
            const software = new Map<
              string,
              InterconnectSnapshot["clusters"][number]["software"][number]
            >();
            for (const name of c.metadata.applications)
              software.set(name, { name, source: "declared", observedAt: null });
            for (const s of inventory.filter((s) => ids.has(s.agentId))) {
              const previous = software.get(s.name);
              const observedAt = s.reportedAt.toISOString();
              if (!previous?.observedAt || previous.observedAt < observedAt)
                software.set(s.name, { name: s.name, source: "inventory", observedAt });
            }
            const clusterCounts = counts.filter((j) => j.agentId && ids.has(j.agentId));
            return {
              ...c,
              updatedAt: c.updatedAt.toISOString(),
              agentIds: [...ids],
              software: [...software.values()].sort((a, b) => a.name.localeCompare(b.name)),
              agents: visibleAgents
                .filter((a) => ids.has(a.id))
                .map((a) => ({
                  id: a.id,
                  status: a.status,
                  observedAt: a.observedAt?.toISOString() ?? null,
                })),
              jobs24h: {
                succeeded: clusterCounts
                  .filter((j) => j.status === "completed")
                  .reduce((n, j) => n + j.count, 0),
                failed: clusterCounts
                  .filter((j) => j.status === "failed")
                  .reduce((n, j) => n + j.count, 0),
              },
            };
          }),
          links: links.map((l) => ({ ...l, updatedAt: l.updatedAt.toISOString() })),
          agents: visibleAgents.map((a) => ({
            id: a.id,
            name: a.name,
            orgId: a.orgId,
            clusterId: visibleBindings.find((b) => b.agentId === a.id)?.clusterId ?? null,
          })),
          organizations,
          defaultView: preference?.view ?? null,
          generatedAt: generatedAt.toISOString(),
          canManage: scope.canManage,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async saveCenter(scope: InterconnectScope, id: string | null, input: CenterInput) {
    return this.mutate(scope, "center", id, async (tx) => {
      assertInterconnectOrg(scope, input.orgId);
      if (id) {
        const previous = await centerForScope(tx, scope, id);
        if (previous.orgId !== input.orgId) fail("已有算力中心不能更换所属组织");
        await tx
          .update(computeCenters)
          .set({ metadata: input.metadata, updatedAt: new Date() })
          .where(eq(computeCenters.id, id));
        return id;
      }
      const [org] = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, input.orgId));
      if (!org) fail("组织不存在");
      const [row] = await tx
        .insert(computeCenters)
        .values(input)
        .returning({ id: computeCenters.id });
      if (!row) throw new Error("Inventory insert returned no row");
      return row.id;
    });
  }

  async saveCluster(scope: InterconnectScope, id: string | null, input: ClusterInput) {
    return this.mutate(scope, "cluster", id, async (tx) => {
      const center = await centerForScope(tx, scope, input.centerId);
      if (id) {
        const [old] = await tx.select().from(computeClusters).where(eq(computeClusters.id, id));
        if (!old) fail("集群不存在", 404);
        const oldCenter = await centerForScope(tx, scope, old.centerId);
        if (oldCenter.orgId !== center.orgId) fail("集群不能跨组织迁移");
      }
      if (input.agentIds.length) {
        const selected = await tx
          .select()
          .from(agents)
          .where(inArray(agents.agentId, input.agentIds))
          .for("update");
        if (
          selected.length !== input.agentIds.length ||
          selected.some((a) => a.providerOrgId !== center.orgId)
        )
          fail("Agent 必须属于算力中心的组织", 403);
        const existing = await tx
          .select()
          .from(computeClusterAgents)
          .where(inArray(computeClusterAgents.agentId, input.agentIds));
        if (existing.some((b) => b.clusterId !== id)) fail("Agent 已归属其他集群", 409);
      }
      let clusterId = id;
      if (clusterId) {
        await tx
          .update(computeClusters)
          .set({ centerId: input.centerId, metadata: input.metadata, updatedAt: new Date() })
          .where(eq(computeClusters.id, clusterId));
        await tx.delete(computeClusterAgents).where(eq(computeClusterAgents.clusterId, clusterId));
      } else {
        const [row] = await tx
          .insert(computeClusters)
          .values({ centerId: input.centerId, metadata: input.metadata })
          .returning({ id: computeClusters.id });
        if (!row) throw new Error("Cluster insert returned no row");
        clusterId = row.id;
      }
      if (input.agentIds.length)
        await tx
          .insert(computeClusterAgents)
          .values(input.agentIds.map((agentId) => ({ agentId, clusterId })));
      return clusterId;
    });
  }

  async saveLink(scope: InterconnectScope, id: string | null, input: LinkInput) {
    return this.mutate(scope, "link", id, async (tx) => {
      await centerForScope(tx, scope, input.fromCenterId);
      await centerForScope(tx, scope, input.toCenterId);
      if (id) {
        const [old] = await tx
          .select()
          .from(computeInterconnects)
          .where(eq(computeInterconnects.id, id));
        if (!old) fail("链路不存在", 404);
        await centerForScope(tx, scope, old.fromCenterId);
        await centerForScope(tx, scope, old.toCenterId);
        await tx
          .update(computeInterconnects)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(computeInterconnects.id, id));
        return id;
      }
      const [row] = await tx
        .insert(computeInterconnects)
        .values(input)
        .returning({ id: computeInterconnects.id });
      if (!row) throw new Error("Inventory insert returned no row");
      return row.id;
    });
  }

  async remove(scope: InterconnectScope, kind: "center" | "cluster" | "link", id: string) {
    return this.mutate(scope, `${kind}.delete`, id, async (tx) => {
      if (kind === "center") {
        await centerForScope(tx, scope, id);
        const children = await tx
          .select({ id: computeClusters.id })
          .from(computeClusters)
          .where(eq(computeClusters.centerId, id));
        const links = await tx
          .select({ id: computeInterconnects.id })
          .from(computeInterconnects)
          .where(
            sql`${computeInterconnects.fromCenterId} = ${id} OR ${computeInterconnects.toCenterId} = ${id}`,
          );
        if (children.length || links.length) fail("请先移除中心下的集群和关联链路", 409);
        await tx.delete(computeCenters).where(eq(computeCenters.id, id));
      } else if (kind === "cluster") {
        const [row] = await tx.select().from(computeClusters).where(eq(computeClusters.id, id));
        if (!row) fail("集群不存在", 404);
        await centerForScope(tx, scope, row.centerId);
        await tx.delete(computeClusters).where(eq(computeClusters.id, id));
      } else {
        const [row] = await tx
          .select()
          .from(computeInterconnects)
          .where(eq(computeInterconnects.id, id));
        if (!row) fail("链路不存在", 404);
        await centerForScope(tx, scope, row.fromCenterId);
        await centerForScope(tx, scope, row.toCenterId);
        await tx.delete(computeInterconnects).where(eq(computeInterconnects.id, id));
      }
      return id;
    });
  }

  async saveView(scope: InterconnectScope, view: MapView) {
    await this.db
      .insert(interconnectMapViews)
      .values({ userId: scope.userId, scope: scope.key, view })
      .onConflictDoUpdate({
        target: [interconnectMapViews.userId, interconnectMapViews.scope],
        set: { view },
      });
  }

  private async mutate(
    scope: InterconnectScope,
    kind: string,
    id: string | null,
    write: (tx: Db) => Promise<string>,
  ) {
    if (!scope.canManage) fail("无权维护算力档案", 403);
    return this.db.transaction(async (tx) => {
      // Serialize inventory edits so validation and bindings remain atomic across concurrent requests.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(725104202)`);
      const result = await write(tx);
      await tx.insert(auditLog).values({
        actor: scope.userId,
        action: `interconnect.${kind}.${id ? "update" : "create"}`,
        target: result,
        diff: { after: { id: result } },
      });
      return { id: result };
    });
  }
}
