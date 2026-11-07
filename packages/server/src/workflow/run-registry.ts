import {
  federationOutbound,
  federationResultAttempts,
  federationResultImports,
  federationResultTransfers,
  jobCancellations,
  jobs,
  type PgDb,
  type PgTransaction,
  workflowExecutionDelegations,
  workflowExecutionJobs,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import {
  createLogger,
  type RoleName,
  type WorkflowExecutionInterrupted,
  WorkflowExecutionWaiting,
  type WorkflowPlacementConfig,
  type WorkflowRunGraph,
  type WorkflowRunRecordResult,
  type WorkflowRunStore,
} from "@kuintessence/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { LeasedWorkflowJournal } from "./execution-journal";

export type { WorkflowRunRecordResult } from "@kuintessence/shared";

const logger = createLogger("workflow-run-registry");

function pendingDelegations(runId: string, requireStopReceipt = false) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${workflowExecutionDelegations} AS wd
    JOIN ${federationOutbound} AS fo
      ON fo.local_site_id = wd.local_site_id AND fo.operation_id = wd.operation_id
    WHERE wd.run_id = ${runId} AND fo.cancel_state IS DISTINCT FROM 'stopped'
      ${requireStopReceipt ? sql`` : sql`AND coalesce(fo.status_report->'workflow'->>'status', '') <> 'completed'`}
  )`;
}

function pendingDelegationCopies(runId: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${workflowExecutionDelegations} AS wd
    JOIN ${federationOutbound} AS fo ON fo.local_site_id = wd.local_site_id AND fo.operation_id = wd.operation_id
    JOIN ${federationResultImports} AS fi ON fi.local_site_id = wd.local_site_id AND fi.operation_id = wd.operation_id
      AND fi.requested_by = fo.submitted_by AND fi.local_org_id = fo.local_org_id
    WHERE wd.run_id = ${runId} AND fi.state <> 'available'
      AND (fi.state <> 'cancelled' OR fi.reserved_bytes > 0 OR EXISTS (
        SELECT 1 FROM ${federationResultTransfers} AS ft
        JOIN ${federationResultAttempts} AS fa ON fa.transfer_id = ft.id
        WHERE ft.import_id = fi.id AND fa.state <> 'cleaned'
      ))
  )`;
}

export type WorkflowRunStatus =
  | "submitted"
  | "queued"
  | "awaiting_approval"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export function terminalStatusFromResult(result: WorkflowRunRecordResult): WorkflowRunStatus {
  const statuses = Object.values(result.status);
  if (statuses.includes("Failed")) return "failed";
  if (statuses.includes("Cancelled")) return "cancelled";
  return "completed";
}

function failedNodeSummary(result: WorkflowRunRecordResult): string | null {
  const failed = Object.entries(result.status).filter(([, status]) => status === "Failed");
  if (failed.length === 0) return null;
  const [first] = failed;
  if (!first) return null;
  const [nodeId] = first;
  const message = result.values[nodeId]?.failure?.message;
  const summary = message ? `${nodeId}: ${message}` : `${nodeId}: node execution failed`;
  return failed.length === 1 ? summary : `${summary} (${failed.length} failed nodes)`;
}

export interface WorkflowRunInput {
  executionModel?: "durable-v2";
  federationReservationId?: string;
  yaml: string;
  role: RoleName;
  orgId?: string | null;
  placementConfig?: WorkflowPlacementConfig;
}

export type WorkflowRunListStatus = "active" | "completed" | "failed" | "cancelled";

export interface WorkflowRunListOptions {
  limit: number;
  offset: number;
  submittedBy?: string;
  ids?: string[];
  status?: WorkflowRunListStatus;
  query?: string;
}

export interface WorkflowRunSummary {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
}

const ACTIVE_WORKFLOW_STATUSES: WorkflowRunStatus[] = [
  "submitted",
  "queued",
  "awaiting_approval",
  "running",
  "cancelling",
];

