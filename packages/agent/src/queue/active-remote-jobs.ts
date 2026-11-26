import { isDeepStrictEqual } from "node:util";
import { activeRemoteJobs, type SqliteDb } from "@kuintessence/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type JobSpec,
  type JobStatusResult,
  SchedulerSubmissionUnknownError,
} from "../adapters/base";
import {
  type CompletedJobSnapshot,
  completionBinding,
  expectedOutputToJson,
  jobSpecToJson,
  jsonToExpectedOutput,
  jsonToJobSpec,
  PENDING_SCHEDULER_SUBMISSION,
  type PreparedRemoteJob,
  validateCompletionSnapshot,
} from "../embedded/job-snapshot";
import type { ExpectedOutput } from "../output-collector";

export {
  type CompletedJobSnapshot,
  jsonToPreparedRemoteJob,
  PENDING_SCHEDULER_SUBMISSION,
  type PreparedRemoteJob,
  preparedRemoteJobToJson,
  validateCompletionSnapshot,
} from "../embedded/job-snapshot";

export interface ActiveRemoteJobRecord {
  submittedAfter?: string;
  completionSnapshot?: CompletedJobSnapshot;
  jobId: string;
  schedulerJobId: string;
  schedulerUid?: string;
  dispatchId?: string;
  spec: JobSpec;
  expectedOutputs: ExpectedOutput[];
}

export interface RecordSubmittedInput extends PreparedRemoteJob {
  schedulerJobId: string;
  schedulerUid?: string;
  dispatchId?: string;
}

export class ActiveRemoteJobs {
  constructor(private readonly db: SqliteDb) {}

  async recordSubmitted(input: RecordSubmittedInput): Promise<void> {
    this.assertConfirmedId(input.schedulerJobId);
    if (await this.insert(input)) return;
    const [row] = await this.db
      .select()
      .from(activeRemoteJobs)
      .where(eq(activeRemoteJobs.jobId, input.spec.jobId))
      .limit(1);
    const existing = row ? activeRemoteJobFromRow(row) : undefined;
    if (
      !existing ||
      !isDeepStrictEqual(existing.spec, jsonToJobSpec(jobSpecToJson(input.spec))) ||
      !isDeepStrictEqual(
        existing.expectedOutputs,
        input.expectedOutputs.map((output) => jsonToExpectedOutput(expectedOutputToJson(output))),
      )
    )
      throw new SchedulerSubmissionUnknownError(
        "Submitted job conflicts with its durable execution binding",
      );
    if (
      (existing.dispatchId !== undefined &&
        input.dispatchId !== undefined &&
        existing.dispatchId !== input.dispatchId) ||
      (existing.schedulerUid !== undefined &&
        input.schedulerUid !== undefined &&
        existing.schedulerUid !== input.schedulerUid) ||
      (existing.schedulerJobId !== PENDING_SCHEDULER_SUBMISSION &&
        existing.schedulerJobId !== input.schedulerJobId)
    )
      throw new SchedulerSubmissionUnknownError(
        "Submitted job conflicts with its durable scheduler identity",
      );
    const dispatchId = existing.dispatchId ?? input.dispatchId;
    const schedulerUid = existing.schedulerUid ?? input.schedulerUid;
    if (
      existing.schedulerJobId === input.schedulerJobId &&
      existing.dispatchId === dispatchId &&
      existing.schedulerUid === schedulerUid
    )
      return;
    if (!row) throw new SchedulerSubmissionUnknownError("Submission binding disappeared");
    const updated = await this.db
      .update(activeRemoteJobs)
      .set({
        schedulerJobId: input.schedulerJobId,
        spec: { ...row.spec, dispatchId, schedulerUid },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(activeRemoteJobs.jobId, input.spec.jobId),
          eq(activeRemoteJobs.schedulerJobId, row.schedulerJobId),
          eq(activeRemoteJobs.spec, row.spec),
        ),
      )
      .returning({ jobId: activeRemoteJobs.jobId });
    if (!updated.length) {
      const current = await this.get(input.spec.jobId);
      if (
        current?.schedulerJobId !== input.schedulerJobId ||
        current.dispatchId !== dispatchId ||
        current.schedulerUid !== schedulerUid
      )
        throw new SchedulerSubmissionUnknownError("Submission binding changed before confirmation");
    }
  }

  async recordSubmissionIntent(spec: JobSpec, expectedOutputs: ExpectedOutput[]): Promise<void> {
    if (
      !(await this.insert({ spec, expectedOutputs, schedulerJobId: PENDING_SCHEDULER_SUBMISSION }))
    )
      throw new SchedulerSubmissionUnknownError(
        "A durable submission already exists; reconcile it before submitting again",
      );
  }

