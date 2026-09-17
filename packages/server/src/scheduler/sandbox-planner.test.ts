import { describe, expect, test } from "bun:test";
import type { SandboxPlannerCandidate, SandboxPlannerNode } from "./sandbox-planner";
import { planSandboxPlacement, SandboxPlannerError } from "./sandbox-planner";

function candidate(agentId: string, siteId: string): SandboxPlannerCandidate {
  return {
    agentId,
    siteId,
    clusterId: `cluster-${siteId}`,
    computeCost: 1,
    queueWaitCost: 0,
    wallTimeCost: 0,
    runtimeCached: true,
    runtimeMissCost: 0,
    failureRiskCost: 0,
    preferenceCost: 0,
    networkCostBySite: { siteA: 1, siteB: 1 },
  };
}

const candidates = [candidate("agent-a", "siteA"), candidate("agent-b", "siteB")];

function node(overrides: Partial<SandboxPlannerNode> = {}): SandboxPlannerNode {
  return { id: "transform", candidates, ...overrides };
}

describe("planSandboxPlacement locality", () => {
  test("large input and small output follows the input replica", () => {
    const result = planSandboxPlacement({
      mode: "Global",
      nodes: [
        node({
          inputs: [{ bytes: 1_000_000_000, replicaSiteIds: ["siteA"] }],
          outputs: [{ bytes: 1_000_000, targetSiteId: "siteB" }],
        }),
      ],
    });
    expect(result.assignments[0]?.siteId).toBe("siteA");
  });

  test("small input and large output follows the target consumer site", () => {
    const result = planSandboxPlacement({
      mode: "Global",
      nodes: [
        node({
          inputs: [{ bytes: 1_000_000, replicaSiteIds: ["siteA"] }],
          outputs: [{ bytes: 1_000_000_000, targetSiteId: "siteB" }],
        }),
      ],
    });
    expect(result.assignments[0]?.siteId).toBe("siteB");
  });

  test("Lookahead co-locates a producer with its only consumer candidate", () => {
    const result = planSandboxPlacement({
      mode: "Lookahead",
      nodes: [
        { id: "produce", candidates },
        { id: "consume", candidates: [candidate("agent-b", "siteB")] },
      ],
      edges: [{ from: "produce", to: "consume", bytes: 1_000_000_000 }],
    });
    expect(result.assignments[0]?.siteId).toBe("siteB");
    expect(result.assignments[1]?.siteId).toBe("siteB");
  });
});

describe("planSandboxPlacement constraints and budget", () => {
  test("Require filters candidates and Prefer can fall back", () => {
    const required = planSandboxPlacement({
      mode: "Greedy",
      nodes: [
        node({
          constraint: {
            mode: "Require",
            siteIds: ["siteB"],
            clusterIds: [],
            dataMovement: "Allow",
          },
        }),
      ],
    });
    expect(required.assignments[0]?.siteId).toBe("siteB");

    const preferred = planSandboxPlacement({
      mode: "Greedy",
      nodes: [
        node({
          candidates: [candidate("agent-a", "siteA")],
          constraint: { mode: "Prefer", siteIds: ["siteB"], clusterIds: [], dataMovement: "Allow" },
        }),
      ],
    });
    expect(preferred.assignments[0]?.siteId).toBe("siteA");
    expect(preferred.objective.preferenceCost).toBe(1_000);
  });

  test("dataMovement Forbid fails when no candidate has the input", () => {
    expect(() =>
      planSandboxPlacement({
        mode: "Global",
        nodes: [
          node({
            candidates: [candidate("agent-b", "siteB")],
            inputs: [{ bytes: 100, replicaSiteIds: ["siteA"] }],
            constraint: { mode: "Prefer", siteIds: [], clusterIds: [], dataMovement: "Forbid" },
          }),
        ],
      }),
    ).toThrow(SandboxPlannerError);
  });

  test("marks a plan awaiting approval when it exceeds budget", () => {
    const result = planSandboxPlacement({
      mode: "Global",
      nodes: [node()],
      budgetCap: 0.5,
    });
    expect(result.budgetStatus).toBe("awaiting-approval");
  });
});
