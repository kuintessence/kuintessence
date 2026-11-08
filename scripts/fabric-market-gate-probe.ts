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
import { connect, EndorseError, signers, type Transaction } from "@hyperledger/fabric-gateway";
import { common, ledger, msp, peer, gateway as proto } from "@hyperledger/fabric-protos";
import { calculateCommercialBill } from "@kuintessence/shared/federation/billing";
import {
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialReceiptSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  MarketActivationSchema,
  MarketClosureSchema,
  MarketDemandSchema,
  MarketDemandStateSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
  MarketExecutionStopSchema,
} from "@kuintessence/shared/federation/market";
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
const passed: string[] = [],
  probes: string[] = [];
const blocks = new Set<bigint>();
const site = (name: string) => Site.parse(network.sites.find((value) => value.name === name));
async function connection(name: string, market = false, endpointName = name) {
  const member = site(name),
    endpoint = site(endpointName);
  const user = market ? "User2" : "User1",
    domain = `${name.toLowerCase()}.kq.test`;
  const mspDir = join(dirname(dirname(member.userMsp)), `${user}@${domain}`, "msp");
  const keyNames = await readdir(join(mspDir, "keystore"));
  assert(keyNames.length === 1 && keyNames[0]);
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
    identity: {
      mspId: `${name}MSP`,
      credentials: await readFile(join(mspDir, "signcerts", `${user}@${domain}-cert.pem`)),
    },
    signer: signers.newPrivateKeySigner(
      createPrivateKey(await readFile(join(mspDir, "keystore", keyNames[0]))),
    ),
    tlsClientCertificateHash: createHash("sha256").update(new X509Certificate(tls).raw).digest(),
    endorseOptions: () => ({ deadline: Date.now() + 10000 }),
    submitOptions: () => ({ deadline: Date.now() + 10000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 15000 }),
    evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
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
  const [a, b, c, am, bm, cm] = await Promise.all([
    connection("A"),
    connection("B"),
    connection("C"),
    connection("A", true),
    connection("B", true),
    connection("C", true),
  ]);
  const domain = network.trust.domains[0];
  assert(domain);
  const signersBySite = await Promise.all(
    ["A", "B"].map(async (name) => ({
      siteId: site(name).siteId,
      keyId: "batch-1",
      privateKey: await importPKCS8(await readFile(site(name).businessKeyFile, "utf8"), "RS256"),
    })),
  );
  const source = signersBySite[0],
    target = signersBySite[1];
  assert(source && target);
  const bilateral = async <T>(schema: z.ZodType<T>, value: T) => ({
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    sourceJws: await signFederationMessage(schema, value, source),
    targetJws: await signFederationMessage(schema, value, target),
  });
  const commercial = (
    gateway: ReturnType<typeof connect>,
    name: string,
    recordId: string,
    input?: unknown,
    msps = ["AMSP", "BMSP"],
  ) =>
    gateway
      .getNetwork(network.channel)
      .getContract("kq-commercial")
      .newProposal(name, {
        arguments: [domain.domainId, recordId],
        endorsingOrganizations: msps,
        ...(input ? { transientData: { commercial: JSON.stringify(input) } } : {}),
      });
  const market = (
    gateway: ReturnType<typeof connect>,
    name: string,
    demandId: string,
    input?: unknown,
    msps = ["AMSP", "BMSP"],
  ) =>
    gateway
      .getNetwork(network.channel)
      .getContract("kq-market")
      .newProposal(name, {
        arguments: [demandId],
        endorsingOrganizations: msps,
        ...(input ? { transientData: { market: JSON.stringify(input) } } : {}),
      });
  const commit = async (tx: Transaction) => {
    const status = await (await tx.submit()).getStatus();
    blocks.add(status.blockNumber);
    return status;
  };
  const retryRead = async (read: () => Promise<boolean>) => {
    const deadline = Date.now() + 45000;
    for (;;) {
      if (await read()) return;
      assert(Date.now() < deadline, "Committed cross-chaincode state must reach all peers");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };
  await retryRead(async () => {
    for (const gateway of [am, bm, cm]) {
      for (const name of ["AMSP", "BMSP", "CMSP"]) {
        try {
          await market(gateway, "GetDemand", randomUUID(), undefined, [name]).endorse();
          return false;
        } catch (error) {
          if (!rejected("ASSET_UNAVAILABLE")(error)) return false;
        }
      }
    }
    for (const gateway of [a, b]) {
      try {
        await commercial(gateway, "GetAgreementReceipt", randomUUID()).endorse();
        return false;
      } catch (error) {
        if (!rejected("ASSET_UNAVAILABLE")(error)) return false;
      }
    }
    return true;
  });
  const amount = "9007199254740993",
    contractProbe = `PRIVATE-GATE-${randomUUID()}`;
  probes.push(amount, contractProbe);
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
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      mode: "ledger_coordinated",
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      unit: "credit.micro",
      budgetLimit: (BigInt(amount) * 2n).toString(),
      maxTaskAmount: amount,
      maxReservations: 3,
      validFrom: new Date(time - 60000).toISOString(),
      validUntil: new Date(time + 3600000).toISOString(),
      templates: [
        {
          originSiteId: source.siteId,
          kind: "script",
          id: randomUUID(),
          revision: "v1",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 30 },
      termsDigest: `sha256:${"b".repeat(64)}`,
    },
    consideration: "exchange",
    priceVersionId: randomUUID(),
    prices: [{ metric: "cpu.time", quantityUnit: "cpu-millisecond", perQuantity: "1000", amount }],
    termsText: contractProbe,
  });
  const envelope = await bilateral(CommercialAgreementSchema, terms);
  probes.push(envelope.sourceJws, envelope.targetJws);
  let registration: Transaction | undefined;
  await retryRead(async () => {
    try {
      registration = await commercial(
        a,
        "RegisterAgreement",
        terms.agreement.agreementRevisionId,
        envelope,
      ).endorse();
      return true;
    } catch (error) {
      if (
        !(error instanceof EndorseError) ||
        !error.details.length ||
        !error.details.every((detail) =>
          detail.message.includes(
            "required to disseminate to at least 1 peers, but know of only 0 eligible peers",
          ),
        )
      )
        throw error;
      return false;
    }
  });
  assert(registration);
  const agreementReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(registration.getResult()).toString()),
  );
  assert.equal((await commit(registration)).successful, true);
  await retryRead(async () => {
    try {
      await commercial(b, "GetAgreementReceipt", agreementReceipt.recordId).endorse();
      return true;
    } catch (error) {
      if (!rejected("ASSET_UNAVAILABLE")(error) && !rejected("DATA_WAITING")(error)) throw error;
      return false;
    }
  });
  const current = async (demandId: string, gateway = am, name = "AMSP") =>
    MarketDemandStateSchema.parse(
      JSON.parse(
        Buffer.from(
          (await market(gateway, "GetDemand", demandId, undefined, [name]).endorse()).getResult(),
        ).toString(),
      ),
    );
  const synced = (demandId: string, status: string) =>
    retryRead(async () => {
      try {
        const values = await Promise.all(
          [
            [am, "AMSP"],
            [bm, "BMSP"],
            [cm, "CMSP"],
          ].map(async ([gateway, name]) => {
            assert(typeof gateway !== "string" && typeof name === "string" && gateway);
            return current(demandId, gateway, name);
          }),
        );
        return values.every((value) => value.status === status);
      } catch (error) {
        if (!(error instanceof EndorseError)) throw error;
        return false;
      }
    });
  const claimed = async (
    maxAmount = amount,
    selected = terms,
    selectedReceipt = agreementReceipt,
  ) => {
    const demand = MarketDemandSchema.parse({
      protocolVersion: 1,
      demandId: randomUUID(),
      sourceSiteId: source.siteId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(time + 1800000).toISOString(),
      title: "Approved public task",
      description: "",
      platform: "linux",
      architecture: "x86_64",
      resources: selected.agreement.resourceLimit,
    });
    assert.equal(
      (await commit(await market(am, "PublishDemand", demand.demandId, demand).endorse()))
        .successful,
      true,
    );
    await synced(demand.demandId, "OPEN");
    const claim = {
      demandId: demand.demandId,
      claimId: randomUUID(),
      providerSiteId: target.siteId,
      commercialDomainId: domain.domainId,
      expectedVersion: 1,
      expiresAt: new Date(time + 900000).toISOString(),
    };
    assert.equal(
      (await commit(await market(bm, "ClaimDemand", demand.demandId, claim).endorse())).successful,
      true,
    );
    await synced(demand.demandId, "CLAIMED");
    const reservation = CommercialReservationSchema.parse({
      protocolVersion: 1,
      kind: "commercial-reservation",
      domainId: domain.domainId,
      reservationId: claim.claimId,
      demandId: demand.demandId,
      claimVersion: 2,
      agreementDigest: selectedReceipt.digest,
      salt: randomBytes(32).toString("hex"),
      request: {
        protocolVersion: 1,
        kind: "delegation",
        operationId: randomUUID(),
        senderSiteId: source.siteId,
        recipientSiteId: target.siteId,
        agreementRevisionId: selectedReceipt.recordId,
        mode: "ledger_coordinated",
        budgetDomainId: selected.agreement.budgetDomainId,
        epoch: selected.agreement.epoch,
        unit: selected.agreement.unit,
        taskId: randomUUID(),
        attempt: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(time + 600000).toISOString(),
        executionExpiresAt: new Date(time + 1200000).toISOString(),
        template: selected.agreement.templates[0],
        resources: demand.resources,
        maxAmount,
        inputManifestDigest: `sha256:${"c".repeat(64)}`,
        environmentLockDigest: `sha256:${"d".repeat(64)}`,
      },
    });
    const signed = await bilateral(CommercialReservationSchema, reservation);
    probes.push(signed.sourceJws, signed.targetJws);
    return { demand, reservation, signed };
  };
  const hash = async (reservationId: string, gateway = c) =>
    z
      .object({ hash: z.string() })
      .parse(
        JSON.parse(
          Buffer.from(
            await gateway
              .getNetwork(network.channel)
              .getContract("kq-commercial")
              .evaluateTransaction("GetExecutionGateHash", domain.domainId, reservationId),
          ).toString(),
        ),
      ).hash;
  const lock = async (f: Awaited<ReturnType<typeof claimed>>) => {
    const tx = await commercial(
      a,
      "ReserveExecution",
      f.reservation.reservationId,
      f.signed,
    ).endorse();
    const receipt = CommercialReceiptSchema.parse(
      JSON.parse(Buffer.from(tx.getResult()).toString()),
    );
    assert.equal((await commit(tx)).successful, true);
    const gate = MarketExecutionGateSchema.parse({
      domainId: domain.domainId,
      reservationId: f.reservation.reservationId,
      demandId: f.demand.demandId,
      claimVersion: 2,
      version: 1,
      state: "READY",
      reservationDigest: receipt.digest,
      expiresAt: f.reservation.request.expiresAt,
    });
    const expectedHash = createHash("sha256").update(JSON.stringify(gate)).digest("hex");
    await retryRead(async () => {
      try {
        return (
          await Promise.all([a, b, c].map((gateway) => hash(gate.reservationId, gateway)))
        ).every((value) => value === expectedHash);
      } catch {
        return false;
      }
    });
    return { ...f, receipt, gate };
  };
  const activation = (f: Awaited<ReturnType<typeof lock>>) =>
    MarketActivationSchema.parse({
      demandId: f.demand.demandId,
      activationId: randomUUID(),
      expectedVersion: 2,
      gate: f.gate,
    });
  const release = async (f: Awaited<ReturnType<typeof lock>>) => {
    const value = CommercialReleaseSchema.parse({
      protocolVersion: 1,
      kind: "commercial-release",
      domainId: domain.domainId,
      releaseId: randomUUID(),
      reservationId: f.reservation.reservationId,
      reservationDigest: f.receipt.digest,
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      expectedGateVersion: 1,
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
      reason: "Withdraw before activation",
    });
    const signed = await bilateral(CommercialReleaseSchema, value);
    probes.push(signed.sourceJws, signed.targetJws);
    return { value, signed };
  };
  const first = await claimed();
  const endorsed = await commercial(
    a,
    "ReserveExecution",
    first.reservation.reservationId,
    first.signed,
  ).endorse();
  const prepared = proto.PreparedTransaction.deserializeBinary(endorsed.getBytes());
  const outer = prepared.getEnvelope();
  assert(outer);
  const payload = common.Payload.deserializeBinary(outer.getPayload_asU8()),
    transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
  for (const action of transaction.getActionsList()) {
    const body = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8()),
      evidence = body.getAction();
    assert(evidence);
    const remaining = evidence
      .getEndorsementsList()
      .filter(
        (entry) =>
          msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid() === "AMSP",
      );
    assert.equal(remaining.length, 1);
    evidence.setEndorsementsList(remaining);
    action.setPayload(body.serializeBinary());
  }
  payload.setData(transaction.serializeBinary());
  outer.setPayload(payload.serializeBinary());
  const invalid = await commit(a.newTransaction(prepared.serializeBinary()));
  assert.equal(invalid.code, peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE);
  passed.push("private budget reservation missing B endorsement is INVALID");
  const one = await lock(first),
    cancel = await release(one),
    activate = activation(one);
  const [activeTx, releaseTx] = await Promise.all([
    market(am, "ActivateDemand", one.demand.demandId, activate, ["AMSP", "CMSP"]).endorse(),
    commercial(a, "ReleaseExecution", cancel.value.releaseId, cancel.signed).endorse(),
  ]);
  assert.equal((await commit(releaseTx)).successful, true);
  assert.equal((await commit(activeTx)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await retryRead(
    async () =>
      (await hash(one.gate.reservationId)) !==
      createHash("sha256").update(JSON.stringify(one.gate)).digest("hex"),
  );
  await assert.rejects(
    market(am, "ActivateDemand", one.demand.demandId, activate).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  const replay = await commercial(
    a,
    "ReserveExecution",
    one.reservation.reservationId,
    one.signed,
  ).endorse();
  assert.deepEqual(JSON.parse(Buffer.from(replay.getResult()).toString()), one.receipt);
  assert.equal((await commit(replay)).successful, true);
  assert.equal(
    (
      await commit(
        await commercial(a, "ReleaseExecution", cancel.value.releaseId, cancel.signed).endorse(),
      )
    ).successful,
    true,
  );
  assert.equal((await current(one.demand.demandId)).status, "CLAIMED");
  passed.push(
    "release commits first: cross-chaincode hashed read invalidates activation and old gate cannot reactivate",
  );
  const two = await lock(await claimed()),
    cancelTwo = await release(two);
  const [winner, loser] = await Promise.all([
    market(am, "ActivateDemand", two.demand.demandId, activation(two), ["AMSP", "CMSP"]).endorse(),
    commercial(a, "ReleaseExecution", cancelTwo.value.releaseId, cancelTwo.signed).endorse(),
  ]);
  assert.equal((await commit(winner)).successful, true);
  assert.equal((await commit(loser)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await synced(two.demand.demandId, "ACTIVE");
  await assert.rejects(
    commercial(a, "ReleaseExecution", cancelTwo.value.releaseId, cancelTwo.signed).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  passed.push(
    "activation commits first: cross-chaincode public read invalidates release and ACTIVE funds remain locked",
  );

  const active = await current(two.demand.demandId);
  assert(active.activation);
  const confirmationTime = Date.now();
  const confirmation = MarketExecutionAuthorizationSchema.parse({
    demandId: two.demand.demandId,
    authorizationId: randomUUID(),
    issuerSiteId: source.siteId,
    activationId: active.activation.activationId,
    gate: active.activation.gate,
    issuedAt: new Date(confirmationTime - 2).toISOString(),
    expiresAt: new Date(confirmationTime + 299000).toISOString(),
  });
  await assert.rejects(
    market(cm, "AuthorizeExecution", two.demand.demandId, {
      ...confirmation,
      issuerSiteId: site("C").siteId,
    }).endorse(),
    rejected("POLICY_DENIED"),
  );
  const renewal = {
    ...confirmation,
    authorizationId: randomUUID(),
    issuedAt: new Date(confirmationTime - 1).toISOString(),
  };
  const [confirmationTx, staleConfirmationTx] = await Promise.all([
    market(am, "AuthorizeExecution", two.demand.demandId, confirmation, ["AMSP", "CMSP"]).endorse(),
    market(am, "AuthorizeExecution", two.demand.demandId, renewal, ["AMSP", "CMSP"]).endorse(),
  ]);
  const confirmedEnvelope = proto.PreparedTransaction.deserializeBinary(
    confirmationTx.getBytes(),
  ).getEnvelope();
  assert(confirmedEnvelope);
  const confirmedActions = peer.Transaction.deserializeBinary(
    common.Payload.deserializeBinary(confirmedEnvelope.getPayload_asU8()).getData_asU8(),
  ).getActionsList();
  let publicRead = false,
    privateHashRead = false;
  for (const action of confirmedActions) {
    const endorsedAction = peer.ChaincodeActionPayload.deserializeBinary(
      action.getPayload_asU8(),
    ).getAction();
    assert(endorsedAction);
    const response = peer.ProposalResponsePayload.deserializeBinary(
      endorsedAction.getProposalResponsePayload_asU8(),
    );
    const execution = peer.ChaincodeAction.deserializeBinary(response.getExtension_asU8());
    for (const ns of ledger.rwset.TxReadWriteSet.deserializeBinary(
      execution.getResults_asU8(),
    ).getNsRwsetList()) {
      if (ns.getNamespace() === "kq-market")
        publicRead ||= ledger.rwset.kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8())
          .getReadsList()
          .some((read) => read.getKey() === `\u0000demand\u0000${two.demand.demandId}\u0000`);
      if (ns.getNamespace() === "kq-commercial")
        privateHashRead ||= ns
          .getCollectionHashedRwsetList()
          .some(
            (collection) =>
              ledger.rwset.kvrwset.HashedRWSet.deserializeBinary(
                collection.getHashedRwset_asU8(),
              ).getHashedReadsList().length > 0,
          );
    }
  }
  assert(
    publicRead && privateHashRead,
    "Execution confirmation must bind ACTIVE and the private gate in its native read set",
  );
  assert.equal((await commit(confirmationTx)).successful, true);
  assert.equal((await commit(staleConfirmationTx)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  assert.equal(
    (
      await commit(
        await market(bm, "AuthorizeExecution", two.demand.demandId, {
          ...renewal,
          issuerSiteId: target.siteId,
        }).endorse(),
      )
    ).successful,
    true,
  );
  passed.push(
    "execution confirmations require a participant, bind native ACTIVE/private-hash reads and reject a stale concurrent renewal by MVCC",
  );

  const stop = MarketExecutionStopSchema.parse({
    demandId: two.demand.demandId,
    stopId: randomUUID(),
    issuerSiteId: source.siteId,
    activationId: active.activation.activationId,
    expectedVersion: active.version,
  });
  await assert.rejects(
    market(cm, "RequestExecutionStop", two.demand.demandId, {
      ...stop,
      issuerSiteId: site("C").siteId,
    }).endorse(),
    rejected("POLICY_DENIED"),
  );
  const oldGateHash = await hash(two.reservation.reservationId);
  const renewedAt = Date.now();
  const [stopping, obsoleteRenewal] = await Promise.all([
    market(am, "RequestExecutionStop", two.demand.demandId, stop, ["AMSP", "CMSP"]).endorse(),
    market(
      bm,
      "AuthorizeExecution",
      two.demand.demandId,
      {
        ...confirmation,
        issuerSiteId: target.siteId,
        authorizationId: randomUUID(),
        issuedAt: new Date(renewedAt).toISOString(),
        expiresAt: new Date(renewedAt + 299000).toISOString(),
      },
      ["AMSP", "CMSP"],
    ).endorse(),
  ]);
  assert.equal((await commit(stopping)).successful, true);
  assert.equal((await commit(obsoleteRenewal)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await synced(two.demand.demandId, "STOPPING");
  const stoppedState = await current(two.demand.demandId);
  assert.deepEqual(stoppedState.stopRequest, stop);
  assert.equal(stoppedState.version, active.version + 1);
  assert.equal(
    (await commit(await market(am, "RequestExecutionStop", two.demand.demandId, stop).endorse()))
      .successful,
    true,
  );
  const otherStop = { ...stop, stopId: randomUUID(), issuerSiteId: target.siteId };
  assert.equal(
    (
      await commit(
        await market(bm, "RequestExecutionStop", two.demand.demandId, otherStop).endorse(),
      )
    ).successful,
    true,
  );
  assert.deepEqual(await current(two.demand.demandId), stoppedState);
  await assert.rejects(
    market(bm, "AuthorizeExecution", two.demand.demandId, {
      ...confirmation,
      issuerSiteId: target.siteId,
    }).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  await assert.rejects(
    commercial(a, "ReleaseExecution", cancelTwo.value.releaseId, cancelTwo.signed).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  assert.deepEqual(await hash(two.reservation.reservationId), oldGateHash);
  passed.push(
    "stop commits first: native MVCC invalidates an endorsed renewal; both participants converge on STOPPING without releasing private funds or reopening the demand",
  );

  const contenders = [await claimed(), await claimed()];
  const proposed = await Promise.all(
    contenders.map((f) =>
      commercial(a, "ReserveExecution", f.reservation.reservationId, f.signed).endorse(),
    ),
  );
  assert(proposed[0] && proposed[1] && contenders[0] && contenders[1]);
  assert.equal((await commit(proposed[0])).successful, true);
  assert.equal((await commit(proposed[1])).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  const funded = contenders[0],
    unfunded = contenders[1];
  await retryRead(async () => {
    try {
      await Promise.all(
        [a, b, c].map((gateway) => hash(funded.reservation.reservationId, gateway)),
      );
      return true;
    } catch {
      return false;
    }
  });
  await assert.rejects(
    commercial(
      a,
      "ReserveExecution",
      unfunded.reservation.reservationId,
      unfunded.signed,
    ).endorse(),
    rejected("BUDGET_EXHAUSTED"),
  );
  passed.push(
    "concurrent private reservations cannot overspend one shared budget; loser stays unfunded",
  );
  const fundedReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(proposed[0].getResult()).toString()),
  );
  const reusedRelease = {
    ...cancel.value,
    reservationId: funded.reservation.reservationId,
    reservationDigest: fundedReceipt.digest,
  };
  await assert.rejects(
    commercial(
      a,
      "ReleaseExecution",
      reusedRelease.releaseId,
      await bilateral(CommercialReleaseSchema, reusedRelease),
    ).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  // A zero-cap fixture still occupies a reservation slot; terminal evidence must not free that slot.
  const terminalTask = await lock(await claimed("0"));
  const terminalActivation = activation(terminalTask);
  assert.equal(
    (
      await commit(
        await market(
          am,
          "ActivateDemand",
          terminalTask.demand.demandId,
          terminalActivation,
        ).endorse(),
      )
    ).successful,
    true,
  );
  await synced(terminalTask.demand.demandId, "ACTIVE");
  const terminal = CommercialTerminalSchema.parse({
    protocolVersion: 1,
    kind: "commercial-terminal",
    terminalId: randomUUID(),
    domainId: domain.domainId,
    reservationId: terminalTask.reservation.reservationId,
    reservationDigest: terminalTask.receipt.digest,
    activationId: terminalActivation.activationId,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    expectedGateVersion: 1,
    outcome: "completed",
    executionEvidenceDigest: `sha256:${randomBytes(32).toString("hex")}`,
    resultManifestDigest: null,
    observedAt: new Date().toISOString(),
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const terminalSignatures = await bilateral(CommercialTerminalSchema, terminal);
  probes.push(
    terminalSignatures.sourceJws,
    terminalSignatures.targetJws,
    terminal.executionEvidenceDigest,
    terminal.salt,
  );
  await assert.rejects(
    commercial(c, "RecordExecutionTerminal", terminal.terminalId, terminalSignatures).endorse(),
    rejected("POLICY_DENIED"),
  );
  const authorization = MarketExecutionAuthorizationSchema.parse({
    authorizationId: randomUUID(),
    demandId: terminalTask.demand.demandId,
    issuerSiteId: target.siteId,
    activationId: terminalActivation.activationId,
    gate: terminalTask.gate,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 299000).toISOString(),
  });
  const [terminalTx, obsoleteAuthorization] = await Promise.all([
    commercial(a, "RecordExecutionTerminal", terminal.terminalId, terminalSignatures).endorse(),
    market(bm, "AuthorizeExecution", terminalTask.demand.demandId, authorization, [
      "AMSP",
      "CMSP",
    ]).endorse(),
  ]);
  const terminalReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(terminalTx.getResult()).toString()),
  );
  assert.equal((await commit(terminalTx)).successful, true);
  assert.equal(
    (await commit(obsoleteAuthorization)).code,
    peer.TxValidationCode.MVCC_READ_CONFLICT,
  );
  const terminalGate = MarketExecutionGateSchema.parse({
    ...terminalTask.gate,
    version: 2,
    state: "TERMINAL",
    terminal: {
      terminalId: terminal.terminalId,
      activationId: terminal.activationId,
      digest: terminalReceipt.digest,
    },
  });
  const terminalHash = createHash("sha256").update(JSON.stringify(terminalGate)).digest("hex");
  await retryRead(async () =>
    (await Promise.all([a, b, c].map((client) => hash(terminal.reservationId, client)))).every(
      (value) => value === terminalHash,
    ),
  );
  await assert.rejects(
    market(bm, "AuthorizeExecution", terminalTask.demand.demandId, authorization).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  const closure = MarketClosureSchema.parse({
    demandId: terminalTask.demand.demandId,
    closureId: terminal.terminalId,
    expectedVersion: 3,
    gate: terminalGate,
  });
  await assert.rejects(
    market(cm, "CloseDemand", terminalTask.demand.demandId, closure).endorse(),
    rejected("POLICY_DENIED"),
  );
  assert.equal(
    (
      await commit(
        await market(am, "CloseDemand", terminalTask.demand.demandId, closure, [
          "AMSP",
          "CMSP",
        ]).endorse(),
      )
    ).successful,
    true,
  );
  await synced(terminalTask.demand.demandId, "CLOSED");
  const closed = await current(terminalTask.demand.demandId);
  assert.equal(closed.version, 4);
  assert.deepEqual(closed.closure, closure);
  assert.equal(
    (await commit(await market(bm, "CloseDemand", terminalTask.demand.demandId, closure).endorse()))
      .successful,
    true,
  );
  assert.equal((await current(terminalTask.demand.demandId)).version, 4);
  assert.equal(
    (
      await commit(
        await commercial(
          b,
          "RecordExecutionTerminal",
          terminal.terminalId,
          terminalSignatures,
        ).endorse(),
      )
    ).successful,
    true,
  );
  const terminalRelease = await release(terminalTask);
  await assert.rejects(
    commercial(
      a,
      "ReleaseExecution",
      terminalRelease.value.releaseId,
      terminalRelease.signed,
    ).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  passed.push(
    "bilateral private terminal acknowledgment invalidates an endorsed renewal by hashed MVCC; either participant closes the exact activation, replay stays CLOSED and funds remain locked",
  );
  // A separate approved budget keeps settlement assertions independent of the gate-race fixtures.
  const settlementProbe = `PRIVATE-SETTLEMENT-${randomUUID()}`;
  const settlementTerms = CommercialAgreementSchema.parse({
    ...terms,
    agreement: {
      ...terms.agreement,
      agreementRevisionId: randomUUID(),
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      budgetLimit: "100",
      maxTaskAmount: "100",
      maxReservations: 2,
    },
    priceVersionId: randomUUID(),
    prices: [
      { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount: "1" },
    ],
    termsText: settlementProbe,
    salt: randomBytes(32).toString("hex"),
  });
  const settlementRegistration = await commercial(
    a,
    "RegisterAgreement",
    settlementTerms.agreement.agreementRevisionId,
    await bilateral(CommercialAgreementSchema, settlementTerms),
  ).endorse();
  assert.equal((await commit(settlementRegistration)).successful, true);
  const settlementAgreementReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(settlementRegistration.getResult()).toString()),
  );
  const settlementTask = await lock(
    await claimed("100", settlementTerms, settlementAgreementReceipt),
  );
  const settlementActivation = activation(settlementTask);
  assert.equal(
    (
      await commit(
        await market(
          am,
          "ActivateDemand",
          settlementTask.demand.demandId,
          settlementActivation,
        ).endorse(),
      )
    ).successful,
    true,
  );
  await synced(settlementTask.demand.demandId, "ACTIVE");
  const settlementTerminal = CommercialTerminalSchema.parse({
    ...terminal,
    terminalId: randomUUID(),
    reservationId: settlementTask.reservation.reservationId,
    reservationDigest: settlementTask.receipt.digest,
    activationId: settlementActivation.activationId,
    observedAt: new Date().toISOString(),
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const terminalSubmission = await commercial(
    a,
    "RecordExecutionTerminal",
    settlementTerminal.terminalId,
    await bilateral(CommercialTerminalSchema, settlementTerminal),
  ).endorse();
  assert.equal((await commit(terminalSubmission)).successful, true);
  const settlementTerminalReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(terminalSubmission.getResult()).toString()),
  );
  const settledGate = MarketExecutionGateSchema.parse({
    ...settlementTask.gate,
    version: 2,
    state: "TERMINAL",
    terminal: {
      terminalId: settlementTerminal.terminalId,
      activationId: settlementActivation.activationId,
      digest: settlementTerminalReceipt.digest,
    },
  });
  const closedSettlementGateHash = createHash("sha256")
    .update(JSON.stringify(settledGate))
    .digest("hex");
  await retryRead(
    async () => (await hash(settlementTask.reservation.reservationId)) === closedSettlementGateHash,
  );
  const settlementClosure = MarketClosureSchema.parse({
    demandId: settlementTask.demand.demandId,
    closureId: settlementTerminal.terminalId,
    expectedVersion: 3,
    gate: settledGate,
  });
  assert.equal(
    (
      await commit(
        await market(
          am,
          "CloseDemand",
          settlementTask.demand.demandId,
          settlementClosure,
        ).endorse(),
      )
    ).successful,
    true,
  );
  await synced(settlementTask.demand.demandId, "CLOSED");
  const metered = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: settlementTerms.agreement.agreementRevisionId,
    agreementDigest: settlementAgreementReceipt.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    taskId: settlementTask.reservation.request.taskId,
    attempt: 1,
    periodStart: settlementTask.reservation.request.issuedAt,
    periodEnd: settlementTerminal.observedAt,
    reportedAt: new Date().toISOString(),
    measurements: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        quantity: "7000",
        evidenceDigest: settlementTerminal.executionEvidenceDigest,
      },
    ],
    salt: randomBytes(32).toString("hex"),
  });
  const meteredSubmission = await commercial(b, "RecordUsage", metered.reportId, {
    providerJws: await signFederationMessage(CommercialUsageSchema, metered, target),
  }).endorse();
  assert.equal((await commit(meteredSubmission)).successful, true);
  const meteredReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(meteredSubmission.getResult()).toString()),
  );
  const settlementBill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: domain.domainId,
    agreementDigest: settlementAgreementReceipt.digest,
    priceVersionId: settlementTerms.priceVersionId,
    reportId: metered.reportId,
    reportDigest: meteredReceipt.digest,
    request: settlementTask.reservation.request,
    reservationId: settlementTask.reservation.reservationId,
    discount: null,
    calculation: calculateCommercialBill(
      settlementTerms,
      settlementTask.reservation.request,
      metered,
    ),
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const billSubmission = await commercial(
    a,
    "ConfirmBill",
    settlementBill.billId,
    await bilateral(CommercialBillSchema, settlementBill),
  ).endorse();
  assert.equal((await commit(billSubmission)).successful, true);
  const settlementBillReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(billSubmission.getResult()).toString()),
  );
  const settlement = CommercialSettlementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-settlement",
    settlementId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: settlementTerms.agreement.agreementRevisionId,
    billId: settlementBill.billId,
    billDigest: settlementBillReceipt.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    reservationId: settlementTask.reservation.reservationId,
    terminal: {
      terminalId: settlementTerminal.terminalId,
      digest: settlementTerminalReceipt.digest,
    },
    unit: settlementBill.request.unit,
    reservedAmount: "100",
    chargedAmount: "7",
    releasedAmount: "93",
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const settlementEnvelope = await bilateral(CommercialSettlementSchema, settlement);
  probes.push(
    settlementProbe,
    settlement.salt,
    settlementEnvelope.sourceJws,
    settlementEnvelope.targetJws,
  );
  await assert.rejects(
    commercial(c, "SettleBill", settlement.settlementId, settlementEnvelope).endorse(),
    rejected("POLICY_DENIED"),
  );
  const singleEndorser = await commercial(
    a,
    "SettleBill",
    settlement.settlementId,
    settlementEnvelope,
    ["AMSP"],
  ).endorse();
  const invalidSettlement = await commit(singleEndorser);
  assert.equal(invalidSettlement.code, peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE);
  const alternateSettlement = {
    ...settlement,
    settlementId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
  };
  const [settleTx, duplicateSettleTx] = await Promise.all([
    commercial(a, "SettleBill", settlement.settlementId, settlementEnvelope).endorse(),
    commercial(
      b,
      "SettleBill",
      alternateSettlement.settlementId,
      await bilateral(CommercialSettlementSchema, alternateSettlement),
    ).endorse(),
  ]);
  const settlementStatus = await commit(settleTx),
    duplicateSettlementStatus = await commit(duplicateSettleTx);
  assert.equal(settlementStatus.successful, true);
  assert.equal(duplicateSettlementStatus.code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  const settlementReplay = await commercial(
    b,
    "SettleBill",
    settlement.settlementId,
    settlementEnvelope,
  ).endorse();
  assert.deepEqual(settlementReplay.getResult(), settleTx.getResult());
  assert.equal((await commit(settlementReplay)).successful, true);
  await assert.rejects(
    commercial(
      b,
      "SettleBill",
      alternateSettlement.settlementId,
      await bilateral(CommercialSettlementSchema, alternateSettlement),
    ).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  assert.equal(await hash(settlementTask.reservation.reservationId), closedSettlementGateHash);
  assert.equal((await current(settlementTask.demand.demandId)).status, "CLOSED");
  await writeFile(
    join(dirname(z.string().parse(process.argv[2])), "gate-settlement.json"),
    JSON.stringify({
      settlement,
      valid: {
        transactionId: settlementStatus.transactionId,
        blockNumber: String(settlementStatus.blockNumber),
        code: settlementStatus.code,
      },
      invalidMissingEndorsement: invalidSettlement.code,
      invalidDuplicate: duplicateSettlementStatus.code,
      gateHash: closedSettlementGateHash,
    }),
    { mode: 0o600 },
  );
  passed.push(
    "separately approved allocation settlement charges 7 and returns 93; missing organizational endorsement is INVALID, native MVCC admits one settlement and replay cannot reopen the terminal gate",
  );
  const settledReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(settleTx.getResult()).toString()),
  );
  const adjustment = CommercialAdjustmentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-adjustment",
    adjustmentId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: settlement.agreementRevisionId,
    billId: settlement.billId,
    billDigest: settlement.billDigest,
    settlementId: settlement.settlementId,
    settlementDigest: settledReceipt.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    unit: settlement.unit,
    previous: null,
    previousChargedAmount: "7",
    chargedAmount: "4",
    reason: `PRIVATE-ADJUSTMENT-${randomUUID()}`,
    supportingEvidenceDigest: null,
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const adjustmentEnvelope = await bilateral(CommercialAdjustmentSchema, adjustment);
  probes.push(
    adjustment.reason,
    adjustment.salt,
    adjustmentEnvelope.sourceJws,
    adjustmentEnvelope.targetJws,
  );
  await assert.rejects(
    commercial(c, "AdjustSettlement", adjustment.adjustmentId, adjustmentEnvelope).endorse(),
    rejected("POLICY_DENIED"),
  );
  const missingAdjustmentEndorsement = await commercial(
    a,
    "AdjustSettlement",
    adjustment.adjustmentId,
    adjustmentEnvelope,
    ["AMSP"],
  ).endorse();
  const missingAdjustmentStatus = await commit(missingAdjustmentEndorsement);
  assert.equal(missingAdjustmentStatus.code, peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE);
  const competingAdjustment = {
    ...adjustment,
    adjustmentId: randomUUID(),
    chargedAmount: "3",
    salt: randomBytes(32).toString("hex"),
  };
  const competingEnvelope = await bilateral(CommercialAdjustmentSchema, competingAdjustment);
  const [credit, competingCredit] = await Promise.all([
    commercial(a, "AdjustSettlement", adjustment.adjustmentId, adjustmentEnvelope).endorse(),
    commercial(
      b,
      "AdjustSettlement",
      competingAdjustment.adjustmentId,
      competingEnvelope,
    ).endorse(),
  ]);
  const credited = await commit(credit),
    conflicted = await commit(competingCredit);
  assert.equal(credited.successful, true);
  assert.equal(conflicted.code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await assert.rejects(
    commercial(
      b,
      "AdjustSettlement",
      competingAdjustment.adjustmentId,
      competingEnvelope,
    ).endorse(),
  );
  const creditReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(credit.getResult()).toString()),
  );
  const debit = CommercialAdjustmentSchema.parse({
    ...adjustment,
    adjustmentId: randomUUID(),
    previous: { adjustmentId: adjustment.adjustmentId, digest: creditReceipt.digest },
    previousChargedAmount: "4",
    chargedAmount: "5",
    reason: "PRIVATE-AGREED-DEBIT",
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const debitEnvelope = await bilateral(CommercialAdjustmentSchema, debit);
  probes.push(debit.reason, debit.salt, debitEnvelope.sourceJws, debitEnvelope.targetJws);
  const debitTx = await commercial(
    b,
    "AdjustSettlement",
    debit.adjustmentId,
    debitEnvelope,
  ).endorse();
  const debited = await commit(debitTx);
  assert.equal(debited.successful, true);
  // Historical credit replay must not rewind the head or credit the balance a second time.
  const creditReplay = await commercial(
    b,
    "AdjustSettlement",
    adjustment.adjustmentId,
    adjustmentEnvelope,
  ).endorse();
  assert.deepEqual(creditReplay.getResult(), credit.getResult());
  assert.equal((await commit(creditReplay)).successful, true);
  const originalSettlementReplay = await commercial(
    a,
    "SettleBill",
    settlement.settlementId,
    settlementEnvelope,
  ).endorse();
  assert.deepEqual(originalSettlementReplay.getResult(), settleTx.getResult());
  assert.equal((await commit(originalSettlementReplay)).successful, true);
  assert.equal(await hash(settlementTask.reservation.reservationId), closedSettlementGateHash);
  assert.equal((await current(settlementTask.demand.demandId)).status, "CLOSED");
  await writeFile(
    join(dirname(z.string().parse(process.argv[2])), "gate-adjustment.json"),
    JSON.stringify({
      adjustment,
      debitTerms: debit,
      credit: {
        transactionId: credited.transactionId,
        blockNumber: String(credited.blockNumber),
        code: credited.code,
      },
      debit: {
        transactionId: debited.transactionId,
        blockNumber: String(debited.blockNumber),
        code: debited.code,
      },
      invalidMissingEndorsement: missingAdjustmentStatus.code,
      invalidCompetingHead: conflicted.code,
      gateHash: closedSettlementGateHash,
    }),
    { mode: 0o600 },
  );
  passed.push(
    "private bilateral adjustments change spent 7 → 4 → 5, require both organizational endorsements and native MVCC head serialization; historical replay does not refund again or reopen execution",
  );
  // Read actual committed PDC writes, independently of application projections.
  const outsiders = [c, await connection("C", false, "A"), await connection("A", false, "C")];
  let latestBudget: { locked: string; spent: string; reservations: number } | undefined;
  let settlementBudget: typeof latestBudget;
  const settlementSpending: string[] = [];
  for (const block of [...blocks].sort((x, y) => (x < y ? -1 : 1))) {
    for (const gateway of [a, b, ...outsiders]) {
      const events = await gateway
        .getNetwork(network.channel)
        .newBlockAndPrivateDataEventsRequest({ startBlock: block })
        .getEvents({ deadline: Date.now() + 10000 });
      let received = false;
      try {
        for await (const event of events) {
          const publicBlock = event.getBlock();
          assert(publicBlock);
          assert.equal(String(publicBlock.getHeader()?.getNumber()), String(block));
          const bytes = Buffer.from(publicBlock.serializeBinary());
          for (const probe of probes)
            assert(
              !bytes.includes(Buffer.from(probe)),
              "Public block leaked private reservation material",
            );
          const writes: { key: string; value: Uint8Array }[] = [];
          for (const [, tx] of event.getPrivateDataMapMap().entries())
            for (const ns of tx.getNsPvtRwsetList())
              if (ns.getNamespace() === "kq-commercial")
                for (const collection of ns.getCollectionPvtRwsetList())
                  for (const write of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                    collection.getRwset_asU8(),
                  ).getWritesList())
                    writes.push({ key: write.getKey(), value: write.getValue_asU8() });
          if (outsiders.includes(gateway))
            assert.equal(writes.length, 0, "Outsider cannot receive private gate/budget/contract");
          else {
            const metadata = publicBlock.getMetadata()?.getMetadataList_asU8()[
              common.BlockMetadataIndex.TRANSACTIONS_FILTER
            ];
            if (metadata && [...metadata].every((code) => code === peer.TxValidationCode.VALID))
              for (const write of writes)
                if (write.key.startsWith("\u0000budget\u0000")) {
                  const budget = z
                    .object({ locked: z.string(), spent: z.string(), reservations: z.number() })
                    .parse(JSON.parse(Buffer.from(write.value).toString()));
                  if (write.key.includes(settlementTerms.agreement.budgetDomainId)) {
                    settlementBudget = budget;
                    settlementSpending.push(budget.spent);
                  } else if (write.key.includes(terms.agreement.budgetDomainId))
                    latestBudget = budget;
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
  }
  assert.deepEqual(settlementBudget, { locked: "0", spent: "5", reservations: 0 });
  for (const amount of ["7", "4", "5"]) assert(settlementSpending.includes(amount));
  assert.deepEqual(latestBudget, {
    locked: (BigInt(amount) * 2n).toString(),
    spent: "0",
    reservations: 3,
  });
  passed.push(
    "committed private budget is exact after races; C sees gate hashes but no private data or plaintext in public blocks",
  );
  // Reuse the remaining funded slot: release it, reserve a fresh task, then activate it via runtimes.
  const fundedGate = MarketExecutionGateSchema.parse({
    domainId: domain.domainId,
    reservationId: funded.reservation.reservationId,
    demandId: funded.demand.demandId,
    claimVersion: 2,
    version: 1,
    state: "READY",
    reservationDigest: fundedReceipt.digest,
    expiresAt: funded.reservation.request.expiresAt,
  });
  const adapterRelease = await release({ ...funded, receipt: fundedReceipt, gate: fundedGate });
  const fresh = await claimed();
  const digest = (value: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const freshGate = MarketExecutionGateSchema.parse({
    ...fundedGate,
    reservationId: fresh.reservation.reservationId,
    demandId: fresh.demand.demandId,
    reservationDigest: digest(fresh.reservation),
    expiresAt: fresh.reservation.request.expiresAt,
  });
  await writeFile(
    join(dirname(z.string().parse(process.argv[2])), "gate-adapter-fixture.json"),
    JSON.stringify({
      agreement: terms,
      fundedReservation: funded.reservation,
      fundedDemand: await current(funded.demand.demandId),
      freshReservation: fresh.reservation,
      freshDemand: await current(fresh.demand.demandId),
      releasePayload: adapterRelease.value,
      release: {
        operation: "release-execution",
        domainId: domain.domainId,
        recordId: adapterRelease.value.releaseId,
        digest: digest(adapterRelease.value),
        envelope: adapterRelease.signed,
      },
      reserve: {
        operation: "reserve-execution",
        domainId: domain.domainId,
        recordId: fresh.reservation.reservationId,
        digest: digest(fresh.reservation),
        envelope: fresh.signed,
      },
      activate: {
        operation: "activate-demand",
        activation: {
          demandId: fresh.demand.demandId,
          activationId: randomUUID(),
          expectedVersion: 2,
          gate: freshGate,
        },
      },
      releasedGate: { ...fundedGate, state: "REVOKED", version: 2 },
    }),
    { mode: 0o600 },
  );
  await writeFile(z.string().parse(process.argv[3]), JSON.stringify({ passed, probes }, null, 2), {
    mode: 0o600,
  });
}
try {
  await run();
} catch (error) {
  await writeFile(
    `${z.string().parse(process.argv[3])}.failure`,
    JSON.stringify(
      error instanceof EndorseError
        ? { message: error.message, details: error.details }
        : {
            message: error instanceof Error ? error.message : "Unknown failure",
            stack: error instanceof Error ? error.stack : undefined,
          },
    ),
    { mode: 0o600 },
  );
  process.exitCode = 1;
} finally {
  for (const { gateway, client } of connections) {
    gateway.close();
    client.close();
  }
}
