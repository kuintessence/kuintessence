import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ArbitrationContextQuerySchema,
  ArbitrationContextSchema,
  assertArbitrationContext,
} from "./arbitration-context";
import { FederationCapabilitySchema, federationCapabilitySources } from "./permissions";
import { FederationKeyInput } from "./trust";

const now = new Date("2026-11-10T00:00:00Z"),
  digest = `sha256:${"a".repeat(64)}`;
const a = randomUUID(),
  b = randomUUID(),
  r = randomUUID();
const scope = {
  caseId: randomUUID(),
  domainId: randomUUID(),
  agreementRevisionId: randomUUID(),
  agreementDigest: digest,
  sourceSiteId: a,
  targetSiteId: b,
  evidenceRecipientSiteId: r,
};
const query = ArbitrationContextQuerySchema.parse({
  protocolVersion: 1,
  kind: "arbitration-context-query",
  readId: randomUUID(),
  queryId: randomUUID(),
  scope,
  senderSiteId: r,
  recipientSiteId: a,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 30000).toISOString(),
});
const { evidenceRecipientSiteId, ...bindingScope } = scope;
const response = ArbitrationContextSchema.parse({
  ...query,
  kind: "arbitration-context",
  senderSiteId: a,
  recipientSiteId: r,
  queryDigest: digest,
  sourceJws: "source",
  targetJws: "target",
  financial: null,
  subject: { recordType: "bill", recordId: randomUUID(), recordDigest: digest },
  binding: {
    ...bindingScope,
    arbitratorSiteId: evidenceRecipientSiteId,
    caseDigest: digest,
    taskId: randomUUID(),
    attempt: 1,
    operationId: randomUUID(),
    reservationId: randomUUID(),
    requestDigest: digest,
    acceptanceDigest: digest,
    policyId: randomUUID(),
    policyDigest: digest,
    mode: "bilateral_direct",
    unit: "credit.micro",
    observedAt: now.toISOString(),
  },
});

test("arbitration context has independent human authority and signing purposes", () => {
  expect(federationCapabilitySources("arbitration.read")).toEqual(["arbitration.read"]);
  expect(federationCapabilitySources("arbitration.decide")).toEqual(["arbitration.decide"]);
  for (const capability of FederationCapabilitySchema.options.filter(
    (c) => c !== "arbitration.decide",
  ))
    expect(federationCapabilitySources(capability)).not.toContain("arbitration.decide");
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain("arbitration-decision");
  for (const capability of FederationCapabilitySchema.options.filter(
    (c) => c !== "arbitration.read",
  ))
    expect(federationCapabilitySources(capability)).not.toContain("arbitration.read");
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain(
    "arbitration-context-query",
  );
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain("arbitration-context");
});

test("arbitration context binds both scope and current query, with no permit or arbitrary extra fields", () => {
  expect(() => assertArbitrationContext(query, digest, response, now)).not.toThrow();
  for (const invalid of [
    { ...response, queryId: randomUUID() },
    { ...response, readId: randomUUID() },
    { ...response, senderSiteId: b },
    { ...response, binding: { ...response.binding, arbitratorSiteId: randomUUID() } },
    { ...response, binding: { ...response.binding, domainId: randomUUID() } },
    { ...response, scope: { ...scope, caseId: randomUUID() } },
  ])
    expect(() => assertArbitrationContext(query, digest, invalid, now)).toThrow("POLICY_DENIED");
  expect(ArbitrationContextSchema.safeParse({ ...response, executionApproved: true }).success).toBe(
    false,
  );
  expect(
    ArbitrationContextQuerySchema.safeParse({
      ...query,
      scope: { ...scope, policyId: randomUUID() },
    }).success,
  ).toBe(false);
});

test("arbitration context cannot extend a query and tolerates bounded institution clock skew", () => {
  for (const invalid of [
    { ...response, expiresAt: new Date(now.getTime() + 30001).toISOString() },
    { ...response, issuedAt: new Date(now.getTime() - 60001).toISOString() },
    {
      ...response,
      binding: { ...response.binding, observedAt: new Date(now.getTime() - 60001).toISOString() },
    },
    {
      ...response,
      binding: { ...response.binding, observedAt: new Date(now.getTime() + 1).toISOString() },
    },
  ])
    expect(() => assertArbitrationContext(query, digest, invalid, now)).toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  const skewed = {
    ...response,
    issuedAt: new Date(now.getTime() - 10000).toISOString(),
    expiresAt: new Date(now.getTime() + 20000).toISOString(),
    binding: { ...response.binding, observedAt: new Date(now.getTime() - 10000).toISOString() },
  };
  expect(ArbitrationContextSchema.safeParse(skewed).success).toBe(true);
  expect(() => assertArbitrationContext(query, digest, skewed, now)).not.toThrow();
  expect(() =>
    assertArbitrationContext(query, digest, response, new Date(query.expiresAt)),
  ).toThrow("AUTHORIZATION_EXPIRED");
  expect(
    ArbitrationContextQuerySchema.safeParse({
      ...query,
      expiresAt: new Date(now.getTime() + 60001).toISOString(),
    }).success,
  ).toBe(false);
});
