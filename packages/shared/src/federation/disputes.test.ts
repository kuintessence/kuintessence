import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CommercialDisputeDraftSchema, CommercialDisputeSchema } from "./disputes";
import { federationCapabilitySources } from "./permissions";
import { FederationKeyInput } from "./trust";

function dispute() {
  const sourceSiteId = randomUUID();
  return {
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId: randomUUID(),
    agreementRevisionId: randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    sourceSiteId,
    targetSiteId: randomUUID(),
    openingSiteId: sourceSiteId,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: new Date().toISOString(),
    salt: "b".repeat(64),
    subject: {
      recordType: "bill",
      recordId: randomUUID(),
      recordDigest: `sha256:${"c".repeat(64)}`,
    },
    reason: "Disputed amount",
    requestedResolution: "Review original meter records",
  };
}

test("dispute opening binds parties, a task attempt and a precise original without copying private originals", () => {
  const value = dispute();
  for (const recordType of ["usage", "bill", "settlement", "adjustment", "payment"] as const)
    expect(
      CommercialDisputeSchema.parse({ ...value, subject: { ...value.subject, recordType } }).subject
        .recordType,
    ).toBe(recordType);
  for (const patch of [
    { openingSiteId: randomUUID() },
    { targetSiteId: value.sourceSiteId },
    { attempt: 0 },
    { subject: { ...value.subject, originalJws: "private" } },
    { debitAmount: "10" },
    { arbitrationPolicyId: randomUUID() },
    { reason: " " },
  ])
    expect(CommercialDisputeSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  const { caseId, subject, reason, requestedResolution } = value;
  expect(
    CommercialDisputeDraftSchema.safeParse({ caseId, subject, reason, requestedResolution })
      .success,
  ).toBe(true);
  expect(
    CommercialDisputeDraftSchema.safeParse({
      caseId,
      subject,
      reason,
      requestedResolution,
      taskId: randomUUID(),
    }).success,
  ).toBe(false);
});

test("case read/open and signing purposes are independent of commercial approvals", () => {
  expect(federationCapabilitySources("dispute.read")).toEqual(["dispute.read", "dispute.open"]);
  expect(federationCapabilitySources("dispute.open")).toEqual(["dispute.open"]);
  expect(federationCapabilitySources("agreement.read")).not.toContain("dispute.read");
  expect(federationCapabilitySources("agreement.read")).not.toContain("dispute.open");
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain("commercial-dispute");
});
