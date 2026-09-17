// ---------------------------------------------------------------------------
// InboundAcks — durable record of received DispatchJob deliveries that have
// not yet been acknowledged with a JobStatusReport.
// ---------------------------------------------------------------------------
//
// Why this exists
// ---------------
// The Server-Agent stream is bidirectional. A typical successful dispatch is:
//
//     Server --DispatchJob----> Agent
//     Agent --[runs, then]--> JobStatusReport(running) --> Server
//
// If the connection drops AFTER the Agent received the DispatchJob but
// BEFORE the Agent's first JobStatusReport went out on the wire, the Server
// has no evidence the Agent actually picked the job up. On reconnect the
// Server re-dispatches and the job runs twice.
//
// InboundAcks closes that hole by persisting a row the moment a dispatch
// is received (BEFORE handing it to the runner), then marking it acked
// once the runner has produced its first status update — whichever it is
// (queued, running, failed, completed). On reconnect, AgentStream queries
// `pendingInbound()` and replays an idempotent JobStatusReport for each
// row. The Server's job-service is idempotent on `(jobId, status)` so safe
// re-delivery is the contract.
//
// Boundary
// --------
// This class only owns the `inbound_dispatch_pending` table. It does not
// know about the proto wire format or the runner — replay synthesis lives
// in `stream.ts` so it can choose the right status for the current local
// runner state.
// ---------------------------------------------------------------------------

import { inboundDispatchPending, type SqliteDb } from "@kuintessence/db";
import { asc, eq, isNull, sql } from "drizzle-orm";

export interface PersistInboundInput {
  /** Stable id of the DispatchJob delivery. Falls back to jobId when proto omits one. */
  dispatchId: string;
  /** The job-id this dispatch is about. */
  jobId: string;
  /** Original DispatchJob payload, persisted for diagnostics and (future) restart replay. */
  payload: Record<string, unknown>;
}

export interface PendingInboundRow {
  dispatchId: string;
  jobId: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
  ackedAt: Date | null;
}

export interface InboundAcksOptions {
  /** Injected wall clock — tests use this for deterministic ordering. */
  now?: () => Date;
}

export class InboundAcks {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqliteDb,
    opts: InboundAcksOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Record that a DispatchJob was received. MUST be called BEFORE the runner
   * is started so a crash between receive and runner-start cannot lose the
   * record.
   *
   * Idempotent on `dispatchId` — a duplicate delivery (Server re-dispatch after
   * a partial drop) is silently ignored so the dispatch handler can stay a
   * single straight-line path.
   */
  async persistInbound(input: PersistInboundInput): Promise<boolean> {
    const inserted = await this.db
      .insert(inboundDispatchPending)
      .values({
        dispatchId: input.dispatchId,
        jobId: input.jobId,
        payload: input.payload,
        receivedAt: this.now(),
        // ackedAt is left null — not setting it explicitly keeps the row
        // pending until markAcked() is called.
      })
      .onConflictDoNothing({ target: inboundDispatchPending.dispatchId })
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    return inserted.length > 0;
  }

  /**
   * Mark a previously-persisted dispatch as acked. Called when the runner
   * has emitted its first status update (queued / running / failed). The
   * `acked_at IS NULL` guard makes this idempotent — calling twice on the
   * same dispatchId or on an unknown dispatchId is a no-op.
   */
  async markAcked(dispatchId: string): Promise<void> {
    await this.db.update(inboundDispatchPending).set({ ackedAt: this.now() }).where(
      // Only update rows that are still pending — protects a crash-replay
      // path from clobbering an earlier acked_at timestamp with a later one.
      sql`${inboundDispatchPending.dispatchId} = ${dispatchId} AND ${inboundDispatchPending.ackedAt} IS NULL`,
    );
  }

  /**
   * List every dispatch that is still pending an ack, in receivedAt asc
   * order (ties broken by id). Used by AgentStream on reconnect to decide
   * which jobs need a replayed status update.
   */
  async pendingInbound(): Promise<PendingInboundRow[]> {
    const rows = await this.db
      .select()
      .from(inboundDispatchPending)
      .where(isNull(inboundDispatchPending.ackedAt))
      .orderBy(asc(inboundDispatchPending.receivedAt), asc(inboundDispatchPending.id));

    return rows.map((r) => ({
      dispatchId: r.dispatchId,
      jobId: r.jobId,
      payload: r.payload,
      receivedAt: r.receivedAt,
      ackedAt: r.ackedAt ?? null,
    }));
  }
}

/** Re-export `eq` for callers that want to compose more complex queries
 * (kept here so consumers don't pull a second drizzle import). */
export { eq as inboundDispatchEq };
