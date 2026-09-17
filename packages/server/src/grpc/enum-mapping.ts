import { JobStatus as ProtoJobStatus, SchedulerType } from "@kuintessence/proto";
import type { SchedulerType as InternalSchedulerType, JobStatusName } from "@kuintessence/shared";

/**
 * Map proto SchedulerType enum (numeric) to internal string identifier.
 *
 * Throws on UNSPECIFIED — callers must validate before invoking.
 */
export function protoToSchedulerType(proto: SchedulerType): InternalSchedulerType {
  switch (proto) {
    case SchedulerType.SLURM:
      return "slurm";
    case SchedulerType.PBS_PRO:
      return "pbs-pro";
    case SchedulerType.TORQUE:
      return "torque";
    case SchedulerType.KUBERNETES:
      return "kubernetes";
    default:
      throw new Error(`Unsupported SchedulerType: ${proto}`);
  }
}

/**
 * Map proto JobStatus enum (numeric) to internal string identifier.
 *
 * Throws on UNSPECIFIED.
 */
export function protoToJobStatus(proto: ProtoJobStatus): JobStatusName {
  switch (proto) {
    case ProtoJobStatus.PENDING:
      return "pending";
    case ProtoJobStatus.QUEUED:
      return "queued";
    case ProtoJobStatus.RUNNING:
      return "running";
    case ProtoJobStatus.COMPLETED:
      return "completed";
    case ProtoJobStatus.FAILED:
      return "failed";
    case ProtoJobStatus.CANCELLED:
      return "cancelled";
    default:
      throw new Error(`Unsupported JobStatus: ${proto}`);
  }
}
