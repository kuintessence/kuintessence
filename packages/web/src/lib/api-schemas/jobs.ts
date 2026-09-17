import { z } from "zod";

/**
 * Job-related response schemas. Server adds fields over time, so we use `.passthrough()`
 * to keep unknown columns rather than rejecting them.
 */

export const JobRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    submittedAt: z.string(),
    accessScope: z
      .enum(["owner", "consumer_admin", "provider_operator", "platform", "authorization_service"])
      .optional(),
  })
  .passthrough();

export const JobListSchema = z
  .object({
    jobs: z.array(JobRowSchema),
  })
  .passthrough();

export const JobDetailSchema = JobRowSchema.extend({
  command: z.string().nullable().optional(),
  schedulerJobId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  node: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  resources: z
    .object({
      cpus: z.number().optional(),
      memoryMb: z.number().optional(),
    })
    .partial()
    .nullable()
    .optional(),
}).passthrough();

export type JobRow = z.infer<typeof JobRowSchema>;
export type JobList = z.infer<typeof JobListSchema>;
export type JobDetail = z.infer<typeof JobDetailSchema>;
