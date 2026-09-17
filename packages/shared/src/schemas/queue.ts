import { z } from "zod";
import { SchedulerTypeEnum } from "./scheduler";

export const QueueIdSchema = z.string().min(1).max(255);
export const SchedulerQueueNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "queueName must be a scheduler token");

export const QueueTargetModeSchema = z.enum(["default", "named"]);

export const QueueTargetSchema = z
  .object({
    mode: QueueTargetModeSchema,
  })
  .strict();

export const QueueValidationModeSchema = z.enum(["off", "shadow", "enforce"]);

export const QueueInventoryStatusSchema = z.enum([
  "unknown",
  "available",
  "unavailable",
  "stale",
  "unsupported",
]);

export const QueueInventoryReasonSchema = z.enum([
  "command_failed",
  "invalid_output",
  "multiple_default_queues",
  "default_queue_missing",
  "unsupported_scheduler",
  "stale",
  "unknown",
]);

export const SchedulerQueueTypeSchema = z.enum([
  "partition",
  "execution",
  "route",
  "namespace",
  "unknown",
]);

export const SchedulerQueueStateSchema = z.enum(["up", "down", "unknown"]);

export const SchedulerQueueFactSchema = z.object({
  queueName: SchedulerQueueNameSchema,
  queueType: SchedulerQueueTypeSchema,
  isDefault: z.boolean(),
  state: SchedulerQueueStateSchema,
  acceptsSubmissions: z.boolean(),
  hasComputeTargets: z.boolean().optional(),
  observedAt: z.date(),
});

export const SchedulerQueueInventorySchema = z
  .object({
    status: QueueInventoryStatusSchema,
    defaultQueueName: SchedulerQueueNameSchema.optional(),
    reason: QueueInventoryReasonSchema.optional(),
    observedAt: z.date(),
    queues: z.array(SchedulerQueueFactSchema).default([]),
  })
  .superRefine((inventory, ctx) => {
    const defaultQueues = inventory.queues.filter((queue) => queue.isDefault);
    if (defaultQueues.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["queues"],
        message: "queue inventory can contain at most one default queue",
      });
    }
    if (
      inventory.defaultQueueName !== undefined &&
      !defaultQueues.some((queue) => queue.queueName === inventory.defaultQueueName)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultQueueName"],
        message: "defaultQueueName must reference an observed default queue",
      });
    }
    if (
      new Set(inventory.queues.map((queue) => queue.queueName)).size !== inventory.queues.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["queues"],
        message: "queue inventory cannot contain duplicate queue names",
      });
    }
  });

export const QueueFailureCodeSchema = z.enum([
  "QUEUE_NOT_FOUND",
  "QUEUE_NOT_ACCEPTING",
  "QUEUE_CHANGED",
  "SCHEDULER_SUBMIT_FAILED",
]);

export const QueueAvailabilityReasonSchema = z.enum([
  "command_failed",
  "invalid_output",
  "multiple_default_queues",
  "default_queue_missing",
  "unsupported_scheduler",
  "stale",
  "unknown",
  "queue_disabled",
  "queue_not_found",
  "queue_not_accepting",
  "scheduler_mismatch",
  "inventory_not_supported",
]);

export const QueueAvailabilitySchema = z.object({
  state: QueueInventoryStatusSchema,
  reason: QueueAvailabilityReasonSchema.nullable(),
  observedAt: z.string().datetime().nullable(),
});

export const QueueSubmitEligibilityStateSchema = z.enum(["ready", "warning", "blocked"]);

export const QueueSubmitEligibilityReasonSchema = z.enum([
  "command_failed",
  "invalid_output",
  "multiple_default_queues",
  "default_queue_missing",
  "unsupported_scheduler",
  "stale",
  "unknown",
  "queue_disabled",
  "queue_not_found",
  "queue_not_accepting",
  "scheduler_mismatch",
  "inventory_not_supported",
  "submit_permission_missing",
]);

export const QueueSubmitEligibilitySchema = z
  .object({
    state: QueueSubmitEligibilityStateSchema,
    reason: QueueSubmitEligibilityReasonSchema.nullable(),
    retryable: z.boolean(),
  })
  .superRefine((eligibility, ctx) => {
    if (eligibility.state === "ready") {
      if (eligibility.reason !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["reason"],
          message: "ready queue eligibility cannot include a reason",
        });
      }
      if (eligibility.retryable) {
        ctx.addIssue({
          code: "custom",
          path: ["retryable"],
          message: "ready queue eligibility cannot be retryable",
        });
      }
      return;
    }
    if (eligibility.reason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "non-ready queue eligibility requires a reason",
      });
    }
  });

export const QueueInventoryFactViewSchema = z.object({
  queueName: SchedulerQueueNameSchema,
  queueType: SchedulerQueueTypeSchema,
  isDefault: z.boolean(),
  state: SchedulerQueueStateSchema,
  acceptsSubmissions: z.boolean(),
  hasComputeTargets: z.boolean().optional(),
  observedAt: z.string().datetime(),
  managed: z.boolean(),
  managedQueueIds: z.array(QueueIdSchema),
});

export const QueueInventoryManagedTargetSchema = z.object({
  queueId: QueueIdSchema,
  targetMode: QueueTargetModeSchema,
  queueName: SchedulerQueueNameSchema.nullable(),
  available: z.boolean(),
  reason: QueueAvailabilityReasonSchema.nullable(),
});

