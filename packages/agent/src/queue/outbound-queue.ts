// ---------------------------------------------------------------------------
// OutboundQueue — durable spillover for AgentStream while the Server is offline.
// ---------------------------------------------------------------------------
//
// Contract
// --------
// The Agent talks to the Server over a single bidirectional connectRPC stream.
// While that stream is alive, outbound messages (job status updates,
// software operation results, and heartbeat snapshots) flow through the
// in-memory generator in `stream.ts`.
//
// When the stream is down (network blip, Server restart, mTLS rotation, etc.)
// the AgentStream pushes outbound state into this queue instead. On the next
// successful reconnect, the queue is drained — strictly in `created_at`
// order, ties broken by SQLite auto-increment `id` — before any new live
// traffic is sent. The Server's job-service treats duplicate JobStatusUpdates
// idempotently (see `packages/server/src/services/job-service.ts`), so replays
// are safe even if the Agent crashed mid-drain.
//
// Heartbeat compaction
// --------------------
// `outbound_heartbeat` is bounded by `maxQueuedHeartbeats` (default
// {@link DEFAULT_MAX_QUEUED_HEARTBEATS}). On each `enqueueHeartbeat`, rows
// older than the most recent N are deleted in the same logical operation —
// this keeps a long disconnect from accumulating arbitrarily many stale CPU
// samples that would flood the Server on reconnect. Job-status rows and software
// operation result rows are NOT compacted: every state transition is durable.
//
// What lives here
//   - `enqueueJobStatus(report)`              - persist a JobStatusReport
//   - `enqueueSoftwareOperationResult(item)`  - persist a Spack operation
//                                               result for replay
//   - `enqueueHeartbeat(snapshot)`            - persist a Heartbeat snapshot,
//                                               then compact heartbeats
//   - `pendingCount()`                        - total queued items (drives the
//                                               Heartbeat.queuedJobs field)
//   - `loadForReplay()`                       - replay queued items in order
//                                               with explicit acknowledgers.
//
// What does NOT live here
//   - Server-side replay handling (Server already idempotent — no work needed).
//   - Inbound dispatch ack persistence — see `inbound-acks.ts`. That class
//     owns `inbound_dispatch_pending`, persists every received DispatchJob
//     before it's handed to the runner, and replays a synthesized status
//     report on reconnect for any row whose `acked_at` is still NULL.
//   - mTLS / WebSocket / OIDC concerns are outside this queue's scope.
// ---------------------------------------------------------------------------

import {
  outboundHeartbeat,
  outboundJobStatus,
  outboundQueueValidationShadowRejection,
  outboundSoftwareOperationResult,
  type SqliteDb,
} from "@kuintessence/db";
import type { SoftwareOperationAction, SoftwareOperationStatus } from "@kuintessence/proto";
import type { InstalledSpec, QueueFailureCode } from "@kuintessence/shared";
import { asc, eq, sql } from "drizzle-orm";
import type { JobStatusReport } from "../embedded/job-executor";

/** Default cap for `outbound_heartbeat` rows kept on disk during a disconnect. */
export const DEFAULT_MAX_QUEUED_HEARTBEATS = 50;

/**
 * Subset of the proto Heartbeat message that the Agent can produce locally.
 * We persist plain numbers (BigInt is not JSON-safe) and convert to BigInt
 * at the proto boundary.
 */
export interface HeartbeatSnapshot {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  runningJobs: number;
  queuedJobs: number;
}

/**
 * Tagged-union of items the queue can replay. Kept structurally identical
 * to the in-memory union in `stream.ts` so the same `send` callback works
 * for both live and replayed traffic.
 */
export type OutboundItem =
  | { kind: "jobStatus"; eventId: string; report: JobStatusReport }
  | {
      kind: "queueValidationShadowRejection";
      eventId: string;
      failureCode: QueueFailureCode;
    }
  | { kind: "heartbeat"; snapshot: HeartbeatSnapshot }
  | {
      kind: "softwareOperationResult";
      operationId: string;
      action: SoftwareOperationAction;
      status: SoftwareOperationStatus;
      spec: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
      installed?: InstalledSpec[];
    };

export interface ReplayableOutboundItem {
  item: OutboundItem;
  acknowledge: () => Promise<void>;
}

export interface OutboundQueueOptions {
  /** Injected wall clock — tests use this for deterministic ordering. */
  now?: () => Date;
  /** Injected event-id generator for deterministic tests. */
  createEventId?: () => string;
  /**
   * Cap on the number of heartbeat snapshots retained in `outbound_heartbeat`.
   * Defaults to {@link DEFAULT_MAX_QUEUED_HEARTBEATS}. After this many rows,
   * each new `enqueueHeartbeat` deletes the oldest excess rows so the table
   * does not grow unbounded across long disconnects. Set to 0 to disable
   * heartbeat persistence entirely.
   */
  maxQueuedHeartbeats?: number;
}

