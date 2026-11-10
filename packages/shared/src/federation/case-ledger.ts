import { z } from "zod";
import { type ArbitrationDecision, ArbitrationOutcomeSchema } from "./arbitration-decision";
import { CommercialArbitrationTaskBindingSchema } from "./arbitration-policy";
import { CommercialAgreementEnvelopeSchema, CommercialReceiptSchema } from "./commercial";
import { CommercialDisclosureSchema } from "./disclosure";
import {
  CommercialDisclosureEvidenceSchema,
  CommercialDisclosureReadScopeSchema,
  verifyCommercialDisclosure,
} from "./disclosure-authorization";
import { FederationError } from "./errors";
import { FabricEvidenceTrustSchema } from "./ledger";
import { FederationDigestSchema } from "./references";
import {
  type FederationVerificationKey,
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "./signatures";

export const CaseSigningKindSchema = z.enum([
  "case-evidence-publication",
  "case-publication-revocation",
  "case-arbitration-decision",
  "commercial-disclosure-policy",
  "commercial-disclosure",
]);
export const CaseDomainSchema = z.strictObject({
  domainId: z.uuid(),
  commercialDomainId: z.uuid(),
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  collection: z.string().regex(/^case_[a-zA-Z0-9_]{1,58}$/),
});
export const FabricCaseTrustSchema = z
  .strictObject({
    version: z.literal(1),
    generationId: z.uuid(),
    organizations: FabricEvidenceTrustSchema.shape.organizations.min(3),
    domains: CaseDomainSchema.array().min(1).max(200),
    keyPurposes: z
      .strictObject({
        siteId: z.uuid(),
        keyId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
        kinds: CaseSigningKindSchema.array().min(1).max(5),
      })
      .array()
      .min(3)
      .max(1000),
  })
  .superRefine((value, ctx) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    const sites = value.organizations.map((org) => org.siteId);
    if (
      !unique(sites) ||
      !unique(value.organizations.map((org) => org.mspId)) ||
      !unique(value.domains.map((domain) => domain.domainId)) ||
      !unique(value.domains.map((domain) => domain.collection))
    )
      ctx.addIssue({ code: "custom", message: "Duplicate case trust identity" });
    for (const domain of value.domains) {
      const members = caseMembers(domain);
      if (
        !unique(members) ||
        members.some((site) => !sites.includes(site)) ||
        domain.domainId === domain.commercialDomainId
      )
        ctx.addIssue({ code: "custom", message: "Invalid case domain" });
    }
    const purposes = value.keyPurposes.map((key) => `${key.siteId}:${key.keyId}`);
    if (!unique(purposes)) ctx.addIssue({ code: "custom", message: "Duplicate key purpose" });
    for (const org of value.organizations) {
      if (!unique(org.keys.map((key) => key.keyId)))
        ctx.addIssue({ code: "custom", message: "Duplicate key" });
      for (const key of org.keys)
        if (!purposes.includes(`${org.siteId}:${key.keyId}`))
          ctx.addIssue({ code: "custom", message: "Missing key purpose" });
    }
    for (const purpose of value.keyPurposes)
      if (
        !unique(purpose.kinds) ||
        !value.organizations
          .find((org) => org.siteId === purpose.siteId)
          ?.keys.some((key) => key.keyId === purpose.keyId)
      )
        ctx.addIssue({ code: "custom", message: "Invalid key purpose" });
  });
export type FabricCaseTrust = z.infer<typeof FabricCaseTrustSchema>;
export type CaseDomain = z.infer<typeof CaseDomainSchema>;
export function caseMembers(domain: CaseDomain) {
  return [domain.sourceSiteId, domain.targetSiteId, domain.recipientSiteId];
}
export function fabricCaseCollections(raw: FabricCaseTrust) {
  const trust = FabricCaseTrustSchema.parse(raw);
  return trust.domains.map((domain) => {
    const msps = caseMembers(domain).map((site) => {
      const org = trust.organizations.find((value) => value.siteId === site);
      if (!org) throw new FederationError("UNTRUSTED_IDENTITY");
      return org.mspId;
    });
    return {
      name: domain.collection,
      policy: `OR(${msps.map((msp) => `'${msp}.member'`).join(",")})`,
      requiredPeerCount: 2,
      maxPeerCount: 2,
      blockToLive: 0,
      memberOnlyRead: true,
      memberOnlyWrite: true,
      endorsementPolicy: {
        signaturePolicy: `AND(${msps.map((msp) => `'${msp}.peer'`).join(",")})`,
      },
    };
  });
}

