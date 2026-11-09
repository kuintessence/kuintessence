import { expect, test } from "bun:test";
import {
  assertCommercialDisclosureReadAuthorization,
  CommercialDisclosureDownloadQuerySchema,
  CommercialDisclosureReadAuthorizationSchema,
  CommercialDisclosureReadQuerySchema,
} from "./disclosure-authorization";
import { FederationKeyInput } from "./trust";

function fixture() {
  const scope = {
    grantId: crypto.randomUUID(),
    disclosureDigest: `sha256:${"a".repeat(64)}`,
    caseId: crypto.randomUUID(),
    policyId: crypto.randomUUID(),
    policyDigest: `sha256:${"b".repeat(64)}`,
    domainId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    agreementDigest: `sha256:${"c".repeat(64)}`,
    sourceSiteId: crypto.randomUUID(),
    targetSiteId: crypto.randomUUID(),
    evidenceRecipientSiteId: crypto.randomUUID(),
  };
  const now = new Date("2026-11-09T00:00:00Z"),
    query = CommercialDisclosureReadQuerySchema.parse({
      protocolVersion: 1,
      kind: "commercial-disclosure-read-query",
      queryId: crypto.randomUUID(),
      readId: crypto.randomUUID(),
      scope,
      senderSiteId: scope.evidenceRecipientSiteId,
      recipientSiteId: scope.sourceSiteId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30000).toISOString(),
    });
  const digest = `sha256:${"d".repeat(64)}`;
  const authorization = CommercialDisclosureReadAuthorizationSchema.parse({
    ...query,
    kind: "commercial-disclosure-read-authorization",
    queryDigest: digest,
    senderSiteId: query.recipientSiteId,
    recipientSiteId: query.senderSiteId,
  });
  return { query, authorization, digest, now };
}

test("disclosure read protocol binds three distinct institutions and a maximum thirty-second window", () => {
  const f = fixture();
  assertCommercialDisclosureReadAuthorization(f.query, f.digest, f.authorization, f.now);
  for (const patch of [
    { senderSiteId: f.query.scope.sourceSiteId },
    { recipientSiteId: f.query.senderSiteId },
    { expiresAt: new Date(f.now.getTime() + 30001).toISOString() },
    { expiresAt: f.query.issuedAt },
    { values: { amount: "1" } },
    { revoked: false },
    { approvalJws: "raw-private-signature" },
    { scope: { ...f.query.scope, evidenceRecipientSiteId: f.query.scope.sourceSiteId } },
  ])
    expect(CommercialDisclosureReadQuerySchema.safeParse({ ...f.query, ...patch }).success).toBe(
      false,
    );
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain(
    "commercial-disclosure-read-query",
  );
  expect(FederationKeyInput.shape.allowedKinds.element.options).toContain(
    "commercial-disclosure-read-authorization",
  );
  expect(
    FederationKeyInput.shape.allowedKinds.safeParse(
      FederationKeyInput.shape.allowedKinds.element.options,
    ).success,
  ).toBe(true);
});

test("disclosure read refuses another request, side, projection or expired observation", () => {
  const f = fixture();
  for (const patch of [
    { queryId: crypto.randomUUID() },
    { readId: crypto.randomUUID() },
    { queryDigest: `sha256:${"e".repeat(64)}` },
    { senderSiteId: f.query.scope.targetSiteId },
    { scope: { ...f.query.scope, grantId: crypto.randomUUID() } },
    { scope: { ...f.query.scope, disclosureDigest: `sha256:${"e".repeat(64)}` } },
    { issuedAt: new Date(f.now.getTime() + 1).toISOString() },
  ])
    expect(() =>
      assertCommercialDisclosureReadAuthorization(
        f.query,
        f.digest,
        CommercialDisclosureReadAuthorizationSchema.parse({ ...f.authorization, ...patch }),
        f.now,
      ),
    ).toThrow();
  expect(() =>
    assertCommercialDisclosureReadAuthorization(
      f.query,
      f.digest,
      f.authorization,
      new Date(f.now.getTime() + 30000),
    ),
  ).toThrow("AUTHORIZATION_EXPIRED");
});

test("disclosure downloads retain bounded originals and require exactly two authorization envelopes", () => {
  const f = fixture();
  const query = {
    ...f.query,
    kind: "commercial-disclosure-download-query",
    part: "disclosure-source",
    authorizations: [
      { queryJws: "signed-query-a", authorizationJws: "signed-authorization-a" },
      { queryJws: "signed-query-b", authorizationJws: "signed-authorization-b" },
    ],
  };
  expect(CommercialDisclosureDownloadQuerySchema.safeParse(query).success).toBe(true);
  for (const patch of [
    { authorizations: query.authorizations.slice(0, 1) },
    { authorizations: [...query.authorizations, query.authorizations[0]] },
    { part: "commercial-original" },
    { includePrices: true },
    { senderSiteId: f.query.scope.sourceSiteId },
  ])
    expect(CommercialDisclosureDownloadQuerySchema.safeParse({ ...query, ...patch }).success).toBe(
      false,
    );
});
