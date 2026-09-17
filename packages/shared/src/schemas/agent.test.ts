import { describe, expect, test } from "bun:test";
import { AgentHeartbeatSchema, AgentRegisterSchema } from "./agent";

describe("AgentRegisterSchema", () => {
  test("accepts valid registration", () => {
    const valid = {
      agentId: "agent-example-01",
      siteName: "example-hpc",
      siteId: "example-site",
      clusterId: "example-slurm",
      topology: { rack: "r1" },
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      restrictedDataIsolation: true,
      computeHealthV1: true,
      queueInventoryV1: true,
    };
    expect(AgentRegisterSchema.safeParse(valid).success).toBe(true);
    expect(AgentRegisterSchema.parse(valid).restrictedDataIsolation).toBe(true);
    expect(AgentRegisterSchema.parse(valid).computeHealthV1).toBe(true);
    expect(AgentRegisterSchema.parse(valid).queueInventoryV1).toBe(true);
  });

  test("rejects unknown scheduler type", () => {
    const invalid = {
      agentId: "agent-01",
      siteName: "site",
      schedulerType: "unknown-scheduler",
      schedulerVersion: "1.0",
    };
    expect(AgentRegisterSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("AgentHeartbeatSchema", () => {
  test("accepts valid heartbeat", () => {
    const valid = {
      agentId: "agent-example-01",
      cpuUsagePercent: 45.2,
      memoryUsedMb: 32768,
      memoryTotalMb: 65536,
      restrictedDataIsolation: false,
      computeHealth: {
        state: "ready",
        observedAt: new Date("2026-08-03T00:00:00.000Z"),
        nodeCount: 2,
        operationalNodeCount: 2,
      },
      queueInventory: {
        status: "available",
        defaultQueueName: "batch",
        observedAt: new Date("2026-08-19T00:00:00.000Z"),
        queues: [
          {
            queueName: "batch",
            queueType: "partition",
            isDefault: true,
            state: "up",
            acceptsSubmissions: true,
            observedAt: new Date("2026-08-19T00:00:00.000Z"),
          },
        ],
      },
    };
    expect(AgentHeartbeatSchema.safeParse(valid).success).toBe(true);
    expect(AgentHeartbeatSchema.parse(valid).computeHealth?.state).toBe("ready");
    expect(AgentHeartbeatSchema.parse(valid).queueInventory?.defaultQueueName).toBe("batch");
  });

  test("rejects compute-health observations with impossible node counts or noncanonical reasons", () => {
    const valid = {
      agentId: "agent-example-01",
      cpuUsagePercent: 45.2,
      memoryUsedMb: 32768,
      memoryTotalMb: 65536,
    };
    expect(
      AgentHeartbeatSchema.safeParse({
        ...valid,
        computeHealth: {
          state: "unavailable",
          observedAt: new Date("2026-08-03T00:00:00.000Z"),
          nodeCount: 1,
          operationalNodeCount: 2,
          reason: "raw scheduler stderr",
        },
      }).success,
    ).toBe(false);
    expect(
      AgentHeartbeatSchema.safeParse({
        ...valid,
        computeHealth: {
          state: "ready",
          observedAt: new Date("2026-08-03T00:00:00.000Z"),
          nodeCount: 1,
          operationalNodeCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentHeartbeatSchema.safeParse({
        ...valid,
        computeHealth: {
          state: "unavailable",
          observedAt: new Date("2026-08-03T00:00:00.000Z"),
          nodeCount: 1,
          operationalNodeCount: 1,
          reason: "no_operational_nodes",
        },
      }).success,
    ).toBe(false);
  });
});
