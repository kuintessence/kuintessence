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
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { FabricMarketAdapter, MarketAdapterConfigSchema } from "./market";

const close: (() => void)[] = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
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
