import {
  agentSchedulerQueueSnapshots,
  agentSchedulerQueues,
  agents,
  auditLog,
  type PgDb,
  schedulerQueues,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type QueueAvailabilityReason,
  type QueueInventoryReason,
  QueueInventoryReasonSchema,
  type QueueInventoryStatus,
  QueueInventoryStatusSchema,
  type QueueTargetMode,
  type SchedulerQueueFact,
  SchedulerQueueInventorySchema,
  SchedulerQueueStateSchema,
  SchedulerQueueTypeSchema,
} from "@kuintessence/shared";
import { eq, sql } from "drizzle-orm";

const DEFAULT_QUEUE_INVENTORY_MAX_AGE_SEC = 120;
const DEFAULT_QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC = 5;

export interface QueueInventoryServiceOptions {
  maxAgeSec?: number;
  maxFutureSkewSec?: number;
  recoveryHoldSec?: number;
  now?: () => Date;
}

export interface AgentQueueInventory {
  agentId: string;
  providerOrgId: string | null;
  schedulerType: string;
  queueInventoryV1: boolean;
  status: QueueInventoryStatus;
  defaultQueueName: string | null;
  reason: QueueInventoryReason | null;
  /** Legacy observation timestamp retained for older clients. */
  observedAt: Date | null;
  lastAttemptAt: Date | null;
  lastSuccessfulObservedAt: Date | null;
  lastNoGoAt: Date | null;
  noGoReason: QueueInventoryReason | null;
  recoveryStartedAt: Date | null;
  recoveredAt: Date | null;
  freshUntil: Date | null;
  queues: SchedulerQueueFact[];
}

export interface QueueTargetInspection {
  agentId: string;
  schedulerType: string;
  targetMode: QueueTargetMode;
  queueName?: string;
}

export interface QueueTargetAvailability {
  capabilityDeclared: boolean;
  inventoryAvailable: boolean;
  targetAvailable: boolean;
  state: QueueInventoryStatus;
  reason: QueueAvailabilityReason | null;
  observedAt: Date | null;
  resolvedQueueName: string | null;
}

export interface QueueInventoryReconcileResult {
  status: QueueInventoryStatus;
  reason: QueueInventoryReason | null;
  observedAt: Date;
}

export interface QueueInventoryCoverage {
  totalHpcAgents: number;
  capabilityDeclared: number;
  activeNoGoAgents: number;
  lastNoGoAt: Date | null;
  statusCounts: Record<QueueInventoryStatus, number>;
}

interface NormalizedQueueInventory extends QueueInventoryReconcileResult {
  defaultQueueName: string | null;
  queues: SchedulerQueueFact[];
  replaceFacts: boolean;
}

type QueueInventorySnapshotRow = typeof agentSchedulerQueueSnapshots.$inferSelect;

interface QueueInventoryNoGoState {
  lastNoGoAt: Date | null;
  noGoReason: QueueInventoryReason | null;
  recoveryStartedAt: Date | null;
  recoveredAt: Date | null;
  active: boolean;
}

/**
 * Owns the Agent-reported scheduler facts. Queue policy remains in
 * QueueRegistryService; this service never modifies scheduler configuration.
 */
export class QueueInventoryService {
  constructor(
    private readonly db: PgDb,
    private readonly options: QueueInventoryServiceOptions = {},
  ) {}

