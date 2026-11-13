import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import type { z } from "zod";
import { CommercialDisclosureSchema } from "./disclosure";
import {
  assertCommercialDisclosurePolicy,
  type CommercialDisclosureContext,
  CommercialDisclosurePolicySchema,
  verifyCommercialDisclosure,
} from "./disclosure-authorization";
import {
  type FederationSigningKey,
  type FederationVerificationKey,
  signFederationMessage,
} from "./signatures";
import { FederationKeyInput } from "./trust";

const pairs = await Promise.all([
  generateKeyPair("RS256"),
  generateKeyPair("RS256"),
  generateKeyPair("RS256"),
]);
function digest(jws: string) {
  const payload = jws.split(".")[1];
  if (!payload) throw new Error("Missing signed payload");
  return `sha256:${createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex")}`;
}
async function fixture() {
  const sites = [randomUUID(), randomUUID(), randomUUID()];
  const signing = pairs.map((pair, i): FederationSigningKey => {
    const siteId = sites[i];
    if (!siteId) throw new Error("Missing site");
    return { siteId, keyId: `key-${i}`, privateKey: pair.privateKey };
  });
  const keys = pairs.map((pair, i): FederationVerificationKey => {
    const signer = signing[i];
    if (!signer) throw new Error("Missing signer");
    return {
      siteId: signer.siteId,
      keyId: signer.keyId,
      publicKey: pair.publicKey,
      validFrom: new Date("2027-01-01"),
      validUntil: new Date("2028-01-01"),
      revoked: false,
      allowedKinds: ["commercial-disclosure-policy", "commercial-disclosure"],
    };
  });
  const [source, target, recipient] = signing;
  if (!source || !target || !recipient) throw new Error("Missing parties");
  const sign = async <T>(schema: z.ZodType<T>, value: T) => {
    return {
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      sourceJws: await signFederationMessage(schema, value, source),
      targetJws: await signFederationMessage(schema, value, target),
    };
  };
  const policy = CommercialDisclosurePolicySchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure-policy",
    policyId: randomUUID(),
    domainId: randomUUID(),
    agreementRevisionId: randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    recipientSiteId: recipient.siteId,
    disclosures: [{ recordType: "payment", fields: ["amount", "unit"] }],
    issuedAt: "2027-01-01T00:00:00Z",
    validFrom: "2027-01-02T00:00:00Z",
    validUntil: "2027-02-01T00:00:00Z",
    salt: "b".repeat(64),
  });
  const policyEnvelope = await sign(CommercialDisclosurePolicySchema, policy);
  const disclosure = CommercialDisclosureSchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure",
    grant: {
      protocolVersion: 1,
      kind: "commercial-disclosure-grant",
      grantId: randomUUID(),
      caseId: randomUUID(),
      policyId: policy.policyId,
      policyDigest: digest(policyEnvelope.sourceJws),
      domainId: policy.domainId,
      agreementRevisionId: policy.agreementRevisionId,
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      recipientSiteId: recipient.siteId,
      recordType: "payment",
      recordId: randomUUID(),
      recordDigest: `sha256:${"c".repeat(64)}`,
      fields: ["amount"],
      validFrom: "2027-01-03T00:00:00Z",
      validUntil: "2027-01-31T00:00:00Z",
      salt: "d".repeat(64),
    },
    evidence: { recordType: "payment", values: { amount: "9007199254740993" } },
  });
  const disclosureEnvelope = await sign(CommercialDisclosureSchema, disclosure);
  const context: CommercialDisclosureContext = {
    ...disclosure.grant,
    agreementDigest: policy.agreementDigest,
    policyRevoked: false,
    grantRevoked: false,
  };
  const now = new Date("2027-01-10T00:00:00Z");
  return {
    source,
    target,
    recipient,
    sign,
    policy,
    policyEnvelope,
    disclosure,
    disclosureEnvelope,
    context,
    now,
    keys,
  };
}

