import { z } from "zod";
import { CommercialReservationSchema } from "./commercial";
import { MarketDemandSchema } from "./market";
import { FederationDigestSchema } from "./references";

/** Private pre-claim intent. Only demand is allowed into the public market. */
export const MarketRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("market-request"),
    demand: MarketDemandSchema,
    proposal: CommercialReservationSchema,
  })
  .superRefine(({ demand, proposal }, ctx) => {
    const request = proposal.request;
    if (
      request.mode !== "ledger_coordinated" ||
      proposal.reservationId !== request.operationId ||
      proposal.claimVersion !== 2 ||
      demand.demandId !== proposal.demandId ||
      demand.sourceSiteId !== request.senderSiteId ||
      demand.expiresAt !== request.expiresAt ||
      Object.entries(request.resources).some(
        ([key, value]) => demand.resources[key as keyof typeof demand.resources] !== value,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Market demand must match the original initial reservation",
      });
  });
export type MarketRequest = z.infer<typeof MarketRequestSchema>;

/** Reception is not a claim; claimed still needs independent ledger and reservation checks. */
export const MarketRequestReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("market-request-receipt"),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    reservationId: z.uuid(),
    requestDigest: FederationDigestSchema,
    state: z.enum(["received", "claimed"]),
    observedAt: z.iso.datetime(),
  })
  .refine((v) => v.senderSiteId !== v.recipientSiteId);
