import { z } from "zod";

const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,37})$/);
/** Scheduler assertions: elapsed wall time and actual CPU time are separate quantities. */
export const SchedulerAccountingSchema = z
  .strictObject({
    version: z.literal(1),
    source: z.enum(["slurm-sacct", "pbs-qstat"]),
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
  );
export type SchedulerAccounting = z.infer<typeof SchedulerAccountingSchema>;
