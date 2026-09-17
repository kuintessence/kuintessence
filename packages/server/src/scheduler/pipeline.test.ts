import { describe, expect, test } from "bun:test";
import { AutoFilter } from "./filters/auto";
import { BillingFilter } from "./filters/billing";
import { InstallRightsFilter } from "./filters/install-rights";
import { LoadFilter } from "./filters/load";
import { ManualFilter } from "./filters/manual";
import { PermissionFilter } from "./filters/permission";
import { QueueFilter } from "./filters/queue";
import { SoftwareFilter } from "./filters/software";
import { UrgencyFilter } from "./filters/urgency";
import { PlacementPipeline } from "./pipeline";
import type { AgentRow, FilterStage, PlacementContext } from "./types";

function makeAgent(id: string, cpu: number | null = 10): AgentRow {
  const now = new Date();
  return {
    agentId: id,
    siteName: "site",
    providerOrgId: null,
    siteId: "site",
    clusterId: id,
    topology: {},
    schedulerType: "slurm",
    schedulerVersion: "23",
    status: "online",
    lastHeartbeat: now,
    computeHealthCapable: false,
    computeHealthStatus: "unknown",
    computeHealthObservedAt: null,
    computeHealthReason: null,
    computeHealthNodeCount: null,
    computeHealthOperationalNodeCount: null,
    cpuUsagePercent: cpu,
    memoryUsedMb: 100,
    memoryTotalMb: 32_000,
    maxConcurrentJobs: 100,
    queueDepth: 0,
    historicalP95WaitSec: 0,
    rootMode: false,
    sandboxReadiness: "critical",
    sandboxCapabilities: {},
    sandboxRuntimeCache: [],
    restrictedDataIsolation: false,
    registeredAt: now,
  };
}

function ctx(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    job: { name: "j", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
    preferences: {},
    userRole: "user",
    userId: "u-1",
    orgId: null,
    ...overrides,
  };
}

describe("PlacementPipeline — basics", () => {
  test("returns empty when no candidates", async () => {
    const p = new PlacementPipeline([new PermissionFilter()]);
    const r = await p.run([], ctx());
    expect(r.selected).toEqual([]);
    expect(r.best).toBeNull();
    expect(r.rejections).toEqual([]);
  });

  test("no stages: all candidates pass with score 0", async () => {
    const p = new PlacementPipeline([]);
    const r = await p.run([makeAgent("a"), makeAgent("b")], ctx());
    expect(r.selected).toHaveLength(2);
    expect(r.best?.score).toBe(0);
  });

  test("all candidates rejected gives null best", async () => {
    const p = new PlacementPipeline([new LoadFilter(50)]);
    const r = await p.run([makeAgent("a", 80), makeAgent("b", 90)], ctx());
    expect(r.best).toBeNull();
    expect(r.selected).toHaveLength(0);
    expect(r.rejections).toHaveLength(2);
  });
});

describe("PlacementPipeline — rejection traces", () => {
  test("filters out rejected agents and records traces", async () => {
    const p = new PlacementPipeline([new LoadFilter(50)]);
    const r = await p.run([makeAgent("a", 30), makeAgent("b", 80), makeAgent("c", 40)], ctx());
    expect(r.selected.map((s) => s.agent.agentId).sort()).toEqual(["a", "c"]);
    expect(r.rejections).toHaveLength(1);
    expect(r.rejections[0]).toMatchObject({
      stage: "load",
      agentId: "b",
    });
  });

  test("trace includes reason", async () => {
    const p = new PlacementPipeline([new PermissionFilter()]);
    const r = await p.run([makeAgent("a")], ctx({ userRole: "guest" }));
    expect(r.rejections[0]?.reason).toBeTruthy();
  });

  test("multi-stage: traces from all stages collected", async () => {
    const sink = new Map<string, number>();
    const stages: FilterStage[] = [
      new PermissionFilter(),
      new LoadFilter(50),
      new AutoFilter(sink),
    ];
    const p = new PlacementPipeline(stages, sink);
    // "guest" rejected at permission; "high-cpu" rejected at load; "ok" passes both
    const agents = [makeAgent("guest-agent", 5), makeAgent("high-cpu", 80), makeAgent("ok", 10)];
    const r = await p.run(agents, ctx({ userRole: "guest" }));
    // All rejected at permission stage
    expect(r.rejections.every((x) => x.stage === "permission")).toBe(true);
    expect(r.rejections).toHaveLength(3);
  });
});

describe("PlacementPipeline — scoring and ordering", () => {
  test("auto stage scores survivors and selects best", async () => {
    const sink = new Map<string, number>();
    const p = new PlacementPipeline([new AutoFilter(sink)], sink);
    const r = await p.run([makeAgent("a", 10), makeAgent("b", 80), makeAgent("c", 40)], ctx());
    expect(r.best?.agent.agentId).toBe("a");
    expect(r.selected.map((s) => s.agent.agentId)).toEqual(["a", "c", "b"]);
  });

  test("selected array sorted by score descending", async () => {
    const sink = new Map<string, number>();
    const p = new PlacementPipeline([new AutoFilter(sink)], sink);
    const r = await p.run([makeAgent("low", 80), makeAgent("high", 5)], ctx());
    expect(r.selected[0]?.agent.agentId).toBe("high");
    expect(r.selected[1]?.agent.agentId).toBe("low");
  });
});