const LIST_STATUS_VALUES: Record<WorkflowRunListStatus, WorkflowRunStatus[]> = {
  active: ACTIVE_WORKFLOW_STATUSES,
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

function workflowRunListConditions(options: WorkflowRunListOptions, includeStatus: boolean): SQL[] {
  const conditions: SQL[] = [];
  if (options.submittedBy) conditions.push(eq(workflowRuns.submittedBy, options.submittedBy));
  if (options.ids) {
    conditions.push(options.ids.length > 0 ? inArray(workflowRuns.id, options.ids) : sql`false`);
  }
  if (options.query) {
    const pattern = `%${options.query}%`;
    conditions.push(
      or(
        ilike(workflowRuns.name, pattern),
        sql`${workflowRuns.id}::text ILIKE ${pattern}`,
        ilike(workflowRuns.status, pattern),
      ) ?? sql`false`,
    );
  }
  if (includeStatus && options.status) {
    conditions.push(inArray(workflowRuns.status, LIST_STATUS_VALUES[options.status]));
  }
  return conditions;
}

function workflowStatusBucket(status: string): WorkflowRunListStatus | null {
  if ((ACTIVE_WORKFLOW_STATUSES as string[]).includes(status)) return "active";
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  return null;
}

/**
 * Persistence for workflow runs against the workflow_runs table.
 *
 * Satisfies the shared {@link WorkflowRunStore} contract. Control-flow runs
 * can be created before execution via {@link createRun} and then finalized
 * by the in-process executor; list/detail reads back the persisted rows.
 */
export class WorkflowRunRegistry implements WorkflowRunStore {
  constructor(private db: PgDb) {}

  async createRun(
    name: string,
    submittedBy: string,
    graph: WorkflowRunGraph,
    input?: WorkflowRunInput,
    description: string | null = null,
    tx?: PgTransaction,
  ): Promise<string> {
    const now = new Date();
    const [row] = await (tx ?? this.db)
      .insert(workflowRuns)
      .values({
        name,
        description,
        submittedBy,
        status: "submitted",
        stepJobs: {},
        graph,
        input,
        submittedAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Failed to insert workflow_run row");
    if (!tx) logger.info({ runId: row.id, name }, "Workflow run submitted");
    return row.id;
  }

  /**
   * Persist a finished synchronous control-flow run for audit/listing.
   * Insert it already-terminal with the status derived from its node statuses
   * (any Failed -> failed; else any Cancelled -> cancelled; else completed) and
   * store the full per-node {status, values} in `result` and the node/edge
   * `graph` the run-detail view renders.
   */
  async recordRun(
    name: string,
    submittedBy: string,
    result: WorkflowRunRecordResult,
    graph: WorkflowRunGraph,
  ): Promise<string> {
    const status = terminalStatusFromResult(result);
    const errorMessage = failedNodeSummary(result);
    const [row] = await this.db
      .insert(workflowRuns)
      .values({
        name,
        description: null,
        submittedBy,
        status,
        stepJobs: {},
        result,
        graph,
        ...(errorMessage ? { errorCode: "WORKFLOW_NODE_FAILED", errorMessage } : {}),
      })
      .returning();
    if (!row) throw new Error("Failed to insert workflow_run row");
    logger.info({ runId: row.id, name, status }, "Workflow run recorded");
    return row.id;
  }

  async claimForExecution(runId: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .update(workflowRuns)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "queued")))
      .returning({ id: workflowRuns.id });
    return claimed.length === 1;
  }

  async queueAuthorizedRun(runId: string): Promise<boolean> {
    const now = new Date();
    const queued = await this.db
      .update(workflowRuns)
      .set({ status: "queued", queuedAt: now, updatedAt: now })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.status, "submitted"),
          sql`${workflowRuns.input}->>'federationReservationId' IS NULL`,
        ),
      )
      .returning({ id: workflowRuns.id });
    return queued.length === 1;
  }

  async completeRun(
    runId: string,
    result: WorkflowRunRecordResult,
    lease?: LeasedWorkflowJournal,
  ): Promise<boolean> {
    if (lease && lease.runId !== runId) throw new Error("Workflow lease belongs to another run");
    const write = async (db: PgTransaction) => {
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update");
      if (run?.status !== "running") return false;
      const invocations = await db
        .select({ jobId: workflowExecutionJobs.jobId })
        .from(workflowExecutionJobs)
        .where(eq(workflowExecutionJobs.runId, runId));
      const jobIds = [
        ...new Set([
          ...Object.values(run.stepJobs ?? {}),
          ...invocations.map(({ jobId }) => jobId),
        ]),
      ];
      // Serialize with revocation and installation creation, in Workflow -> Job lock order.
      if (jobIds.length)
        await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(inArray(jobs.id, jobIds))
          .orderBy(asc(jobs.id))
          .for("update");
      const pending = jobIds.length
        ? await db
            .select({ id: jobCancellations.id })
            .from(jobCancellations)
            .where(
              and(inArray(jobCancellations.jobId, jobIds), isNull(jobCancellations.acknowledgedAt)),
            )
            .limit(1)
        : [];
      const status = terminalStatusFromResult(result);
      const errorMessage = failedNodeSummary(result);
      const [remote] = await db
        .select({
          pending: sql<boolean>`(${pendingDelegations(runId)} OR ${pendingDelegationCopies(runId)})`,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId));
      const stopping = pending.length > 0 || remote?.pending === true;
      const finalized = await db
        .update(workflowRuns)
        .set({
          status: stopping ? "cancelling" : status,
          waitingInvocations: [],
          result,
          completedAt: stopping ? null : new Date(),
          ...(stopping ? { cancelRequestedAt: new Date() } : {}),
          updatedAt: new Date(),
          errorCode: errorMessage ? "WORKFLOW_NODE_FAILED" : null,
          errorMessage,
        })
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running")))
        .returning({ id: workflowRuns.id });
      if (finalized.length === 1 && !stopping)
        logger.info({ runId, status }, "Workflow run finalized");
      return finalized.length === 1 && !stopping;
    };
    return lease ? lease.transaction(write) : this.db.transaction(write);
  }

  async failRun(
    runId: string,
    err: unknown,
    errorCode = "WORKFLOW_EXECUTION_FAILED",
  ): Promise<boolean> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const pending = sql<boolean>`(${pendingDelegations(runId, true)} OR ${pendingDelegationCopies(runId)})`;
    const failed = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update");
      return tx
        .update(workflowRuns)
        .set({
          status: sql`CASE WHEN ${pending} THEN 'cancelling' ELSE 'failed' END`,
          waitingInvocations: [],
          errorCode,
          errorMessage,
          result: {
            status: { __run__: "Failed" },
            values: {
              __run__: {
                status: "Failed",
                values: { error: errorMessage },
              },
            },
          },
          completedAt: sql`CASE WHEN ${pending} THEN NULL ELSE now() END`,
          cancelRequestedAt: sql`CASE WHEN ${pending} THEN now() ELSE ${workflowRuns.cancelRequestedAt} END`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowRuns.id, runId),
            inArray(workflowRuns.status, ["submitted", "queued", "awaiting_approval", "running"]),
          ),
        )
        .returning({ id: workflowRuns.id, status: workflowRuns.status });
    });
    if (failed.length === 1)
      logger.error({ runId, err, status: failed[0]?.status }, "Workflow execution failed");
    return failed[0]?.status === "failed";
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = await this.getById(runId);
    const status =
      run?.result && terminalStatusFromResult(run.result) === "failed" ? "failed" : "cancelled";
    const cancelled = await this.db
      .update(workflowRuns)
      .set({
        status,
        waitingInvocations: [],
        errorCode: sql`CASE WHEN ${workflowRuns.errorCode} = 'WORKFLOW_WAITING' THEN NULL ELSE ${workflowRuns.errorCode} END`,
        errorMessage: sql`CASE WHEN ${workflowRuns.errorCode} = 'WORKFLOW_WAITING' THEN NULL ELSE ${workflowRuns.errorMessage} END`,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.status, "cancelling"),
          sql`NOT ${pendingDelegations(runId, true)}`,
          sql`NOT ${pendingDelegationCopies(runId)}`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (cancelled.length === 1) logger.info({ runId, status }, "Workflow cancellation completed");
    return cancelled.length === 1;
  }

  async requestCancel(
    runId: string,
    reason?: { code: string; message: string },
  ): Promise<WorkflowRunStatus | null> {
    const cancelling = await this.db
      .update(workflowRuns)
      .set({
        status: "cancelling",
        cancelRequestedAt: new Date(),
        updatedAt: new Date(),
        ...(reason ? { errorCode: reason.code, errorMessage: reason.message } : {}),
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          inArray(workflowRuns.status, ["submitted", "queued", "awaiting_approval", "running"]),
        ),
      )
      .returning({ id: workflowRuns.id });
    if (cancelling.length === 1) return "cancelling";
    const run = await this.getById(runId);
    return run ? (run.status as WorkflowRunStatus) : null;
  }

  async requestInterrupt(
    runId: string,
    errorMessage: string,
    lease?: LeasedWorkflowJournal,
  ): Promise<boolean> {
    if (lease && lease.runId !== runId) throw new Error("Workflow lease belongs to another run");
    const write = async (db: PgDb | PgTransaction) => {
      const interrupted = await db
        .update(workflowRuns)
        .set({
          status: "cancelling",
          errorCode: "WORKFLOW_INTERRUPTED",
          errorMessage,
          cancelRequestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running")))
        .returning({ id: workflowRuns.id });
      return interrupted.length === 1;
    };
    return lease ? lease.transaction(write) : write(this.db);
  }

  async failInterruptedRun(runId: string): Promise<boolean> {
    const run = await this.getById(runId);
    const errorMessage = run?.errorMessage ?? "workflow interrupted while Server was unavailable";
    const failed = await this.db
      .update(workflowRuns)
      .set({
        status: "failed",
        waitingInvocations: [],
        result: {
          status: { __run__: "Failed" },
          values: {
            __run__: {
              status: "Failed",
              values: { error: errorMessage },
            },
          },
        },
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.status, "cancelling"),
          eq(workflowRuns.errorCode, "WORKFLOW_INTERRUPTED"),
          sql`NOT ${pendingDelegations(runId, true)}`,
          sql`NOT ${pendingDelegationCopies(runId)}`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (failed.length === 1) logger.error({ runId }, "Interrupted workflow cleanup completed");
    return failed.length === 1;
  }

  async listRecoverableRuns(limit = 100) {
    return this.db
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ACTIVE_WORKFLOW_STATUSES))
      .limit(limit);
  }

  async listRunnableDurableRuns(limit = 100) {
    const rows = await this.db
      .select({ run: workflowRuns })
      .from(workflowRuns)
      .leftJoin(workflowExecutionLeases, eq(workflowExecutionLeases.runId, workflowRuns.id))
      .where(
        and(
          sql`${workflowRuns.input}->>'executionModel' = 'durable-v2'`,
          inArray(workflowRuns.status, ["queued", "running", "cancelling"]),
          or(
            eq(workflowRuns.status, "cancelling"),
            and(
              or(
                isNull(workflowRuns.errorCode),
                ne(workflowRuns.errorCode, "WORKFLOW_RECONCILING"),
              ),
              or(
                isNull(workflowExecutionLeases.token),
                lte(workflowExecutionLeases.expiresAt, sql`clock_timestamp()`),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(workflowRuns.updatedAt), asc(workflowRuns.id))
      .limit(limit);
    return rows.map((row) => row.run);
  }

  async recordInterruption(
    runId: string,
    error: WorkflowExecutionInterrupted,
    lease: LeasedWorkflowJournal,
  ): Promise<void> {
    if (lease.runId !== runId) throw new Error("Workflow lease belongs to another run");
    if (
      error instanceof WorkflowExecutionWaiting &&
      Buffer.byteLength(JSON.stringify(error.invocations)) > 8 * 1024 * 1024
    )
      throw new Error("Workflow waiting snapshot exceeds 8 MiB");
    await lease.transaction(async (tx) => {
      await tx
        .update(workflowRuns)
        .set({
          errorCode:
            error instanceof WorkflowExecutionWaiting
              ? "WORKFLOW_WAITING"
              : error.retryable
                ? "WORKFLOW_RECOVERY_PENDING"
                : "WORKFLOW_RECONCILING",
          waitingInvocations: error instanceof WorkflowExecutionWaiting ? error.invocations : [],
          errorMessage: error.message,
          updatedAt: new Date(),
        })
        .where(eq(workflowRuns.id, runId));
    });
  }

  async listJobIds(runId: string): Promise<string[]> {
    const [run, invocations] = await Promise.all([
      this.getById(runId),
      this.db
        .select({ jobId: workflowExecutionJobs.jobId })
        .from(workflowExecutionJobs)
        .where(eq(workflowExecutionJobs.runId, runId)),
    ]);
    return [
      ...new Set([...Object.values(run?.stepJobs ?? {}), ...invocations.map((row) => row.jobId)]),
    ];
  }

  async recordStepJob(runId: string, nodeId: string, jobId: string): Promise<boolean> {
    const recorded = await this.db
      .update(workflowRuns)
      .set({
        stepJobs: sql`coalesce(${workflowRuns.stepJobs}, '{}'::jsonb) || ${JSON.stringify({
          [nodeId]: jobId,
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running")))
      .returning({ id: workflowRuns.id });
    return recorded.length === 1;
  }

  async listPage(options: WorkflowRunListOptions) {
    const baseConditions = workflowRunListConditions(options, false);
    const pageConditions = workflowRunListConditions(options, true);
    const whereBase = baseConditions.length > 0 ? and(...baseConditions) : undefined;
    const wherePage = pageConditions.length > 0 ? and(...pageConditions) : undefined;

    const [runs, totalRows, summaryRows] = await Promise.all([
      this.db
        .select()
        .from(workflowRuns)
        .where(wherePage)
        .orderBy(desc(workflowRuns.submittedAt), desc(workflowRuns.id))
        .limit(options.limit)
        .offset(options.offset),
      this.db.select({ value: count() }).from(workflowRuns).where(wherePage),
      this.db
        .select({ status: workflowRuns.status, value: count() })
        .from(workflowRuns)
        .where(whereBase)
        .groupBy(workflowRuns.status),
    ]);

    const summary: WorkflowRunSummary = {
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of summaryRows) {
      const bucket = workflowStatusBucket(row.status);
      if (bucket) summary[bucket] += row.value;
    }
    return {
      runs,
      total: totalRows[0]?.value ?? 0,
      summary,
    };
  }

  /**
   * Get a single workflow run by UUID. Returns null if not found.
   */
  async getById(runId: string) {
    const [row] = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return row ?? null;
  }
}
