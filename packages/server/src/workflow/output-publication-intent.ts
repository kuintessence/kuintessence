import { jobs, type PgDb, workflowOutputPublicationIntents } from "@kuintessence/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { PublicationRecord, PublicationStore } from "./output-publication";
import { preparePublicationInput } from "./output-publication-input";

export interface PublicationIntentJob {
  jobId: string;
  workflowRunId: string | null;
  status: string;
  submittedBy: string | null;
  agentId: string | null;
  workingDir: string | null;
  restrictedNoEgress: boolean;
  sandboxExecution: unknown;
  expectedOutputs: Array<{
    descriptor: string;
    path: string;
    isBatch: boolean;
    pathsOnly?: boolean;
  }> | null;
  fileOutputDescriptors: string[] | null;
  collectedOutputs: Record<string, string> | null;
}

export interface PublicationIntentStore {
  pending(limit: number): Promise<string[]>;
  load(jobId: string): Promise<PublicationIntentJob | undefined>;
  remove(jobId: string): Promise<void>;
  retry(jobId: string): Promise<void>;
}

export class PgPublicationIntentStore implements PublicationIntentStore {
  constructor(private readonly db: PgDb) {}
  async pending(limit: number) {
    const rows = await this.db
      .select({ id: workflowOutputPublicationIntents.jobId })
      .from(workflowOutputPublicationIntents)
      .innerJoin(jobs, eq(jobs.id, workflowOutputPublicationIntents.jobId))
      .where(
        and(
          eq(jobs.status, "completed"),
          lte(workflowOutputPublicationIntents.nextAttemptAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(
        asc(workflowOutputPublicationIntents.nextAttemptAt),
        asc(workflowOutputPublicationIntents.jobId),
      )
      .limit(limit);
    return rows.map((row) => row.id);
  }
  async load(jobId: string) {
    const [row] = await this.db
      .select({
        jobId: jobs.id,
        workflowRunId: workflowOutputPublicationIntents.workflowRunId,
        status: jobs.status,
        submittedBy: jobs.submittedBy,
        agentId: jobs.agentId,
        workingDir: jobs.workingDir,
        restrictedNoEgress: jobs.restrictedNoEgress,
        sandboxExecution: jobs.sandboxExecution,
        expectedOutputs: jobs.expectedOutputs,
        fileOutputDescriptors: jobs.fileOutputDescriptors,
        collectedOutputs: jobs.collectedOutputs,
      })
      .from(workflowOutputPublicationIntents)
      .innerJoin(jobs, eq(jobs.id, workflowOutputPublicationIntents.jobId))
      .where(eq(workflowOutputPublicationIntents.jobId, jobId))
      .limit(1);
    return row;
  }
  async remove(jobId: string) {
    await this.db
      .delete(workflowOutputPublicationIntents)
      .where(eq(workflowOutputPublicationIntents.jobId, jobId));
  }
  async retry(jobId: string) {
    await this.db
      .update(workflowOutputPublicationIntents)
      .set({
        attempts: sql`${workflowOutputPublicationIntents.attempts} + 1`,
        nextAttemptAt: sql`clock_timestamp() + interval '1 second' * least(300, 30 * power(2, least(${workflowOutputPublicationIntents.attempts}, 4)))`,
        error: "Workflow output intent pending; metadata or publication retry required",
      })
      .where(eq(workflowOutputPublicationIntents.jobId, jobId));
  }
}

/** Recover delivery intent only; computation and workflow/DAG execution are never invoked. */
export class WorkflowPublicationIntentRecovery {
  private recovering: Promise<{ enqueued: number; failed: number }> | undefined;
  constructor(
    private readonly deps: {
      store: PublicationIntentStore;
      publications: Pick<PublicationStore, "enqueue" | "get">;
    },
  ) {}

  async enqueue(jobId: string): Promise<PublicationRecord> {
    const job = await this.deps.store.load(jobId);
    if (!job) {
      const existing = await this.deps.publications.get(jobId);
      if (!existing) throw new Error("Workflow publication intent unavailable");
      return existing;
    }
    try {
      if (
        job.status !== "completed" ||
        job.restrictedNoEgress ||
        job.sandboxExecution ||
        !job.submittedBy ||
        !job.agentId ||
        !job.workingDir
      )
        throw new Error("Completed Workflow output binding unavailable");
      const input = preparePublicationInput({
        jobId: job.jobId,
        ownerId: job.submittedBy,
        agentId: job.agentId,
        workingDir: job.workingDir,
        ...(job.workflowRunId ? { workflowRunId: job.workflowRunId } : {}),
        spec: {
          expectedOutputs: job.expectedOutputs ?? [],
          fileOutputDescriptors: job.fileOutputDescriptors ?? [],
        },
        collected: job.collectedOutputs ?? {},
      });
      const record = await this.deps.publications.enqueue(input);
      // A crash before this delete repeats enqueue, which preserves the first durable transfer IDs.
      await this.deps.store.remove(jobId);
      return record;
    } catch (error) {
      await this.deps.store.retry(jobId);
      throw error;
    }
  }

  recover(): Promise<{ enqueued: number; failed: number }> {
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      const report = { enqueued: 0, failed: 0 };
      for (const id of await this.deps.store.pending(25)) {
        try {
          await this.enqueue(id);
          report.enqueued++;
        } catch {
          report.failed++;
        }
      }
      return report;
    })().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
}
