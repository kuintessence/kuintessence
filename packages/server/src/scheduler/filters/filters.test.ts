import { describe, expect, test } from "bun:test";
import type { AgentRow, PlacementContext } from "../types";
import { AutoFilter } from "./auto";
import { BillingFilter } from "./billing";
import { InstallRightsFilter } from "./install-rights";
import { LoadFilter } from "./load";
import { ManualFilter } from "./manual";
import { PermissionFilter } from "./permission";
import { SoftwareFilter } from "./software";
import { UrgencyFilter } from "./urgency";

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  const now = new Date();
  return {
    agentId: "a-1",
    siteName: "site",
    schedulerType: "slurm",
    schedulerVersion: "23",
    status: "online",
    lastHeartbeat: now,
    cpuUsagePercent: 10,
    memoryUsedMb: 1000,
    memoryTotalMb: 32000,
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
    siteId: overrides.siteId ?? overrides.siteName ?? "site",
    clusterId: overrides.clusterId ?? overrides.agentId ?? "a-1",
    topology: overrides.topology ?? {},
    restrictedDataIsolation: overrides.restrictedDataIsolation ?? false,
  };
}

function makeCtx(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    job: {
      name: "test-job",
      command: "true",
      resources: { cpus: 4, memoryMb: 8192 },
    },
    preferences: {},
    userRole: "user",
    userId: "u-1",
    orgId: null,
    ...overrides,
  };
}

describe("PermissionFilter", () => {
  const f = new PermissionFilter();
  test("rejects guest", () => {
    const r = f.evaluate(makeAgent(), makeCtx({ userRole: "guest" }));
    expect(r.kind).toBe("reject");
  });
  test("allows user", () => {
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });
  test("allows org_admin", () => {
    expect(f.evaluate(makeAgent(), makeCtx({ userRole: "org_admin" })).kind).toBe("pass");
  });
  test("allows platform_admin", () => {
    expect(f.evaluate(makeAgent(), makeCtx({ userRole: "platform_admin" })).kind).toBe("pass");
  });
  test("reject reason mentions guest", () => {
    const r = f.evaluate(makeAgent(), makeCtx({ userRole: "guest" }));
    if (r.kind === "reject") {
      expect(r.reason).toContain("guest");
    }
  });
});

