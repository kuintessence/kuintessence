import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import {
  connect,
  EndorseError,
  type Proposal,
  signers,
  type Transaction,
} from "@hyperledger/fabric-gateway";
import { common, ledger, msp, peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  CaseDomainSchema,
  type CaseProposal,
  CaseProposalSchema,
  CasePublicationSchema,
  CaseRevocationSchema,
  FabricCaseTrustSchema,
} from "@kuintessence/shared/federation/case-ledger";
import {
  CommercialAgreementSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import { CommercialDisclosurePolicySchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { startCaseAdapter } from "../packages/fabric-adapter/src/case-runtime";
import { Site } from "./fabric-evidence-fixture";

const root = z.string().parse(process.argv[2]);
const action = z.enum(["verify", "prepare", "advance", "crash", "inspect"]).parse(process.argv[3]);
const replyFile = z.string().parse(process.argv[4]);
const CaseSite = Site.extend({ name: z.enum(["A", "B", "R", "D"]) });
const network = z
  .object({
    channel: z.string(),
    chaincode: z.literal("kq-commercial"),
    trust: FabricCommercialTrustSchema,
    sites: CaseSite.array().length(4),
  })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const trust = FabricCaseTrustSchema.parse(
  JSON.parse(await readFile(join(root, "case-trust.json"), "utf8")),
);
const domain = CaseDomainSchema.parse(trust.domains[0]);
const write = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });
const digest = (jws: string) => {
  const payload = jws.split(".")[1];
  assert(payload);
  return `sha256:${createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex")}`;
};

