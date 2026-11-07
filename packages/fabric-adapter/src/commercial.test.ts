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
import {
  CommercialAgreementSchema,
  type CommercialExecutionProposalInput,
  CommercialExecutionProposalInputSchema,
  type CommercialProposalInput,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
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
        kinds: [
          "commercial-agreement",
          "commercial-usage",
          "commercial-reservation",
          "commercial-release",
          "commercial-terminal",
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
