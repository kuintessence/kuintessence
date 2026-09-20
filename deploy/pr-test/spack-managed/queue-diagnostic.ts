import {
  QueueInventoryAdminViewSchema,
  SchedulerQueueInventorySchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { SlurmAdapter } from "../../../packages/agent/src/adapters/slurm";

const QueueDiagnosticViewSchema = QueueInventoryAdminViewSchema.extend({
  lastNoGoAt: z.string().datetime().nullable().optional(),
  recoveryStartedAt: z.string().datetime().nullable().optional(),
  recoveredAt: z.string().datetime().nullable().optional(),
});

function presence(value: string | null | undefined): string {
  return value === undefined ? "unavailable" : value === null ? "absent" : "present";
}

function age(value: string | null, now: number): string {
  if (value === null) return "missing";
  const elapsed = now - Date.parse(value);
  if (elapsed < 0) return "future";
  if (elapsed <= 120_000) return "under-120s";
  return elapsed <= 240_000 ? "120-240s" : "over-240s";
}

export function managedQueueMarker(input: unknown, now = Date.now()): string {
  const view = QueueDiagnosticViewSchema.parse(input);
  const target = view.queues.find((queue) => queue.queueName === "debug");
  return [
    `ci-managed-queue:capable=${view.queueInventoryV1}`,
    `status=${view.status}`,
    `reason=${view.reason ?? "none"}`,
    `target=${target?.state ?? "missing"}`,
    `accepting=${target?.acceptsSubmissions ?? false}`,
    `attempt-age=${age(view.lastAttemptAt, now)}`,
    `observation-age=${age(view.lastSuccessfulObservedAt, now)}`,
    `no-go=${presence(view.lastNoGoAt)}`,
    `recovering=${presence(view.recoveryStartedAt)}`,
    `recovered=${presence(view.recoveredAt)}`,
  ].join(" ");
}

export function nativeQueueMarker(input: unknown): string {
  const view = SchedulerQueueInventorySchema.parse(input);
  const target = view.queues.find((queue) => queue.queueName === "debug");
  return [
    `ci-managed-queue-native:status=${view.status}`,
    `reason=${view.reason ?? "none"}`,
    `target=${target?.state ?? "missing"}`,
    `accepting=${target?.acceptsSubmissions ?? false}`,
  ].join(" ");
}

export async function diagnoseManagedQueue(): Promise<void> {
  try {
    if (process.env.KQ_PR_TEST !== "1" || process.getuid?.() !== 1000) return;
    // Use the existing native parser without emitting CLI output or host names.
    const adapter = new SlurmAdapter("unknown", { queueInventoryTimeoutMs: 5_000 });
    console.error(nativeQueueMarker(await adapter.inspectQueues()));
  } catch {
    console.error("ci-managed-queue-native:unavailable");
  }
}
