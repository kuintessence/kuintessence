import { expect, test } from "bun:test";
import {
  assertArbitrationRequest,
  CommercialArbitrationPolicyDraftSchema,
  CommercialArbitrationPolicySchema,
} from "./arbitration-policy";
import {
  ArbitrationRevocationNoticeSchema,
  ArbitrationRevocationReceiptSchema,
} from "./arbitration-revocation-notice";
import { FederationArbitrationBindingSchema } from "./index";
import { federationCapabilitySources } from "./permissions";
import { FederationKeyInput } from "./trust";

const draft = CommercialArbitrationPolicyDraftSchema.parse({
  policyId: crypto.randomUUID(),
  arbitratorSiteId: crypto.randomUUID(),
  subjectTypes: ["bill", "settlement"],
  disclosures: [{ recordType: "bill", fields: ["dueAmount", "grossAmount"] }],
  requiredEvidence: [{ recordType: "bill", fields: ["dueAmount"] }],
  decisionRule: "designated-arbitrator",
  actions: ["settle", "adjust"],
  maxChargedAmount: "9007199254740993",
  validUntil: "2028-01-01T00:00:00Z",
});
const policy = {
  ...draft,
  protocolVersion: 1,
  kind: "commercial-arbitration-policy",
  domainId: crypto.randomUUID(),
  agreementRevisionId: crypto.randomUUID(),
  agreementDigest: `sha256:${"a".repeat(64)}`,
  sourceSiteId: crypto.randomUUID(),
  targetSiteId: crypto.randomUUID(),
  unit: "credit",
  issuedAt: "2027-01-01T00:00:00Z",
  validFrom: "2027-01-01T00:00:00Z",
  salt: "b".repeat(64),
};

test("original delegation binds policy identity, parties, contract, unit and current validity", () => {
  const value = CommercialArbitrationPolicySchema.parse(policy);
  const digest = `sha256:${"d".repeat(64)}`;
  const request = {
    arbitration: { policyId: value.policyId, policyDigest: digest },
    agreementRevisionId: value.agreementRevisionId,
    senderSiteId: value.sourceSiteId,
    recipientSiteId: value.targetSiteId,
    unit: value.unit,
  };
  const now = new Date(value.validFrom);
  expect(() => assertArbitrationRequest(value, digest, request, now)).not.toThrow();
  for (const patch of [
    { arbitration: undefined },
    { arbitration: { ...request.arbitration, policyId: crypto.randomUUID() } },
    { arbitration: { ...request.arbitration, policyDigest: value.agreementDigest } },
    { agreementRevisionId: crypto.randomUUID() },
    { senderSiteId: value.targetSiteId },
    { recipientSiteId: value.sourceSiteId },
    { unit: "other" },
  ])
    expect(() => assertArbitrationRequest(value, digest, { ...request, ...patch }, now)).toThrow(
      "POLICY_DENIED",
    );
  for (const time of [new Date(+now - 1), new Date(value.validUntil), new Date(Number.NaN)])
    expect(() => assertArbitrationRequest(value, digest, request, time)).toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  const binding = { ...request.arbitration, sourceJws: "source", targetJws: "target" };
  expect(FederationArbitrationBindingSchema.safeParse(binding).success).toBe(true);
  for (const patch of [{ sourceJws: undefined }, { targetJws: "" }, { autoApprove: true }])
    expect(FederationArbitrationBindingSchema.safeParse({ ...binding, ...patch }).success).toBe(
      false,
    );
});