describe("SoftwareFilter", () => {
  test("passes when no requirements", () => {
    const f = new SoftwareFilter({ agentSoftware: new Map() });
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("rejects when required software missing (no installed)", () => {
    const f = new SoftwareFilter({ agentSoftware: new Map([["a-1", new Set(["wrf@4.4"])]]) });
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: false }],
      },
    });
    const r = f.evaluate(makeAgent(), ctx);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toContain("vasp");
  });

  test("passes when required software present (versioned)", () => {
    const f = new SoftwareFilter({ agentSoftware: new Map([["a-1", new Set(["wrf@4.4"])]]) });
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "wrf", version: "4.4", installable: false }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("passes when required software present (name-only, any version)", () => {
    const f = new SoftwareFilter({ agentSoftware: new Map([["a-1", new Set(["wrf@4.4"])]]) });
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "wrf", installable: false }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("passes when missing but installable=true", () => {
    const f = new SoftwareFilter({ agentSoftware: new Map() });
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("rejects installable software when availability resolver reports a block", () => {
    const f = new SoftwareFilter({
      agentSoftware: new Map(),
      availability: new Map([
        ["vasp", new Map([["a-1", ["provider policy only allows preinstalled software"]]])],
      ]),
    });
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    const r = f.evaluate(makeAgent(), ctx);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") {
      expect(r.reason).toContain("provider policy");
    }
  });

  test("filter name is 'software'", () => {
    expect(new SoftwareFilter().name).toBe("software");
  });
});

describe("BillingFilter", () => {
  test("passes when no quota set", () => {
    const f = new BillingFilter({ quotas: new Map() });
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("rejects when user quota is zero", () => {
    const f = new BillingFilter({ quotas: new Map([["user:u-1", 0]]) });
    const r = f.evaluate(makeAgent(), makeCtx());
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toContain("user quota");
  });

  test("passes when user quota is positive", () => {
    const f = new BillingFilter({ quotas: new Map([["user:u-1", 100]]) });
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("rejects when org quota zero and no user override", () => {
    const f = new BillingFilter({ quotas: new Map([["org:org-1", 0]]) });
    const r = f.evaluate(makeAgent(), makeCtx({ orgId: "org-1" }));
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toContain("org quota");
  });

  test("user quota overrides org quota (user positive, org zero)", () => {
    const f = new BillingFilter({
      quotas: new Map([
        ["user:u-1", 10],
        ["org:org-1", 0],
      ]),
    });
    expect(f.evaluate(makeAgent(), makeCtx({ orgId: "org-1" })).kind).toBe("pass");
  });

  test("passes when org quota positive", () => {
    const f = new BillingFilter({ quotas: new Map([["org:org-1", 50]]) });
    expect(f.evaluate(makeAgent(), makeCtx({ orgId: "org-1" })).kind).toBe("pass");
  });

  test("filter name is 'billing'", () => {
    expect(new BillingFilter().name).toBe("billing");
  });
});

describe("UrgencyFilter", () => {
  test("passes when active < max (default max 100)", () => {
    const f = new UrgencyFilter(() => 5);
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("rejects when active equals max", () => {
    const f = new UrgencyFilter(() => 100);
    const r = f.evaluate(makeAgent(), makeCtx());
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toContain("100/100");
  });

  test("rejects when active exceeds max", () => {
    const f = new UrgencyFilter(() => 150);
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("reject");
  });

  test("respects custom maxConcurrentJobs from agent row", () => {
    const agent = makeAgent({ maxConcurrentJobs: 5 } as never);
    const f = new UrgencyFilter(() => 4);
    expect(f.evaluate(agent, makeCtx()).kind).toBe("pass");
    const f2 = new UrgencyFilter(() => 5);
    expect(f2.evaluate(agent, makeCtx()).kind).toBe("reject");
  });

  test("passes when no active jobs (default count 0)", () => {
    const f = new UrgencyFilter();
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("filter name is 'urgency'", () => {
    expect(new UrgencyFilter().name).toBe("urgency");
  });
});

describe("InstallRightsFilter", () => {
  test("passes when no softwareRequirements", () => {
    const f = new InstallRightsFilter();
    expect(f.evaluate(makeAgent(), makeCtx()).kind).toBe("pass");
  });

  test("passes when requirements exist but none have installable=true", () => {
    const f = new InstallRightsFilter();
    const ctx = makeCtx({
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "wrf", version: "4.4", installable: false }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("rejects regular user when install requested", () => {
    const f = new InstallRightsFilter();
    const ctx = makeCtx({
      userRole: "user",
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    const r = f.evaluate(makeAgent(), ctx);
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toContain("install permission");
  });

  test("allows org_admin to request install", () => {
    const f = new InstallRightsFilter();
    const ctx = makeCtx({
      userRole: "org_admin",
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("allows platform_admin to request install", () => {
    const f = new InstallRightsFilter();
    const ctx = makeCtx({
      userRole: "platform_admin",
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("allows super_admin to request install", () => {
    const f = new InstallRightsFilter();
    const ctx = makeCtx({
      userRole: "super_admin",
      job: {
        ...makeCtx().job,
        softwareRequirements: [{ name: "vasp", installable: true }],
      },
    });
    expect(f.evaluate(makeAgent(), ctx).kind).toBe("pass");
  });

  test("filter name is 'install-rights'", () => {
    expect(new InstallRightsFilter().name).toBe("install-rights");
  });
});

describe("LoadFilter", () => {
  test("rejects high CPU (above threshold)", () => {
    const r = new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: 99 }), makeCtx());
    expect(r.kind).toBe("reject");
  });
  test("allows null CPU usage (unknown = pass)", () => {
    expect(new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: null }), makeCtx()).kind).toBe(
      "pass",
    );
  });
  test("allows CPU usage below threshold", () => {
    expect(new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: 50 }), makeCtx()).kind).toBe(
      "pass",
    );
  });
  test("allows CPU usage exactly at threshold", () => {
    expect(new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: 95 }), makeCtx()).kind).toBe(
      "pass",
    );
  });
  test("rejects CPU usage one above threshold", () => {
    expect(new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: 96 }), makeCtx()).kind).toBe(
      "reject",
    );
  });
  test("reject reason includes CPU percent", () => {
    const r = new LoadFilter(95).evaluate(makeAgent({ cpuUsagePercent: 99 }), makeCtx());
    if (r.kind === "reject") {
      expect(r.reason).toContain("99");
    }
  });
  test("custom maxCpuPercent: rejects at 80 threshold", () => {
    expect(new LoadFilter(80).evaluate(makeAgent({ cpuUsagePercent: 85 }), makeCtx()).kind).toBe(
      "reject",
    );
  });
});

describe("ManualFilter — site policy", () => {
  const f = new ManualFilter();
  test("rejects denied agent", () => {
    const r = f.evaluate(
      makeAgent({ agentId: "bad" }),
      makeCtx({ preferences: { sitePolicy: { deniedAgents: ["bad"] } } }),
    );
    expect(r.kind).toBe("reject");
  });
  test("rejects agent not in allow list", () => {
    const r = f.evaluate(
      makeAgent({ agentId: "x" }),
      makeCtx({ preferences: { sitePolicy: { allowedAgents: ["a", "b"] } } }),
    );
    expect(r.kind).toBe("reject");
  });
  test("allows agent in allow list", () => {
    expect(
      f.evaluate(
        makeAgent({ agentId: "a" }),
        makeCtx({ preferences: { sitePolicy: { allowedAgents: ["a"] } } }),
      ).kind,
    ).toBe("pass");
  });
  test("allows when no policy set", () => {
    expect(f.evaluate(makeAgent({ agentId: "any" }), makeCtx({ preferences: {} })).kind).toBe(
      "pass",
    );
  });
  test("deny list takes precedence", () => {
    // agent in both allowedAgents and deniedAgents -> denied wins (deny check first)
    const r = f.evaluate(
      makeAgent({ agentId: "a" }),
      makeCtx({
        preferences: {
          sitePolicy: { allowedAgents: ["a"], deniedAgents: ["a"] },
        },
      }),
    );
    expect(r.kind).toBe("reject");
  });
});

describe("ManualFilter — hard limits", () => {
  const f = new ManualFilter();
  test("rejects when cpus exceed maxCpus", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: { name: "j", command: "true", resources: { cpus: 8, memoryMb: 1024 } },
        preferences: { hardLimits: { maxCpus: 4 } },
      }),
    );
    expect(r.kind).toBe("reject");
  });
  test("allows when cpus equal maxCpus", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: { name: "j", command: "true", resources: { cpus: 4, memoryMb: 1024 } },
        preferences: { hardLimits: { maxCpus: 4 } },
      }),
    );
    expect(r.kind).toBe("pass");
  });
  test("rejects when memory exceeds maxMemoryMb", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: { name: "j", command: "true", resources: { cpus: 1, memoryMb: 16_000 } },
        preferences: { hardLimits: { maxMemoryMb: 8000 } },
      }),
    );
    expect(r.kind).toBe("reject");
  });
  test("allows when memory equals maxMemoryMb", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: { name: "j", command: "true", resources: { cpus: 1, memoryMb: 8000 } },
        preferences: { hardLimits: { maxMemoryMb: 8000 } },
      }),
    );
    expect(r.kind).toBe("pass");
  });
  test("rejects when wallTime exceeds maxWallTimeSec", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: {
          name: "j",
          command: "true",
          resources: { cpus: 1, memoryMb: 1024, wallTimeSec: 7200 },
        },
        preferences: { hardLimits: { maxWallTimeSec: 3600 } },
      }),
    );
    expect(r.kind).toBe("reject");
  });
  test("allows when wallTime not provided in job (no limit check)", () => {
    const r = f.evaluate(
      makeAgent(),
      makeCtx({
        job: { name: "j", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
        preferences: { hardLimits: { maxWallTimeSec: 3600 } },
      }),
    );
    expect(r.kind).toBe("pass");
  });
});

