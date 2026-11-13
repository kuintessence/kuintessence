import type { JobStatusName, JobSubmission, usecase } from "@kuintessence/shared";

/**
 * Seams for turning a materialized JobSubmission into a real, completed job.
 * The async job model is dispatch-then-await: `submit` persists the job,
 * `dispatch` sends DispatchJob (with input staging) to the agent, and
 * `awaitCompletion` resolves when the agent reports a terminal JobStatusUpdate
 * carrying its collected outputs. The completion seam is fed by the gRPC
 * agent-handler (live stack); kept injected so this bridge is testable.
 */
export interface JobSubmitterDeps {
  prepare?(spec: JobSubmission): Promise<JobSubmission>;
  submit(spec: JobSubmission): Promise<{ id: string }>;
  dispatch(
    jobId: string,
    inputStaging: { fileMetadataId: string; stagePath: string }[],
    expectedOutputs: {
      descriptor: string;
      path: string;
      isBatch: boolean;
      pathsOnly?: boolean;
    }[],
    stdinText: string | undefined,
    licensedMaterials: JobSubmission["licensedMaterials"],
    softwareRequirements: JobSubmission["softwareRequirements"],
    schedulingStrategy: JobSubmission["schedulingStrategy"] | undefined,
    spackExecution?: JobSubmission["spackExecution"],
  ): Promise<void>;
  awaitCompletion(jobId: string): Promise<{
    status: JobStatusName;
    collected: Record<string, string>;
    collectedFiles?: Record<string, usecase.FileInputValue>;
    errorMessage?: string;
    reason?: string;
    exitCode?: number;
  }>;
  collectFiles?(
    jobId: string,
    spec: JobSubmission,
    collected: Record<string, string>,
  ): Promise<Record<string, usecase.FileInputValue>>;
  onSubmitted?(nodeId: string, jobId: string): Promise<void>;
}

/** Build the usecase executor's `submitJob`: submit → dispatch → await. */
export function createJobSubmitter(deps: JobSubmitterDeps): (spec: JobSubmission) => Promise<{
  jobId: string;
  status: JobStatusName;
  collected: Record<string, string>;
  collectedFiles?: Record<string, usecase.FileInputValue>;
  errorMessage?: string;
  reason?: string;
  exitCode?: number;
}> {
  return async (spec) => {
    const prepared = (await deps.prepare?.(spec)) ?? spec;
    const job = await deps.submit(prepared);
    await deps.onSubmitted?.(prepared.nodeId, job.id);
    await deps.dispatch(
      job.id,
      prepared.inputStaging,
      prepared.expectedOutputs,
      prepared.stdinText,
      prepared.licensedMaterials,
      prepared.softwareRequirements,
      prepared.schedulingStrategy,
      prepared.spackExecution,
    );
    const { status, collected, collectedFiles, errorMessage, reason, exitCode } =
      await deps.awaitCompletion(job.id);
    const publishedFiles =
      status === "completed" &&
      (prepared.fileOutputDescriptors?.length ?? 0) > 0 &&
      deps.collectFiles
        ? await deps.collectFiles(job.id, prepared, collected)
        : undefined;
    const mergedFiles =
      collectedFiles || publishedFiles
        ? { ...(collectedFiles ?? {}), ...(publishedFiles ?? {}) }
        : undefined;
    return {
      jobId: job.id,
      status,
      collected,
      ...(mergedFiles ? { collectedFiles: mergedFiles } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(reason ? { reason } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  };
}
