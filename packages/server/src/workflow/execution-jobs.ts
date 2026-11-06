import { createHash } from "node:crypto";
import { type PgTransaction, workflowExecutionJobs } from "@kuintessence/db";
import {
  canonicalJson,
  type JobSubmission,
  journalOperation,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "./execution-journal";

/** Internal usecase bridge. Entry-level permission/license checks still precede this call. */
export async function bindWorkflowExecutionJob(
  lease: LeasedWorkflowJournal,
  spec: JobSubmission,
  createJob: (tx: PgTransaction, intent: JobSubmission) => Promise<{ id: string }>,
): Promise<{ jobId: string; reused: boolean; intent: JobSubmission }> {
  const path = spec.invocation?.path;
  if (!path || Buffer.byteLength(path) > 16_384)
    throw new WorkflowExecutionInterrupted("A durable job requires an invocation path");
  const pathHash = createHash("sha256").update(path).digest("hex");
  const encoded = canonicalJson(spec);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
    throw new WorkflowExecutionInterrupted("Workflow job intent exceeds 8 MiB");
  const intent: JobSubmission = JSON.parse(encoded);
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
          throw new WorkflowExecutionInterrupted("Workflow invocation changed its job intent");
        return { jobId: existing.jobId, reused: true, intent: existing.intent };
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
