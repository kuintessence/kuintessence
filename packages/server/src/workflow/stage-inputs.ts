export interface WorkflowInputFile {
  fileMetadataId: string;
  stagePath: string;
}

/**
 * Stage one input file into the placed agent's run directory. Implemented by
 * reusing the existing FileTransferRequest (cloud_to_cluster) subsystem
 * (decision: reuse, not a new staging path), which the agent already handles
 * and which is container-aware. Injected so the loop is testable without a
 * live agent.
 */
export type StageOne = (file: WorkflowInputFile, targetPath: string) => Promise<void>;

/**
 * Stage all of a workflow node's input files to `<workingDir>/<stagePath>` before the
 * job is dispatched. Sequential + fail-fast: a transfer error aborts staging
 * (the job must not run against missing inputs).
 */
export async function stageWorkflowInputs(
  workingDir: string,
  files: WorkflowInputFile[],
  stageOne: StageOne,
): Promise<void> {
  const base = workingDir.replace(/\/+$/, "");
  for (const file of files) {
    await stageOne(file, `${base}/${file.stagePath}`);
  }
}
