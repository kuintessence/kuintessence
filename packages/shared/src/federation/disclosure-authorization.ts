import { z } from "zod";
import { federationCanonicalJson } from "./assets";
import { CommercialAgreementEnvelopeSchema } from "./commercial";
import {
  type CommercialDisclosureGrant,
  CommercialDisclosureGrantSchema,
  CommercialDisclosureSchema,
} from "./disclosure";
import { FederationError } from "./errors";
import { FederationDigestSchema } from "./references";
import type { FederationVerificationKey } from "./signatures";
import { assertFederationStatusQueryFresh } from "./status";

const selection = { recordType: true, fields: true } as const;
const selections = CommercialDisclosureGrantSchema.options;
const Selection = z.discriminatedUnion("recordType", [
  selections[0].pick(selection),
  selections[1].pick(selection),
  selections[2].pick(selection),
  selections[3].pick(selection),
  selections[4].pick(selection),
  selections[5].pick(selection),
]);

/** Read authority only; no permission to arbitrate, debit, change a bill or transfer money. */
export const CommercialDisclosurePolicySchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-disclosure-policy"),
    policyId: z.uuid(),
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    disclosures: Selection.array().min(1).max(6),
    issuedAt: z.iso.datetime(),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (v) =>
      new Set([v.sourceSiteId, v.targetSiteId, v.recipientSiteId]).size === 3 &&
      new Set(v.disclosures.map((s) => s.recordType)).size === v.disclosures.length &&
      v.disclosures.every((s) => new Set(s.fields).size === s.fields.length) &&
      Date.parse(v.issuedAt) <= Date.parse(v.validFrom) &&
      Date.parse(v.validFrom) < Date.parse(v.validUntil),
    "Invalid disclosure policy",
  );
export type CommercialDisclosurePolicy = z.infer<typeof CommercialDisclosurePolicySchema>;

export const CommercialDisclosurePolicyDraftSchema = z
  .strictObject({
    policyId: CommercialDisclosurePolicySchema.shape.policyId,
    recipientSiteId: CommercialDisclosurePolicySchema.shape.recipientSiteId,
    disclosures: CommercialDisclosurePolicySchema.shape.disclosures,
    validUntil: CommercialDisclosurePolicySchema.shape.validUntil,
  })
  .refine(
    (v) =>
      new Set(v.disclosures.map((s) => s.recordType)).size === v.disclosures.length &&
      v.disclosures.every((s) => new Set(s.fields).size === s.fields.length),
    "Duplicate disclosure selector",
  );
