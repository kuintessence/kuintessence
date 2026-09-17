import { describe, expect, test } from "bun:test";
import {
  QueueRegistryCreateSchema,
  QueueRegistryUpdateSchema,
  QueueRegistryViewSchema,
  SchedulerQueueInventorySchema,
} from "./queue";

describe("QueueRegistryCreateSchema", () => {
  test("accepts a Slurm queue registry entry", () => {
    const parsed = QueueRegistryCreateSchema.parse({
      queueId: "example-slurm-batch",
      name: "Example Slurm batch",
      providerOrgId: "00000000-0000-4000-8000-000000000001",
      visibleOrgIds: ["00000000-0000-4000-8000-000000000002"],
      agentId: "agent-example-01",
      schedulerType: "slurm",
      queueName: "batch",
      qos: "normal",
      enabled: true,
      policyTags: ["gpu-ok"],
    });
    expect(parsed.queueName).toBe("batch");
    expect(parsed.policyTags).toEqual(["gpu-ok"]);
  });

  test("defaults visibility, enabled flag, and policy tags", () => {
    const parsed = QueueRegistryCreateSchema.parse({
      queueId: "pbs-workq",
      name: "PBS workq",
      agentId: "agent-pbs-01",
      schedulerType: "pbs-pro",
      queueName: "workq",
    });
    expect(parsed.visibleOrgIds).toEqual([]);
    expect(parsed.enabled).toBe(true);
    expect(parsed.policyTags).toEqual([]);
  });

  test("accepts a scheduler-default target without a named queue", () => {
    const parsed = QueueRegistryCreateSchema.parse({
      queueId: "pbs-default",
      name: "PBS default",
      agentId: "agent-pbs-01",
      schedulerType: "pbs-pro",
      target: { mode: "default" },
    });
    expect(parsed.target).toEqual({ mode: "default" });
    expect(parsed.queueName).toBeUndefined();
  });

  test("keeps legacy queueName payloads as named targets", () => {
    const parsed = QueueRegistryCreateSchema.parse({
      queueId: "legacy-batch",
      name: "Legacy batch",
      agentId: "agent-slurm-01",
      schedulerType: "slurm",
      queueName: "batch",
    });
    expect(parsed.target).toBeUndefined();
    expect(parsed.queueName).toBe("batch");
  });

  test("accepts legacy registry responses without additive target fields", () => {
    const parsed = QueueRegistryViewSchema.parse({
      queueId: "legacy-batch",
      name: "Legacy batch",
      providerOrgId: "00000000-0000-4000-8000-000000000001",
      visibleOrgIds: [],
      agentId: "agent-slurm-01",
      schedulerType: "slurm",
      queueName: "batch",
      qos: null,
      enabled: true,
      policyTags: [],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(parsed.target).toBeUndefined();
  });

  test("rejects ambiguous default targets and invalid scheduler tokens", () => {
    const defaultWithName = QueueRegistryCreateSchema.safeParse({
      queueId: "bad-default",
      name: "bad",
      agentId: "agent-1",
      schedulerType: "slurm",
      target: { mode: "default" },
      queueName: "batch",
    });
    const invalidToken = QueueRegistryCreateSchema.safeParse({
      queueId: "bad-token",
      name: "bad",
      agentId: "agent-1",
      schedulerType: "slurm",
      queueName: "batch\n#SBATCH --account=other",
    });
    expect(defaultWithName.success).toBe(false);
    expect(invalidToken.success).toBe(false);
  });

  test("rejects unknown scheduler type", () => {
    const parsed = QueueRegistryCreateSchema.safeParse({
      queueId: "bad",
      name: "bad",
      agentId: "agent-1",
      schedulerType: "lsf",
      queueName: "normal",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("QueueRegistryUpdateSchema", () => {
  test("allows partial updates", () => {
    const parsed = QueueRegistryUpdateSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
  });

  test("requires a name when switching a target to named", () => {
    const parsed = QueueRegistryUpdateSchema.safeParse({ target: { mode: "named" } });
    expect(parsed.success).toBe(false);
  });
});

describe("SchedulerQueueInventorySchema", () => {
  const observedAt = new Date("2026-08-19T00:00:00.000Z");

  test("accepts a canonical single-default inventory", () => {
    const parsed = SchedulerQueueInventorySchema.parse({
      status: "available",
      defaultQueueName: "batch",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          hasComputeTargets: true,
          observedAt,
        },
      ],
    });
    expect(parsed.defaultQueueName).toBe("batch");
  });

  test("rejects duplicate or mismatched defaults", () => {
    const duplicateDefault = SchedulerQueueInventorySchema.safeParse({
      status: "available",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
        {
          queueName: "debug",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
      ],
    });
    const mismatchedDefault = SchedulerQueueInventorySchema.safeParse({
      status: "available",
      defaultQueueName: "debug",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
      ],
    });
    expect(duplicateDefault.success).toBe(false);
    expect(mismatchedDefault.success).toBe(false);
  });
});
