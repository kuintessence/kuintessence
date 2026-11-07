import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  CommercialAgreementSchema,
  type CommercialProposalInput,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import {
  type CommercialAdapterConfig,
  CommercialAdapterConfigSchema,
  FabricCommercialAdapter,
} from "./commercial";

let config: CommercialAdapterConfig;
let input: CommercialProposalInput;
const keys: FederationSigningKey[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
beforeAll(async () => {
  const sites = [randomUUID(), randomUUID(), randomUUID()] as const;
  const organizations: CommercialAdapterConfig["trust"]["organizations"] = [];
  for (const [index, siteId] of sites.entries()) {
    const pair = await generateKeyPair("RS256", { extractable: true });
    keys.push({ siteId, keyId: "commercial-1", privateKey: pair.privateKey });
    organizations.push({
      siteId,
      mspId: `${String.fromCharCode(65 + index)}MSP`,
      keys: [
        {
          keyId: "commercial-1",
          publicKeyPem: await exportSPKI(pair.publicKey),
          validFrom: "2025-01-01T00:00:00Z",
          validUntil: "2099-01-01T00:00:00Z",
        },
      ],
    });
  }
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing fixture signers");
  const domainId = randomUUID();
  config = CommercialAdapterConfigSchema.parse({
    siteId: sites[0],
    channel: "cooperation",
    chaincode: "kq-commercial",
    trust: {
      version: 1,
      generationId: randomUUID(),
      organizations,
      domains: [{ domainId, collection: "commercial_AB", siteIds: [sites[0], sites[1]] }],
      keyPurposes: keys.map((key) => ({
        siteId: key.siteId,
        keyId: key.keyId,
        kinds: ["commercial-agreement", "commercial-usage"],
      })),
    },
  });
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId,
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: randomUUID(),
      sourceSiteId: sites[0],
      targetSiteId: sites[1],
      mode: "bilateral_attested",
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      unit: "credit.micro",
      budgetLimit: "9007199254740993",
      maxTaskAmount: "100",
      maxReservations: 10,
      validFrom: "2025-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
      templates: [
        {
          originSiteId: sites[0],
          kind: "script",
          id: randomUUID(),
          revision: "1",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
      termsDigest: `sha256:${"b".repeat(64)}`,
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        perQuantity: "3600",
        amount: "9007199254740993",
      },
    ],
    termsText: "PRIVATE-AGREEMENT-FIXTURE",
  });
  const sourceJws = await signFederationMessage(CommercialAgreementSchema, terms, source);
  const payload = sourceJws.split(".")[1];
  if (!payload) throw new Error("Missing payload");
  input = {
    operation: "register-agreement",
    domainId,
    recordId: terms.agreement.agreementRevisionId,
    digest: `sha256:${createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex")}`,
    envelope: {
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      sourceJws,
      targetJws: await signFederationMessage(CommercialAgreementSchema, terms, target),
    },
  };
});
function setup(overrides: Partial<CommercialAdapterConfig> = {}) {
  const configured = CommercialAdapterConfigSchema.parse({ ...config, ...overrides });
  const member = configured.trust.organizations.find((org) => org.siteId === configured.siteId);
  if (!member) throw new Error("Missing local institution");
  const client = new Client("127.0.0.1:1", credentials.createInsecure());
  const identity = { mspId: member.mspId, credentials: Buffer.from("sdk-test-identity") };
  const signer = signers.newPrivateKeySigner(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  );
  const gateway = connect({ client, identity, signer });
  cleanups.push(() => {
    gateway.close();
    client.close();
  });
  const key = randomBytes(32),
    adapter = new FabricCommercialAdapter(configured, gateway, identity, signer, key);
  const sdk = spyOn(gateway, "getNetwork");
  return { configured, adapter, gateway, identity, signer, key, sdk };
}
function decode(fixture: ReturnType<typeof setup>, token: string) {
  const bytes = Buffer.from(token, "base64"),
    cipher = createDecipheriv("aes-256-gcm", fixture.key, bytes.subarray(0, 12));
  cipher.setAAD(
    createHash("sha256")
      .update(JSON.stringify({ purpose: "kq-commercial-v1", config: fixture.configured }))
      .update(fixture.identity.credentials)
      .digest(),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return z
    .object({ batchId: z.string(), digest: z.string(), message: z.object({ bytes: z.string() }) })
    .parse(
      JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()),
    );
}
test("commercial proposals encrypt exact signed terms and target only the two configured member MSPs", async () => {
  const fixture = setup(),
    prepared = await fixture.adapter.prepare(input);
  expect(Buffer.from(prepared.recovery, "base64").toString()).not.toContain(
    "PRIVATE-AGREEMENT-FIXTURE",
  );
  const stored = decode(fixture, prepared.recovery);
  expect(stored.batchId).toBe(input.recordId);
  expect(stored.digest).toBe(input.digest);
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  expect(proposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(payload.getTransientmapMap().get("commercial") ?? []).toString()).toBe(
    JSON.stringify(input.envelope),
  );
  const invoke = peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8());
  expect(
    invoke
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((bytes) => Buffer.from(bytes).toString()),
  ).toEqual(["RegisterAgreement", input.domainId, input.recordId]);
});
test("wrong digest, record, domain, signer or key purpose fails before SDK proposal creation", async () => {
  const fixture = setup();
  for (const changed of [
    { ...input, digest: `sha256:${"0".repeat(64)}` },
    { ...input, recordId: randomUUID() },
    { ...input, domainId: randomUUID() },
  ])
    await expect(fixture.adapter.prepare(changed)).rejects.toThrow("POLICY_DENIED");
  if (input.operation !== "register-agreement") throw new Error("Missing agreement");
  await expect(
    fixture.adapter.prepare({
      ...input,
      envelope: { ...input.envelope, targetJws: input.envelope.sourceJws },
    }),
  ).rejects.toThrow();
  expect(fixture.sdk).not.toHaveBeenCalled();
  const trust = structuredClone(config.trust);
  const purposes = trust.keyPurposes[0];
  if (!purposes) throw new Error("Missing purpose");
  purposes.kinds = ["commercial-usage"];
  const denied = setup({ trust });
  await expect(denied.adapter.prepare(input)).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(denied.sdk).not.toHaveBeenCalled();
});
test("another institution, config generation, credential or recovery key cannot resume this checkpoint", async () => {
  const original = setup(),
    checkpoint = await original.adapter.prepare(input);
  const foreign = config.trust.organizations[2];
  if (!foreign) throw new Error("Missing foreign institution");
  await expect(setup({ siteId: foreign.siteId }).adapter.prepare(input)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const variants = [
    new FabricCommercialAdapter(
      { ...config, channel: "other" },
      original.gateway,
      original.identity,
      original.signer,
      original.key,
    ),
    new FabricCommercialAdapter(
      config,
      original.gateway,
      { ...original.identity, credentials: Buffer.from("changed-identity") },
      original.signer,
      original.key,
    ),
    new FabricCommercialAdapter(
      config,
      original.gateway,
      original.identity,
      original.signer,
      randomBytes(32),
    ),
    new FabricCommercialAdapter(
      { ...config, trust: { ...config.trust, generationId: randomUUID() } },
      original.gateway,
      original.identity,
      original.signer,
      original.key,
    ),
  ];
  for (const adapter of variants)
    await expect(adapter.advance(checkpoint.recovery)).rejects.toThrow("INVALID_RECOVERY");
});
test("only the executing institution can propose its signed usage", async () => {
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing signers");
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: input.domainId,
    agreementRevisionId: input.recordId,
    agreementDigest: input.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    taskId: randomUUID(),
    attempt: 1,
    salt: randomBytes(32).toString("hex"),
    reportedAt: new Date().toISOString(),
    periodStart: "2025-01-01T00:00:00Z",
    periodEnd: "2025-01-02T00:00:00Z",
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "9007199254740993",
        evidenceDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
  });
  const providerJws = await signFederationMessage(CommercialUsageSchema, report, target);
  const payload = providerJws.split(".")[1];
  if (!payload) throw new Error("Missing payload");
  const request: CommercialProposalInput = {
    operation: "record-usage",
    recordId: report.reportId,
    domainId: report.domainId,
    digest: `sha256:${createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex")}`,
    envelope: { providerJws },
  };
  await expect(setup().adapter.prepare(request)).rejects.toThrow();
  const receiver = setup({ siteId: target.siteId });
  expect((await receiver.adapter.prepare(request)).transactionId).toMatch(/^[a-f0-9]{64}$/);
});
