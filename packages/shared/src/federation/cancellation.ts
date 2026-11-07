import { z } from "zod";
import { FederationDigestSchema } from "./references";
import { FederationStatusReportSchema } from "./status";

const Identity = {
  protocolVersion: z.literal(1),
  operationId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  taskId: z.uuid(),
  attempt: z.number().int().positive().max(2_147_483_647),
  requestDigest: FederationDigestSchema,
};

/** Permanent withdrawal of one immutable operation; retries cannot resume it. */
export const FederationCancellationSchema = z
  .strictObject({
    ...Identity,
    kind: z.literal("cancellation"),
    issuedAt: z.iso.datetime(),
  })
  .refine((v) => v.senderSiteId !== v.recipientSiteId, "Different sites required");
export type FederationCancellation = z.infer<typeof FederationCancellationSchema>;

export const FederationCancellationReceiptSchema = z.strictObject({
  ...Identity,
  kind: z.literal("cancellation-receipt"),
  cancellationDigest: FederationDigestSchema,
  recordedAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  reservationId: z.uuid().nullable(),
  state: z.enum(["pending", "stopped"]),
  workflow: FederationStatusReportSchema.shape.workflow,
});
export type FederationCancellationReceipt = z.infer<typeof FederationCancellationReceiptSchema>;
