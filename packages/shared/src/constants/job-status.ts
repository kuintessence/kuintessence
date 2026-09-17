export const JobStatus = {
  PENDING: "pending",
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type JobStatusName = (typeof JobStatus)[keyof typeof JobStatus];
