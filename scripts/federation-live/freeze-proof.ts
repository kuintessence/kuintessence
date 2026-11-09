import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, peer } from "@hyperledger/fabric-protos";
import {
  CommercialDisputeAttestationEnvelopeSchema,
  CommercialReceiptSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { z } from "zod";
import { Site } from "../fabric-evidence-fixture";

const root = z.string().min(1).parse(process.argv[2]);
const network = z
  .object({ channel: z.string(), sites: z.array(Site), trust: FabricCommercialTrustSchema })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const proof = z
  .object({
    draft: CommercialDisputeFreezeSchema,
    opening: CommercialDisputeSchema,
    envelope: CommercialDisputeAttestationEnvelopeSchema,
    receipt: CommercialReceiptSchema,
    transaction: z.object({
      transactionId: z.string(),
      stage: z.literal("committed"),
      validationCode: z.literal(0),
      blockNumber: z.string(),
    }),
    evidenceDirectory: z.string(),
  })
  .parse(JSON.parse(await readFile(join(root, "live-freeze-proof.json"), "utf8")));
assert.equal(proof.draft.mode, "ledger_coordinated");
assert.equal(proof.receipt.recordId, proof.draft.caseId);
const domain = network.trust.domains.find(
  (v) =>
    v.siteIds.includes(proof.draft.sourceSiteId) &&
    v.siteIds.includes(proof.draft.targetSiteId) &&
    v.domainId === proof.opening.domainId,
);
assert(domain);
const results: Record<string, { transactionId: string; proofWrites: number; taskWrites: number }> =
  {};
for (const name of ["A", "B", "C"]) {
  const member = Site.parse(network.sites.find((v) => v.name === name));
  const keys = await readdir(join(member.userMsp, "keystore"));
  assert.equal(keys.length, 1);
  assert(keys[0]);
  const tls = await readFile(join(member.tls, "server.crt"));
  const client = new Client(
    `127.0.0.1:${member.peerPort}`,
    credentials.createSsl(
      await readFile(join(member.tls, "ca.crt")),
      await readFile(join(member.tls, "server.key")),
      tls,
    ),
    { "grpc.ssl_target_name_override": "localhost" },
  );
  const gateway = connect({
    client,
    identity: {
      mspId: `${name}MSP`,
      credentials: await readFile(
        join(member.userMsp, "signcerts", `User1@${name.toLowerCase()}.kq.test-cert.pem`),
      ),
    },
    signer: signers.newPrivateKeySigner(
      createPrivateKey(await readFile(join(member.userMsp, "keystore", keys[0]))),
    ),
    tlsClientCertificateHash: createHash("sha256").update(new X509Certificate(tls).raw).digest(),
  });
  let proofWrites = 0,
    taskWrites = 0;
  try {
    const events = await gateway
      .getNetwork(network.channel)
      .newBlockAndPrivateDataEventsRequest({ startBlock: BigInt(proof.transaction.blockNumber) })
      .getEvents({ deadline: Date.now() + 15000 });
    let received = false;
    try {
      for await (const event of events) {
        const block = event.getBlock();
        assert(block);
        assert.equal(String(block.getHeader()?.getNumber()), proof.transaction.blockNumber);
        const bytes = Buffer.from(block.serializeBinary());
        for (const marker of [
          proof.draft.salt,
          proof.opening.salt,
          proof.opening.reason,
          proof.envelope.openingJws,
          proof.envelope.sourceJws,
          proof.envelope.targetJws,
        ])
          assert(!bytes.includes(Buffer.from(marker)), "Private case leaked into public block");
        const ids = (block.getData()?.getDataList_asU8() ?? []).map((bytes) => {
          const envelope = common.Envelope.deserializeBinary(bytes);
          const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
          const header = payload.getHeader();
          assert(header);
          return common.ChannelHeader.deserializeBinary(header.getChannelHeader_asU8()).getTxId();
        });
        const index = ids.indexOf(proof.transaction.transactionId);
        assert(index >= 0);
        const codes = block.getMetadata()?.getMetadataList_asU8()[
          common.BlockMetadataIndex.TRANSACTIONS_FILTER
        ];
        assert(codes);
        assert.equal(codes[index], peer.TxValidationCode.VALID);
        for (const [position, transaction] of event.getPrivateDataMapMap().entries()) {
          if (position !== index) continue;
          for (const namespace of transaction.getNsPvtRwsetList()) {
            if (namespace.getNamespace() !== "kq-commercial") continue;
            for (const collection of namespace.getCollectionPvtRwsetList()) {
              const writes = ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                collection.getRwset_asU8(),
              ).getWritesList();
              if (name === "C") {
                assert.equal(writes.length, 0, "Third institution obtained case data");
                continue;
              }
              assert.equal(collection.getCollectionName(), domain.collection);
              assert.equal(
                writes.length,
                2,
                "Freeze changed records outside the case and task marker",
              );
              for (const write of writes) {
                assert(!write.getIsDelete());
                const value = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                if (
                  write.getKey() ===
                  `\u0000native-dispute-freeze\u0000${domain.domainId}\u0000${proof.draft.caseId}\u0000`
                ) {
                  assert.deepEqual(value, {
                    receipt: proof.receipt,
                    envelope: proof.envelope,
                    terms: proof.draft,
                    opening: proof.opening,
                  });
                  proofWrites++;
                } else {
                  assert.equal(
                    write.getKey(),
                    `\u0000dispute-task\u0000${domain.domainId}\u0000${proof.draft.agreementRevisionId}\u0000${proof.draft.taskId}\u0000${proof.draft.attempt}\u0000`,
                  );
                  assert.deepEqual(value, { activeCases: 1, salt: proof.draft.salt });
                  taskWrites++;
                }
              }
            }
          }
        }
        received = true;
        break;
      }
    } finally {
      events.close();
    }
    assert(received);
    assert.equal(proofWrites, name === "C" ? 0 : 1);
    assert.equal(taskWrites, name === "C" ? 0 : 1);
    results[name] = { transactionId: proof.transaction.transactionId, proofWrites, taskWrites };
  } finally {
    gateway.close();
    client.close();
  }
}
await writeFile(
  join(proof.evidenceDirectory, "freeze-private-ledger.json"),
  `${JSON.stringify({ caseId: proof.draft.caseId, results }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  "REAL NATIVE FREEZE PDC PASSED: original transaction VALID; A/B have exact signed case, C has none; only proof/task marker written, no money or execution writes",
);
