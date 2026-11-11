import {
  CommercialArbitrationPolicyApprovalSchema,
  CommercialArbitrationPolicyDraftSchema,
  CommercialArbitrationPolicySchema,
} from "@kuintessence/shared/federation/arbitration-policy";
import {
  CasePublicationApprovalSchema,
  CasePublicationDraftSchema,
  CasePublicationSchema,
} from "@kuintessence/shared/federation/case-ledger";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisclosureApprovalSchema,
  CommercialDisclosureDraftSchema,
  CommercialDisclosureGrantSchema,
  CommercialDisclosureSchema,
} from "@kuintessence/shared/federation/disclosure";
import {
  CommercialDisclosurePolicyApprovalSchema,
  CommercialDisclosurePolicyDraftSchema,
  CommercialDisclosurePolicySchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import type { z } from "zod";

export const governanceKinds = ["arbitration", "disclosure", "grant", "publication"] as const;
export type GovernanceKind = (typeof governanceKinds)[number];
export const governanceSchemas = {
  arbitration: {
    draft: CommercialArbitrationPolicyDraftSchema,
    payload: CommercialArbitrationPolicySchema,
    row: CommercialArbitrationPolicyApprovalSchema,
    capability: "arbitration.approve",
    filter: "policyId",
  },
  disclosure: {
    draft: CommercialDisclosurePolicyDraftSchema,
    payload: CommercialDisclosurePolicySchema,
    row: CommercialDisclosurePolicyApprovalSchema,
    capability: "disclosure.approve",
    filter: "policyId",
  },
  grant: {
    draft: CommercialDisclosureDraftSchema,
    payload: CommercialDisclosureSchema,
    row: CommercialDisclosureApprovalSchema,
    capability: "disclosure.approve",
    filter: "grantId",
  },
  publication: {
    draft: CasePublicationDraftSchema,
    payload: CasePublicationSchema,
    row: CasePublicationApprovalSchema,
    capability: "case.publish",
    filter: "publicationId",
  },
};
export type GovernancePayload = z.infer<(typeof governanceSchemas)[GovernanceKind]["payload"]>;
export type GovernanceRow = z.infer<(typeof governanceSchemas)[GovernanceKind]["row"]>;
export const disclosureChoices = CommercialDisclosureGrantSchema.options.map((option) => ({
  recordType: option.shape.recordType.value,
  fields: option.shape.fields.element.options,
}));
export function governanceBase(kind: GovernanceKind, revision: string) {
  return kind === "publication"
    ? `/federation/case-publications/${revision}`
    : `/federation/commercial-agreements/${revision}/${kind === "grant" ? "disclosures" : `${kind}-policies`}`;
}
export function governanceIdentity(payload: GovernancePayload) {
  return "grant" in payload ? payload.grant : "scope" in payload ? payload.scope : payload;
}
export function governanceId(payload: GovernancePayload) {
  return "grant" in payload
    ? payload.grant.grantId
    : "publicationId" in payload
      ? payload.publicationId
      : payload.policyId;
}
export function checkGovernancePayload(
  payload: GovernancePayload,
  approval: CommercialAgreementApproval,
) {
  const identity = governanceIdentity(payload);
  if (
    identity.agreementRevisionId !== approval.revisionId ||
    identity.domainId !== approval.terms.domainId ||
    identity.sourceSiteId !== approval.terms.agreement.sourceSiteId ||
    identity.targetSiteId !== approval.terms.agreement.targetSiteId ||
    ("agreementDigest" in identity && identity.agreementDigest !== approval.digest)
  )
    throw new Error("Policy contract scope mismatch");
  return payload;
}
export function checkGovernanceRow(
  kind: GovernanceKind,
  raw: unknown,
  approval: CommercialAgreementApproval,
  orgId: string,
) {
  const row = governanceSchemas[kind].row.parse(raw);
  if (
    row.localOrgId !== orgId ||
    row.localSiteId !== approval.localSiteId ||
    row.agreementRevisionId !== approval.revisionId
  )
    throw new Error("Policy organization scope mismatch");
  if (
    "publicationId" in row &&
    "scope" in row.payload &&
    (row.publicationId !== row.payload.publicationId ||
      row.grantId !== row.payload.scope.grantId ||
      row.caseId !== row.payload.scope.caseId ||
      (row.counterpartyJws === null) !== (row.confirmedAt === null) ||
      (row.revokedAt === null) !== (row.revokedBy === null))
  )
    throw new Error("Case publication identity mismatch");
  checkGovernancePayload(row.payload, approval);
  return row;
}
