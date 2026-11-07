import { canonicalJson } from "../utils/canonical-json";
import type { Workflow } from "../workflow-dsl";
import type { NodeStatus } from "./engine";
import type { WorkflowNodeFailure } from "./run-store";

/** Stable within a run, including every loop iteration and sub-workflow call. */
export interface NodeInvocation {
  path: string;
}

export type WorkflowJournalEntry =
  | { kind: "definition"; workflow: Workflow }
  | { kind: "version"; workflow: Workflow | null }
  | {
      kind: "node";
      status: NodeStatus;
      values: Record<string, unknown>;
      failure?: WorkflowNodeFailure;
      selectedTarget?: string;
    };

/** Run-scoped immutable records. Implementations must fence every read/write by a live lease. */
export interface WorkflowJournal {
  read(key: string): Promise<WorkflowJournalEntry | null>;
  write(key: string, entry: WorkflowJournalEntry): Promise<void>;
}

/** Infrastructure uncertainty must suspend execution, never become a scientific failure. */
export class WorkflowExecutionInterrupted extends Error {
  readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(message, options);
    this.retryable = options?.retryable ?? true;
    this.name = "WorkflowExecutionInterrupted";
  }
}

export type WorkflowWaitingReason =
  | "DATA_WAITING"
  | "SOFTWARE_WAITING"
  | "REMOTE_WAITING"
  | "RESULT_WAITING"
  | "LEDGER_WAITING";

export interface WorkflowWaitingInvocation extends NodeInvocation {
  reason: WorkflowWaitingReason;
}

/** An executor has persisted its external intent, but has no terminal result yet. */
export class WorkflowNodeWaiting extends Error {
  constructor(readonly reason: WorkflowWaitingReason) {
    super(reason);
    this.name = "WorkflowNodeWaiting";
  }
}

/** Runnable siblings have checkpointed; the run can release its lease until recovery. */
export class WorkflowExecutionWaiting extends WorkflowExecutionInterrupted {
  constructor(readonly invocations: WorkflowWaitingInvocation[]) {
    super("Workflow is waiting for external prerequisites");
    this.name = "WorkflowExecutionWaiting";
  }
}

export async function journalOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof WorkflowExecutionInterrupted) throw cause;
    throw new WorkflowExecutionInterrupted("Workflow journal is unavailable", { cause });
  }
}

export async function bindWorkflowJournal(journal: WorkflowJournal, workflow: Workflow) {
  await journalOperation(async () => {
    const key = JSON.stringify(["definition"]);
    const saved = await journal.read(key);
    if (saved) {
      if (
        saved.kind !== "definition" ||
        canonicalJson(saved.workflow) !== canonicalJson(workflow)
      ) {
        throw new WorkflowExecutionInterrupted("Workflow definition changed during recovery", {
          retryable: false,
        });
      }
    } else {
      await journal.write(key, { kind: "definition", workflow });
    }
  });
}
