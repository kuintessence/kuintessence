import { z } from "zod";
import { SchedulerAccountingSchema } from "../scheduler-accounting";
import { FederationDigestSchema } from "./references";

export const FederationAccountingRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  jobId: z.uuid(),
  dispatchEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  schedulerJobId: z.string().min(1).max(255),
  originalEvidenceDigest: FederationDigestSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type FederationAccountingRequest = z.infer<typeof FederationAccountingRequestSchema>;
export const FederationAccountingObservationSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  jobId: z.uuid(),
  dispatchEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  originalEvidenceDigest: FederationDigestSchema,
  terminalStatus: z.enum(["completed", "failed"]),
  accounting: SchedulerAccountingSchema,
});
export type FederationAccountingObservation = z.infer<typeof FederationAccountingObservationSchema>;
export const FederationAccountingResponseSchema = z.discriminatedUnion("state", [
  z.strictObject({
    request: FederationAccountingRequestSchema,
    state: z.literal("observed"),
    observation: FederationAccountingObservationSchema,
  }),
  z.strictObject({
    request: FederationAccountingRequestSchema,
    state: z.enum(["unavailable", "identity_mismatch", "not_terminal"]),
  }),
]);
export type FederationAccountingResponse = z.infer<typeof FederationAccountingResponseSchema>;
