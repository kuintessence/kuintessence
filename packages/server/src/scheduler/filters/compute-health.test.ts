import { describe, expect, test } from "bun:test";
import type { AgentRow, PlacementContext } from "../types";
import { ComputeHealthFilter } from "./compute-health";

const now = new Date("2026-08-03T08:00:00.000Z");

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: "compute-health-agent",
    siteName: "site",
    providerOrgId: null,
    siteId: "site",
    clusterId: "cluster",
    topology: {},
    schedulerType: "slurm",
    schedulerVersion: "23",
    status: "online",
    lastHeartbeat: now,
    computeHealthCapable: true,
    computeHealthStatus: "ready",
    computeHealthObservedAt: now,
    computeHealthReason: null,
    computeHealthNodeCount: 2,
    computeHealthOperationalNodeCount: 2,
    cpuUsagePercent: 10,
    memoryUsedMb: 1_024,
    memoryTotalMb: 8_192,
    maxConcurrentJobs: 100,
    queueDepth: 0,
    historicalP95WaitSec: 0,
    rootMode: false,
    sandboxReadiness: "critical",
    sandboxCapabilities: {},
    sandboxRuntimeCache: [],
    restrictedDataIsolation: false,
    registeredAt: now,
    ...overrides,
  };
}

const context: PlacementContext = {
  job: { name: "health-gate", command: "true", resources: { cpus: 1, memoryMb: 128 } },
  preferences: {},
  userRole: "user",
  userId: "user-1",
  orgId: null,
};

describe("ComputeHealthFilter", () => {
  test("keeps legacy or unknown Agents eligible until enforcement is enabled", () => {
    const legacy = makeAgent({
      computeHealthCapable: false,
      computeHealthStatus: "unknown",
      computeHealthObservedAt: null,
    });
    const compatible = new ComputeHealthFilter({ now: () => now });
    const enforced = new ComputeHealthFilter({ enforce: true, now: () => now });

    expect(compatible.evaluate(legacy, context)).toEqual({ kind: "pass" });
    expect(enforced.evaluate(legacy, context)).toMatchObject({ kind: "reject" });
  });

  test("rejects unavailable and stale health before any soft placement stage", () => {
    const filter = new ComputeHealthFilter({ now: () => now, maxAgeSec: 120 });
    const unavailable = makeAgent({
      computeHealthStatus: "unavailable",
      computeHealthReason: "scheduler_unavailable",
    });
    const stale = makeAgent({
      computeHealthObservedAt: new Date(now.getTime() - 120_001),
    });

    expect(filter.evaluate(unavailable, context)).toMatchObject({
      kind: "reject",
      reason: "compute health reports unavailable: scheduler_unavailable",
    });
    expect(filter.evaluate(stale, context)).toMatchObject({
      kind: "reject",
      reason: "compute health report is stale or clock-invalid",
    });
  });

  test("accepts bounded future clock skew but rejects a larger future sample", () => {
    const filter = new ComputeHealthFilter({
      now: () => now,
      maxFutureSkewSec: 5,
    });

    expect(
      filter.evaluate(
        makeAgent({ computeHealthObservedAt: new Date(now.getTime() + 5_000) }),
        context,
      ),
    ).toEqual({ kind: "pass" });
    expect(
      filter.evaluate(
        makeAgent({ computeHealthObservedAt: new Date(now.getTime() + 5_001) }),
        context,
      ),
    ).toEqual({
      kind: "reject",
      reason: "compute health report is stale or clock-invalid",
    });
  });

  test("fails closed for a Server-invalidated sample even while legacy compatibility is enabled", () => {
    const filter = new ComputeHealthFilter({ now: () => now });
    const invalid = makeAgent({
      computeHealthStatus: "unknown",
      computeHealthObservedAt: null,
      computeHealthReason: "invalid_observed_at",
      computeHealthNodeCount: null,
      computeHealthOperationalNodeCount: null,
    });

    expect(filter.evaluate(invalid, context)).toEqual({
      kind: "reject",
      reason: "compute health report is invalid",
    });
  });

  test("rejects a contradictory ready sample with no operational compute node", () => {
    const filter = new ComputeHealthFilter({ now: () => now });
    const invalid = makeAgent({
      computeHealthNodeCount: 1,
      computeHealthOperationalNodeCount: 0,
    });

    expect(filter.evaluate(invalid, context)).toEqual({
      kind: "reject",
      reason: "compute health report is invalid",
    });
  });

  test("does not surface a non-canonical health reason in the placement trace", () => {
    const filter = new ComputeHealthFilter({ now: () => now });
    const result = filter.evaluate(
      makeAgent({
        computeHealthStatus: "unavailable",
        computeHealthReason: "qstat failed: secret scheduler output",
      }),
      context,
    );

    expect(result).toEqual({ kind: "reject", reason: "compute health reports unavailable" });
  });
});