export const QueueInventoryAdminViewSchema = z.object({
  agentId: z.string().min(1).max(255),
  providerOrgId: z.string().uuid().nullable(),
  schedulerType: SchedulerTypeEnum,
  queueInventoryV1: z.boolean(),
  status: QueueInventoryStatusSchema,
  defaultQueueName: SchedulerQueueNameSchema.nullable(),
  reason: QueueInventoryReasonSchema.nullable(),
  observedAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable().optional().default(null),
  lastSuccessfulObservedAt: z.string().datetime().nullable().optional().default(null),
  freshUntil: z.string().datetime().nullable().optional().default(null),
  queues: z.array(QueueInventoryFactViewSchema).default([]),
  managedTargets: z.array(QueueInventoryManagedTargetSchema).default([]),
});

export function resolveQueueTargetMode(input: { target?: QueueTarget }): QueueTargetMode {
  return input.target?.mode ?? "named";
}

export const QueueRegistryCreateSchema = z
  .object({
    queueId: QueueIdSchema,
    name: z.string().min(1).max(255),
    providerOrgId: z.string().uuid().optional(),
    visibleOrgIds: z.array(z.string().uuid()).default([]),
    agentId: z.string().min(1).max(255),
    schedulerType: SchedulerTypeEnum,
    queueName: SchedulerQueueNameSchema.optional(),
    target: QueueTargetSchema.optional(),
    qos: z.string().min(1).max(255).nullable().optional(),
    enabled: z.boolean().default(true),
    policyTags: z.array(z.string().min(1).max(255)).default([]),
  })
  .superRefine((queue, ctx) => {
    const targetMode = resolveQueueTargetMode(queue);
    if (targetMode === "named" && queue.queueName === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["queueName"],
        message: "named queue targets require queueName",
      });
    }
    if (targetMode === "default" && queue.queueName !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["queueName"],
        message: "default queue targets cannot include queueName",
      });
    }
  });

export const QueueRegistryUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    visibleOrgIds: z.array(z.string().uuid()).optional(),
    agentId: z.string().min(1).max(255).optional(),
    schedulerType: SchedulerTypeEnum.optional(),
    queueName: SchedulerQueueNameSchema.optional(),
    target: QueueTargetSchema.optional(),
    qos: z.string().min(1).max(255).nullable().optional(),
    enabled: z.boolean().optional(),
    policyTags: z.array(z.string().min(1).max(255)).optional(),
  })
  .superRefine((queue, ctx) => {
    if (queue.target?.mode === "named" && queue.queueName === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["queueName"],
        message: "named queue target updates require queueName",
      });
    }
    if (queue.target?.mode === "default" && queue.queueName !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["queueName"],
        message: "default queue targets cannot include queueName",
      });
    }
  });

export const QueueRegistryViewSchema = z.object({
  queueId: QueueIdSchema,
  name: z.string().min(1).max(255),
  providerOrgId: z.string().uuid(),
  visibleOrgIds: z.array(z.string().uuid()),
  agentId: z.string().min(1).max(255),
  schedulerType: SchedulerTypeEnum,
  queueName: SchedulerQueueNameSchema.nullable(),
  target: QueueTargetSchema.optional(),
  qos: z.string().nullable(),
  resolvedQueueName: SchedulerQueueNameSchema.nullable().optional(),
  availability: QueueAvailabilitySchema.optional(),
  submitEligibility: QueueSubmitEligibilitySchema.optional(),
  enabled: z.boolean(),
  policyTags: z.array(z.string().min(1).max(255)),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type QueueRegistryCreate = z.infer<typeof QueueRegistryCreateSchema>;
export type QueueRegistryUpdate = z.infer<typeof QueueRegistryUpdateSchema>;
export type QueueRegistryView = z.infer<typeof QueueRegistryViewSchema>;
export type QueueTarget = z.infer<typeof QueueTargetSchema>;
export type QueueTargetMode = z.infer<typeof QueueTargetModeSchema>;
export type QueueValidationMode = z.infer<typeof QueueValidationModeSchema>;
export type QueueInventoryStatus = z.infer<typeof QueueInventoryStatusSchema>;
export type SchedulerQueueFact = z.infer<typeof SchedulerQueueFactSchema>;
export type SchedulerQueueInventory = z.infer<typeof SchedulerQueueInventorySchema>;
export type QueueInventoryReason = z.infer<typeof QueueInventoryReasonSchema>;
export type QueueFailureCode = z.infer<typeof QueueFailureCodeSchema>;
export type QueueAvailabilityReason = z.infer<typeof QueueAvailabilityReasonSchema>;
export type QueueSubmitEligibility = z.infer<typeof QueueSubmitEligibilitySchema>;
export type QueueSubmitEligibilityReason = z.infer<typeof QueueSubmitEligibilityReasonSchema>;
export type QueueInventoryFactView = z.infer<typeof QueueInventoryFactViewSchema>;
export type QueueInventoryManagedTarget = z.infer<typeof QueueInventoryManagedTargetSchema>;
export type QueueInventoryAdminView = z.infer<typeof QueueInventoryAdminViewSchema>;
