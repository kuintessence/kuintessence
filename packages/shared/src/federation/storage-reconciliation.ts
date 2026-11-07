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
export type FederationStorageReconciliationRecord = FederationStorageReconciliation & {
  actorId: string;
  recordedAt: string;
};