export class OutboundQueue {
  private readonly now: () => Date;
  private readonly createEventId: () => string;
  private readonly maxQueuedHeartbeats: number;

  constructor(
    private readonly db: SqliteDb,
    opts: OutboundQueueOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.createEventId = opts.createEventId ?? (() => crypto.randomUUID());
    this.maxQueuedHeartbeats = opts.maxQueuedHeartbeats ?? DEFAULT_MAX_QUEUED_HEARTBEATS;
  }

  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  async enqueueJobStatus(report: JobStatusReport): Promise<ReplayableOutboundItem> {
    const eventId = this.createEventId();
    const payload = reportToPayload(report, eventId);
    const createdAt = this.now();
    const inserted = await this.db
      .insert(outboundJobStatus)
      .values({ jobId: report.jobId, payload, createdAt })
      .returning({ id: outboundJobStatus.id });
    const row = inserted[0];
    if (!row) throw new Error("Failed to persist outbound job status");
    return {
      item: { kind: "jobStatus", eventId, report },
      acknowledge: () => this.deleteRow({ kind: "jobStatus", id: row.id, createdAt, payload }),
    };
  }

  async acknowledgeJobStatus(eventId: string): Promise<boolean> {
    const rows = await this.db.select().from(outboundJobStatus);
    const match = rows.find(
      (row) => eventIdFromPayload(row.payload, row.id, row.jobId) === eventId,
    );
    if (!match) return false;
    await this.db.delete(outboundJobStatus).where(eq(outboundJobStatus.id, match.id));
    return true;
  }

  async enqueueQueueValidationShadowRejection(
    failureCode: QueueFailureCode,
    eventId = this.createEventId(),
  ): Promise<ReplayableOutboundItem> {
    const createdAt = this.now();
    const inserted = await this.db
      .insert(outboundQueueValidationShadowRejection)
      .values({ eventId, failureCode, createdAt })
      .onConflictDoNothing({ target: outboundQueueValidationShadowRejection.eventId })
      .returning({ id: outboundQueueValidationShadowRejection.id });
    const [existing] = inserted[0]
      ? []
      : await this.db
          .select()
          .from(outboundQueueValidationShadowRejection)
          .where(eq(outboundQueueValidationShadowRejection.eventId, eventId))
          .limit(1);
    const row = inserted[0] ?? existing;
    if (!row) throw new Error("Failed to persist queue validation shadow rejection");
    if ("failureCode" in row && row.failureCode !== failureCode) {
      throw new Error(
        "Queue validation shadow rejection event id already has another failure code",
      );
    }
    return {
      item: { kind: "queueValidationShadowRejection", eventId, failureCode },
      acknowledge: () =>
        this.deleteRow({
          kind: "queueValidationShadowRejection",
          id: row.id,
          createdAt,
          payload: { eventId, failureCode },
        }),
    };
  }

  async acknowledgeQueueValidationShadowRejection(eventId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(outboundQueueValidationShadowRejection)
      .where(eq(outboundQueueValidationShadowRejection.eventId, eventId))
      .returning({ eventId: outboundQueueValidationShadowRejection.eventId });
    return deleted.length > 0;
  }

  async enqueueHeartbeat(snapshot: HeartbeatSnapshot): Promise<void> {
    // When the cap is 0, persistence is disabled outright — skip the insert
    // entirely so we don't flap rows in/out of the table.
    if (this.maxQueuedHeartbeats <= 0) return;

    await this.db.insert(outboundHeartbeat).values({
      payload: snapshotToPayload(snapshot),
      createdAt: this.now(),
    });

    // Compact in the same logical operation. We avoid a transaction because
    // bun:sqlite doesn't expose drizzle transactions for the async driver
    // here — the worst case under crash/interleave is a brief over-cap state,
    // self-corrected by the next enqueue. The cap is a soft bound, not a
    // safety property.
    await this.compactHeartbeats();
  }

  async enqueueSoftwareOperationResult(
    item: Omit<Extract<OutboundItem, { kind: "softwareOperationResult" }>, "kind">,
  ): Promise<void> {
    await this.db.insert(outboundSoftwareOperationResult).values({
      operationId: item.operationId,
      payload: softwareOperationResultToPayload(item),
      createdAt: this.now(),
    });
  }

  /**
   * Delete the oldest `outbound_heartbeat` rows so the table contains at most
   * `maxQueuedHeartbeats` rows. Survivors are the most recent N by
   * `(created_at desc, id desc)` — same total ordering used by the drain.
   */
  private async compactHeartbeats(): Promise<void> {
    const cap = this.maxQueuedHeartbeats;
    // Subquery selecting the IDs of the rows to KEEP (most recent `cap`).
    // Then delete every row whose id is not in that set. Single SQL statement
    // so the work is atomic at the SQLite level.
    await this.db.run(sql`
      DELETE FROM outbound_heartbeat
      WHERE id NOT IN (
        SELECT id FROM outbound_heartbeat
        ORDER BY created_at DESC, id DESC
        LIMIT ${cap}
      )
    `);
  }