export const CommercialDisclosurePolicyApprovalSchema = z
  .object({
    localSiteId: z.uuid(),
    localOrgId: z.uuid(),
    agreementRevisionId: z.uuid(),
    policyId: z.uuid(),
    recipientSiteId: z.uuid(),
    payload: CommercialDisclosurePolicySchema,
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
      v.recipientSiteId === v.payload.recipientSiteId &&
      [v.payload.sourceSiteId, v.payload.targetSiteId].includes(v.localSiteId) &&
      (v.counterpartyJws === null) === (v.confirmedAt === null) &&
      (v.revokedAt === null) === (v.revokedBy === null),
    "Inconsistent disclosure policy approval",
  );
export const CommercialDisclosurePolicyListSchema = z.object({
  data: CommercialDisclosurePolicyApprovalSchema.array(),
  hasMore: z.boolean(),
});

/** Caller checks approvals and revocation first. Scope is checked again before signing a projection. */
export function assertCommercialDisclosurePolicy(
  rawGrant: CommercialDisclosureGrant,
  rawPolicy: CommercialDisclosurePolicy,
  policyDigest: string,
  now: Date,
) {
  try {
    const grant = CommercialDisclosureGrantSchema.parse(rawGrant);
    const policy = CommercialDisclosurePolicySchema.parse(rawPolicy);
    const allowed = policy.disclosures.find((s) => s.recordType === grant.recordType);
    const allowedFields = new Set<string>(allowed?.fields);
    if (
      !allowed ||
      !Number.isFinite(now.getTime()) ||
      grant.policyId !== policy.policyId ||
      grant.policyDigest !== policyDigest ||
      grant.domainId !== policy.domainId ||
      grant.agreementRevisionId !== policy.agreementRevisionId ||
      grant.sourceSiteId !== policy.sourceSiteId ||
      grant.targetSiteId !== policy.targetSiteId ||
      grant.recipientSiteId !== policy.recipientSiteId ||
      Date.parse(grant.validFrom) < Date.parse(policy.validFrom) ||
      Date.parse(grant.validUntil) > Date.parse(policy.validUntil) ||
      now.getTime() < Date.parse(grant.validFrom) ||
      now.getTime() >= Date.parse(grant.validUntil) ||
      !grant.fields.every((field) => allowedFields.has(field))
    )
      throw new FederationError("POLICY_DENIED");
  } catch {
    throw new FederationError("POLICY_DENIED");
  }
}

const boundFields = [
  "grantId",
  "caseId",
  "policyId",
  "policyDigest",
  "domainId",
  "agreementRevisionId",
  "sourceSiteId",
  "targetSiteId",
  "recipientSiteId",
  "recordType",
  "recordId",
  "recordDigest",
] as const;
export type CommercialDisclosureContext = Pick<
  CommercialDisclosureGrant,
  (typeof boundFields)[number]
> & {
  agreementDigest: string;
  policyRevoked: boolean;
  grantRevoked: boolean;
};

async function bilateral<T extends { kind: string }>(
  schema: z.ZodType<T>,
  rawEnvelope: z.infer<typeof CommercialAgreementEnvelopeSchema>,
  keys: readonly FederationVerificationKey[],
  context: CommercialDisclosureContext,
  now: Date,
) {
  const envelope = CommercialAgreementEnvelopeSchema.parse(rawEnvelope);
  if (
    envelope.sourceSiteId !== context.sourceSiteId ||
    envelope.targetSiteId !== context.targetSiteId
  )
    throw new FederationError("UNTRUSTED_IDENTITY");
  const { federationMessageKeyId, verifyFederationMessage } = await import("./signatures");
  const verify = async (siteId: string, jws: string) => {
    const id = federationMessageKeyId(jws);
    const matches = keys.filter((key) => key.siteId === siteId && key.keyId === id);
    if (matches.length !== 1 || !matches[0]) throw new FederationError("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(schema, jws, matches[0], now);
  };
  const source = await verify(envelope.sourceSiteId, envelope.sourceJws);
  const target = await verify(envelope.targetSiteId, envelope.targetJws);
  if (source.digest !== target.digest) throw new FederationError("POLICY_DENIED");
  return { payload: source.payload, digest: source.digest };
}

/** Context/revocation and keys come from current local trust/case records, never the received body. */
export async function verifyCommercialDisclosure(
  policyEnvelope: z.infer<typeof CommercialAgreementEnvelopeSchema>,
  disclosureEnvelope: z.infer<typeof CommercialAgreementEnvelopeSchema>,
  keys: readonly FederationVerificationKey[],
  context: CommercialDisclosureContext,
  now: Date,
) {
  try {
    if (context.policyRevoked !== false || context.grantRevoked !== false)
      throw new FederationError("POLICY_DENIED");
    const policy = await bilateral(
      CommercialDisclosurePolicySchema,
      policyEnvelope,
      keys,
      context,
      now,
    );
    if (
      policy.payload.agreementDigest !== context.agreementDigest ||
      policy.digest !== context.policyDigest
    )
      throw new FederationError("POLICY_DENIED");
    const disclosure = await bilateral(
      CommercialDisclosureSchema,
      disclosureEnvelope,
      keys,
      context,
      now,
    );
    const grant = disclosure.payload.grant;
    if (boundFields.some((field) => grant[field] !== context[field]))
      throw new FederationError("POLICY_DENIED");
    assertCommercialDisclosurePolicy(grant, policy.payload, policy.digest, now);
    return { policy, disclosure };
  } catch (error) {
    if (error instanceof FederationError) throw error;
    throw new FederationError("INVALID_MESSAGE");
  }
}

/** Exact evidence selection; hashes bind fields/values without transporting them. */
export const CommercialDisclosureReadScopeSchema = z
  .strictObject({
    grantId: z.uuid(),
    disclosureDigest: FederationDigestSchema,
    caseId: z.uuid(),
    policyId: z.uuid(),
    policyDigest: FederationDigestSchema,
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    evidenceRecipientSiteId: z.uuid(),
  })
  .refine((v) => new Set([v.sourceSiteId, v.targetSiteId, v.evidenceRecipientSiteId]).size === 3);
export type CommercialDisclosureReadScope = z.infer<typeof CommercialDisclosureReadScopeSchema>;
const readIdentity = {
  protocolVersion: z.literal(1),
  readId: z.uuid(),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  scope: CommercialDisclosureReadScopeSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};
const readWindow = (v: { issuedAt: string; expiresAt: string }) => {
  const duration = Date.parse(v.expiresAt) - Date.parse(v.issuedAt);
  return duration > 0 && duration <= 30000;
};
export const CommercialDisclosureReadQuerySchema = z
  .strictObject({
    ...readIdentity,
    kind: z.literal("commercial-disclosure-read-query"),
  })
  .refine(
    (v) =>
      readWindow(v) &&
      v.senderSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.recipientSiteId),
  );
export type CommercialDisclosureReadQuery = z.infer<typeof CommercialDisclosureReadQuerySchema>;
export const CommercialDisclosureReadAuthorizationSchema = z
  .strictObject({
    ...readIdentity,
    kind: z.literal("commercial-disclosure-read-authorization"),
    queryDigest: FederationDigestSchema,
  })
  .refine(
    (v) =>
      readWindow(v) &&
      v.recipientSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.senderSiteId),
  );
