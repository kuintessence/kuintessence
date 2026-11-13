import { FederationDigestSchema } from "@kuintessence/shared/federation";
import {
  MarketAdapterProposalInputSchema,
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { materialDigest } from "./asset-material";

export function marketIdentity(input: z.infer<typeof MarketAdapterProposalInputSchema>) {
  switch (input.operation) {
    case "publish-demand":
      return { id: input.demand.demandId, demandId: input.demand.demandId };
    case "claim-demand":
      return { id: input.claim.claimId, demandId: input.claim.demandId };
    case "cancel-open-demand":
      return { id: input.cancellation.cancellationId, demandId: input.cancellation.demandId };
    case "activate-demand":
      return { id: input.activation.activationId, demandId: input.activation.demandId };
    case "authorize-execution":
      return { id: input.authorization.authorizationId, demandId: input.authorization.demandId };
    case "request-execution-stop":
      return { id: input.stop.stopId, demandId: input.stop.demandId };
    default:
      return { id: input.closure.closureId, demandId: input.closure.demandId };
  }
}

const State = z.enum(["pending", "committed", "needs_review", "closed"]);
export const MarketAcceptedSchema = z.object({ id: z.uuid(), demandId: z.uuid(), state: State });
const Operation = MarketAcceptedSchema.extend({
  input: MarketAdapterProposalInputSchema,
  digest: FederationDigestSchema,
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((row, ctx) => {
  const identity = marketIdentity(row.input);
  if (row.id !== identity.id || row.demandId !== identity.demandId)
    ctx.addIssue({ code: "custom", message: "Market operation identity mismatch" });
});
export const MarketOperationsSchema = z.object({
  enabled: z.boolean(),
  data: z.array(Operation).max(20),
  hasMore: z.boolean(),
});
export const MarketOperationDetailSchema = z.object({
  enabled: z.boolean(),
  operation: Operation,
  transactions: z
    .array(
      z.object({
        number: z.number().int().positive(),
        transactionId: z.string().regex(/^[a-f0-9]{64}$/),
        stage: z.enum(["proposal", "transaction", "committed", "invalid", "abandoned"]),
        validationCode: z.number().int().nullable(),
        blockNumber: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .nullable(),
      }),
    )
    .max(20),
  hasMore: z.boolean(),
});

export async function verifyMarketOperation(row: z.infer<typeof Operation>, localSiteId: string) {
  if (
    row.digest !== (await materialDigest(row.input)) ||
    (row.input.operation === "publish-demand" && row.input.demand.sourceSiteId !== localSiteId) ||
    (row.input.operation === "claim-demand" && row.input.claim.providerSiteId !== localSiteId)
  )
    throw new Error("Market operation scope or digest mismatch");
  return row;
}

export function marketCapability(input: MarketProposalInput) {
  return input.operation === "claim-demand" ? "market.claim" : "market.publish";
}
