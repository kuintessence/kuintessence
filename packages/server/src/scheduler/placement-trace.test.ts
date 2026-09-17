import { describe, expect, test } from "bun:test";
import { PLACEMENT_STAGE_NAMES } from "@kuintessence/shared";
import { AutoFilter } from "./filters/auto";
import { BillingFilter } from "./filters/billing";
import { ComputeHealthFilter } from "./filters/compute-health";
import { InstallRightsFilter } from "./filters/install-rights";
import { LoadFilter } from "./filters/load";
import { ManualFilter } from "./filters/manual";
import { PermissionFilter } from "./filters/permission";
import { QueueFilter } from "./filters/queue";
import { SoftwareFilter } from "./filters/software";
import { UrgencyFilter } from "./filters/urgency";
import { isFullPlacementTrace, runPlacementWithTrace } from "./placement-trace";
import type { AgentRow, FilterStage, PlacementContext } from "./types";

function makeAgent(id: string, cpu: number | null = 10): AgentRow {
  const now = new Date();
  return {
    agentId: id,
    siteName: `site-${id}`,
    providerOrgId: null,
    siteId: `site-${id}`,
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

function buildStages(): { stages: FilterStage[]; sink: Map<string, number> } {
  const sink = new Map<string, number>();
  const stages: FilterStage[] = [
    new ComputeHealthFilter(),
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
  return { stages, sink };
}

describe("runPlacementWithTrace — happy path", () => {
  test("records all stages in canonical order even when most are no-ops", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("a", 10)],
      context: ctx(),
      stages,
      scoreSink: sink,
      preview: true,
    });
    expect(trace.stages.map((s) => s.name)).toEqual([...PLACEMENT_STAGE_NAMES]);
    expect(isFullPlacementTrace(trace)).toBe(true);
  });

  test("auto stage survivors carry a numeric score and the final decision is the top score", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("light", 10), makeAgent("heavy", 60)],
      context: ctx(),
      stages,
      scoreSink: sink,
      preview: true,
    });
    const auto = trace.stages.find((s) => s.name === "auto");
    expect(auto?.passed).toHaveLength(2);
    for (const a of auto?.passed ?? []) {
      expect(typeof a.score).toBe("number");
    }
    expect(trace.finalDecision?.agentId).toBe("light");
  });

  test("preview flag is preserved on the trace envelope", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("a", 10)],
      context: ctx(),
      stages,
      scoreSink: sink,
      preview: false,
    });
    expect(trace.preview).toBe(false);
    expect(trace.candidateCount).toBe(1);
  });
});

describe("runPlacementWithTrace — every stage records reasons", () => {
  test("permission rejection lands on the permission stage with a reason", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("a", 10), makeAgent("b", 10)],
      context: ctx({ userRole: "guest" }),
      stages,
      scoreSink: sink,
      preview: true,
    });
    const perm = trace.stages.find((s) => s.name === "permission");
    expect(perm?.rejected).toHaveLength(2);
    for (const r of perm?.rejected ?? []) {
      expect(r.reason).toBeTruthy();
    }
    // After permission flushed everyone, downstream stages must still appear
    // with inputCount: 0 (the very contract that justifies this helper).
    const billing = trace.stages.find((s) => s.name === "billing");
    expect(billing?.inputCount).toBe(0);
    expect(billing?.passed).toHaveLength(0);
    expect(billing?.rejected).toHaveLength(0);
    expect(trace.finalDecision).toBeNull();
  });

  test("load stage rejects high-CPU agents and records reasons", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("light", 10), makeAgent("heavy", 99)],
      context: ctx(),
      stages,
      scoreSink: sink,
      preview: true,
    });
    const load = trace.stages.find((s) => s.name === "load");
    expect(load?.rejected.map((r) => r.agent.agentId)).toContain("heavy");
    expect(load?.rejected.find((r) => r.agent.agentId === "heavy")?.reason).toBeTruthy();
    expect(load?.passed.map((p) => p.agentId)).toContain("light");
  });

  test("manual deny list rejects at the manual stage with a reason", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("good", 10), makeAgent("bad", 10)],
      context: ctx({ preferences: { sitePolicy: { deniedAgents: ["bad"] } } }),
      stages,
      scoreSink: sink,
      preview: true,
    });
    const manual = trace.stages.find((s) => s.name === "manual");
    expect(manual?.rejected.map((r) => r.agent.agentId)).toContain("bad");
    expect(trace.finalDecision?.agentId).toBe("good");
  });

  test("hard limit rejection at manual stage carries an explanatory reason", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [makeAgent("a", 10)],
      context: ctx({
        job: { name: "j", command: "true", resources: { cpus: 16, memoryMb: 1024 } },
        preferences: { hardLimits: { maxCpus: 8 } },
      }),
      stages,
      scoreSink: sink,
      preview: true,
    });
    const manual = trace.stages.find((s) => s.name === "manual");
    expect(manual?.rejected.length).toBeGreaterThan(0);
    expect(manual?.rejected[0]?.reason).toMatch(/cpu|cpus/i);
    expect(trace.finalDecision).toBeNull();
  });
});

describe("runPlacementWithTrace — empty inputs", () => {
  test("zero candidates yields a trace with 0 candidate count and no final decision", async () => {
    const { stages, sink } = buildStages();
    const trace = await runPlacementWithTrace({
      candidates: [],
      context: ctx(),
      stages,
      scoreSink: sink,
      preview: true,
    });
    expect(trace.candidateCount).toBe(0);
    expect(trace.finalDecision).toBeNull();
    expect(trace.stages).toHaveLength(PLACEMENT_STAGE_NAMES.length);
    for (const stage of trace.stages) {
      expect(stage.inputCount).toBe(0);
      expect(stage.passed).toHaveLength(0);
      expect(stage.rejected).toHaveLength(0);
    }
  });
});

describe("isFullPlacementTrace", () => {
  test("rejects a trace with fewer than all stages", () => {
    const trace = {
      generatedAt: "now",
      preview: true,
      candidateCount: 0,
      stages: [{ name: "permission", inputCount: 0, passed: [], rejected: [] }],
      finalDecision: null,
    };
    expect(isFullPlacementTrace(trace)).toBe(false);
  });

  test("rejects a trace with the wrong stage order", () => {
    const trace = {
      generatedAt: "now",
      preview: true,
      candidateCount: 0,
      stages: PLACEMENT_STAGE_NAMES.map((_n, _i) => ({
        name: "auto",
        inputCount: 0,
        passed: [],
        rejected: [],
      })),
      finalDecision: null,
    };
    expect(isFullPlacementTrace(trace)).toBe(false);
  });
});
