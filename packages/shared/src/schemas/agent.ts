import { z } from "zod";
import { SchedulerQueueInventorySchema } from "./queue";
import { SchedulerTypeEnum } from "./scheduler";

export { SchedulerTypeEnum } from "./scheduler";

export const ComputeHealthStateSchema = z.enum(["unknown", "ready", "unavailable"]);

export const ComputeHealthReasonSchema = z.enum([
  "scheduler_unavailable",
  "scheduler_command_failed",
  "no_operational_nodes",
  "invalid_scheduler_state",
  "unsupported_scheduler",
  "probe_timeout",
  "unknown",
]);

export const ComputeHealthSchema = z
  .object({
    state: ComputeHealthStateSchema,
    observedAt: z.date(),
    nodeCount: z.number().int().nonnegative(),
    operationalNodeCount: z.number().int().nonnegative(),
    reason: ComputeHealthReasonSchema.optional(),
  })
  .refine((health) => health.operationalNodeCount <= health.nodeCount, {
    message: "operationalNodeCount cannot exceed nodeCount",
    path: ["operationalNodeCount"],
  })
  .refine((health) => health.state !== "ready" || health.operationalNodeCount > 0, {
    message: "ready compute health requires an operational node",
    path: ["operationalNodeCount"],
  })
  .refine((health) => health.state !== "unavailable" || health.operationalNodeCount === 0, {
    message: "unavailable compute health cannot report an operational node",
    path: ["operationalNodeCount"],
  });

export const AgentRegisterSchema = z.object({
  agentId: z.string().min(1).max(255),
  siteName: z.string().min(1).max(255),
  providerOrgId: z.string().uuid().optional(),
  siteId: z.string().min(1).max(255).optional(),
  clusterId: z.string().min(1).max(255).optional(),
  topology: z.record(z.string(), z.unknown()).optional(),
  schedulerType: SchedulerTypeEnum,
  schedulerVersion: z.string().min(1),
  capabilities: z.array(z.string()).optional(),
  rootMode: z.boolean().optional(),
  sandboxReadiness: z.enum(["ready", "degraded", "critical"]).optional(),
  sandboxCapabilities: z.record(z.string(), z.unknown()).optional(),
  sandboxRuntimeCache: z.array(z.record(z.string(), z.unknown())).optional(),
  restrictedDataIsolation: z.boolean().optional(),
  computeHealthV1: z.boolean().optional(),
  queueInventoryV1: z.boolean().optional(),
});

export const AgentHeartbeatSchema = z.object({
  agentId: z.string().min(1),
  cpuUsagePercent: z.number().min(0).max(100),
  memoryUsedMb: z.number().nonnegative(),
  memoryTotalMb: z.number().positive(),
  gpuCount: z.number().int().nonnegative().optional(),
  gpuUsagePercent: z.number().min(0).max(100).optional(),
  runningJobs: z.number().int().nonnegative().optional(),
  queuedJobs: z.number().int().nonnegative().optional(),
  /**
   * Migration 0013 — pending jobs in the agent's local scheduler queue.
   * Persisted on `agents.queue_depth` and read by the scheduler scoring
   * layer + CP-Console queue-depth sampler.
   */
  queueDepth: z.number().int().nonnegative().optional(),
  /**
   * Migration 0013 — historical 95th percentile of jobs' wait time in
   * seconds. Persisted on `agents.historical_p95_wait_sec` and read by
   * the queue-wait scorer.
   */
  historicalP95WaitSec: z.number().int().nonnegative().optional(),
  rootMode: z.boolean().optional(),
  sandboxReadiness: z.enum(["ready", "degraded", "critical"]).optional(),
  sandboxCapabilities: z.record(z.string(), z.unknown()).optional(),
  sandboxRuntimeCache: z.array(z.record(z.string(), z.unknown())).optional(),
  restrictedDataIsolation: z.boolean().optional(),
  computeHealth: ComputeHealthSchema.optional(),
  queueInventory: SchedulerQueueInventorySchema.optional(),
});

/**
 * One physical GPU's live telemetry. The connectRPC heartbeat carries a
 * `repeated GpuMetric`; the Server persists each into `agent_metrics` (value =
 * utilPercent, the rest in `payload`). This schema is the canonical decode of
 * that persisted shape, shared so the Server read path and the TUI agree.
 */
export const AgentGpuSampleSchema = z.object({
  index: z.number().int().nonnegative(),
  model: z.string(),
  utilPercent: z.number(),
  memUsedMb: z.number().nonnegative(),
  memTotalMb: z.number().nonnegative(),
});

export type AgentRegister = z.infer<typeof AgentRegisterSchema>;
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;
export type SchedulerType = z.infer<typeof SchedulerTypeEnum>;
export type AgentGpuSample = z.infer<typeof AgentGpuSampleSchema>;
export type ComputeHealth = z.infer<typeof ComputeHealthSchema>;
export type ComputeHealthState = z.infer<typeof ComputeHealthStateSchema>;
export type ComputeHealthReason = z.infer<typeof ComputeHealthReasonSchema>;
