import type {
  QueueRegistryView,
  QueueSubmitEligibility,
  QueueTargetMode,
} from "@kuintessence/shared/browser";

export type PlacementSelection = { mode: "auto" } | { mode: "default" | "named"; queueId: string };

export function queueTargetMode(
  queue: Pick<QueueRegistryView, "target" | "queueName">,
): QueueTargetMode | null {
  if (queue.target) return queue.target.mode;
  return queue.queueName ? "named" : null;
}

export function queueEligibility(
  queue: Pick<QueueRegistryView, "submitEligibility">,
): QueueSubmitEligibility {
  return queue.submitEligibility ?? { state: "ready", reason: null, retryable: false };
}

export function buildSchedulingStrategy(
  selection: PlacementSelection,
): { queueId: string } | undefined {
  return selection.mode === "auto" || !selection.queueId
    ? undefined
    : { queueId: selection.queueId };
}

export function isPlacementSelectionAvailable(
  selection: PlacementSelection,
  queues: readonly QueueRegistryView[],
): boolean {
  if (selection.mode === "auto") return true;
  if (!selection.queueId) return false;
  const queue = queues.find((item) => item.queueId === selection.queueId);
  return Boolean(queue && queueTargetMode(queue) === selection.mode);
}
