import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** Local operator attestation, never a peer assertion or an automatic storage observation. */
export const FederationStorageReconciliationSchema = z.strictObject({
  snapshotDigest: FederationDigestSchema,
  stoppedAt: z.iso.datetime(),
  incidentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  evidenceDigest: FederationDigestSchema,
  allWritersStopped: z.literal(true),
  storageRequestsDrained: z.literal(true),
});
export type FederationStorageReconciliation = z.infer<typeof FederationStorageReconciliationSchema>;
export const FederationStorageReconciliationRecordSchema =
  FederationStorageReconciliationSchema.extend({
    actorId: z.uuid(),
    recordedAt: z.iso.datetime(),
  });
export type FederationStorageReconciliationRecord = z.infer<
  typeof FederationStorageReconciliationRecordSchema
>;

export const FederationInputReconciliationCandidateSchema = z.object({
  generation: z.uuid(),
  importId: z.uuid(),
  reservationId: z.uuid(),
  leaseUntil: z.iso.datetime(),
  reconciliation: FederationStorageReconciliationRecordSchema.nullable(),
});
export const FederationInputReconciliationPlanSchema =
  FederationInputReconciliationCandidateSchema.extend({
    localSiteId: z.uuid(),
    transferId: z.uuid(),
    storageKey: z.string(),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    allocationStartedAt: z.iso.datetime().nullable(),
    uploadId: z.string().nullable(),
    completionStartedAt: z.iso.datetime().nullable(),
    completionSettledAt: z.iso.datetime().nullable(),
    destinationVersionId: z.string().nullable(),
    destinationEtag: z.string().nullable(),
    snapshotDigest: FederationDigestSchema,
    state: z.enum([
      "preparing",
      "copying",
      "assembling",
      "verifying",
      "verified",
      "available",
      "cleanup_pending",
      "cleaned",
    ]),
    importState: z.enum(["pending", "transferring", "available", "cancelling", "cancelled"]),
    executionStopped: z.boolean(),
  });
export type FederationInputReconciliationPlan = z.infer<
  typeof FederationInputReconciliationPlanSchema
>;
