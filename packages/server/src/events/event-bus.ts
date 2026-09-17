import { createLogger, type JobStatusName } from "@kuintessence/shared";

const logger = createLogger("event-bus");

/**
 * Status delta emitted whenever a job transitions in the Server. Mirrors the
 * `jobs.status` column shape; `agentId`/`schedulerJobId` are surfaced when the
 * Server knows them so WebSocket subscribers don't need to re-fetch.
 */
export interface JobStatusChangedEvent {
  jobId: string;
  status: JobStatusName | string;
  schedulerJobId?: string | null;
  agentId?: string | null;
}

/**
 * Status delta emitted whenever a workflow step (= a single job in the engine)
 * transitions. Subscribers indexed by `runId` so the per-run UI can render the
 * DAG in real time without polling.
 */
export interface WorkflowStateChangedEvent {
  runId: string;
  stepId: string;
  jobId: string;
  status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled" | string;
}

type JobListener = (evt: JobStatusChangedEvent) => void;
type WorkflowListener = (evt: WorkflowStateChangedEvent) => void;

/**
 * In-process pub/sub for Server→Web fan-out.
 *
 * Why a custom class instead of Node's `EventEmitter`:
 *   - keys are dynamic (per jobId / per runId) and we want subscriber
 *     bookkeeping per-key without leaking listener-count caps;
 *   - we want a typed publish/subscribe API instead of stringly-named events;
 *   - we want subscriber errors isolated (one buggy WS handler must not abort
 *     fan-out to siblings);
 *   - this is single-Server only; multiple Servers require a shared pub/sub adapter.
 *
 * The bus is intentionally synchronous; subscribers (e.g. WebSocket `send`)
 * must be cheap. If a subscriber wants to do async work it should schedule
 * its own task.
 */
export class EventBus {
  private jobSubs = new Map<string, Set<JobListener>>();
  private workflowSubs = new Map<string, Set<WorkflowListener>>();

  /** Subscribe to job status events for `jobId`. Returns an unsubscribe fn. */
  subscribeJob(jobId: string, listener: JobListener): () => void {
    let set = this.jobSubs.get(jobId);
    if (!set) {
      set = new Set();
      this.jobSubs.set(jobId, set);
    }
    set.add(listener);
    return () => {
      const cur = this.jobSubs.get(jobId);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) this.jobSubs.delete(jobId);
    };
  }

  /** Subscribe to workflow step state events for `runId`. Returns an unsubscribe fn. */
  subscribeWorkflow(runId: string, listener: WorkflowListener): () => void {
    let set = this.workflowSubs.get(runId);
    if (!set) {
      set = new Set();
      this.workflowSubs.set(runId, set);
    }
    set.add(listener);
    return () => {
      const cur = this.workflowSubs.get(runId);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) this.workflowSubs.delete(runId);
    };
  }

  /** Publish a job status delta. No-op if no subscribers for this jobId. */
  publishJobStatus(evt: JobStatusChangedEvent): void {
    const set = this.jobSubs.get(evt.jobId);
    if (!set) return;
    // Snapshot to allow listeners to unsubscribe themselves during dispatch.
    for (const listener of [...set]) {
      try {
        listener(evt);
      } catch (err) {
        logger.error({ jobId: evt.jobId, err }, "Job status subscriber threw an error");
      }
    }
  }

  /** Publish a workflow step state delta. No-op if no subscribers for this runId. */
  publishWorkflowState(evt: WorkflowStateChangedEvent): void {
    const set = this.workflowSubs.get(evt.runId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(evt);
      } catch (err) {
        logger.error({ runId: evt.runId, err }, "Workflow state subscriber threw an error");
      }
    }
  }

  /** Test helper: how many subscribers are currently registered for a jobId. */
  jobSubscriberCount(jobId: string): number {
    return this.jobSubs.get(jobId)?.size ?? 0;
  }

  /** Test helper: how many subscribers are currently registered for a runId. */
  workflowSubscriberCount(runId: string): number {
    return this.workflowSubs.get(runId)?.size ?? 0;
  }
}
