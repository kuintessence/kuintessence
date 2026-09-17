import { type PgDb, workflowRuns } from "@kuintessence/db";
import {
  createLogger,
  type RoleName,
  type WorkflowPlacementConfig,
  type WorkflowRunGraph,
  type WorkflowRunRecordResult,
  type WorkflowRunStore,
} from "@kuintessence/shared";
import { and, count, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";

export type { WorkflowRunRecordResult } from "@kuintessence/shared";

const logger = createLogger("workflow-run-registry");

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
  ): Promise<string> {
    const now = new Date();
    const [row] = await this.db
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
    logger.info({ runId: row.id, name }, "Workflow run submitted");
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
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "submitted")))
      .returning({ id: workflowRuns.id });
    return queued.length === 1;
  }

  async completeRun(runId: string, result: WorkflowRunRecordResult): Promise<boolean> {
    const status = terminalStatusFromResult(result);
    const errorMessage = failedNodeSummary(result);
    const finalized = await this.db
      .update(workflowRuns)
      .set({
        status,
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
        ...(errorMessage ? { errorCode: "WORKFLOW_NODE_FAILED", errorMessage } : {}),
      })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running")))
      .returning({ id: workflowRuns.id });
    if (finalized.length === 1) logger.info({ runId, status }, "Workflow run finalized");
    return finalized.length === 1;
  }

  async failRun(
    runId: string,
    err: unknown,
    errorCode = "WORKFLOW_EXECUTION_FAILED",
  ): Promise<boolean> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failed = await this.db
      .update(workflowRuns)
      .set({
        status: "failed",
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
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          inArray(workflowRuns.status, ["submitted", "queued", "awaiting_approval", "running"]),
        ),
      )
      .returning({ id: workflowRuns.id });
    if (failed.length === 1) logger.error({ runId, err }, "Workflow run failed");
    return failed.length === 1;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const cancelled = await this.db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "cancelling")))
      .returning({ id: workflowRuns.id });
    if (cancelled.length === 1) logger.info({ runId }, "Workflow run cancelled");
    return cancelled.length === 1;
  }

  async requestCancel(runId: string): Promise<WorkflowRunStatus | null> {
    const cancelling = await this.db
      .update(workflowRuns)
      .set({ status: "cancelling", cancelRequestedAt: new Date(), updatedAt: new Date() })
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

  async requestInterrupt(runId: string, errorMessage: string): Promise<boolean> {
    const interrupted = await this.db
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
  }

  async failInterruptedRun(runId: string): Promise<boolean> {
    const run = await this.getById(runId);
    const errorMessage = run?.errorMessage ?? "workflow interrupted while Server was unavailable";
    const failed = await this.db
      .update(workflowRuns)
      .set({
        status: "failed",
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