const connections: { gateway: ReturnType<typeof connect>; client: Client }[] = [];
const passed: string[] = [];
const site = (name: string) => CaseSite.parse(network.sites.find((site) => site.name === name));
async function connection(name: string, endpointName = name, commercial = false) {
  const member = site(name),
    endpoint = site(endpointName),
    user = commercial ? "User1" : "User2",
    mspDir = commercial
      ? member.userMsp
      : join(member.userMsp, "..", "..", `${user}@${name.toLowerCase()}.kq.test`, "msp");
  const keyNames = await readdir(join(mspDir, "keystore"));
  assert(keyNames.length === 1 && keyNames[0]);
  const identity = {
    mspId: `${name}MSP`,
    credentials: await readFile(
      join(mspDir, "signcerts", `${user}@${name.toLowerCase()}.kq.test-cert.pem`),
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
async function signing(name: string) {
  const member = site(name);
  return {
    siteId: member.siteId,
    keyId: "batch-1",
    privateKey: await importPKCS8(await readFile(member.businessKeyFile, "utf8"), "RS256"),
  };
}
function chainRejection(code: string) {
  return (error: unknown) =>
    error instanceof EndorseError &&
    error.details.some((detail) => detail.message === `chaincode response 500, ${code}`);
}

const BlockCheck = z.object({
  block: z.string(),
  chaincode: z.enum(["kq-cases", "kq-commercial"]),
  expected: z.array(z.unknown()),
});
const Results = z.object({
  passed: z.string().array(),
  probes: z.string().array(),
  blocks: BlockCheck.array(),
});
const resultFile = join(root, "case-results.json");
let stage = "initialization";
const members = ["AMSP", "BMSP", "RMSP"];
const blocks: z.infer<typeof BlockCheck>[] = [];
async function commit(
  tx: Transaction,
  expected: unknown[],
  chaincode: "kq-cases" | "kq-commercial" = "kq-cases",
  code = 0,
) {
  const status = await (await tx.submit()).getStatus();
  assert.equal(status.code, code);
  assert.equal(status.successful, code === 0);
  blocks.push({ block: String(status.blockNumber), chaincode, expected });
}
function stored(input: CaseProposal) {
  return { receipt: { recordId: input.recordId, digest: input.digest }, input };
}
async function readyEndorse(proposal: Proposal) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      return await proposal.endorse();
    } catch (error) {
      if (
        !(error instanceof EndorseError) ||
        Date.now() >= deadline ||
        (error.code !== 14 &&
          (!error.details.length ||
            !error.details.every((detail) => detail.message.includes("eligible peers"))))
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
async function verify() {
  const a = await connection("A");
  const contract = a.getNetwork(network.channel).getContract("kq-cases");
  async function receipt(recordId: string, recordType = "case-evidence") {
    const bytes = await contract
      .newProposal("GetCaseReceipt", {
        arguments: [domain.domainId, recordType, recordId],
      })
      .evaluate();
    return JSON.parse(Buffer.from(bytes).toString());
  }
  const propose = (input: CaseProposal) =>
    contract.newProposal(
      input.operation === "record-case-evidence" ? "RecordCaseEvidence" : "RevokeCasePublication",
      {
        arguments: [input.domainId, input.recordId],
        transientData: { case: JSON.stringify(input) },
        endorsingOrganizations: members,
      },
    );
  const [sourceKey, targetKey] = await Promise.all([signing("A"), signing("B")]);
  const time = Date.now(),
    contractProbe = `PRIVATE-CONTRACT-${randomUUID()}`,
    priceProbe = "900719925474099317";
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: domain.commercialDomainId,
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date(time).toISOString(),
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: randomUUID(),
      sourceSiteId: sourceKey.siteId,
      targetSiteId: targetKey.siteId,
      mode: "ledger_coordinated",
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      unit: "credit.micro",
      budgetLimit: "99999999999999999999999999999999999999",
      maxTaskAmount: "9999999999999999999999999999999999999",
      maxReservations: 10,
      validFrom: new Date(time - 60000).toISOString(),
      validUntil: new Date(time + 3600000).toISOString(),
      templates: [
        {
          originSiteId: sourceKey.siteId,
          kind: "script",
          id: randomUUID(),
          revision: "v1",
          digest: `sha256:${randomBytes(32).toString("hex")}`,
        },
      ],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 30 },
      termsDigest: `sha256:${randomBytes(32).toString("hex")}`,
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      { metric: "cpu", quantityUnit: "core-second", perQuantity: "3600", amount: priceProbe },
    ],
    termsText: contractProbe,
  });
  const envelope = {
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    sourceJws: await signFederationMessage(CommercialAgreementSchema, terms, sourceKey),
    targetJws: await signFederationMessage(CommercialAgreementSchema, terms, targetKey),
  };

  const commercialGateway = await connection("A", "A", true);
  const commercial = commercialGateway.getNetwork(network.channel).getContract("kq-commercial");
  // Gossip readiness is bounded and retries only the same unsubmitted proposal.
  const initial = commercial.newProposal("RegisterAgreement", {
    arguments: [domain.commercialDomainId, terms.agreement.agreementRevisionId],
    transientData: { commercial: JSON.stringify(envelope) },
    endorsingOrganizations: ["AMSP", "BMSP"],
  });
  stage = "commercial agreement";
  const initialTx = await readyEndorse(initial);
  const commercialReceipt = JSON.parse(Buffer.from(initialTx.getResult()).toString());
  await commit(initialTx, [{ receipt: commercialReceipt, envelope, terms }], "kq-commercial");
  const sign = async <T>(schema: z.ZodType<T>, value: T) => ({
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    sourceJws: await signFederationMessage(schema, value, sourceKey),
    targetJws: await signFederationMessage(schema, value, targetKey),
  });
  const validFrom = new Date(time - 60000).toISOString(),
    validUntil = new Date(time + 3600000).toISOString();
  const policy = CommercialDisclosurePolicySchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure-policy",
    policyId: randomUUID(),
    domainId: domain.commercialDomainId,
    agreementRevisionId: terms.agreement.agreementRevisionId,
    agreementDigest: digest(envelope.sourceJws),
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    recipientSiteId: domain.recipientSiteId,
    disclosures: [{ recordType: "agreement", fields: ["prices"] }],
    issuedAt: validFrom,
    validFrom,
    validUntil,
    salt: randomBytes(32).toString("hex"),
  });
  const policyPair = await sign(CommercialDisclosurePolicySchema, policy);
  const disclosure = CommercialDisclosureSchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure",
    grant: {
      protocolVersion: 1,
      kind: "commercial-disclosure-grant",
      grantId: randomUUID(),
      caseId: randomUUID(),
      policyId: policy.policyId,
      policyDigest: digest(policyPair.sourceJws),
      domainId: policy.domainId,
      agreementRevisionId: policy.agreementRevisionId,
      sourceSiteId: sourceKey.siteId,
      targetSiteId: targetKey.siteId,
      recipientSiteId: domain.recipientSiteId,
      recordType: "agreement",
      recordId: policy.agreementRevisionId,
      recordDigest: policy.agreementDigest,
      fields: ["prices"],
      validFrom,
      validUntil,
      salt: randomBytes(32).toString("hex"),
    },
    evidence: { recordType: "agreement", values: { prices: terms.prices } },
  });
  const disclosurePair = await sign(CommercialDisclosureSchema, disclosure);
  const publication = CasePublicationSchema.parse({
    protocolVersion: 1,
    kind: "case-evidence-publication",
    publicationId: randomUUID(),
    caseDomainId: domain.domainId,
    scope: {
      grantId: disclosure.grant.grantId,
      disclosureDigest: digest(disclosurePair.sourceJws),
      caseId: disclosure.grant.caseId,
      policyId: policy.policyId,
      policyDigest: disclosure.grant.policyDigest,
      domainId: policy.domainId,
      agreementRevisionId: policy.agreementRevisionId,
      agreementDigest: policy.agreementDigest,
      sourceSiteId: sourceKey.siteId,
      targetSiteId: targetKey.siteId,
      evidenceRecipientSiteId: domain.recipientSiteId,
    },
    issuedAt: new Date(time).toISOString(),
    validUntil,
    salt: randomBytes(32).toString("hex"),
  });
  async function fresh() {
    const value = {
      ...publication,
      publicationId: randomUUID(),
      salt: randomBytes(32).toString("hex"),
    };
    const pair = await sign(CasePublicationSchema, value);
    return CaseProposalSchema.options[0].parse({
      operation: "record-case-evidence",
      domainId: domain.domainId,
      recordId: value.publicationId,
      digest: digest(pair.sourceJws),
      envelope: { publication: pair, evidence: { policy: policyPair, disclosure: disclosurePair } },
    });
  }
  async function revoke(input: CaseProposal, issuer = sourceKey) {
    const value = CaseRevocationSchema.parse({
      protocolVersion: 1,
      kind: "case-publication-revocation",
      revocationId: randomUUID(),
      caseDomainId: domain.domainId,
      publicationId: input.recordId,
      publicationDigest: input.digest,
      issuerSiteId: issuer.siteId,
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
    const jws = await signFederationMessage(CaseRevocationSchema, value, issuer);
    return CaseProposalSchema.options[1].parse({
      operation: "revoke-case-publication",
      domainId: domain.domainId,
      recordId: value.revocationId,
      digest: digest(jws),
      envelope: { issuerSiteId: issuer.siteId, jws },
    });
  }
  const evidence = await fresh();
  stage = "case endorsements";
  for (const missing of members) {
    const tx = await readyEndorse(propose(evidence));
    const prepared = proto.PreparedTransaction.deserializeBinary(tx.getBytes()),
      outer = prepared.getEnvelope();
    assert(outer);
    const payload = common.Payload.deserializeBinary(outer.getPayload_asU8());
    const transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
    for (const action of transaction.getActionsList()) {
      const body = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8()),
        endorsements = body.getAction();
      assert(endorsements);
      assert.deepEqual(
        endorsements
          .getEndorsementsList()
          .map((entry) =>
            msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid(),
          )
          .sort(),
        [...members].sort(),
      );
      endorsements.setEndorsementsList(
        endorsements
          .getEndorsementsList()
          .filter(
            (entry) =>
              msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid() !==
              missing,
          ),
      );
      action.setPayload(body.serializeBinary());
    }
    payload.setData(transaction.serializeBinary());
    outer.setPayload(payload.serializeBinary());
    // Invalid transactions retain authorized private simulation data, but never update world state.
    await commit(a.newTransaction(prepared.serializeBinary()), [stored(evidence)], "kq-cases", 10);
    assert.deepEqual(await receipt(evidence.recordId), { receipt: null });
  }
  passed.push("native validation rejects each missing A/B/R endorsement");
  await commit(await readyEndorse(propose(evidence)), [stored(evidence)]);
  await commit(await readyEndorse(propose(evidence)), [stored(evidence)]);
  passed.push("three-member publication commits and replay preserves all six original signatures");
  for (const name of ["R", "D"]) {
    const gateway = await connection(name, "A", true);
    await assert.rejects(
      gateway
        .getNetwork(network.channel)
        .getContract("kq-commercial")
        .newProposal("GetAgreementReceipt", {
          arguments: [domain.commercialDomainId, policy.agreementRevisionId],
          endorsingOrganizations: ["AMSP"],
        })
        .endorse(),
      chainRejection("POLICY_DENIED"),
    );
  }
  const outsider = await connection("D", "A");
  await assert.rejects(
    outsider
      .getNetwork(network.channel)
      .getContract("kq-cases")
      .newProposal("GetCaseReceipt", {
        arguments: [domain.domainId, "case-evidence", evidence.recordId],
        endorsingOrganizations: ["AMSP"],
      })
      .endorse(),
    chainRejection("POLICY_DENIED"),
  );
  passed.push("R and D cannot read original commercial receipts; D cannot read case receipts");
  for (const first of ["revoke", "publish"] as const) {
    const input = await fresh(),
      revocation = await revoke(input, first === "revoke" ? sourceKey : targetKey);
    const pendingEvidence = await propose(input).endorse(),
      pendingRevocation = await propose(revocation).endorse();
    if (first === "revoke") {
      await commit(pendingRevocation, [stored(revocation), input.digest]);
      await commit(pendingEvidence, [stored(input)], "kq-cases", 11);
      assert.deepEqual(await receipt(input.recordId), { receipt: null });
    } else {
      await commit(pendingEvidence, [stored(input)]);
      await commit(pendingRevocation, [stored(revocation), input.digest], "kq-cases", 11);
      assert.deepEqual(await receipt(revocation.recordId, "case-revocation"), { receipt: null });
      await propose(input).endorse();
      await commit(await propose(revocation).endorse(), [stored(revocation), input.digest]);
    }
    await assert.rejects(propose(input).endorse(), chainRejection("POLICY_DENIED"));
    passed.push(
      `real MVCC conflict and permanent publication refusal with ${first} committed first`,
    );
  }
  const recovery = await fresh();
  await write(join(root, "case-proposal.json"), recovery);
  await writeFile(join(root, "case-recovery.key"), randomBytes(32), { mode: 0o600 });
  const probes = [
    contractProbe,
    priceProbe,
    envelope.sourceJws,
    envelope.targetJws,
    ...[evidence.envelope.publication, policyPair, disclosurePair].flatMap((pair) => [
      pair.sourceJws,
      pair.targetJws,
    ]),
  ];
  await write(resultFile, { passed, probes, blocks });
}

