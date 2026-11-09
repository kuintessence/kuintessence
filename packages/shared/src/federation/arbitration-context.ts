import { z } from "zod";
import {
  CommercialArbitrationPolicySchema,
  CommercialArbitrationTaskBindingSchema,
} from "./arbitration-policy";
import { CommercialReceiptSchema } from "./commercial";
import { CommercialEvidenceCaseInputSchema } from "./disclosure-authorization";
import { CommercialDisputeFinancialViewSchema, CommercialDisputeSubjectSchema } from "./disputes";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "./index";
import { FederationDigestSchema } from "./references";

const identity = {
  protocolVersion: z.literal(1),
  readId: z.uuid(),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  scope: CommercialEvidenceCaseInputSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};
function window(value: { issuedAt: string; expiresAt: string }) {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  return duration > 0 && duration <= 60000;
}
export const ArbitrationContextQuerySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-context-query"),
  })
  .refine(
    (v) =>
      window(v) &&
      v.senderSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.recipientSiteId),
  );
export type ArbitrationContextQuery = z.infer<typeof ArbitrationContextQuerySchema>;

export const ArbitrationEvidenceReferenceSchema = z.strictObject({
  recordType: z.enum(["agreement", "usage", "bill", "settlement", "adjustment", "payment"]),
  recordId: z.uuid(),
  recordDigest: FederationDigestSchema,
});
export const ArbitrationFinancialViewSchema = z.strictObject({
  headDigest: FederationDigestSchema,
  freezeDigest: FederationDigestSchema,
  records: CommercialDisputeFinancialViewSchema.shape.records,
  evidenceReferences: ArbitrationEvidenceReferenceSchema.array(),
  ledgerReceipt: CommercialReceiptSchema.nullable(),
});
export const ArbitrationFinancialContextSchema = ArbitrationFinancialViewSchema.extend({
  sourceJws: z.string().min(1).max(524288),
  targetJws: z.string().min(1).max(524288),
});

/** A current observation, never a freeze confirmation or permission to execute an award. */
export const ArbitrationContextSchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-context"),
    queryDigest: FederationDigestSchema,
    binding: CommercialArbitrationTaskBindingSchema,
    subject: CommercialDisputeSubjectSchema,
    financial: ArbitrationFinancialContextSchema.nullable(),
    sourceJws: z.string().min(1).max(524288),
    targetJws: z.string().min(1).max(524288),
  })
  .refine(
    (v) =>
      window(v) &&
      v.recipientSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.senderSiteId),
  );
export type ArbitrationContext = z.infer<typeof ArbitrationContextSchema>;

export function assertArbitrationContext(
  query: ArbitrationContextQuery,
  digest: string,
  response: ArbitrationContext,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  assertFederationStatusQueryFresh(response, now);
  const b = response.binding,
    s = query.scope;
  if (
    response.queryId !== query.queryId ||
    response.readId !== query.readId ||
    response.queryDigest !== digest ||
    response.senderSiteId !== query.recipientSiteId ||
    response.recipientSiteId !== query.senderSiteId ||
    federationCanonicalJson(response.scope) !== federationCanonicalJson(s) ||
    b.arbitratorSiteId !== s.evidenceRecipientSiteId ||
    (
      [
        "caseId",
        "domainId",
        "agreementRevisionId",
        "agreementDigest",
        "sourceSiteId",
        "targetSiteId",
      ] as const
    ).some((k) => b[k] !== s[k])
  )
    throw new FederationError("POLICY_DENIED");
  if (
    Date.parse(response.expiresAt) > Date.parse(query.expiresAt) ||
    Date.parse(response.issuedAt) < Date.parse(query.issuedAt) - 60000 ||
    Date.parse(b.observedAt) < Date.parse(response.issuedAt) - 60000 ||
    Date.parse(b.observedAt) > Date.parse(response.issuedAt)
  )
    throw new FederationError("AUTHORIZATION_EXPIRED");
}

export const ArbitrationContextViewSchema = z.strictObject({
  readId: z.uuid(),
  binding: CommercialArbitrationTaskBindingSchema,
  policy: CommercialArbitrationPolicySchema,
  subject: CommercialDisputeSubjectSchema,
  financial: ArbitrationFinancialViewSchema.nullable(),
  observations: z.tuple([
    z.strictObject({ siteId: z.uuid(), observedAt: z.iso.datetime() }),
    z.strictObject({ siteId: z.uuid(), observedAt: z.iso.datetime() }),
  ]),
  expiresAt: z.iso.datetime(),
});

export const ArbitrationReviewInputSchema = z
  .strictObject({
    grantIds: z.uuid().array().max(64),
  })
  .refine((v) => new Set(v.grantIds).size === v.grantIds.length, "Duplicate disclosure grants");
export const ArbitrationReviewSchema = z.strictObject({
  context: ArbitrationContextViewSchema,
  evidence: z.array(
    ArbitrationEvidenceReferenceSchema.extend({
      grantId: z.uuid(),
      disclosureDigest: FederationDigestSchema,
      fields: z.string().array(),
    }),
  ),
  expiresAt: z.iso.datetime(),
});
