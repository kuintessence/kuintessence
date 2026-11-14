import { z } from "zod";

/** Fixed-point amounts in the agreement unit. */
export const FederationAmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,37})$/);

/** Receiver-owned resource identities, explicitly included in the signed agreement. */
export const FederationExecutionTargetSchema = z.strictObject({
  providerOrgId: z.uuid(),
  clusterId: z.string().min(1).max(255),
  agentId: z.string().min(1).max(255),
  queueId: z.string().min(1).max(255),
});
export type FederationExecutionTarget = z.infer<typeof FederationExecutionTargetSchema>;

export const FederationResourcesSchema = z.strictObject({
  cpus: z.number().int().min(1).max(1_000_000),
  memoryMb: z.number().int().min(1).max(1_000_000_000),
  gpus: z.number().int().min(0).max(100_000),
  wallTimeSec: z.number().int().min(1).max(31_536_000),
});
