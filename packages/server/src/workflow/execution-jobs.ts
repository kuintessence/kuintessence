import { createHash } from "node:crypto";
import { jobs, type PgTransaction, workflowExecutionJobs } from "@kuintessence/db";
import {
  canonicalJson,
  type JobSubmission,
  journalOperation,
  type usecase,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "./execution-journal";

/** Internal leaf-job bridge. Entry-level permission/license checks still precede this call. */
export async function bindWorkflowExecutionJob<T extends JobSubmission>(
  lease: LeasedWorkflowJournal,
  spec: T,
  createJob: (tx: PgTransaction, intent: T) => Promise<{ id: string }>,
): Promise<{ jobId: string; reused: boolean; intent: T }> {
  const path = spec.invocation?.path;
  if (!path || Buffer.byteLength(path) > 16_384)
    throw new WorkflowExecutionInterrupted("A durable job requires an invocation path", {
      retryable: false,
    });
  const pathHash = createHash("sha256").update(path).digest("hex");
  const encoded = canonicalJson(spec);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
    throw new WorkflowExecutionInterrupted("Workflow job intent exceeds 8 MiB", {
      retryable: false,
    });
  const intent: T = JSON.parse(encoded);
  return journalOperation(() =>
    lease.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(workflowExecutionJobs)
        .where(
          and(
            eq(workflowExecutionJobs.runId, lease.runId),
            eq(workflowExecutionJobs.pathHash, pathHash),
          ),
        );
      if (existing) {
        if (existing.path !== path || canonicalJson(existing.intent) !== encoded)
          throw new WorkflowExecutionInterrupted("Workflow invocation changed its job intent", {
            retryable: false,
          });
        return { jobId: existing.jobId, reused: true, intent };
      }
      // The callback must use submitInTransaction, without network I/O or Agent dispatch.
      const job = await createJob(tx, structuredClone(intent));
      await tx.insert(workflowExecutionJobs).values({
        runId: lease.runId,
        pathHash,
        path,
        nodeId: intent.nodeId,
        jobId: job.id,
        intent,
      });
      return { jobId: job.id, reused: false, intent };
    }),
  );
}

/** File publication must commit before the Agent work root can be released. */
export async function readWorkflowPublishedFiles(lease: LeasedWorkflowJournal, jobId: string) {
  return journalOperation(() =>
    lease.transaction(async (tx) => {
      const [row] = await tx
        .select({ files: workflowExecutionJobs.publishedFiles })
        .from(workflowExecutionJobs)
        .where(
          and(eq(workflowExecutionJobs.runId, lease.runId), eq(workflowExecutionJobs.jobId, jobId)),
        );
      if (!row)
        throw new WorkflowExecutionInterrupted("Missing workflow Job binding", {
          retryable: false,
        });
      return row.files;
    }),
  );
}

export async function saveWorkflowPublishedFiles(
  lease: LeasedWorkflowJournal,
  jobId: string,
  files: Record<string, usecase.FileInputValue>,
): Promise<void> {
  const encoded = canonicalJson(files);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
    throw new WorkflowExecutionInterrupted("Workflow file list exceeds 8 MiB", {
      retryable: false,
    });
  await journalOperation(() =>
    lease.transaction(async (tx) => {
      const [job] = await tx
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .for("update");
      if (job?.status !== "completed")
        throw new WorkflowExecutionInterrupted("Only completed Jobs can publish workflow files", {
          retryable: false,
        });
      const [row] = await tx
        .select()
        .from(workflowExecutionJobs)
        .where(
          and(eq(workflowExecutionJobs.runId, lease.runId), eq(workflowExecutionJobs.jobId, jobId)),
        )
        .for("update");
      if (!row)
        throw new WorkflowExecutionInterrupted("Missing workflow Job binding", {
          retryable: false,
        });
      if (row.publishedFiles !== null) {
        if (canonicalJson(row.publishedFiles) !== encoded)
          throw new WorkflowExecutionInterrupted("Published workflow files are immutable", {
            retryable: false,
          });
        return;
      }
      await tx
        .update(workflowExecutionJobs)
        .set({ publishedFiles: files })
        .where(eq(workflowExecutionJobs.jobId, jobId));
    }),
  );
}