  // -------------------------------------------------------------------------
  // Inspect
  // -------------------------------------------------------------------------

  async pendingCount(): Promise<number> {
    const status = await this.db.select().from(outboundJobStatus);
    const queueRejections = await this.db.select().from(outboundQueueValidationShadowRejection);
    const hb = await this.db.select().from(outboundHeartbeat);
    const software = await this.db.select().from(outboundSoftwareOperationResult);
    return status.length + queueRejections.length + hb.length + software.length;
  }

  // -------------------------------------------------------------------------
  // Drain
  // -------------------------------------------------------------------------

  /**
   * Load queued items with explicit acknowledgers for async-generator replay.
   * The caller must invoke `acknowledge()` only after the item has actually
   * been yielded to the transport. If the stream closes during `yield`, the
   * ack is skipped and the row remains durable for the next reconnect.
   */
  async loadForReplay(): Promise<ReplayableOutboundItem[]> {
    const merged = await this.loadOrdered();
    return merged.map((row) => ({
      item: rowToItem(row),
      acknowledge: () => this.deleteRow(row),
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadOrdered(): Promise<MergedRow[]> {
    const statusRows = await this.db
      .select()
      .from(outboundJobStatus)
      .orderBy(asc(outboundJobStatus.createdAt), asc(outboundJobStatus.id));
    const heartbeatRows = await this.db
      .select()
      .from(outboundHeartbeat)
      .orderBy(asc(outboundHeartbeat.createdAt), asc(outboundHeartbeat.id));
    const queueRejectionRows = await this.db
      .select()
      .from(outboundQueueValidationShadowRejection)
      .orderBy(
        asc(outboundQueueValidationShadowRejection.createdAt),
        asc(outboundQueueValidationShadowRejection.id),
      );
    const softwareRows = await this.db
      .select()
      .from(outboundSoftwareOperationResult)
      .orderBy(
        asc(outboundSoftwareOperationResult.createdAt),
        asc(outboundSoftwareOperationResult.id),
      );

    const merged: MergedRow[] = [
      ...statusRows.map(
        (r): MergedRow => ({
          kind: "jobStatus",
          id: r.id,
          createdAt: r.createdAt,
          payload: r.payload,
        }),
      ),
      ...heartbeatRows.map(
        (r): MergedRow => ({
          kind: "heartbeat",
          id: r.id,
          createdAt: r.createdAt,
          payload: r.payload,
        }),
      ),
      ...queueRejectionRows.map(
        (r): MergedRow => ({
          kind: "queueValidationShadowRejection",
          id: r.id,
          createdAt: r.createdAt,
          payload: { eventId: r.eventId, failureCode: r.failureCode },
        }),
      ),
      ...softwareRows.map(
        (r): MergedRow => ({
          kind: "softwareOperationResult",
          id: r.id,
          createdAt: r.createdAt,
          payload: r.payload,
        }),
      ),
    ];

    // Stable order: createdAt asc, then id asc (within the same kind).
    // For cross-kind ties on createdAt, the original within-kind id ordering
    // is preserved by JS Array.sort stability.
    merged.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return merged;
  }

  private async deleteRow(row: MergedRow): Promise<void> {
    if (row.kind === "jobStatus") {
      await this.db.delete(outboundJobStatus).where(eq(outboundJobStatus.id, row.id));
    } else if (row.kind === "queueValidationShadowRejection") {
      await this.db
        .delete(outboundQueueValidationShadowRejection)
        .where(eq(outboundQueueValidationShadowRejection.id, row.id));
    } else if (row.kind === "heartbeat") {
      await this.db.delete(outboundHeartbeat).where(eq(outboundHeartbeat.id, row.id));
    } else {
      await this.db
        .delete(outboundSoftwareOperationResult)
        .where(eq(outboundSoftwareOperationResult.id, row.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — payload <-> typed
// ---------------------------------------------------------------------------

interface MergedRow {
  kind: "jobStatus" | "queueValidationShadowRejection" | "heartbeat" | "softwareOperationResult";
  id: number;
  createdAt: Date;
  payload: Record<string, unknown>;
}

function reportToPayload(report: JobStatusReport, eventId: string): Record<string, unknown> {
  return {
    eventId,
    jobId: report.jobId,
    status: report.status,
    schedulerJobId: report.schedulerJobId,
    exitCode: report.exitCode,
    message: report.message,
    failureCode: report.failureCode,
    node: report.node,
    reason: report.reason,
    collected: report.collected,
    workingDir: report.workingDir,
  };
}

function snapshotToPayload(s: HeartbeatSnapshot): Record<string, unknown> {
  return {
    cpuUsagePercent: s.cpuUsagePercent,
    memoryUsedMb: s.memoryUsedMb,
    memoryTotalMb: s.memoryTotalMb,
    runningJobs: s.runningJobs,
    queuedJobs: s.queuedJobs,
  };
}

function softwareOperationResultToPayload(
  item: Omit<Extract<OutboundItem, { kind: "softwareOperationResult" }>, "kind">,
): Record<string, unknown> {
  return {
    operationId: item.operationId,
    action: item.action,
    status: item.status,
    spec: item.spec,
    stdout: item.stdout,
    stderr: item.stderr,
    exitCode: item.exitCode,
    error: item.error,
    installed: item.installed,
  };
}

function rowToItem(row: MergedRow): OutboundItem {
  if (row.kind === "jobStatus") {
    const p = row.payload as Partial<JobStatusReport> & { jobId: string; status: string };
    return {
      kind: "jobStatus",
      eventId: eventIdFromPayload(row.payload, row.id, p.jobId),
      report: stripUndefined({
        jobId: p.jobId,
        status: p.status as JobStatusReport["status"],
        schedulerJobId: p.schedulerJobId,
        exitCode: p.exitCode,
        message: p.message,
        failureCode: p.failureCode,
        node: p.node,
        reason: p.reason,
        collected: p.collected,
        workingDir: p.workingDir,
      }),
    };
  }
  if (row.kind === "queueValidationShadowRejection") {
    return {
      kind: "queueValidationShadowRejection",
      eventId: String(row.payload.eventId),
      failureCode: String(row.payload.failureCode) as QueueFailureCode,
    };
  }
  if (row.kind === "softwareOperationResult") {
    const p = row.payload as Partial<Extract<OutboundItem, { kind: "softwareOperationResult" }>> & {
      operationId: string;
      action: SoftwareOperationAction;
      status: SoftwareOperationStatus;
      spec: string;
    };
    return stripSoftwareUndefined({
      kind: "softwareOperationResult",
      operationId: p.operationId,
      action: p.action,
      status: p.status,
      spec: p.spec,
      stdout: p.stdout,
      stderr: p.stderr,
      exitCode: p.exitCode,
      error: p.error,
      installed: p.installed,
    });
  }
  const p = row.payload as unknown as HeartbeatSnapshot;
  return {
    kind: "heartbeat",
    snapshot: {
      cpuUsagePercent: p.cpuUsagePercent,
      memoryUsedMb: p.memoryUsedMb,
      memoryTotalMb: p.memoryTotalMb,
      runningJobs: p.runningJobs,
      queuedJobs: p.queuedJobs,
    },
  };
}

function eventIdFromPayload(
  payload: Record<string, unknown>,
  rowId: number,
  jobId: string,
): string {
  return typeof payload.eventId === "string" && payload.eventId.length > 0
    ? payload.eventId
    : `legacy-job-status-${rowId}-${jobId}`;
}

/**
 * SQLite stores `undefined` field values as JSON nulls, which then come back
 * as explicit `undefined` keys. We strip those so equality checks against
 * the original `JobStatusReport` are clean (no surprise `key: undefined`).
 */
function stripUndefined(report: JobStatusReport): JobStatusReport {
  const out: JobStatusReport = { jobId: report.jobId, status: report.status };
  if (report.schedulerJobId !== undefined) out.schedulerJobId = report.schedulerJobId;
  if (report.exitCode !== undefined) out.exitCode = report.exitCode;
  if (report.message !== undefined) out.message = report.message;
  if (report.failureCode !== undefined) out.failureCode = report.failureCode;
  if (report.node !== undefined) out.node = report.node;
  if (report.reason !== undefined) out.reason = report.reason;
  if (report.collected !== undefined) out.collected = report.collected;
  if (report.workingDir !== undefined) out.workingDir = report.workingDir;
  return out;
}

function stripSoftwareUndefined(
  item: Extract<OutboundItem, { kind: "softwareOperationResult" }>,
): Extract<OutboundItem, { kind: "softwareOperationResult" }> {
  const out: Extract<OutboundItem, { kind: "softwareOperationResult" }> = {
    kind: "softwareOperationResult",
    operationId: item.operationId,
    action: item.action,
    status: item.status,
    spec: item.spec,
  };
  if (item.stdout !== undefined) out.stdout = item.stdout;
  if (item.stderr !== undefined) out.stderr = item.stderr;
  if (item.exitCode !== undefined) out.exitCode = item.exitCode;
  if (item.error !== undefined) out.error = item.error;
  if (item.installed !== undefined) out.installed = item.installed;
  return out;
}
