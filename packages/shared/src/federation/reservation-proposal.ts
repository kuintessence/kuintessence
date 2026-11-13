import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** Durable receipt only; approval, ledger commit and execution consent have separate records. */
export const ReservationProposalReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("reservation-proposal-receipt"),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    agreementRevisionId: z.uuid(),
    reservationId: z.uuid(),
    proposalDigest: FederationDigestSchema,
    receivedAt: z.iso.datetime(),
  })
  .refine(
    (value) => value.senderSiteId !== value.recipientSiteId,
    "Distinct institutions required",
  );