/** Separate A/B consent to durable PDC storage; a read grant alone never authorizes publication. */
export const CasePublicationSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("case-evidence-publication"),
    publicationId: z.uuid(),
    caseDomainId: z.uuid(),
    scope: CommercialDisclosureReadScopeSchema,
    issuedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => Date.parse(value.issuedAt) < Date.parse(value.validUntil));
export type CasePublication = z.infer<typeof CasePublicationSchema>;
export const CasePublicationDraftSchema = z.strictObject({
  publicationId: z.uuid(),
  caseDomainId: z.uuid(),
  grantId: z.uuid(),
  validUntil: z.iso.datetime(),
});
export const CaseEvidenceEnvelopeSchema = z.strictObject({
  publication: CommercialAgreementEnvelopeSchema,
  evidence: CommercialDisclosureEvidenceSchema,
});
export const CaseRevocationSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("case-publication-revocation"),
  revocationId: z.uuid(),
  caseDomainId: z.uuid(),
  publicationId: z.uuid(),
  publicationDigest: FederationDigestSchema,
  issuerSiteId: z.uuid(),
  issuedAt: z.iso.datetime(),
  salt: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CaseRevocation = z.infer<typeof CaseRevocationSchema>;
export const CasePublicationApprovalSchema = z.object({
  localSiteId: z.uuid(),
  publicationId: z.uuid(),
  agreementRevisionId: z.uuid(),
  grantId: z.uuid(),
  caseId: z.uuid(),
  localOrgId: z.uuid(),
  payload: CasePublicationSchema,
  digest: FederationDigestSchema,
  approvalJws: z.string(),
  counterpartyJws: z.string().nullable(),
  approvedBy: z.uuid(),
  confirmedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.uuid().nullable(),
  revocationPayload: CaseRevocationSchema.nullable(),
  revocationJws: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const CasePublicationListSchema = z.object({
  data: CasePublicationApprovalSchema.array(),
  hasMore: z.boolean(),
});
export const CaseRevocationEnvelopeSchema = z.strictObject({
  issuerSiteId: z.uuid(),
  jws: z.string().min(1).max(524288),
});
/** R attests a historical decision commitment, not its financial execution or confidential content. */
export const CaseArbitrationDecisionSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("case-arbitration-decision"),
    caseDomainId: z.uuid(),
    decisionId: z.uuid(),
    decisionDigest: FederationDigestSchema,
    binding: CommercialArbitrationTaskBindingSchema.omit({
      observedAt: true,
      unit: true,
      mode: true,
    }),
    headDigest: FederationDigestSchema,
    freezeDigest: FederationDigestSchema,
    basisDigest: FederationDigestSchema,
    action: z.enum(ArbitrationOutcomeSchema.options.map((option) => option.shape.action.value)),
    decidedAt: z.iso.datetime(),
    issuedAt: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => Date.parse(value.decidedAt) <= Date.parse(value.issuedAt));
export type CaseArbitrationDecision = z.infer<typeof CaseArbitrationDecisionSchema>;
export const CaseArbitrationDecisionDraftSchema = z.strictObject({ caseDomainId: z.uuid() });
export function caseArbitrationDecision(
  decision: ArbitrationDecision,
  digest: string,
  caseDomainId: string,
  issuedAt: string,
  salt: string,
): CaseArbitrationDecision {
  const { unit: _unit, mode: _mode, ...binding } = decision.intent.binding;
  return CaseArbitrationDecisionSchema.parse({
    protocolVersion: 1,
    kind: "case-arbitration-decision",
    caseDomainId,
    decisionId: decision.intent.decisionId,
    decisionDigest: digest,
    binding,
    headDigest: decision.intent.financial.headDigest,
    freezeDigest: decision.intent.financial.freezeDigest,
    basisDigest: decision.basisDigest,
    action: decision.intent.outcome.action,
    decidedAt: decision.issuedAt,
    issuedAt,
    salt,
  });
}
const reference = { domainId: z.uuid(), recordId: z.uuid(), digest: FederationDigestSchema };
export const CaseProposalSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...reference,
    operation: z.literal("record-case-evidence"),
    envelope: CaseEvidenceEnvelopeSchema,
  }),
  z.strictObject({
    ...reference,
    operation: z.literal("revoke-case-publication"),
    envelope: CaseRevocationEnvelopeSchema,
  }),
  z.strictObject({
    ...reference,
    operation: z.literal("record-arbitration-decision"),
    envelope: CaseRevocationEnvelopeSchema,
  }),
]);
export type CaseProposal = z.infer<typeof CaseProposalSchema>;
export const CaseReceiptSchema = CommercialReceiptSchema;
export const CaseReceiptQuerySchema = z.strictObject({
  domainId: z.uuid(),
  recordId: z.uuid(),
  recordType: z.enum(["case-evidence", "case-revocation", "case-arbitration-decision"]),
});
export const CaseReceiptResultSchema = z.strictObject({ receipt: CaseReceiptSchema.nullable() });

