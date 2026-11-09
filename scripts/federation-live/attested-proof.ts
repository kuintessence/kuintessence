import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, peer } from "@hyperledger/fabric-protos";
import {
  CommercialAdapterProposalInputSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  FabricEvidenceTrustSchema,
  FederationEvidenceBatchSchema,
} from "@kuintessence/shared/federation/ledger";
import { z } from "zod";
import { Site } from "../fabric-evidence-fixture";

const root = z.string().min(1).parse(process.argv[2]);
const network = z
  .object({ channel: z.string(), sites: z.array(Site), trust: FabricCommercialTrustSchema })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const evidenceTrust = FabricEvidenceTrustSchema.parse(
  JSON.parse(await readFile(join(root, "execution-evidence-trust.json"), "utf8")),
);
const proof = z
  .object({ evidenceDirectory: z.string(), scenario: z.enum(["success", "refund", "refund-auto"]) })
  .parse(JSON.parse(await readFile(join(root, "live-attested-proof.json"), "utf8")));
const refund = ["refund", "refund-auto"].includes(proof.scenario);
const attempt = z.object({
  transactionId: z.string(),
  stage: z.string(),
  validationCode: z.number().nullable(),
  blockNumber: z.string().nullable(),
});
const snapshot = z.object({
  commercial: z.array(
    z.object({
      id: z.uuid(),
      state: z.literal("committed"),
      input: CommercialAdapterProposalInputSchema,
    }),
  ),
  commercialTransactions: z.array(attempt.extend({ submissionId: z.uuid() })),
  evidenceBatches: z.array(
    z.object({
      id: z.uuid(),
      state: z.literal("anchored"),
      manifest: FederationEvidenceBatchSchema,
      issuerJws: z.string(),
      digest: z.string(),
    }),
  ),
  attestationAttempts: z.array(attempt.extend({ batchId: z.uuid() })),
});
const recordTypes = {
  "register-agreement": "agreement",
  "record-usage": "usage",
  "confirm-bill": "bill",
  "settle-bill": "settlement",
  "adjust-settlement": "adjustment",
  "record-refund": "refund",
  "record-payment": "payment",
} as const;
const expected: {
  chaincode: string;
  collection: string;
  key: string;
  digest: string;
  recordId: string;
  envelope: object;
  body: Record<string, unknown>;
  transactionId: string;
  blockNumber: string;
  manifest?: z.infer<typeof FederationEvidenceBatchSchema>;
}[] = [];
for (const name of ["source", "provider"]) {
  const state = snapshot.parse(
    JSON.parse(
      await readFile(join(proof.evidenceDirectory, `${name}-attested-recovered.json`), "utf8"),
    ),
  );
  assert.equal(state.commercial.length, name === "source" ? 1 : refund ? 2 : 8);
  for (const row of state.commercial) {
    const operation = z
      .enum([
        "register-agreement",
        "record-usage",
        "confirm-bill",
        "settle-bill",
        "adjust-settlement",
        "record-refund",
        "record-payment",
      ])
      .parse(row.input.operation);
    const domain = network.trust.domains.find((v) => v.domainId === row.input.domainId);
    assert(domain);
    const valid = state.commercialTransactions.filter(
      (a) => a.submissionId === row.id && a.stage === "committed" && a.validationCode === 0,
    );
    assert.equal(valid.length, 1);
    const tx = valid[0];
    assert(tx?.blockNumber);
    const jws = Object.entries(row.input.envelope).find(([key]) => key.endsWith("Jws"))?.[1];
    assert(typeof jws === "string");
    const payload = jws.split(".")[1];
    assert(payload);
    const body = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    expected.push({
      chaincode: "kq-commercial",
      collection: domain.collection,
      key: `\u0000${recordTypes[operation]}\u0000${row.input.domainId}\u0000${row.input.recordId}\u0000`,
      digest: row.input.digest,
      recordId: row.input.recordId,
      envelope: row.input.envelope,
      body,
      transactionId: tx.transactionId,
      blockNumber: tx.blockNumber,
    });
  }
  for (const batch of state.evidenceBatches) {
    const domain = evidenceTrust.domains.find((v) => v.domainId === batch.manifest.domainId);
    assert(domain);
    const valid = state.attestationAttempts.filter(
      (a) => a.batchId === batch.id && a.stage === "anchored" && a.validationCode === 0,
    );
    assert.equal(valid.length, 1);
    const tx = valid[0];
    assert(tx?.blockNumber);
    expected.push({
      chaincode: "kq-evidence",
      collection: domain.collection,
      key: `\u0000anchor\u0000${batch.manifest.domainId}\u0000${batch.id}\u0000`,
      recordId: batch.id,
      digest: batch.digest,
      envelope: { issuerJws: batch.issuerJws },
      body: batch.manifest,
      manifest: batch.manifest,
      transactionId: tx.transactionId,
      blockNumber: tx.blockNumber,
    });
  }
}
assert.equal(expected.filter((v) => v.chaincode === "kq-commercial").length, refund ? 3 : 9);
const batches = expected.filter((v) => v.manifest);
assert(batches.length >= 1 && batches.length <= 2);
assert.equal(
  batches.reduce((n, v) => n + (v.manifest?.records.length ?? 0), 0),
  2,
);
assert.equal(new Set(expected.map((v) => v.transactionId)).size, expected.length);
const results: Record<
  string,
  {
    transactions: number;
    originals: number;
    admissionRecords: number;
    cursors: number;
    adjustmentHeads: number;
    refundIndexes: number;
    paymentHeads: number;
  }
