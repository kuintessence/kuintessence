import { z } from "zod";

export const AgentUpdateStateSchema = z.enum([
  "requested",
  "waiting",
  "applying",
  "restarting",
  "succeeded",
  "failed",
  "disabled",
]);
export const AgentUpdateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(["notice", "update"]),
  release: z.string().regex(/^[a-f0-9]{64}$/),
  message: z.string().trim().max(500).default(""),
});
export const AgentUpdateReportSchema = z.strictObject({
  source: z.enum(["startup", "remote"]).optional(),
  requestId: z.uuid(),
  release: z.string().regex(/^[a-f0-9]{64}$/),
  state: AgentUpdateStateSchema,
});
export type AgentUpdateReport = z.infer<typeof AgentUpdateReportSchema>;
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;
export const AgentUpdateListSchema = z.object({
  supported: z.boolean(),
  requests: z.array(
    AgentUpdateRequestSchema.extend({
      state: AgentUpdateStateSchema,
      createdAt: z.string(),
    }),
  ),
});
