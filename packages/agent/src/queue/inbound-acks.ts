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

import { agentConfig, inboundDispatchPending, type SqliteDb } from "@kuintessence/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { type PreparedRemoteJob, preparedRemoteJobToJson } from "./active-remote-jobs";

export interface FederationRuntimeReceipt {
  owner: string;
  expiresAt: number;
  state: "active" | "stopping" | "finished";
}

export interface PersistInboundInput {
  /** Stable id of the DispatchJob delivery. Falls back to jobId when proto omits one. */
  dispatchId: string;
  /** The job-id this dispatch is about. */
  jobId: string;
  /** Diagnostics and, for federation dispatches, an immutable recovery fingerprint. */
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

  /** Survives cleanup-journal deletion: an ambiguous submission must never be replayed. */
  async markSubmissionStarted(
    dispatchId: string,
    prepared?: PreparedRemoteJob,
    runtime?: FederationRuntimeReceipt,
  ): Promise<void> {
    if (runtime) this.validateRuntimeExpiry(runtime.expiresAt);
    const submission = prepared ? JSON.stringify(preparedRemoteJobToJson(prepared)) : "null";
    const updated = await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationSubmissionStarted', json('true'), '$.federationSubmission', json(${submission}), '$.federationRuntime', json(${JSON.stringify(runtime ?? null)}))`,
      })
      .where(
        sql`${inboundDispatchPending.dispatchId} = ${dispatchId} AND ${inboundDispatchPending.ackedAt} IS NULL AND coalesce(json_extract(${inboundDispatchPending.payload}, '$.federationSubmissionStarted'), 0) = 0`,
      )
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    if (updated.length !== 1) throw new Error("Pending federation dispatch receipt is missing");
  }

  async get(dispatchId: string): Promise<PendingInboundRow | undefined> {
    return this.db
      .select()
      .from(inboundDispatchPending)
      .where(eq(inboundDispatchPending.dispatchId, dispatchId))
      .get();
  }

  /** Claim the original deadline, including acknowledged deliveries; never grant more time. */
  async claimRuntime(dispatchId: string): Promise<FederationRuntimeReceipt> {
    const row = await this.get(dispatchId);
    if (
      row?.payload.federationExecution !== true ||
      row.payload.federationSubmissionStarted !== true
    )
      throw new Error("Federation runtime receipt is missing");
    const raw = row.payload.federationRuntime;
    const previous = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const now = this.now().getTime();
    const expiresAt =
      typeof previous.expiresAt === "number" && Number.isSafeInteger(previous.expiresAt)
        ? previous.expiresAt
        : 0;
    const runtime: FederationRuntimeReceipt = {
      owner: crypto.randomUUID(),
      expiresAt,
      state:
        previous.state === "finished"
          ? "finished"
          : previous.state === "active" && expiresAt > now && expiresAt <= now + 30_000
            ? "active"
            : "stopping",
    };
    const updated = await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationRuntime', json(${JSON.stringify(runtime)}))`,
      })
      .where(
        and(
          eq(inboundDispatchPending.dispatchId, dispatchId),
          eq(inboundDispatchPending.payload, row.payload),
        ),
      )
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    if (updated.length !== 1) throw new Error("Federation runtime receipt changed during recovery");
    return runtime;
  }

  async renewRuntime(dispatchId: string, owner: string, expiresAt: number): Promise<void> {
    this.validateRuntimeExpiry(expiresAt);
    const updated = await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationRuntime.expiresAt', ${expiresAt})`,
      })
      .where(sql`${inboundDispatchPending.dispatchId} = ${dispatchId}
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.owner') = ${owner}
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.state') = 'active'
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.expiresAt') > ${this.now().getTime()}`)
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    if (updated.length !== 1)
      throw new Error("Federation runtime authority expired or was replaced");
  }

  /** Owner fencing also prevents an old timer or completion from changing a recovered job. */
  async setRuntimeState(
    dispatchId: string,
    owner: string,
    state: "stopping" | "finished",
  ): Promise<boolean> {
    const updated = await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationRuntime.state', ${state})`,
      })
      .where(sql`${inboundDispatchPending.dispatchId} = ${dispatchId}
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.owner') = ${owner}
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.state') != 'finished'`)
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    return updated.length === 1;
  }

  async runtimeStopCandidates(): Promise<PendingInboundRow[]> {
    return this.db
      .select()
      .from(inboundDispatchPending)
      .where(sql`
      json_extract(${inboundDispatchPending.payload}, '$.federationExecution') = 1
      AND json_extract(${inboundDispatchPending.payload}, '$.federationSubmissionStarted') = 1
      AND coalesce(json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.state'), '') != 'finished'
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntimeStop') IS NULL
    `)
      .orderBy(asc(inboundDispatchPending.id));
  }

  async latestForJob(jobId: string): Promise<PendingInboundRow | undefined> {
    return this.db
      .select()
      .from(inboundDispatchPending)
      .where(eq(inboundDispatchPending.jobId, jobId))
      .orderBy(desc(inboundDispatchPending.id))
      .limit(1)
      .get();
  }

  /** Compare the observed deadline atomically: a concurrent renewal wins or is fenced out. */
  async fenceRuntimeStop(row: PendingInboundRow): Promise<boolean> {
    const previous = row.payload.federationRuntime;
    const runtime =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous, state: "stopping" }
        : { owner: crypto.randomUUID(), expiresAt: 0, state: "stopping" };
    const updated = await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationRuntime', json(${JSON.stringify(runtime)}))`,
      })
      .where(
        and(
          eq(inboundDispatchPending.dispatchId, row.dispatchId),
          eq(inboundDispatchPending.payload, row.payload),
        ),
      )
      .returning({ dispatchId: inboundDispatchPending.dispatchId });
    return updated.length === 1;
  }

  async recordRuntimeStop(dispatchId: string, schedulerJobId: string): Promise<void> {
    await this.db
      .update(inboundDispatchPending)
      .set({
        payload: sql`json_set(${inboundDispatchPending.payload}, '$.federationRuntimeStop', json(${JSON.stringify({ schedulerJobId, confirmedAt: this.now().getTime() })}))`,
      })
      .where(sql`${inboundDispatchPending.dispatchId} = ${dispatchId}
      AND json_extract(${inboundDispatchPending.payload}, '$.federationRuntime.state') = 'stopping'`);
  }

  async hasConfirmedRuntimeStop(dispatchId: string, schedulerJobId: string): Promise<boolean> {
    const row = await this.get(dispatchId);
    const proof = row?.payload.federationRuntimeStop;
    return (
      row?.payload.federationExecution === true &&
      !!proof &&
      typeof proof === "object" &&
      "schedulerJobId" in proof &&
      proof.schedulerJobId === schedulerJobId &&
      "confirmedAt" in proof &&
      typeof proof.confirmedAt === "number" &&
      Number.isSafeInteger(proof.confirmedAt) &&
      proof.confirmedAt > 0
    );
  }

  async recordWatchdogHeartbeat(schedulerType: string): Promise<void> {
    const value = JSON.stringify({ schedulerType, observedAt: this.now().getTime() });
    await this.db
      .insert(agentConfig)
      .values({ key: "federation-watchdog-v1", value })
      .onConflictDoUpdate({ target: agentConfig.key, set: { value } });
  }

  async assertWatchdogReady(schedulerType: string): Promise<void> {
    const row = await this.db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.key, "federation-watchdog-v1"))
      .get();
    const state: unknown = row ? JSON.parse(row.value) : undefined;
    if (
      !state ||
      typeof state !== "object" ||
      !("schedulerType" in state) ||
      state.schedulerType !== schedulerType ||
      !("observedAt" in state) ||
      typeof state.observedAt !== "number" ||
      !Number.isSafeInteger(state.observedAt) ||
      this.now().getTime() < state.observedAt ||
      this.now().getTime() - state.observedAt > 2000
    )
      throw new Error("Independent federation scheduler watchdog is unavailable");
  }

  private validateRuntimeExpiry(expiresAt: number): void {
    const remaining = expiresAt - this.now().getTime();
    if (!Number.isSafeInteger(expiresAt) || remaining <= 0 || remaining > 30_000)
      throw new Error("Invalid federation runtime expiry");
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
