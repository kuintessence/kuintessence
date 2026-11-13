import { expect, test } from "bun:test";
import {
  type CommercialDisputeResolution,
  CommercialDisputeResolutionSchema,
} from "./dispute-resolution";

function original(): CommercialDisputeResolution {
  return {
    protocolVersion: 1,
    kind: "commercial-dispute-resolution",
    resolutionId: crypto.randomUUID(),
    caseId: crypto.randomUUID(),
    caseDigest: `sha256:${"a".repeat(64)}`,
    domainId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    sourceSiteId: crypto.randomUUID(),
    targetSiteId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    attempt: 1,
    mode: "bilateral_direct",
    decisionId: crypto.randomUUID(),
    withdrawalDigest: `sha256:${"b".repeat(64)}`,
    headDigest: `sha256:${"c".repeat(64)}`,
    financial: null,
    reason: "Joint reconciliation",
    issuedAt: "2026-01-01T00:00:00Z",
    salt: "d".repeat(64),
  };
}

test("v1 reconciliation keeps the exact original payload and its permanent withdrawal requirement", () => {
  const value = original();
  expect(CommercialDisputeResolutionSchema.parse(value)).toEqual(value);
  for (const replacement of [
    { decisionId: null },
    { withdrawalDigest: null },
    { mode: "ledger_coordinated" },
    { freezeDigest: null },
  ])
    expect(CommercialDisputeResolutionSchema.safeParse({ ...value, ...replacement }).success).toBe(
      false,
    );
});

test("v2 generic reconciliation has no implicit old-execution authority and pins native coordinated freeze", () => {
  const value = {
    ...original(),
    protocolVersion: 2,
    decisionId: null,
    withdrawalDigest: null,
    freezeDigest: null,
  } satisfies CommercialDisputeResolution;
  expect(CommercialDisputeResolutionSchema.parse(value)).toEqual(value);
  expect(
    CommercialDisputeResolutionSchema.safeParse({ ...value, decisionId: crypto.randomUUID() })
      .success,
  ).toBe(false);
  expect(
    CommercialDisputeResolutionSchema.safeParse({ ...value, mode: "ledger_coordinated" }).success,
  ).toBe(false);
  const coordinated = {
    ...value,
    mode: "ledger_coordinated",
    freezeDigest: `sha256:${"e".repeat(64)}`,
  } satisfies CommercialDisputeResolution;
  expect(CommercialDisputeResolutionSchema.parse(coordinated)).toEqual(coordinated);
});
