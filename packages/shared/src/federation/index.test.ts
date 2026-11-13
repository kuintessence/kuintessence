import { expect, test } from "bun:test";
import {
  assertDelegationPolicy,
  FederationAgreementSchema,
  FederationAmountSchema,
  FederationDelegationSchema,
  federationExecutionDeadline,
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

test("file delivery preserves legacy signed payloads and requires explicit media input inventory", () => {
  expect(FederationDelegationSchema.parse(request)).not.toHaveProperty("inputDelivery");
  expect(FederationDelegationSchema.parse(request)).not.toHaveProperty("resultDelivery");
  for (const inputDelivery of ["network", "media"])
    for (const resultDelivery of ["network", "media"])
      expect(
        FederationDelegationSchema.parse({
          ...request,
          inputFilesDigest: digest,
          inputDelivery,
          resultDelivery,
        }),
      ).toMatchObject({ inputDelivery, resultDelivery });
  for (const patch of [
    { inputDelivery: "media" },
    { inputDelivery: "automatic" },
    { resultDelivery: "automatic" },
    { inputDelivery: null },
  ])
    expect(FederationDelegationSchema.safeParse({ ...request, ...patch }).success).toBe(false);
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

test("execution targets bind provider, cluster, Agent and unique receiver queue IDs", () => {
  const target = {
    providerOrgId: crypto.randomUUID(),
    clusterId: "cluster-a",
    agentId: "agent-a",
    queueId: "queue-a",
  };
  expect(
    FederationAgreementSchema.parse({ ...agreement, executionTargets: [target] }).executionTargets,
  ).toEqual([target]);
  expect(FederationAgreementSchema.parse(agreement).executionTargets).toBeUndefined();
  for (const targets of [
    [],
    [target, target],
    [{ ...target, providerOrgId: "invalid" }],
    [{ ...target, clusterId: "" }],
  ])
    expect(
      FederationAgreementSchema.safeParse({ ...agreement, executionTargets: targets }).success,
    ).toBe(false);
});

test("a signed execution deadline never extends first admission or the agreement", () => {
  const extended = FederationDelegationSchema.parse({
    ...request,
    executionExpiresAt: "2026-01-01T12:00:00.000Z",
  });
  const later = new Date("2026-01-01T02:00:00.000Z");
  expect(() => assertDelegationPolicy(agreement, extended, now)).not.toThrow();
  expect(() => assertDelegationPolicy(agreement, extended, later)).toThrow("AUTHORIZATION_EXPIRED");
  expect(() => assertDelegationPolicy(agreement, extended, later, "execution")).not.toThrow();
  expect(() =>
    assertDelegationPolicy(
      agreement,
      extended,
      new Date(extended.executionExpiresAt ?? ""),
      "execution",
    ),
  ).toThrow("AUTHORIZATION_EXPIRED");
  expect(() =>
    assertDelegationPolicy(
      agreement,
      { ...extended, executionExpiresAt: "2026-01-03T00:00:00.000Z" },
      now,
    ),
  ).toThrow("AUTHORIZATION_EXPIRED");
  expect(
    FederationDelegationSchema.safeParse({
      ...extended,
      executionExpiresAt: "2026-01-01T00:09:59.999Z",
    }).success,
  ).toBe(false);
  expect(
    FederationDelegationSchema.safeParse({ ...extended, executionExpiresAt: "unbounded" }).success,
  ).toBe(false);
});

test("legacy execution authority ends at the original request deadline", () => {
  expect(federationExecutionDeadline(request)).toBe(Date.parse(request.expiresAt));
  expect(FederationDelegationSchema.parse(request)).not.toHaveProperty("executionExpiresAt");
  expect(() =>
    assertDelegationPolicy(agreement, request, new Date(request.expiresAt), "execution"),
  ).toThrow("AUTHORIZATION_EXPIRED");
});

test("attestation limits are optional signed terms and cannot silently alter other modes", () => {
  expect(FederationAgreementSchema.parse(agreement)).not.toHaveProperty("attestationLimits");
  const limits = {
    maxOutstandingTasks: 5,
    maxOutstandingAmount: "9007199254740993000",
    maxOutstandingAgeSec: 3600,
  };
  expect(
    FederationAgreementSchema.parse({
      ...agreement,
      mode: "bilateral_attested",
      attestationLimits: limits,
    }).attestationLimits,
  ).toEqual(limits);
  for (const mode of ["bilateral_direct", "ledger_coordinated"])
    expect(
      FederationAgreementSchema.safeParse({ ...agreement, mode, attestationLimits: limits })
        .success,
    ).toBe(false);
  for (const change of [
    { maxOutstandingTasks: 0 },
    { maxOutstandingAgeSec: 0 },
    { maxOutstandingAmount: 1 },
    { maxOutstandingAmount: "-1" },
    { extra: true },
  ])
    expect(
      FederationAgreementSchema.safeParse({
        ...agreement,
        mode: "bilateral_attested",
        attestationLimits: { ...limits, ...change },
      }).success,
    ).toBe(false);
});