  async declareCapability(agentId: string, queueInventoryV1: boolean): Promise<void> {
    const now = this.now();
    if (queueInventoryV1) {
      await this.db
        .insert(agentSchedulerQueueSnapshots)
        .values({
          agentId,
          queueInventoryV1: true,
          status: "unknown",
          defaultQueueName: null,
          reason: null,
          observedAt: null,
          lastAttemptAt: null,
          lastSuccessfulObservedAt: null,
          lastNoGoAt: null,
          noGoReason: null,
          recoveryStartedAt: null,
          recoveredAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: agentSchedulerQueueSnapshots.agentId,
          set: { queueInventoryV1: true, updatedAt: now },
        });
      return;
    }

    await this.db
      .insert(agentSchedulerQueueSnapshots)
      .values({
        agentId,
        queueInventoryV1: false,
        status: "unsupported",
        defaultQueueName: null,
        reason: "unsupported_scheduler",
        observedAt: null,
        lastAttemptAt: now,
        lastSuccessfulObservedAt: null,
        lastNoGoAt: null,
        noGoReason: null,
        recoveryStartedAt: null,
        recoveredAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentSchedulerQueueSnapshots.agentId,
        set: {
          queueInventoryV1: false,
          status: "unsupported",
          reason: "unsupported_scheduler",
          lastAttemptAt: now,
          updatedAt: now,
        },
      });
  }

