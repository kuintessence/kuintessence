import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, peer } from "@hyperledger/fabric-protos";
import {
  CommercialSettlementSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { z } from "zod";
import { Site } from "../fabric-evidence-fixture";

const root = z.string().min(1).parse(process.argv[2]);
const network = z
  .object({ channel: z.string(), sites: z.array(Site), trust: FabricCommercialTrustSchema })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const proof = z
  .object({
    draft: CommercialSettlementSchema,
    budgetDomainId: z.uuid(),
    epoch: z.uuid(),
    evidenceDirectory: z.string(),
    statuses: z.record(
      z.string(),
      z.object({
        record: z.object({
          settlement: z.object({ digest: z.string() }),
          ledger: z.object({ id: z.uuid() }),
        }),
      }),
    ),
    transactions: z.record(
      z.string(),
      z.array(
        z.object({
          transactionId: z.string(),
          stage: z.string(),
          validationCode: z.number().nullable(),
          blockNumber: z.string().nullable(),
        }),
      ),
    ),
  })
  .parse(JSON.parse(await readFile(join(root, "live-settlement-proof.json"), "utf8")));
for (const name of ["source", "provider"]) {
  const state = z
    .object({
      commercialTransactions: z.array(
        z.object({ submissionId: z.uuid(), transactionId: z.string() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(join(proof.evidenceDirectory, `${name}-settlement-offline.json`), "utf8"),
      ),
    );
  const id = proof.statuses[name]?.record.ledger.id;
  assert(id);
  for (const attempt of state.commercialTransactions.filter((v) => v.submissionId === id)) {
    assert(
      proof.transactions[name]?.some((v) => v.transactionId === attempt.transactionId),
      "Recovery discarded an original settlement checkpoint",
    );
  }
}
const domain = network.trust.domains.find((v) => v.domainId === proof.draft.domainId);
assert(domain);
const expected = Object.values(proof.transactions)
  .flat()
  .filter((v) => v.stage === "committed" && v.validationCode === 0);
assert.equal(expected.length, 2);
const blocks = [...new Set(expected.map((v) => v.blockNumber))];
const results: Record<
  string,
  {
    transactions: string[];
    budgetWrites: number;
    settlementWrites: number;
    reservationWrites: number;
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
    transactions: [] as string[],
    budgetWrites: 0,
    settlementWrites: 0,
    reservationWrites: 0,
  };
  try {
    for (const number of blocks) {
      assert(number);
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
          assert(
            !Buffer.from(block.serializeBinary()).includes(Buffer.from(proof.draft.salt)),
            "Settlement plaintext leaked into public block",
          );
          const codes = block.getMetadata()?.getMetadataList_asU8()[
            common.BlockMetadataIndex.TRANSACTIONS_FILTER
          ];
          assert(codes);
          const transactionIds = (block.getData()?.getDataList_asU8() ?? []).map((bytes) => {
            const envelope = common.Envelope.deserializeBinary(bytes);
            const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
            const header = payload.getHeader();
            assert(header);
            return common.ChannelHeader.deserializeBinary(header.getChannelHeader_asU8()).getTxId();
          });
          for (const wanted of expected.filter((v) => v.blockNumber === number)) {
            const index = transactionIds.indexOf(wanted.transactionId);
            assert(index >= 0, "Persisted transaction is missing from claimed block");
            assert.equal(codes[index], peer.TxValidationCode.VALID);
            result.transactions.push(wanted.transactionId);
          }
          for (const [index, transaction] of event.getPrivateDataMapMap().entries()) {
            if (!expected.some((v) => v.transactionId === transactionIds[index])) continue;
            for (const namespace of transaction.getNsPvtRwsetList()) {
              if (namespace.getNamespace() !== "kq-commercial") continue;
              for (const collection of namespace.getCollectionPvtRwsetList()) {
                const writes = ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                  collection.getRwset_asU8(),
                ).getWritesList();
                if (name === "C") {
                  assert.equal(
                    writes.length,
                    0,
                    "Third institution received private settlement data",
                  );
                  continue;
                }
                assert.equal(collection.getCollectionName(), domain.collection);
                for (const write of writes) {
                  if (
                    write.getKey() ===
                    `\u0000budget\u0000${proof.draft.domainId}\u0000${proof.budgetDomainId}\u0000${proof.epoch}\u0000`
                  ) {
                    const budget = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    assert.equal(budget.locked, "0");
                    assert.equal(budget.spent, proof.draft.chargedAmount);
                    assert.equal(budget.reservations, 0);
                    assert.equal(budget.unit, proof.draft.unit);
                    assert.equal(budget.sourceSiteId, proof.draft.sourceSiteId);
                    assert.equal(budget.targetSiteId, proof.draft.targetSiteId);
                    result.budgetWrites++;
                  }
                  if (
                    write.getKey() ===
                    `\u0000settlement\u0000${proof.draft.domainId}\u0000${proof.draft.settlementId}\u0000`
                  ) {
                    const record = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    assert.deepEqual(record.terms, proof.draft);
                    assert.equal(
                      record.receipt.digest,
                      proof.statuses.provider?.record.settlement.digest,
                    );
                    result.settlementWrites++;
                  }
                  if (
                    write.getKey() ===
                    `\u0000reservation\u0000${proof.draft.domainId}\u0000${proof.draft.reservationId}\u0000`
                  ) {
                    const reservation = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    assert.equal(reservation.state, "settled");
                    assert.equal(
                      reservation.reservation.request.maxAmount,
                      proof.draft.reservedAmount,
                    );
                    assert.deepEqual(reservation.settlement.terms, proof.draft);
                    result.reservationWrites++;
                  }
                  assert(
                    !write.getKey().startsWith("\u0000execution-gate\u0000"),
                    "Settlement changed execution gate",
                  );
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
    }
    assert.equal(result.transactions.length, 2);
    assert.equal(
      result.budgetWrites,
      name === "C" ? 0 : 1,
      "The original budget must be spent exactly once",
    );
    assert.equal(
      result.settlementWrites,
      name === "C" ? 0 : 2,
      "Both VALID transactions retain the same immutable settlement",
    );
    assert.equal(result.reservationWrites, name === "C" ? 0 : 1);
    results[name] = result;
  } finally {
    gateway.close();
    client.close();
  }
}
await writeFile(
  join(proof.evidenceDirectory, "settlement-private-ledger.json"),
  `${JSON.stringify(
    {
      settlementId: proof.draft.settlementId,
      chargedAmount: proof.draft.chargedAmount,
      releasedAmount: proof.draft.releasedAmount,
      results,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  "REAL SETTLEMENT PDC PASSED: both platform transactions are VALID; one private budget debit, identical settlement replay, unchanged terminal gate and no third-party private writes",
);
