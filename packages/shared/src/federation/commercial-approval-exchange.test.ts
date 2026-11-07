import { expect, test } from "bun:test";
import {
  CommercialApprovalQuerySchema,
  CommercialApprovalWaitingSchema,
} from "./commercial-approval-exchange";
import { FederationKeyInput } from "./trust";

test("commercial approval exchange binds record kind, digest, distinct parties and a minute query window", () => {
  const revision = crypto.randomUUID();
  const query = {
    protocolVersion: 1,
    kind: "commercial-approval-query",
    queryId: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    agreementRevisionId: revision,
    domainId: crypto.randomUUID(),
    recordKind: "agreement",
    recordId: revision,
    recordDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: "2026-11-08T00:00:00Z",
    expiresAt: "2026-11-08T00:01:00Z",
  };
  expect(CommercialApprovalQuerySchema.safeParse(query).success).toBe(true);
  for (const patch of [
    { recordId: crypto.randomUUID() },
    { recordKind: "terminal" },
    { recordDigest: "unknown" },
    { recipientSiteId: query.senderSiteId },
    { expiresAt: "2026-11-08T00:01:01Z" },
    { expiresAt: query.issuedAt },
    { autoApprove: true },
  ])
    expect(CommercialApprovalQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
  expect(
    CommercialApprovalQuerySchema.safeParse({
      ...query,
      recordKind: "bill",
      recordId: crypto.randomUUID(),
    }).success,
  ).toBe(true);
  expect(
    CommercialApprovalQuerySchema.safeParse({
      ...query,
      recordKind: "reservation",
      recordId: crypto.randomUUID(),
    }).success,
  ).toBe(true);
});

test("commercial approval waiting message has no contract body and explicit separate signing purpose", () => {
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("commercial-approval-query");
  expect(kinds).toContain("commercial-approval-waiting");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
  expect(Object.keys(CommercialApprovalWaitingSchema.shape)).not.toContain("approvalJws");
  expect(Object.keys(CommercialApprovalWaitingSchema.shape)).not.toContain("terms");
});