async function recover() {
  const member = site("A"),
    userMsp = join(member.userMsp, "..", "..", "User2@a.kq.test", "msp");
  const keys = await readdir(join(userMsp, "keystore"));
  assert(keys.length === 1 && keys[0]);
  const runDirectory = join(root, "case-adapter");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const configFile = join(root, "case-adapter.json");
  await write(configFile, {
    adapter: { siteId: member.siteId, channel: network.channel, chaincode: "kq-cases", trust },
    peerEndpoint: `127.0.0.1:${member.peerPort}`,
    peerTlsCaFile: join(member.tls, "ca.crt"),
    tlsCertificateFile: join(member.tls, "server.crt"),
    tlsPrivateKeyFile: join(member.tls, "server.key"),
    identityCertificateFile: join(userMsp, "signcerts", "User2@a.kq.test-cert.pem"),
    identityPrivateKeyFile: join(userMsp, "keystore", keys[0]),
    recoveryKeyFile: join(root, "case-recovery.key"),
    runDirectory,
  });
  const close = await startCaseAdapter(configFile);
  async function post(path: string, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: join(runDirectory, "case.sock"),
          path: `/v1/case/${path}`,
          method: "POST",
          headers: { "content-type": "application/json" },
          timeout: 30000,
        },
        (response) => {
          const parts: Buffer[] = [];
          response.on("data", (part) => parts.push(Buffer.from(part)));
          response.on("error", reject);
          response.on("end", () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve(JSON.parse(Buffer.concat(parts).toString()));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Case socket timeout")));
      req.end(JSON.stringify(body));
    });
  }
  try {
    const checkpointFile = join(root, "case-checkpoint.json");
    if (action === "prepare") {
      const input = CaseProposalSchema.parse(
        JSON.parse(await readFile(join(root, "case-proposal.json"), "utf8")),
      );
      const checkpoint = FabricProposalCheckpointSchema.parse(await post("proposal", input));
      await write(checkpointFile, checkpoint);
      return { state: "proposal", transactionId: checkpoint.transactionId };
    }
    const checkpoint = FabricProposalCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointFile, "utf8")),
    );
    const Result = z.object({
      state: z.enum(["prepared", "pending", "committed", "invalid"]),
      transactionId: z.string(),
      recovery: z.string().optional(),
      blockNumber: z.string().optional(),
    });
    let result = Result.parse(await post("advance", { recovery: checkpoint.recovery }));
    assert.equal(result.transactionId, checkpoint.transactionId);
    if (action === "crash") {
      for (let attempt = 0; attempt < 2 && result.state === "pending"; attempt++)
        result = Result.parse(await post("advance", { recovery: checkpoint.recovery }));
      assert.equal(result.state, "committed");
      await write(join(root, "case-crash-committed.json"), {
        transactionId: result.transactionId,
        state: result.state,
      });
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    if (result.state === "prepared")
      await write(checkpointFile, {
        transactionId: result.transactionId,
        recovery: result.recovery,
      });
    if (result.state === "committed") {
      const input = CaseProposalSchema.parse(
        JSON.parse(await readFile(join(root, "case-proposal.json"), "utf8")),
      );
      assert.deepEqual(
        await post("query", {
          domainId: domain.domainId,
          recordType: "case-evidence",
          recordId: input.recordId,
        }),
        { receipt: stored(input).receipt },
      );
    }
    return { ...result, recovery: undefined };
  } finally {
    await close();
  }
}