export async function caseVerificationKeys(
  trust: FabricCaseTrust,
  input: CaseProposal,
  revoked: (site: string, key: string) => Promise<boolean>,
) {
  const references =
    input.operation !== "record-case-evidence"
      ? [{ siteId: input.envelope.issuerSiteId, jws: input.envelope.jws }]
      : [
          input.envelope.publication,
          input.envelope.evidence.policy,
          input.envelope.evidence.disclosure,
        ].flatMap((pair) => [
          { siteId: pair.sourceSiteId, jws: pair.sourceJws },
          { siteId: pair.targetSiteId, jws: pair.targetJws },
        ]);
  const keys: FederationVerificationKey[] = [];
  for (const { siteId, jws } of references) {
    const keyId = federationMessageKeyId(jws);
    if (keys.some((key) => key.siteId === siteId && key.keyId === keyId)) continue;
    const key = trust.organizations
      .find((org) => org.siteId === siteId)
      ?.keys.find((key) => key.keyId === keyId);
    const purpose = trust.keyPurposes.find(
      (value) => value.siteId === siteId && value.keyId === keyId,
    );
    if (!key || !purpose) throw new FederationError("UNTRUSTED_IDENTITY");
    keys.push({
      siteId,
      keyId,
      publicKey: await parseFederationPublicKey(key.publicKeyPem),
      validFrom: new Date(key.validFrom),
      validUntil: new Date(key.validUntil),
      revoked: await revoked(siteId, keyId),
      allowedKinds: purpose.kinds,
    });
  }
  return keys;
}

