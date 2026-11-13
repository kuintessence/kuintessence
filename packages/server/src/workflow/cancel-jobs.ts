import { createLogger } from "@kuintessence/shared";
import type { JobCancellationOutbox } from "../grpc/dispatcher";
import type { JobService } from "../services/job-service";
import type { JobCompletionRegistry } from "./job-completion-registry";
import type { WorkflowRunRegistry } from "./run-registry";

const logger = createLogger("workflow-cancellation");

export async function cancelWorkflowJobs(
  runId: string,
  workflowRegistry: Pick<WorkflowRunRegistry, "listJobIds">,
  jobService: Pick<JobService, "getById" | "updateStatus">,
  jobCancellationOutbox: Pick<JobCancellationOutbox, "deliverJob" | "waitForAcknowledgement">,
  jobCompletionRegistry: Pick<JobCompletionRegistry, "complete">,
): Promise<void> {
  const jobIds = await workflowRegistry.listJobIds(runId);
  const results = await Promise.allSettled(
    jobIds.map(async (jobId) => {
      const job = await jobService.getById(jobId);
      if (!job) return;
      const cancelled = await jobService.updateStatus(jobId, "cancelled");
      if (await jobCancellationOutbox.deliverJob(jobId)) {
        await jobCancellationOutbox.waitForAcknowledgement(jobId, cancelled.revokedEpoch);
      }
      if (cancelled.status === "cancelled")
        jobCompletionRegistry.complete(jobId, { status: "cancelled", collected: {} });
    }),
  );
  const failures: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      logger.warn(
        { err: result.reason, jobId: jobIds[index], runId },
        "Failed to cancel submitted workflow job",
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Workflow ${runId} job cancellation did not converge`);
  }
}
