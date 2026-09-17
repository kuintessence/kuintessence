import { z } from "zod";

export const AgentRowSchema = z
  .object({
    agentId: z.string(),
    siteName: z.string(),
    schedulerType: z.string(),
    schedulerVersion: z.string(),
    status: z.string(),
    lastHeartbeat: z.string().nullable().optional(),
    cpuUsagePercent: z.number().nullable().optional(),
    memoryUsedMb: z.number().nullable().optional(),
    memoryTotalMb: z.number().nullable().optional(),
    maxConcurrentJobs: z.number().nullable().optional(),
  })
  .passthrough();

export const AgentListSchema = z
  .object({
    agents: z.array(AgentRowSchema),
  })
  .passthrough();

export type AgentRow = z.infer<typeof AgentRowSchema>;
export type AgentList = z.infer<typeof AgentListSchema>;