test("both institutions approve the exact policy and projection without granting settlement authority", async () => {
  const f = await fixture();
  const result = await verifyCommercialDisclosure(
    f.policyEnvelope,
    f.disclosureEnvelope,
    f.keys,
    f.context,
    f.now,
  );
  expect(result.policy.payload).toEqual(f.policy);
  expect(result.disclosure.payload).toEqual(f.disclosure);
  expect(result.disclosure.digest).toBe(digest(f.disclosureEnvelope.sourceJws));
  expect(JSON.stringify(result)).not.toContain("sourceJws");
  for (const field of ["debitAmount", "arbitrate", "wallet", "settlementId"])
    expect(CommercialDisclosurePolicySchema.safeParse({ ...f.policy, [field]: "1" }).success).toBe(
      false,
    );
});

test("source signature alone and recipient signature cannot substitute for target approval", async () => {
  const f = await fixture();
  const r = await signFederationMessage(CommercialDisclosureSchema, f.disclosure, f.recipient);
  for (const targetJws of [f.disclosureEnvelope.sourceJws, r, "unsigned"])
    await expect(
      verifyCommercialDisclosure(
        f.policyEnvelope,
        { ...f.disclosureEnvelope, targetJws },
        f.keys,
        f.context,
        f.now,
      ),
    ).rejects.toThrow();
  await expect(
    verifyCommercialDisclosure(
      { ...f.policyEnvelope, targetJws: f.policyEnvelope.sourceJws },
      f.disclosureEnvelope,
      f.keys,
      f.context,
      f.now,
    ),
  ).rejects.toThrow();
});

test("different signed policies or different signed values are not a bilateral approval", async () => {
  const f = await fixture();
  const changedPolicy = await f.sign(CommercialDisclosurePolicySchema, {
    ...f.policy,
    salt: "e".repeat(64),
  });
  await expect(
    verifyCommercialDisclosure(
      { ...f.policyEnvelope, targetJws: changedPolicy.targetJws },
      f.disclosureEnvelope,
      f.keys,
      f.context,
      f.now,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  const changed = CommercialDisclosureSchema.parse({
    ...f.disclosure,
    evidence: { recordType: "payment", values: { amount: "1" } },
  });
  const signed = await f.sign(CommercialDisclosureSchema, changed);
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      { ...f.disclosureEnvelope, targetJws: signed.targetJws },
      f.keys,
      f.context,
      f.now,
    ),
  ).rejects.toThrow("POLICY_DENIED");
});

test("approval cannot enlarge the policy field whitelist or authorized lifetime", async () => {
  const f = await fixture();
  for (const changed of [
    {
      ...f.disclosure,
      grant: { ...f.disclosure.grant, fields: ["reason"] },
      evidence: { recordType: "payment", values: { reason: "PRIVATE_REASON" } },
    },
    { ...f.disclosure, grant: { ...f.disclosure.grant, validUntil: "2027-02-02T00:00:00Z" } },
    { ...f.disclosure, grant: { ...f.disclosure.grant, validFrom: "2027-01-01T00:00:00Z" } },
  ]) {
    const signed = await f.sign(
      CommercialDisclosureSchema,
      CommercialDisclosureSchema.parse(changed),
    );
    await expect(
      verifyCommercialDisclosure(f.policyEnvelope, signed, f.keys, f.context, f.now),
    ).rejects.toThrow("POLICY_DENIED");
  }
});

test("case, recipient, contract and original references must match current local context", async () => {
  const f = await fixture();
  for (const key of [
    "grantId",
    "caseId",
    "policyId",
    "domainId",
    "agreementRevisionId",
    "recordId",
    "recipientSiteId",
    "sourceSiteId",
    "targetSiteId",
  ] as const)
    await expect(
      verifyCommercialDisclosure(
        f.policyEnvelope,
        f.disclosureEnvelope,
        f.keys,
        { ...f.context, [key]: randomUUID() },
        f.now,
      ),
    ).rejects.toThrow();
  for (const key of ["policyDigest", "agreementDigest", "recordDigest"] as const)
    await expect(
      verifyCommercialDisclosure(
        f.policyEnvelope,
        f.disclosureEnvelope,
        f.keys,
        { ...f.context, [key]: `sha256:${"f".repeat(64)}` },
        f.now,
      ),
    ).rejects.toThrow("POLICY_DENIED");
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      f.disclosureEnvelope,
      f.keys,
      { ...f.context, recordType: "bill" },
      f.now,
    ),
  ).rejects.toThrow("POLICY_DENIED");
});

