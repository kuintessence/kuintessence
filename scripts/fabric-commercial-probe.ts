import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, EndorseError, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, msp, peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  CommercialAgreementSchema,
  CommercialReceiptSchema,
  CommercialUsageSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { Site } from "./fabric-evidence-fixture";

const network = z
  .object({
    channel: z.literal("kq-evidence-test"),
    chaincode: z.literal("kq-commercial"),
    trust: FabricCommercialTrustSchema,
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

async function run() {
  const a = await connection("A"),
    b = await connection("B"),
    c = await connection("C"),
    domain = network.trust.domains[0];
  assert(domain);
  const contract = (gateway: ReturnType<typeof connect>) =>
    gateway.getNetwork(network.channel).getContract(network.chaincode);
  const deadline = Date.now() + 45000;
  for (;;) {
    let ready = true;
    for (const mspId of ["AMSP", "BMSP"]) {
      try {
        await contract(a)
          .newProposal("GetAgreementReceipt", {
            arguments: [domain.domainId, randomUUID()],
            endorsingOrganizations: [mspId],
          })
          .endorse();
        throw new Error("Unexpected fixture agreement");
      } catch (error) {
        if (!chainRejection("ASSET_UNAVAILABLE")(error)) ready = false;
      }
    }
    if (ready) break;
    assert(Date.now() < deadline, "Commercial peers must be ready");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const [sourceKey, targetKey] = await Promise.all([signing("A"), signing("B")]);
  const contractProbe = `PRIVATE-CONTRACT-${randomUUID()}`,
    priceProbe = "900719925474099317",
    usageProbe = "72057594037927939";
  const time = Date.now();
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: domain.domainId,
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
  const proposal = (gateway: ReturnType<typeof connect>, fcn: string, id: string, input: unknown) =>
    contract(gateway).newProposal(fcn, {
      arguments: [domain.domainId, id],
      transientData: { commercial: JSON.stringify(input) },
      endorsingOrganizations: ["AMSP", "BMSP"],
    });
  await assert.rejects(
    proposal(a, "RegisterAgreement", terms.agreement.agreementRevisionId, {
      ...envelope,
      targetJws: envelope.sourceJws,
    }).endorse(),
    chainRejection("INVALID_MESSAGE"),
  );
  passed.push("both real peers reject missing counterparty business approval");
  const endorsed = await proposal(
    a,
    "RegisterAgreement",
    terms.agreement.agreementRevisionId,
    envelope,
  ).endorse();
  const prepared = proto.PreparedTransaction.deserializeBinary(endorsed.getBytes());
  const outer = prepared.getEnvelope();
  assert(outer);
  const payload = common.Payload.deserializeBinary(outer.getPayload_asU8()),
    transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
  for (const action of transaction.getActionsList()) {
    const actionPayload = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8()),
      endorsements = actionPayload.getAction();
    assert(endorsements);
    const remaining = endorsements
      .getEndorsementsList()
      .filter(
        (entry) =>
          msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid() === "AMSP",
      );
    assert.equal(remaining.length, 1);
    endorsements.setEndorsementsList(remaining);
    action.setPayload(actionPayload.serializeBinary());
  }
  payload.setData(transaction.serializeBinary());
  outer.setPayload(payload.serializeBinary());
  const invalid = await (await a.newTransaction(prepared.serializeBinary()).submit()).getStatus();
  assert.equal(invalid.successful, false);
  assert.equal(invalid.code, 10);
  passed.push("Fabric VALIDATION rejects a commercial transaction missing B's native endorsement");
  const registered = await proposal(
    a,
    "RegisterAgreement",
    terms.agreement.agreementRevisionId,
    envelope,
  ).endorse();
  const receipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(registered.getResult()).toString()),
  );
  assert.equal(receipt.recordId, terms.agreement.agreementRevisionId);
  const valid = await (await registered.submit()).getStatus();
  assert.equal(valid.successful, true);
  passed.push(
    "both approvals and native institution endorsements commit the private agreement VALID",
  );
  const report = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: receipt.recordId,
    agreementDigest: receipt.digest,
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    taskId: randomUUID(),
    attempt: 1,
    salt: randomBytes(32).toString("hex"),
    reportedAt: new Date(time).toISOString(),
    periodStart: new Date(time - 50000).toISOString(),
    periodEnd: new Date(time - 10000).toISOString(),
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: usageProbe,
        evidenceDigest: `sha256:${randomBytes(32).toString("hex")}`,
      },
    ],
  });
  const providerJws = await signFederationMessage(CommercialUsageSchema, report, targetKey);
  const recorded = await proposal(b, "RecordUsage", report.reportId, { providerJws }).endorse();
  const recordedStatus = await (await recorded.submit()).getStatus();
  assert.equal(recordedStatus.successful, true);
  CommercialReceiptSchema.parse(JSON.parse(Buffer.from(recorded.getResult()).toString()));
  passed.push("provider usage commits separately without producing a payment or settlement");
  const taskId = randomUUID();
  const concurrent = [0, 1].map(() => ({
    ...report,
    taskId,
    reportId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
  }));
  const contenders = await Promise.all(
    concurrent.map(async (value) =>
      proposal(b, "RecordUsage", value.reportId, {
        providerJws: await signFederationMessage(CommercialUsageSchema, value, targetKey),
      }).endorse(),
    ),
  );
  assert(contenders[0] && contenders[1]);
  const won = await (await contenders[0].submit()).getStatus();
  const lost = await (await contenders[1].submit()).getStatus();
  assert.equal(won.successful, true);
  assert.equal(lost.successful, false);
  assert.equal(lost.code, 11);
  passed.push(
    "native MVCC permits only one concurrently endorsed initial usage report per task attempt",
  );
  for (const gateway of [a, b]) {
    const read = await contract(gateway).evaluateTransaction(
      "GetAgreementReceipt",
      domain.domainId,
      receipt.recordId,
    );
    assert.deepEqual(JSON.parse(Buffer.from(read).toString()), receipt);
  }
  await assert.rejects(
    contract(c)
      .newProposal("GetAgreementReceipt", {
        arguments: [domain.domainId, receipt.recordId],
        endorsingOrganizations: ["CMSP"],
      })
      .endorse(),
    chainRejection("POLICY_DENIED"),
  );
  const admin = await connection("A", "A", true);
  await assert.rejects(
    contract(admin)
      .newProposal("GetAgreementReceipt", {
        arguments: [domain.domainId, receipt.recordId],
        endorsingOrganizations: ["AMSP"],
      })
      .endorse(),
    chainRejection("UNTRUSTED_IDENTITY"),
  );
  passed.push("nonmember and trust-admin clients cannot query commercial receipts");
  const probes = [
    contractProbe,
    priceProbe,
    usageProbe,
    envelope.sourceJws,
    envelope.targetJws,
    providerJws,
  ];
  for (const blockNumber of [
    invalid.blockNumber,
    valid.blockNumber,
    recordedStatus.blockNumber,
    won.blockNumber,
    lost.blockNumber,
  ]) {
    for (const [name, endpoint, expected] of [
      ["A", "A", true],
      ["B", "B", true],
      ["C", "A", false],
      ["A", "C", false],
      ["C", "C", false],
    ] as const) {
      const gateway = await connection(name, endpoint);
      const events = await gateway
        .getNetwork(network.channel)
        .newBlockAndPrivateDataEventsRequest({ startBlock: blockNumber })
        .getEvents({ deadline: Date.now() + 10000 });
      let seen = false;
      try {
        for await (const event of events) {
          const block = event.getBlock();
          assert(block);
          assert.equal(String(block.getHeader()?.getNumber()), String(blockNumber));
          const publicBytes = Buffer.from(block.serializeBinary());
          for (const probe of probes)
            assert(
              !publicBytes.includes(Buffer.from(probe)),
              "Public block leaked commercial material",
            );
          const writes: Buffer[] = [];
          for (const [, tx] of event.getPrivateDataMapMap().entries())
            for (const ns of tx.getNsPvtRwsetList())
              if (ns.getNamespace() === network.chaincode)
                for (const collection of ns.getCollectionPvtRwsetList())
                  for (const write of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                    collection.getRwset_asU8(),
                  ).getWritesList())
                    writes.push(Buffer.from(write.getValue_asU8()));
          if (!expected) assert.equal(writes.length, 0);
          else if (blockNumber !== invalid.blockNumber && blockNumber !== lost.blockNumber) {
            assert.equal(writes.length, blockNumber === valid.blockNumber ? 1 : 2);
            assert(
              writes.some((bytes) =>
                bytes.includes(
                  Buffer.from(blockNumber === valid.blockNumber ? contractProbe : usageProbe),
                ),
              ),
            );
          }
          seen = true;
          break;
        }
      } finally {
        events.close();
      }
      assert(seen, "Receive committed block");
    }
  }
  passed.push(
    "actual public blocks omit contract/price/usage/JWS probes; A/B receive PDC and C cannot obtain it through A or C peers",
  );
  const replay = await proposal(a, "RegisterAgreement", receipt.recordId, envelope).endorse();
  assert.deepEqual(JSON.parse(Buffer.from(replay.getResult()).toString()), receipt);
  assert.equal((await (await replay.submit()).getStatus()).successful, true);
  passed.push("same immutable agreement replays idempotently under the two-party PDC policy");
  await writeFile(z.string().parse(process.argv[3]), JSON.stringify({ passed, probes }), {
    mode: 0o600,
  });
}
try {
  await run();
} catch (error) {
  process.stderr.write(
    `Commercial probe failed: ${error instanceof Error ? error.name : "Error"}${error instanceof Error && error.name === "AssertionError" ? ` (${error.message})` : ""}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const { gateway, client } of connections) {
    gateway.close();
    client.close();
  }
}
