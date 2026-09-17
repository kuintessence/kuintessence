import { type PgDb, queueObservabilityCounters, queueObservabilityEvents } from "@kuintessence/db";
import {
  type QueueFailureCode,
  QueueFailureCodeSchema,
  type QueueInventoryStatus,
} from "@kuintessence/shared";
import { sql } from "drizzle-orm";
import type { QueueInventoryCoverage, QueueInventoryService } from "./queue-inventory";

export const QUEUE_SHADOW_REJECTION_METRIC = "queue_validation_shadow_rejection";
export const SCHEDULER_SUBMIT_FAILURE_METRIC = "scheduler_submit_failure";

export type QueueObservabilityMetric =
  | typeof QUEUE_SHADOW_REJECTION_METRIC
  | typeof SCHEDULER_SUBMIT_FAILURE_METRIC;

export interface QueueFailureCounts {
  shadowRejections: Record<QueueFailureCode, number>;
  schedulerSubmitFailures: Record<QueueFailureCode, number>;
}

export interface QueueObservabilitySnapshot {
  coverage: QueueInventoryCoverage;
  failures: QueueFailureCounts;
}

export interface QueueObservabilityEvent {
  agentId: string;
  eventId: string;
  metric: QueueObservabilityMetric;
  failureCode: QueueFailureCode;
}

export class QueueObservabilityService {
  constructor(
    private readonly db: PgDb,
    private readonly inventory: Pick<QueueInventoryService, "getCoverage">,
  ) {}

  /**
   * Claims an Agent event and advances its fixed-cardinality counter in one
   * transaction. A replay that has already been claimed returns false.
   */
  async recordEvent(event: QueueObservabilityEvent): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(queueObservabilityEvents)
        .values({
          agentId: event.agentId,
          eventId: event.eventId,
          metric: event.metric,
          failureCode: event.failureCode,
        })
        .onConflictDoNothing()
        .returning({ id: queueObservabilityEvents.id });
      if (!claimed) return false;

      await tx
        .insert(queueObservabilityCounters)
        .values({
          metric: event.metric,
          failureCode: event.failureCode,
          count: 1,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [queueObservabilityCounters.metric, queueObservabilityCounters.failureCode],
          set: {
            count: sql`${queueObservabilityCounters.count} + 1`,
            updatedAt: new Date(),
          },
        });
      return true;
    });
  }

  async snapshot(): Promise<QueueObservabilitySnapshot> {
    const [coverage, counters] = await Promise.all([
      this.inventory.getCoverage(),
      this.db
        .select({
          metric: queueObservabilityCounters.metric,
          failureCode: queueObservabilityCounters.failureCode,
          count: queueObservabilityCounters.count,
        })
        .from(queueObservabilityCounters),
    ]);
    const failures: QueueFailureCounts = {
      shadowRejections: emptyFailureCounts(),
      schedulerSubmitFailures: emptyFailureCounts(),
    };

    for (const counter of counters) {
      const failureCode = QueueFailureCodeSchema.safeParse(counter.failureCode);
      if (!failureCode.success || !Number.isFinite(counter.count) || counter.count < 0) continue;
      if (counter.metric === QUEUE_SHADOW_REJECTION_METRIC) {
        failures.shadowRejections[failureCode.data] += counter.count;
      }
      if (counter.metric === SCHEDULER_SUBMIT_FAILURE_METRIC) {
        failures.schedulerSubmitFailures[failureCode.data] += counter.count;
      }
    }

    return { coverage, failures };
  }
}

export function emptyQueueObservabilitySnapshot(): QueueObservabilitySnapshot {
  return {
    coverage: {
      totalHpcAgents: 0,
      capabilityDeclared: 0,
      activeNoGoAgents: 0,
      lastNoGoAt: null,
      statusCounts: {
        unknown: 0,
        available: 0,
        unavailable: 0,
        stale: 0,
        unsupported: 0,
      },
    },
    failures: {
      shadowRejections: emptyFailureCounts(),
      schedulerSubmitFailures: emptyFailureCounts(),
    },
  };
}

function emptyFailureCounts(): Record<QueueFailureCode, number> {
  return Object.fromEntries(
    QueueFailureCodeSchema.options.map((failureCode) => [failureCode, 0]),
  ) as Record<QueueFailureCode, number>;
}

export function queueInventoryStatusCount(
  coverage: QueueInventoryCoverage,
  status: QueueInventoryStatus,
): number {
  return coverage.statusCounts[status] ?? 0;
}
