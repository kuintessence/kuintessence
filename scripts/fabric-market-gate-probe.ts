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
import {
  FederationAcceptanceSchema,
  FederationDelegationSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import { CommercialArbitrationPolicySchema } from "@kuintessence/shared/federation/arbitration-policy";
import {
  type CommercialArbitrationRevocationEnvelopeSchema,
  CommercialArbitrationRevocationSchema,
} from "@kuintessence/shared/federation/arbitration-revocation";
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
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import {
  MarketActivationSchema,
  MarketClosureSchema,
  MarketDemandSchema,
  MarketDemandStateSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
  MarketExecutionStopSchema,
  MarketUnreservedClosureSchema,
} from "@kuintessence/shared/federation/market";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FabricCommercialAdapter } from "../packages/fabric-adapter/src/commercial";
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
let probeOperation = "initialize";
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
  ) => {
    probeOperation = name;
    return gateway
      .getNetwork(network.channel)
      .getContract("kq-commercial")
      .newProposal(name, {
        arguments: [domain.domainId, recordId],
        endorsingOrganizations: msps,
        ...(input ? { transientData: { commercial: JSON.stringify(input) } } : {}),
      });
  };
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
  if (
    process.argv.includes("--arbitration-resolution") ||
    process.argv.includes("--arbitration-financial")
  ) {
    const financial = process.argv.includes("--arbitration-financial");
    const digest = (jws: string) =>
      `sha256:${createHash("sha256")
        .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
        .digest("hex")}`;
    const arbitrator: FederationSigningKey = {
      siteId: site("C").siteId,
      keyId: "batch-1",
      privateKey: await importPKCS8(await readFile(site("C").businessKeyFile, "utf8"), "RS256"),
    };
    const policy = CommercialArbitrationPolicySchema.parse({
      protocolVersion: 1,
      kind: "commercial-arbitration-policy",
      policyId: randomUUID(),
      domainId: domain.domainId,
      agreementRevisionId: agreementReceipt.recordId,
      agreementDigest: agreementReceipt.digest,
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      arbitratorSiteId: arbitrator.siteId,
      subjectTypes: ["usage"],
      disclosures: financial
        ? [{ recordType: "bill", fields: ["dueAmount"] }]
        : [{ recordType: "usage", fields: ["measurements"] }],
      requiredEvidence: financial
        ? [{ recordType: "bill", fields: ["dueAmount"] }]
        : [{ recordType: "usage", fields: ["measurements"] }],
      decisionRule: "designated-arbitrator",
      actions: financial ? ["settle", "adjust"] : ["resolve-without-financial-change"],
      maxChargedAmount: financial ? amount : "0",
      unit: terms.agreement.unit,
      salt: randomBytes(32).toString("hex"),
      issuedAt: new Date().toISOString(),
      validFrom: new Date().toISOString(),
      validUntil: new Date(time + 1800000).toISOString(),
    });
    const approvals = await bilateral(CommercialArbitrationPolicySchema, policy);
    const task = await claimed();
    const request = {
      ...task.reservation.request,
      arbitration: {
        policyId: policy.policyId,
        policyDigest: digest(approvals.sourceJws),
        sourceJws: approvals.sourceJws,
        targetJws: approvals.targetJws,
      },
    };
    const reservation = CommercialReservationSchema.parse({ ...task.reservation, request });
    const signedReservation = await bilateral(CommercialReservationSchema, reservation);
    const reserved = await commercial(
      a,
      "ReserveExecution",
      reservation.reservationId,
      signedReservation,
    ).endorse();
    assert.equal((await commit(reserved)).successful, true);
    const requestJws = await signFederationMessage(FederationDelegationSchema, request, source);
    const acceptance = FederationAcceptanceSchema.parse({
      protocolVersion: 1,
      kind: "acceptance",
      senderSiteId: target.siteId,
      recipientSiteId: source.siteId,
      operationId: request.operationId,
      agreementRevisionId: request.agreementRevisionId,
      mode: request.mode,
      budgetDomainId: request.budgetDomainId,
      epoch: request.epoch,
      taskId: request.taskId,
      attempt: request.attempt,
      requestDigest: digest(requestJws),
      reservationId: reservation.reservationId,
      reservedAmount: request.maxAmount,
      unit: request.unit,
      acceptedAt: new Date().toISOString(),
      status: "RESERVED",
    });
    const acceptanceJws = await signFederationMessage(
      FederationAcceptanceSchema,
      acceptance,
      target,
    );
    type Reference = { recordId: string; recordDigest: string };
    const records: {
      recordType: "bill" | "settlement" | "adjustment";
      recordId: string;
      recordDigest: string;
      state: "ready";
    }[] = [];
    let billRef: Reference | null = null,
      settlementRef: Reference | null = null;
    let billTerms: z.infer<typeof CommercialBillSchema> | undefined;
    if (financial) {
      const gate = MarketExecutionGateSchema.parse({
        domainId: domain.domainId,
        reservationId: reservation.reservationId,
        demandId: reservation.demandId,
        claimVersion: 2,
        version: 1,
        state: "READY",
        reservationDigest: digest(signedReservation.sourceJws),
        expiresAt: request.expiresAt,
      });
      const activation = MarketActivationSchema.parse({
        demandId: reservation.demandId,
        activationId: randomUUID(),
        expectedVersion: 2,
        gate,
      });
      assert(
        (
          await commit(
            await market(am, "ActivateDemand", reservation.demandId, activation).endorse(),
          )
        ).successful,
      );
      await synced(reservation.demandId, "ACTIVE");
      const terminal = CommercialTerminalSchema.parse({
        protocolVersion: 1,
        kind: "commercial-terminal",
        terminalId: randomUUID(),
        domainId: domain.domainId,
        reservationId: reservation.reservationId,
        reservationDigest: gate.reservationDigest,
        activationId: activation.activationId,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        expectedGateVersion: 1,
        outcome: "completed",
        executionEvidenceDigest: `sha256:${"a".repeat(64)}`,
        resultManifestDigest: `sha256:${"b".repeat(64)}`,
        observedAt: new Date().toISOString(),
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      assert(
        (
          await commit(
            await commercial(
              a,
              "RecordExecutionTerminal",
              terminal.terminalId,
              await bilateral(CommercialTerminalSchema, terminal),
            ).endorse(),
          )
        ).successful,
      );
      const report = CommercialUsageSchema.parse({
        protocolVersion: 1,
        kind: "commercial-usage",
        reportId: randomUUID(),
        domainId: domain.domainId,
        agreementRevisionId: request.agreementRevisionId,
        agreementDigest: agreementReceipt.digest,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        taskId: request.taskId,
        attempt: request.attempt,
        periodStart: request.issuedAt,
        periodEnd: terminal.observedAt,
        reportedAt: new Date().toISOString(),
        measurements: terms.prices.map((p) => ({
          metric: p.metric,
          quantityUnit: p.quantityUnit,
          quantity: "1000",
          evidenceDigest: `sha256:${"c".repeat(64)}`,
        })),
        salt: randomBytes(32).toString("hex"),
      });
      const providerJws = await signFederationMessage(CommercialUsageSchema, report, target);
      assert(
        (
          await commit(
            await commercial(b, "RecordUsage", report.reportId, { providerJws }).endorse(),
          )
        ).successful,
      );
      billTerms = CommercialBillSchema.parse({
        protocolVersion: 1,
        kind: "commercial-bill",
        billId: randomUUID(),
        domainId: domain.domainId,
        agreementDigest: agreementReceipt.digest,
        priceVersionId: terms.priceVersionId,
        reportId: report.reportId,
        reportDigest: digest(providerJws),
        request,
        reservationId: reservation.reservationId,
        discount: null,
        calculation: calculateCommercialBill(terms, request, report),
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const signed = await bilateral(CommercialBillSchema, billTerms);
      assert(
        (await commit(await commercial(a, "ConfirmBill", billTerms.billId, signed).endorse()))
          .successful,
      );
      billRef = { recordId: billTerms.billId, recordDigest: digest(signed.sourceJws) };
      records.push({ recordType: "bill", ...billRef, state: "ready" });
    }
    const makeCase = async (
      action:
        | "settle"
        | "adjust"
        | "resolve-without-financial-change" = "resolve-without-financial-change",
      chargedAmount = "0",
    ) => {
      // Signed fixture evidence exercises contract enforcement, not the three-Server review flow.
      const opening = CommercialDisputeSchema.parse({
        protocolVersion: 1,
        kind: "commercial-dispute",
        caseId: randomUUID(),
        domainId: domain.domainId,
        agreementRevisionId: request.agreementRevisionId,
        agreementDigest: agreementReceipt.digest,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        openingSiteId: source.siteId,
        taskId: request.taskId,
        attempt: request.attempt,
        subject: {
          recordType: "usage",
          recordId: randomUUID(),
          recordDigest: `sha256:${"a".repeat(64)}`,
        },
        reason: `PRIVATE-RESOLUTION-${randomUUID()}`,
        requestedResolution: "Resolve without charge",
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const openingJws = await signFederationMessage(CommercialDisputeSchema, opening, source);
      const identity = {
        caseId: opening.caseId,
        caseDigest: digest(openingJws),
        agreementRevisionId: request.agreementRevisionId,
        taskId: request.taskId,
        attempt: request.attempt,
        mode: request.mode,
      };
      const freeze = CommercialDisputeFreezeSchema.parse({
        ...identity,
        protocolVersion: 1,
        kind: "commercial-dispute-freeze",
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        headDigest: `sha256:${createHash("sha256")
          .update(
            federationCanonicalJson({
              ...identity,
              records: [...records].sort((a, b) =>
                `${a.recordType}:${a.recordId}` < `${b.recordType}:${b.recordId}` ? -1 : 1,
              ),
            }),
          )
          .digest("hex")}`,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const freezeEnvelope = {
        ...(await bilateral(CommercialDisputeFreezeSchema, freeze)),
        openingSiteId: source.siteId,
        openingJws,
      };
      assert.equal(
        (
          await commit(
            await commercial(a, "FreezeDisputedTask", opening.caseId, freezeEnvelope).endorse(),
          )
        ).successful,
        true,
      );
      const decision = ArbitrationDecisionSchema.parse({
        protocolVersion: 1,
        kind: "arbitration-decision",
        issuedAt: new Date().toISOString(),
        basisExpiresAt: new Date(Date.now() + 30000).toISOString(),
        basisDigest: `sha256:${"b".repeat(64)}`,
        intent: {
          decisionId: randomUUID(),
          binding: {
            ...identity,
            domainId: domain.domainId,
            agreementDigest: agreementReceipt.digest,
            sourceSiteId: source.siteId,
            targetSiteId: target.siteId,
            arbitratorSiteId: arbitrator.siteId,
            operationId: request.operationId,
            reservationId: reservation.reservationId,
            requestDigest: digest(requestJws),
            acceptanceDigest: digest(acceptanceJws),
            policyId: policy.policyId,
            policyDigest: digest(approvals.sourceJws),
            unit: request.unit,
          },
          subject: opening.subject,
          financial: {
            headDigest: freeze.headDigest,
            freezeDigest: digest(freezeEnvelope.sourceJws),
            records: [...records].sort((a, b) =>
              `${a.recordType}:${a.recordId}` < `${b.recordType}:${b.recordId}` ? -1 : 1,
            ),
            evidenceReferences: [],
            targets: billRef
              ? [{ bill: billRef, settlement: settlementRef, previousAdjustment: null }]
              : [],
            ledgerReceipt: { recordId: opening.caseId, digest: digest(freezeEnvelope.sourceJws) },
          },
          evidence: billRef
            ? [
                {
                  ...billRef,
                  recordType: "bill",
                  grantId: randomUUID(),
                  disclosureDigest: `sha256:${"c".repeat(64)}`,
                  fields: ["dueAmount"],
                },
              ]
            : [
                {
                  ...opening.subject,
                  grantId: randomUUID(),
                  disclosureDigest: `sha256:${"c".repeat(64)}`,
                  fields: ["measurements"],
                },
              ],
          outcome:
            action === "settle"
              ? { action, bill: billRef, chargedAmount }
              : action === "adjust"
                ? {
                    action,
                    bill: billRef,
                    settlement: settlementRef,
                    previousAdjustment: null,
                    chargedAmount,
                  }
                : { action },
          reason: opening.reason,
          salt: randomBytes(32).toString("hex"),
        },
      });
      const envelope = {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        requestJws,
        acceptanceJws,
        decisionJws: await signFederationMessage(ArbitrationDecisionSchema, decision, arbitrator),
      };
      probes.push(opening.reason, openingJws, envelope.decisionJws, freezeEnvelope.sourceJws);
      return {
        decision,
        envelope,
        id: decision.intent.decisionId,
        resolve: () =>
          commercial(a, "ResolveArbitratedCase", decision.intent.decisionId, envelope).endorse(),
      };
    };
    if (financial) {
      assert(billRef && billTerms);
      const gateHash = () =>
        commercial(cm, "GetExecutionGateHash", reservation.reservationId)
          .endorse()
          .then((tx) => Buffer.from(tx.getResult()).toString());
      const terminalHash = await gateHash();
      const first = await makeCase("settle", "5");
      const member = site("A");
      const keyNames = await readdir(join(member.userMsp, "keystore"));
      assert(keyNames[0]);
      const identity = {
        mspId: "AMSP",
        credentials: await readFile(join(member.userMsp, "signcerts", "User1@a.kq.test-cert.pem")),
      };
      const signer = signers.newPrivateKeySigner(
        createPrivateKey(await readFile(join(member.userMsp, "keystore", keyNames[0]))),
      );
      const recoveryKey = randomBytes(32);
      const adapter = () =>
        new FabricCommercialAdapter(
          {
            siteId: source.siteId,
            channel: network.channel,
            chaincode: "kq-commercial",
            trust: network.trust,
          },
          a,
          identity,
          signer,
          recoveryKey,
        );
      const proposal = await adapter().prepare({
        operation: "resolve-arbitrated-case",
        domainId: domain.domainId,
        recordId: first.id,
        digest: digest(first.envelope.decisionJws),
        envelope: first.envelope,
      });
      const prepared = await adapter().advance(proposal.recovery);
      assert.equal(prepared.state, "prepared");
      assert(prepared.state === "prepared");
      const settled = await adapter().advance(prepared.recovery);
      assert.equal(settled.state, "committed");
      assert(settled.state === "committed");
      assert.equal(settled.transactionId, proposal.transactionId);
      settlementRef = { recordId: first.id, recordDigest: digest(first.envelope.decisionJws) };
      records.push({ recordType: "settlement", ...settlementRef, state: "ready" });
      const second = await makeCase("adjust", "3");
      const adjusted = await commit(await second.resolve());
      assert(adjusted.successful);
      const next = CommercialAdjustmentSchema.parse({
        protocolVersion: 1,
        kind: "commercial-adjustment",
        adjustmentId: randomUUID(),
        domainId: domain.domainId,
        agreementRevisionId: request.agreementRevisionId,
        billId: billRef.recordId,
        billDigest: billRef.recordDigest,
        settlementId: first.id,
        settlementDigest: settlementRef.recordDigest,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        unit: request.unit,
        previous: { adjustmentId: second.id, digest: digest(second.envelope.decisionJws) },
        previousChargedAmount: "3",
        chargedAmount: "4",
        reason: "Joint post-award correction",
        supportingEvidenceDigest: null,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const changed = await commit(
        await commercial(
          a,
          "AdjustSettlement",
          next.adjustmentId,
          await bilateral(CommercialAdjustmentSchema, next),
        ).endorse(),
      );
      assert(changed.successful);
      const replay = await commit(await first.resolve());
      assert(replay.successful);
      assert.equal(await gateHash(), terminalHash);
      passed.push(
        "production Adapter executes a private R settlement through restored checkpoints with the original transaction; R adjustment and a later A/B correction retain the terminal gate",
      );
      for (const [block, spent] of [
        [BigInt(settled.blockNumber), "5"],
        [adjusted.blockNumber, "3"],
        [changed.blockNumber, "4"],
        [replay.blockNumber, null],
      ] as const) {
        for (const gateway of [b, c]) {
          const events = await gateway
            .getNetwork(network.channel)
            .getBlockAndPrivateDataEvents({ startBlock: block });
          try {
            let seen = false;
            for await (const event of events) {
              const publicBlock = event.getBlock();
              assert(publicBlock);
              assert.equal(String(publicBlock.getHeader()?.getNumber()), String(block));
              const bytes = Buffer.from(publicBlock.serializeBinary());
              for (const probe of probes) assert(!bytes.includes(Buffer.from(probe)));
              const writes: { key: string; value: Uint8Array }[] = [];
              for (const [, tx] of event.getPrivateDataMapMap().entries())
                for (const ns of tx.getNsPvtRwsetList())
                  if (ns.getNamespace() === "kq-commercial")
                    for (const collection of ns.getCollectionPvtRwsetList())
                      for (const write of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
                        collection.getRwset_asU8(),
                      ).getWritesList())
                        writes.push({ key: write.getKey(), value: write.getValue_asU8() });
              if (gateway === c) assert.equal(writes.length, 0);
              else {
                const budgets = writes.filter((w) => w.key.startsWith("\u0000budget\u0000"));
                assert.equal(budgets.length, spent === null ? 0 : 1);
                if (spent !== null)
                  assert.deepEqual(
                    z
                      .object({ locked: z.string(), spent: z.string(), reservations: z.number() })
                      .parse(JSON.parse(Buffer.from(budgets[0]?.value ?? []).toString())),
                    { locked: "0", spent, reservations: 0 },
                  );
                if (block === BigInt(settled.blockNumber)) {
                  const original = writes.find((w) => w.key.startsWith("\u0000settlement\u0000"));
                  assert(original);
                  const saved = JSON.parse(Buffer.from(original.value).toString());
                  assert.equal(saved.arbitration.decision.intent.decisionId, first.id);
                  assert.equal(saved.envelope, undefined);
                }
              }
              seen = true;
              break;
            }
            assert(seen);
          } finally {
            events.close();
          }
        }
      }
      passed.push(
        "real private budget spends exactly 5 then 3 then 4, replay writes no budget; R receives no PDC and public blocks expose no signed financial proof",
      );
      await writeFile(
        z.string().parse(process.argv[3]),
        JSON.stringify({ passed, probes }, null, 2),
        { mode: 0o600 },
      );
      return;
    }
    const first = await makeCase(),
      second = await makeCase();
    const releaseValue = CommercialReleaseSchema.parse({
      protocolVersion: 1,
      kind: "commercial-release",
      domainId: domain.domainId,
      releaseId: randomUUID(),
      reservationId: reservation.reservationId,
      reservationDigest: digest(signedReservation.sourceJws),
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      expectedGateVersion: 1,
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
      reason: "After both cases resolve",
    });
    const releaseEnvelope = await bilateral(CommercialReleaseSchema, releaseValue);
    const releaseAttempt = () =>
      commercial(a, "ReleaseExecution", releaseValue.releaseId, releaseEnvelope).endorse();
    await assert.rejects(releaseAttempt(), rejected("DATA_WAITING"));
    await assert.rejects(
      commercial(c, "ResolveArbitratedCase", first.id, first.envelope).endorse(),
      rejected("POLICY_DENIED"),
    );
    for (const omitted of ["AMSP", "BMSP"]) {
      const tx = await first.resolve();
      const prepared = proto.PreparedTransaction.deserializeBinary(tx.getBytes());
      const envelope = prepared.getEnvelope();
      assert(envelope);
      const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
      const transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
      for (const action of transaction.getActionsList()) {
        const body = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());
        const endorsements = body.getAction();
        assert(endorsements);
        const remaining = endorsements
          .getEndorsementsList()
          .filter(
            (entry) =>
              msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid() !==
              omitted,
          );
        assert.equal(remaining.length, 1);
        endorsements.setEndorsementsList(remaining);
        action.setPayload(body.serializeBinary());
      }
      payload.setData(transaction.serializeBinary());
      envelope.setPayload(payload.serializeBinary());
      assert.equal(
        (await commit(a.newTransaction(prepared.serializeBinary()))).code,
        peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE,
      );
    }
    passed.push(
      "resolution without either A or B endorsement is native INVALID; R cannot access the commercial PDC",
    );
    const [one, two] = await Promise.all([first.resolve(), second.resolve()]);
    assert.equal((await commit(one)).successful, true);
    assert.equal((await commit(two)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
    assert.equal((await commit(await first.resolve())).successful, true);
    await assert.rejects(releaseAttempt(), rejected("DATA_WAITING"));
    passed.push(
      "concurrent case resolutions serialize through native MVCC; replay of the first cannot unfreeze the second",
    );
    assert.equal((await commit(await second.resolve())).successful, true);
    assert.equal((await commit(await releaseAttempt())).successful, true);
    passed.push("the original reservation can be released only after both distinct cases resolve");
    const changed = {
      ...first.decision,
      intent: { ...first.decision.intent, decisionId: randomUUID() },
    };
    await assert.rejects(
      commercial(a, "ResolveArbitratedCase", changed.intent.decisionId, {
        ...first.envelope,
        decisionJws: await signFederationMessage(ArbitrationDecisionSchema, changed, arbitrator),
      }).endorse(),
      rejected("OPERATION_CONFLICT"),
    );
    for (const gateway of [a, b]) {
      const result = await gateway
        .getNetwork(network.channel)
        .getContract("kq-commercial")
        .evaluateTransaction(
          "GetRecordReceipt",
          domain.domainId,
          "arbitration-resolution",
          first.id,
        );
      assert.deepEqual(JSON.parse(Buffer.from(result).toString()), {
        receipt: { recordId: first.id, digest: digest(first.envelope.decisionJws) },
      });
    }
    await assert.rejects(
      c
        .getNetwork(network.channel)
        .getContract("kq-commercial")
        .evaluateTransaction(
          "GetRecordReceipt",
          domain.domainId,
          "arbitration-resolution",
          first.id,
        ),
    );
    passed.push(
      "both parties read the immutable resolution receipt, R is denied and a second award cannot overwrite the same case",
    );
    await writeFile(
      z.string().parse(process.argv[3]),
      JSON.stringify({ passed, probes }, null, 2),
      { mode: 0o600 },
    );
    return;
  }
  if (process.argv.includes("--arbitration-revocation")) {
    const record = async (gateway: ReturnType<typeof connect>, type: string, id: string) =>
      z
        .object({ receipt: CommercialReceiptSchema.nullable() })
        .parse(
          JSON.parse(
            Buffer.from(
              await gateway
                .getNetwork(network.channel)
                .getContract("kq-commercial")
                .evaluateTransaction("GetRecordReceipt", domain.domainId, type, id),
            ).toString(),
          ),
        ).receipt;
    for (const reserveFirst of [false, true]) {
      const policy = CommercialArbitrationPolicySchema.parse({
        protocolVersion: 1,
        kind: "commercial-arbitration-policy",
        policyId: randomUUID(),
        domainId: domain.domainId,
        agreementRevisionId: agreementReceipt.recordId,
        agreementDigest: agreementReceipt.digest,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        arbitratorSiteId: site("C").siteId,
        subjectTypes: ["bill"],
        disclosures: [{ recordType: "bill", fields: ["dueAmount"] }],
        requiredEvidence: [{ recordType: "bill", fields: ["dueAmount"] }],
        decisionRule: "designated-arbitrator",
        actions: ["settle"],
        maxChargedAmount: amount,
        unit: terms.agreement.unit,
        salt: randomBytes(32).toString("hex"),
        issuedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        validUntil: new Date(time + 1800000).toISOString(),
      });
      const approvals = await bilateral(CommercialArbitrationPolicySchema, policy);
      const policyDigest = `sha256:${createHash("sha256")
        .update(Buffer.from(approvals.sourceJws.split(".")[1] ?? "", "base64url"))
        .digest("hex")}`;
      const bind = async (task: Awaited<ReturnType<typeof claimed>>) => {
        const reservation = CommercialReservationSchema.parse({
          ...task.reservation,
          request: {
            ...task.reservation.request,
            arbitration: {
              policyId: policy.policyId,
              policyDigest,
              sourceJws: approvals.sourceJws,
              targetJws: approvals.targetJws,
            },
          },
        });
        const signed = await bilateral(CommercialReservationSchema, reservation);
        probes.push(signed.sourceJws, signed.targetJws);
        return { ...task, reservation, signed };
      };
      const task = await bind(await claimed());
      const issuer: FederationSigningKey = reserveFirst ? target : source;
      const withdrawal = CommercialArbitrationRevocationSchema.parse({
        protocolVersion: 1,
        kind: "commercial-arbitration-revocation",
        revocationId: randomUUID(),
        policyId: policy.policyId,
        policyDigest,
        domainId: domain.domainId,
        agreementRevisionId: agreementReceipt.recordId,
        agreementDigest: agreementReceipt.digest,
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        issuerSiteId: issuer.siteId,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const revocation: z.infer<typeof CommercialArbitrationRevocationEnvelopeSchema> = {
        issuerSiteId: issuer.siteId,
        revocationJws: await signFederationMessage(
          CommercialArbitrationRevocationSchema,
          withdrawal,
          issuer,
        ),
      };
      probes.push(approvals.sourceJws, approvals.targetJws, revocation.revocationJws);
      await assert.rejects(
        commercial(c, "RevokeArbitrationPolicy", withdrawal.revocationId, revocation).endorse(),
        rejected("POLICY_DENIED"),
      );
      const caller = reserveFirst ? b : a;
      const [reserveTx, revokeTx] = await Promise.all([
        commercial(a, "ReserveExecution", task.reservation.reservationId, task.signed).endorse(),
        commercial(
          caller,
          "RevokeArbitrationPolicy",
          withdrawal.revocationId,
          revocation,
        ).endorse(),
      ]);
      let revokeForCommit = revokeTx;
      if (!reserveFirst) {
        const prepared = proto.PreparedTransaction.deserializeBinary(revokeTx.getBytes());
        const envelope = prepared.getEnvelope();
        assert(envelope);
        const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
        const transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
        for (const action of transaction.getActionsList()) {
          const body = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());
          const endorsements = body.getAction();
          assert(endorsements);
          const remaining = endorsements
            .getEndorsementsList()
            .filter(
              (entry) =>
                msp.SerializedIdentity.deserializeBinary(entry.getEndorser_asU8()).getMspid() ===
                "AMSP",
            );
          assert.equal(remaining.length, 1);
          endorsements.setEndorsementsList(remaining);
          action.setPayload(body.serializeBinary());
        }
        payload.setData(transaction.serializeBinary());
        envelope.setPayload(payload.serializeBinary());
        assert.equal(
          (await commit(a.newTransaction(prepared.serializeBinary()))).code,
          peer.TxValidationCode.ENDORSEMENT_POLICY_FAILURE,
        );
        passed.push(
          "unilateral business withdrawal still requires native A/B organizational endorsements",
        );
        revokeForCommit = await commercial(
          caller,
          "RevokeArbitrationPolicy",
          withdrawal.revocationId,
          revocation,
        ).endorse();
      }
      const first = await commit(reserveFirst ? reserveTx : revokeForCommit);
      assert.equal(first.successful, true);
      const second = await commit(reserveFirst ? revokeForCommit : reserveTx);
      if (reserveFirst) {
        assert.equal(second.successful, true);
        passed.push(
          "reservation first: both transactions VALID, subsequent withdrawal preserves the original admission",
        );
      } else {
        assert.equal(second.code, peer.TxValidationCode.MVCC_READ_CONFLICT);
        passed.push(
          "withdrawal first: the concurrent reservation is native MVCC INVALID on the previously absent private fence",
        );
      }
      const expected = CommercialReceiptSchema.parse(
        JSON.parse(Buffer.from(revokeTx.getResult()).toString()),
      );
      await retryRead(async () => {
        const receipts = await Promise.all(
          [a, b].map((g) => record(g, "arbitration-revocation", withdrawal.revocationId)),
        );
        return receipts.every((r) => r?.digest === expected.digest);
      });
      await assert.rejects(record(c, "arbitration-revocation", withdrawal.revocationId));
      const stored = await record(a, "reservation", task.reservation.reservationId);
      assert.equal(stored !== null, reserveFirst);
      if (reserveFirst) {
        const replay = await commercial(
          a,
          "ReserveExecution",
          task.reservation.reservationId,
          task.signed,
        ).endorse();
        assert.deepEqual(JSON.parse(Buffer.from(replay.getResult()).toString()), stored);
        assert.equal((await commit(replay)).successful, true);
      } else {
        await assert.rejects(
          commercial(a, "ReserveExecution", task.reservation.reservationId, task.signed).endorse(),
          rejected("AUTHORIZATION_EXPIRED"),
        );
      }
      const next = await bind(await claimed());
      await assert.rejects(
        commercial(a, "ReserveExecution", next.reservation.reservationId, next.signed).endorse(),
        rejected("AUTHORIZATION_EXPIRED"),
      );
      const replay: Transaction = await commercial(
        caller,
        "RevokeArbitrationPolicy",
        withdrawal.revocationId,
        revocation,
      ).endorse();
      assert.deepEqual(JSON.parse(Buffer.from(replay.getResult()).toString()), expected);
      assert.equal((await commit(replay)).successful, true);
      passed.push(
        `original withdrawal receipt is stable on A/B and denied to R; new reservations are refused (${reserveFirst ? "B" : "A"} withdraws)`,
      );
    }
    await writeFile(
      z.string().parse(process.argv[3]),
      JSON.stringify({ passed, probes }, null, 2),
      { mode: 0o600 },
    );
    return;
  }
  if (process.argv.includes("--unreserved-closure")) {
    for (const reserveFirst of [false, true]) {
      const task = await claimed();
      const issuer = reserveFirst ? source : target;
      const caller = reserveFirst ? am : bm;
      const closure = MarketUnreservedClosureSchema.parse({
        demandId: task.demand.demandId,
        closureId: randomUUID(),
        claimId: task.reservation.reservationId,
        commercialDomainId: domain.domainId,
        issuerSiteId: issuer.siteId,
        expectedVersion: 2,
      });
      await assert.rejects(
        market(cm, "CloseUnreservedDemand", task.demand.demandId, {
          ...closure,
          issuerSiteId: site("C").siteId,
        }).endorse(),
        rejected("POLICY_DENIED"),
      );
      const [reserveTx, closeTx] = await Promise.all([
        commercial(a, "ReserveExecution", task.reservation.reservationId, task.signed).endorse(),
        market(caller, "CloseUnreservedDemand", task.demand.demandId, closure, [
          "AMSP",
          "CMSP",
        ]).endorse(),
      ]);
      assert.equal((await commit(reserveFirst ? reserveTx : closeTx)).successful, true);
      assert.equal(
        (await commit(reserveFirst ? closeTx : reserveTx)).code,
        peer.TxValidationCode.MVCC_READ_CONFLICT,
      );
      await synced(task.demand.demandId, reserveFirst ? "CLAIMED" : "CLOSED");
      if (reserveFirst) {
        await assert.rejects(
          market(caller, "CloseUnreservedDemand", task.demand.demandId, closure).endorse(),
          rejected("OPERATION_CONFLICT"),
        );
        passed.push(
          "private reserve wins: native absent-hash MVCC rejects concurrent unreserved closure and funded claim stays open",
        );
      } else {
        const closed = await current(task.demand.demandId);
        assert.equal(closed.activation, null);
        assert.deepEqual(closed.unreservedClosure, closure);
        assert.equal(
          (
            await commit(
              await market(
                caller,
                "CloseUnreservedDemand",
                task.demand.demandId,
                closure,
              ).endorse(),
            )
          ).successful,
          true,
        );
        await assert.rejects(
          commercial(a, "ReserveExecution", task.reservation.reservationId, task.signed).endorse(),
          rejected("OPERATION_CONFLICT"),
        );
        passed.push(
          "provider closes unreserved claim with A/C endorsement: concurrent private reserve is INVALID, closure replay is stable and late funding is denied",
        );
      }
    }
    await writeFile(
      z.string().parse(process.argv[3]),
      JSON.stringify({ passed, probes }, null, 2),
      { mode: 0o600 },
    );
    return;
  }
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
  const releasedClosure = {
    demandId: one.demand.demandId,
    closureId: cancel.value.releaseId,
    expectedVersion: 2,
    gate: { ...one.gate, state: "REVOKED", version: 2 },
  };
  await assert.rejects(
    market(bm, "CloseDemand", one.demand.demandId, releasedClosure).endorse(),
    rejected("POLICY_DENIED"),
  );
  const closedTx = await market(am, "CloseDemand", one.demand.demandId, releasedClosure, [
    "AMSP",
    "CMSP",
  ]).endorse();
  assert.equal((await commit(closedTx)).successful, true);
  await synced(one.demand.demandId, "CLOSED");
  const releasedState = await current(one.demand.demandId);
  assert.equal(releasedState.activation, null);
  assert.equal(releasedState.version, 3);
  assert.deepEqual(releasedState.closure, releasedClosure);
  assert.equal(
    (await commit(await market(am, "CloseDemand", one.demand.demandId, releasedClosure).endorse()))
      .successful,
    true,
  );
  await assert.rejects(
    market(am, "ActivateDemand", one.demand.demandId, activate).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  passed.push(
    "VALID bilateral pre-execution release closes the public claim using the PDC hash with A/C endorsement, replays once and never activates",
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
  await assert.rejects(
    market(am, "CloseDemand", two.demand.demandId, {
      demandId: two.demand.demandId,
      closureId: cancelTwo.value.releaseId,
      expectedVersion: 2,
      gate: { ...two.gate, state: "REVOKED", version: 2 },
    }).endorse(),
    rejected("OPERATION_CONFLICT"),
  );
  if (process.argv.includes("--preexecution-closure")) {
    if (process.argv.includes("--database")) {
      const funded = await lock(await claimed());
      const fresh = await claimed();
      const pendingRelease = await release(funded);
      await writeFile(
        join(dirname(z.string().parse(process.argv[2])), "gate-adapter-fixture.json"),
        JSON.stringify({
          agreement: terms,
          fundedReservation: funded.reservation,
          fundedDemand: await current(funded.demand.demandId),
          freshReservation: fresh.reservation,
          freshDemand: await current(fresh.demand.demandId),
          releasePayload: pendingRelease.value,
          releasedGate: { ...funded.gate, state: "REVOKED", version: 2 },
        }),
        { mode: 0o600 },
      );
    }
    await writeFile(
      z.string().parse(process.argv[3]),
      JSON.stringify({ passed, probes }, null, 2),
      { mode: 0o600 },
    );
    return;
  }

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
  const nativeOpening = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId: domain.domainId,
    agreementRevisionId: settlementTerms.agreement.agreementRevisionId,
    agreementDigest: settlementAgreementReceipt.digest,
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    openingSiteId: source.siteId,
    taskId: settlementTask.reservation.request.taskId,
    attempt: 1,
    subject: {
      recordType: "settlement",
      recordId: settlement.settlementId,
      recordDigest: settledReceipt.digest,
    },
    reason: `PRIVATE-NATIVE-CASE-${randomUUID()}`,
    requestedResolution: "Review settled charge",
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const nativeOpeningJws = await signFederationMessage(
    CommercialDisputeSchema,
    nativeOpening,
    source,
  );
  const nativeIdentity = {
    caseId: nativeOpening.caseId,
    caseDigest: `sha256:${createHash("sha256")
      .update(Buffer.from(nativeOpeningJws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`,
    agreementRevisionId: nativeOpening.agreementRevisionId,
    taskId: nativeOpening.taskId,
    attempt: 1,
    mode: "ledger_coordinated" as const,
  };
  const debitReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(debitTx.getResult()).toString()),
  );
  const nativeRecords = [
    {
      recordType: "bill",
      recordId: settlementBill.billId,
      recordDigest: settlement.billDigest,
      state: "ready",
    },
    {
      recordType: "settlement",
      recordId: settlement.settlementId,
      recordDigest: settledReceipt.digest,
      state: "ready",
    },
    {
      recordType: "adjustment",
      recordId: creditReceipt.recordId,
      recordDigest: creditReceipt.digest,
      state: "ready",
    },
    {
      recordType: "adjustment",
      recordId: debitReceipt.recordId,
      recordDigest: debitReceipt.digest,
      state: "ready",
    },
  ];
  const nativeProof = async () => {
    const terms = CommercialDisputeFreezeSchema.parse({
      ...nativeIdentity,
      protocolVersion: 1,
      kind: "commercial-dispute-freeze",
      sourceSiteId: source.siteId,
      targetSiteId: target.siteId,
      headDigest: `sha256:${createHash("sha256")
        .update(
          federationCanonicalJson({
            ...nativeIdentity,
            records: [...nativeRecords].sort((a, b) =>
              `${a.recordType}:${a.recordId}` < `${b.recordType}:${b.recordId}` ? -1 : 1,
            ),
          }),
        )
        .digest("hex")}`,
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
    const envelope = {
      ...(await bilateral(CommercialDisputeFreezeSchema, terms)),
      openingSiteId: source.siteId,
      openingJws: nativeOpeningJws,
    };
    probes.push(terms.salt, envelope.sourceJws, envelope.targetJws);
    return { terms, envelope };
  };
  probes.push(nativeOpening.reason, nativeOpening.salt, nativeOpeningJws);
  const staleFreeze = await nativeProof();
  const concurrentChange = CommercialAdjustmentSchema.parse({
    ...debit,
    adjustmentId: randomUUID(),
    previous: { adjustmentId: debitReceipt.recordId, digest: debitReceipt.digest },
    previousChargedAmount: "5",
    chargedAmount: "4",
    issuedAt: new Date().toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const concurrentEnvelope = await bilateral(CommercialAdjustmentSchema, concurrentChange);
  const [staleTx, changeTx] = await Promise.all([
    commercial(a, "FreezeDisputedTask", nativeOpening.caseId, staleFreeze.envelope).endorse(),
    commercial(b, "AdjustSettlement", concurrentChange.adjustmentId, concurrentEnvelope).endorse(),
  ]);
  assert.equal((await commit(changeTx)).successful, true);
  assert.equal((await commit(staleTx)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await assert.rejects(
    commercial(a, "FreezeDisputedTask", nativeOpening.caseId, staleFreeze.envelope).endorse(),
  );
  const changeReceipt = CommercialReceiptSchema.parse(
    JSON.parse(Buffer.from(changeTx.getResult()).toString()),
  );
  nativeRecords.push({
    recordType: "adjustment",
    recordId: changeReceipt.recordId,
    recordDigest: changeReceipt.digest,
    state: "ready",
  });
  const currentFreeze = await nativeProof(),
    blockedChange = {
      ...concurrentChange,
      previousChargedAmount: "4",
      chargedAmount: "5",
      adjustmentId: randomUUID(),
      previous: { adjustmentId: changeReceipt.recordId, digest: changeReceipt.digest },
    };
  const blockedEnvelope = await bilateral(CommercialAdjustmentSchema, blockedChange);
  const [freezeTx, blockedTx] = await Promise.all([
    commercial(a, "FreezeDisputedTask", nativeOpening.caseId, currentFreeze.envelope).endorse(),
    commercial(b, "AdjustSettlement", blockedChange.adjustmentId, blockedEnvelope).endorse(),
  ]);
  const frozen = await commit(freezeTx);
  assert.equal(frozen.successful, true);
  assert.equal((await commit(blockedTx)).code, peer.TxValidationCode.MVCC_READ_CONFLICT);
  await assert.rejects(
    commercial(b, "AdjustSettlement", blockedChange.adjustmentId, blockedEnvelope).endorse(),
  );
  const freezeReplay = await commercial(
    b,
    "FreezeDisputedTask",
    nativeOpening.caseId,
    currentFreeze.envelope,
  ).endorse();
  assert.deepEqual(freezeReplay.getResult(), freezeTx.getResult());
  assert.equal((await commit(freezeReplay)).successful, true);
  const changeReplay = await commercial(
    a,
    "AdjustSettlement",
    concurrentChange.adjustmentId,
    concurrentEnvelope,
  ).endorse();
  assert.deepEqual(changeReplay.getResult(), changeTx.getResult());
  assert.equal((await commit(changeReplay)).successful, true);
  await assert.rejects(
    c
      .getNetwork(network.channel)
      .getContract(network.chaincode)
      .newProposal("GetRecordReceipt", {
        arguments: [domain.domainId, "native-dispute-freeze", nativeOpening.caseId],
        endorsingOrganizations: ["CMSP"],
      })
      .endorse(),
  );
  assert.equal(await hash(settlementTask.reservation.reservationId), closedSettlementGateHash);
  passed.push(
    "native dispute freeze and adjustment conflict in both commit orders; stale heads and new financial writes fail, historical replay and execution gate remain intact",
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
            if (block === frozen.blockNumber) {
              assert.deepEqual(writes.map((w) => w.key.split("\u0000")[1]).sort(), [
                "dispute-task",
                "native-dispute-freeze",
              ]);
              assert(
                writes.some((w) =>
                  Buffer.from(w.value).includes(Buffer.from(nativeOpening.reason)),
                ),
              );
            }
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
  assert.deepEqual(settlementBudget, { locked: "0", spent: "4", reservations: 0 });
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
        ? { operation: probeOperation, message: error.message, details: error.details }
        : {
            operation: probeOperation,
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
