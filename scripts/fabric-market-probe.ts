import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, EndorseError, signers } from "@hyperledger/fabric-gateway";
import { peer } from "@hyperledger/fabric-protos";
import {
  FabricMarketTrustSchema,
  MarketDemandSchema,
  MarketDemandStateSchema,
  MarketReceiptSchema,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { Site } from "./fabric-evidence-fixture";

const network = z
  .object({
    channel: z.literal("kq-evidence-test"),
    chaincode: z.literal("kq-market"),
    trust: FabricMarketTrustSchema,
    sites: z.array(Site).length(3),
  })
  .parse(JSON.parse(await readFile(z.string().parse(process.argv[2]), "utf8")));
const connections: { gateway: ReturnType<typeof connect>; client: Client }[] = [];
const passed: string[] = [];
const site = (name: string) => Site.parse(network.sites.find((site) => site.name === name));
async function connection(name: string, endpointName = name, admin = false) {
  const member = site(name),
    endpoint = site(endpointName),
    mspDir = admin ? member.adminMsp : member.userMsp;
  const keyNames = await readdir(join(mspDir, "keystore"));
  assert(keyNames.length === 1 && keyNames[0]);
  const identity = {
    mspId: `${name}MSP`,
    credentials: await readFile(
      join(
        mspDir,
        "signcerts",
        `${admin ? "Admin" : "User1"}@${name.toLowerCase()}.kq.test-cert.pem`,
      ),
    ),
  };
  const tls = await readFile(join(member.tls, "server.crt"));
  const client = new Client(
    `127.0.0.1:${endpoint.peerPort}`,
    credentials.createSsl(
      await readFile(join(endpoint.tls, "ca.crt")),
      await readFile(join(member.tls, "server.key")),
      tls,
    ),
    { "grpc.ssl_target_name_override": "localhost" },
  );
  const gateway = connect({
    client,
    identity,
    signer: signers.newPrivateKeySigner(
      createPrivateKey(await readFile(join(mspDir, "keystore", keyNames[0]))),
    ),
    tlsClientCertificateHash: createHash("sha256").update(new X509Certificate(tls).raw).digest(),
    endorseOptions: () => ({ deadline: Date.now() + 10000 }),
    submitOptions: () => ({ deadline: Date.now() + 10000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 15000 }),
  });
  connections.push({ gateway, client });
  return gateway;
}

function rejected(code: string) {
  return (error: unknown) =>
    error instanceof EndorseError &&
    error.details.some((detail) => detail.message === `chaincode response 500, ${code}`);
}
async function run() {
  const [a, b, c] = await Promise.all([connection("A"), connection("B"), connection("C")]);
  const contract = (gateway: ReturnType<typeof connect>) =>
    gateway.getNetwork(network.channel).getContract(network.chaincode);
  const demand = MarketDemandSchema.parse({
    protocolVersion: 1,
    demandId: randomUUID(),
    sourceSiteId: site("A").siteId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    title: "Public integration task",
    description: "Approved public summary",
    platform: "linux",
    architecture: "x86_64",
    resources: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
  });
  const propose = (
    gateway: ReturnType<typeof connect>,
    name: string,
    value: unknown,
    msps = ["AMSP", "BMSP"],
  ) =>
    contract(gateway).newProposal(name, {
      arguments: [demand.demandId],
      transientData: { market: JSON.stringify(value) },
      endorsingOrganizations: msps,
    });
  const current = async (msp = "AMSP") =>
    MarketDemandStateSchema.parse(
      JSON.parse(
        Buffer.from(
          (
            await contract(a)
              .newProposal("GetDemand", {
                arguments: [demand.demandId],
                endorsingOrganizations: [msp],
              })
              .endorse()
          ).getResult(),
        ).toString(),
      ),
    );
  const commit = async (
    transaction: Awaited<ReturnType<ReturnType<typeof propose>["endorse"]>>,
  ) => {
    const result = await transaction.submit();
    return result.getStatus();
  };
  const readyDeadline = Date.now() + 45000;
  for (;;) {
    let ready = true;
    for (const msp of ["AMSP", "BMSP", "CMSP"]) {
      try {
        await current(msp);
        throw new Error("Unexpected demand");
      } catch (error) {
        if (!rejected("ASSET_UNAVAILABLE")(error)) ready = false;
      }
    }
    if (ready) break;
    assert(Date.now() < readyDeadline, "Market peers ready");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const waitStatus = async (status: string) => {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const states = await Promise.all(["AMSP", "BMSP", "CMSP"].map(current));
        if (states.every((value) => value.status === status)) return;
      } catch (error) {
        if (!rejected("ASSET_UNAVAILABLE")(error)) throw error;
      }
      assert(Date.now() < deadline, "Committed market state must reach every peer");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  // One organization cannot validate a public task write under MAJORITY Endorsement.
  const insufficient = await commit(await propose(a, "PublishDemand", demand, ["AMSP"]).endorse());
  assert.equal(insufficient.successful, false);
  assert.equal(insufficient.code, peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE);
  passed.push("one-organization publication is INVALID under native majority endorsement");
  const publication = await propose(a, "PublishDemand", demand).endorse();
  const receipt = MarketReceiptSchema.parse(
    JSON.parse(Buffer.from(publication.getResult()).toString()),
  );
  assert.equal((await commit(publication)).successful, true);
  await waitStatus("OPEN");
  passed.push("two-organization publication is VALID");
  const claim = (name: string) => ({
    demandId: demand.demandId,
    claimId: randomUUID(),
    providerSiteId: site(name).siteId,
    expectedVersion: 1,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
  const bClaim = claim("B"),
    cClaim = claim("C");
  const [bProposal, cProposal] = await Promise.all([
    propose(b, "ClaimDemand", bClaim).endorse(),
    propose(c, "ClaimDemand", cClaim, ["AMSP", "CMSP"]).endorse(),
  ]);
  assert.equal((await commit(bProposal)).successful, true);
  const loser = await commit(cProposal);
  assert.equal(loser.successful, false);
  assert.equal(loser.code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await waitStatus("CLAIMED");
  assert.equal((await current()).claim?.providerSiteId, site("B").siteId);
  passed.push("concurrent B/C claims produce one VALID claimant and one MVCC_READ_CONFLICT");
  const before = await current();
  const replay = await propose(b, "ClaimDemand", bClaim).endorse();
  assert.equal((await commit(replay)).successful, true);
  const publishReplay = await propose(a, "PublishDemand", demand).endorse();
  assert.deepEqual(
    MarketReceiptSchema.parse(JSON.parse(Buffer.from(publishReplay.getResult()).toString())),
    receipt,
  );
  assert.equal((await commit(publishReplay)).successful, true);
  assert.deepEqual(await current(), before);
  passed.push("claim and publication retries retain the original immutable claim");
  await assert.rejects(propose(c, "ClaimDemand", cClaim).endorse(), rejected("OPERATION_CONFLICT"));
  await assert.rejects(
    propose(a, "CancelOpenDemand", {
      demandId: demand.demandId,
      cancellationId: randomUUID(),
      expectedVersion: 2,
    }).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  await assert.rejects(propose(a, "Activate", bClaim).endorse(), rejected("INVALID_MESSAGE"));
  passed.push(
    "claimed demand cannot be overwritten, cancelled as open, or activated without a gate",
  );
  await writeFile(
    z.string().parse(process.argv[3]),
    JSON.stringify(
      {
        passed,
        state: await current(),
        invalidCodes: { insufficient: insufficient.code, concurrent: loser.code },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
try {
  await run();
} catch (error) {
  process.stderr.write(
    `Market probe failed after ${passed.length} checks: ${error instanceof Error ? error.name : "Error"}${error instanceof Error && error.name === "AssertionError" ? ` (${error.message})` : ""}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const { gateway, client } of connections) {
    gateway.close();
    client.close();
  }
}
