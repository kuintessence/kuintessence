import { z } from "zod";
import { FederationError } from "./errors";
import { FEDERATION_MEDIA_MAX_BYTES, FEDERATION_MEDIA_MAX_FILES } from "./media";
import { FederationDigestSchema } from "./references";

/** A historical custody statement, never a use/download authorization. */
export const FederationMediaReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("media-import-receipt"),
    receiptId: z.uuid(),
    generation: z.uuid(),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    packageId: z.uuid(),
    agreementRevisionId: z.uuid(),
    manifestDigest: FederationDigestSchema,
    keyQueryId: z.uuid(),
    keyQueryDigest: FederationDigestSchema,
    state: z.literal("verified-private"),
    fileCount: z.number().int().min(1).max(FEDERATION_MEDIA_MAX_FILES),
    sizeBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
    receivedAt: z.iso.datetime(),
  })
  .refine((r) => r.senderSiteId !== r.recipientSiteId);
export type FederationMediaReceipt = z.infer<typeof FederationMediaReceiptSchema>;
export const FederationMediaReceiptAckSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("media-import-receipt-ack"),
    receiptId: z.uuid(),
    packageId: z.uuid(),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    receiptDigest: FederationDigestSchema,
    recordedAt: z.iso.datetime(),
  })
  .refine((r) => r.senderSiteId !== r.recipientSiteId);
export type FederationMediaReceiptAck = z.infer<typeof FederationMediaReceiptAckSchema>;
export function assertMediaReceiptAck(
  receipt: FederationMediaReceipt,
  digest: string,
  ack: FederationMediaReceiptAck,
  now: Date,
) {
  if (
    ack.receiptId !== receipt.receiptId ||
    ack.packageId !== receipt.packageId ||
    ack.receiptDigest !== digest ||
    ack.senderSiteId !== receipt.recipientSiteId ||
    ack.recipientSiteId !== receipt.senderSiteId ||
    Date.parse(ack.recordedAt) > now.getTime() + 60_000 ||
    Date.parse(ack.recordedAt) < Date.parse(receipt.receivedAt) - 60_000
  )
    throw new FederationError("INVALID_MESSAGE");
}