async function inspect() {
  const result = Results.parse(JSON.parse(await readFile(resultFile, "utf8")));
  const recovery = z
    .object({ blockNumber: z.string() })
    .parse(JSON.parse(await readFile(join(root, "case-recovered.json"), "utf8")));
  const input = CaseProposalSchema.parse(
    JSON.parse(await readFile(join(root, "case-proposal.json"), "utf8")),
  );
  result.blocks.push({
    block: recovery.blockNumber,
    chaincode: "kq-cases",
    expected: [stored(input)],
  });
  for (const check of result.blocks) {
    for (const [identity, endpoint] of [
      ["A", "A"],
      ["B", "B"],
      ["R", "R"],
      ["D", "D"],
      ["R", "A"],
      ["D", "A"],
      ["A", "D"],
    ]) {
      assert(identity && endpoint);
      const gateway = await connection(identity, endpoint);
      const stream = await gateway
        .getNetwork(network.channel)
        .newBlockAndPrivateDataEventsRequest({ startBlock: BigInt(check.block) })
        .getEvents({ deadline: Date.now() + 15000 });
      let seen = false;
      try {
        for await (const event of stream) {
          const block = event.getBlock();
          assert(block);
          assert.equal(String(block.getHeader()?.getNumber()), check.block);
          for (const marker of result.probes)
            assert(
              !Buffer.from(block.serializeBinary()).includes(Buffer.from(marker)),
              "Public block contains private evidence",
            );
          const writes: unknown[] = [];
          for (const [, tx] of event.getPrivateDataMapMap().entries())
            for (const ns of tx.getNsPvtRwsetList()) {
              if (ns.getNamespace() !== check.chaincode) continue;
              for (const collection of ns.getCollectionPvtRwsetList()) {
                assert.equal(
                  collection.getCollectionName(),
                  check.chaincode === "kq-cases"
                    ? domain.collection
                    : network.trust.domains[0]?.collection,
                );
                for (const value of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                  collection.getRwset_asU8(),
                ).getWritesList()) {
                  const bytes = Buffer.from(value.getValue_asU8()).toString();
                  writes.push(
                    value.getKey().split("\u0000")[1] === "case-withdrawn"
                      ? bytes
                      : JSON.parse(bytes),
                  );
                }
              }
            }
          const allowed = check.chaincode === "kq-cases" ? ["A", "B", "R"] : ["A", "B"];
          const expected =
            allowed.includes(identity) && allowed.includes(endpoint) ? check.expected : [];
          assert.deepEqual(
            writes.map((value) => JSON.stringify(value)).sort(),
            expected.map((value) => JSON.stringify(value)).sort(),
            `PDC exact writes for ${identity} via ${endpoint} in ${check.chaincode}`,
          );
          seen = true;
          break;
        }
      } finally {
        stream.close();
      }
      assert(seen);
    }
  }
  result.passed.push(
    "actual blocks prove AB commercial privacy and ABR-only exact case originals, including cross-peer and nonmember delivery",
  );
  result.passed.push("public blocks contain no original commercial or disclosed signature probes");
  await write(resultFile, result);
  return result;
}

try {
  if (action === "verify") {
    await verify();
    await write(replyFile, { state: "verified" });
  } else await write(replyFile, action === "inspect" ? await inspect() : await recover());
} catch (error) {
  if (error instanceof EndorseError)
    await write(join(root, "case-private-rpc-error.json"), {
      stage,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  // Detailed RPC errors may include private proposal bodies; retain only safe diagnostics.
  process.stderr.write(
    `Case probe ${action} at ${stage} failed: ${error instanceof Error ? error.name : "Error"}${error instanceof Error && error.name === "AssertionError" ? ` (${error.message.split("\n")[0]})` : ""}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const { gateway, client } of connections) {
    gateway.close();
    client.close();
  }
}
