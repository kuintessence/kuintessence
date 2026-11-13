import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** A permanent withdrawal of one exact policy; it does not undo accepted tasks or financial records. */
export const CommercialArbitrationRevocationSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-arbitration-revocation"),
    revocationId: z.uuid(),
    policyId: z.uuid(),
    policyDigest: FederationDigestSchema,
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    issuerSiteId: z.uuid(),
    issuedAt: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (value) =>
      value.sourceSiteId !== value.targetSiteId &&
      [value.sourceSiteId, value.targetSiteId].includes(value.issuerSiteId),
    "Only a contracting institution can withdraw arbitration consent",
  );
export type CommercialArbitrationRevocation = z.infer<typeof CommercialArbitrationRevocationSchema>;
export const CommercialArbitrationRevocationEnvelopeSchema = z.strictObject({
  issuerSiteId: z.uuid(),
  revocationJws: z.string().min(1).max(524288),
});
