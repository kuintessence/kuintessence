/**
 * Side-effect-free barrel for the scheduler adapters. Importing this does NOT
 * boot the agent daemon (that lives in `../index.ts`), so other packages — the
 * all-in-one CLI/TUI in particular — can reuse adapters and scheduler detection
 * without starting a long-running stream loop.
 */
export {
  type JobResult,
  type JobSpec,
  type JobStatusResult,
  type ListedJob,
  type QueueTargetValidation,
  type QueueTargetValidationResult,
  realSpawner,
  type SchedulerAdapter,
  SchedulerSubmissionError,
  type Spawner,
} from "./base";
export { type DetectOptions, detectScheduler } from "./detect";
export { K8sAdapter } from "./k8s";
export { PbsProAdapter } from "./pbs-pro";
export { SlurmAdapter, type SlurmAdapterDeps } from "./slurm";
export { TorqueAdapter } from "./torque";