> = {};
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
  const result = {
    transactions: 0,
    originals: 0,
    admissionRecords: 0,
    cursors: 0,
    adjustmentHeads: 0,
    refundIndexes: 0,
    paymentHeads: 0,
  };
  try {
    for (const number of new Set(expected.map((v) => v.blockNumber))) {
      const events = await gateway
        .getNetwork(network.channel)
        .newBlockAndPrivateDataEventsRequest({ startBlock: BigInt(number) })
        .getEvents({ deadline: Date.now() + 15000 });
      let received = false;
      try {
        for await (const event of events) {
          const block = event.getBlock();
          assert(block);
          assert.equal(String(block.getHeader()?.getNumber()), number);
          const publicBytes = Buffer.from(block.serializeBinary());
          for (const value of expected) {
            assert(
              !publicBytes.includes(Buffer.from(JSON.stringify(value.envelope))),
              "Public block contains private signature envelope",
            );
            for (const [key, signature] of Object.entries(value.envelope))
              if (key.endsWith("Jws")) {
                assert(typeof signature === "string");
                assert(
                  !publicBytes.includes(Buffer.from(signature)),
                  "Public block contains a private signature with encoded commercial terms",
                );
              }
            assert(typeof value.body.salt === "string");
            assert(
              !publicBytes.includes(Buffer.from(value.body.salt)),
              "Public block contains private plaintext",
            );
          }
          const codes = block.getMetadata()?.getMetadataList_asU8()[
            common.BlockMetadataIndex.TRANSACTIONS_FILTER
          ];
          assert(codes);
          const txIds = (block.getData()?.getDataList_asU8() ?? []).map((bytes) => {
            const envelope = common.Envelope.deserializeBinary(bytes);
            const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
            const header = payload.getHeader();
            assert(header);
            return common.ChannelHeader.deserializeBinary(header.getChannelHeader_asU8()).getTxId();
          });
          for (const wanted of expected.filter((v) => v.blockNumber === number)) {
            const index = txIds.indexOf(wanted.transactionId);
            assert(index >= 0);
            assert.equal(codes[index], peer.TxValidationCode.VALID);
            result.transactions++;
            let originals = 0,
              records = 0,
              cursors = 0;
            const data = event.getPrivateDataMapMap().get(index);
            for (const namespace of data?.getNsPvtRwsetList() ?? []) {
              if (namespace.getNamespace() !== wanted.chaincode) continue;
              for (const collection of namespace.getCollectionPvtRwsetList()) {
                const writes = ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                  collection.getRwset_asU8(),
                ).getWritesList();
                if (name === "C") {
                  assert.equal(writes.length, 0, "Nonmember received private evidence");
                  continue;
                }
                assert.equal(collection.getCollectionName(), wanted.collection);
                for (const write of writes) {
                  assert(!write.getIsDelete(), "Attestation deleted private history");
                  for (const prefix of ["budget", "reservation", "execution-gate"])
                    assert(
                      !write.getKey().startsWith(`\u0000${prefix}\u0000`),
                      "Attestation created spendable ledger state or execution permit",
                    );
                  if (write.getKey() === wanted.key) {
                    const record = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    assert.deepEqual(record.envelope, wanted.envelope);
                    assert.equal(record.receipt.digest, wanted.digest);
                    assert.equal(
                      wanted.manifest ? record.receipt.batchId : record.receipt.recordId,
                      wanted.recordId,
                    );
                    if (!wanted.manifest)
                      assert.deepEqual(record.terms ?? record.report, wanted.body);
                    originals++;
                  }
                  if (wanted.body.kind === "commercial-payment") {
                    const headKey = `\u0000payment-head\u0000${wanted.body.domainId}\u0000${wanted.body.paymentId}\u0000`;
                    assert(
                      [wanted.key, headKey].includes(write.getKey()),
                      "Payment changed unrelated ledger state",
                    );
                    if (write.getKey() === headKey) {
                      assert.deepEqual(JSON.parse(Buffer.from(write.getValue_asU8()).toString()), {
                        recordId: wanted.recordId,
                        digest: wanted.digest,
                      });
                      result.paymentHeads++;
                    }
                  }
                  if (wanted.manifest) {
                    if (
                      write.getKey() === `\u0000cursor\u0000${wanted.manifest.issuerSiteId}\u0000`
                    ) {
                      assert.deepEqual(JSON.parse(Buffer.from(write.getValue_asU8()).toString()), {
                        sequence: wanted.manifest.records.at(-1)?.sequence,
                        salt: wanted.manifest.salt,
                      });
                      cursors++;
                    }
                    for (const item of wanted.manifest.records)
                      if (
                        write.getKey() ===
                        `\u0000record\u0000${wanted.manifest.issuerSiteId}\u0000${item.evidenceId}\u0000`
                      ) {
                        assert.equal(
                          Buffer.from(write.getValue_asU8()).toString(),
                          wanted.recordId,
                        );
                        records++;
                      }
                  }
                  if (
                    ["refund-head", "refund-operation"].some((prefix) =>
                      write.getKey().startsWith(`\u0000${prefix}\u0000`),
                    )
                  ) {
                    assert(refund);
                    assert.deepEqual(JSON.parse(Buffer.from(write.getValue_asU8()).toString()), {
                      refundId: wanted.recordId,
                      salt: wanted.body.salt,
                    });
                    result.refundIndexes++;
                  }
                  if (write.getKey().startsWith("\u0000adjustment-head\u0000")) {
                    assert.deepEqual(JSON.parse(Buffer.from(write.getValue_asU8()).toString()), {
                      adjustmentId: wanted.recordId,
                      salt: wanted.body.salt,
                    });
                    result.adjustmentHeads++;
                  }
                }
              }
            }
            assert.equal(originals, name === "C" ? 0 : 1);
            assert.equal(records, name === "C" ? 0 : (wanted.manifest?.records.length ?? 0));
            assert.equal(cursors, name !== "C" && wanted.manifest ? 1 : 0);
            result.originals += originals;
            result.admissionRecords += records;
            result.cursors += cursors;
          }
          received = true;
          break;
        }
      } finally {
        events.close();
      }
      assert(received);
    }
    assert.equal(result.transactions, expected.length);
    assert.equal(result.adjustmentHeads, name === "C" || refund ? 0 : 2);
    assert.equal(result.refundIndexes, name !== "C" && refund ? 2 : 0);
    assert.equal(result.paymentHeads, name === "C" || refund ? 0 : 2);
    assert.equal(result.admissionRecords, name === "C" ? 0 : 2);
    results[name] = result;
  } finally {
    gateway.close();
    client.close();
  }
}
await writeFile(
  join(proof.evidenceDirectory, "attested-private-ledger.json"),
  `${JSON.stringify(
    {
      transactions: expected.map(({ transactionId, blockNumber, chaincode }) => ({
        transactionId,
        blockNumber,
        chaincode,
      })),
      results,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  "REAL ATTESTED PDC PASSED: original commercial records and both admission evidence entries are VALID; no ledger budget/permit writes; A/B private originals match; C receives no private data",
);
