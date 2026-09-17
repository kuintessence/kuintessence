import type { DataInputRef, JobStatusName, JobSubmission, usecase } from "@kuintessence/shared";

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
  submit(spec: {
    nodeId: string;
    name: string;
    usecasePackageId?: string;
    dataInputs?: Record<string, DataInputRef>;
    command: string;
    envVars: Record<string, string>;
    inputStaging?: { fileMetadataId: string; stagePath: string }[];
    expectedOutputs?: {
      descriptor: string;
      path: string;
      isBatch: boolean;
      pathsOnly?: boolean;
    }[];
    fileOutputDescriptors?: string[];
    stdinText?: string;
    licensedMaterials?: JobSubmission["licensedMaterials"];
    softwareRequirements?: JobSubmission["softwareRequirements"];
    resources?: { cpus?: number; wallTimeSec?: number };
    schedulingStrategy?: { queueId: string };
  }): Promise<{ id: string }>;
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
    const manualSchedulingStrategy =
      prepared.schedulingStrategy && "queueId" in prepared.schedulingStrategy
        ? prepared.schedulingStrategy
        : undefined;
    const job = await deps.submit({
      nodeId: prepared.nodeId,
      name: prepared.name,
      ...(prepared.usecasePackageId ? { usecasePackageId: prepared.usecasePackageId } : {}),
      ...(prepared.dataInputs ? { dataInputs: prepared.dataInputs } : {}),
      command: prepared.command,
      envVars: prepared.envVars,
      inputStaging: prepared.inputStaging,
      expectedOutputs: prepared.expectedOutputs,
      fileOutputDescriptors: prepared.fileOutputDescriptors,
      stdinText: prepared.stdinText,
      licensedMaterials: prepared.licensedMaterials,
      softwareRequirements: prepared.softwareRequirements,
      ...(prepared.resources ? { resources: prepared.resources } : {}),
      ...(manualSchedulingStrategy ? { schedulingStrategy: manualSchedulingStrategy } : {}),
    });
    await deps.onSubmitted?.(prepared.nodeId, job.id);
    await deps.dispatch(
      job.id,
      prepared.inputStaging,
      prepared.expectedOutputs,
      prepared.stdinText,
      prepared.licensedMaterials,
      prepared.softwareRequirements,
      prepared.schedulingStrategy,
    );
    const { status, collected, collectedFiles, errorMessage, reason, exitCode } =
      await deps.awaitCompletion(job.id);
    const publishedFiles =
      status === "completed" && deps.collectFiles
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
