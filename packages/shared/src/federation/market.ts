import { z } from "zod";
import { FederationResourcesSchema } from "./index";
import { FabricEvidenceAdvanceResultSchema, FabricProposalCheckpointSchema } from "./ledger";
import { FederationDigestSchema } from "./references";

const Id = z.uuid();
const Version = z.number().int().min(1).max(2147483647);
/** Explicitly public fields only. Prices, usage, contracts and real user identities belong in PDC/off chain. */
export const MarketDemandSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    demandId: Id,
    sourceSiteId: Id,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(4096),
    platform: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    architecture: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    resources: FederationResourcesSchema,
  })
  .refine(
    (value) => Date.parse(value.createdAt) < Date.parse(value.expiresAt),
    "Invalid demand interval",
  );
export type MarketDemand = z.infer<typeof MarketDemandSchema>;
export const MarketClaimSchema = z.strictObject({
  demandId: Id,
  claimId: Id,
  providerSiteId: Id,
  commercialDomainId: Id.optional(),
  expectedVersion: Version,
  expiresAt: z.iso.datetime(),
});
export type MarketClaim = z.infer<typeof MarketClaimSchema>;
export const MarketCancelOpenSchema = z.strictObject({
  demandId: Id,
  cancellationId: Id,
  expectedVersion: Version,
});
/** Public preimage of a private gate hash; contains no amount, price or contract body. */
export const MarketExecutionGateSchema = z.strictObject({
  domainId: Id,
  reservationId: Id,
  demandId: Id,
  claimVersion: Version,
  version: Version,
  state: z.enum(["READY", "REVOKED"]),
  reservationDigest: FederationDigestSchema,
  expiresAt: z.iso.datetime(),
});
export const MarketActivationSchema = z.strictObject({
  demandId: Id,
  activationId: Id,
  expectedVersion: Version,
  gate: MarketExecutionGateSchema,
});
export const MarketDemandStateSchema = z.strictObject({
  demand: MarketDemandSchema,
  digest: FederationDigestSchema,
  version: Version,
  status: z.enum(["OPEN", "CLAIMED", "CANCELLED", "ACTIVE"]),
  claim: MarketClaimSchema.nullable(),
  cancellation: MarketCancelOpenSchema.nullable(),
  activation: MarketActivationSchema.nullable().default(null),
});
export const MarketReceiptSchema = z.strictObject({
  recordId: Id,
  digest: FederationDigestSchema,
});
export const FabricMarketTrustSchema = z
  .strictObject({
    version: z.literal(1),
    generationId: Id,
    organizations: z
      .array(
        z.strictObject({
          siteId: Id,
          mspId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
        }),
      )
      .min(2)
      .max(50),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.organizations.map((o) => o.siteId)).size !== value.organizations.length ||
      new Set(value.organizations.map((o) => o.mspId)).size !== value.organizations.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate market organization" });
  });
export type FabricMarketTrust = z.infer<typeof FabricMarketTrustSchema>;

export const MarketProposalInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("publish-demand"), demand: MarketDemandSchema }),
  z.strictObject({ operation: z.literal("claim-demand"), claim: MarketClaimSchema }),
  z.strictObject({
    operation: z.literal("cancel-open-demand"),
    cancellation: MarketCancelOpenSchema,
  }),
]);
export type MarketProposalInput = z.infer<typeof MarketProposalInputSchema>;
/** Public HTTP intent remains narrower until execution approval is wired. */
export const MarketAdapterProposalInputSchema = z.discriminatedUnion("operation", [
  ...MarketProposalInputSchema.options,
  z.strictObject({ operation: z.literal("activate-demand"), activation: MarketActivationSchema }),
]);
export type MarketAdapterProposalInput = z.infer<typeof MarketAdapterProposalInputSchema>;

export const FabricMarketAdvanceResultSchema = z.discriminatedUnion("state", [
  FabricProposalCheckpointSchema.extend({ state: z.literal("prepared") }),
  FabricProposalCheckpointSchema.extend({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("committed"),
    transactionId: z.string().regex(/^[a-f0-9]{64}$/),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  }),
  FabricEvidenceAdvanceResultSchema.options[3],
]);
export type MarketAdvanceResult = z.infer<typeof FabricMarketAdvanceResultSchema>;

export const MarketPageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(50),
  bookmark: z.string().max(4096),
});
export const MarketQueryInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list-demands"), ...MarketPageRequestSchema.shape }),
  z.strictObject({ operation: z.literal("get-demand"), demandId: Id }),
]);
export type MarketQueryInput = z.infer<typeof MarketQueryInputSchema>;
export const MarketPageSchema = z.strictObject({
  demands: z.array(MarketDemandStateSchema).max(50),
  bookmark: z.string().max(4096),
});
export const MarketQueryResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list-demands"), ...MarketPageSchema.shape }),
  z.strictObject({
    operation: z.literal("get-demand"),
    demand: MarketDemandStateSchema.nullable(),
  }),
]);
export type MarketQueryResult = z.infer<typeof MarketQueryResultSchema>;
