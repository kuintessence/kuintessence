import { z } from "zod";
import { FederationAgreementSchema, FederationAmountSchema } from "./index";
import {
  FabricEvidenceAdvanceResultSchema,
  FabricEvidenceTrustSchema,
  FabricProposalCheckpointSchema,
  fabricEvidenceCollections,
} from "./ledger";
import { FederationDigestSchema } from "./references";

const Id = z.uuid();
const Salt = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveQuantity = z.string().regex(/^[1-9][0-9]{0,37}$/);
const Metric = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/);
export const CommercialSigningKindSchema = z.enum(["commercial-agreement", "commercial-usage"]);

/** Private rates use integer amount per integer quantity; the execution agreement fixes the money unit. */
export const CommercialAgreementSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-agreement"),
    domainId: Id,
    salt: Salt,
    createdAt: z.iso.datetime(),
    agreement: FederationAgreementSchema,
    consideration: z.enum(["charity", "exchange", "paid"]),
    priceVersionId: Id,
    prices: z
      .array(
        z.strictObject({
          metric: Metric,
          quantityUnit: Metric,
          perQuantity: PositiveQuantity,
          amount: FederationAmountSchema,
        }),
      )
      .min(1)
      .max(64),
    termsText: z.string().min(1).max(65536),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.prices.map((price) => price.metric)).size !== value.prices.length)
      ctx.addIssue({ code: "custom", message: "Duplicate price metric" });
    if (value.consideration === "charity" && value.prices.some((price) => price.amount !== "0"))
      ctx.addIssue({ code: "custom", message: "Charity cannot charge a unit price" });
  });
export type CommercialAgreement = z.infer<typeof CommercialAgreementSchema>;
export const CommercialAgreementEnvelopeSchema = z.strictObject({
  sourceSiteId: Id,
  targetSiteId: Id,
  sourceJws: z.string().min(1).max(524288),
  targetJws: z.string().min(1).max(524288),
});

/** Provider assertions and technical corrections remain immutable; neither confirms a bill or payment. */
export const CommercialUsageSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-usage"),
    reportId: Id,
    domainId: Id,
    agreementRevisionId: Id,
    agreementDigest: FederationDigestSchema,
    sourceSiteId: Id,
    targetSiteId: Id,
    taskId: Id,
    attempt: z.number().int().min(1).max(2147483647),
    salt: Salt,
    reportedAt: z.iso.datetime(),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    measurements: z
      .array(
        z.strictObject({
          metric: Metric,
          quantityUnit: Metric,
          quantity: FederationAmountSchema,
          evidenceDigest: FederationDigestSchema,
        }),
      )
      .min(1)
      .max(64),
    correctionOf: Id.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.sourceSiteId === value.targetSiteId ||
      Date.parse(value.periodStart) >= Date.parse(value.periodEnd) ||
      Date.parse(value.periodEnd) > Date.parse(value.reportedAt)
    )
      ctx.addIssue({ code: "custom", message: "Invalid usage identity or reporting interval" });
    if (
      new Set(value.measurements.map((item) => item.metric)).size !== value.measurements.length ||
      value.correctionOf === value.reportId
    )
      ctx.addIssue({ code: "custom", message: "Duplicate measurement or self correction" });
  });
export type CommercialUsage = z.infer<typeof CommercialUsageSchema>;
export const CommercialUsageEnvelopeSchema = z.strictObject({
  providerJws: z.string().min(1).max(524288),
});
export const CommercialReceiptSchema = z.strictObject({
  recordId: Id,
  digest: FederationDigestSchema,
});

/** Public lifecycle-governed purposes; registering a key never implies authority to sign every record. */
export const FabricCommercialTrustSchema = FabricEvidenceTrustSchema.safeExtend({
  keyPurposes: z
    .array(
      z.strictObject({
        siteId: Id,
        keyId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
        kinds: z.array(CommercialSigningKindSchema).min(1).max(2),
      }),
    )
    .min(2)
    .max(1000),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const item of value.keyPurposes) {
    const id = `${item.siteId}:${item.keyId}`;
    if (
      ids.has(id) ||
      new Set(item.kinds).size !== item.kinds.length ||
      !value.organizations
        .find((org) => org.siteId === item.siteId)
        ?.keys.some((key) => key.keyId === item.keyId)
    )
      ctx.addIssue({ code: "custom", message: "Invalid commercial signing purposes" });
    ids.add(id);
  }
  for (const org of value.organizations)
    for (const key of org.keys)
      if (!ids.has(`${org.siteId}:${key.keyId}`))
        ctx.addIssue({
          code: "custom",
          message: "Every commercial key requires explicit purposes",
        });
});
export type FabricCommercialTrust = z.infer<typeof FabricCommercialTrustSchema>;
export function fabricCommercialCollections(input: FabricCommercialTrust) {
  const trust = FabricCommercialTrustSchema.parse(input);
  return fabricEvidenceCollections({
    version: trust.version,
    generationId: trust.generationId,
    organizations: trust.organizations,
    domains: trust.domains,
  });
}

const ProposalIdentity = { domainId: Id, recordId: Id, digest: FederationDigestSchema };
export const CommercialProposalInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("register-agreement"),
    envelope: CommercialAgreementEnvelopeSchema,
  }),
  z.strictObject({
    ...ProposalIdentity,
    operation: z.literal("record-usage"),
    envelope: CommercialUsageEnvelopeSchema,
  }),
]);
export type CommercialProposalInput = z.infer<typeof CommercialProposalInputSchema>;
export const FabricCommercialAdvanceResultSchema = z.discriminatedUnion("state", [
  FabricProposalCheckpointSchema.extend({ state: z.literal("prepared") }),
  FabricProposalCheckpointSchema.extend({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("committed"),
    transactionId: z.string().regex(/^[a-f0-9]{64}$/),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  }),
  FabricEvidenceAdvanceResultSchema.options[3],
]);
export type CommercialAdvanceResult = z.infer<typeof FabricCommercialAdvanceResultSchema>;
