import type {
  QueueFailureCode,
  QueueInventoryReason,
  SchedulerQueueFact,
  SchedulerQueueInventory,
} from "@kuintessence/shared";
import type { QueueTargetValidation, QueueTargetValidationResult } from "./base";
import { isSchedulerQueueName } from "./base";

export function unavailableQueueInventory(
  reason: QueueInventoryReason,
  observedAt = new Date(),
): SchedulerQueueInventory {
  return {
    status: "unavailable",
    reason,
    observedAt,
    queues: [],
  };
}

export function availableQueueInventory(
  queues: SchedulerQueueFact[],
  observedAt = new Date(),
): SchedulerQueueInventory {
  const defaultQueues = queues.filter((queue) => queue.isDefault);
  if (defaultQueues.length > 1) {
    return unavailableQueueInventory("multiple_default_queues", observedAt);
  }
  return {
    status: "available",
    ...(defaultQueues[0] ? { defaultQueueName: defaultQueues[0].queueName } : {}),
    observedAt,
    queues,
  };
}

export function validateQueueTarget(
  inventory: SchedulerQueueInventory,
  target: QueueTargetValidation,
): QueueTargetValidationResult {
  if (target.targetMode === "default" && target.queueName !== undefined) {
    return { accepted: false, failureCode: "QUEUE_CHANGED" };
  }
  if (target.targetMode === "named" && !isSchedulerQueueName(target.queueName ?? "")) {
    return { accepted: false, failureCode: "QUEUE_NOT_FOUND" };
  }
  if (inventory.status !== "available") {
    return { accepted: false, failureCode: "QUEUE_CHANGED" };
  }
  const queue =
    target.targetMode === "default"
      ? inventory.queues.find((item) => item.isDefault)
      : inventory.queues.find((item) => item.queueName === target.queueName);
  if (!queue) return { accepted: false, failureCode: "QUEUE_NOT_FOUND" };
  if (queue.state !== "up" || !queue.acceptsSubmissions) {
    return { accepted: false, failureCode: "QUEUE_NOT_ACCEPTING" };
  }
  return { accepted: true, resolvedQueueName: queue.queueName };
}

export class SchedulerQueueInventoryCache {
  private snapshot: SchedulerQueueInventory | undefined;
  private expiresAt = 0;
  private pending: Promise<SchedulerQueueInventory> | undefined;

  constructor(private readonly refreshIntervalMs = 30_000) {}

  async inspect(loader: () => Promise<SchedulerQueueInventory>): Promise<SchedulerQueueInventory> {
    if (this.snapshot && Date.now() < this.expiresAt) return this.snapshot;
    if (this.pending) return this.pending;
    this.pending = loader().then((inventory) => {
      this.snapshot = inventory;
      this.expiresAt = Date.now() + this.refreshIntervalMs;
      return inventory;
    });
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
}

export function queueFailureCode(error: unknown): QueueFailureCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failureCode = (error as { failureCode?: unknown }).failureCode;
  return failureCode === "QUEUE_NOT_FOUND" ||
    failureCode === "QUEUE_NOT_ACCEPTING" ||
    failureCode === "QUEUE_CHANGED" ||
    failureCode === "SCHEDULER_SUBMIT_FAILED"
    ? failureCode
    : undefined;
}
