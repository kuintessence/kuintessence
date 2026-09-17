// Migration 0013 — `toAgentCandidate` reads `queue_depth` and
// `historical_p95_wait_sec` straight off the agent row instead of
// defaulting to zero. This guards against a future regression that would
// silently make every agent look idle to the scoring layer.

import { describe, expect, test } from "bun:test";
import type { PreferenceSpec } from "@kuintessence/shared";
import type { AgentRow, PlacementContext } from "../../types";
import { toAgentCandidate, toScoringContext } from "../from-pipeline";

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  const now = new Date();
  return {
    agentId: "a-1",
    siteName: "site-x",
    schedulerType: "slurm",
    schedulerVersion: "23",
    status: "online",
    lastHeartbeat: now,
    cpuUsagePercent: 30,
    memoryUsedMb: 1024,
    memoryTotalMb: 32_000,
    maxConcurrentJobs: 100,
    queueDepth: 0,
    historicalP95WaitSec: 0,
    registeredAt: now,
    ...overrides,
    computeHealthCapable: overrides.computeHealthCapable ?? false,
    computeHealthStatus: overrides.computeHealthStatus ?? "unknown",
    computeHealthObservedAt: overrides.computeHealthObservedAt ?? null,
    computeHealthReason: overrides.computeHealthReason ?? null,
    computeHealthNodeCount: overrides.computeHealthNodeCount ?? null,
    computeHealthOperationalNodeCount: overrides.computeHealthOperationalNodeCount ?? null,
    rootMode: overrides.rootMode ?? false,
    sandboxReadiness: overrides.sandboxReadiness ?? "critical",
    sandboxCapabilities: overrides.sandboxCapabilities ?? {},
    sandboxRuntimeCache: overrides.sandboxRuntimeCache ?? [],
    providerOrgId: overrides.providerOrgId ?? null,
    siteId: "siteId" in overrides ? (overrides.siteId ?? null) : null,
    clusterId: "clusterId" in overrides ? (overrides.clusterId ?? null) : null,
    topology: overrides.topology ?? {},
    restrictedDataIsolation: overrides.restrictedDataIsolation ?? false,
  };
}

function makeCtx(
  overrides: { preferences?: PreferenceSpec; job?: Partial<PlacementContext["job"]> } = {},
): PlacementContext {
  return {
    job: {
      name: "j",
      command: "echo hi",
      resources: { cpus: 1, memoryMb: 512 },
      ...overrides.job,
    },
    preferences: overrides.preferences ?? {},
    userRole: "user",
    userId: "u-1",
    orgId: null,
  };
}

describe("toAgentCandidate (migration 0013 columns)", () => {
  test("forwards real queueDepth from the agent row", () => {
    const candidate = toAgentCandidate(makeAgent({ queueDepth: 17 }));
    expect(candidate.queueDepth).toBe(17);
  });

  test("forwards real historicalP95WaitSec from the agent row", () => {
    const candidate = toAgentCandidate(makeAgent({ historicalP95WaitSec: 4200 }));
    expect(candidate.historicalP95WaitSec).toBe(4200);
  });

  test("does not silently fall back to zero when both columns are populated", () => {
    const candidate = toAgentCandidate(makeAgent({ queueDepth: 9, historicalP95WaitSec: 1234 }));
    expect(candidate.queueDepth).toBe(9);
    expect(candidate.historicalP95WaitSec).toBe(1234);
  });

  test("uses siteId and clusterId before falling back to siteName", () => {
    const candidate = toAgentCandidate(
      makeAgent({ siteId: "site-real", clusterId: "cluster-real" }),
    );
    expect(candidate.clusterName).toBe("cluster-real");
    expect(candidate.siteId).toBe("site-real");
  });

  test("clusterName and siteId fall back to siteName for legacy rows", () => {
    const candidate = toAgentCandidate(makeAgent());
    expect(candidate.clusterName).toBe("site-x");
    expect(candidate.siteId).toBe("site-x");
  });

  test("loadPercent falls back to neutral 50 when cpuUsagePercent is null", () => {
    const candidate = toAgentCandidate(makeAgent({ cpuUsagePercent: null }));
    expect(candidate.loadPercent).toBe(50);
  });
});

describe("toScoringContext", () => {
  test("reads real costRates from preferences (no cast)", () => {
    const ctx = makeCtx({ preferences: { costRates: { "site-a": 0.42 } } });
    expect(toScoringContext(ctx).costRates).toEqual({ "site-a": 0.42 });
  });

  test("costRates defaults to empty when preferences omit it", () => {
    expect(toScoringContext(makeCtx()).costRates).toEqual({});
  });

  test("reads real dataSites from job.requires.locality (no cast)", () => {
    const ctx = makeCtx({ job: { requires: { locality: { dataSites: ["s1"] } } } });
    expect(toScoringContext(ctx).dataSites).toEqual(["s1"]);
  });

  test("dataSites defaults to empty when job omits requires", () => {
    expect(toScoringContext(makeCtx()).dataSites).toEqual([]);
  });
});
