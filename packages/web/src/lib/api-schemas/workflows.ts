import { z } from "zod";

export const WorkflowRunRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const WorkflowListSchema = z
  .object({
    runs: z.array(WorkflowRunRowSchema),
  })
  .passthrough();

export const WorkflowRunGraphSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      when: z.string().optional(),
    }),
  ),
});

export const WorkflowRunDetailSchema = WorkflowRunRowSchema.extend({
  description: z.string().nullable().optional(),
  stepJobs: z.record(z.string(), z.string()).default({}),
  // Pending or local runs may not have a persisted orchestration graph.
  graph: WorkflowRunGraphSchema.nullable().optional(),
}).passthrough();

export const WorkflowSubmitResponseSchema = z
  .object({
    runId: z.string(),
    name: z.string().optional(),
    status: z.string(),
  })
  .passthrough();

export type WorkflowRunRow = z.infer<typeof WorkflowRunRowSchema>;
export type WorkflowList = z.infer<typeof WorkflowListSchema>;
export type WorkflowRunGraph = z.infer<typeof WorkflowRunGraphSchema>;
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetailSchema>;
export type WorkflowSubmitResponse = z.infer<typeof WorkflowSubmitResponseSchema>;
