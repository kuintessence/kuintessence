import { type JobSubmit, WorkflowExecutionInterrupted } from "@kuintessence/shared";

export type WorkflowResourceLimits = Required<
  Pick<JobSubmit["resources"], "cpus" | "memoryMb" | "gpus" | "wallTimeSec">
>;

/** Defaults may fit the delegated budget; explicit requests are never silently reduced. */
export function constrainWorkflowResources(
  requested: Partial<JobSubmit["resources"]> | undefined,
  limits: WorkflowResourceLimits,
): JobSubmit["resources"] {
  const resources = {
    ...requested,
    cpus: requested?.cpus ?? 1,
    memoryMb: requested?.memoryMb ?? limits.memoryMb,
    gpus: requested?.gpus ?? 0,
    wallTimeSec: requested?.wallTimeSec ?? limits.wallTimeSec,
  };
  for (const key of ["cpus", "memoryMb", "gpus", "wallTimeSec"] as const) {
    const minimum = key === "gpus" ? 0 : 1;
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < minimum ||
      !Number.isSafeInteger(resources[key]) ||
      resources[key] < minimum ||
      resources[key] > limits[key]
    )
      throw new WorkflowExecutionInterrupted(
        `Workflow resource ${key} exceeds its authorized limit`,
        { retryable: false },
      );
  }
  return resources;
}
