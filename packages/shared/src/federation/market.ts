import { z } from "zod";
import { FederationResourcesSchema } from "./index";
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
  expectedVersion: Version,
  expiresAt: z.iso.datetime(),
});
export type MarketClaim = z.infer<typeof MarketClaimSchema>;
export const MarketCancelOpenSchema = z.strictObject({
  demandId: Id,
  cancellationId: Id,
  expectedVersion: Version,
});
export const MarketDemandStateSchema = z.strictObject({
  demand: MarketDemandSchema,
  digest: FederationDigestSchema,
  version: Version,
  status: z.enum(["OPEN", "CLAIMED", "CANCELLED"]),
  claim: MarketClaimSchema.nullable(),
  cancellation: MarketCancelOpenSchema.nullable(),
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