export async function verifyCaseSignature<T extends { kind: string }>(
  schema: z.ZodType<T>,
  jws: string,
  siteId: string,
  keys: readonly FederationVerificationKey[],
  now: Date,
) {
  const matches = keys.filter(
    (key) => key.siteId === siteId && key.keyId === federationMessageKeyId(jws),
  );
  if (matches.length !== 1 || !matches[0]) throw new FederationError("UNTRUSTED_IDENTITY");
  return verifyFederationMessage(schema, jws, matches[0], now);
}
export async function verifyCasePublication(
  raw: z.infer<typeof CaseEvidenceEnvelopeSchema>,
  domain: CaseDomain,
  keys: readonly FederationVerificationKey[],
  now: Date,
) {
  const envelope = CaseEvidenceEnvelopeSchema.parse(raw);
  const { publication: pair } = envelope;
  if (pair.sourceSiteId !== domain.sourceSiteId || pair.targetSiteId !== domain.targetSiteId)
    throw new FederationError("POLICY_DENIED");
  const source = await verifyCaseSignature(
    CasePublicationSchema,
    pair.sourceJws,
    domain.sourceSiteId,
    keys,
    now,
  );
  const target = await verifyCaseSignature(
    CasePublicationSchema,
    pair.targetJws,
    domain.targetSiteId,
    keys,
    now,
  );
  if (source.digest !== target.digest) throw new FederationError("OPERATION_CONFLICT");
  const publication = source.payload,
    scope = publication.scope;
  if (
    publication.caseDomainId !== domain.domainId ||
    scope.domainId !== domain.commercialDomainId ||
    scope.sourceSiteId !== domain.sourceSiteId ||
    scope.targetSiteId !== domain.targetSiteId ||
    scope.evidenceRecipientSiteId !== domain.recipientSiteId
  )
    throw new FederationError("POLICY_DENIED");
  if (
    Date.parse(publication.issuedAt) > now.getTime() ||
    Date.parse(publication.validUntil) <= now.getTime()
  )
    throw new FederationError("AUTHORIZATION_EXPIRED");
  const disclosure = await verifyCaseSignature(
    CommercialDisclosureSchema,
    envelope.evidence.disclosure.sourceJws,
    domain.sourceSiteId,
    keys,
    now,
  );
  const verified = await verifyCommercialDisclosure(
    envelope.evidence.policy,
    envelope.evidence.disclosure,
    keys,
    {
      ...disclosure.payload.grant,
      ...scope,
      recipientSiteId: domain.recipientSiteId,
      // Publication is a separately signed durable-storage decision, not a new remote read permit.
      policyRevoked: false,
      grantRevoked: false,
    },
    now,
  );
  if (
    disclosure.digest !== scope.disclosureDigest ||
    Date.parse(publication.validUntil) >
      Math.min(
        Date.parse(verified.policy.payload.validUntil),
        Date.parse(disclosure.payload.grant.validUntil),
      )
  )
    throw new FederationError("POLICY_DENIED");
  return source;
}
export async function verifyCaseRevocation(
  envelope: z.infer<typeof CaseRevocationEnvelopeSchema>,
  domain: CaseDomain,
  keys: readonly FederationVerificationKey[],
  now: Date,
) {
  if (![domain.sourceSiteId, domain.targetSiteId].includes(envelope.issuerSiteId))
    throw new FederationError("POLICY_DENIED");
  const signed = await verifyCaseSignature(
    CaseRevocationSchema,
    envelope.jws,
    envelope.issuerSiteId,
    keys,
    now,
  );
  if (
    signed.payload.issuerSiteId !== envelope.issuerSiteId ||
    signed.payload.caseDomainId !== domain.domainId ||
    Date.parse(signed.payload.issuedAt) > now.getTime()
  )
    throw new FederationError("POLICY_DENIED");
  return signed;
}

export const caseOperationFunction = {
  "record-case-evidence": "RecordCaseEvidence",
  "revoke-case-publication": "RevokeCasePublication",
  "record-arbitration-decision": "RecordArbitrationDecision",
} as const;
export const caseOperationRecordType = {
  "record-case-evidence": "case-evidence",
  "revoke-case-publication": "case-revocation",
  "record-arbitration-decision": "case-arbitration-decision",
} as const;
export async function verifyCaseArbitrationDecision(
  envelope: z.infer<typeof CaseRevocationEnvelopeSchema>,
  domain: CaseDomain,
  keys: readonly FederationVerificationKey[],
  now: Date,
) {
  if (envelope.issuerSiteId !== domain.recipientSiteId) throw new FederationError("POLICY_DENIED");
  const signed = await verifyCaseSignature(
    CaseArbitrationDecisionSchema,
    envelope.jws,
    domain.recipientSiteId,
    keys,
    now,
  );
  const value = signed.payload,
    binding = value.binding;
  if (
    value.caseDomainId !== domain.domainId ||
    binding.domainId !== domain.commercialDomainId ||
    binding.sourceSiteId !== domain.sourceSiteId ||
    binding.targetSiteId !== domain.targetSiteId ||
    binding.arbitratorSiteId !== domain.recipientSiteId
  )
    throw new FederationError("POLICY_DENIED");
  if (Date.parse(value.issuedAt) > now.getTime())
    throw new FederationError("AUTHORIZATION_EXPIRED");
  return signed;
}