export type CommercialDisclosureReadAuthorization = z.infer<
  typeof CommercialDisclosureReadAuthorizationSchema
>;

/** A short-lived observation, never permission to skip revocation checks at material delivery. */
export function assertCommercialDisclosureReadAuthorization(
  query: CommercialDisclosureReadQuery,
  queryDigest: string,
  authorization: CommercialDisclosureReadAuthorization,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  assertFederationStatusQueryFresh(authorization, now);
  if (
    authorization.senderSiteId !== query.recipientSiteId ||
    authorization.recipientSiteId !== query.senderSiteId ||
    authorization.queryId !== query.queryId ||
    authorization.readId !== query.readId ||
    authorization.queryDigest !== queryDigest ||
    federationCanonicalJson(authorization.scope) !== federationCanonicalJson(query.scope) ||
    Date.parse(authorization.expiresAt) > Date.parse(query.expiresAt) ||
    Date.parse(authorization.issuedAt) > now.getTime() ||
    Date.parse(authorization.issuedAt) < Date.parse(query.issuedAt) - 60000
  )
    throw new FederationError("INVALID_MESSAGE");
}

const readPairEntry = z.strictObject({
  queryJws: z.string().min(1).max(524288),
  authorizationJws: z.string().min(1).max(524288),
});
export const CommercialDisclosureReadPairSchema = z.tuple([readPairEntry, readPairEntry]);
export type CommercialDisclosureReadPair = z.infer<typeof CommercialDisclosureReadPairSchema>;
export const CommercialDisclosurePartSchema = z.enum([
  "policy-source",
  "policy-target",
  "disclosure-source",
  "disclosure-target",
]);
export const CommercialDisclosureDownloadQuerySchema = z
  .strictObject({
    ...readIdentity,
    kind: z.literal("commercial-disclosure-download-query"),
    part: CommercialDisclosurePartSchema,
    authorizations: CommercialDisclosureReadPairSchema,
  })
  .refine(
    (v) =>
      readWindow(v) &&
      v.senderSiteId === v.scope.evidenceRecipientSiteId &&
      [v.scope.sourceSiteId, v.scope.targetSiteId].includes(v.recipientSiteId),
  );
export type CommercialDisclosureDownloadQuery = z.infer<
  typeof CommercialDisclosureDownloadQuerySchema
>;

export const CommercialEvidenceCaseInputSchema = z
  .strictObject({
    caseId: z.uuid(),
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    evidenceRecipientSiteId: z.uuid(),
  })
  .refine((v) => new Set([v.sourceSiteId, v.targetSiteId, v.evidenceRecipientSiteId]).size === 3);
export type CommercialEvidenceCaseInput = z.infer<typeof CommercialEvidenceCaseInputSchema>;
export const CommercialDisclosureEvidenceSchema = z.strictObject({
  policy: CommercialAgreementEnvelopeSchema,
  disclosure: CommercialAgreementEnvelopeSchema,
});
export type CommercialDisclosureEvidence = z.infer<typeof CommercialDisclosureEvidenceSchema>;
