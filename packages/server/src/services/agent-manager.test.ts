// Test isolation: this suite uses agent IDs prefixed with "test-agent-am".
// Each test suite that touches the agents table MUST use a distinct prefix to allow
// parallel runs without collision. Currently in use:
//   - test-agent-am, test-agent-am-2, test-agent-am-offline  (this file)
//   - route-test-agent                                         (routes/agents.test.ts)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { agentMetrics, agents, auditLog, createPgDb, orgs, type PgDb } from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import type { AuthzService, AuthzTuple } from "../authz/service";
import { AgentManager } from "./agent-manager";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PROVIDER_A = "00000000-0000-4000-8000-00000000a001";
const PROVIDER_B = "00000000-0000-4000-8000-00000000a002";

function capturingAuthz(enqueued: AuthzTuple[]): AuthzService {
  return {
    mode: "enforce",
    enqueueMany: async (tuples: AuthzTuple[]) => {
      enqueued.push(...tuples);
    },
  } as unknown as AuthzService;
}

describe("AgentManager", () => {
  let db: PgDb;
  let manager: AgentManager;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    manager = new AgentManager(db);
  });

  beforeEach(async () => {
    // Clean up any test agents from previous runs
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-2"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-offline"));
    await db.delete(auditLog).where(eq(auditLog.target, "test-agent-am-stale"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-stale"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-fresh"));
    await db
      .insert(orgs)
      .values({ id: PROVIDER_A, name: "agent-manager-provider-a" })
      .onConflictDoNothing();
    await db
      .insert(orgs)
      .values({ id: PROVIDER_B, name: "agent-manager-provider-b" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-2"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-offline"));
    await db.delete(auditLog).where(eq(auditLog.target, "test-agent-am-stale"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-stale"));
    await db.delete(agents).where(eq(agents.agentId, "test-agent-am-fresh"));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_A));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_B));
  });

  test("register new agent", async () => {
    const result = await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    expect(result.agentId).toBe("test-agent-am");
    expect(result.status).toBe("online");
    expect(result.siteName).toBe("test-site");
  });

  test("re-register updates existing agent", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "site-1",
      schedulerType: "slurm",
      schedulerVersion: "20.11.0",
    });
    const updated = await manager.register({
      agentId: "test-agent-am",
      siteName: "site-2",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    expect(updated.siteName).toBe("site-2");
    expect(updated.schedulerVersion).toBe("23.02.7");
  });

  test("register projects agent platform and provider relationships", async () => {
    const enqueued: AuthzTuple[] = [];
    const authzManager = new AgentManager(db, capturingAuthz(enqueued));

    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      providerOrgId: PROVIDER_A,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    expect(enqueued).toEqual([
      {
        operation: "create",
        resource: { type: "agent", id: "test-agent-am" },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "create",
        resource: { type: "agent", id: "test-agent-am" },
        relation: "provider",
        subject: { type: "provider", id: PROVIDER_A },
      },
    ]);
  });

  test("re-register deletes stale provider relationship before creating the current one", async () => {
    const enqueued: AuthzTuple[] = [];
    const authzManager = new AgentManager(db, capturingAuthz(enqueued));

    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-1",
      providerOrgId: PROVIDER_A,
      schedulerType: "slurm",
      schedulerVersion: "20.11.0",
    });
    enqueued.length = 0;
    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-2",
      providerOrgId: PROVIDER_B,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    expect(enqueued).toEqual([
      {
        operation: "create",
        resource: { type: "agent", id: "test-agent-am" },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "delete",
        resource: { type: "agent", id: "test-agent-am" },
        relation: "provider",
        subject: { type: "provider", id: PROVIDER_A },
      },
      {
        operation: "create",
        resource: { type: "agent", id: "test-agent-am" },
        relation: "provider",
        subject: { type: "provider", id: PROVIDER_B },
      },
    ]);
  });

  test("re-register with unchanged provider does not enqueue duplicate authz tuples", async () => {
    const enqueued: AuthzTuple[] = [];
    const authzManager = new AgentManager(db, capturingAuthz(enqueued));

    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-1",
      providerOrgId: PROVIDER_A,
      schedulerType: "slurm",
      schedulerVersion: "20.11.0",
    });
    enqueued.length = 0;
    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-2",
      providerOrgId: PROVIDER_A,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    expect(enqueued).toEqual([]);
  });

  test("re-register without provider does not enqueue duplicate platform tuple", async () => {
    const enqueued: AuthzTuple[] = [];
    const authzManager = new AgentManager(db, capturingAuthz(enqueued));

    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-1",
      schedulerType: "slurm",
      schedulerVersion: "20.11.0",
    });
    enqueued.length = 0;
    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-2",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    expect(enqueued).toEqual([]);
  });

  test("re-register without provider preserves existing provider binding", async () => {
    const enqueued: AuthzTuple[] = [];
    const authzManager = new AgentManager(db, capturingAuthz(enqueued));

    await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-1",
      providerOrgId: PROVIDER_A,
      schedulerType: "slurm",
      schedulerVersion: "20.11.0",
    });
    enqueued.length = 0;
    const updated = await authzManager.register({
      agentId: "test-agent-am",
      siteName: "site-2",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    expect(updated.providerOrgId).toBe(PROVIDER_A);
    expect(enqueued).toEqual([]);
  });

  test("heartbeat updates metrics and status", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const updated = await manager.heartbeat({
      agentId: "test-agent-am",
      cpuUsagePercent: 55.0,
      memoryUsedMb: 16384,
      memoryTotalMb: 32768,
    });
    expect(updated.cpuUsagePercent).toBe(55);
    expect(updated.memoryUsedMb).toBe(16384);
    expect(updated.memoryTotalMb).toBe(32768);
    expect(updated.status).toBe("online");
  });

  test("re-registration clears a previously ready compute-health report, including legacy fallback", async () => {
    const observedAt = new Date("2026-08-03T08:00:00.000Z");
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });
    await manager.heartbeat(
      {
        agentId: "test-agent-am",
        cpuUsagePercent: 10,
        memoryUsedMb: 1_024,
        memoryTotalMb: 8_192,
        computeHealth: {
          state: "ready",
          observedAtUnixMs: BigInt(observedAt.getTime()),
          nodeCount: 2,
          operationalNodeCount: 2,
        },
      },
      observedAt,
    );

    const reset = await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });
    expect(reset.computeHealthCapable).toBe(true);
    expect(reset.computeHealthStatus).toBe("unknown");
    expect(reset.computeHealthObservedAt).toBeNull();

    const legacyReset = await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    expect(legacyReset.computeHealthCapable).toBe(false);
    expect(legacyReset.computeHealthStatus).toBe("unknown");
    expect(legacyReset.computeHealthObservedAt).toBeNull();
    expect(legacyReset.computeHealthReason).toBeNull();
    expect(legacyReset.computeHealthNodeCount).toBeNull();
    expect(legacyReset.computeHealthOperationalNodeCount).toBeNull();
  });

  test("heartbeat persists valid compute health but never retains an arbitrary reason", async () => {
    const observedAt = new Date("2026-08-03T08:00:00.000Z");
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });

    const stored = await manager.heartbeat(
      {
        agentId: "test-agent-am",
        cpuUsagePercent: 10,
        memoryUsedMb: 1_024,
        memoryTotalMb: 8_192,
        computeHealth: {
          state: "unavailable",
          observedAtUnixMs: BigInt(observedAt.getTime()),
          nodeCount: 3,
          operationalNodeCount: 0,
          reason: "qstat failed: arbitrary CLI output",
        },
      },
      observedAt,
    );

    expect(stored.computeHealthCapable).toBe(true);
    expect(stored.computeHealthStatus).toBe("unavailable");
    expect(stored.computeHealthObservedAt).toEqual(observedAt);
    expect(stored.computeHealthReason).toBe("unknown");
    expect(stored.computeHealthNodeCount).toBe(3);
    expect(stored.computeHealthOperationalNodeCount).toBe(0);
  });

  test("clamps bounded future clock skew but rejects out-of-bound or expired samples", async () => {
    const now = new Date("2026-08-03T08:00:00.000Z");
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });

    const bounded = await manager.heartbeat(
      {
        agentId: "test-agent-am",
        cpuUsagePercent: 10,
        memoryUsedMb: 1_024,
        memoryTotalMb: 8_192,
        computeHealth: {
          state: "ready",
          observedAtUnixMs: BigInt(now.getTime() + 5_000),
          nodeCount: 2,
          operationalNodeCount: 2,
        },
      },
      now,
    );
    expect(bounded.computeHealthStatus).toBe("ready");
    expect(bounded.computeHealthObservedAt).toEqual(now);
    expect(bounded.computeHealthReason).toBeNull();

    for (const observedAtUnixMs of [
      BigInt(now.getTime() + 5_001),
      BigInt(now.getTime() - 120_001),
    ]) {
      const stored = await manager.heartbeat(
        {
          agentId: "test-agent-am",
          cpuUsagePercent: 10,
          memoryUsedMb: 1_024,
          memoryTotalMb: 8_192,
          computeHealth: {
            state: "ready",
            observedAtUnixMs,
            nodeCount: 2,
            operationalNodeCount: 2,
          },
        },
        now,
      );
      expect(stored.computeHealthCapable).toBe(true);
      expect(stored.computeHealthStatus).toBe("unknown");
      expect(stored.computeHealthObservedAt).toBeNull();
      expect(stored.computeHealthReason).toBe("invalid_observed_at");
      expect(stored.computeHealthNodeCount).toBeNull();
      expect(stored.computeHealthOperationalNodeCount).toBeNull();
    }
  });

  test("contradictory compute-health state and node counts fail closed", async () => {
    const now = new Date("2026-08-03T08:00:00.000Z");
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });

    for (const computeHealth of [
      {
        state: "ready" as const,
        observedAtUnixMs: BigInt(now.getTime()),
        nodeCount: 1,
        operationalNodeCount: 0,
      },
      {
        state: "unavailable" as const,
        observedAtUnixMs: BigInt(now.getTime()),
        nodeCount: 1,
        operationalNodeCount: 1,
        reason: "no_operational_nodes",
      },
    ]) {
      const stored = await manager.heartbeat(
        {
          agentId: "test-agent-am",
          cpuUsagePercent: 10,
          memoryUsedMb: 1_024,
          memoryTotalMb: 8_192,
          computeHealth,
        },
        now,
      );
      expect(stored.computeHealthStatus).toBe("unknown");
      expect(stored.computeHealthObservedAt).toBeNull();
      expect(stored.computeHealthReason).toBe("invalid_health_report");
      expect(stored.computeHealthNodeCount).toBeNull();
      expect(stored.computeHealthOperationalNodeCount).toBeNull();
    }
  });

  test("heartbeat persists migration-0013 queueDepth and historicalP95WaitSec when provided", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const updated = await manager.heartbeat({
      agentId: "test-agent-am",
      cpuUsagePercent: 25,
      memoryUsedMb: 1024,
      memoryTotalMb: 8192,
      queueDepth: 7,
      historicalP95WaitSec: 360,
    });
    expect(updated.queueDepth).toBe(7);
    expect(updated.historicalP95WaitSec).toBe(360);
  });

  test("heartbeat without queueDepth/historicalP95WaitSec preserves existing values", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    // First heartbeat sets the columns.
    await manager.heartbeat({
      agentId: "test-agent-am",
      cpuUsagePercent: 25,
      memoryUsedMb: 1024,
      memoryTotalMb: 8192,
      queueDepth: 7,
      historicalP95WaitSec: 360,
    });
    // Second heartbeat omits them; the old values must survive (no
    // accidental zero-reset for older agents that don't yet report the
    // new fields).
    const updated = await manager.heartbeat({
      agentId: "test-agent-am",
      cpuUsagePercent: 30,
      memoryUsedMb: 2048,
      memoryTotalMb: 8192,
    });
    expect(updated.queueDepth).toBe(7);
    expect(updated.historicalP95WaitSec).toBe(360);
  });

  test("heartbeat for unknown agent throws AppError NOT_FOUND", async () => {
    await expect(
      manager.heartbeat({
        agentId: "nonexistent-agent-xyz",
        cpuUsagePercent: 50,
        memoryUsedMb: 1024,
        memoryTotalMb: 8192,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  test("getById returns agent or null", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const found = await manager.getById("test-agent-am");
    expect(found?.agentId).toBe("test-agent-am");

    const missing = await manager.getById("nonexistent");
    expect(missing).toBeNull();
  });

  test("list returns all agents", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "site-a",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await manager.register({
      agentId: "test-agent-am-2",
      siteName: "site-b",
      schedulerType: "kubernetes",
      schedulerVersion: "1.28",
    });
    const list = await manager.list();
    const ids = list.map((a) => a.agentId);
    expect(ids).toContain("test-agent-am");
    expect(ids).toContain("test-agent-am-2");
  });

  test("list/getById enrich each agent with latest GPU + disk telemetry from agent_metrics", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const older = new Date("2026-05-31T10:00:00Z");
    const newer = new Date("2026-05-31T10:05:00Z");
    await db.insert(agentMetrics).values([
      // disk: stale 30 then latest 64 — only 64 should surface.
      { agentId: "test-agent-am", metric: "disk_used_percent", value: 30, ts: older },
      { agentId: "test-agent-am", metric: "disk_used_percent", value: 64, ts: newer },
      // gpu index 0: stale 10 then latest 87.
      {
        agentId: "test-agent-am",
        metric: "gpu",
        value: 10,
        payload: { index: 0, model: "A100", memUsedMb: 1000, memTotalMb: 40000 },
        ts: older,
      },
      {
        agentId: "test-agent-am",
        metric: "gpu",
        value: 87,
        payload: { index: 0, model: "A100", memUsedMb: 12000, memTotalMb: 40000 },
        ts: newer,
      },
      // gpu index 1: single sample.
      {
        agentId: "test-agent-am",
        metric: "gpu",
        value: 12,
        payload: { index: 1, model: "A100", memUsedMb: 500, memTotalMb: 40000 },
        ts: newer,
      },
    ]);

    const list = await manager.list();
    const row = list.find((a) => a.agentId === "test-agent-am");
    expect(row?.diskUsedPercent).toBe(64);
    expect(row?.gpus).toEqual([
      { index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 },
      { index: 1, model: "A100", utilPercent: 12, memUsedMb: 500, memTotalMb: 40000 },
    ]);

    const byId = await manager.getById("test-agent-am");
    expect(byId?.diskUsedPercent).toBe(64);
    expect(byId?.gpus).toHaveLength(2);
  });

  test("list returns gpus=[] and no disk for an agent with no telemetry", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const row = (await manager.list()).find((a) => a.agentId === "test-agent-am");
    expect(row?.gpus).toEqual([]);
    expect(row?.diskUsedPercent).toBeUndefined();
  });

  test("getOnlineAgent returns an online agent or null", async () => {
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const online = await manager.getOnlineAgent();
    expect(online).not.toBeNull();
    expect(online?.status).toBe("online");
  });

  test("listOnline returns only online agents", async () => {
    // Register an offline agent first
    await manager.register({
      agentId: "test-agent-am-offline",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    // Manually mark it offline
    await db
      .update(agents)
      .set({ status: "offline" })
      .where(eq(agents.agentId, "test-agent-am-offline"));

    // Register an online agent
    await manager.register({
      agentId: "test-agent-am",
      siteName: "test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    const list = await manager.listOnline();
    const ids = list.map((a) => a.agentId);
    expect(ids).toContain("test-agent-am");
    expect(ids).not.toContain("test-agent-am-offline");
  });

  test("sweeps stale Agents offline, preserves fresh Agents, and restores on heartbeat", async () => {
    const now = new Date("2026-07-27T08:00:00.000Z");
    await manager.register({
      agentId: "test-agent-am-stale",
      siteName: "stale-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await manager.register({
      agentId: "test-agent-am-fresh",
      siteName: "fresh-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await db
      .update(agents)
      .set({ lastHeartbeat: new Date(now.getTime() - 61_000) })
      .where(eq(agents.agentId, "test-agent-am-stale"));
    await db
      .update(agents)
      .set({ lastHeartbeat: new Date(now.getTime() - 60_000) })
      .where(eq(agents.agentId, "test-agent-am-fresh"));

    expect(await manager.sweepStaleHeartbeats(60, now)).toEqual(["test-agent-am-stale"]);
    expect((await manager.getById("test-agent-am-stale"))?.status).toBe("offline");
    expect((await manager.getById("test-agent-am-fresh"))?.status).toBe("online");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "agent.heartbeat.timeout"),
          eq(auditLog.target, "test-agent-am-stale"),
        ),
      );
    expect(audit?.actor).toBe("system");

    await manager.heartbeat({
      agentId: "test-agent-am-stale",
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
    });
    expect((await manager.getById("test-agent-am-stale"))?.status).toBe("online");
  });
});
