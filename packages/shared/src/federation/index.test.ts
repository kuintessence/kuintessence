import { expect, test } from "bun:test";
import {
  assertDelegationPolicy,
  FederationAgreementSchema,
  FederationAmountSchema,
  FederationDelegationSchema,
} from "./index";

const now = new Date("2026-01-01T00:00:00.000Z");
const source = crypto.randomUUID();
const target = crypto.randomUUID();
const digest = `sha256:${"a".repeat(64)}`;
const template = {
  originSiteId: source,
  kind: "script" as const,
  id: crypto.randomUUID(),
  revision: "v1",
  digest,
};
const agreement = FederationAgreementSchema.parse({
  protocolVersion: 1,
  kind: "agreement",
  agreementRevisionId: crypto.randomUUID(),
  sourceSiteId: source,
  targetSiteId: target,
  mode: "bilateral_direct",
  budgetDomainId: crypto.randomUUID(),
  epoch: crypto.randomUUID(),
  unit: "credit.micro",
  budgetLimit: "9007199254740993000",
  maxTaskAmount: "9007199254740993000",
  maxReservations: 10,
  validFrom: "2025-12-31T00:00:00.000Z",
  validUntil: "2026-01-02T00:00:00.000Z",
  templates: [template],
  resourceLimit: { cpus: 2, memoryMb: 256, gpus: 0, wallTimeSec: 60 },
  termsDigest: digest,
});
const request = FederationDelegationSchema.parse({
  protocolVersion: 1,
  kind: "delegation",
  operationId: crypto.randomUUID(),
  senderSiteId: source,
  recipientSiteId: target,
  agreementRevisionId: agreement.agreementRevisionId,
  mode: agreement.mode,
  budgetDomainId: agreement.budgetDomainId,
  epoch: agreement.epoch,
  taskId: crypto.randomUUID(),
  attempt: 1,
  issuedAt: now.toISOString(),
  expiresAt: "2026-01-01T00:10:00.000Z",
  template,
  inputManifestDigest: digest,
  environmentLockDigest: digest,
  resources: agreement.resourceLimit,
  maxAmount: "9007199254740992999",
  unit: agreement.unit,
});

test("amounts preserve 38-digit precision and reject ambiguous or lossy encodings", () => {
  for (const valid of ["0", "9007199254740993", "9".repeat(38)])
    expect(FederationAmountSchema.parse(valid)).toBe(valid);
  for (const invalid of [0, "-1", "01", "1.0", "1e3", "+1", " 1", "9".repeat(39)])
    expect(FederationAmountSchema.safeParse(invalid).success).toBe(false);
});

test("admission binds the exact template, budget epoch, units and resource caps", () => {
  expect(() => assertDelegationPolicy(agreement, request, now)).not.toThrow();
  for (const override of [
    { epoch: crypto.randomUUID() },
    { unit: "CNY" },
    { recipientSiteId: source },
    { maxAmount: "9007199254740993001" },
    { template: { ...template, digest: `sha256:${"b".repeat(64)}` } },
    { resources: { ...request.resources, cpus: 3 } },
  ])
    expect(() => assertDelegationPolicy(agreement, { ...request, ...override }, now)).toThrow(
      "POLICY_DENIED",
    );
});

test("chain coordination cannot fall back to bilateral admission", () => {
  expect(() =>
    assertDelegationPolicy({ ...agreement, mode: "ledger_coordinated" }, request, now),
  ).toThrow("LEDGER_REQUIRED");
});

test("expiration is exclusive; future issued requests and excessive lifetimes fail", () => {
  expect(() => assertDelegationPolicy(agreement, request, new Date(request.expiresAt))).toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(() =>
    assertDelegationPolicy(agreement, request, new Date(now.getTime() - 61_000)),
  ).toThrow("AUTHORIZATION_EXPIRED");
  expect(
    FederationDelegationSchema.safeParse({
      ...request,
      expiresAt: "2026-01-01T02:00:00.000Z",
    }).success,
  ).toBe(false);
});

test("unrecognized command, identity, money and protocol fields cannot slip through", () => {
  for (const override of [
    { command: "sh arbitrary-script" },
    { submittedBy: source },
    { protocolVersion: 2 },
    { maxAmount: 10 },
  ])
    expect(FederationDelegationSchema.safeParse({ ...request, ...override }).success).toBe(false);
});
