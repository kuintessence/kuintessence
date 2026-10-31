import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agents,
  auditLog,
  computeCenters,
  computeClusters,
  computeInterconnects,
  createPgDb,
  interconnectMapViews,
  jobs,
  orgs,
  users,
} from "@kuintessence/db";
import {
  type CenterInput,
  type ClusterInput,
  DEFAULT_MAP_VIEW,
  type LinkInput,
  summarizeInterconnect,
} from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { type InterconnectScope, InterconnectService } from "./interconnect";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence", {
  max: 4,
});
const service = new InterconnectService(db);
const orgA = crypto.randomUUID(),
  orgB = crypto.randomUUID(),
  userId = crypto.randomUUID();
const agentIds: [string, string, string] = [
  `interconnect-a-${crypto.randomUUID()}`,
  `interconnect-b-${crypto.randomUUID()}`,
  `interconnect-c-${crypto.randomUUID()}`,
];
const scope: InterconnectScope = {
  orgIds: [orgA],
  userId,
  key: `provider:${orgA}`,
  canManage: true,
};
const globalScope: InterconnectScope = { ...scope, orgIds: null, key: "operator" };
let centerA: string, centerB: string, clusterId: string, linkId: string;
const createdIds: string[] = [];
const centerInput = (orgId: string, name: string): CenterInput => ({
  orgId,
  metadata: {
    name,
    country: "中国",
    province: "北京",
    city: "北京",
    longitude: 116,
    latitude: 40,
    status: "operational",
  },
});
const clusterInput = (centerId: string, ids: string[]): ClusterInput => ({
  centerId,
  agentIds: ids,
  metadata: {
    name: "Cluster",
    status: "operational",
    computeTypes: ["CPU", "GPU"],
    cpuCores: 64,
    storageBytes: 1024,
    storageTypes: ["Ceph"],
    applications: ["gromacs", "declared-only"],
  },
});
beforeAll(async () => {
  await db.insert(orgs).values([
    { id: orgA, name: "Interconnect A" },
    { id: orgB, name: "Interconnect B" },
  ]);
  await db
    .insert(users)
    .values({ id: userId, email: `interconnect-${userId}@example.test`, role: "platform_admin" });
  await db.insert(agents).values(
    agentIds.map((agentId) => ({
      agentId,
      siteName: agentId,
      providerOrgId: orgA,
      schedulerType: "slurm",
      schedulerVersion: "test",
      status: "online",
      lastHeartbeat: new Date(),
    })),
  );
  centerA = (await service.saveCenter(scope, null, centerInput(orgA, "A"))).id;
  centerB = (await service.saveCenter(globalScope, null, centerInput(orgB, "B"))).id;
  createdIds.push(centerA, centerB);
  clusterId = (await service.saveCluster(scope, null, clusterInput(centerA, agentIds.slice(0, 2))))
    .id;
  createdIds.push(clusterId);
  await db.insert(agentInstalledSoftware).values(
    agentIds.slice(0, 2).map((agentId, index) => ({
      agentId,
      name: "gromacs",
      version: String(index),
      hash: `hash${index}`,
      spec: "gromacs",
      reportedAt: new Date(),
    })),
  );
  await db.insert(jobs).values([
    {
      name: "done",
      command: "true",
      cpus: 1,
      memoryMb: 1,
      agentId: agentIds[0],
      providerOrgId: orgA,
      status: "completed",
      completedAt: new Date(),
    },
    {
      name: "fail",
      command: "false",
      cpus: 1,
      memoryMb: 1,
      agentId: agentIds[1],
      providerOrgId: orgA,
      status: "failed",
      completedAt: new Date(),
    },
  ]);
  const link: LinkInput = {
    fromCenterId: centerA,
    toCenterId: centerB,
    metadata: {
      name: "Cross-provider link",
      status: "unknown",
      bandwidthMbps: null,
      throughputMbps: null,
      latencyMs: null,
      packetLossPercent: null,
      observedAt: null,
      source: "",
    },
  };
  linkId = (await service.saveLink(globalScope, null, link)).id;
  createdIds.push(linkId);
});
afterAll(async () => {
  await db.delete(computeInterconnects).where(inArray(computeInterconnects.id, createdIds));
  await db.delete(computeClusters).where(inArray(computeClusters.centerId, [centerA, centerB]));
  await db.delete(computeCenters).where(inArray(computeCenters.orgId, [orgA, orgB]));
  await db.delete(interconnectMapViews).where(eq(interconnectMapViews.userId, userId));
  await db.delete(auditLog).where(eq(auditLog.actor, userId));
  await db.delete(jobs).where(inArray(jobs.agentId, agentIds));
  await db.delete(agents).where(inArray(agents.agentId, agentIds));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
});
describe("interconnect relational inventory", () => {
  test("aggregates logical cluster once and deduplicates software versions and agents", async () => {
    const snapshot = await service.snapshot(scope);
    expect(snapshot.centers.map((c) => c.id)).toEqual([centerA]);
    const cluster = snapshot.clusters.find((c) => c.id === clusterId);
    expect(cluster?.software.map((s) => s.name).sort()).toEqual(["declared-only", "gromacs"]);
    expect(cluster?.software.find((s) => s.name === "gromacs")?.source).toBe("inventory");
    expect(cluster?.jobs24h).toEqual({ succeeded: 1, failed: 1 });
    expect(summarizeInterconnect(snapshot.centers, snapshot.clusters).cpuCores).toBe(64);
    expect(snapshot.links).toEqual([]);
    expect((await service.snapshot(globalScope)).links.some((l) => l.id === linkId)).toBe(true);
  });
  test("rejects cross-org reads, bindings, moves and link edits", async () => {
    await expect(service.saveCenter(scope, centerB, centerInput(orgA, "stolen"))).rejects.toThrow(
      "无权访问",
    );
    await expect(
      service.saveCluster(globalScope, null, clusterInput(centerB, [agentIds[2]])),
    ).rejects.toThrow("Agent 必须属于");
    await expect(
      service.saveCenter(globalScope, centerA, centerInput(orgB, "moved")),
    ).rejects.toThrow("不能更换");
    const cross = (await service.snapshot(globalScope)).links.find((l) => l.id === linkId);
    if (!cross) throw new Error("Test link is missing");
    await expect(service.saveLink(scope, linkId, cross)).rejects.toThrow("无权访问");
  });
  test("duplicate binding failure leaves the original cluster intact", async () => {
    await expect(
      service.saveCluster(scope, null, clusterInput(centerA, [agentIds[0]])),
    ).rejects.toThrow("已归属");
    expect(
      (await service.snapshot(scope)).clusters.find((c) => c.id === clusterId)?.agentIds.sort(),
    ).toEqual(agentIds.slice(0, 2).sort());
  });
  test("concurrent binding attempts create exactly one owner", async () => {
    const results = await Promise.allSettled([
      service.saveCluster(scope, null, clusterInput(centerA, [agentIds[2]])),
      service.saveCluster(scope, null, clusterInput(centerA, [agentIds[2]])),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (await service.snapshot(scope)).clusters.filter((c) => c.agentIds.includes(agentIds[2])),
    ).toHaveLength(1);
  });
  test("reassigned agents no longer expose inventory or job statistics to the old provider", async () => {
    await db.update(agents).set({ providerOrgId: orgB }).where(eq(agents.agentId, agentIds[0]));
    try {
      const snapshot = await service.snapshot(scope);
      expect(snapshot.agents.some((a) => a.id === agentIds[0])).toBe(false);
      expect(snapshot.clusters.find((c) => c.id === clusterId)?.jobs24h.succeeded).toBe(0);
    } finally {
      await db.update(agents).set({ providerOrgId: orgA }).where(eq(agents.agentId, agentIds[0]));
    }
  });
  test("new provider can bind a transferred Agent without inheriting the old provider's job counts", async () => {
    const scopeB: InterconnectScope = { ...scope, orgIds: [orgB], key: `provider:${orgB}` };
    await db.update(agents).set({ providerOrgId: orgB }).where(eq(agents.agentId, agentIds[0]));
    let rebound: string | null = null;
    try {
      const before = await service.snapshot(scopeB);
      expect(before.agents.find((a) => a.id === agentIds[0])?.clusterId).toBeNull();
      rebound = (await service.saveCluster(scopeB, null, clusterInput(centerB, [agentIds[0]]))).id;
      const snapshot = await service.snapshot(scopeB);
      expect(snapshot.clusters.find((c) => c.id === rebound)?.agentIds).toEqual([agentIds[0]]);
      expect(snapshot.clusters.find((c) => c.id === rebound)?.jobs24h).toEqual({
        succeeded: 0,
        failed: 0,
      });
    } finally {
      if (rebound) await service.remove(scopeB, "cluster", rebound);
      await db.update(agents).set({ providerOrgId: orgA }).where(eq(agents.agentId, agentIds[0]));
      await service.saveCluster(scope, clusterId, clusterInput(centerA, agentIds.slice(0, 2)));
    }
  });
  test("saves independent defaults per user and scope and protects dependent centers", async () => {
    await service.saveView(scope, { ...DEFAULT_MAP_VIEW, level: "world", zoom: 2 });
    expect((await service.snapshot(scope)).defaultView?.zoom).toBe(2);
    expect((await service.snapshot(globalScope)).defaultView).toBeNull();
    await expect(service.remove(scope, "center", centerA)).rejects.toThrow("请先移除");
    await expect(
      service.saveCenter({ ...scope, canManage: false }, null, centerInput(orgA, "denied")),
    ).rejects.toThrow("无权维护");
    await service.remove(globalScope, "link", linkId);
    expect((await service.snapshot(globalScope)).links.some((l) => l.id === linkId)).toBe(false);
  });
});
