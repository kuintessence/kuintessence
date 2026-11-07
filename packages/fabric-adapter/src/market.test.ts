import { afterEach, expect, spyOn, test } from "bun:test";
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
import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  MarketDemandSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionStopSchema,
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { FabricMarketAdapter, MarketAdapterConfigSchema } from "./market";

const close: (() => void)[] = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
});

test("stop transport binds issuer, original activation and immutable recovery without private fields", async () => {
  const f = fixture();
  const stop = MarketExecutionStopSchema.parse({
    demandId: f.demand.demandId,
    stopId: randomUUID(),
    issuerSiteId: f.config.siteId,
    activationId: randomUUID(),
    expectedVersion: 3,
  });
  const prepared = await f.adapter.prepare({ operation: "request-execution-stop", stop });
  const stored = decode(f, prepared.recovery);
  expect(stored.batchId).toBe(stop.stopId);
  expect(stored.digest).toBe(
    `sha256:${createHash("sha256").update(federationCanonicalJson(stop)).digest("hex")}`,
  );
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(payload.getTransientmapMap().get("market") ?? []).toString()).toBe(
    federationCanonicalJson(stop),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((value) => Buffer.from(value).toString()),
  ).toEqual(["RequestExecutionStop", stop.demandId]);
  const sdk = spyOn(f.gateway, "getNetwork");
  await expect(
    f.adapter.prepare({
      operation: "request-execution-stop",
      stop: { ...stop, issuerSiteId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  const privateInput = {
    operation: "request-execution-stop" as const,
    stop: { ...stop, contract: "private" },
  };
  await expect(f.adapter.prepare(privateInput)).rejects.toThrow();
  expect(sdk).not.toHaveBeenCalled();
});

test("execution confirmation transport fixes issuer, bounded lifetime and exact public recovery payload", async () => {
  const f = fixture();
  const authorization = MarketExecutionAuthorizationSchema.parse({
    demandId: f.demand.demandId,
    authorizationId: randomUUID(),
    issuerSiteId: f.config.siteId,
    activationId: randomUUID(),
    issuedAt: f.demand.createdAt,
    expiresAt: new Date(Date.parse(f.demand.createdAt) + 300000).toISOString(),
    gate: {
      domainId: randomUUID(),
      reservationId: randomUUID(),
      demandId: f.demand.demandId,
      claimVersion: 2,
      version: 1,
      state: "READY",
      reservationDigest: `sha256:${"b".repeat(64)}`,
      expiresAt: f.demand.expiresAt,
    },
  });
  const checkpoint = await f.adapter.prepare({ operation: "authorize-execution", authorization });
  const stored = decode(f, checkpoint.recovery);
  expect(stored.batchId).toBe(authorization.authorizationId);
  expect(stored.digest).toBe(
    `sha256:${createHash("sha256").update(federationCanonicalJson(authorization)).digest("hex")}`,
  );
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(payload.getTransientmapMap().get("market") ?? []).toString()).toBe(
    federationCanonicalJson(authorization),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((value) => Buffer.from(value).toString()),
  ).toEqual(["AuthorizeExecution", f.demand.demandId]);
  const sdk = spyOn(f.gateway, "getNetwork");
  await expect(
    f.adapter.prepare({
      operation: "authorize-execution",
      authorization: { ...authorization, issuerSiteId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.adapter.prepare({
      operation: "authorize-execution",
      authorization: { ...authorization, expiresAt: f.demand.expiresAt },
    }),
  ).rejects.toThrow();
  const privateInput = {
    operation: "authorize-execution" as const,
    authorization: { ...authorization, amount: "private" },
  };
  await expect(f.adapter.prepare(privateInput)).rejects.toThrow();
  expect(sdk).not.toHaveBeenCalled();
});
function fixture() {
  const siteId = randomUUID();
  const config = MarketAdapterConfigSchema.parse({
    siteId,
    channel: "cooperation",
    chaincode: "kq-market",
    trust: {
      version: 1,
      generationId: randomUUID(),
      organizations: [
        { siteId, mspId: "AMSP" },
        { siteId: randomUUID(), mspId: "BMSP" },
      ],
    },
  });
  const client = new Client("127.0.0.1:1", credentials.createInsecure());
  const identity = { mspId: "AMSP", credentials: Buffer.from("isolated-market-sdk") };
  const signer = signers.newPrivateKeySigner(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  );
  const gateway = connect({ client, identity, signer });
  close.push(() => {
    gateway.close();
    client.close();
  });
  const key = randomBytes(32),
    adapter = new FabricMarketAdapter(config, gateway, identity, signer, key);
  const demand = MarketDemandSchema.parse({
    protocolVersion: 1,
    demandId: randomUUID(),
    sourceSiteId: siteId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    title: "Explicit public task",
    description: "Public summary",
    platform: "linux",
    architecture: "x86_64",
    resources: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
  });
  return { config, client, identity, signer, gateway, key, adapter, demand };
}
function decode(f: ReturnType<typeof fixture>, token: string) {
  const bytes = Buffer.from(token, "base64"),
    cipher = createDecipheriv("aes-256-gcm", f.key, bytes.subarray(0, 12));
  cipher.setAAD(
    createHash("sha256")
      .update(JSON.stringify({ purpose: "kq-market-v1", config: f.config }))
      .update(f.identity.credentials)
      .digest(),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return z
    .object({
      batchId: z.string(),
      domainId: z.string(),
      digest: z.string(),
      message: z.object({ bytes: z.string() }),
    })
    .parse(
      JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()),
    );
}
test("market checkpoint binds exact canonical payload and leaves native endorsement discovery to Gateway", async () => {
  const f = fixture();
  const variants: MarketProposalInput[] = [
    { operation: "publish-demand", demand: f.demand },
    {
      operation: "claim-demand",
      claim: {
        demandId: f.demand.demandId,
        claimId: randomUUID(),
        providerSiteId: f.config.siteId,
        expectedVersion: 1,
        expiresAt: f.demand.expiresAt,
      },
    },
    {
      operation: "cancel-open-demand",
      cancellation: {
        demandId: f.demand.demandId,
        cancellationId: randomUUID(),
        expectedVersion: 1,
      },
    },
  ];
  for (const input of variants) {
    const prepared = await f.adapter.prepare(input),
      stored = decode(f, prepared.recovery);
    const [name, value, id] =
      input.operation === "publish-demand"
        ? ["PublishDemand", input.demand, input.demand.demandId]
        : input.operation === "claim-demand"
          ? ["ClaimDemand", input.claim, input.claim.claimId]
          : ["CancelOpenDemand", input.cancellation, input.cancellation.cancellationId];
    const bytes = federationCanonicalJson(value);
    expect(stored).toMatchObject({
      batchId: id,
      domainId: f.config.trust.generationId,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    const proposed = proto.ProposedTransaction.deserializeBinary(
      Buffer.from(stored.message.bytes, "base64"),
    );
    expect(proposed.getEndorsingOrganizationsList()).toEqual([]);
    const signed = proposed.getProposal();
    if (!signed) throw new Error("Missing SDK proposal");
    const payload = peer.ChaincodeProposalPayload.deserializeBinary(
      peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
    );
    expect(Buffer.from(payload.getTransientmapMap().get("market") ?? []).toString()).toBe(bytes);
    expect(
      peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
        .getChaincodeSpec()
        ?.getInput()
        ?.getArgsList_asU8()
        .map((v) => Buffer.from(v).toString()),
    ).toEqual([name, f.demand.demandId]);
  }
});
test("market caller cannot impersonate another publishing or claiming institution or inject arbitrary calls", async () => {
  const f = fixture(),
    sdk = spyOn(f.gateway, "getNetwork");
  await expect(
    f.adapter.prepare({
      operation: "publish-demand",
      demand: { ...f.demand, sourceSiteId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.adapter.prepare({
      operation: "claim-demand",
      claim: {
        demandId: f.demand.demandId,
        claimId: randomUUID(),
        providerSiteId: randomUUID(),
        expectedVersion: 1,
        expiresAt: f.demand.expiresAt,
      },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  const extra = { operation: "publish-demand" as const, demand: f.demand, chaincode: "other" };
  await expect(f.adapter.prepare(extra)).rejects.toThrow();
  expect(sdk).not.toHaveBeenCalled();
  expect(
    () =>
      new FabricMarketAdapter(
        f.config,
        f.gateway,
        { ...f.identity, mspId: "BMSP" },
        f.signer,
        f.key,
      ),
  ).toThrow("INVALID_ADAPTER_CONFIG");
});
test("market recovery rejects changed governance, channel, identity, key and ciphertext before network access", async () => {
  const f = fixture(),
    prepared = await f.adapter.prepare({ operation: "publish-demand", demand: f.demand });
  for (const other of [
    new FabricMarketAdapter(
      { ...f.config, channel: "other" },
      f.gateway,
      f.identity,
      f.signer,
      f.key,
    ),
    new FabricMarketAdapter(
      { ...f.config, trust: { ...f.config.trust, generationId: randomUUID() } },
      f.gateway,
      f.identity,
      f.signer,
      f.key,
    ),
    new FabricMarketAdapter(
      f.config,
      f.gateway,
      { ...f.identity, credentials: Buffer.from("other") },
      f.signer,
      f.key,
    ),
    new FabricMarketAdapter(f.config, f.gateway, f.identity, f.signer, randomBytes(32)),
  ])
    await expect(other.advance(prepared.recovery)).rejects.toThrow("INVALID_RECOVERY");
  const changed = Buffer.from(prepared.recovery, "base64");
  changed[30] = (changed[30] ?? 0) ^ 1;
  await expect(f.adapter.advance(changed.toString("base64"))).rejects.toThrow("INVALID_RECOVERY");
});

test("market query only evaluates fixed public methods and rejects wrong or oversized ledger results", async () => {
  const f = fixture();
  const network = f.gateway.getNetwork(f.config.channel),
    contract = network.getContract(f.config.chaincode);
  spyOn(f.gateway, "getNetwork").mockReturnValue(network);
  spyOn(network, "getContract").mockReturnValue(contract);
  const state = {
    demand: f.demand,
    digest: `sha256:${createHash("sha256").update(federationCanonicalJson(f.demand)).digest("hex")}`,
    version: 1,
    status: "OPEN" as const,
    claim: null,
    cancellation: null,
    activation: null,
  };
  let response: unknown = state;
  const calls: { name: string; options: unknown }[] = [];
  const original = contract.newProposal.bind(contract);
  spyOn(contract, "newProposal").mockImplementation((name, options) => {
    calls.push({ name, options });
    const proposal = original(name, options);
    spyOn(proposal, "evaluate").mockImplementation(async () =>
      Buffer.from(JSON.stringify(response)),
    );
    return proposal;
  });
  expect(await f.adapter.query({ operation: "get-demand", demandId: f.demand.demandId })).toEqual({
    operation: "get-demand",
    demand: state,
  });
  const page = { demands: [state], bookmark: "opaque\u0000cursor" };
  response = page;
  expect(await f.adapter.query({ operation: "list-demands", limit: 1, bookmark: "" })).toEqual({
    operation: "list-demands",
    ...page,
  });
  expect(calls).toEqual([
    { name: "GetDemand", options: { arguments: [f.demand.demandId] } },
    { name: "ListDemands", options: { arguments: ["1", ""] } },
  ]);
  response = { ...state, digest: `sha256:${"0".repeat(64)}` };
  await expect(
    f.adapter.query({ operation: "get-demand", demandId: f.demand.demandId }),
  ).rejects.toThrow("INVALID_LEDGER_RESPONSE");
  response = state;
  await expect(
    f.adapter.query({ operation: "get-demand", demandId: randomUUID() }),
  ).rejects.toThrow("INVALID_LEDGER_RESPONSE");
  response = { demands: [state, state], bookmark: "" };
  await expect(
    f.adapter.query({ operation: "list-demands", limit: 1, bookmark: "" }),
  ).rejects.toThrow("INVALID_LEDGER_RESPONSE");
  response = "x".repeat(2_097_153);
  await expect(
    f.adapter.query({ operation: "get-demand", demandId: f.demand.demandId }),
  ).rejects.toThrow("INVALID_LEDGER_RESPONSE");
});

test("activation transport preserves the exact public gate and cannot accept private fields", async () => {
  const f = fixture();
  const activation = {
    demandId: f.demand.demandId,
    activationId: randomUUID(),
    expectedVersion: 2,
    gate: {
      domainId: randomUUID(),
      reservationId: randomUUID(),
      demandId: f.demand.demandId,
      claimVersion: 2,
      version: 1,
      state: "READY" as const,
      reservationDigest: `sha256:${"b".repeat(64)}`,
      expiresAt: f.demand.expiresAt,
    },
  };
  const checkpoint = await f.adapter.prepare({ operation: "activate-demand", activation });
  const stored = decode(f, checkpoint.recovery);
  expect(stored.batchId).toBe(activation.activationId);
  expect(stored.digest).toBe(
    `sha256:${createHash("sha256").update(federationCanonicalJson(activation)).digest("hex")}`,
  );
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  expect(proposed.getEndorsingOrganizationsList()).toEqual([]);
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(Buffer.from(payload.getTransientmapMap().get("market") ?? []).toString()).toBe(
    federationCanonicalJson(activation),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((value) => Buffer.from(value).toString()),
  ).toEqual(["ActivateDemand", f.demand.demandId]);
  const privateInput = {
    operation: "activate-demand" as const,
    activation: { ...activation, gate: { ...activation.gate, amount: "1" } },
  };
  await expect(f.adapter.prepare(privateInput)).rejects.toThrow();
});

test("closure adapter carries only the public terminal commitment and rejects private evidence", async () => {
  const f = fixture(),
    terminalId = randomUUID();
  const closure = {
    demandId: f.demand.demandId,
    closureId: terminalId,
    expectedVersion: 3,
    gate: {
      domainId: randomUUID(),
      reservationId: randomUUID(),
      demandId: f.demand.demandId,
      claimVersion: 2,
      version: 2,
      state: "TERMINAL" as const,
      reservationDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: f.demand.expiresAt,
      terminal: { terminalId, activationId: randomUUID(), digest: `sha256:${"b".repeat(64)}` },
    },
  };
  const checkpoint = await f.adapter.prepare({ operation: "close-demand", closure });
  const stored = decode(f, checkpoint.recovery);
  expect(stored.batchId).toBe(terminalId);
  expect(stored.digest).toBe(
    `sha256:${createHash("sha256").update(federationCanonicalJson(closure)).digest("hex")}`,
  );
  const proposed = proto.ProposedTransaction.deserializeBinary(
    Buffer.from(stored.message.bytes, "base64"),
  );
  expect(proposed.getEndorsingOrganizationsList()).toEqual([]);
  const signed = proposed.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(
    peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
  );
  expect(
    peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((v) => Buffer.from(v).toString()),
  ).toEqual(["CloseDemand", f.demand.demandId]);
  const privateInput = {
    operation: "close-demand" as const,
    closure: { ...closure, gate: { ...closure.gate, outcome: "completed" } },
  };
  await expect(f.adapter.prepare(privateInput)).rejects.toThrow();
});