  /**
   * Reconciles one heartbeat snapshot. Successful snapshots atomically replace
   * facts; failed collection only changes snapshot state so the last known
   * facts remain inspectable for operations.
   */
  async reconcile(agentId: string, input: unknown): Promise<QueueInventoryReconcileResult> {
    const now = this.now();
    const normalized = normalizeInventory(input, now, this.options);
    const reconciledNoGo = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agentId}, 0))`);
      const [previousSnapshot] = await tx
        .select()
        .from(agentSchedulerQueueSnapshots)
        .where(eq(agentSchedulerQueueSnapshots.agentId, agentId))
        .limit(1);
      const previousFacts = await tx
        .select()
        .from(agentSchedulerQueues)
        .where(eq(agentSchedulerQueues.agentId, agentId));
      const noGo = nextQueueInventoryNoGoState(previousSnapshot, normalized, now, this.options);

      if (normalized.replaceFacts) {
        await tx
          .insert(agentSchedulerQueueSnapshots)
          .values({
            agentId,
            queueInventoryV1: true,
            status: normalized.status,
            defaultQueueName: normalized.defaultQueueName,
            reason: normalized.reason,
            observedAt: normalized.observedAt,
            lastAttemptAt: now,
            lastSuccessfulObservedAt: normalized.observedAt,
            lastNoGoAt: noGo.lastNoGoAt,
            noGoReason: noGo.noGoReason,
            recoveryStartedAt: noGo.recoveryStartedAt,
            recoveredAt: noGo.recoveredAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: agentSchedulerQueueSnapshots.agentId,
            set: {
              queueInventoryV1: true,
              status: normalized.status,
              defaultQueueName: normalized.defaultQueueName,
              reason: normalized.reason,
              observedAt: normalized.observedAt,
              lastAttemptAt: now,
              lastSuccessfulObservedAt: normalized.observedAt,
              lastNoGoAt: noGo.lastNoGoAt,
              noGoReason: noGo.noGoReason,
              recoveryStartedAt: noGo.recoveryStartedAt,
              recoveredAt: noGo.recoveredAt,
              updatedAt: now,
            },
          });
        await tx.delete(agentSchedulerQueues).where(eq(agentSchedulerQueues.agentId, agentId));
        if (normalized.queues.length > 0) {
          await tx.insert(agentSchedulerQueues).values(
            normalized.queues.map((queue) => ({
              agentId,
              queueName: queue.queueName,
              queueType: queue.queueType,
              isDefault: queue.isDefault,
              state: queue.state,
              acceptsSubmissions: queue.acceptsSubmissions,
              hasComputeTargets: queue.hasComputeTargets ?? null,
              observedAt: queue.observedAt,
            })),
          );
        }

        const auditEntries: Array<typeof auditLog.$inferInsert> = [];
        if (
          previousSnapshot?.defaultQueueName !== null &&
          previousSnapshot?.defaultQueueName !== undefined &&
          previousSnapshot.defaultQueueName !== normalized.defaultQueueName
        ) {
          auditEntries.push({
            actor: "system",
            action: "queue.inventory.default_changed",
            target: agentId,
            diff: {
              before: { defaultQueueName: previousSnapshot.defaultQueueName },
              after: {
                defaultQueueName: normalized.defaultQueueName,
                observedAt: normalized.observedAt.toISOString(),
              },
            },
          });
        }

        const managedTargets = await tx
          .select({
            queueId: schedulerQueues.queueId,
            targetMode: schedulerQueues.targetMode,
            queueName: schedulerQueues.queueName,
          })
          .from(schedulerQueues)
          .where(eq(schedulerQueues.agentId, agentId));
        const previousNames = new Set(previousFacts.map((queue) => queue.queueName));
        const currentNames = new Set(normalized.queues.map((queue) => queue.queueName));
        for (const target of managedTargets) {
          if (
            target.targetMode === "named" &&
            target.queueName !== null &&
            previousNames.has(target.queueName) &&
            !currentNames.has(target.queueName)
          ) {
            auditEntries.push({
              actor: "system",
              action: "queue.inventory.managed_target_missing",
              target: target.queueId,
              diff: {
                before: { agentId, queueName: target.queueName, observed: true },
                after: {
                  agentId,
                  queueName: target.queueName,
                  observed: false,
                  observedAt: normalized.observedAt.toISOString(),
                },
              },
            });
          }
        }
        if (auditEntries.length > 0) {
          await tx.insert(auditLog).values(auditEntries);
        }
        return noGo;
      }

      await tx
        .insert(agentSchedulerQueueSnapshots)
        .values({
          agentId,
          queueInventoryV1: true,
          status: normalized.status,
          defaultQueueName: previousSnapshot?.defaultQueueName ?? null,
          reason: normalized.reason,
          observedAt: normalized.observedAt,
          lastAttemptAt: now,
          lastSuccessfulObservedAt:
            previousSnapshot?.lastSuccessfulObservedAt ??
            previousSnapshot?.observedAt ??
            latestObservedAt(previousFacts),
          lastNoGoAt: noGo.lastNoGoAt,
          noGoReason: noGo.noGoReason,
          recoveryStartedAt: noGo.recoveryStartedAt,
          recoveredAt: noGo.recoveredAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: agentSchedulerQueueSnapshots.agentId,
          set: {
            queueInventoryV1: true,
            status: normalized.status,
            reason: normalized.reason,
            observedAt: normalized.observedAt,
            lastAttemptAt: now,
            lastSuccessfulObservedAt:
              previousSnapshot?.lastSuccessfulObservedAt ??
              previousSnapshot?.observedAt ??
              latestObservedAt(previousFacts),
            lastNoGoAt: noGo.lastNoGoAt,
            noGoReason: noGo.noGoReason,
            recoveryStartedAt: noGo.recoveryStartedAt,
            recoveredAt: noGo.recoveredAt,
            updatedAt: now,
          },
        });
      return noGo;
    });
    return {
      status: reconciledNoGo.active ? "unavailable" : normalized.status,
      reason: reconciledNoGo.active ? reconciledNoGo.noGoReason : normalized.reason,
      observedAt: normalized.observedAt,
    };
  }

  async getForAgent(agentId: string): Promise<AgentQueueInventory> {
    const [agent] = await this.db
      .select({
        agentId: agents.agentId,
        providerOrgId: agents.providerOrgId,
        schedulerType: agents.schedulerType,
      })
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, `Agent ${agentId} not found`, 404);
    }
    const [snapshot, facts] = await Promise.all([
      this.db
        .select()
        .from(agentSchedulerQueueSnapshots)
        .where(eq(agentSchedulerQueueSnapshots.agentId, agentId))
        .limit(1),
      this.db.select().from(agentSchedulerQueues).where(eq(agentSchedulerQueues.agentId, agentId)),
    ]);
    const stored = snapshot[0];
    const rawStatus = queueInventoryStatus(stored?.status);
    const noGo = storedQueueInventoryNoGoState(stored);
    const lastSuccessfulObservedAt =
      stored?.lastSuccessfulObservedAt ??
      (rawStatus === "available" ? (stored?.observedAt ?? latestObservedAt(facts)) : null);
    const status = noGo.active
      ? "unavailable"
      : effectiveInventoryStatus(rawStatus, lastSuccessfulObservedAt, this.now(), this.options);
    const reason = noGo.active
      ? noGo.noGoReason
      : status === "stale"
        ? "stale"
        : status === "unknown" && rawStatus === "available"
          ? "unknown"
          : queueInventoryReason(stored?.reason);
    const freshUntil =
      status === "available" && lastSuccessfulObservedAt
        ? queueInventoryFreshUntil(lastSuccessfulObservedAt, this.options)
        : null;
    return {
      agentId: agent.agentId,
      providerOrgId: agent.providerOrgId,
      schedulerType: agent.schedulerType,
      queueInventoryV1: stored?.queueInventoryV1 ?? false,
      status,
      defaultQueueName: stored?.defaultQueueName ?? null,
      reason,
      observedAt: stored?.observedAt ?? null,
      lastAttemptAt: stored?.lastAttemptAt ?? stored?.observedAt ?? null,
      lastSuccessfulObservedAt,
      lastNoGoAt: noGo.lastNoGoAt,
      noGoReason: noGo.noGoReason,
      recoveryStartedAt: noGo.recoveryStartedAt,
      recoveredAt: noGo.recoveredAt,
      freshUntil,
      queues: facts.map(toFact),
    };
  }

  async assertAgentBinding(input: {
    agentId: string;
    providerOrgId: string;
    schedulerType: string;
  }): Promise<{ schedulerType: string }> {
    const [agent] = await this.db
      .select({ providerOrgId: agents.providerOrgId, schedulerType: agents.schedulerType })
      .from(agents)
      .where(eq(agents.agentId, input.agentId))
      .limit(1);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, `Agent ${input.agentId} not found`, 404);
    }
    if (agent.providerOrgId !== input.providerOrgId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        `Agent ${input.agentId} does not belong to this provider`,
        403,
      );
    }
    if (agent.schedulerType !== input.schedulerType) {
      throw queueUnavailable(
        `Agent ${input.agentId} scheduler does not match queue scheduler`,
        "scheduler_mismatch",
      );
    }
    return { schedulerType: agent.schedulerType };
  }

  async inspectTarget(input: QueueTargetInspection): Promise<QueueTargetAvailability> {
    const inventory = await this.getForAgent(input.agentId);
    if (inventory.schedulerType !== input.schedulerType) {
      return unavailableTarget(inventory, "scheduler_mismatch", input.queueName ?? null);
    }
    if (!isHpcScheduler(input.schedulerType)) {
      return {
        capabilityDeclared: inventory.queueInventoryV1,
        inventoryAvailable: true,
        targetAvailable: true,
        state: inventory.status,
        reason: null,
        observedAt: inventory.lastSuccessfulObservedAt,
        resolvedQueueName: input.targetMode === "named" ? (input.queueName ?? null) : null,
      };
    }
    if (!inventory.queueInventoryV1) {
      return {
        capabilityDeclared: false,
        inventoryAvailable: false,
        targetAvailable: false,
        state: "unknown",
        reason: "inventory_not_supported",
        observedAt: inventory.lastSuccessfulObservedAt,
        resolvedQueueName: null,
      };
    }
    if (inventory.status !== "available") {
      return {
        capabilityDeclared: true,
        inventoryAvailable: false,
        targetAvailable: false,
        state: inventory.status,
        reason: inventory.reason ?? "unknown",
        observedAt: inventory.lastSuccessfulObservedAt,
        resolvedQueueName: null,
      };
    }
    const selected =
      input.targetMode === "default"
        ? inventory.queues.find((queue) => queue.isDefault)
        : inventory.queues.find((queue) => queue.queueName === input.queueName);
    if (!selected) {
      return unavailableTarget(
        inventory,
        input.targetMode === "default" ? "default_queue_missing" : "queue_not_found",
        input.queueName ?? null,
      );
    }
    if (selected.state !== "up" || !selected.acceptsSubmissions) {
      return unavailableTarget(inventory, "queue_not_accepting", selected.queueName);
    }
    return {
      capabilityDeclared: true,
      inventoryAvailable: true,
      targetAvailable: true,
      state: "available",
      reason: null,
      observedAt: inventory.lastSuccessfulObservedAt,
      resolvedQueueName: selected.queueName,
    };
  }

  async getCoverage(): Promise<QueueInventoryCoverage> {
    const [agentRows, snapshotRows] = await Promise.all([
      this.db.select({ agentId: agents.agentId, schedulerType: agents.schedulerType }).from(agents),
      this.db.select().from(agentSchedulerQueueSnapshots),
    ]);
    const snapshots = new Map(snapshotRows.map((snapshot) => [snapshot.agentId, snapshot]));
    const statusCounts = emptyInventoryStatusCounts();
    let totalHpcAgents = 0;
    let capabilityDeclared = 0;
    let activeNoGoAgents = 0;
    let lastNoGoAt: Date | null = null;

    for (const agent of agentRows) {
      if (!isHpcScheduler(agent.schedulerType)) continue;
      totalHpcAgents += 1;
      const snapshot = snapshots.get(agent.agentId);
      if (snapshot?.queueInventoryV1) capabilityDeclared += 1;
      const rawStatus = queueInventoryStatus(snapshot?.status);
      const noGo = storedQueueInventoryNoGoState(snapshot);
      if (noGo.lastNoGoAt && (!lastNoGoAt || noGo.lastNoGoAt > lastNoGoAt)) {
        lastNoGoAt = noGo.lastNoGoAt;
      }
      if (noGo.active) activeNoGoAgents += 1;
      const lastSuccessfulObservedAt =
        snapshot?.lastSuccessfulObservedAt ??
        (rawStatus === "available" ? (snapshot?.observedAt ?? null) : null);
      const status = noGo.active
        ? "unavailable"
        : effectiveInventoryStatus(rawStatus, lastSuccessfulObservedAt, this.now(), this.options);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }

    return { totalHpcAgents, capabilityDeclared, activeNoGoAgents, lastNoGoAt, statusCounts };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function nextQueueInventoryNoGoState(
  previous: QueueInventorySnapshotRow | undefined,
  normalized: NormalizedQueueInventory,
  now: Date,
  options: QueueInventoryServiceOptions,
): QueueInventoryNoGoState {
  if (normalized.status !== "available") {
    return {
      lastNoGoAt: now,
      noGoReason: normalized.reason ?? "unknown",
      recoveryStartedAt: null,
      recoveredAt: null,
      active: true,
    };
  }

  const stored = storedQueueInventoryNoGoState(previous);
  if (!stored.active) return stored;
  const recoveryHoldMs = queueInventoryRecoveryHoldMs(options);
  const previousAttemptAt = previous?.lastAttemptAt ?? null;
  const attemptGapMs = previousAttemptAt
    ? now.getTime() - previousAttemptAt.getTime()
    : Number.POSITIVE_INFINITY;
  const continuousObservation =
    queueInventoryStatus(previous?.status) === "available" &&
    attemptGapMs >= 0 &&
    attemptGapMs <= queueInventoryMaxAgeMs(options);
  const recoveryStartedAt = continuousObservation ? (stored.recoveryStartedAt ?? now) : now;
  const recoveredAt =
    recoveryHoldMs === 0 ||
    (continuousObservation &&
      stored.recoveryStartedAt &&
      now.getTime() - stored.recoveryStartedAt.getTime() >= recoveryHoldMs)
      ? now
      : null;
  return {
    ...stored,
    recoveryStartedAt,
    recoveredAt,
    active: recoveredAt === null,
  };
}

function storedQueueInventoryNoGoState(
  snapshot: QueueInventorySnapshotRow | undefined,
): QueueInventoryNoGoState {
  if (!snapshot) {
    return {
      lastNoGoAt: null,
      noGoReason: null,
      recoveryStartedAt: null,
      recoveredAt: null,
      active: false,
    };
  }
  const rawStatus = queueInventoryStatus(snapshot.status);
  const lastNoGoAt =
    snapshot.lastNoGoAt ??
    (rawStatus !== "available" && rawStatus !== "unknown" ? snapshot.updatedAt : null);
  const noGoReason =
    queueInventoryReason(snapshot.noGoReason) ??
    (lastNoGoAt ? queueInventoryReason(snapshot.reason) : null);
  return {
    lastNoGoAt,
    noGoReason,
    recoveryStartedAt: snapshot.recoveryStartedAt,
    recoveredAt: snapshot.recoveredAt,
    active: lastNoGoAt !== null && snapshot.recoveredAt === null,
  };
}

function queueInventoryRecoveryHoldMs(options: QueueInventoryServiceOptions): number {
  const holdSec =
    options.recoveryHoldSec ?? 2 * (options.maxAgeSec ?? DEFAULT_QUEUE_INVENTORY_MAX_AGE_SEC);
  return Math.max(0, holdSec) * 1_000;
}

function queueInventoryMaxAgeMs(options: QueueInventoryServiceOptions): number {
  return Math.max(1, options.maxAgeSec ?? DEFAULT_QUEUE_INVENTORY_MAX_AGE_SEC) * 1_000;
}

export function isHpcScheduler(schedulerType: string): boolean {
  return schedulerType === "slurm" || schedulerType === "pbs-pro" || schedulerType === "torque";
}

function normalizeInventory(
  input: unknown,
  now: Date,
  options: QueueInventoryServiceOptions,
): NormalizedQueueInventory {
  const parsed = SchedulerQueueInventorySchema.safeParse(input);
  if (!parsed.success) {
    return failedInventory("unavailable", "invalid_output", now);
  }
  const observedAt = normalizeObservation(parsed.data.observedAt, now, options);
  if (!observedAt) {
    return failedInventory("stale", "stale", now);
  }
  const queues = parsed.data.queues.map((queue) => {
    const factObservedAt = normalizeObservation(queue.observedAt, now, options);
    return factObservedAt ? { ...queue, observedAt: factObservedAt } : null;
  });
  if (queues.some((queue) => queue === null)) {
    return failedInventory("stale", "stale", observedAt);
  }
  const currentQueues = queues.filter((queue): queue is SchedulerQueueFact => queue !== null);
  if (parsed.data.status !== "available") {
    return {
      ...failedInventory(
        parsed.data.status,
        canonicalInventoryReason(parsed.data.status, parsed.data.reason),
        observedAt,
      ),
      queues: currentQueues,
    };
  }
  const defaultQueueName =
    parsed.data.defaultQueueName ??
    currentQueues.find((queue) => queue.isDefault)?.queueName ??
    null;
  return {
    status: "available",
    reason: null,
    observedAt,
    defaultQueueName,
    queues: currentQueues,
    replaceFacts: true,
  };
}

function failedInventory(
  status: QueueInventoryStatus,
  reason: QueueInventoryReason,
  observedAt: Date,
): NormalizedQueueInventory {
  return {
    status,
    reason,
    observedAt,
    defaultQueueName: null,
    queues: [],
    replaceFacts: false,
  };
}

function normalizeObservation(
  observedAt: Date,
  now: Date,
  options: QueueInventoryServiceOptions,
): Date | null {
  const observedMs = observedAt.getTime();
  const maxAgeMs = queueInventoryMaxAgeMs(options);
  const maxFutureSkewMs =
    Math.max(0, options.maxFutureSkewSec ?? DEFAULT_QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC) * 1_000;
  if (
    !Number.isFinite(observedMs) ||
    observedMs > now.getTime() + maxFutureSkewMs ||
    now.getTime() - observedMs > maxAgeMs
  ) {
    return null;
  }
  return new Date(Math.min(observedMs, now.getTime()));
}

function effectiveInventoryStatus(
  status: QueueInventoryStatus,
  lastSuccessfulObservedAt: Date | null,
  now: Date,
  options: QueueInventoryServiceOptions,
): QueueInventoryStatus {
  if (status !== "available") return status;
  if (!lastSuccessfulObservedAt) return "unknown";
  return normalizeObservation(lastSuccessfulObservedAt, now, options) ? "available" : "stale";
}

function queueInventoryFreshUntil(
  lastSuccessfulObservedAt: Date,
  options: QueueInventoryServiceOptions,
): Date {
  const maxAgeMs = queueInventoryMaxAgeMs(options);
  return new Date(lastSuccessfulObservedAt.getTime() + maxAgeMs);
}

function latestObservedAt(
  rows: ReadonlyArray<typeof agentSchedulerQueues.$inferSelect>,
): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (!latest || row.observedAt.getTime() > latest.getTime()) latest = row.observedAt;
  }
  return latest;
}

function canonicalInventoryReason(
  status: QueueInventoryStatus,
  reason: string | undefined,
): QueueInventoryReason {
  if (status === "available") {
    return "unknown";
  }
  const parsed = QueueInventoryReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  if (status === "stale") return "stale";
  if (status === "unsupported") return "unsupported_scheduler";
  return "unknown";
}

function queueInventoryStatus(value: string | null | undefined): QueueInventoryStatus {
  const parsed = QueueInventoryStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function emptyInventoryStatusCounts(): Record<QueueInventoryStatus, number> {
  return Object.fromEntries(
    QueueInventoryStatusSchema.options.map((status) => [status, 0]),
  ) as Record<QueueInventoryStatus, number>;
}

function queueInventoryReason(value: string | null | undefined): QueueInventoryReason | null {
  if (value === null || value === undefined) return null;
  const parsed = QueueInventoryReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function toFact(row: typeof agentSchedulerQueues.$inferSelect): SchedulerQueueFact {
  const queueType = SchedulerQueueTypeSchema.safeParse(row.queueType);
  const state = SchedulerQueueStateSchema.safeParse(row.state);
  return {
    queueName: row.queueName,
    queueType: queueType.success ? queueType.data : "unknown",
    isDefault: row.isDefault,
    state: state.success ? state.data : "unknown",
    acceptsSubmissions: row.acceptsSubmissions,
    ...(row.hasComputeTargets === null ? {} : { hasComputeTargets: row.hasComputeTargets }),
    observedAt: row.observedAt,
  };
}

function unavailableTarget(
  inventory: AgentQueueInventory,
  reason: QueueAvailabilityReason,
  resolvedQueueName: string | null,
): QueueTargetAvailability {
  return {
    capabilityDeclared: inventory.queueInventoryV1,
    inventoryAvailable: true,
    targetAvailable: false,
    state: "unavailable",
    reason,
    observedAt: inventory.lastSuccessfulObservedAt,
    resolvedQueueName,
  };
}

export function queueUnavailable(message: string, reason: QueueAvailabilityReason): AppError {
  return new AppError(ErrorCode.QUEUE_UNAVAILABLE, message, 409, { reason });
}

export function queueInventoryUnavailable(
  message: string,
  reason: QueueAvailabilityReason,
): AppError {
  return new AppError(ErrorCode.QUEUE_INVENTORY_UNAVAILABLE, message, 503, {
    reason,
    retryable: true,
  });
}