describe("AutoFilter scoring", () => {
  test("higher score for lower CPU usage", () => {
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    f.evaluate(makeAgent({ agentId: "low", cpuUsagePercent: 10 }), makeCtx());
    f.evaluate(makeAgent({ agentId: "high", cpuUsagePercent: 80 }), makeCtx());
    const lowScore = sink.get("low") ?? 0;
    const highScore = sink.get("high") ?? 0;
    expect(lowScore).toBeGreaterThan(highScore);
  });
  test("respects loadWeight from preferences (relative ranking unaffected when load dominates)", () => {
    // CompositeScorer normalizes by total weight, so the absolute score is no
    // longer `loadScore * loadWeight`. The ranking property still holds: with
    // loadWeight dominant, the lower-CPU agent must out-rank the higher-CPU.
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    const ctx = makeCtx({
      preferences: {
        softWeights: { loadWeight: 10, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
      },
    });
    f.evaluate(makeAgent({ agentId: "low", cpuUsagePercent: 10 }), ctx);
    f.evaluate(makeAgent({ agentId: "high", cpuUsagePercent: 80 }), ctx);
    expect((sink.get("low") ?? 0) > (sink.get("high") ?? 0)).toBe(true);
    // Final score is normalized 0..100.
    expect(sink.get("low") ?? -1).toBeLessThanOrEqual(100);
    expect(sink.get("low") ?? -1).toBeGreaterThanOrEqual(0);
  });
  test("null cpuUsagePercent defaults to 50% load (mid-range composite score)", () => {
    // Composite: load=50 (neutral), cost=50 (no cost data), locality=50
    // (no data sites), queue-wait=100 (zero wait + zero queue depth) =>
    // weighted average lands above 50.
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    f.evaluate(makeAgent({ agentId: "y", cpuUsagePercent: null }), makeCtx());
    const score = sink.get("y") ?? 0;
    expect(score).toBeGreaterThan(40);
    expect(score).toBeLessThan(80);
  });
  test("zero CPU usage gives high (near-100) composite score", () => {
    // load=100, queue-wait=100 (idle), locality=50, cost=50 => avg ~75.
    const sink = new Map<string, number>();
    const f = new AutoFilter(sink);
    f.evaluate(makeAgent({ agentId: "z", cpuUsagePercent: 0 }), makeCtx());
    const score = sink.get("z") ?? 0;
    expect(score).toBeGreaterThan(70);
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
});
