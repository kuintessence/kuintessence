/**
 * Storage-agnostic contract for workflow-run persistence.
 *
 * The Server satisfies this with a Postgres-backed implementation
 * (`WorkflowRunRegistry`); the embedded local kernel uses SQLite.
 * Keeping the interface in `@kuintessence/shared` lets either component depend
 * on the contract without depending on the other (`agent → shared`, `server →
 * shared`; never `agent → server`). The interface MUST stay free of any storage
 * backend types (Drizzle, PG, SQLite).
 */

import type { WorkflowRunGraph } from "../workflow-dsl/run-graph";

/** Map from step ID within a workflow to the job UUID that runs it. */
export type StepJobs = Record<string, string>;

export interface WorkflowNodeFailure {
  message: string;
  jobId?: string;
  exitCode?: number;
}

/** Per-node result of a control-flow run, stored on `workflow_runs.result`. */
export interface WorkflowRunRecordResult {
  status: Record<string, string>;
  values: Record<
    string,
    {
      status: string;
      values: Record<string, unknown>;
      failure?: WorkflowNodeFailure;
    }
  >;
}

/** Persistence contract for recording completed control-flow runs. */
export interface WorkflowRunStore {
  /** Persist a finished control-flow run already-terminal; returns its UUID. */
  recordRun(
    name: string,
    submittedBy: string,
    result: WorkflowRunRecordResult,
    graph: WorkflowRunGraph,
  ): Promise<string>;
}
