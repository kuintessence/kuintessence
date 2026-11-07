import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** A signed statement of completed local publication, not scientific or commercial acceptance. */
export const FederationResultReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("result-receipt"),
    receiptId: z.uuid(),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    operationId: z.uuid(),
    agreementRevisionId: z.uuid(),
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(2_147_483_647),
    reservationId: z.uuid(),
    requestDigest: FederationDigestSchema,
    manifestDigest: FederationDigestSchema,
    fileCount: z.number().int().min(0).max(256),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    receivedAt: z.iso.datetime(),
  })
  .refine(
    (value) =>
      value.senderSiteId !== value.recipientSiteId &&
      (value.fileCount !== 0 || value.sizeBytes === 0),
    "Invalid receipt identity or totals",
  );
export type FederationResultReceipt = z.infer<typeof FederationResultReceiptSchema>;

/** Confirms durable recording of the peer's claim, not independent proof of its storage. */
export const FederationResultReceiptAckSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("result-receipt-ack"),
    receiptId: z.uuid(),
    operationId: z.uuid(),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    receiptDigest: FederationDigestSchema,
    recordedAt: z.iso.datetime(),
  })
  .refine(
    (value) => value.senderSiteId !== value.recipientSiteId,
    "Invalid acknowledgement identity",
  );
export type FederationResultReceiptAck = z.infer<typeof FederationResultReceiptAckSchema>;
