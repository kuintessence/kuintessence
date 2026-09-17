import { z } from "zod";

export const SchedulerTypeEnum = z.enum(["slurm", "pbs-pro", "torque", "kubernetes"]);
