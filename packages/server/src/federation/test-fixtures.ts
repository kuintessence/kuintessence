import type {
  FederationAgreement,
  FederationDelegation,
  FederationMode,
} from "@kuintessence/shared/federation";
import { generateKeyPair } from "jose";
import type { FederationSigningKey, FederationVerificationKey } from "./signatures";

export const testNow = new Date("2026-01-01T00:00:00.000Z");
export async function testKeys(siteId: string = crypto.randomUUID()) {
  const pair = await generateKeyPair("RS256");
  const keyId = `test-${siteId}`;
  const signing: FederationSigningKey = { siteId, keyId, privateKey: pair.privateKey };
  const verification: FederationVerificationKey = {
    siteId,
    keyId,
    publicKey: pair.publicKey,
    validFrom: new Date("2025-01-01T00:00:00.000Z"),
    validUntil: new Date("2027-01-01T00:00:00.000Z"),
    revoked: false,
    allowedKinds: ["agreement", "delegation", "acceptance"],
  };
  return { signing, verification };
}

export function testAgreement(
  sourceSiteId: string,
  targetSiteId: string,
  mode: FederationMode = "bilateral_direct",
): FederationAgreement {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    protocolVersion: 1,
    kind: "agreement",
    agreementRevisionId: crypto.randomUUID(),
    sourceSiteId,
    targetSiteId,
    mode,
    budgetDomainId: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    unit: "credit.micro",
    budgetLimit: "100",
    maxTaskAmount: "60",
    maxReservations: 100,
    validFrom: "2025-12-31T00:00:00.000Z",
    validUntil: "2026-01-02T00:00:00.000Z",
    templates: [
      {
        originSiteId: sourceSiteId,
        kind: "script",
        id: crypto.randomUUID(),
        revision: "v1",
        digest,
      },
    ],
    resourceLimit: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 },
    termsDigest: digest,
  };
}

export function testDelegation(terms: FederationAgreement): FederationDelegation {
  const template = terms.templates[0];
  if (!template) throw new Error("Test agreement requires a template");
  return {
    protocolVersion: 1,
    kind: "delegation",
    operationId: crypto.randomUUID(),
    senderSiteId: terms.sourceSiteId,
    recipientSiteId: terms.targetSiteId,
    agreementRevisionId: terms.agreementRevisionId,
    mode: terms.mode,
    budgetDomainId: terms.budgetDomainId,
    epoch: terms.epoch,
    taskId: crypto.randomUUID(),
    attempt: 1,
    issuedAt: testNow.toISOString(),
    expiresAt: "2026-01-01T00:10:00.000Z",
    template,
    inputManifestDigest: terms.termsDigest,
    environmentLockDigest: terms.termsDigest,
    resources: terms.resourceLimit,
    maxAmount: "60",
    unit: terms.unit,
  };
}