test("arbitration authority preserves exact caps, named parties and required evidence", () => {
  expect(CommercialArbitrationPolicySchema.parse(policy).maxChargedAmount).toBe("9007199254740993");
  expect(CommercialArbitrationPolicyDraftSchema.parse(draft).requiredEvidence).toEqual(
    draft.requiredEvidence,
  );
  for (const patch of [
    { arbitratorSiteId: policy.sourceSiteId },
    { targetSiteId: policy.sourceSiteId },
    { issuedAt: "2027-01-02T00:00:00Z" },
    { validUntil: policy.validFrom },
    { unit: "" },
    { agreementDigest: "unknown" },
    { maxChargedAmount: 9007199254740992 },
    { maxChargedAmount: "-1" },
    { maxChargedAmount: "01" },
    { maxChargedAmount: "1.1" },
    { sourceJws: "private contract" },
  ])
    expect(CommercialArbitrationPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(
      false,
    );
});

test("evidence requirements cannot exceed disclosure consent or use arbitrary selectors", () => {
  for (const patch of [
    { requiredEvidence: [{ recordType: "bill", fields: ["lines"] }] },
    { requiredEvidence: [{ recordType: "payment", fields: ["amount"] }] },
    { requiredEvidence: [] },
    { requiredEvidence: [draft.requiredEvidence[0], draft.requiredEvidence[0]] },
    { disclosures: [draft.disclosures[0], draft.disclosures[0]] },
    { disclosures: [{ recordType: "bill", fields: ["dueAmount", "dueAmount"] }] },
    { requiredEvidence: [{ recordType: "bill", fields: ["dueAmount", "dueAmount"] }] },
    { disclosures: [{ recordType: "bill", fields: ["$.calculation.*"] }] },
  ])
    expect(CommercialArbitrationPolicyDraftSchema.safeParse({ ...draft, ...patch }).success).toBe(
      false,
    );
});

test("a policy cannot add payment, minting or generic governance authority", () => {
  for (const patch of [
    { actions: ["pay"] },
    { actions: ["mint"] },
    { actions: ["adjust", "adjust"] },
    { subjectTypes: ["bill", "bill"] },
    { subjectTypes: ["wallet"] },
    { decisionRule: "any-two-signers" },
    { actions: ["resolve-without-financial-change"] },
    { policyDigest: `sha256:${"c".repeat(64)}` },
  ])
    expect(CommercialArbitrationPolicyDraftSchema.safeParse({ ...draft, ...patch }).success).toBe(
      false,
    );
  expect(
    CommercialArbitrationPolicyDraftSchema.safeParse({
      ...draft,
      actions: ["resolve-without-financial-change"],
      maxChargedAmount: "0",
    }).success,
  ).toBe(true);
  expect(federationCapabilitySources("arbitration.approve")).toEqual(["arbitration.approve"]);
  expect(federationCapabilitySources("agreement.read")).toContain("arbitration.approve");
  for (const capability of ["disclosure.approve", "settlement.approve", "payment.approve"] as const)
    expect(federationCapabilitySources(capability)).not.toContain("arbitration.approve");
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("commercial-arbitration-policy");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});

test("arbitration notification schemas restrict audience, fields and immutable receipt bindings", () => {
  const value = ArbitrationRevocationNoticeSchema.parse({
    protocolVersion: 1,
    kind: "arbitration-revocation-notice",
    noticeId: crypto.randomUUID(),
    issuerSiteId: policy.sourceSiteId,
    receivingSiteId: policy.targetSiteId,
    policy,
    policyJws: "original.policy.signature",
    revocationJws: "signed.withdrawal.original",
    issuedAt: "2027-02-01T00:00:00Z",
  });
  for (const patch of [
    { receivingSiteId: value.issuerSiteId },
    { contractJws: "private contract" },
    { revocationJws: "" },
    { unfreeze: true },
  ])
    expect(ArbitrationRevocationNoticeSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  const receipt = ArbitrationRevocationReceiptSchema.parse({
    protocolVersion: 1,
    kind: "arbitration-revocation-receipt",
    noticeId: value.noticeId,
    noticeDigest: policy.agreementDigest,
    policyId: policy.policyId,
    policyDigest: policy.agreementDigest,
    revocationId: crypto.randomUUID(),
    revocationDigest: policy.agreementDigest,
    issuerSiteId: value.issuerSiteId,
    receivingSiteId: value.receivingSiteId,
    recordedAt: "2027-02-01T00:00:00Z",
  });
  for (const patch of [
    { receivingSiteId: receipt.issuerSiteId },
    { revocationDigest: "unknown" },
    { policyDigest: undefined },
    { amount: "1" },
  ])
    expect(ArbitrationRevocationReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(
      false,
    );
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("arbitration-revocation-notice");
  expect(kinds).toContain("arbitration-revocation-receipt");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
