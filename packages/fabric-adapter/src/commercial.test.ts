import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Client, credentials, Metadata } from "@grpc/grpc-js";
import { connect, GatewayError, signers } from "@hyperledger/fabric-gateway";
import { peer, gateway as proto } from "@hyperledger/fabric-protos";
import { FederationCancellationReceiptSchema } from "@kuintessence/shared/federation";
import { CommercialArbitrationRevocationSchema } from "@kuintessence/shared/federation/arbitration-revocation";
import {
  CommercialAdapterProposalInputSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  type CommercialExecutionProposalInput,
  CommercialExecutionProposalInputSchema,
  CommercialPaymentSchema,
  type CommercialProposalInput,
  CommercialRefundSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
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
        kinds: [
          "commercial-agreement",
          "commercial-arbitration-revocation",
          "commercial-usage",
          "commercial-reservation",
          "commercial-release",
          "commercial-terminal",
          "commercial-discount",
          "commercial-bill",
          "commercial-settlement",
          "commercial-adjustment",
          "commercial-refund",
          "commercial-payment",
          "commercial-dispute",
          "commercial-dispute-freeze",
          "cancellation-receipt",
        ],
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
test("arbitration withdrawals keep signatures transient, require a current purpose and retain A/B endorsement", async () => {
  const a = keys[0],
    b = keys[1];
  if (!a || !b) throw new Error("Missing fixture parties");
  const payload = CommercialArbitrationRevocationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-arbitration-revocation",
    revocationId: randomUUID(),
    policyId: randomUUID(),
    policyDigest: `sha256:${"a".repeat(64)}`,
    domainId: input.domainId,
    agreementRevisionId: input.recordId,
    agreementDigest: input.digest,
    sourceSiteId: a.siteId,
    targetSiteId: b.siteId,
    issuerSiteId: b.siteId,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const jws = await signFederationMessage(CommercialArbitrationRevocationSchema, payload, b);
  const value = CommercialAdapterProposalInputSchema.parse({
    operation: "revoke-arbitration-policy",
    domainId: payload.domainId,
    recordId: payload.revocationId,
    policyId: payload.policyId,
    digest: `sha256:${createHash("sha256")
      .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`,
    envelope: { issuerSiteId: b.siteId, revocationJws: jws },
  });
  if (value.operation !== "revoke-arbitration-policy") throw new Error("Missing withdrawal");
  const f = setup(),
    prepared = await f.adapter.prepare(value);
  const stored = decode(f, prepared.recovery);
  expect(Buffer.from(prepared.recovery, "base64").toString()).not.toContain(jws);
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  expect(proposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing SDK proposal");
  const wire = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(wire.getTransientmapMap().get("commercial") ?? []).toString()).toBe(
    JSON.stringify(value.envelope),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(wire.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((bytes) => Buffer.from(bytes).toString()),
  ).toEqual(["RevokeArbitrationPolicy", value.domainId, value.recordId]);
  const denied = setup();
  for (const patch of [
    { policyId: randomUUID() },
    { recordId: randomUUID() },
    { digest: `sha256:${"0".repeat(64)}` },
    { envelope: { ...value.envelope, issuerSiteId: a.siteId } },
  ])
    await expect(denied.adapter.prepare({ ...value, ...patch })).rejects.toThrow();
  expect(denied.sdk).not.toHaveBeenCalled();
  const trust = structuredClone(config.trust);
  for (const key of trust.keyPurposes)
    key.kinds = key.kinds.filter((kind) => kind !== "commercial-arbitration-revocation");
  await expect(setup({ trust }).adapter.prepare(value)).rejects.toThrow("UNTRUSTED_IDENTITY");
});

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

async function executionFixture() {
  const source = keys[0],
    target = keys[1];
  if (!source || !target || input.operation !== "register-agreement")
    throw new Error("Missing signers");
  const raw = input.envelope.sourceJws.split(".")[1];
  if (!raw) throw new Error("Missing fixture payload");
  const terms = CommercialAgreementSchema.parse(
    JSON.parse(Buffer.from(raw, "base64url").toString()),
  );
  const reservation = CommercialReservationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-reservation",
    domainId: input.domainId,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    claimVersion: 2,
    agreementDigest: input.digest,
    salt: randomBytes(32).toString("hex"),
    request: {
      protocolVersion: 1,
      kind: "delegation",
      operationId: randomUUID(),
      senderSiteId: source.siteId,
      recipientSiteId: target.siteId,
      agreementRevisionId: input.recordId,
      mode: "ledger_coordinated",
      budgetDomainId: terms.agreement.budgetDomainId,
      epoch: terms.agreement.epoch,
      unit: terms.agreement.unit,
      taskId: randomUUID(),
      attempt: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      template: terms.agreement.templates[0],
      resources: terms.agreement.resourceLimit,
      inputManifestDigest: `sha256:${"c".repeat(64)}`,
      environmentLockDigest: `sha256:${"d".repeat(64)}`,
      maxAmount: "100",
    },
  });
  const signed = async <T extends { domainId: string }>(
    schema: z.ZodType<T>,
    payload: T,
    operation: CommercialExecutionProposalInput["operation"],
    recordId: string,
  ) => {
    const sourceJws = await signFederationMessage(schema, payload, source),
      bytes = sourceJws.split(".")[1];
    if (!bytes) throw new Error("Missing signature payload");
    return CommercialExecutionProposalInputSchema.parse({
      operation,
      domainId: payload.domainId,
      recordId,
      digest: `sha256:${createHash("sha256").update(Buffer.from(bytes, "base64url")).digest("hex")}`,
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws,
        targetJws: await signFederationMessage(schema, payload, target),
      },
    });
  };
  const reserve = await signed(
    CommercialReservationSchema,
    reservation,
    "reserve-execution",
    reservation.reservationId,
  );
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    domainId: input.domainId,
    releaseId: randomUUID(),
    reservationId: reservation.reservationId,
    reservationDigest: reserve.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    expectedGateVersion: 1,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "PRIVATE-RELEASE-FIXTURE",
  });
  return {
    reserve,
    release: await signed(CommercialReleaseSchema, release, "release-execution", release.releaseId),
    reservation,
    signed,
  };
}
test("execution adapter binds both signatures and recovery to exact private operation and member-only endorsement", async () => {
  const f = setup(),
    values = await executionFixture();
  for (const input of [values.reserve, values.release]) {
    const checkpoint = await f.adapter.prepare(input),
      stored = decode(f, checkpoint.recovery);
    expect(stored).toMatchObject({ batchId: input.recordId, digest: input.digest });
    expect(
      Buffer.from(checkpoint.recovery, "base64").includes(Buffer.from(input.envelope.sourceJws)),
    ).toBe(false);
    const proposed = proto.ProposedTransaction.deserializeBinary(
      Buffer.from(stored.message.bytes, "base64"),
    );
    expect(proposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
    const signed = proposed.getProposal();
    if (!signed) throw new Error("Missing SDK proposal");
    const payload = peer.ChaincodeProposalPayload.deserializeBinary(
      peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
    );
    expect(Buffer.from(payload.getTransientmapMap().get("commercial") ?? []).toString()).toBe(
      JSON.stringify(input.envelope),
    );
    const args = peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((value) => Buffer.from(value).toString());
    expect(args).toEqual([
      input.operation === "reserve-execution" ? "ReserveExecution" : "ReleaseExecution",
      input.domainId,
      input.recordId,
    ]);
  }
});
test("execution adapter rejects crossed signatures, binding and signing authority before private disclosure", async () => {
  const f = setup(),
    values = await executionFixture();
  for (const input of [values.reserve, values.release]) {
    await expect(f.adapter.prepare({ ...input, recordId: randomUUID() })).rejects.toThrow(
      "POLICY_DENIED",
    );
    await expect(
      f.adapter.prepare({ ...input, digest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toThrow("POLICY_DENIED");
    await expect(
      f.adapter.prepare({
        ...input,
        envelope: { ...input.envelope, targetJws: input.envelope.sourceJws },
      }),
    ).rejects.toThrow();
  }
  const changed = {
    ...values.reservation,
    request: { ...values.reservation.request, mode: "bilateral_direct" as const },
  };
  await expect(
    f.adapter.prepare(
      await values.signed(
        CommercialReservationSchema,
        changed,
        "reserve-execution",
        changed.reservationId,
      ),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  expect(f.sdk).not.toHaveBeenCalled();
  const trust = structuredClone(config.trust);
  for (const purpose of trust.keyPurposes)
    purpose.kinds = ["commercial-agreement", "commercial-usage"];
  const denied = setup({ trust });
  await expect(denied.adapter.prepare(values.reserve)).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(denied.adapter.prepare(values.release)).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(denied.sdk).not.toHaveBeenCalled();
});
test("commercial gate query exposes only a bounded current hash and rejects unowned domains before SDK access", async () => {
  const f = setup(),
    query = {
      operation: "get-execution-gate-hash" as const,
      domainId: input.domainId,
      reservationId: randomUUID(),
    };
  await expect(f.adapter.query({ ...query, domainId: randomUUID() })).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(f.sdk).not.toHaveBeenCalled();
  const network = f.gateway.getNetwork(config.channel),
    contract = network.getContract(config.chaincode);
  f.sdk.mockReturnValue(network);
  spyOn(network, "getContract").mockReturnValue(contract);
  const original = contract.newProposal.bind(contract);
  let output: unknown = { hash: "a".repeat(64) };
  let failure: Error | undefined;
  spyOn(contract, "newProposal").mockImplementation((name, options) => {
    expect(name).toBe("GetExecutionGateHash");
    expect(options).toEqual({ arguments: [query.domainId, query.reservationId] });
    const proposal = original(name, options);
    spyOn(proposal, "evaluate").mockImplementation(async () => {
      if (failure) throw failure;
      return Buffer.from(JSON.stringify(output));
    });
    return proposal;
  });
  expect(await f.adapter.query(query)).toEqual({ hash: "a".repeat(64) });
  for (const value of [{ hash: null }, { hash: "a".repeat(64), amount: "100" }, "x".repeat(1025)]) {
    output = value;
    await expect(f.adapter.query(query)).rejects.toThrow("INVALID_LEDGER_RESPONSE");
  }
  const unavailable = (messages: string[]) =>
    new GatewayError({
      code: 2,
      cause: Object.assign(new Error("private peer detail"), {
        code: 2,
        details: "private",
        metadata: new Metadata(),
      }),
      details: messages.map((message) => ({ address: "private-peer", mspId: "AMSP", message })),
    });
  failure = unavailable(["chaincode response 500, ASSET_UNAVAILABLE"]);
  expect(await f.adapter.query(query)).toEqual({ hash: null });
  for (const error of [
    new Error("offline"),
    unavailable([]),
    unavailable(["chaincode response 500, ASSET_UNAVAILABLE", "peer unavailable"]),
  ]) {
    failure = error;
    await expect(f.adapter.query(query)).rejects.toBe(error);
  }
});

test("terminal adapter confines dual signatures to PDC members and binds recovery to terminal identity", async () => {
  const f = setup(),
    values = await executionFixture(),
    source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing signers");
  const terminal = CommercialTerminalSchema.parse({
    protocolVersion: 1,
    kind: "commercial-terminal",
    terminalId: randomUUID(),
    domainId: input.domainId,
    reservationId: values.reservation.reservationId,
    reservationDigest: values.reserve.digest,
    activationId: randomUUID(),
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    expectedGateVersion: 1,
    outcome: "completed",
    executionEvidenceDigest: `sha256:${"b".repeat(64)}`,
    resultManifestDigest: null,
    observedAt: new Date().toISOString(),
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const request = {
    operation: "record-execution-terminal" as const,
    recordId: terminal.terminalId,
    domainId: input.domainId,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(terminal)).digest("hex")}`,
    envelope: {
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      sourceJws: await signFederationMessage(CommercialTerminalSchema, terminal, source),
      targetJws: await signFederationMessage(CommercialTerminalSchema, terminal, target),
    },
  };
  const checkpoint = await f.adapter.prepare(request),
    stored = decode(f, checkpoint.recovery);
  expect(stored).toMatchObject({ batchId: request.recordId, digest: request.digest });
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
    JSON.stringify(request.envelope),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((v) => Buffer.from(v).toString()),
  ).toEqual(["RecordExecutionTerminal", request.domainId, request.recordId]);
  await expect(f.adapter.prepare({ ...request, recordId: randomUUID() })).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(
    f.adapter.prepare({
      ...request,
      envelope: { ...request.envelope, targetJws: request.envelope.sourceJws },
    }),
  ).rejects.toThrow();
  const trust = structuredClone(config.trust);
  for (const purpose of trust.keyPurposes)
    purpose.kinds = purpose.kinds.filter((k) => k !== "commercial-terminal");
  await expect(setup({ trust }).adapter.prepare(request)).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("commercial receipt query is member scoped, binds identity and rejects private or oversized responses", async () => {
  const f = setup();
  const query = {
    operation: "get-commercial-receipt" as const,
    domainId: input.domainId,
    recordType: "agreement" as const,
    recordId: input.recordId,
  };
  await expect(f.adapter.receipt({ ...query, domainId: randomUUID() })).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(f.sdk).not.toHaveBeenCalled();
  const network = f.gateway.getNetwork(config.channel),
    contract = network.getContract(config.chaincode);
  f.sdk.mockReturnValue(network);
  spyOn(network, "getContract").mockReturnValue(contract);
  const original = contract.newProposal.bind(contract);
  let failure: Error | undefined;
  let output: unknown = { receipt: { recordId: input.recordId, digest: input.digest } };
  spyOn(contract, "newProposal").mockImplementation((name, options) => {
    expect(name).toBe("GetRecordReceipt");
    expect(options).toEqual({ arguments: [input.domainId, "agreement", input.recordId] });
    const proposal = original(name, options);
    spyOn(proposal, "evaluate").mockImplementation(async () => {
      if (failure) throw failure;
      return Buffer.from(JSON.stringify(output));
    });
    return proposal;
  });
  expect(await f.adapter.receipt(query)).toEqual({
    receipt: { recordId: input.recordId, digest: input.digest },
  });
  for (const value of [
    { receipt: { recordId: randomUUID(), digest: input.digest } },
    { receipt: { recordId: input.recordId, digest: input.digest, price: "123" } },
    { receipt: null, secret: "private" },
    "x".repeat(1025),
  ]) {
    output = value;
    await expect(f.adapter.receipt(query)).rejects.toThrow("INVALID_LEDGER_RESPONSE");
  }
  output = { receipt: null };
  expect(await f.adapter.receipt(query)).toEqual({ receipt: null });
  failure = new GatewayError({
    code: 2,
    cause: Object.assign(new Error("private peer detail"), {
      code: 2,
      details: "private",
      metadata: new Metadata(),
    }),
    details: [
      { address: "private-peer", mspId: "AMSP", message: "chaincode response 500, DATA_WAITING" },
    ],
  });
  await expect(f.adapter.receipt(query)).rejects.toThrow("DATA_WAITING");
  failure = new Error("offline");
  await expect(f.adapter.receipt(query)).rejects.toBe(failure);
});

async function billingInputs() {
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing business keys");
  const execution = await executionFixture();
  const digest = `sha256:${"a".repeat(64)}`;
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: input.domainId,
    agreementDigest: digest,
    priceVersionId: randomUUID(),
    reportId: randomUUID(),
    reportDigest: digest,
    request: execution.reservation.request,
    reservationId: execution.reservation.reservationId,
    discount: null,
    calculation: {
      rounding: "ceil-per-line",
      lines: [
        {
          metric: "cpu",
          quantityUnit: "core-second",
          quantity: "1",
          perQuantity: "1",
          rateAmount: "10",
          amount: "10",
        },
      ],
      grossAmount: "10",
      capReduction: "0",
      discountAmount: "0",
      dueAmount: "10",
    },
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: bill.billId,
    domainId: input.domainId,
    agreementRevisionId: bill.request.agreementRevisionId,
    agreementDigest: digest,
    reportId: bill.reportId,
    reportDigest: bill.reportDigest,
    taskId: bill.request.taskId,
    attempt: 1,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    unit: bill.request.unit,
    amount: "1",
    reason: "PRIVATE-CONCESSION-FIXTURE",
    issuedAt: bill.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const sourceJws = await signFederationMessage(CommercialBillSchema, bill, source);
  const providerJws = await signFederationMessage(CommercialDiscountSchema, discount, target);
  const hash = (jws: string) => {
    const body = jws.split(".")[1];
    if (!body) throw new Error("Missing signed body");
    return `sha256:${createHash("sha256").update(Buffer.from(body, "base64url")).digest("hex")}`;
  };
  const settlement = CommercialSettlementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-settlement",
    settlementId: randomUUID(),
    domainId: bill.domainId,
    agreementRevisionId: bill.request.agreementRevisionId,
    billId: bill.billId,
    billDigest: hash(sourceJws),
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    reservationId: bill.reservationId,
    terminal: { terminalId: randomUUID(), digest },
    unit: bill.request.unit,
    reservedAmount: bill.request.maxAmount,
    chargedAmount: bill.calculation.dueAmount,
    releasedAmount: (
      BigInt(bill.request.maxAmount) - BigInt(bill.calculation.dueAmount)
    ).toString(),
    issuedAt: bill.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const settlementJws = await signFederationMessage(CommercialSettlementSchema, settlement, source);
  const adjustment = CommercialAdjustmentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-adjustment",
    adjustmentId: randomUUID(),
    domainId: settlement.domainId,
    agreementRevisionId: settlement.agreementRevisionId,
    billId: bill.billId,
    billDigest: settlement.billDigest,
    settlementId: settlement.settlementId,
    settlementDigest: hash(settlementJws),
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    unit: settlement.unit,
    previous: null,
    previousChargedAmount: settlement.chargedAmount,
    chargedAmount: "0",
    reason: "PRIVATE-ADJUSTMENT-PROBE",
    supportingEvidenceDigest: null,
    issuedAt: settlement.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const adjustmentJws = await signFederationMessage(CommercialAdjustmentSchema, adjustment, source);

  const payment = CommercialPaymentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-payment",
    receiptId: randomUUID(),
    paymentId: randomUUID(),
    domainId: bill.domainId,
    agreementRevisionId: bill.request.agreementRevisionId,
    agreementDigest: bill.agreementDigest,
    billId: bill.billId,
    billDigest: hash(sourceJws),
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    unit: bill.request.unit,
    amount: "5",
    occurredAt: bill.issuedAt,
    issuedAt: bill.issuedAt,
    evidenceDigest: digest,
    previous: null,
    reason: "PRIVATE-PAYMENT-PROBE",
    salt: randomBytes(32).toString("hex"),
  });
  const paymentJws = await signFederationMessage(CommercialPaymentSchema, payment, source);

  return [
    CommercialAdapterProposalInputSchema.parse({
      operation: "record-payment",
      domainId: payment.domainId,
      recordId: payment.receiptId,
      digest: hash(paymentJws),
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws: paymentJws,
        targetJws: await signFederationMessage(CommercialPaymentSchema, payment, target),
      },
    }),
    CommercialAdapterProposalInputSchema.parse({
      operation: "adjust-settlement",
      domainId: adjustment.domainId,
      recordId: adjustment.adjustmentId,
      digest: hash(adjustmentJws),
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws: adjustmentJws,
        targetJws: await signFederationMessage(CommercialAdjustmentSchema, adjustment, target),
      },
    }),
    CommercialAdapterProposalInputSchema.parse({
      operation: "settle-bill",
      domainId: settlement.domainId,
      recordId: settlement.settlementId,
      digest: hash(settlementJws),
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws: settlementJws,
        targetJws: await signFederationMessage(CommercialSettlementSchema, settlement, target),
      },
    }),
    CommercialAdapterProposalInputSchema.parse({
      operation: "confirm-bill",
      domainId: bill.domainId,
      recordId: bill.billId,
      digest: hash(sourceJws),
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws,
        targetJws: await signFederationMessage(CommercialBillSchema, bill, target),
      },
    }),
    CommercialAdapterProposalInputSchema.parse({
      operation: "record-discount",
      domainId: discount.domainId,
      recordId: discount.discountId,
      digest: hash(providerJws),
      envelope: { providerJws },
    }),
  ];
}

test("bill, discount, settlement, adjustment and payment proposals disclose only to the two PDC institutions, never normal arguments", async () => {
  for (const value of await billingInputs()) {
    const provider = keys[1];
    if (!provider) throw new Error("Missing provider");
    const f = setup(value.operation === "record-discount" ? { siteId: provider.siteId } : {});
    const prepared = await f.adapter.prepare(value);
    const stored = decode(f, prepared.recovery);
    const proposed = proto.ProposedTransaction.deserializeBinary(
      Buffer.from(stored.message.bytes, "base64"),
    );
    expect(proposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
    const signed = proposed.getProposal();
    if (!signed) throw new Error("Missing SDK proposal");
    const payload = peer.ChaincodeProposalPayload.deserializeBinary(
      peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
    );
    expect(Buffer.from(payload.getTransientmapMap().get("commercial") ?? []).toString()).toBe(
      JSON.stringify(value.envelope),
    );
    const args = peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((bytes) => Buffer.from(bytes).toString());
    expect(args).toEqual([
      value.operation === "record-payment"
        ? "RecordPayment"
        : value.operation === "confirm-bill"
          ? "ConfirmBill"
          : value.operation === "settle-bill"
            ? "SettleBill"
            : value.operation === "adjust-settlement"
              ? "AdjustSettlement"
              : "RecordDiscount",
      value.domainId,
      value.recordId,
    ]);
  }
});

test("new billing operations reject mismatched identities, old key authority and public-field injection before SDK access", async () => {
  const provider = keys[1];
  if (!provider) throw new Error("Missing provider");
  for (const value of await billingInputs()) {
    const f = setup(value.operation === "record-discount" ? { siteId: provider.siteId } : {});
    await expect(f.adapter.prepare({ ...value, recordId: randomUUID() })).rejects.toThrow(
      "POLICY_DENIED",
    );
    await expect(
      f.adapter.prepare({ ...value, digest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toThrow("POLICY_DENIED");
    expect(
      CommercialAdapterProposalInputSchema.safeParse({ ...value, dueAmount: "10" }).success,
    ).toBe(false);
    if (
      value.operation === "record-payment" ||
      value.operation === "confirm-bill" ||
      value.operation === "settle-bill" ||
      value.operation === "adjust-settlement"
    )
      await expect(
        f.adapter.prepare({
          ...value,
          envelope: { ...value.envelope, targetJws: value.envelope.sourceJws },
        }),
      ).rejects.toThrow();
    else if (value.operation === "record-discount")
      await expect(setup().adapter.prepare(value)).rejects.toThrow();
    expect(f.sdk).not.toHaveBeenCalled();
    const trust = structuredClone(config.trust);
    for (const purpose of trust.keyPurposes)
      purpose.kinds = ["commercial-agreement", "commercial-usage"];
    const denied = setup({
      trust,
      ...(value.operation === "record-discount" ? { siteId: provider.siteId } : {}),
    });
    await expect(denied.adapter.prepare(value)).rejects.toThrow("UNTRUSTED_IDENTITY");
    expect(denied.sdk).not.toHaveBeenCalled();
  }
});

async function refundInput() {
  const execution = await executionFixture(),
    source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing signers");
  const request = { ...execution.reservation.request, mode: "bilateral_attested" as const };
  const receipt = FederationCancellationReceiptSchema.parse({
    protocolVersion: 1,
    kind: "cancellation-receipt",
    operationId: request.operationId,
    senderSiteId: target.siteId,
    recipientSiteId: source.siteId,
    agreementRevisionId: request.agreementRevisionId,
    taskId: request.taskId,
    attempt: request.attempt,
    requestDigest: `sha256:${"1".repeat(64)}`,
    cancellationDigest: `sha256:${"2".repeat(64)}`,
    recordedAt: request.issuedAt,
    observedAt: request.issuedAt,
    reservationId: null,
    state: "stopped",
    workflow: null,
  });
  const value = CommercialRefundSchema.parse({
    protocolVersion: 1,
    kind: "commercial-refund",
    refundId: randomUUID(),
    domainId: input.domainId,
    agreementDigest: `sha256:${"3".repeat(64)}`,
    request,
    requestDigest: receipt.requestDigest,
    cancellationReceiptJws: await signFederationMessage(
      FederationCancellationReceiptSchema,
      receipt,
      target,
    ),
    releasedAmount: request.maxAmount,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "PRIVATE-REFUND",
  });
  const sourceJws = await signFederationMessage(CommercialRefundSchema, value, source);
  const body = sourceJws.split(".")[1];
  if (!body) throw new Error("Missing body");
  const proposal = {
    operation: "record-refund" as const,
    domainId: value.domainId,
    recordId: value.refundId,
    digest: `sha256:${createHash("sha256").update(Buffer.from(body, "base64url")).digest("hex")}`,
    envelope: {
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      sourceJws,
      targetJws: await signFederationMessage(CommercialRefundSchema, value, target),
    },
  };
  return { proposal, value, source, target, receipt };
}

test("refund adapter keeps nested cancellation and both signatures in transient data with member endorsement", async () => {
  const { proposal } = await refundInput(),
    f = setup();
  const prepared = await f.adapter.prepare(proposal),
    stored = decode(f, prepared.recovery);
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  expect(proposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing signed proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(payload.getTransientmapMap().get("commercial") ?? []).toString()).toBe(
    JSON.stringify(proposal.envelope),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((bytes) => Buffer.from(bytes).toString()),
  ).toEqual(["RecordRefund", proposal.domainId, proposal.recordId]);
  expect(stored.digest).toBe(proposal.digest);
});

test("refund adapter rejects changed record identity and absent receipt purpose before proposal disclosure", async () => {
  const { proposal } = await refundInput();
  await expect(setup().adapter.prepare({ ...proposal, recordId: randomUUID() })).rejects.toThrow(
    "POLICY_DENIED",
  );
  const trust = structuredClone(config.trust);
  for (const item of trust.keyPurposes)
    item.kinds = item.kinds.filter((kind) => kind !== "cancellation-receipt");
  await expect(setup({ trust }).adapter.prepare(proposal)).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("dispute attestation adapter binds all three signatures and uses only transient private transport", async () => {
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing signers");
  const opening = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId: config.trust.domains[0]?.domainId,
    agreementRevisionId: randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    openingSiteId: target.siteId,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
    subject: {
      recordType: "usage",
      recordId: randomUUID(),
      recordDigest: `sha256:${"b".repeat(64)}`,
    },
    reason: "PRIVATE-CASE",
    requestedResolution: "Review",
  });
  const hash = (jws: string) =>
    `sha256:${createHash("sha256")
      .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`;
  const openingJws = await signFederationMessage(CommercialDisputeSchema, opening, target);
  const freeze = CommercialDisputeFreezeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute-freeze",
    caseId: opening.caseId,
    caseDigest: hash(openingJws),
    agreementRevisionId: opening.agreementRevisionId,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    taskId: opening.taskId,
    attempt: 1,
    mode: "bilateral_attested",
    headDigest: `sha256:${"c".repeat(64)}`,
    issuedAt: opening.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const input = async (value = freeze) => {
    const sourceJws = await signFederationMessage(CommercialDisputeFreezeSchema, value, source);
    return CommercialAdapterProposalInputSchema.parse({
      operation: "record-dispute-freeze",
      domainId: opening.domainId,
      recordId: opening.caseId,
      digest: hash(sourceJws),
      envelope: {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceJws,
        targetJws: await signFederationMessage(CommercialDisputeFreezeSchema, value, target),
        openingSiteId: target.siteId,
        openingJws,
      },
    });
  };
  const value = await input();
  if (value.operation !== "record-dispute-freeze") throw new Error("Missing dispute input");
  const f = setup(),
    prepared = await f.adapter.prepare(value),
    stored = decode(f, prepared.recovery);
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
    JSON.stringify(value.envelope),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((b) => Buffer.from(b).toString()),
  ).toEqual(["RecordDisputeFreeze", value.domainId, value.recordId]);
  const denied = setup();
  for (const patch of [
    { taskId: randomUUID() },
    { mode: "ledger_coordinated" as const },
    { caseDigest: `sha256:${"d".repeat(64)}` },
  ])
    await expect(denied.adapter.prepare(await input({ ...freeze, ...patch }))).rejects.toThrow(
      "POLICY_DENIED",
    );
  await expect(
    denied.adapter.prepare({
      ...value,
      envelope: { ...value.envelope, openingSiteId: source.siteId },
    }),
  ).rejects.toThrow();
  const trust = structuredClone(config.trust);
  for (const key of trust.keyPurposes)
    key.kinds = key.kinds.filter((k) => k !== "commercial-dispute-freeze");
  await expect(setup({ trust }).adapter.prepare(value)).rejects.toThrow();
  expect(denied.sdk).not.toHaveBeenCalled();
  const nativeInput = CommercialAdapterProposalInputSchema.parse({
    ...(await input({ ...freeze, mode: "ledger_coordinated" })),
    operation: "freeze-disputed-task",
  });
  const native = setup(),
    nativePrepared = await native.adapter.prepare(nativeInput),
    nativeStored = decode(native, nativePrepared.recovery);
  const nativeProposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(nativeStored.message.bytes, "base64"),
  );
  const nativeSigned = nativeProposed.getProposal();
  if (!nativeSigned) throw new Error("Missing native proposal");
  const nativePayload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(nativeSigned.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(nativePayload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((b) => Buffer.from(b).toString()),
  ).toEqual(["FreezeDisputedTask", value.domainId, value.recordId]);
  expect(nativeProposed.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
  await expect(
    setup().adapter.prepare({ ...value, operation: "freeze-disputed-task" }),
  ).rejects.toThrow("POLICY_DENIED");
});
