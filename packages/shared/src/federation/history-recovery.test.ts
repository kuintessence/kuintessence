import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { CommercialAdapterProposalInputSchema, CommercialUsageSchema } from "./commercial";
import { CommercialHistoryRecoverySchema } from "./history-recovery";
import {
  commercialHistoryDigest,
  verifyArchivedCommercialDocument,
  verifyCommercialHistoryEnvelope,
  verifyOriginalCommercialHistory,
} from "./history-recovery-proof";
import { federationCanonicalJson } from "./index";
import {
  type FederationVerificationKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";

async function fixture() {
  const sourceSiteId = randomUUID(),
    targetSiteId = randomUUID(),
    now = new Date();
  const [oldPair, sourcePair, targetPair] = await Promise.all([
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
    generateKeyPair("RS256"),
  ]);
  const old = { siteId: targetSiteId, keyId: "archived", privateKey: oldPair.privateKey };
  const current = [
    { siteId: sourceSiteId, keyId: "current-a", privateKey: sourcePair.privateKey },
    { siteId: targetSiteId, keyId: "current-b", privateKey: targetPair.privateKey },
  ];
  const verification: FederationVerificationKey[] = current.map((key, index) => ({
    siteId: key.siteId,
    keyId: key.keyId,
    publicKey: index === 0 ? sourcePair.publicKey : targetPair.publicKey,
    validFrom: new Date(now.getTime() - 86400000),
    validUntil: new Date(now.getTime() + 86400000),
    revoked: false,
    allowedKinds: ["commercial-history-recovery"],
  }));
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: randomUUID(),
    agreementRevisionId: randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    sourceSiteId,
    targetSiteId,
    taskId: randomUUID(),
    attempt: 1,
    salt: randomBytes(32).toString("hex"),
    reportedAt: "2026-01-01T00:00:02.000Z",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-01-01T00:00:01.000Z",
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "1",
        evidenceDigest: `sha256:${"b".repeat(64)}`,
      },
    ],
  });
  const oldJws = await signFederationMessage(CommercialUsageSchema, report, old);
  const originalDigest = `sha256:${createHash("sha256")
    .update(Buffer.from(oldJws.split(".")[1] ?? "", "base64url"))
    .digest("hex")}`;
  const input = CommercialAdapterProposalInputSchema.parse({
    operation: "record-usage",
    domainId: report.domainId,
    recordId: report.reportId,
    digest: originalDigest,
    envelope: { providerJws: oldJws },
  });
  const payload = CommercialHistoryRecoverySchema.parse({
    protocolVersion: 1,
    kind: "commercial-history-recovery",
    recoveryId: randomUUID(),
    domainId: report.domainId,
    agreementRevisionId: report.agreementRevisionId,
    sourceSiteId,
    targetSiteId,
    mode: "bilateral_attested",
    assertion: "acknowledge-original-record",
    originalOperation: "record-usage",
    originalRecordId: report.reportId,
    originalDigest,
    originalInputDigest: commercialHistoryDigest(input),
    reason: "Both institutions reviewed the preserved report",
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const [a, b] = current;
  if (!a || !b) throw new Error("Missing current keys");
  const envelope = {
    sourceSiteId,
    targetSiteId,
    sourceJws: await signFederationMessage(CommercialHistoryRecoverySchema, payload, a),
    targetJws: await signFederationMessage(CommercialHistoryRecoverySchema, payload, b),
    originalInput: federationCanonicalJson(input),
  };
  const verify = <T extends { kind: string }>(
    schema: Parameters<typeof verifyFederationMessage<T>>[0],
    jws: string,
    siteId: string,
  ) => {
    const key = verification.find((item) => item.siteId === siteId);
    if (!key) throw new Error("Missing current key");
    return verifyFederationMessage(schema, jws, key, now);
  };
  const archived = <T extends { kind: string }>(
    schema: Parameters<typeof verifyFederationMessage<T>>[0],
    jws: string,
    siteId: string,
  ) =>
    verifyArchivedCommercialDocument(schema, jws, siteId, async (site, kid) => {
      if (site !== targetSiteId || kid !== old.keyId) throw new Error("Unknown archive key");
      return oldPair.publicKey;
    });
  return { envelope, payload, verification, verify, archived, now, oldPair, old, oldJws, input };
}

test("history recovery requires current dual approval without renewing expired original authority", async () => {
  const f = await fixture();
  expect(
    (
      await verifyCommercialHistoryEnvelope(
        f.envelope,
        f.payload.domainId,
        f.payload.recoveryId,
        f.verify,
        f.archived,
        f.now,
      )
    ).payload,
  ).toEqual(f.payload);
  await expect(
    verifyFederationMessage(
      CommercialUsageSchema,
      f.oldJws,
      {
        siteId: f.old.siteId,
        keyId: f.old.keyId,
        publicKey: f.oldPair.publicKey,
        validFrom: new Date("2025-01-01"),
        validUntil: new Date("2026-02-01"),
        revoked: true,
        allowedKinds: ["commercial-usage"],
      },
      f.now,
    ),
  ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
});

test("history recovery refuses changed original bytes or a different original digest", async () => {
  const f = await fixture();
  for (const originalInput of [
    JSON.stringify(f.input),
    federationCanonicalJson({ ...f.input, digest: `sha256:${"f".repeat(64)}` }),
  ]) {
    if (originalInput === f.envelope.originalInput) continue;
    await expect(
      verifyCommercialHistoryEnvelope(
        { ...f.envelope, originalInput },
        f.payload.domainId,
        f.payload.recoveryId,
        f.verify,
        f.archived,
        f.now,
      ),
    ).rejects.toBeDefined();
  }
  await expect(
    verifyCommercialHistoryEnvelope(
      {
        ...f.envelope,
        originalInput: federationCanonicalJson({
          ...f.input,
          envelope: { providerJws: `${f.oldJws.slice(0, -4)}AAAA` },
        }),
      },
      f.payload.domainId,
      f.payload.recoveryId,
      f.verify,
      f.archived,
      f.now,
    ),
  ).rejects.toBeDefined();
});

test("retired current recovery keys and missing explicit recovery purpose cannot approve archives", async () => {
  for (const missing of ["revoked", "purpose"] as const) {
    const f = await fixture(),
      key = f.verification[1];
    if (!key) throw new Error("Missing target key");
    if (missing === "revoked") key.revoked = true;
    else key.allowedKinds = ["commercial-usage"];
    await expect(
      verifyCommercialHistoryEnvelope(
        f.envelope,
        f.payload.domainId,
        f.payload.recoveryId,
        f.verify,
        f.archived,
        f.now,
      ),
    ).rejects.toMatchObject({ code: "UNTRUSTED_IDENTITY" });
  }
});

test("history recovery never accepts executable coordination or recursive recovery as its original", () => {
  expect(
    CommercialHistoryRecoverySchema.shape.originalOperation.safeParse("reserve-execution").success,
  ).toBe(false);
  expect(
    CommercialHistoryRecoverySchema.shape.originalOperation.safeParse("resolve-arbitrated-case")
      .success,
  ).toBe(false);
  expect(
    CommercialHistoryRecoverySchema.shape.originalOperation.safeParse(
      "record-historical-commercial",
    ).success,
  ).toBe(false);
});

test("malformed original JSON and unsupported envelopes fail as protocol errors", async () => {
  const f = await fixture();
  for (const originalInput of ["{", "{}", "null"]) {
    await expect(
      verifyCommercialHistoryEnvelope(
        { ...f.envelope, originalInput },
        f.payload.domainId,
        f.payload.recoveryId,
        f.verify,
        f.archived,
        f.now,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
  }
});

test("malformed archived arbitration hints fail as protocol errors before key lookup", async () => {
  const f = await fixture();
  let keyLookups = 0;
  for (const decisionJws of ["broken", "header.ew.signature", "header.e30.signature"]) {
    const input = CommercialAdapterProposalInputSchema.parse({
      ...f.input,
      operation: "record-arbitration-resolution",
      envelope: {
        sourceSiteId: f.payload.sourceSiteId,
        targetSiteId: f.payload.targetSiteId,
        decisionJws,
        requestJws: "preserved.request",
        acceptanceJws: "preserved.acceptance",
      },
    });
    await expect(
      verifyOriginalCommercialHistory(
        { ...f.payload, originalOperation: "record-arbitration-resolution" },
        input,
        async () => {
          keyLookups++;
          throw new Error("Malformed hint must not select a key");
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
  }
  expect(keyLookups).toBe(0);
});
