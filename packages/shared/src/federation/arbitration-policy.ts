import { z } from "zod";
import { CommercialDisclosurePolicySchema } from "./disclosure-authorization";
import { CommercialDisputeSubjectSchema } from "./disputes";
import { FederationAmountSchema, FederationDelegationSchema } from "./index";
import { FederationDigestSchema } from "./references";

const terms = {
  policyId: z.uuid(),
  arbitratorSiteId: z.uuid(),
  subjectTypes: CommercialDisputeSubjectSchema.shape.recordType.array().min(1).max(5),
  disclosures: CommercialDisclosurePolicySchema.shape.disclosures,
  requiredEvidence: CommercialDisclosurePolicySchema.shape.disclosures,
  decisionRule: z.literal("designated-arbitrator"),
  actions: z.enum(["resolve-without-financial-change", "settle", "adjust"]).array().min(1).max(3),
  maxChargedAmount: FederationAmountSchema,
  validUntil: z.iso.datetime(),
};
function validSelections(value: z.infer<typeof Draft>) {
  if (
    new Set(value.subjectTypes).size !== value.subjectTypes.length ||
    new Set(value.actions).size !== value.actions.length ||
    (value.actions.every((action) => action === "resolve-without-financial-change") &&
      value.maxChargedAmount !== "0")
  )
    return false;
  for (const selections of [value.disclosures, value.requiredEvidence])
    if (
      new Set(selections.map((s) => s.recordType)).size !== selections.length ||
      selections.some((s) => new Set(s.fields).size !== s.fields.length)
    )
      return false;
  return value.requiredEvidence.every((required) => {
    const allowed = value.disclosures.find((s) => s.recordType === required.recordType);
    const fields = new Set<string>(allowed?.fields);
    return !!allowed && required.fields.every((field) => fields.has(field));
  });
}
const Draft = z.strictObject(terms);
export const CommercialArbitrationPolicyDraftSchema = Draft.refine(
  validSelections,
  "Invalid arbitration authority or evidence selection",
);

/** A policy is usable only after both signatures and an immutable original admission binding. */
export const CommercialArbitrationPolicySchema = z
  .strictObject({
    ...terms,
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-arbitration-policy"),
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    unit: FederationDelegationSchema.shape.unit,
    issuedAt: z.iso.datetime(),
    validFrom: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(validSelections, "Invalid arbitration authority or evidence selection")
  .refine(
    (v) =>
      new Set([v.sourceSiteId, v.targetSiteId, v.arbitratorSiteId]).size === 3 &&
      Date.parse(v.issuedAt) <= Date.parse(v.validFrom) &&
      Date.parse(v.validFrom) < Date.parse(v.validUntil),
    "Invalid arbitration parties or validity window",
  );
export type CommercialArbitrationPolicy = z.infer<typeof CommercialArbitrationPolicySchema>;

export const CommercialArbitrationPolicyApprovalSchema = z
  .object({
    localSiteId: z.uuid(),
    localOrgId: z.uuid(),
    agreementRevisionId: z.uuid(),
    policyId: z.uuid(),
    arbitratorSiteId: z.uuid(),
    payload: CommercialArbitrationPolicySchema,
    digest: FederationDigestSchema,
    approvalJws: z.string().min(1).max(524288),
    counterpartyJws: z.string().min(1).max(524288).nullable(),
    approvedBy: z.uuid(),
    confirmedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revokedBy: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .refine(
    (v) =>
      v.policyId === v.payload.policyId &&
      v.agreementRevisionId === v.payload.agreementRevisionId &&
      v.arbitratorSiteId === v.payload.arbitratorSiteId &&
      [v.payload.sourceSiteId, v.payload.targetSiteId].includes(v.localSiteId) &&
      (v.counterpartyJws === null) === (v.confirmedAt === null) &&
      (v.revokedAt === null) === (v.revokedBy === null),
    "Inconsistent arbitration policy approval",
  );
export const CommercialArbitrationPolicyListSchema = z.object({
  data: CommercialArbitrationPolicyApprovalSchema.array(),
  hasMore: z.boolean(),
});
