import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, EndorseError, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, msp, peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  FederationCancellationReceiptSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { calculateCommercialBill } from "@kuintessence/shared/federation/billing";
import {
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialPaymentSchema,
  CommercialReceiptSchema,
  CommercialRefundSchema,
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
  const initialProposal = proposal(
    a,
    "RegisterAgreement",
    terms.agreement.agreementRevisionId,
    envelope,
  );
  const disseminationDeadline = Date.now() + 45000;
  const endorsed = await (async () => {
    for (;;) {
      try {
        return await initialProposal.endorse();
      } catch (error) {
        // Read-only readiness does not establish the peer gossip required by PDC dissemination.
        if (
          !(error instanceof EndorseError) ||
          !error.details.length ||
          !error.details.every((detail) =>
            detail.message.includes(
              "required to disseminate to at least 1 peers, but know of only 0 eligible peers",
            ),
          ) ||
          Date.now() >= disseminationDeadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
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
  const billingTerms = CommercialAgreementSchema.parse({
    ...terms,
    agreement: {
      ...terms.agreement,
      mode: "bilateral_attested",
      agreementRevisionId: randomUUID(),
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
    },
    salt: randomBytes(32).toString("hex"),
  });
  const billingEnvelope = {
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    sourceJws: await signFederationMessage(CommercialAgreementSchema, billingTerms, sourceKey),
    targetJws: await signFederationMessage(CommercialAgreementSchema, billingTerms, targetKey),
  };
  const billingAgreement = await proposal(
    a,
    "RegisterAgreement",
    billingTerms.agreement.agreementRevisionId,
    billingEnvelope,
  ).endorse();
  assert.equal((await (await billingAgreement.submit()).getStatus()).successful, true);
  const billingReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(billingAgreement.getResult()).toString()),
  );
  const billingUsage = {
    ...report,
    reportId: randomUUID(),
    agreementRevisionId: billingReceipt.recordId,
    agreementDigest: billingReceipt.digest,
  };
  const billingUsageJws = await signFederationMessage(
    CommercialUsageSchema,
    billingUsage,
    targetKey,
  );
  const billingUsageTx = await proposal(b, "RecordUsage", billingUsage.reportId, {
    providerJws: billingUsageJws,
  }).endorse();
  assert.equal((await (await billingUsageTx.submit()).getStatus()).successful, true);
  const billingUsageReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(billingUsageTx.getResult()).toString()),
  );
  const request = FederationDelegationSchema.parse({
    protocolVersion: 1,
    kind: "delegation",
    operationId: randomUUID(),
    senderSiteId: sourceKey.siteId,
    recipientSiteId: targetKey.siteId,
    agreementRevisionId: billingReceipt.recordId,
    mode: "bilateral_attested",
    budgetDomainId: billingTerms.agreement.budgetDomainId,
    epoch: billingTerms.agreement.epoch,
    unit: billingTerms.agreement.unit,
    taskId: billingUsage.taskId,
    attempt: 1,
    issuedAt: billingUsage.periodStart,
    expiresAt: new Date(time + 60000).toISOString(),
    template: billingTerms.agreement.templates[0],
    resources: billingTerms.agreement.resourceLimit,
    maxAmount: "100",
    inputManifestDigest: `sha256:${randomBytes(32).toString("hex")}`,
    environmentLockDigest: `sha256:${randomBytes(32).toString("hex")}`,
  });
  const discountProbe = `PRIVATE-DISCOUNT-${randomUUID()}`;
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: billingReceipt.recordId,
    agreementDigest: billingReceipt.digest,
    reportId: billingUsage.reportId,
    reportDigest: billingUsageReceipt.digest,
    taskId: request.taskId,
    attempt: 1,
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    unit: request.unit,
    amount: "7",
    reason: discountProbe,
    issuedAt: new Date(time).toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const discountJws = await signFederationMessage(CommercialDiscountSchema, discount, targetKey);
  const discountTx = await proposal(b, "RecordDiscount", discount.discountId, {
    providerJws: discountJws,
  }).endorse();
  const discountStatus = await (await discountTx.submit()).getStatus();
  assert.equal(discountStatus.successful, true);
  const discountReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(discountTx.getResult()).toString()),
  );
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: discount.billId,
    domainId: domain.domainId,
    agreementDigest: billingReceipt.digest,
    priceVersionId: billingTerms.priceVersionId,
    reportId: billingUsage.reportId,
    reportDigest: billingUsageReceipt.digest,
    request,
    reservationId: null,
    discount: { discountId: discount.discountId, digest: discountReceipt.digest },
    calculation: calculateCommercialBill(billingTerms, request, billingUsage, discount.amount),
    issuedAt: discount.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  assert.equal(bill.calculation.dueAmount, "93");
  const billEnvelope = {
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    sourceJws: await signFederationMessage(CommercialBillSchema, bill, sourceKey),
    targetJws: await signFederationMessage(CommercialBillSchema, bill, targetKey),
  };
  await assert.rejects(
    proposal(a, "ConfirmBill", bill.billId, {
      ...billEnvelope,
      targetJws: billEnvelope.sourceJws,
    }).endorse(),
    chainRejection("INVALID_MESSAGE"),
  );
  const billTx = await proposal(a, "ConfirmBill", bill.billId, billEnvelope).endorse();
  const competingBill = {
    ...bill,
    billId: randomUUID(),
    discount: null,
    calculation: calculateCommercialBill(billingTerms, request, billingUsage),
  };
  const competingBillTx = await proposal(b, "ConfirmBill", competingBill.billId, {
    ...billEnvelope,
    sourceJws: await signFederationMessage(CommercialBillSchema, competingBill, sourceKey),
    targetJws: await signFederationMessage(CommercialBillSchema, competingBill, targetKey),
  }).endorse();
  const billStatus = await (await billTx.submit()).getStatus();
  assert.equal(billStatus.successful, true);
  const competingBillStatus = await (await competingBillTx.submit()).getStatus();
  assert.equal(competingBillStatus.successful, false);
  assert.equal(competingBillStatus.code, 11);
  passed.push(
    "native MVCC allows only one of two concurrently endorsed initial bills for the same task",
  );
  const billReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(billTx.getResult()).toString()),
  );
  const billReplay = await proposal(b, "ConfirmBill", bill.billId, billEnvelope).endorse();
  assert.deepEqual(JSON.parse(Buffer.from(billReplay.getResult()).toString()), billReceipt);
  assert.equal((await (await billReplay.submit()).getStatus()).successful, true);
  const replacement = { ...bill, billId: randomUUID() };
  await assert.rejects(
    proposal(a, "ConfirmBill", replacement.billId, {
      ...billEnvelope,
      sourceJws: await signFederationMessage(CommercialBillSchema, replacement, sourceKey),
      targetJws: await signFederationMessage(CommercialBillSchema, replacement, targetKey),
    }).endorse(),
    chainRejection("OPERATION_CONFLICT"),
  );
  const paymentProbe = `PRIVATE-PAYMENT-${randomUUID()}`;
  const payment = CommercialPaymentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-payment",
    receiptId: randomUUID(),
    paymentId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: bill.request.agreementRevisionId,
    agreementDigest: billingReceipt.digest,
    billId: bill.billId,
    billDigest: billReceipt.digest,
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    amount: "41",
    unit: bill.request.unit,
    occurredAt: bill.issuedAt,
    issuedAt: bill.issuedAt,
    evidenceDigest: `sha256:${randomBytes(32).toString("hex")}`,
    previous: null,
    reason: paymentProbe,
    salt: randomBytes(32).toString("hex"),
  });
  const paymentEnvelope = async (value: z.infer<typeof CommercialPaymentSchema>) => ({
    sourceSiteId: sourceKey.siteId,
    targetSiteId: targetKey.siteId,
    sourceJws: await signFederationMessage(CommercialPaymentSchema, value, sourceKey),
    targetJws: await signFederationMessage(CommercialPaymentSchema, value, targetKey),
  });
  const paymentSigned = await paymentEnvelope(payment);
  const adapterPayment = CommercialPaymentSchema.parse({
    ...payment,
    paymentId: randomUUID(),
    receiptId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
  });
  await writeFile(
    join(dirname(process.argv[2] ?? ""), "commercial-payment-proposal.json"),
    JSON.stringify({
      operation: "record-payment",
      domainId: adapterPayment.domainId,
      recordId: adapterPayment.receiptId,
      digest: `sha256:${createHash("sha256").update(JSON.stringify(adapterPayment)).digest("hex")}`,
      envelope: await paymentEnvelope(adapterPayment),
    }),
    { mode: 0o600 },
  );

  await assert.rejects(
    proposal(a, "RecordPayment", payment.receiptId, {
      ...paymentSigned,
      targetJws: paymentSigned.sourceJws,
    }).endorse(),
    chainRejection("INVALID_MESSAGE"),
  );
  const paymentTx = await proposal(a, "RecordPayment", payment.receiptId, paymentSigned).endorse();
  const paymentStatus = await (await paymentTx.submit()).getStatus();
  assert(paymentStatus.successful);
  const paymentReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(paymentTx.getResult()).toString()),
  );
  const correction = CommercialPaymentSchema.parse({
    ...payment,
    receiptId: randomUUID(),
    amount: "0",
    previous: { receiptId: paymentReceipt.recordId, digest: paymentReceipt.digest },
    salt: randomBytes(32).toString("hex"),
  });
  const correctionSigned = await paymentEnvelope(correction);
  const competingPayment = {
    ...correction,
    receiptId: randomUUID(),
    amount: "40",
    salt: randomBytes(32).toString("hex"),
  };
  const paymentCorrections = await Promise.all([
    proposal(a, "RecordPayment", correction.receiptId, correctionSigned).endorse(),
    proposal(
      b,
      "RecordPayment",
      competingPayment.receiptId,
      await paymentEnvelope(competingPayment),
    ).endorse(),
  ]);
  assert(paymentCorrections[0] && paymentCorrections[1]);
  const paymentCorrectionStatus = await (await paymentCorrections[0].submit()).getStatus();
  const paymentLostStatus = await (await paymentCorrections[1].submit()).getStatus();
  assert(paymentCorrectionStatus.successful);
  assert.equal(paymentLostStatus.successful, false);
  assert.equal(paymentLostStatus.code, 11);
  const paymentReplay = await proposal(
    b,
    "RecordPayment",
    payment.receiptId,
    paymentSigned,
  ).endorse();
  assert.deepEqual(JSON.parse(Buffer.from(paymentReplay.getResult()).toString()), paymentReceipt);
  assert((await (await paymentReplay.submit()).getStatus()).successful);
  await assert.rejects(
    proposal(
      a,
      "RecordPayment",
      competingPayment.receiptId,
      await paymentEnvelope(competingPayment),
    ).endorse(),
    chainRejection("OPERATION_CONFLICT"),
  );
  passed.push(
    "external payment receipt and correction commit privately; concurrent corrections have one VALID and one MVCC INVALID; old replay does not reset the head",
  );
  const refundProbe = `REFUND-${randomUUID()}`;
  let refundBlock: bigint | undefined;
  let refundRecordId = "";
  const refundProbes: string[] = [refundProbe];
  for (const refundFirst of [true, false]) {
    const refundRequest = { ...request, operationId: randomUUID(), taskId: randomUUID() };
    const cancellation = FederationCancellationReceiptSchema.parse({
      protocolVersion: 1,
      kind: "cancellation-receipt",
      operationId: refundRequest.operationId,
      senderSiteId: targetKey.siteId,
      recipientSiteId: sourceKey.siteId,
      agreementRevisionId: refundRequest.agreementRevisionId,
      taskId: refundRequest.taskId,
      attempt: 1,
      requestDigest: `sha256:${randomBytes(32).toString("hex")}`,
      cancellationDigest: `sha256:${randomBytes(32).toString("hex")}`,
      recordedAt: new Date(time).toISOString(),
      observedAt: new Date(time).toISOString(),
      reservationId: randomUUID(),
      state: "stopped",
      workflow: null,
    });
    const refund = CommercialRefundSchema.parse({
      protocolVersion: 1,
      kind: "commercial-refund",
      refundId: randomUUID(),
      domainId: domain.domainId,
      agreementDigest: billingReceipt.digest,
      request: refundRequest,
      requestDigest: cancellation.requestDigest,
      cancellationReceiptJws: await signFederationMessage(
        FederationCancellationReceiptSchema,
        cancellation,
        targetKey,
      ),
      releasedAmount: refundRequest.maxAmount,
      issuedAt: new Date(time).toISOString(),
      salt: randomBytes(32).toString("hex"),
      reason: refundProbe,
    });
    const refundEnvelope = {
      sourceSiteId: sourceKey.siteId,
      targetSiteId: targetKey.siteId,
      sourceJws: await signFederationMessage(CommercialRefundSchema, refund, sourceKey),
      targetJws: await signFederationMessage(CommercialRefundSchema, refund, targetKey),
    };
    const conflictingUsage = {
      ...billingUsage,
      reportId: randomUUID(),
      taskId: refundRequest.taskId,
    };
    const refundTx = await proposal(b, "RecordRefund", refund.refundId, refundEnvelope).endorse();
    const usageTx = await proposal(b, "RecordUsage", conflictingUsage.reportId, {
      providerJws: await signFederationMessage(CommercialUsageSchema, conflictingUsage, targetKey),
    }).endorse();
    const first = await (await (refundFirst ? refundTx : usageTx).submit()).getStatus();
    const second = await (await (refundFirst ? usageTx : refundTx).submit()).getStatus();
    assert.equal(first.successful, true);
    assert.equal(second.successful, false);
    assert.equal(second.code, 11);
    if (refundFirst) {
      refundBlock = first.blockNumber;
      refundRecordId = refund.refundId;
      refundProbes.push(
        refundEnvelope.sourceJws,
        refundEnvelope.targetJws,
        refund.cancellationReceiptJws,
        refund.salt,
      );
      const replay = await proposal(a, "RecordRefund", refund.refundId, refundEnvelope).endorse();
      assert.deepEqual(
        JSON.parse(Buffer.from(replay.getResult()).toString()),
        JSON.parse(Buffer.from(refundTx.getResult()).toString()),
      );
      assert.equal((await (await replay.submit()).getStatus()).successful, true);
      const duplicate = { ...refund, refundId: randomUUID() };
      await assert.rejects(
        proposal(b, "RecordRefund", duplicate.refundId, {
          ...refundEnvelope,
          sourceJws: await signFederationMessage(CommercialRefundSchema, duplicate, sourceKey),
          targetJws: await signFederationMessage(CommercialRefundSchema, duplicate, targetKey),
        }).endorse(),
        chainRejection("OPERATION_CONFLICT"),
      );
    }
  }
  assert(refundBlock !== undefined);
  passed.push(
    "native MVCC excludes refund and first usage in both commit orders; immutable refund replays and duplicate IDs cannot release twice",
  );
  for (const [recordType, recordId] of [
    ["bill", bill.billId],
    ["discount", discount.discountId],
    ["refund", refundRecordId],
    ["payment", payment.receiptId],
  ] as const)
    await assert.rejects(
      contract(c)
        .newProposal("GetRecordReceipt", {
          arguments: [domain.domainId, recordType, recordId],
          endorsingOrganizations: ["CMSP"],
        })
        .endorse(),
      chainRejection("POLICY_DENIED"),
    );
  passed.push(
    "real PDC discount and dual-signed bill commit VALID; exact capped amount, replay, duplicate and nonmember rejection verified",
  );
  await writeFile(
    join(dirname(z.string().parse(process.argv[3])), "commercial-billing.json"),
    JSON.stringify({
      billId: bill.billId,
      discountId: discount.discountId,
      discount: {
        transactionId: discountStatus.transactionId,
        blockNumber: String(discountStatus.blockNumber),
      },
      bill: {
        transactionId: billStatus.transactionId,
        blockNumber: String(billStatus.blockNumber),
      },
      calculation: bill.calculation,
      receipt: billReceipt,
    }),
    { mode: 0o600 },
  );
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
  await writeFile(
    join(dirname(z.string().parse(process.argv[3])), "commercial-proposal.json"),
    JSON.stringify({
      operation: "register-agreement",
      domainId: domain.domainId,
      recordId: receipt.recordId,
      digest: receipt.digest,
      envelope,
    }),
    { mode: 0o600 },
  );
  const probes = [
    ...refundProbes,
    paymentProbe,
    paymentSigned.sourceJws,
    paymentSigned.targetJws,
    correctionSigned.sourceJws,
    correctionSigned.targetJws,
    payment.salt,
    correction.salt,
    contractProbe,
    priceProbe,
    usageProbe,
    envelope.sourceJws,
    envelope.targetJws,
    providerJws,
    discountProbe,
    discountJws,
    billEnvelope.sourceJws,
    billEnvelope.targetJws,
  ];
  for (const blockNumber of [
    invalid.blockNumber,
    valid.blockNumber,
    recordedStatus.blockNumber,
    won.blockNumber,
    lost.blockNumber,
    discountStatus.blockNumber,
    billStatus.blockNumber,
    refundBlock,
    paymentStatus.blockNumber,
    paymentCorrectionStatus.blockNumber,
    paymentLostStatus.blockNumber,
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
                  ).getWritesList()) {
                    if (
                      blockNumber === paymentStatus.blockNumber ||
                      blockNumber === paymentCorrectionStatus.blockNumber
                    )
                      assert(
                        ["payment", "payment-head"].includes(
                          write.getKey().split("\u0000")[1] ?? "",
                        ),
                        "Payment evidence must not modify balances, bills, or execution state",
                      );
                    if (blockNumber === refundBlock)
                      assert(
                        ["refund", "refund-head", "refund-operation"].includes(
                          write.getKey().split("\u0000")[1] ?? "",
                        ),
                        "Refund must not write a budget, gate or original usage",
                      );
                    writes.push(Buffer.from(write.getValue_asU8()));
                  }
          if (!expected) assert.equal(writes.length, 0);
          else if (
            blockNumber !== invalid.blockNumber &&
            blockNumber !== lost.blockNumber &&
            blockNumber !== paymentLostStatus.blockNumber
          ) {
            assert.equal(
              writes.length,
              blockNumber === valid.blockNumber || blockNumber === discountStatus.blockNumber
                ? 1
                : blockNumber === refundBlock
                  ? 3
                  : 2,
            );
            assert(
              writes.some((bytes) =>
                bytes.includes(
                  Buffer.from(
                    blockNumber === paymentStatus.blockNumber ||
                      blockNumber === paymentCorrectionStatus.blockNumber
                      ? paymentProbe
                      : blockNumber === valid.blockNumber
                        ? contractProbe
                        : blockNumber === discountStatus.blockNumber
                          ? discountProbe
                          : blockNumber === refundBlock
                            ? refundProbe
                            : usageProbe,
                  ),
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
    `Commercial probe failed after ${passed.length} checks: ${error instanceof Error ? error.name : "Error"}${error instanceof Error && error.name === "AssertionError" ? ` (${error.message})` : ""}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const { gateway, client } of connections) {
    gateway.close();
    client.close();
  }
}
