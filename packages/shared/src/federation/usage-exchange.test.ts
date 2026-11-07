import { expect, test } from "bun:test";
import { FederationKeyInput } from "./trust";
import { CommercialUsageQuerySchema } from "./usage-exchange";

const query = {
  protocolVersion: 1,
  kind: "commercial-usage-query",
  queryId: crypto.randomUUID(),
  senderSiteId: crypto.randomUUID(),
  recipientSiteId: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  agreementRevisionId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  attempt: 1,
  reservationId: crypto.randomUUID(),
  requestDigest: `sha256:${"a".repeat(64)}`,
  agreementDigest: `sha256:${"b".repeat(64)}`,
  issuedAt: "2026-11-07T00:00:00.000Z",
  expiresAt: "2026-11-07T00:01:00.000Z",
  afterNumber: 0,
  afterReportId: null,
};

test("usage query binds bounded cursor, distinct peers and short lifetime without hidden fields", () => {
  expect(CommercialUsageQuerySchema.safeParse(query).success).toBe(true);
  for (const patch of [
    { afterNumber: 1 },
    { afterReportId: crypto.randomUUID() },
    { afterNumber: -1 },
    { recipientSiteId: query.senderSiteId },
    { expiresAt: "2026-11-07T00:01:00.001Z" },
    { price: "1" },
    { kind: "status-query" },
  ])
    expect(CommercialUsageQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
});

test("usage exchange signing purposes are explicit and the trust catalog accepts the complete catalog", () => {
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("commercial-usage-query");
  expect(kinds).toContain("commercial-usage-page");
  expect(kinds).toContain("commercial-reservation");
  expect(kinds).toContain("commercial-release");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
