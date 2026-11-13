import { z } from "zod";

const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,37})$/);
/** Scheduler assertions: elapsed wall time and actual CPU time are separate quantities. */
export const SchedulerAccountingSchema = z
  .strictObject({
    version: z.literal(1),
    source: z.enum(["slurm-sacct", "pbs-qstat", "kubernetes-pod"]),
    schedulerJobId: z.string().min(1).max(255),
    observedAt: z.iso.datetime(),
    elapsedMilliseconds: Quantity.optional(),
    cpuTimeMilliseconds: Quantity.optional(),
    allocatedCpus: Quantity.optional(),
  })
  .refine(
    (value) =>
      value.elapsedMilliseconds !== undefined ||
      value.cpuTimeMilliseconds !== undefined ||
      value.allocatedCpus !== undefined,
    "Accounting requires at least one reported quantity",
  )
  .refine(
    (value) =>
      value.source !== "kubernetes-pod" ||
      (value.cpuTimeMilliseconds === undefined && value.allocatedCpus === undefined),
    "Pod termination timestamps report elapsed time only",
  );
export type SchedulerAccounting = z.infer<typeof SchedulerAccountingSchema>;

export function schedulerAccountingSource(scheduler: string | undefined) {
  switch (scheduler) {
    case "slurm":
      return "slurm-sacct";
    case "pbs-pro":
      return "pbs-qstat";
    case "kubernetes":
      return "kubernetes-pod";
    default:
      return undefined;
  }
}