test("revoked policy, key revocation, expiry and missing purpose block new disclosure", async () => {
  const f = await fixture();
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      f.disclosureEnvelope,
      f.keys,
      { ...f.context, policyRevoked: true },
      f.now,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      f.disclosureEnvelope,
      f.keys,
      { ...f.context, grantRevoked: true },
      f.now,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  const first = f.keys[0];
  if (!first) throw new Error("Missing key");
  for (const patch of [
    { revoked: true },
    { validUntil: f.now },
    { allowedKinds: [] },
    { allowedKinds: ["commercial-disclosure-policy"] as const },
    { allowedKinds: ["commercial-disclosure"] as const },
  ])
    await expect(
      verifyCommercialDisclosure(
        f.policyEnvelope,
        f.disclosureEnvelope,
        [{ ...first, ...patch }, ...f.keys.slice(1)],
        f.context,
        f.now,
      ),
    ).rejects.toThrow("UNTRUSTED_IDENTITY");
  for (const now of [
    new Date("invalid"),
    new Date(f.disclosure.grant.validUntil),
    new Date(Date.parse(f.disclosure.grant.validFrom) - 1),
  ])
    await expect(
      verifyCommercialDisclosure(f.policyEnvelope, f.disclosureEnvelope, f.keys, f.context, now),
    ).rejects.toThrow();
});

test("unknown or ambiguous key selection and envelope identity substitution fail closed", async () => {
  const f = await fixture();
  const first = f.keys[0];
  if (!first) throw new Error("Missing key");
  for (const keys of [f.keys.slice(1), [...f.keys, first]])
    await expect(
      verifyCommercialDisclosure(f.policyEnvelope, f.disclosureEnvelope, keys, f.context, f.now),
    ).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      { ...f.disclosureEnvelope, targetSiteId: f.recipient.siteId },
      f.keys,
      f.context,
      f.now,
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("tampered signed values and raw private error input are rejected without disclosure", async () => {
  const f = await fixture();
  const chunks = f.disclosureEnvelope.sourceJws.split(".");
  chunks[1] = Buffer.from(
    JSON.stringify({ ...f.disclosure, privateProbe: "PRIVATE_ERROR_PROBE" }),
  ).toString("base64url");
  await expect(
    verifyCommercialDisclosure(
      f.policyEnvelope,
      { ...f.disclosureEnvelope, sourceJws: chunks.join(".") },
      f.keys,
      f.context,
      f.now,
    ),
  ).rejects.toThrow("INVALID_MESSAGE");
});

test("policy scope is strict, rejects duplicate selectors and has explicit independent key purposes", async () => {
  const f = await fixture();
  for (const patch of [
    { disclosures: [] },
    { disclosures: [f.policy.disclosures[0], f.policy.disclosures[0]] },
    { disclosures: [{ recordType: "payment", fields: ["amount", "amount"] }] },
    { disclosures: [{ recordType: "payment", fields: ["prices"] }] },
    { recipientSiteId: f.source.siteId },
    { validUntil: f.policy.validFrom },
    { issuedAt: "2027-01-03T00:00:00Z" },
  ])
    expect(CommercialDisclosurePolicySchema.safeParse({ ...f.policy, ...patch }).success).toBe(
      false,
    );
  expect(() =>
    assertCommercialDisclosurePolicy(
      f.disclosure.grant,
      { ...f.policy, disclosures: [{ recordType: "bill", fields: ["dueAmount"] }] },
      f.context.policyDigest,
      f.now,
    ),
  ).toThrow("POLICY_DENIED");
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("commercial-disclosure-policy");
  expect(kinds).toContain("commercial-disclosure");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
