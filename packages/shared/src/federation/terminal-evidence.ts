import { z } from "zod";
import { SchedulerAccountingSchema } from "../scheduler-accounting";
import { FederationDigestSchema } from "./references";
import { FederationResultReceiptSchema } from "./result-receipts";

/** Receiver-private observations and optional scheduler assertions, never a bill. */
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
  accounting: SchedulerAccountingSchema.optional(),
  observation: z.strictObject({
    basis: z.literal("server-status-observation"),
    runningObservedAt: z.iso.datetime().nullable(),
    terminalObservedAt: z.iso.datetime(),
    quality: z.enum(["observed-interval", "start-unobserved", "clock-inconsistent"]),
    schedulerAccounting: z.enum(["reported", "unavailable"]),
  }),
});
export type FederationTerminalEvidence = z.infer<typeof FederationTerminalEvidenceSchema>;

/** Private supporting records for a terminal signature; never sent to the public market. */
export const FederationExecutionTerminalEvidenceSchema = z.strictObject({
  version: z.literal(1),
  reservationId: z.uuid(),
  activationId: z.uuid(),
  requestDigest: FederationDigestSchema,
  executionSnapshotDigest: FederationDigestSchema,
  workflow: z.strictObject({
    runId: z.uuid(),
    status: z.enum(["completed", "failed", "cancelled"]),
    completedAt: z.iso.datetime(),
  }),
  observedAt: z.iso.datetime(),
  input: z
    .strictObject({
      importId: z.uuid(),
      manifestDigest: FederationDigestSchema,
      state: z.enum(["available", "cancelled"]),
    })
    .nullable(),
  cancellation: z
    .strictObject({
      digest: FederationDigestSchema,
      confirmedAt: z.iso.datetime(),
    })
    .nullable(),
  jobs: z
    .array(
      z.strictObject({
        evidence: FederationTerminalEvidenceSchema,
        digest: FederationDigestSchema,
        cancellations: z.array(
          z.strictObject({
            id: z.uuid(),
            agentId: z.string(),
            revokedEpoch: z.number().int().nonnegative(),
            requiresInstallationStop: z.boolean(),
            acknowledgedAt: z.iso.datetime(),
          }),
        ),
        revocations: z.array(
          z.strictObject({
            id: z.uuid(),
            agentId: z.string(),
            revokedEpoch: z.number().int().nonnegative(),
            destroyRestrictedWorkRoot: z.boolean(),
            acknowledgedAt: z.iso.datetime(),
          }),
        ),
        installations: z.array(
          z.strictObject({
            id: z.uuid(),
            agentId: z.string(),
            status: z.enum(["succeeded", "failed", "rejected", "queued", "running"]),
            finishedAt: z.iso.datetime().nullable(),
            stopAcknowledgementId: z.uuid().nullable(),
          }),
        ),
      }),
    )
    .max(4096),
  result: z
    .strictObject({
      receipt: FederationResultReceiptSchema,
      receiptJws: z.string().min(1).max(524288),
    })
    .nullable(),
});
export type FederationExecutionTerminalEvidence = z.infer<
  typeof FederationExecutionTerminalEvidenceSchema
>;
