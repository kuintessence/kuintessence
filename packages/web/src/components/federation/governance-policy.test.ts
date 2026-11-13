import { expect, test } from "vitest";
import {
  checkGovernancePayload,
  checkGovernanceRow,
  disclosureChoices,
  governanceId,
  governanceSchemas,
} from "./governance-policy";
import { approval, disclosurePolicy, policyRow, uuid } from "./governance-test-fixtures";

test("policies keep exact field scope, large amounts and original IDs", () => {
  expect(governanceId(disclosurePolicy)).toBe(disclosurePolicy.policyId);
  expect(checkGovernancePayload(disclosurePolicy, approval)).toEqual(disclosurePolicy);
  expect(disclosureChoices.find((choice) => choice.recordType === "agreement")?.fields).toContain(
    "prices",
  );
  expect(() =>
    governanceSchemas.disclosure.draft.parse({
      policyId: uuid(10),
      recipientSiteId: uuid(11),
      disclosures: [{ recordType: "bill", fields: ["dueAmount", "secret"] }],
      validUntil: "2099-01-01T00:00:00Z",
    }),
  ).toThrow();
  expect(() =>
    governanceSchemas.arbitration.draft.parse({
      policyId: uuid(10),
      arbitratorSiteId: uuid(11),
      subjectTypes: ["bill"],
      disclosures: [{ recordType: "bill", fields: ["dueAmount"] }],
      requiredEvidence: [{ recordType: "bill", fields: ["lines"] }],
      decisionRule: "designated-arbitrator",
      actions: ["settle"],
      maxChargedAmount: "9007199254740993",
      validUntil: "2099-01-01T00:00:00Z",
    }),
  ).toThrow();
});
test("policy responses reject cross organization, contract and digest substitutions", () => {
  expect(checkGovernanceRow("disclosure", policyRow, approval, approval.localOrgId)).toEqual(
    policyRow,
  );
  expect(() =>
    checkGovernanceRow(
      "disclosure",
      { ...policyRow, localOrgId: uuid(99) },
      approval,
      approval.localOrgId,
    ),
  ).toThrow();
  expect(() =>
    checkGovernancePayload(
      { ...disclosurePolicy, agreementDigest: `sha256:${"f".repeat(64)}` },
      approval,
    ),
  ).toThrow();
  expect(() =>
    checkGovernancePayload({ ...disclosurePolicy, targetSiteId: uuid(99) }, approval),
  ).toThrow();
});
test("case publication rows cannot substitute their grant or publication identity", () => {
  const payload = {
    protocolVersion: 1,
    kind: "case-evidence-publication",
    publicationId: uuid(40),
    caseDomainId: uuid(41),
    scope: {
      caseId: uuid(30),
      domainId: approval.terms.domainId,
      agreementRevisionId: approval.revisionId,
      agreementDigest: approval.digest,
      sourceSiteId: approval.terms.agreement.sourceSiteId,
      targetSiteId: approval.terms.agreement.targetSiteId,
      evidenceRecipientSiteId: uuid(21),
      grantId: uuid(39),
      disclosureDigest: approval.digest,
      policyId: disclosurePolicy.policyId,
      policyDigest: policyRow.digest,
    },
    issuedAt: "2026-01-01T00:00:00Z",
    validUntil: "2099-01-01T00:00:00Z",
    salt: "a".repeat(64),
  };
  const row = {
    ...policyRow,
    publicationId: uuid(40),
    grantId: uuid(39),
    caseId: uuid(30),
    payload,
    revocationPayload: null,
    revocationJws: null,
  };
  expect(checkGovernanceRow("publication", row, approval, approval.localOrgId).payload).toEqual(
    payload,
  );
  expect(() =>
    checkGovernanceRow("publication", { ...row, grantId: uuid(99) }, approval, approval.localOrgId),
  ).toThrow();
});
