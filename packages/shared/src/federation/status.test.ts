import { expect, test } from "bun:test";
import {
  assertFederationStatusQueryFresh,
  assertFederationStatusReport,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
} from "./status";

const now = new Date("2026-01-01T00:00:00Z");
const query = FederationStatusQuerySchema.parse({
  protocolVersion: 1,
  kind: "status-query",
  queryId: crypto.randomUUID(),
  senderSiteId: crypto.randomUUID(),
  recipientSiteId: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  agreementRevisionId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  attempt: 1,
  reservationId: crypto.randomUUID(),
  requestDigest: `sha256:${"a".repeat(64)}`,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
});
const digest = `sha256:${"b".repeat(64)}`;
const { issuedAt, expiresAt, ...identity } = query;
const report = FederationStatusReportSchema.parse({
  ...identity,
  kind: "status-report",
  senderSiteId: query.recipientSiteId,
  recipientSiteId: query.senderSiteId,
  queryDigest: digest,
  observedAt: now.toISOString(),
  preparation: null,
  workflow: { status: "cancelling", updatedAt: now.toISOString() },
});

test("status challenges expire without granting longer admission or execution", () => {
  assertFederationStatusQueryFresh(query, now);
  expect(() => assertFederationStatusQueryFresh(query, new Date(expiresAt))).toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(() => assertFederationStatusQueryFresh(query, new Date(now.getTime() - 60_001))).toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(FederationStatusQuerySchema.safeParse({ ...query, expiresAt: issuedAt }).success).toBe(
    false,
  );
  expect(
    FederationStatusQuerySchema.safeParse({
      ...query,
      expiresAt: new Date(now.getTime() + 60_001).toISOString(),
    }).success,
  ).toBe(false);
});

test("status reports bind a fresh challenge and cannot carry execution contents", () => {
  assertFederationStatusReport(query, digest, report, now);
  for (const changed of [
    { queryId: crypto.randomUUID() },
    { queryDigest: query.requestDigest },
    { observedAt: new Date(now.getTime() + 60_001).toISOString() },
    { observedAt: new Date(now.getTime() - 60_001).toISOString() },
  ])
    expect(() =>
      assertFederationStatusReport(query, digest, { ...report, ...changed }, now),
    ).toThrow("INVALID_MESSAGE");
  expect(
    FederationStatusReportSchema.safeParse({ ...report, result: "private file" }).success,
  ).toBe(false);
  expect(
    FederationStatusReportSchema.safeParse({
      ...report,
      workflow: { ...report.workflow, errorMessage: "internal path" },
    }).success,
  ).toBe(false);
});
