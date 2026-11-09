import { z } from "zod";

export const FederationCapabilitySchema = z.enum([
  "agreement.read",
  "agreement.approve",
  "billing.approve",
  "settlement.approve",
  "adjustment.approve",
  "asset.read",
  "asset.map",
  "media.import",
  "media.export",
  "media.logistics",
  "dataset.use.approve",
  "delegation.read",
  "delegation.submit",
  "delegation.cancel",
  "result.read",
  "market.read",
  "market.publish",
  "market.claim",
]);
export type FederationCapability = z.infer<typeof FederationCapabilitySchema>;

/** Explicit grants that satisfy a requested capability; platform roles never imply one. */
export function federationCapabilitySources(
  capability: FederationCapability,
): readonly FederationCapability[] {
  return capability === "market.read"
    ? ["market.read", "market.publish", "market.claim"]
    : capability === "agreement.read"
      ? [
          "agreement.read",
          "agreement.approve",
          "billing.approve",
          "settlement.approve",
          "adjustment.approve",
        ]
      : capability === "delegation.read"
        ? ["delegation.read", "delegation.submit", "delegation.cancel"]
        : capability === "delegation.cancel"
          ? ["delegation.cancel", "delegation.submit"]
          : capability === "asset.read"
            ? ["asset.read", "asset.map"]
            : [capability];
}

export const FederationCapabilityChangeSchema = z.strictObject({
  orgId: z.uuid(),
  userId: z.uuid(),
  capability: FederationCapabilitySchema,
  enabled: z.boolean(),
});
export const FederationCapabilityGrantSchema = z.object({
  orgId: z.uuid(),
  userId: z.uuid(),
  capability: FederationCapabilitySchema,
  grantedBy: z.uuid(),
  grantedAt: z.iso.datetime(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  suspended: z.boolean().nullable(),
  serviceAccount: z.boolean().nullable(),
  membershipActive: z.boolean(),
});
export type FederationCapabilityGrant = z.infer<typeof FederationCapabilityGrantSchema>;
export const FederationMemberOptionSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
});
export const FederationMemberOptionsSchema = z.object({
  data: z.array(FederationMemberOptionSchema),
  hasMore: z.boolean(),
});
export const FederationCurrentCapabilitiesSchema = z.object({
  orgId: z.uuid(),
  userId: z.uuid(),
  grants: z.array(FederationCapabilitySchema),
  effectiveCapabilities: z.array(FederationCapabilitySchema),
});
