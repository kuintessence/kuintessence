import { describe, expect, test } from "bun:test";
import { type WorkflowPlacementConfig, WorkflowPlacementConfigSchema } from "@kuintessence/shared";
import type { PlacementPlanDraft, PlacementPlanRecord, PlacementPlanStore } from "./placement-plan";
import { PlacementPlanService } from "./placement-plan";

class MemoryStore implements PlacementPlanStore {
  readonly plans: PlacementPlanRecord[] = [];

  async saveIfChanged(draft: PlacementPlanDraft): Promise<PlacementPlanRecord> {
    const latest = this.plans.at(-1);
    const comparable = (value: PlacementPlanDraft | PlacementPlanRecord) =>
      JSON.stringify({
        nodes: value.nodes,
        objective: value.objective,
        budgetCap: value.budgetCap,
      });
    if (latest && comparable(latest) === comparable(draft)) return latest;
    const record: PlacementPlanRecord = {
      ...draft,
      id: `plan-${this.plans.length + 1}`,
      version: this.plans.length + 1,
      supersedesPlanId: latest?.id ?? null,
      createdAt: new Date(),
    };
    this.plans.push(record);
    return record;
  }

  async list(): Promise<PlacementPlanRecord[]> {
    return this.plans.toReversed();
  }

  async approve(_workflowRunId: string, planId: string): Promise<PlacementPlanRecord | null> {
    const plan = this.plans.find((item) => item.id === planId);
    if (!plan || plan.budgetStatus !== "awaiting-approval") return null;
    plan.budgetStatus = "approved";
    return plan;
  }
}

function config(values: Partial<WorkflowPlacementConfig> = {}): WorkflowPlacementConfig {
  return WorkflowPlacementConfigSchema.parse(values);
}

describe("PlacementPlanService", () => {
  test("persists preferred/fallback candidates and deduplicates unchanged replans", async () => {
    const store = new MemoryStore();
    const service = new PlacementPlanService(store, async () => ({
      config: config(),
      request: {
        nodes: [
          {
            id: "transform",
            candidates: [
              {
                agentId: "near",
                siteId: "site-a",
                clusterId: "cluster-a",
                computeCost: 1,
                queueWaitCost: 0,
                wallTimeCost: 0,
                runtimeCached: true,
                runtimeMissCost: 0,
                failureRiskCost: 0,
                preferenceCost: 0,
                networkCostBySite: {},
              },
              {
                agentId: "backup",
                siteId: "site-b",
                clusterId: "cluster-b",
                computeCost: 2,
                queueWaitCost: 0,
                wallTimeCost: 0,
                runtimeCached: true,
                runtimeMissCost: 0,
                failureRiskCost: 0,
                preferenceCost: 0,
                networkCostBySite: {},
              },
            ],
            outputs: [{ bytes: 10 }],
          },
        ],
      },
    }));

    const first = await service.replan("run-1", "node-ready");
    const second = await service.replan("run-1", "heartbeat");

    expect(first.nodes[0]).toMatchObject({
      preferredAgentId: "near",
      fallbackAgentIds: ["backup"],
      estimatedOutputBytes: 10,
    });
    expect(second.id).toBe(first.id);
    expect(store.plans).toHaveLength(1);
  });

  test("marks a plan awaiting approval when its total exceeds budget", async () => {
    const store = new MemoryStore();
    const service = new PlacementPlanService(store, async () => ({
      config: config({ budgetCap: 1 }),
      request: {
        nodes: [
          {
            id: "expensive",
            candidates: [
              {
                agentId: "agent",
                siteId: "site",
                clusterId: "cluster",
                computeCost: 2,
                queueWaitCost: 0,
                wallTimeCost: 0,
                runtimeCached: true,
                runtimeMissCost: 0,
                failureRiskCost: 0,
                preferenceCost: 0,
                networkCostBySite: {},
              },
            ],
          },
        ],
      },
    }));

    const plan = await service.replan("run-1", "workflow-submit");
    expect(plan.budgetStatus).toBe("awaiting-approval");
    expect((await service.approve("run-1", plan.id))?.budgetStatus).toBe("approved");
  });
});
