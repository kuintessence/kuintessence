import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, peer } from "@hyperledger/fabric-protos";
import {
  CommercialAdjustmentSchema,
  CommercialPaymentApprovalSchema,
  CommercialPaymentSchema,
  CommercialSettlementSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { z } from "zod";
import { Site } from "../fabric-evidence-fixture";

const root = z.string().min(1).parse(process.argv[2]);
const recordName = z
  .enum(["settlement", "adjustment-1", "adjustment-2", "payment-1", "payment-2"])
  .parse(process.argv[3] ?? "settlement");
const network = z
  .object({ channel: z.string(), sites: z.array(Site), trust: FabricCommercialTrustSchema })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const proof = z
  .object({
    draft: z.union([
      CommercialSettlementSchema,
      CommercialAdjustmentSchema,
      CommercialPaymentSchema,
    ]),
    budgetDomainId: z.uuid(),
    epoch: z.uuid(),
    evidenceDirectory: z.string(),
    statuses: z.record(
      z.string(),
      z.object({
        record: z.object({
          settlement: z.object({ digest: z.string() }).optional(),
          adjustment: z.object({ digest: z.string() }).optional(),
          payment: CommercialPaymentApprovalSchema.optional(),
          ledger: z.object({ id: z.uuid() }).nullable(),
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
  .parse(JSON.parse(await readFile(join(root, `live-${recordName}-proof.json`), "utf8")));
const isAdjustment = proof.draft.kind === "commercial-adjustment";
const isPayment = proof.draft.kind === "commercial-payment";
assert.equal(isAdjustment, recordName.startsWith("adjustment-"));
assert.equal(isPayment, recordName.startsWith("payment-"));
const receipt = isPayment
  ? proof.statuses.provider?.record.payment
  : isAdjustment
    ? proof.statuses.provider?.record.adjustment
    : proof.statuses.provider?.record.settlement;
assert(receipt);
if (isPayment) {
  const source = proof.statuses.source?.record;
  const provider = proof.statuses.provider?.record;
  assert.equal(source?.ledger, null);
  assert(source?.payment && provider?.payment);
  assert.deepEqual(source.payment.payload, proof.draft);
  assert.deepEqual(provider.payment.payload, proof.draft);
  assert.equal(source.payment.digest, provider.payment.digest);
  assert.equal(source.payment.counterpartyJws, provider.payment.approvalJws);
  assert.equal(provider.payment.counterpartyJws, source.payment.approvalJws);
}
for (const name of isPayment ? ["provider"] : ["source", "provider"]) {
  const state = z
    .object({
      commercialTransactions: z.array(
        z.object({ submissionId: z.uuid(), transactionId: z.string() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(join(proof.evidenceDirectory, `${name}-${recordName}-offline.json`), "utf8"),
      ),
    );
  const id = proof.statuses[name]?.record.ledger?.id;
  assert(id);
  for (const attempt of state.commercialTransactions.filter((v) => v.submissionId === id)) {
    assert(
      proof.transactions[name]?.some((v) => v.transactionId === attempt.transactionId),
      "Recovery discarded an original commercial checkpoint",
    );
  }
}
const domain = network.trust.domains.find((v) => v.domainId === proof.draft.domainId);
assert(domain);
const expected = Object.values(proof.transactions)
  .flat()
  .filter((v) => v.stage === "committed" && v.validationCode === 0);
assert.equal(expected.length, isPayment ? 1 : 2);
const blocks = [...new Set(expected.map((v) => v.blockNumber))];
const results: Record<
  string,
  {
    transactions: string[];
    budgetWrites: number;
    settlementWrites: number;
    reservationWrites: number;
    adjustmentWrites: number;
    headWrites: number;
    paymentWrites: number;
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
    adjustmentWrites: 0,
    headWrites: 0,
    paymentWrites: 0,
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
            "Commercial plaintext leaked into public block",
          );
          if (isPayment) {
            for (const value of Object.values(proof.statuses)) {
              assert(value.record.payment?.counterpartyJws);
              for (const jws of [
                value.record.payment.approvalJws,
                value.record.payment.counterpartyJws,
              ]) {
                assert(
                  !Buffer.from(block.serializeBinary()).includes(Buffer.from(jws)),
                  "Public block leaked payment signature",
                );
              }
            }
          }
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
                    "Third institution received private commercial data",
                  );
                  continue;
                }
                assert.equal(collection.getCollectionName(), domain.collection);
                for (const write of writes) {
                  if (proof.draft.kind === "commercial-payment") {
                    const key = `\u0000payment\u0000${proof.draft.domainId}\u0000${proof.draft.receiptId}\u0000`;
                    const head = `\u0000payment-head\u0000${proof.draft.domainId}\u0000${proof.draft.paymentId}\u0000`;
                    assert(!write.getIsDelete());
                    assert(
                      [key, head].includes(write.getKey()),
                      "Payment changed accounting or execution state",
                    );
                    const value = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    if (write.getKey() === key) {
                      assert.deepEqual(value.terms, proof.draft);
                      assert.equal(value.receipt.digest, receipt.digest);
                      assert.equal(value.receipt.recordId, proof.draft.receiptId);
                      const signed = proof.statuses.provider?.record.payment;
                      assert(signed);
                      assert.equal(signed.localSiteId, proof.draft.targetSiteId);
                      assert.deepEqual(value.envelope, {
                        sourceSiteId: proof.draft.sourceSiteId,
                        targetSiteId: proof.draft.targetSiteId,
                        sourceJws: signed.counterpartyJws,
                        targetJws: signed.approvalJws,
                      });
                      result.paymentWrites++;
                    } else {
                      assert.deepEqual(value, {
                        recordId: proof.draft.receiptId,
                        digest: receipt.digest,
                      });
                      result.headWrites++;
                    }
                    continue;
                  }
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
                  if (proof.draft.kind === "commercial-adjustment") {
                    if (
                      write.getKey() ===
                      `\u0000adjustment\u0000${proof.draft.domainId}\u0000${proof.draft.adjustmentId}\u0000`
                    ) {
                      const record = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                      assert.deepEqual(record.terms, proof.draft);
                      assert.equal(record.receipt.digest, receipt.digest);
                      result.adjustmentWrites++;
                    }
                    if (
                      write.getKey() ===
                      `\u0000adjustment-head\u0000${proof.draft.domainId}\u0000${proof.draft.settlementId}\u0000`
                    ) {
                      const head = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                      assert.deepEqual(head, {
                        adjustmentId: proof.draft.adjustmentId,
                        salt: proof.draft.salt,
                      });
                      result.headWrites++;
                    }
                    for (const prefix of ["settlement", "reservation", "bill"])
                      assert(
                        !write.getKey().startsWith(`\u0000${prefix}\u0000`),
                        "Adjustment rewrote an original record",
                      );
                  }
                  if (
                    proof.draft.kind === "commercial-settlement" &&
                    write.getKey() ===
                      `\u0000settlement\u0000${proof.draft.domainId}\u0000${proof.draft.settlementId}\u0000`
                  ) {
                    const record = JSON.parse(Buffer.from(write.getValue_asU8()).toString());
                    assert.deepEqual(record.terms, proof.draft);
                    assert.equal(record.receipt.digest, receipt.digest);
                    result.settlementWrites++;
                  }
                  if (
                    proof.draft.kind === "commercial-settlement" &&
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
                    "Commercial record changed execution gate",
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
    assert.equal(result.transactions.length, isPayment ? 1 : 2);
    assert.equal(
      result.budgetWrites,
      name === "C" || isPayment ? 0 : 1,
      "Only settlement/adjustment changes budget, never payment",
    );
    assert.equal(
      result.settlementWrites,
      name === "C" || isAdjustment || isPayment ? 0 : 2,
      "Only settlement transactions write the original settlement",
    );
    assert.equal(result.reservationWrites, name === "C" || isAdjustment || isPayment ? 0 : 1);
    assert.equal(result.adjustmentWrites, name !== "C" && isAdjustment ? 2 : 0);
    assert.equal(result.headWrites, name !== "C" && (isAdjustment || isPayment) ? 1 : 0);
    assert.equal(result.paymentWrites, name !== "C" && isPayment ? 1 : 0);
    results[name] = result;
  } finally {
    gateway.close();
    client.close();
  }
}
await writeFile(
  join(proof.evidenceDirectory, `${recordName}-private-ledger.json`),
  `${JSON.stringify(
    {
      ...(proof.draft.kind === "commercial-payment"
        ? {
            receiptId: proof.draft.receiptId,
            amount: proof.draft.amount,
          }
        : {
            settlementId: proof.draft.settlementId,
            chargedAmount: proof.draft.chargedAmount,
          }),
      recordName,
      adjustmentId: proof.draft.kind === "commercial-adjustment" ? proof.draft.adjustmentId : null,
      results,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  isPayment
    ? `REAL ${recordName.toUpperCase()} PDC PASSED: provider transaction VALID; only private receipt/head changed; no accounting/permit writes or third-party private data`
    : `REAL ${recordName.toUpperCase()} PDC PASSED: both platform transactions VALID; exactly one private budget change, immutable replay, unchanged terminal gate and no third-party private writes`,
);
