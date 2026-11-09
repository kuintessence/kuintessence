import { expect, test } from "bun:test";
import { CommercialArbitrationRevocationSchema } from "./arbitration-revocation";
import { FederationKeyInput } from "./trust";

test("arbitration withdrawal is unilateral, exact and cannot grant financial or execution powers", () => {
  const sourceSiteId = crypto.randomUUID(),
    targetSiteId = crypto.randomUUID();
  const value = CommercialArbitrationRevocationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-arbitration-revocation",
    revocationId: crypto.randomUUID(),
    policyId: crypto.randomUUID(),
    policyDigest: `sha256:${"a".repeat(64)}`,
    domainId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    agreementDigest: `sha256:${"b".repeat(64)}`,
    sourceSiteId,
    targetSiteId,
    issuerSiteId: sourceSiteId,
    issuedAt: "2027-01-01T00:00:00Z",
    salt: "c".repeat(64),
  });
  expect(
    CommercialArbitrationRevocationSchema.parse({ ...value, issuerSiteId: targetSiteId })
      .issuerSiteId,
  ).toBe(targetSiteId);
  for (const patch of [
    { issuerSiteId: crypto.randomUUID() },
    { targetSiteId: sourceSiteId },
    { policyDigest: "unknown" },
    { policyId: "unknown" },
    { amount: "10" },
    { unfreeze: true },
    { releaseReservation: true },
    { validUntil: "2028-01-01T00:00:00Z" },
  ])
    expect(CommercialArbitrationRevocationSchema.safeParse({ ...value, ...patch }).success).toBe(
      false,
    );
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("commercial-arbitration-revocation");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