describe("PlacementPipeline — full chain", () => {
  function buildPipeline(): { pipeline: PlacementPipeline; sink: Map<string, number> } {
    const sink = new Map<string, number>();
    const stages: FilterStage[] = [
      new PermissionFilter(),
      new QueueFilter(),
      new SoftwareFilter(),
      new BillingFilter(),
      new LoadFilter(),
      new UrgencyFilter(),
      new InstallRightsFilter(),
      new ManualFilter(),
      new AutoFilter(sink),
    ];
    return { pipeline: new PlacementPipeline(stages, sink), sink };
  }

  test("guest rejected at permission stage in full pipeline", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run([makeAgent("a", 10)], ctx({ userRole: "guest" }));
    expect(r.best).toBeNull();
    expect(r.rejections.some((x) => x.stage === "permission")).toBe(true);
  });

  test("high-load agent rejected at load stage", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run([makeAgent("overloaded", 99)], ctx());
    expect(r.best).toBeNull();
    expect(r.rejections.some((x) => x.stage === "load")).toBe(true);
  });

  test("manual filter respects deniedAgents", async () => {
    const sink = new Map<string, number>();
    const p = new PlacementPipeline([new ManualFilter(), new AutoFilter(sink)], sink);
    const r = await p.run(
      [makeAgent("good", 10), makeAgent("bad", 5)],
      ctx({ preferences: { sitePolicy: { deniedAgents: ["bad"] } } }),
    );
    expect(r.best?.agent.agentId).toBe("good");
    expect(r.rejections.some((x) => x.agentId === "bad")).toBe(true);
  });

  test("full pipeline: two agents, picks lower CPU", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run([makeAgent("heavy", 70), makeAgent("light", 20)], ctx());
    expect(r.best?.agent.agentId).toBe("light");
  });

  test("full pipeline: hard limit rejects via manual stage", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run(
      [makeAgent("a", 10)],
      ctx({
        job: { name: "j", command: "true", resources: { cpus: 16, memoryMb: 1024 } },
        preferences: { hardLimits: { maxCpus: 8 } },
      }),
    );
    expect(r.best).toBeNull();
    expect(r.rejections.some((x) => x.stage === "manual")).toBe(true);
  });

  test("empty candidates always gives null best regardless of stages", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run([], ctx());
    expect(r.best).toBeNull();
    expect(r.rejections).toHaveLength(0);
  });

  test("all stubs pass: only real filters affect outcome", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run([makeAgent("ok", 30)], ctx());
    // Only stub filters and load filter; 30% CPU passes
    expect(r.best?.agent.agentId).toBe("ok");
    expect(r.rejections).toHaveLength(0);
  });

  test("queue stage restricts placement to the selected queue agent", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run(
      [makeAgent("a", 10), makeAgent("b", 5)],
      ctx({
        queueSelection: {
          queueId: "q-a",
          agentId: "a",
          schedulerType: "slurm",
          queueName: "batch",
          qos: null,
          policyTags: [],
        },
      }),
    );
    expect(r.best?.agent.agentId).toBe("a");
    expect(r.rejections).toContainEqual({
      stage: "queue",
      agentId: "b",
      reason: "agent is not bound to queue q-a",
    });
  });

  test("prefer queue boosts matching agents without rejecting fallback candidates", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run(
      [makeAgent("preferred", 80), makeAgent("fallback", 5)],
      ctx({
        preferredQueueSelections: [
          {
            queueId: "q-preferred",
            agentId: "preferred",
            schedulerType: "slurm",
            queueName: "fast",
            qos: null,
            policyTags: [],
          },
        ],
      }),
    );
    expect(r.best?.agent.agentId).toBe("preferred");
    expect(r.rejections.some((x) => x.stage === "queue")).toBe(false);
  });

  test("prefer queue falls back when the preferred agent is rejected by a hard filter", async () => {
    const { pipeline } = buildPipeline();
    const r = await pipeline.run(
      [makeAgent("preferred", 99), makeAgent("fallback", 10)],
      ctx({
        preferredQueueSelections: [
          {
            queueId: "q-preferred",
            agentId: "preferred",
            schedulerType: "slurm",
            queueName: "fast",
            qos: null,
            policyTags: [],
          },
        ],
      }),
    );
    expect(r.best?.agent.agentId).toBe("fallback");
    expect(r.rejections).toContainEqual({
      stage: "load",
      agentId: "preferred",
      reason: "agent CPU 99% exceeds 95%",
    });
  });
});
