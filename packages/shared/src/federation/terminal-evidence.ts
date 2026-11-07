import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** Receiver-private observations, not a bill or a scheduler accounting statement. */
export const FederationTerminalEvidenceSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.uuid(),
  runId: z.uuid(),
  reservationId: z.uuid(),
  agreementRevisionId: z.uuid(),
  taskId: z.uuid(),
  attempt: z.number().int().positive(),
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  requestDigest: FederationDigestSchema,
  executionSnapshotDigest: FederationDigestSchema,
  invocationPathHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["completed", "failed", "cancelled"]),
  previousStatus: z.enum(["pending", "queued", "running"]),
  source: z.enum(["agent-status", "status-update", "platform-cancellation", "data-revocation"]),
  agentEventId: z.string().nullable(),
  dispatchEpoch: z.number().int().nonnegative(),
  requested: z.strictObject({
    cpus: z.string().regex(/^[0-9]+$/),
    gpus: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    memoryMb: z.string().regex(/^[0-9]+$/),
  }),
  scheduler: z.strictObject({
    agentId: z.string().nullable(),
    type: z.string().nullable(),
    jobId: z.string().nullable(),
    queueId: z.string().nullable(),
    node: z.string().nullable(),
    exitCode: z.number().int().nullable(),
  }),
  observation: z.strictObject({
    basis: z.literal("server-status-observation"),
    runningObservedAt: z.iso.datetime().nullable(),
    terminalObservedAt: z.iso.datetime(),
    quality: z.enum(["observed-interval", "start-unobserved", "clock-inconsistent"]),
    schedulerAccounting: z.literal("unavailable"),
  }),
});
export type FederationTerminalEvidence = z.infer<typeof FederationTerminalEvidenceSchema>;
