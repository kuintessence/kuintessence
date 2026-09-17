// auto-stage composite scoring tests.
//
// These tests assert the new behaviour: the auto stage no longer multiplies
// `(100 - cpuUsagePercent) * loadWeight`. It runs the full `defaultScorers`
// (load + cost + locality + queue-wait) through `CompositeScorer` and writes
// the normalised 0..100 finalScore to the score sink.
import { describe, expect, test } from "bun:test";
import type { AgentRow, PlacementContext } from "../../types";
import { AutoFilter } from "../auto";

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  const now = new Date();
  return {
    agentId: "a-1",
    siteName: "groupa-site-1",
    schedulerType: "slurm",
    schedulerVersion: "23",
    status: "online",
    lastHeartbeat: now,
    cpuUsagePercent: 50,
    memoryUsedMb: 100,
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
    siteId: overrides.siteId ?? overrides.siteName ?? "groupa-site-1",
    clusterId: overrides.clusterId ?? overrides.agentId ?? "a-1",
    topology: overrides.topology ?? {},
    restrictedDataIsolation: overrides.restrictedDataIsolation ?? false,
  };
}

function makeCtx(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    job: { name: "j", command: "true", resources: { cpus: 4, memoryMb: 8192 } },
    preferences: {},
    userRole: "user",
    userId: "u-1",
    orgId: null,
    ...overrides,
  };
}

describe("AutoFilter — composite scoring", () => {
  test("low CPU + matching dataSite scores high (>70)", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const agent = makeAgent({ agentId: "a-good", siteName: "groupa-site-1", cpuUsagePercent: 10 });
    const ctx = makeCtx({
      job: {
        name: "j",
        command: "true",
        resources: { cpus: 4, memoryMb: 8192 },
        // The adapter reads dataSites off `requires.locality.dataSites` if present.
        // biome-ignore lint/suspicious/noExplicitAny: extension field, see from-pipeline.ts
        ...({ requires: { locality: { dataSites: ["groupa-site-1"] } } } as any),
      },
    });
    f.evaluate(agent, ctx);
    const score = sink.get("a-good") ?? 0;
    expect(score).toBeGreaterThan(70);
  });

  test("very high CPU usage scores low (<40) when load weight dominates", () => {
    // With load completely dominant, the composite reduces to (100-cpu) so
    // a 95% CPU agent must score 5, well below 40.
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const ctx = makeCtx({
      preferences: {
        softWeights: { loadWeight: 100, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
      },
    });
    f.evaluate(makeAgent({ agentId: "busy", cpuUsagePercent: 95 }), ctx);
    const score = sink.get("busy") ?? 0;
    expect(score).toBeLessThan(40);
  });

  test("loadWeight=0 makes load not affect ranking", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const ctx = makeCtx({
      preferences: {
        softWeights: { loadWeight: 0, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
      },
    });
    // Two agents at very different load. With load disabled, their composite
    // scores must match (cost / locality / queue-wait all equal).
    f.evaluate(makeAgent({ agentId: "lo", cpuUsagePercent: 5 }), ctx);
    f.evaluate(makeAgent({ agentId: "hi", cpuUsagePercent: 95 }), ctx);
    const lo = sink.get("lo") ?? -1;
    const hi = sink.get("hi") ?? -2;
    expect(lo).toBe(hi);
  });

  test("locality weight bump: closer agent wins over cheaper agent", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    // Both agents have identical load (50). Cheaper one is at a different site,
    // closer one is at the right site. With localityWeight bumped high, the
    // closer agent must out-rank the cheaper one.
    const ctx = makeCtx({
      preferences: {
        softWeights: { loadWeight: 1, costWeight: 1, localityWeight: 5, queueWaitWeight: 1 },
        // biome-ignore lint/suspicious/noExplicitAny: extension field, see from-pipeline.ts
        ...({ costRates: { "site-cheap": 1, "site-close": 5 } } as any),
      },
      job: {
        name: "j",
        command: "true",
        resources: { cpus: 4, memoryMb: 8192 },
        // biome-ignore lint/suspicious/noExplicitAny: extension field, see from-pipeline.ts
        ...({ requires: { locality: { dataSites: ["site-close"] } } } as any),
      },
    });
    f.evaluate(makeAgent({ agentId: "cheap", siteName: "site-cheap", cpuUsagePercent: 50 }), ctx);
    f.evaluate(makeAgent({ agentId: "close", siteName: "site-close", cpuUsagePercent: 50 }), ctx);
    expect((sink.get("close") ?? 0) > (sink.get("cheap") ?? 0)).toBe(true);
  });

  test("score is normalized 0..100 (no longer raw weighted sum)", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const ctx = makeCtx({
      preferences: {
        softWeights: {
          loadWeight: 100,
          costWeight: 100,
          localityWeight: 100,
          queueWaitWeight: 100,
        },
      },
    });
    f.evaluate(makeAgent({ agentId: "z", cpuUsagePercent: 0 }), ctx);
    const score = sink.get("z") ?? 0;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test("always returns pass (never rejects)", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const r = f.evaluate(makeAgent({ cpuUsagePercent: 100 }), makeCtx());
    expect(r.kind).toBe("pass");
  });

  test("filter name is 'auto'", () => {
    expect(new AutoFilter(new Map()).name).toBe("auto");
  });

  test("workflow plan ordering wins as a soft preference", () => {
    const sink = new Map<string, number>();
    const filter = new AutoFilter(sink);
    const context = makeCtx({ preferredAgentIds: ["planned", "fallback"] });
    filter.evaluate(makeAgent({ agentId: "unplanned", cpuUsagePercent: 0 }), context);
    filter.evaluate(makeAgent({ agentId: "fallback", cpuUsagePercent: 90 }), context);
    filter.evaluate(makeAgent({ agentId: "planned", cpuUsagePercent: 99 }), context);
    expect(sink.get("planned")).toBe(20_000);
    expect(sink.get("fallback")).toBe(19_999);
    expect((sink.get("unplanned") ?? 0) < 19_999).toBe(true);
  });
});
