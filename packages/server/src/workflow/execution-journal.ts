import { createHash, randomUUID } from "node:crypto";
import {
  type PgDb,
  type PgTransaction,
  workflowExecutionJournal,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import {
  canonicalJson,
  WorkflowExecutionInterrupted,
  type WorkflowJournal,
  type WorkflowJournalEntry,
} from "@kuintessence/shared";
import { and, eq, sql } from "drizzle-orm";

/** Internal execution primitive; callers must authorize the run before acquiring it. */
export class WorkflowExecutionJournalStore {
  constructor(private readonly db: PgDb) {}

  async acquire(runId: string, leaseMs = 30_000): Promise<LeasedWorkflowJournal | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000)
      throw new Error("Workflow lease must be between 100 ms and 300 seconds");
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update");
      if (run?.status !== "running") return null;
      await tx.insert(workflowExecutionLeases).values({ runId }).onConflictDoNothing();
      const token = randomUUID();
      const [claimed] = await tx
        .update(workflowExecutionLeases)
        .set({ token, expiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'` })
        .where(
          and(
            eq(workflowExecutionLeases.runId, runId),
            sql`(${workflowExecutionLeases.token} IS NULL OR ${workflowExecutionLeases.expiresAt} <= clock_timestamp())`,
          ),
        )
        .returning({ runId: workflowExecutionLeases.runId });
      return claimed ? new LeasedWorkflowJournal(this.db, runId, token, leaseMs) : null;
    });
  }
}

export class LeasedWorkflowJournal implements WorkflowJournal {
  constructor(
    private readonly db: PgDb,
    readonly runId: string,
    private readonly token: string,
    private readonly leaseMs: number,
  ) {}

  /** The same fence can surround an atomic invocation → Job binding transaction. */
  async transaction<T>(operation: (tx: PgTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Use the same lock order as acquisition, and observe cancellation before any write.
      const [run] = await tx
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, this.runId))
        .for("update");
      const [lease] = await tx
        .select()
        .from(workflowExecutionLeases)
        .where(eq(workflowExecutionLeases.runId, this.runId))
        .for("update");
      const [time] = await tx
        .select({ valid: sql<boolean>`${workflowExecutionLeases.expiresAt} > clock_timestamp()` })
        .from(workflowExecutionLeases)
        .where(eq(workflowExecutionLeases.runId, this.runId));
      if (run?.status !== "running" || lease?.token !== this.token || !time?.valid)
        throw new WorkflowExecutionInterrupted(
          "Workflow execution lease expired or run was stopped",
        );
      const result = await operation(tx);
      // An operation that outlives its lease must roll back, even without a competing worker.
      const [stillValid] = await tx
        .select({ valid: sql<boolean>`${workflowExecutionLeases.expiresAt} > clock_timestamp()` })
        .from(workflowExecutionLeases)
        .where(eq(workflowExecutionLeases.runId, this.runId));
      if (!stillValid?.valid)
        throw new WorkflowExecutionInterrupted(
          "Workflow execution lease expired during transaction",
        );
      return result;
    });
  }

  async renew(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx
        .update(workflowExecutionLeases)
        .set({ expiresAt: sql`clock_timestamp() + ${this.leaseMs} * interval '1 millisecond'` })
        .where(eq(workflowExecutionLeases.runId, this.runId));
    });
  }

  async release(): Promise<void> {
    await this.db
      .update(workflowExecutionLeases)
      .set({ token: null, expiresAt: null })
      .where(
        and(
          eq(workflowExecutionLeases.runId, this.runId),
          eq(workflowExecutionLeases.token, this.token),
        ),
      );
  }

  async read(key: string): Promise<WorkflowJournalEntry | null> {
    const hash = keyHash(key);
    return this.transaction(async (tx) => {
      const [saved] = await tx
        .select()
        .from(workflowExecutionJournal)
        .where(
          and(
            eq(workflowExecutionJournal.runId, this.runId),
            eq(workflowExecutionJournal.keyHash, hash),
          ),
        );
      if (saved && saved.key !== key)
        throw new WorkflowExecutionInterrupted("Workflow journal key collision");
      return saved?.entry ?? null;
    });
  }

  async write(key: string, entry: WorkflowJournalEntry): Promise<void> {
    const hash = keyHash(key);
    const encoded = canonicalJson(entry);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
      throw new WorkflowExecutionInterrupted(
        "Workflow checkpoint exceeds 8 MiB; store artifacts as file references",
      );
    await this.transaction(async (tx) => {
      await tx
        .insert(workflowExecutionJournal)
        .values({ runId: this.runId, keyHash: hash, key, entry })
        .onConflictDoNothing();
      const [saved] = await tx
        .select()
        .from(workflowExecutionJournal)
        .where(
          and(
            eq(workflowExecutionJournal.runId, this.runId),
            eq(workflowExecutionJournal.keyHash, hash),
          ),
        );
      if (!saved || saved.key !== key || canonicalJson(saved.entry) !== encoded)
        throw new WorkflowExecutionInterrupted("Workflow checkpoint is immutable");
    });
  }
}

function keyHash(key: string): string {
  if (key.length === 0 || Buffer.byteLength(key) > 16_384)
    throw new WorkflowExecutionInterrupted("Invalid workflow journal key size");
  return createHash("sha256").update(key).digest("hex");
}
