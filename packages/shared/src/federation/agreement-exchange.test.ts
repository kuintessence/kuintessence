import { expect, test } from "bun:test";
import { AgreementApprovalQuerySchema, AgreementApprovalWaitingSchema } from "./agreement-exchange";
import { FederationKeyInput } from "./trust";

test("execution consent query binds original digest and distinct institutions within a minute", () => {
  const query = {
    protocolVersion: 1,
    kind: "agreement-approval-query",
    queryId: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: "2026-11-08T00:00:00Z",
    expiresAt: "2026-11-08T00:01:00Z",
  };
  expect(AgreementApprovalQuerySchema.safeParse(query).success).toBe(true);
  for (const patch of [
    { agreementDigest: "unknown" },
    { recipientSiteId: query.senderSiteId },
    { expiresAt: "2026-11-08T00:01:01Z" },
    { expiresAt: query.issuedAt },
    { executionUserId: crypto.randomUUID() },
    { autoApprove: true },
  ])
    expect(AgreementApprovalQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
});
test("execution consent exchange has explicit transport signing purposes and no identity or approval in waiting messages", () => {
  const purposes = FederationKeyInput.shape.allowedKinds.element.options;
  expect(purposes).toContain("agreement-approval-query");
  expect(purposes).toContain("agreement-approval-waiting");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(purposes).success).toBe(true);
  for (const field of ["approvalJws", "terms", "executionUserId", "orgId"])
    expect(Object.keys(AgreementApprovalWaitingSchema.shape)).not.toContain(field);
});
