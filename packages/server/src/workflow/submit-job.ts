import {
  type JobSubmission,
  type JobSubmit,
  type RoleName,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import type { JobService, JobSubmitOptions } from "../services/job-service";
import { bindWorkflowExecutionJob } from "./execution-jobs";
import type { LeasedWorkflowJournal } from "./execution-journal";

export async function submitWorkflowJob(input: {
  jobService: JobService;
  spec: JobSubmission;
  submittedBy: string;
  role: RoleName;
  orgId?: string | null;
  runId?: string;
  workingDirBase?: string;
  lease?: LeasedWorkflowJournal;
}) {
  const { spec, jobService, lease } = input;
  if (lease && (lease.runId !== input.runId || input.orgId === undefined))
    throw new WorkflowExecutionInterrupted(
      "Durable Job requires its run and explicit organization scope",
      { retryable: false },
    );
  const submission: JobSubmit = {
    name: spec.name,
    ...(spec.usecasePackageId ? { usecasePackageId: spec.usecasePackageId } : {}),
    ...(spec.dataInputs ? { dataInputs: spec.dataInputs } : {}),
    command: spec.command,
    resources: {
      cpus: spec.resources?.cpus ?? 1,
      memoryMb: spec.resources?.memoryMb ?? 1024,
      ...(spec.resources?.wallTimeSec != null ? { wallTimeSec: spec.resources.wallTimeSec } : {}),
    },
    envVars: spec.envVars,
    ...(spec.licensedMaterials ? { licensedMaterials: spec.licensedMaterials } : {}),
    ...(spec.softwareRequirements ? { softwareRequirements: spec.softwareRequirements } : {}),
    inputStaging: spec.inputStaging,
    expectedOutputs: spec.expectedOutputs,
    fileOutputDescriptors: spec.fileOutputDescriptors,
    ...(spec.stdinText !== undefined ? { stdinText: spec.stdinText } : {}),
    ...(spec.schedulingStrategy && "queueId" in spec.schedulingStrategy
      ? { schedulingStrategy: spec.schedulingStrategy }
      : {}),
  };
  const options: JobSubmitOptions = {
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
    trustedMaterialization: true,
    trustedUsecaseRevisionId:
      spec.usecaseVersionId !== spec.usecasePackageId ? spec.usecaseVersionId : undefined,
    ...(input.runId ? { workflow: { runId: input.runId, nodeId: spec.nodeId } } : {}),
  };
  const job = lease
    ? await (async () => {
        const bound = await bindWorkflowExecutionJob(
          lease,
          {
            ...spec,
            submission,
            executionContext: {
              submittedBy: input.submittedBy,
              orgId: input.orgId,
              role: input.role,
              workingDirBase: input.workingDirBase ?? null,
            },
          },
          (tx, intent) =>
            jobService.submitInTransaction(tx, intent.submission, input.submittedBy, options),
        );
        const saved = await jobService.getById(bound.jobId);
        if (!saved)
          throw new WorkflowExecutionInterrupted("Bound workflow Job is unavailable", {
            retryable: false,
          });
        return saved;
      })()
    : await jobService.submit(submission, input.submittedBy, options);
  if (input.workingDirBase)
    await jobService.setWorkingDir(job.id, `${input.workingDirBase}/${job.id}`, lease);
  return job;
}
