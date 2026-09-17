import { randomUUID } from "node:crypto";
import { localWorkflowRuns, type SqliteDb } from "@kuintessence/db";
import type {
  StepJobs,
  WorkflowRunGraph,
  WorkflowRunRecordResult,
  WorkflowRunStore,
} from "@kuintessence/shared";
import { desc, eq } from "drizzle-orm";

/** Node statuses that count as a failure when deriving a terminal run status. */
const FAILURE_STATUSES: ReadonlySet<string> = new Set(["failed", "error", "cancelled", "canceled"]);

/** Default page size for {@link WorkflowRunReader.listRuns}. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * Decoded view of a `local_workflow_runs` row: the JSON `step_jobs` / `result`
 * columns are parsed into typed values. `result` is null while a run is active.
 */
export interface LocalWorkflowRunRecord {
  runId: string;
  name: string;
  description: string | null;
  submittedBy: string;
  status: string;
  stepJobs: StepJobs;
  /** Optional run graph supplied by a reader; SQLite records terminal results without it. */
  graph?: WorkflowRunGraph | null;
  result: WorkflowRunRecordResult | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Read-back surface over recorded local workflow runs. Deliberately SEPARATE
 * from the write-only {@link WorkflowRunStore} (shared with the Server) so adding
 * reads here never widens the Server's contract. Satisfied by
 * {@link SqliteWorkflowRunStore}; consumed by the local TUI's detail view.
 */
export interface WorkflowRunReader {
  /** Read one run by id, with `step_jobs`/`result` parsed, or null if absent. */
  getRun(runId: string): Promise<LocalWorkflowRunRecord | null>;
  /** Recent runs, newest-first (by `created_at`). */
  listRuns(limit?: number): Promise<LocalWorkflowRunRecord[]>;
}

/**
 * Derive a deterministic terminal run status from a per-node result:
 * "failed" if ANY node status is a failure ({@link FAILURE_STATUSES}),
 * otherwise "succeeded". An empty status map is treated as "succeeded".
 */
function deriveStatus(result: WorkflowRunRecordResult): "succeeded" | "failed" {
  const anyFailed = Object.values(result.status).some((status) =>
    FAILURE_STATUSES.has(status.toLowerCase()),
  );
  return anyFailed ? "failed" : "succeeded";
}

/** JSON-parse a TEXT column into a record-of-strings, narrowing defensively;
 *  malformed or non-object payloads degrade to `{}` rather than throwing. */
function parseStepJobs(raw: string): StepJobs {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: StepJobs = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** JSON-parse the `result` TEXT column into a {@link WorkflowRunRecordResult}, or null
 *  for an active run / unparseable payload. Narrows the two maps without `any`. */
function parseResult(raw: string | null): WorkflowRunRecordResult | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const status: Record<string, string> = {};
  if (typeof obj.status === "object" && obj.status !== null) {
    for (const [key, value] of Object.entries(obj.status)) {
      if (typeof value === "string") status[key] = value;
    }
  }
  const values: WorkflowRunRecordResult["values"] = {};
  if (typeof obj.values === "object" && obj.values !== null) {
    for (const [key, entry] of Object.entries(obj.values as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const entryStatus = typeof e.status === "string" ? e.status : "unknown";
      const entryValues =
        typeof e.values === "object" && e.values !== null
          ? (e.values as Record<string, unknown>)
          : {};
      const rawFailure =
        typeof e.failure === "object" && e.failure !== null
          ? (e.failure as Record<string, unknown>)
          : null;
      const message = typeof rawFailure?.message === "string" ? rawFailure.message : null;
      const jobId = typeof rawFailure?.jobId === "string" ? rawFailure.jobId : null;
      const exitCode = typeof rawFailure?.exitCode === "number" ? rawFailure.exitCode : null;
      values[key] = {
        status: entryStatus,
        values: entryValues,
        ...(message
          ? {
              failure: {
                message,
                ...(jobId ? { jobId } : {}),
                ...(exitCode !== null ? { exitCode } : {}),
              },
            }
          : {}),
      };
    }
  }
  return { status, values };
}

interface LocalWorkflowRunRow {
  runId: string;
  name: string;
  description: string | null;
  submittedBy: string;
  status: string;
  stepJobs: string;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function decodeRow(row: LocalWorkflowRunRow): LocalWorkflowRunRecord {
  return {
    runId: row.runId,
    name: row.name,
    description: row.description,
    submittedBy: row.submittedBy,
    status: row.status,
    stepJobs: parseStepJobs(row.stepJobs),
    result: parseResult(row.result),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * SQLite-backed {@link WorkflowRunStore} over the `local_workflow_runs` table
 * (shared schema from `@kuintessence/db`). Lets the all-in-one binary's local
 * workflow runner persist run state with no Server/Postgres.
 *
 * `stepJobs` and `result` are stored as JSON-encoded TEXT (same convention as
 * `outbound_job_status.payload`). Synchronous under the hood (bun:sqlite); the
 * async signatures satisfy the shared contract the Server also implements.
 */
export class SqliteWorkflowRunStore implements WorkflowRunStore, WorkflowRunReader {
  constructor(private readonly db: SqliteDb) {}

  async getRun(runId: string): Promise<LocalWorkflowRunRecord | null> {
    const rows = this.db
      .select()
      .from(localWorkflowRuns)
      .where(eq(localWorkflowRuns.runId, runId))
      .all();
    const row = rows[0];
    return row ? decodeRow(row) : null;
  }

  async listRuns(limit: number = DEFAULT_LIST_LIMIT): Promise<LocalWorkflowRunRecord[]> {
    const rows = this.db
      .select()
      .from(localWorkflowRuns)
      .orderBy(desc(localWorkflowRuns.createdAt))
      .limit(limit)
      .all();
    return rows.map(decodeRow);
  }

  async recordRun(
    name: string,
    submittedBy: string,
    result: WorkflowRunRecordResult,
    _graph: WorkflowRunGraph,
  ): Promise<string> {
    const runId = randomUUID();
    const now = new Date();
    this.db
      .insert(localWorkflowRuns)
      .values({
        runId,
        name,
        description: null,
        submittedBy,
        status: deriveStatus(result),
        stepJobs: "{}",
        result: JSON.stringify(result),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return runId;
  }
}