  private async insert(input: RecordSubmittedInput): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .insert(activeRemoteJobs)
      .values({
        jobId: input.spec.jobId,
        schedulerJobId: input.schedulerJobId,
        spec: {
          ...jobSpecToJson(input.spec),
          dispatchId: input.dispatchId,
          schedulerUid: input.schedulerUid,
        },
        expectedOutputs: input.expectedOutputs.map(expectedOutputToJson),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: activeRemoteJobs.jobId })
      .returning({ jobId: activeRemoteJobs.jobId });
    return rows.length === 1;
  }

  private assertConfirmedId(schedulerJobId: string): void {
    if (
      !schedulerJobId ||
      schedulerJobId === PENDING_SCHEDULER_SUBMISSION ||
      schedulerJobId.includes("\0")
    )
      throw new SchedulerSubmissionUnknownError("A confirmed scheduler identity is required");
  }

  async listActive(): Promise<ActiveRemoteJobRecord[]> {
    const rows = await this.db
      .select()
      .from(activeRemoteJobs)
      .orderBy(asc(activeRemoteJobs.createdAt), asc(activeRemoteJobs.jobId));
    return rows.map(activeRemoteJobFromRow);
  }

  async get(jobId: string): Promise<ActiveRemoteJobRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(activeRemoteJobs)
      .where(eq(activeRemoteJobs.jobId, jobId))
      .limit(1);
    return row ? activeRemoteJobFromRow(row) : undefined;
  }

  async confirmSubmission(jobId: string, schedulerJobId: string): Promise<boolean> {
    this.assertConfirmedId(schedulerJobId);
    const rows = await this.db
      .update(activeRemoteJobs)
      .set({ schedulerJobId, updatedAt: new Date() })
      .where(
        and(
          eq(activeRemoteJobs.jobId, jobId),
          eq(activeRemoteJobs.schedulerJobId, PENDING_SCHEDULER_SUBMISSION),
        ),
      )
      .returning({ jobId: activeRemoteJobs.jobId });
    return rows.length === 1;
  }

  async recordCompleted(input: RecordSubmittedInput, result: JobStatusResult): Promise<void> {
    this.assertConfirmedId(input.schedulerJobId);
    if (result.status !== "completed")
      throw new Error("Only a completed scheduler result may be persisted");
    const [row] = await this.db
      .select()
      .from(activeRemoteJobs)
      .where(eq(activeRemoteJobs.jobId, input.spec.jobId))
      .limit(1);
    if (!row || row.schedulerJobId !== input.schedulerJobId)
      throw new Error("Completed job scheduler binding unavailable");
    const existing = activeRemoteJobFromRow(row);
    const binding = completionBinding(input.spec, input.schedulerJobId, input.expectedOutputs);
    if (
      completionBinding(existing.spec, existing.schedulerJobId, existing.expectedOutputs) !==
      binding
    )
      throw new Error("Completed job execution binding changed");
    const snapshot = validateCompletionSnapshot(
      { format: 1, schedulerJobId: input.schedulerJobId, binding, result },
      input.spec,
      input.schedulerJobId,
      input.expectedOutputs,
    );
    if (existing.completionSnapshot) {
      if (!isDeepStrictEqual(existing.completionSnapshot, snapshot))
        throw new Error("Completed job snapshot changed");
      return;
    }
    const rows = await this.db
      .update(activeRemoteJobs)
      .set({ spec: { ...row.spec, completionSnapshot: snapshot }, updatedAt: new Date() })
      .where(
        and(
          eq(activeRemoteJobs.jobId, input.spec.jobId),
          eq(activeRemoteJobs.schedulerJobId, input.schedulerJobId),
          eq(activeRemoteJobs.spec, row.spec),
        ),
      )
      .returning({ jobId: activeRemoteJobs.jobId });
    if (!rows.length) throw new Error("Completed job changed before its durable snapshot");
  }

  async markFinished(jobId: string): Promise<void> {
    await this.db.delete(activeRemoteJobs).where(eq(activeRemoteJobs.jobId, jobId));
  }
}

function activeRemoteJobFromRow(row: typeof activeRemoteJobs.$inferSelect): ActiveRemoteJobRecord {
  const spec = jsonToJobSpec(row.spec);
  if (spec.jobId !== row.jobId) throw new Error("Active job identity binding changed");
  const expectedOutputs = row.expectedOutputs.map(jsonToExpectedOutput);
  const completionSnapshot =
    row.spec.completionSnapshot === undefined
      ? undefined
      : validateCompletionSnapshot(
          row.spec.completionSnapshot,
          spec,
          row.schedulerJobId,
          expectedOutputs,
        );
  return {
    jobId: row.jobId,
    dispatchId: typeof row.spec.dispatchId === "string" ? row.spec.dispatchId : undefined,
    schedulerUid: z.string().uuid().optional().parse(row.spec.schedulerUid),
    submittedAfter: new Date(row.createdAt.getTime() - 86400000).toISOString().slice(0, 10),
    schedulerJobId: row.schedulerJobId,
    spec,
    expectedOutputs,
    completionSnapshot,
  };
}
