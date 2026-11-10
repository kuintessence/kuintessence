import { beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FederationAcceptanceSchema,
  FederationCancellationReceiptSchema,
  FederationDelegationSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import { CommercialArbitrationPolicySchema } from "@kuintessence/shared/federation/arbitration-policy";
import {
  type CommercialArbitrationRevocation,
  CommercialArbitrationRevocationSchema,
} from "@kuintessence/shared/federation/arbitration-revocation";
import {
  assertCommercialPayment,
  calculateCommercialBill,
} from "@kuintessence/shared/federation/billing";
import {
  CommercialAdjustmentSchema,
  type CommercialAgreement,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialPaymentSchema,
  CommercialReceiptSchema,
  CommercialRefundSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  type CommercialUsage,
  CommercialUsageSchema,
  type FabricCommercialTrust,
  FabricCommercialTrustSchema,
  fabricCommercialCollections,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import {
  MarketActivationSchema,
  MarketExecutionGateSchema,
} from "@kuintessence/shared/federation/market";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import { CommercialLedger } from "./contract";

const sites = [randomUUID(), randomUUID(), randomUUID()] as const;
const domainId = randomUUID();
const keys: FederationSigningKey[] = [];
let trust: FabricCommercialTrust;
const now = new Date("2027-01-01T12:00:00.000Z");
beforeAll(async () => {
  const organizations: FabricCommercialTrust["organizations"] = [];
  for (const [index, siteId] of sites.entries()) {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const keyId = `commercial-${index}`;
    keys.push({ siteId, keyId, privateKey: pair.privateKey });
    organizations.push({
      siteId,
      mspId: `${String.fromCharCode(65 + index)}MSP`,
      keys: [
        {
          keyId,
          publicKeyPem: await exportSPKI(pair.publicKey),
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: "2030-01-01T00:00:00Z",
        },
      ],
    });
  }
  trust = FabricCommercialTrustSchema.parse({
    version: 1,
    generationId: randomUUID(),
    organizations,
    domains: [{ domainId, collection: "commercial_AB_v1", siteIds: [sites[0], sites[1]] }],
    keyPurposes: keys.map((key) => ({
      siteId: key.siteId,
      keyId: key.keyId,
      kinds: [
        "commercial-agreement",
        "commercial-arbitration-policy",
        "arbitration-decision",
        "delegation",
        "acceptance",
        "commercial-arbitration-revocation",
        "commercial-usage",
        "commercial-reservation",
        "commercial-release",
        "commercial-terminal",
        "commercial-discount",
        "commercial-bill",
        "commercial-settlement",
        "commercial-adjustment",
        "commercial-refund",
        "commercial-payment",
        "commercial-dispute",
        "commercial-dispute-freeze",
        "cancellation-receipt",
      ],
    })),
  });
});
function identity(index = 0, role = "commercial") {
  return {
    getMSPID: () => `${String.fromCharCode(65 + index)}MSP`,
    getAttributeValue: (name: string) =>
      name === "kq.federation.site"
        ? (sites[index] ?? null)
        : name === "kq.federation.role"
          ? role
          : null,
  };
}
class MemoryLedger {
  state = new Map<string, Uint8Array>();
  policies = new Map<string, Uint8Array>();
  privateState = new Map<string, Uint8Array>();
  privateHashes = new Map<string, Uint8Array>();
  transient = new Map<string, Uint8Array>();
  fcn = "Init";
  params: string[] = [];
  timestamp = now;
  market: unknown = null;
  getChannelID = () => "cooperation";
  invokeChaincode = async (name: string, args: string[], channel: string) => {
    expect(name).toBe("kq-market");
    expect(channel).toBe("cooperation");
    expect(args[0]).toBe("GetDemand");
    return { status: this.market ? 200 : 500, payload: Buffer.from(JSON.stringify(this.market)) };
  };
  getFunctionAndParameters = () => ({ fcn: this.fcn, params: this.params });
  getDateTimestamp = () => this.timestamp;
  getTransient = () => this.transient;
  createCompositeKey = (name: string, parts: string[]) => JSON.stringify([name, ...parts]);
  getState = async (key: string) => this.state.get(key) ?? new Uint8Array();
  putState = async (key: string, value: Uint8Array) => {
    this.state.set(key, value);
  };
  setStateValidationParameter = async (key: string, value: Uint8Array) => {
    this.policies.set(key, value);
  };
  getPrivateData = async (collection: string, key: string) =>
    this.privateState.get(`${collection}:${key}`) ?? new Uint8Array();
  getPrivateDataHash = async (collection: string, key: string) =>
    this.privateHashes.get(`${collection}:${key}`) ?? new Uint8Array();
  putPrivateData = async (collection: string, key: string, value: Uint8Array) => {
    this.privateState.set(`${collection}:${key}`, value);
    this.privateHashes.set(`${collection}:${key}`, createHash("sha256").update(value).digest());
  };
}
function agreement(): CommercialAgreement {
  return CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId,
    salt: randomBytes(32).toString("hex"),
    createdAt: now.toISOString(),
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: randomUUID(),
      sourceSiteId: sites[0],
      targetSiteId: sites[1],
      mode: "ledger_coordinated",
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      unit: "credit.micro",
      budgetLimit: "99999999999999999999999999999999999999",
      maxTaskAmount: "9007199254740993",
      maxReservations: 10,
      validFrom: "2026-12-01T00:00:00Z",
      validUntil: "2027-02-01T00:00:00Z",
      templates: [
        {
          originSiteId: sites[0],
          kind: "script",
          id: randomUUID(),
          revision: "v1",
          digest: `sha256:${"a".repeat(64)}`,
        },
      ],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
      termsDigest: `sha256:${"b".repeat(64)}`,
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        perQuantity: "3600",
        amount: "9007199254740993",
      },
    ],
    termsText: "PRIVATE-CONTRACT-PROBE",
  });
}
async function signedAgreement(terms: CommercialAgreement) {
  const source = keys.find((key) => key.siteId === terms.agreement.sourceSiteId);
  const target = keys.find((key) => key.siteId === terms.agreement.targetSiteId);
  if (!source || !target) throw new Error("Missing signer");
  return {
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    sourceJws: await signFederationMessage(CommercialAgreementSchema, terms, source),
    targetJws: await signFederationMessage(CommercialAgreementSchema, terms, target),
  };
}
async function setup(input = trust) {
  const stub = new MemoryLedger();
  const ledger = new CommercialLedger(input);
  await ledger.initialize(stub, identity(0, "trust-admin"));
  const call = (fcn: string, recordId: string, payload?: unknown, actor = identity()) => {
    stub.fcn = fcn;
    stub.params = [domainId, recordId];
    stub.transient = payload
      ? new Map([["commercial", Buffer.from(JSON.stringify(payload))]])
      : new Map();
    return ledger.invoke(stub, actor);
  };
  return { stub, ledger, call };
}
async function install(terms = agreement()) {
  const fixture = await setup();
  const receipt = CommercialReceiptSchema.parse(
    JSON.parse(
      (
        await fixture.call(
          "RegisterAgreement",
          terms.agreement.agreementRevisionId,
          await signedAgreement(terms),
        )
      ).toString(),
    ),
  );
  return { ...fixture, terms, receipt };
}
function usage(terms: CommercialAgreement, digest: string): CommercialUsage {
  return {
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId,
    agreementRevisionId: terms.agreement.agreementRevisionId,
    agreementDigest: digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    taskId: randomUUID(),
    attempt: 1,
    salt: randomBytes(32).toString("hex"),
    reportedAt: now.toISOString(),
    periodStart: "2027-01-01T10:00:00Z",
    periodEnd: "2027-01-01T11:00:00Z",
    measurements: [
      {
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "9007199254740993",
        evidenceDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
  };
}
async function signedUsage(report: CommercialUsage) {
  const key = keys[1];
  if (!key) throw new Error("Missing provider key");
  return { providerJws: await signFederationMessage(CommercialUsageSchema, report, key) };
}

test("both business approvals store exact private terms while all responses remain commitments", async () => {
  const { stub, terms, receipt, call } = await install();
  expect(
    [...stub.state.values()].map((value) => Buffer.from(value).toString()).join(""),
  ).not.toContain("PRIVATE-CONTRACT-PROBE");
  expect(
    [...stub.privateState.values()].map((value) => Buffer.from(value).toString()).join(""),
  ).toContain("9007199254740993");
  const read = await call("GetAgreementReceipt", terms.agreement.agreementRevisionId);
  expect(JSON.parse(read.toString())).toEqual(receipt);
  expect(read.toString()).not.toContain("prices");
  expect(
    JSON.parse(
      (
        await call(
          "RegisterAgreement",
          terms.agreement.agreementRevisionId,
          await signedAgreement(terms),
          identity(1),
        )
      ).toString(),
    ),
  ).toEqual(receipt);
  expect(stub.privateState.size).toBe(1);
});
test("reverse direction and institution-specific key IDs are supported", async () => {
  const { call } = await setup();
  const terms = agreement();
  [terms.agreement.sourceSiteId, terms.agreement.targetSiteId] = [sites[1], sites[0]];
  await call(
    "RegisterAgreement",
    terms.agreement.agreementRevisionId,
    await signedAgreement(terms),
    identity(1),
  );
});
test("nonmembers and governance identities cannot read or publish a private agreement", async () => {
  const { call, terms } = await install();
  for (const actor of [identity(2), identity(0, "trust-admin"), identity(0, "attestor")]) {
    await expect(
      call("GetAgreementReceipt", terms.agreement.agreementRevisionId, undefined, actor),
    ).rejects.toThrow();
    await expect(
      call(
        "RegisterAgreement",
        terms.agreement.agreementRevisionId,
        await signedAgreement(terms),
        actor,
      ),
    ).rejects.toThrow();
  }
});
test("missing, mismatching and re-used one-party signatures cannot approve a contract", async () => {
  const { call, stub } = await setup();
  const terms = agreement();
  const envelope = await signedAgreement(terms);
  await expect(
    call("RegisterAgreement", terms.agreement.agreementRevisionId, {
      ...envelope,
      targetJws: envelope.sourceJws,
    }),
  ).rejects.toThrow();
  await expect(
    call("RegisterAgreement", terms.agreement.agreementRevisionId, {
      ...envelope,
      targetJws: (await signedAgreement({ ...terms, termsText: "changed" })).targetJws,
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    call("RegisterAgreement", terms.agreement.agreementRevisionId, {
      ...envelope,
      targetJws: undefined,
    }),
  ).rejects.toThrow();
  expect(stub.privateState.size).toBe(0);
});
test("same revision cannot change its private price or contract even with new signatures", async () => {
  const { call, terms } = await install();
  await expect(
    call(
      "RegisterAgreement",
      terms.agreement.agreementRevisionId,
      await signedAgreement({ ...terms, termsText: "different contract" }),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
});
test("usage is an append-only provider assertion and correction preserves the original", async () => {
  const { call, stub, terms, receipt } = await install();
  const report = usage(terms, receipt.digest);
  const first = await call("RecordUsage", report.reportId, await signedUsage(report), identity(1));
  expect(first.toString()).not.toContain("9007199254740993");
  const original = [...stub.privateState.values()].find((value) =>
    Buffer.from(value).toString().includes(report.reportId),
  );
  const correction = {
    ...report,
    reportId: randomUUID(),
    correctionOf: report.reportId,
    measurements: [
      {
        ...report.measurements[0],
        metric: "cpu",
        quantityUnit: "core-second",
        quantity: "2",
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      },
    ],
  };
  await call("RecordUsage", correction.reportId, await signedUsage(correction), identity(1));
  if (!original) throw new Error("Missing original usage");
  expect([...stub.privateState.values()]).toContain(original);
  expect(stub.privateState.size).toBe(4);
  expect([...stub.privateState.keys()].join("")).not.toMatch(/balance|settlement/);
  const second = await call("RecordUsage", report.reportId, await signedUsage(report), identity(1));
  expect(second.equals(first)).toBe(true);
});
test("wrong publisher, allowance commitment, metric units and task correction are refused", async () => {
  const { call, terms, receipt } = await install();
  const report = usage(terms, receipt.digest);
  await expect(call("RecordUsage", report.reportId, await signedUsage(report))).rejects.toThrow();
  await call("RecordUsage", report.reportId, await signedUsage(report), identity(1));
  for (const changed of [
    { ...report, reportId: randomUUID(), agreementDigest: `sha256:${"e".repeat(64)}` },
    {
      ...report,
      reportId: randomUUID(),
      measurements: [
        {
          ...report.measurements[0],
          metric: "cpu",
          quantityUnit: "hours",
          quantity: "1",
          evidenceDigest: `sha256:${"e".repeat(64)}`,
        },
      ],
    },
    { ...report, reportId: randomUUID(), taskId: randomUUID(), correctionOf: report.reportId },
  ])
    await expect(
      call("RecordUsage", changed.reportId, await signedUsage(changed), identity(1)),
    ).rejects.toThrow(changed.correctionOf ? "OPERATION_CONFLICT" : "POLICY_DENIED");
});
test("missing or corrupt private data never becomes a new empty record", async () => {
  const { stub, call, terms } = await install();
  const key = [...stub.privateState.keys()][0];
  if (!key) throw new Error("Missing private key");
  stub.privateState.delete(key);
  await expect(call("GetAgreementReceipt", terms.agreement.agreementRevisionId)).rejects.toThrow(
    "DATA_WAITING",
  );
  await expect(
    call("RegisterAgreement", terms.agreement.agreementRevisionId, await signedAgreement(terms)),
  ).rejects.toThrow("DATA_WAITING");
  stub.privateState.set(key, Buffer.from("corrupt"));
  await expect(call("GetAgreementReceipt", terms.agreement.agreementRevisionId)).rejects.toThrow(
    "DATA_WAITING",
  );
});
test("explicit key purposes and owner revocation govern new business approvals", async () => {
  const input = structuredClone(trust);
  const purpose = input.keyPurposes[0];
  if (!purpose) throw new Error("Missing purpose");
  purpose.kinds = ["commercial-usage"];
  const denied = await setup(input);
  const terms = agreement();
  await expect(
    denied.call(
      "RegisterAgreement",
      terms.agreement.agreementRevisionId,
      await signedAgreement(terms),
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const { stub, ledger, call } = await setup();
  stub.fcn = "RevokeKey";
  stub.params = [sites[0], "commercial-0"];
  await expect(ledger.invoke(stub, identity(1, "trust-admin"))).rejects.toThrow("POLICY_DENIED");
  await ledger.invoke(stub, identity(0, "trust-admin"));
  await expect(
    call("RegisterAgreement", terms.agreement.agreementRevisionId, await signedAgreement(terms)),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
});
test("private write policy requires both institutions independently of channel governance", () => {
  const [collection] = fabricCommercialCollections(trust);
  expect(collection).toMatchObject({
    policy: "OR('AMSP.member','BMSP.member')",
    memberOnlyRead: true,
    memberOnlyWrite: true,
    endorsementPolicy: { signaturePolicy: "AND('AMSP.peer','BMSP.peer')" },
  });
});
test("invalid charity rates and malformed or unassigned signing purposes fail validation", () => {
  expect(
    CommercialAgreementSchema.safeParse({ ...agreement(), consideration: "charity" }).success,
  ).toBe(false);
  expect(
    FabricCommercialTrustSchema.safeParse({ ...trust, keyPurposes: trust.keyPurposes.slice(1) })
      .success,
  ).toBe(false);
  expect(
    FabricCommercialTrustSchema.safeParse({
      ...trust,
      keyPurposes: [...trust.keyPurposes, trust.keyPurposes[0]],
    }).success,
  ).toBe(false);
});

test("one task attempt has one initial report and a linear correction chain; old replay cannot rewind it", async () => {
  const { call, terms, receipt } = await install();
  const first = usage(terms, receipt.digest);
  const initial = await call("RecordUsage", first.reportId, await signedUsage(first), identity(1));
  const second = { ...first, reportId: randomUUID(), correctionOf: first.reportId };
  await call("RecordUsage", second.reportId, await signedUsage(second), identity(1));
  expect(
    (await call("RecordUsage", first.reportId, await signedUsage(first), identity(1))).equals(
      initial,
    ),
  ).toBe(true);
  for (const next of [
    { ...first, reportId: randomUUID() },
    { ...second, reportId: randomUUID() },
  ])
    await expect(
      call("RecordUsage", next.reportId, await signedUsage(next), identity(1)),
    ).rejects.toThrow("OPERATION_CONFLICT");
  const third = { ...second, reportId: randomUUID(), correctionOf: second.reportId };
  await call("RecordUsage", third.reportId, await signedUsage(third), identity(1));
});

test("expired execution terms and source signing key do not erase approved historical usage", async () => {
  const input = structuredClone(trust);
  const sourceKey = input.organizations[0]?.keys[0];
  if (!sourceKey) throw new Error("Missing source key");
  sourceKey.validUntil = "2027-01-02T00:00:00Z";
  const { call, stub } = await setup(input);
  const terms = agreement();
  const receipt = CommercialReceiptSchema.parse(
    JSON.parse(
      (
        await call(
          "RegisterAgreement",
          terms.agreement.agreementRevisionId,
          await signedAgreement(terms),
        )
      ).toString(),
    ),
  );
  stub.timestamp = new Date("2028-01-01T00:00:00Z");
  const report = { ...usage(terms, receipt.digest), reportedAt: stub.timestamp.toISOString() };
  await call("RecordUsage", report.reportId, await signedUsage(report), identity(1));
  const outOfRange = { ...report, reportId: randomUUID(), periodEnd: "2027-03-01T00:00:00Z" };
  await expect(
    call("RecordUsage", outOfRange.reportId, await signedUsage(outOfRange), identity(1)),
  ).rejects.toThrow("POLICY_DENIED");
});

async function bilateral<T>(schema: z.ZodType<T>, value: T) {
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing signers");
  return {
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    sourceJws: await signFederationMessage(schema, value, source),
    targetJws: await signFederationMessage(schema, value, target),
  };
}
async function reservationFixture(terms = agreement()) {
  const f = await install(terms);
  const reservation = CommercialReservationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-reservation",
    domainId,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    claimVersion: 2,
    agreementDigest: f.receipt.digest,
    salt: randomBytes(32).toString("hex"),
    request: {
      protocolVersion: 1,
      kind: "delegation",
      operationId: randomUUID(),
      senderSiteId: sites[0],
      recipientSiteId: sites[1],
      agreementRevisionId: terms.agreement.agreementRevisionId,
      mode: "ledger_coordinated",
      budgetDomainId: terms.agreement.budgetDomainId,
      epoch: terms.agreement.epoch,
      unit: terms.agreement.unit,
      taskId: randomUUID(),
      attempt: 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(+now + 300000).toISOString(),
      executionExpiresAt: new Date(+now + 3600000).toISOString(),
      template: terms.agreement.templates[0],
      resources: terms.agreement.resourceLimit,
      inputManifestDigest: `sha256:${"d".repeat(64)}`,
      environmentLockDigest: `sha256:${"e".repeat(64)}`,
      maxAmount: terms.agreement.maxTaskAmount,
    },
  });
  const market = {
    demand: {
      protocolVersion: 1,
      demandId: reservation.demandId,
      sourceSiteId: sites[0],
      createdAt: now.toISOString(),
      expiresAt: new Date(+now + 3600000).toISOString(),
      title: "Public test",
      description: "",
      platform: "linux",
      architecture: "x86_64",
      resources: reservation.request.resources,
    },
    digest: `sha256:${"a".repeat(64)}`,
    status: "CLAIMED",
    version: 2,
    cancellation: null,
    activation: null,
    claim: {
      demandId: reservation.demandId,
      claimId: reservation.reservationId,
      providerSiteId: sites[1],
      commercialDomainId: domainId,
      expectedVersion: 1,
      expiresAt: reservation.request.expiresAt,
    },
  };
  f.stub.market = market;
  const reserve = async (value = reservation) =>
    CommercialReceiptSchema.parse(
      JSON.parse(
        (
          await f.call(
            "ReserveExecution",
            value.reservationId,
            await bilateral(CommercialReservationSchema, value),
          )
        ).toString(),
      ),
    );
  const budget = () => {
    const entry = [...f.stub.privateState].find(([key]) => key.includes('["budget",'));
    if (!entry) throw new Error("Missing private budget");
    return z
      .object({ locked: z.string(), spent: z.string(), reservations: z.number() })
      .parse(JSON.parse(Buffer.from(entry[1]).toString()));
  };
  return { ...f, reservation, reserve, market, budget };
}
async function arbitrationReservationFixture(resolution = false) {
  const f = await reservationFixture();
  const policy = CommercialArbitrationPolicySchema.parse({
    protocolVersion: 1,
    kind: "commercial-arbitration-policy",
    policyId: randomUUID(),
    domainId,
    agreementRevisionId: f.terms.agreement.agreementRevisionId,
    agreementDigest: f.receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    arbitratorSiteId: sites[2],
    subjectTypes: resolution ? ["usage"] : ["bill"],
    disclosures: [{ recordType: "bill", fields: ["dueAmount"] }],
    requiredEvidence: [{ recordType: "bill", fields: ["dueAmount"] }],
    decisionRule: "designated-arbitrator",
    actions: resolution ? ["resolve-without-financial-change"] : ["settle"],
    maxChargedAmount: resolution ? "0" : "9007199254740993",
    unit: f.reservation.request.unit,
    issuedAt: now.toISOString(),
    validFrom: now.toISOString(),
    validUntil: "2027-02-01T00:00:00Z",
    salt: randomBytes(32).toString("hex"),
  });
  const signed = await bilateral(CommercialArbitrationPolicySchema, policy);
  const binding = {
    policyId: policy.policyId,
    policyDigest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    sourceJws: signed.sourceJws,
    targetJws: signed.targetJws,
  };
  const request = { ...f.reservation.request, arbitration: binding };
  const reservation = { ...f.reservation, request };
  const withdrawal = (issuerSiteId = sites[0]) =>
    CommercialArbitrationRevocationSchema.parse({
      protocolVersion: 1,
      kind: "commercial-arbitration-revocation",
      revocationId: randomUUID(),
      policyId: policy.policyId,
      policyDigest: binding.policyDigest,
      domainId,
      agreementRevisionId: policy.agreementRevisionId,
      agreementDigest: policy.agreementDigest,
      sourceSiteId: sites[0],
      targetSiteId: sites[1],
      issuerSiteId,
      issuedAt: now.toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
  const revoke = async (
    value: CommercialArbitrationRevocation,
    signer = keys.find((key) => key.siteId === value.issuerSiteId),
    actor = identity(),
  ) => {
    if (!signer) throw new Error("Missing revocation signer");
    return CommercialReceiptSchema.parse(
      JSON.parse(
        (
          await f.call(
            "RevokeArbitrationPolicy",
            value.revocationId,
            {
              issuerSiteId: value.issuerSiteId,
              revocationJws: await signFederationMessage(
                CommercialArbitrationRevocationSchema,
                value,
                signer,
              ),
            },
            actor,
          )
        ).toString(),
      ),
    );
  };
  return { ...f, policy, binding, request, reservation, withdrawal, revoke };
}

test("arbitration reservation keeps both original signatures private and immutable on replay", async () => {
  const f = await arbitrationReservationFixture();
  const { policy, binding, request, reservation } = f;
  const signed = binding;
  const before = new Map(f.stub.privateState);
  for (const patch of [
    { sourceJws: signed.targetJws },
    { targetJws: signed.sourceJws },
    { policyId: randomUUID() },
    { policyDigest: `sha256:${"0".repeat(64)}` },
  ]) {
    await expect(
      f.reserve({ ...reservation, request: { ...request, arbitration: { ...binding, ...patch } } }),
    ).rejects.toThrow();
    expect(f.stub.privateState).toEqual(before);
  }
  for (const patch of [
    { agreementDigest: `sha256:${"0".repeat(64)}` },
    { domainId: randomUUID() },
    { arbitratorSiteId: randomUUID() },
    { unit: "other" },
    { validFrom: "2027-01-02T00:00:00Z" },
  ]) {
    const other = CommercialArbitrationPolicySchema.parse({ ...policy, ...patch });
    const signatures = await bilateral(CommercialArbitrationPolicySchema, other);
    const bad = {
      ...binding,
      policyDigest: `sha256:${createHash("sha256").update(JSON.stringify(other)).digest("hex")}`,
      sourceJws: signatures.sourceJws,
      targetJws: signatures.targetJws,
    };
    await expect(
      f.reserve({ ...reservation, request: { ...request, arbitration: bad } }),
    ).rejects.toThrow();
    expect(f.stub.privateState).toEqual(before);
  }
  const purpose = f.ledger.trust.keyPurposes[0];
  if (!purpose) throw new Error("Missing purpose");
  const kinds = purpose.kinds;
  try {
    purpose.kinds = kinds.filter((kind) => kind !== "commercial-arbitration-policy");
    await expect(f.reserve(reservation)).rejects.toThrow("UNTRUSTED_IDENTITY");
  } finally {
    purpose.kinds = kinds;
  }
  expect(f.stub.privateState).toEqual(before);
  const publicBefore = new Map(f.stub.state);
  const receipt = await f.reserve(reservation);
  const budget = f.budget();
  expect(f.stub.state).toEqual(publicBefore);
  expect(
    [...f.stub.privateState].some(
      ([key, bytes]) =>
        key.startsWith("commercial_AB_v1:") &&
        Buffer.from(bytes).toString().includes(binding.sourceJws),
    ),
  ).toBe(true);
  f.stub.fcn = "GetRecordReceipt";
  f.stub.params = [domainId, "reservation", reservation.reservationId];
  f.stub.transient.clear();
  await expect(f.ledger.invoke(f.stub, identity(2))).rejects.toThrow("POLICY_DENIED");
  f.stub.timestamp = new Date("2027-03-01T00:00:00Z");
  expect(await f.reserve(reservation)).toEqual(receipt);
  await expect(f.reserve()).rejects.toThrow("OPERATION_CONFLICT");
  expect(f.budget()).toEqual(budget);
});

test("arbitration withdrawal by either party fences new reservations without changing money or public state", async () => {
  for (const issuer of [sites[0], sites[1]]) {
    const f = await arbitrationReservationFixture();
    const before = new Map(f.stub.privateState),
      publicBefore = new Map(f.stub.state);
    const value = f.withdrawal(issuer);
    const receipt = await f.revoke(value);
    const privateAfter = new Map(f.stub.privateState);
    expect(receipt.recordId).toBe(value.revocationId);
    const writes = spyOn(f.stub, "putPrivateData");
    try {
      expect(await f.revoke(value)).toEqual(receipt);
      const key = f.stub.createCompositeKey("arbitration-revocation", [
        domainId,
        value.revocationId,
      ]);
      expect(writes).toHaveBeenCalledWith(
        "commercial_AB_v1",
        key,
        privateAfter.get(`commercial_AB_v1:${key}`),
      );
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
    }
    expect(f.stub.privateState).toEqual(privateAfter);
    await expect(f.reserve(f.reservation)).rejects.toThrow("AUTHORIZATION_EXPIRED");
    expect(
      new Map([...f.stub.privateState].filter(([key]) => !key.includes("arbitration-"))),
    ).toEqual(before);
    expect(f.stub.state).toEqual(publicBefore);
    expect(
      [...f.stub.privateState.keys()].filter((key) =>
        key.includes("arbitration-policy-withdrawal"),
      ),
    ).toHaveLength(1);
    f.stub.fcn = "GetRecordReceipt";
    f.stub.params = [domainId, "arbitration-revocation", value.revocationId];
    f.stub.transient.clear();
    expect(JSON.parse((await f.ledger.invoke(f.stub, identity(1))).toString())).toEqual({
      receipt,
    });
    await expect(f.ledger.invoke(f.stub, identity(2))).rejects.toThrow("POLICY_DENIED");
  }
});

test("arbitration withdrawal preserves earlier acceptance and both independent withdrawals", async () => {
  const f = await arbitrationReservationFixture();
  const accepted = await f.reserve(f.reservation);
  const before = f.budget();
  const a = f.withdrawal(),
    b = f.withdrawal(sites[1]);
  const first = await f.revoke(a);
  const fence = [...f.stub.privateState].find(([key]) =>
    key.includes("arbitration-policy-withdrawal"),
  );
  await f.revoke(b);
  expect(
    [...f.stub.privateState].find(([key]) => key.includes("arbitration-policy-withdrawal")),
  ).toEqual(fence);
  expect(await f.reserve(f.reservation)).toEqual(accepted);
  expect(f.budget()).toEqual(before);
  await expect(f.revoke({ ...a, policyDigest: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(await f.revoke(a)).toEqual(first);
});

test("arbitration withdrawal is scoped to the original policy digest and current independent signer", async () => {
  const f = await arbitrationReservationFixture();
  const value = f.withdrawal(),
    before = new Map(f.stub.privateState);
  for (const patch of [
    { agreementDigest: `sha256:${"0".repeat(64)}` },
    { agreementRevisionId: randomUUID() },
    { domainId: randomUUID() },
    { sourceSiteId: sites[1], targetSiteId: sites[0] },
    { issuedAt: new Date(+now + 60001).toISOString() },
  ]) {
    await expect(f.revoke({ ...value, ...patch })).rejects.toThrow();
    expect(f.stub.privateState).toEqual(before);
  }
  await expect(f.revoke(value, keys[1])).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(f.revoke(value, undefined, identity(2))).rejects.toThrow("POLICY_DENIED");
  const purpose = f.ledger.trust.keyPurposes[0];
  if (!purpose) throw new Error("Missing key purposes");
  const kinds = purpose.kinds;
  purpose.kinds = kinds.filter((kind) => kind !== "commercial-arbitration-revocation");
  await expect(f.revoke(value)).rejects.toThrow("UNTRUSTED_IDENTITY");
  purpose.kinds = kinds.filter((kind) => kind !== "commercial-arbitration-policy");
  await f.revoke({ ...value, policyDigest: `sha256:${"0".repeat(64)}` });
  purpose.kinds = kinds;
  expect((await f.reserve(f.reservation)).recordId).toBe(f.reservation.reservationId);
  expect(f.budget().reservations).toBe(1);
});

test("arbitration withdrawal does not require the expired contract or original policy signing purpose to remain usable", async () => {
  const f = await arbitrationReservationFixture();
  f.stub.timestamp = new Date("2027-03-01T00:00:00Z");
  for (const purpose of f.ledger.trust.keyPurposes)
    purpose.kinds = ["commercial-arbitration-revocation"];
  const before = new Map(f.stub.privateState);
  const value = { ...f.withdrawal(), issuedAt: f.stub.timestamp.toISOString() };
  expect((await f.revoke(value)).recordId).toBe(value.revocationId);
  expect(
    new Map([...f.stub.privateState].filter(([key]) => !key.includes("arbitration-"))),
  ).toEqual(before);
});

test("commercial reservation and pre-activation release preserve exact private budget and immutable gate", async () => {
  const f = await reservationFixture(),
    receipt = await f.reserve();
  expect(await f.reserve()).toEqual(receipt);
  expect(f.budget()).toEqual({ locked: "9007199254740993", spent: "0", reservations: 1 });
  const publicBefore = new Map(f.stub.state);
  const gateKey = f.stub.createCompositeKey("execution-gate", [
    domainId,
    f.reservation.reservationId,
  ]);
  const gateBefore = await f.stub.getPrivateDataHash("commercial_AB_v1", gateKey);
  const hash = await f.call(
    "GetExecutionGateHash",
    f.reservation.reservationId,
    undefined,
    identity(2, "market"),
  );
  expect(JSON.parse(hash.toString())).toEqual({ hash: Buffer.from(gateBefore).toString("hex") });
  expect(hash.toString()).not.toContain(f.reservation.request.maxAmount);
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    releaseId: randomUUID(),
    domainId,
    reservationId: f.reservation.reservationId,
    reservationDigest: receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    expectedGateVersion: 1,
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "Withdraw before activation",
  });
  const signed = await bilateral(CommercialReleaseSchema, release);
  const released = await f.call("ReleaseExecution", release.releaseId, signed);
  f.stub.fcn = "GetRecordReceipt";
  f.stub.params = [domainId, "release", release.releaseId];
  f.stub.transient.clear();
  expect(JSON.parse((await f.ledger.invoke(f.stub, identity(1))).toString())).toEqual({
    receipt: JSON.parse(released.toString()),
  });
  expect((await f.call("ReleaseExecution", release.releaseId, signed)).equals(released)).toBe(true);
  expect(f.budget()).toEqual({ locked: "0", spent: "0", reservations: 0 });
  expect(await f.reserve()).toEqual(receipt);
  expect(f.budget().locked).toBe("0");
  expect(await f.stub.getPrivateDataHash("commercial_AB_v1", gateKey)).not.toEqual(gateBefore);
  expect(f.stub.state).toEqual(publicBefore);
  const next = {
    ...f.reservation,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    request: { ...f.reservation.request, taskId: randomUUID(), operationId: randomUUID() },
  };
  f.stub.market = {
    ...f.market,
    demand: { ...f.market.demand, demandId: next.demandId },
    claim: { ...f.market.claim, claimId: next.reservationId, demandId: next.demandId },
  };
  const nextReceipt = await f.reserve(next);
  const reused = {
    ...release,
    reservationId: next.reservationId,
    reservationDigest: nextReceipt.digest,
  };
  await expect(
    f.call("ReleaseExecution", reused.releaseId, await bilateral(CommercialReleaseSchema, reused)),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(f.budget().locked).toBe(next.request.maxAmount);
});
test("commercial reservation rejects overspend and duplicate operation despite distinct public claims", async () => {
  const terms = agreement();
  terms.agreement.budgetLimit = terms.agreement.maxTaskAmount;
  const f = await reservationFixture(terms);
  await f.reserve();
  const second = {
    ...f.reservation,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
  };
  f.stub.market = {
    ...f.market,
    demand: { ...f.market.demand, demandId: second.demandId },
    claim: { ...f.market.claim, demandId: second.demandId, claimId: second.reservationId },
  };
  await expect(f.reserve(second)).rejects.toThrow("OPERATION_CONFLICT");
  second.request = { ...second.request, taskId: randomUUID(), operationId: randomUUID() };
  await expect(f.reserve(second)).rejects.toThrow("BUDGET_EXHAUSTED");
  expect(f.budget()).toEqual({
    locked: terms.agreement.maxTaskAmount,
    spent: "0",
    reservations: 1,
  });
});
test("commercial reservation binds both approvals, domain, current claim, resources and declared signing purposes", async () => {
  const f = await reservationFixture();
  const envelope = await bilateral(CommercialReservationSchema, f.reservation);
  await expect(
    f.call("ReserveExecution", f.reservation.reservationId, {
      ...envelope,
      targetJws: envelope.sourceJws,
    }),
  ).rejects.toThrow();
  for (const market of [
    { ...f.market, status: "ACTIVE" },
    { ...f.market, version: 3 },
    { ...f.market, claim: { ...f.market.claim, commercialDomainId: randomUUID() } },
    { ...f.market, claim: { ...f.market.claim, claimId: randomUUID() } },
    {
      ...f.market,
      demand: { ...f.market.demand, resources: { ...f.market.demand.resources, cpus: 2 } },
    },
  ]) {
    f.stub.market = market;
    await expect(f.reserve()).rejects.toThrow("OPERATION_CONFLICT");
  }
  f.stub.market = f.market;
  await expect(
    f.reserve({
      ...f.reservation,
      request: { ...f.reservation.request, mode: "bilateral_direct" },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  const old = structuredClone(trust);
  for (const purpose of old.keyPurposes)
    purpose.kinds = ["commercial-agreement", "commercial-usage"];
  const denied = await setup(old);
  await expect(
    denied.call("ReserveExecution", f.reservation.reservationId, envelope),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(f.stub.privateState.size).toBe(1);
});
test("active or expired active execution cannot release money and missing private state cannot reset balance", async () => {
  const f = await reservationFixture(),
    receipt = await f.reserve();
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    releaseId: randomUUID(),
    domainId,
    reservationId: f.reservation.reservationId,
    reservationDigest: receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    expectedGateVersion: 1,
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "Attempt release",
  });
  f.stub.timestamp = new Date(+now + 7200000);
  const activation = MarketActivationSchema.parse({
    demandId: f.reservation.demandId,
    activationId: randomUUID(),
    expectedVersion: 2,
    gate: {
      domainId,
      reservationId: f.reservation.reservationId,
      demandId: f.reservation.demandId,
      claimVersion: 2,
      version: 1,
      state: "READY",
      reservationDigest: receipt.digest,
      expiresAt: f.reservation.request.expiresAt,
    },
  });
  for (const status of ["ACTIVE", "STOPPING"]) {
    f.stub.market = {
      ...f.market,
      status,
      activation,
      version: status === "STOPPING" ? 4 : 3,
      ...(status === "STOPPING"
        ? {
            stopRequest: {
              demandId: f.reservation.demandId,
              stopId: randomUUID(),
              issuerSiteId: sites[0],
              activationId: activation.activationId,
              expectedVersion: 3,
            },
          }
        : {}),
    };
    await expect(
      f.call(
        "ReleaseExecution",
        release.releaseId,
        await bilateral(CommercialReleaseSchema, release),
      ),
    ).rejects.toThrow("OPERATION_CONFLICT");
  }
  expect(f.budget().locked).toBe(f.reservation.request.maxAmount);
  f.stub.market = f.market;
  const budgetKey = [...f.stub.privateState.keys()].find((key) => key.includes('["budget",'));
  if (!budgetKey) throw new Error("Missing budget");
  f.stub.privateState.delete(budgetKey);
  await expect(
    f.call(
      "ReleaseExecution",
      release.releaseId,
      await bilateral(CommercialReleaseSchema, release),
    ),
  ).rejects.toThrow("DATA_WAITING");
});

test("a later agreement revision cannot refill or enlarge an existing private budget epoch", async () => {
  const original = agreement();
  original.agreement.budgetLimit = (BigInt(original.agreement.maxTaskAmount) * 2n).toString();
  const f = await reservationFixture(original);
  await f.reserve();
  const nextTerms = {
    ...f.terms,
    salt: randomBytes(32).toString("hex"),
    agreement: {
      ...f.terms.agreement,
      agreementRevisionId: randomUUID(),
      budgetLimit: (BigInt(f.terms.agreement.budgetLimit) + 1n).toString(),
    },
  };
  const changed = CommercialAgreementSchema.parse(nextTerms);
  const receipt = CommercialReceiptSchema.parse(
    JSON.parse(
      (
        await f.call(
          "RegisterAgreement",
          changed.agreement.agreementRevisionId,
          await signedAgreement(changed),
        )
      ).toString(),
    ),
  );
  const next = {
    ...f.reservation,
    reservationId: randomUUID(),
    demandId: randomUUID(),
    agreementDigest: receipt.digest,
    request: {
      ...f.reservation.request,
      taskId: randomUUID(),
      operationId: randomUUID(),
      agreementRevisionId: receipt.recordId,
    },
  };
  f.stub.market = {
    ...f.market,
    demand: { ...f.market.demand, demandId: next.demandId },
    claim: { ...f.market.claim, claimId: next.reservationId, demandId: next.demandId },
  };
  await expect(f.reserve(next)).rejects.toThrow("OPERATION_CONFLICT");
  expect(f.budget()).toEqual({
    locked: f.reservation.request.maxAmount,
    spent: "0",
    reservations: 1,
  });
});

async function terminalFixture() {
  const f = await reservationFixture();
  const receipt = await f.reserve();
  const gateKey = f.stub.createCompositeKey("execution-gate", [
    domainId,
    f.reservation.reservationId,
  ]);
  const gate = MarketExecutionGateSchema.parse(
    JSON.parse(Buffer.from(await f.stub.getPrivateData("commercial_AB_v1", gateKey)).toString()),
  );
  const activation = MarketActivationSchema.parse({
    demandId: f.reservation.demandId,
    activationId: randomUUID(),
    expectedVersion: 2,
    gate,
  });
  const active = { ...f.market, status: "ACTIVE", version: 3, activation };
  f.stub.market = active;
  const terminal = CommercialTerminalSchema.parse({
    protocolVersion: 1,
    kind: "commercial-terminal",
    terminalId: randomUUID(),
    domainId,
    reservationId: f.reservation.reservationId,
    reservationDigest: receipt.digest,
    activationId: activation.activationId,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    expectedGateVersion: 1,
    outcome: "completed",
    executionEvidenceDigest: `sha256:${"b".repeat(64)}`,
    resultManifestDigest: `sha256:${"c".repeat(64)}`,
    observedAt: now.toISOString(),
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const record = async (value = terminal) =>
    f.call(
      "RecordExecutionTerminal",
      value.terminalId,
      await bilateral(CommercialTerminalSchema, value),
    );
  return { ...f, gate, gateKey, active, terminal, record };
}

test.each([
  "completed",
  "failed",
  "cancelled",
] as const)("terminal %s requires bilateral evidence and never settles money", async (outcome) => {
  const f = await terminalFixture();
  if (outcome === "cancelled")
    f.stub.market = {
      ...f.active,
      status: "STOPPING",
      version: 4,
      stopRequest: {
        demandId: f.reservation.demandId,
        stopId: randomUUID(),
        issuerSiteId: sites[1],
        activationId: f.active.activation.activationId,
        expectedVersion: 3,
      },
    };
  const budget = f.budget(),
    publicState = new Map(f.stub.state);
  // Historical execution expiry does not prevent acknowledging already completed work.
  f.stub.timestamp = new Date(+now + 86400000);
  const value = { ...f.terminal, outcome, issuedAt: f.stub.timestamp.toISOString() };
  const receipt = await f.record(value);
  const after = new Map(f.stub.privateState);
  expect(await f.record(value)).toEqual(receipt);
  expect(f.stub.privateState).toEqual(after);
  expect(f.stub.state).toEqual(publicState);
  expect(f.budget()).toEqual(budget);
  const closed = MarketExecutionGateSchema.parse(
    JSON.parse(Buffer.from(await f.stub.getPrivateData("commercial_AB_v1", f.gateKey)).toString()),
  );
  expect(closed).toMatchObject({
    state: "TERMINAL",
    version: 2,
    terminal: { terminalId: value.terminalId, activationId: value.activationId },
  });
  for (const secret of [
    "outcome",
    "executionEvidenceDigest",
    "resultManifestDigest",
    "amount",
    "salt",
  ])
    expect(JSON.stringify(closed)).not.toContain(secret);
  await expect(f.record({ ...value, terminalId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    f.record({ ...value, executionEvidenceDigest: `sha256:${"d".repeat(64)}` }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await f.reserve();
  expect(await f.stub.getPrivateData("commercial_AB_v1", f.gateKey)).toEqual(
    Buffer.from(JSON.stringify(closed)),
  );
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    releaseId: randomUUID(),
    domainId,
    reservationId: value.reservationId,
    reservationDigest: value.reservationDigest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    expectedGateVersion: 2,
    issuedAt: f.stub.timestamp.toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "A terminal declaration cannot refund funds",
  });
  await expect(
    f.call(
      "ReleaseExecution",
      release.releaseId,
      await bilateral(CommercialReleaseSchema, release),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(f.budget()).toEqual(budget);
});

test("terminal binds exact activation and both signatures; third parties and early declarations are rejected", async () => {
  const f = await terminalFixture();
  const before = new Map(f.stub.privateState);
  const envelope = await bilateral(CommercialTerminalSchema, f.terminal);
  await expect(
    f.call("RecordExecutionTerminal", f.terminal.terminalId, envelope, identity(2)),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.call("RecordExecutionTerminal", f.terminal.terminalId, {
      ...envelope,
      targetJws: envelope.sourceJws,
    }),
  ).rejects.toThrow();
  for (const change of [
    { activationId: randomUUID() },
    { expectedGateVersion: 2 },
    { reservationDigest: `sha256:${"f".repeat(64)}` },
    { issuedAt: new Date(+now + 60001).toISOString() },
    { observedAt: new Date(+now - 1).toISOString() },
  ])
    await expect(f.record({ ...f.terminal, ...change })).rejects.toThrow();
  f.stub.market = f.market;
  await expect(f.record()).rejects.toThrow("OPERATION_CONFLICT");
  f.stub.market = f.active;
  const revoked = f.stub.createCompositeKey("revoked", [sites[1], keys[1]?.keyId ?? "missing"]);
  await f.stub.putState(revoked, Buffer.from("revoked"));
  await expect(f.record()).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(f.stub.privateState).toEqual(before);
});

test("commercial record receipts expose only original digests to PDC members and never confuse missing private data with absence", async () => {
  const f = await terminalFixture();
  const terminalReceipt = JSON.parse((await f.record()).toString());
  const read = async (kind: string, id: string, actor = identity()) => {
    f.stub.fcn = "GetRecordReceipt";
    f.stub.params = [domainId, kind, id];
    f.stub.transient.clear();
    return JSON.parse((await f.ledger.invoke(f.stub, actor)).toString());
  };
  expect(await read("agreement", f.terms.agreement.agreementRevisionId)).toEqual({
    receipt: f.receipt,
  });
  expect(await read("reservation", f.reservation.reservationId)).toEqual({
    receipt: { recordId: f.reservation.reservationId, digest: f.terminal.reservationDigest },
  });
  expect(await read("terminal", f.terminal.terminalId, identity(1))).toEqual({
    receipt: terminalReceipt,
  });
  const report = usage(f.terms, f.receipt.digest);
  const provider = keys[1];
  if (!provider) throw new Error("Missing provider signing key");
  const reportJws = await signFederationMessage(CommercialUsageSchema, report, provider);
  const reported = JSON.parse(
    (
      await f.call("RecordUsage", report.reportId, { providerJws: reportJws }, identity(1))
    ).toString(),
  );
  expect(await read("usage", report.reportId)).toEqual({ receipt: reported });
  expect(await read("release", randomUUID())).toEqual({ receipt: null });
  for (const actor of [identity(2), identity(0, "trust-admin"), identity(0, "market")])
    await expect(read("agreement", f.terms.agreement.agreementRevisionId, actor)).rejects.toThrow();
  await expect(read("budget", f.terms.agreement.agreementRevisionId)).rejects.toThrow();
  const privateKey = `commercial_AB_v1:${f.stub.createCompositeKey("terminal", [domainId, f.terminal.terminalId])}`;
  f.stub.privateState.delete(privateKey);
  await expect(read("terminal", f.terminal.terminalId)).rejects.toThrow("DATA_WAITING");
});

async function billFixture(coordinated = false) {
  const base = agreement();
  base.agreement.mode = "bilateral_attested";
  const chain = coordinated ? await terminalFixture() : null;
  const f = chain ?? (await install(base));
  const request = chain
    ? chain.reservation.request
    : FederationDelegationSchema.parse({
        protocolVersion: 1,
        kind: "delegation",
        operationId: randomUUID(),
        senderSiteId: sites[0],
        recipientSiteId: sites[1],
        agreementRevisionId: f.terms.agreement.agreementRevisionId,
        mode: f.terms.agreement.mode,
        budgetDomainId: f.terms.agreement.budgetDomainId,
        epoch: f.terms.agreement.epoch,
        unit: f.terms.agreement.unit,
        taskId: randomUUID(),
        attempt: 1,
        issuedAt: now.toISOString(),
        expiresAt: new Date(+now + 60000).toISOString(),
        template: f.terms.agreement.templates[0],
        resources: f.terms.agreement.resourceLimit,
        maxAmount: "100",
        inputManifestDigest: `sha256:${"d".repeat(64)}`,
        environmentLockDigest: `sha256:${"e".repeat(64)}`,
      });
  f.stub.timestamp = new Date(+now + 2000);
  const report = {
    ...usage(f.terms, f.receipt.digest),
    taskId: request.taskId,
    periodStart: request.issuedAt,
    periodEnd: new Date(+now + 1000).toISOString(),
    reportedAt: f.stub.timestamp.toISOString(),
  };
  const reportReceipt = CommercialReceiptSchema.parse(
    JSON.parse(
      (
        await f.call("RecordUsage", report.reportId, await signedUsage(report), identity(1))
      ).toString(),
    ),
  );
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId,
    agreementDigest: f.receipt.digest,
    priceVersionId: f.terms.priceVersionId,
    reportId: report.reportId,
    reportDigest: reportReceipt.digest,
    request,
    reservationId: chain ? chain.reservation.reservationId : null,
    discount: null,
    calculation: calculateCommercialBill(f.terms, request, report),
    issuedAt: f.stub.timestamp.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const confirm = async (value = bill) =>
    f.call("ConfirmBill", value.billId, await bilateral(CommercialBillSchema, value));
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: bill.billId,
    domainId,
    agreementRevisionId: request.agreementRevisionId,
    agreementDigest: f.receipt.digest,
    reportId: report.reportId,
    reportDigest: reportReceipt.digest,
    taskId: request.taskId,
    attempt: request.attempt,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    unit: request.unit,
    amount: "7",
    reason: "PRIVATE-DISCOUNT-PROBE",
    issuedAt: bill.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const reduce = async (value = discount, signer = keys[1], actor = identity(1)) => {
    if (!signer) throw new Error("Missing provider key");
    return f.call(
      "RecordDiscount",
      value.discountId,
      { providerJws: await signFederationMessage(CommercialDiscountSchema, value, signer) },
      actor,
    );
  };
  return { ...f, chain, bill, report, confirm, discount, reduce };
}

test("bill and concession retain private originals and do not create balances or public business fields", async () => {
  const f = await billFixture();
  const publicBefore = new Map(f.stub.state),
    privateBefore = new Map(f.stub.privateState);
  const discount = CommercialReceiptSchema.parse(JSON.parse((await f.reduce()).toString()));
  const value = {
    ...f.bill,
    discount: { discountId: discount.recordId, digest: discount.digest },
    calculation: calculateCommercialBill(f.terms, f.bill.request, f.report, f.discount.amount),
  };
  const receipt = await f.confirm(value);
  expect((await f.confirm(value)).equals(receipt)).toBe(true);
  expect(f.stub.state).toEqual(publicBefore);
  for (const [key, bytes] of privateBefore) expect(f.stub.privateState.get(key)).toEqual(bytes);
  expect([...f.stub.privateState.keys()].some((key) => key.includes('["budget",'))).toBe(false);
  expect(receipt.toString()).not.toContain("PRIVATE");
  expect(receipt.toString()).not.toContain("dueAmount");
  expect(value.calculation.dueAmount).toBe("93");
  await expect(
    f.call("ConfirmBill", value.billId, await bilateral(CommercialBillSchema, value), identity(2)),
  ).rejects.toThrow("POLICY_DENIED");
});

test("confirmed billing is idempotent, single per task, and remains original after technical correction", async () => {
  const f = await billFixture();
  const initial = await f.confirm();
  const corrected = { ...f.report, reportId: randomUUID(), correctionOf: f.report.reportId };
  await f.call("RecordUsage", corrected.reportId, await signedUsage(corrected), identity(1));
  expect((await f.confirm()).equals(initial)).toBe(true);
  await expect(f.confirm({ ...f.bill, billId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(f.confirm({ ...f.bill, salt: "a".repeat(64) })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(f.reduce()).rejects.toThrow("OPERATION_CONFLICT");
});

test("unconfirmed bill cannot use an obsolete report, uncommitted discount or invented amount", async () => {
  const f = await billFixture();
  await expect(
    f.confirm({ ...f.bill, calculation: { ...f.bill.calculation, dueAmount: "1" } }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.confirm({
      ...f.bill,
      discount: { discountId: f.discount.discountId, digest: `sha256:${"0".repeat(64)}` },
    }),
  ).rejects.toThrow("ASSET_UNAVAILABLE");
  const corrected = { ...f.report, reportId: randomUUID(), correctionOf: f.report.reportId };
  await f.call("RecordUsage", corrected.reportId, await signedUsage(corrected), identity(1));
  await expect(f.confirm()).rejects.toThrow("OPERATION_CONFLICT");
});

test("discount requires the provider, cannot cross bills, and cannot change an old signed record", async () => {
  const f = await billFixture();
  await expect(f.reduce(f.discount, keys[0], identity(0))).rejects.toThrow("POLICY_DENIED");
  const receipt = await f.reduce();
  expect((await f.reduce()).equals(receipt)).toBe(true);
  await expect(f.reduce({ ...f.discount, amount: "8" })).rejects.toThrow("OPERATION_CONFLICT");
  const ref = CommercialReceiptSchema.parse(JSON.parse(receipt.toString()));
  await expect(
    f.confirm({
      ...f.bill,
      billId: randomUUID(),
      discount: { discountId: ref.recordId, digest: ref.digest },
      calculation: calculateCommercialBill(f.terms, f.bill.request, f.report, f.discount.amount),
    }),
  ).rejects.toThrow("POLICY_DENIED");
});

test("bill requires exact dual signatures and newly granted purposes, not existing contract authority", async () => {
  const f = await billFixture();
  const envelope = await bilateral(CommercialBillSchema, f.bill);
  await expect(
    f.call("ConfirmBill", f.bill.billId, { ...envelope, targetJws: envelope.sourceJws }),
  ).rejects.toThrow();
  const changed = await bilateral(CommercialBillSchema, { ...f.bill, salt: "a".repeat(64) });
  await expect(
    f.call("ConfirmBill", f.bill.billId, { ...envelope, targetJws: changed.targetJws }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const old = structuredClone(trust);
  for (const purpose of old.keyPurposes)
    purpose.kinds = ["commercial-agreement", "commercial-usage"];
  const denied = await setup(old);
  await expect(denied.call("ConfirmBill", f.bill.billId, envelope)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});

test("billing can follow contract expiry but cannot follow signing-key revocation", async () => {
  const f = await billFixture();
  f.stub.timestamp = new Date("2028-01-01T00:00:00Z");
  const value = { ...f.bill, issuedAt: f.stub.timestamp.toISOString() };
  await f.confirm(value);
  f.stub.fcn = "RevokeKey";
  f.stub.params = [sites[0], "commercial-0"];
  f.stub.transient.clear();
  await f.ledger.invoke(f.stub, identity(0, "trust-admin"));
  await expect(f.confirm(value)).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("missing private report bytes fail closed, even when the receipt hash exists", async () => {
  const f = await billFixture();
  const key = `commercial_AB_v1:${f.stub.createCompositeKey("usage", [domainId, f.report.reportId])}`;
  f.stub.privateState.delete(key);
  await expect(f.confirm()).rejects.toThrow("DATA_WAITING");
  await expect(f.reduce()).rejects.toThrow("DATA_WAITING");
});

test("coordinated bill requires original terminal reservation and keeps all locked amounts unchanged", async () => {
  const f = await billFixture(true);
  const chain = f.chain;
  if (!chain) throw new Error("Missing coordinated fixture");
  await expect(f.confirm()).rejects.toThrow("OPERATION_CONFLICT");
  chain.terminal.observedAt = f.stub.timestamp.toISOString();
  chain.terminal.issuedAt = f.stub.timestamp.toISOString();
  await chain.record();
  const before = chain.budget();
  await expect(
    f.confirm({ ...f.bill, request: { ...f.bill.request, operationId: randomUUID() } }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await f.confirm();
  expect(chain.budget()).toEqual(before);
});

test("coordinated billing rejects usage that extends beyond the acknowledged terminal observation", async () => {
  const f = await billFixture(true);
  const chain = f.chain;
  if (!chain) throw new Error("Missing coordinated fixture");
  await chain.record();
  const before = chain.budget();
  await expect(f.confirm()).rejects.toThrow("OPERATION_CONFLICT");
  expect(chain.budget()).toEqual(before);
});

async function settlementFixture(coordinated = true) {
  const f = await billFixture(coordinated);
  if (f.chain) {
    f.chain.terminal.observedAt = f.stub.timestamp.toISOString();
    f.chain.terminal.issuedAt = f.stub.timestamp.toISOString();
    await f.chain.record();
  }
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.confirm()).toString()));
  const terminal = f.chain
    ? JSON.parse(
        Buffer.from(
          f.stub.privateState.get(
            `commercial_AB_v1:${f.stub.createCompositeKey("reservation", [domainId, f.chain.reservation.reservationId])}`,
          ) ?? [],
        ).toString(),
      ).terminal.receipt
    : null;
  const value = CommercialSettlementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-settlement",
    settlementId: randomUUID(),
    domainId,
    agreementRevisionId: f.bill.request.agreementRevisionId,
    billId: f.bill.billId,
    billDigest: receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    reservationId: f.bill.reservationId,
    terminal: terminal ? { terminalId: terminal.recordId, digest: terminal.digest } : null,
    unit: f.bill.request.unit,
    reservedAmount: f.bill.request.maxAmount,
    chargedAmount: f.bill.calculation.dueAmount,
    releasedAmount: (
      BigInt(f.bill.request.maxAmount) - BigInt(f.bill.calculation.dueAmount)
    ).toString(),
    issuedAt: f.stub.timestamp.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const settle = async (body = value, actor = identity()) =>
    f.call(
      "SettleBill",
      body.settlementId,
      await bilateral(CommercialSettlementSchema, body),
      actor,
    );
  const budgetKey = `commercial_AB_v1:${f.stub.createCompositeKey("budget", [domainId, f.bill.request.budgetDomainId, f.bill.request.epoch])}`;
  return { ...f, value, settle, budgetKey };
}
test("coordinated settlement consumes approved usage once, releases the remainder and preserves terminal gate", async () => {
  const f = await settlementFixture();
  const before = JSON.parse(Buffer.from(f.stub.privateState.get(f.budgetKey) ?? []).toString());
  const publicBefore = new Map(f.stub.state),
    gateKey = `commercial_AB_v1:${f.stub.createCompositeKey("execution-gate", [domainId, String(f.bill.reservationId)])}`;
  const gateBefore = f.stub.privateState.get(gateKey);
  const result = await f.settle();
  const after = JSON.parse(Buffer.from(f.stub.privateState.get(f.budgetKey) ?? []).toString());
  expect(BigInt(after.locked)).toBe(BigInt(before.locked) - BigInt(f.value.reservedAmount));
  expect(BigInt(after.spent)).toBe(BigInt(before.spent) + BigInt(f.value.chargedAmount));
  expect(after.reservations).toBe(before.reservations - 1);
  expect(f.stub.privateState.get(gateKey)).toEqual(gateBefore);
  expect(f.stub.state).toEqual(publicBefore);
  const privateAfter = new Map(f.stub.privateState);
  expect(await f.settle()).toEqual(result);
  expect(f.stub.privateState).toEqual(privateAfter);
  expect(await f.confirm()).toBeDefined();
  await expect(f.settle({ ...f.value, settlementId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(f.settle({ ...f.value, salt: randomBytes(32).toString("hex") })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});
test("attested settlement records agreement without creating or charging a chain budget", async () => {
  const f = await settlementFixture(false);
  const publicBefore = new Map(f.stub.state);
  await f.settle();
  expect([...f.stub.privateState.keys()].some((key) => key.includes("budget"))).toBe(false);
  expect(f.stub.state).toEqual(publicBefore);
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.settle()).toString()));
  f.stub.fcn = "GetRecordReceipt";
  f.stub.params = [domainId, "settlement", f.value.settlementId];
  f.stub.transient.clear();
  expect(JSON.parse((await f.ledger.invoke(f.stub, identity(1))).toString())).toEqual({ receipt });
  await expect(f.ledger.invoke(f.stub, identity(2))).rejects.toThrow("POLICY_DENIED");
});
test("settlement requires both fresh business signatures and its explicit signing purpose", async () => {
  const f = await settlementFixture();
  const signed = await bilateral(CommercialSettlementSchema, f.value),
    before = new Map(f.stub.privateState);
  await expect(
    f.call("SettleBill", f.value.settlementId, { ...signed, targetJws: signed.sourceJws }),
  ).rejects.toThrow();
  await expect(f.settle(f.value, identity(2))).rejects.toThrow("POLICY_DENIED");
  const denied = structuredClone(trust);
  for (const item of denied.keyPurposes)
    item.kinds = item.kinds.filter((kind) => kind !== "commercial-settlement");
  const g = await setup(denied);
  await expect(g.call("SettleBill", f.value.settlementId, signed)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect(f.stub.privateState).toEqual(before);
});
test("settlement refuses substituted bills, amounts and terminal evidence without touching balances", async () => {
  const f = await settlementFixture();
  const before = new Map(f.stub.privateState);
  for (const change of [
    { billDigest: `sha256:${"f".repeat(64)}` },
    { chargedAmount: "0", releasedAmount: f.value.reservedAmount },
    { unit: "other.micro" },
    { terminal: { terminalId: randomUUID(), digest: `sha256:${"f".repeat(64)}` } },
    { issuedAt: new Date(+f.stub.timestamp + 120000).toISOString() },
  ])
    await expect(f.settle({ ...f.value, ...change })).rejects.toThrow();
  expect(f.stub.privateState).toEqual(before);
});
test("missing settlement private data cannot be mistaken for an unspent reservation", async () => {
  const f = await settlementFixture();
  await f.settle();
  const key = `commercial_AB_v1:${f.stub.createCompositeKey("settlement", [domainId, f.value.settlementId])}`;
  f.stub.privateState.delete(key);
  await expect(f.settle()).rejects.toThrow("DATA_WAITING");
});

async function adjustmentFixture(coordinated = true) {
  const f = await settlementFixture(coordinated);
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.settle()).toString()));
  const value = CommercialAdjustmentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-adjustment",
    adjustmentId: randomUUID(),
    domainId,
    agreementRevisionId: f.value.agreementRevisionId,
    billId: f.value.billId,
    billDigest: f.value.billDigest,
    settlementId: f.value.settlementId,
    settlementDigest: receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    unit: f.value.unit,
    previous: null,
    previousChargedAmount: f.value.chargedAmount,
    chargedAmount: "0",
    reason: "PRIVATE-ADJUSTMENT-REASON",
    supportingEvidenceDigest: null,
    issuedAt: f.stub.timestamp.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const adjust = (body = value, actor = identity()) =>
    bilateral(CommercialAdjustmentSchema, body).then((envelope) =>
      f.call("AdjustSettlement", body.adjustmentId, envelope, actor),
    );
  return { ...f, adjustment: value, adjust };
}
test("coordinated adjustment credits once, supports a bounded debit and preserves original settlement and gate", async () => {
  const f = await adjustmentFixture(),
    before = new Map(f.stub.privateState);
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.adjust()).toString()));
  const creditBudget = JSON.parse(
    Buffer.from(f.stub.privateState.get(f.budgetKey) ?? []).toString(),
  );
  expect(creditBudget.spent).toBe("0");
  const next = {
    ...f.adjustment,
    adjustmentId: randomUUID(),
    previous: { adjustmentId: f.adjustment.adjustmentId, digest: receipt.digest },
    previousChargedAmount: "0",
    chargedAmount: f.value.reservedAmount,
  };
  await f.adjust(next);
  const after = JSON.parse(Buffer.from(f.stub.privateState.get(f.budgetKey) ?? []).toString());
  expect(after.spent).toBe(f.value.reservedAmount);
  expect(after.locked).toBe(creditBudget.locked);
  expect(after.reservations).toBe(creditBudget.reservations);
  const privateAfter = new Map(f.stub.privateState);
  await f.adjust();
  await f.adjust(next);
  expect(f.stub.privateState).toEqual(privateAfter);
  for (const [key, value] of before)
    if (key !== f.budgetKey) expect(f.stub.privateState.get(key)).toEqual(value);
  await expect(f.adjust({ ...f.adjustment, adjustmentId: randomUUID() })).rejects.toThrow();
  await expect(f.adjust({ ...f.adjustment, reason: "changed" })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});
test("attested adjustment stores private append-only facts without creating a chain budget", async () => {
  const f = await adjustmentFixture(false),
    publicBefore = new Map(f.stub.state);
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.adjust()).toString()));
  expect([...f.stub.privateState.keys()].some((key) => key.includes("budget"))).toBe(false);
  expect(f.stub.state).toEqual(publicBefore);
  f.stub.fcn = "GetRecordReceipt";
  f.stub.params = [domainId, "adjustment", f.adjustment.adjustmentId];
  f.stub.transient.clear();
  expect(JSON.parse((await f.ledger.invoke(f.stub, identity(1))).toString())).toEqual({ receipt });
  await expect(f.ledger.invoke(f.stub, identity(2))).rejects.toThrow("POLICY_DENIED");
});
test("adjustment requires independent current signatures from both members and explicit key purposes", async () => {
  const f = await adjustmentFixture(),
    signed = await bilateral(CommercialAdjustmentSchema, f.adjustment);
  await expect(
    f.call("AdjustSettlement", f.adjustment.adjustmentId, {
      ...signed,
      targetJws: signed.sourceJws,
    }),
  ).rejects.toThrow();
  const changed = await bilateral(CommercialAdjustmentSchema, { ...f.adjustment, reason: "other" });
  await expect(
    f.call("AdjustSettlement", f.adjustment.adjustmentId, {
      ...signed,
      targetJws: changed.targetJws,
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.adjust(f.adjustment, identity(2))).rejects.toThrow("POLICY_DENIED");
  const denied = structuredClone(trust);
  for (const item of denied.keyPurposes)
    item.kinds = item.kinds.filter((kind) => kind !== "commercial-adjustment");
  const g = await setup(denied);
  await expect(g.call("AdjustSettlement", f.adjustment.adjustmentId, signed)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  f.stub.fcn = "RevokeKey";
  f.stub.params = [sites[0], "commercial-0"];
  f.stub.transient.clear();
  await f.ledger.invoke(f.stub, identity(0, "trust-admin"));
  await expect(f.adjust()).rejects.toThrow("UNTRUSTED_IDENTITY");
});
test("adjustment rejects changed originals and missing private bytes without touching the budget", async () => {
  const f = await adjustmentFixture(),
    before = new Map(f.stub.privateState);
  for (const change of [
    { settlementDigest: `sha256:${"f".repeat(64)}` },
    { billId: randomUUID() },
    { chargedAmount: (BigInt(f.value.reservedAmount) + 1n).toString() },
    { previousChargedAmount: "1" },
    { issuedAt: new Date(+f.stub.timestamp + 120000).toISOString() },
  ])
    await expect(f.adjust({ ...f.adjustment, ...change })).rejects.toThrow();
  expect(f.stub.privateState).toEqual(before);
  const privateKey = `commercial_AB_v1:${f.stub.createCompositeKey("settlement", [domainId, f.value.settlementId])}`;
  f.stub.privateState.delete(privateKey);
  await expect(f.adjust()).rejects.toThrow("DATA_WAITING");
  expect(f.stub.privateState.get(f.budgetKey)).toEqual(before.get(f.budgetKey));
});
test("debit adjustments cannot spend capacity already locked by other tasks", async () => {
  const f = await adjustmentFixture();
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.adjust()).toString()));
  const key = f.stub.createCompositeKey("budget", [
    domainId,
    f.bill.request.budgetDomainId,
    f.bill.request.epoch,
  ]);
  const budget = JSON.parse(Buffer.from(f.stub.privateState.get(f.budgetKey) ?? []).toString());
  await f.stub.putPrivateData(
    "commercial_AB_v1",
    key,
    Buffer.from(JSON.stringify({ ...budget, locked: budget.limit, reservations: 1 })),
  );
  const before = new Map(f.stub.privateState);
  await expect(
    f.adjust({
      ...f.adjustment,
      adjustmentId: randomUUID(),
      previous: { adjustmentId: f.adjustment.adjustmentId, digest: receipt.digest },
      previousChargedAmount: "0",
      chargedAmount: "1",
    }),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
  expect(f.stub.privateState).toEqual(before);
});
test("missing adjustment head bytes cannot reset the adjustment chain and refund again", async () => {
  const f = await adjustmentFixture();
  await f.adjust();
  const key = `commercial_AB_v1:${f.stub.createCompositeKey("adjustment-head", [domainId, f.value.settlementId])}`;
  f.stub.privateState.delete(key);
  const before = new Map(f.stub.privateState);
  await expect(f.adjust({ ...f.adjustment, adjustmentId: randomUUID() })).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(f.stub.privateState).toEqual(before);
});

test("execution gate presence reports explicit absence only for a configured commercial domain", async () => {
  const f = await reservationFixture();
  const presence = () =>
    f.call(
      "GetExecutionGatePresence",
      f.reservation.reservationId,
      undefined,
      identity(2, "market"),
    );
  expect(JSON.parse((await presence()).toString())).toEqual({ hash: null });
  await expect(
    f.call("GetExecutionGateHash", f.reservation.reservationId, undefined, identity(2, "market")),
  ).rejects.toThrow("ASSET_UNAVAILABLE");
  await f.reserve();
  expect(JSON.parse((await presence()).toString()).hash).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    f.call("GetExecutionGatePresence", randomUUID(), undefined, identity(2, "trust-admin")),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  f.stub.fcn = "GetExecutionGatePresence";
  f.stub.params = [randomUUID(), f.reservation.reservationId];
  await expect(f.ledger.invoke(f.stub, identity(2, "market"))).rejects.toThrow("ASSET_UNAVAILABLE");
});

async function refundFixture() {
  const terms = agreement();
  terms.agreement.mode = "bilateral_attested";
  const f = await install(terms);
  const request = FederationDelegationSchema.parse({
    protocolVersion: 1,
    kind: "delegation",
    operationId: randomUUID(),
    senderSiteId: sites[0],
    recipientSiteId: sites[1],
    agreementRevisionId: terms.agreement.agreementRevisionId,
    mode: "bilateral_attested",
    budgetDomainId: terms.agreement.budgetDomainId,
    epoch: terms.agreement.epoch,
    unit: terms.agreement.unit,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(+now + 60000).toISOString(),
    template: terms.agreement.templates[0],
    resources: terms.agreement.resourceLimit,
    maxAmount: "100",
    inputManifestDigest: `sha256:${"d".repeat(64)}`,
    environmentLockDigest: `sha256:${"e".repeat(64)}`,
  });
  const source = keys[0],
    target = keys[1];
  if (!source || !target) throw new Error("Missing keys");
  const cancellation = FederationCancellationReceiptSchema.parse({
    protocolVersion: 1,
    kind: "cancellation-receipt",
    operationId: request.operationId,
    senderSiteId: sites[1],
    recipientSiteId: sites[0],
    agreementRevisionId: request.agreementRevisionId,
    taskId: request.taskId,
    attempt: 1,
    requestDigest: `sha256:${"1".repeat(64)}`,
    cancellationDigest: `sha256:${"2".repeat(64)}`,
    recordedAt: now.toISOString(),
    observedAt: now.toISOString(),
    reservationId: randomUUID(),
    state: "stopped",
    workflow: null,
  });
  const value = CommercialRefundSchema.parse({
    protocolVersion: 1,
    kind: "commercial-refund",
    refundId: randomUUID(),
    domainId,
    agreementDigest: f.receipt.digest,
    request,
    requestDigest: cancellation.requestDigest,
    cancellationReceiptJws: await signFederationMessage(
      FederationCancellationReceiptSchema,
      cancellation,
      target,
    ),
    releasedAmount: request.maxAmount,
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
    reason: "PRIVATE-REFUND-PROBE",
  });
  const envelope = async (payload = value) => ({
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    sourceJws: await signFederationMessage(CommercialRefundSchema, payload, source),
    targetJws: await signFederationMessage(CommercialRefundSchema, payload, target),
  });
  return { ...f, value, cancellation, target, source, envelope };
}

test("refund attestation is private and immutable, never mutates a budget and excludes later usage", async () => {
  const f = await refundFixture();
  const before = new Map(f.stub.state);
  const receipt = JSON.parse(
    (await f.call("RecordRefund", f.value.refundId, await f.envelope())).toString(),
  );
  expect(f.stub.state).toEqual(before);
  expect([...f.stub.privateState.keys()].some((key) => key.includes('"budget"'))).toBe(false);
  expect(
    JSON.parse((await f.call("RecordRefund", f.value.refundId, await f.envelope())).toString()),
  ).toEqual(receipt);
  await expect(
    f.call("RecordRefund", randomUUID(), await f.envelope({ ...f.value, refundId: randomUUID() })),
  ).rejects.toThrow();
  const replacement = { ...f.value, refundId: randomUUID() };
  await expect(
    f.call("RecordRefund", replacement.refundId, await f.envelope(replacement)),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.call("RecordRefund", f.value.refundId, await f.envelope(), identity(2)),
  ).rejects.toThrow("POLICY_DENIED");
  const report = { ...usage(f.terms, f.receipt.digest), taskId: f.value.request.taskId };
  await expect(
    f.call("RecordUsage", report.reportId, await signedUsage(report), identity(1)),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("refund attestation refuses recorded usage, wrong cancellation and missing financial signing authority", async () => {
  const f = await refundFixture();
  const report = { ...usage(f.terms, f.receipt.digest), taskId: f.value.request.taskId };
  await f.call("RecordUsage", report.reportId, await signedUsage(report), identity(1));
  await expect(f.call("RecordRefund", f.value.refundId, await f.envelope())).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const g = await refundFixture();
  const invalid = {
    ...g.value,
    cancellationReceiptJws: await signFederationMessage(
      FederationCancellationReceiptSchema,
      { ...g.cancellation, state: "pending" },
      g.target,
    ),
  };
  await expect(g.call("RecordRefund", invalid.refundId, await g.envelope(invalid))).rejects.toThrow(
    "POLICY_DENIED",
  );
  const wrongSigner = {
    ...g.value,
    cancellationReceiptJws: await signFederationMessage(
      FederationCancellationReceiptSchema,
      g.cancellation,
      g.source,
    ),
  };
  await expect(
    g.call("RecordRefund", wrongSigner.refundId, await g.envelope(wrongSigner)),
  ).rejects.toThrow();
  const purpose = g.ledger.trust.keyPurposes.find((v) => v.siteId === sites[1]);
  if (!purpose) throw new Error("Missing purpose");
  purpose.kinds = purpose.kinds.filter((kind) => kind !== "commercial-refund");
  await expect(g.call("RecordRefund", g.value.refundId, await g.envelope())).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});

async function paymentFixture(coordinated = false) {
  const f = await billFixture(coordinated);
  if (f.chain) {
    f.chain.terminal.observedAt = f.stub.timestamp.toISOString();
    f.chain.terminal.issuedAt = f.stub.timestamp.toISOString();
    await f.chain.record();
  }
  const billReceipt = CommercialReceiptSchema.parse(JSON.parse((await f.confirm()).toString()));
  const payment = CommercialPaymentSchema.parse({
    protocolVersion: 1,
    kind: "commercial-payment",
    receiptId: randomUUID(),
    paymentId: randomUUID(),
    domainId,
    agreementRevisionId: f.terms.agreement.agreementRevisionId,
    agreementDigest: f.receipt.digest,
    billId: f.bill.billId,
    billDigest: billReceipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    amount: "9007199254740993",
    unit: f.bill.request.unit,
    occurredAt: f.bill.issuedAt,
    issuedAt: f.bill.issuedAt,
    evidenceDigest: `sha256:${"f".repeat(64)}`,
    previous: null,
    reason: "PRIVATE-BANK-RECEIPT",
    salt: randomBytes(32).toString("hex"),
  });
  const record = async (value = payment, actor = identity()) =>
    f.call(
      "RecordPayment",
      value.receiptId,
      await bilateral(CommercialPaymentSchema, value),
      actor,
    );
  return { ...f, payment, billReceipt, record };
}
test.each([
  false,
  true,
])("external payment receipts preserve budgets and originals, coordinated=%s", async (coordinated) => {
  const f = await paymentFixture(coordinated),
    original = new Map(f.stub.privateState),
    publicState = new Map(f.stub.state);
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.record()).toString()));
  expect(receipt.recordId).toBe(f.payment.receiptId);
  expect(f.stub.privateState.size).toBe(original.size + 2);
  for (const [key, value] of original) expect(f.stub.privateState.get(key)).toEqual(value);
  expect(f.stub.state).toEqual(publicState);
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE-BANK-RECEIPT");
  const after = new Map(f.stub.privateState);
  expect(CommercialReceiptSchema.parse(JSON.parse((await f.record()).toString()))).toEqual(receipt);
  expect(f.stub.privateState).toEqual(after);
  await expect(f.record({ ...f.payment, amount: "1" })).rejects.toThrow("OPERATION_CONFLICT");
  const correction = CommercialPaymentSchema.parse({
    ...f.payment,
    receiptId: randomUUID(),
    amount: "0",
    previous: { receiptId: receipt.recordId, digest: receipt.digest },
    reason: "Incorrect external payment report",
    salt: randomBytes(32).toString("hex"),
  });
  const changed = CommercialReceiptSchema.parse(
    JSON.parse((await f.record(correction)).toString()),
  );
  expect(f.stub.privateState.size).toBe(original.size + 3);
  for (const [key, value] of original) expect(f.stub.privateState.get(key)).toEqual(value);
  await f.record();
  const head = f.stub.privateState.get(
    `commercial_AB_v1:${f.stub.createCompositeKey("payment-head", [domainId, f.payment.paymentId])}`,
  );
  expect(head).toBeDefined();
  expect(JSON.parse(Buffer.from(head ?? []).toString())).toEqual(changed);
  await expect(f.record({ ...correction, receiptId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});
test("payment receipts require matching two signatures, a confirmed paid bill and original scope", async () => {
  const f = await paymentFixture(),
    before = new Map(f.stub.privateState);
  const envelope = await bilateral(CommercialPaymentSchema, f.payment);
  await expect(
    f.call("RecordPayment", f.payment.receiptId, { ...envelope, targetJws: envelope.sourceJws }),
  ).rejects.toThrow();
  await expect(f.record(f.payment, identity(2))).rejects.toThrow("POLICY_DENIED");
  await expect(f.record(f.payment, identity(0, "trust-admin"))).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  for (const patch of [
    { agreementDigest: `sha256:${"a".repeat(64)}` },
    { billDigest: `sha256:${"a".repeat(64)}` },
    { unit: "another-unit" },
    { billId: randomUUID() },
    { agreementRevisionId: randomUUID() },
    { previous: { receiptId: randomUUID(), digest: `sha256:${"a".repeat(64)}` } },
    { issuedAt: new Date(+f.stub.timestamp + 120000).toISOString() },
  ])
    await expect(f.record({ ...f.payment, ...patch })).rejects.toThrow();
  expect(f.stub.privateState).toEqual(before);
  for (const consideration of ["charity", "exchange"] as const) {
    const agreement = {
      ...f.terms,
      consideration,
      prices: f.terms.prices.map((p) => ({ ...p, amount: "0" })),
    };
    expect(() =>
      assertCommercialPayment(f.payment, {
        agreement,
        agreementDigest: f.receipt.digest,
        bill: { terms: f.bill, digest: f.billReceipt.digest },
      }),
    ).toThrow("POLICY_DENIED");
  }
  for (const patch of [
    { amount: "0" },
    { amount: "-1" },
    { amount: "1.2" },
    { amount: "01" },
    { occurredAt: new Date(+f.stub.timestamp + 1).toISOString() },
    { sourceSiteId: sites[1] },
  ])
    expect(CommercialPaymentSchema.safeParse({ ...f.payment, ...patch }).success).toBe(false);
});
test("payment receipts fail closed on missing private predecessors and dedicated signing authority", async () => {
  const f = await paymentFixture();
  const configured = structuredClone(trust);
  for (const key of configured.keyPurposes)
    key.kinds = key.kinds.filter((kind) => kind !== "commercial-payment");
  const denied = await setup(configured);
  await expect(
    denied.call(
      "RecordPayment",
      f.payment.receiptId,
      await bilateral(CommercialPaymentSchema, f.payment),
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  const receipt = CommercialReceiptSchema.parse(JSON.parse((await f.record()).toString()));
  const key = `commercial_AB_v1:${f.stub.createCompositeKey("payment", [domainId, f.payment.receiptId])}`;
  f.stub.privateState.delete(key);
  const correction = {
    ...f.payment,
    receiptId: randomUUID(),
    previous: { receiptId: receipt.recordId, digest: receipt.digest },
  };
  await expect(f.record(correction)).rejects.toThrow("DATA_WAITING");
});

async function disputeAttestationFixture(openingIndex = 0) {
  const terms = agreement();
  terms.agreement.mode = "bilateral_attested";
  const f = await install(terms),
    opener = keys[openingIndex];
  if (!opener) throw new Error("Missing opener");
  const opening = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId,
    agreementRevisionId: terms.agreement.agreementRevisionId,
    agreementDigest: f.receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    openingSiteId: opener.siteId,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
    subject: {
      recordType: "usage",
      recordId: randomUUID(),
      recordDigest: `sha256:${"a".repeat(64)}`,
    },
    reason: "PRIVATE-DISPUTE",
    requestedResolution: "Review usage",
  });
  const openingJws = await signFederationMessage(CommercialDisputeSchema, opening, opener);
  const freeze = CommercialDisputeFreezeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute-freeze",
    caseId: opening.caseId,
    caseDigest: `sha256:${createHash("sha256")
      .update(Buffer.from(openingJws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`,
    agreementRevisionId: opening.agreementRevisionId,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    taskId: opening.taskId,
    attempt: 1,
    mode: "bilateral_attested",
    headDigest: `sha256:${"b".repeat(64)}`,
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const envelope = async (value = freeze) => ({
    ...(await bilateral(CommercialDisputeFreezeSchema, value)),
    openingSiteId: opener.siteId,
    openingJws,
  });
  const record = async (value = freeze, actor = identity(openingIndex)) =>
    f.call("RecordDisputeFreeze", value.caseId, await envelope(value), actor);
  return { ...f, opening, openingJws, freeze, envelope, record };
}
test("dispute attestation preserves only one private dual proof without freezing or changing financial state", async () => {
  for (const opener of [0, 1]) {
    const f = await disputeAttestationFixture(opener),
      before = new Map(f.stub.privateState),
      publicBefore = new Map(f.stub.state);
    const receipt = JSON.parse((await f.record()).toString());
    expect(receipt.recordId).toBe(f.opening.caseId);
    expect(JSON.parse((await f.record()).toString())).toEqual(receipt);
    expect(f.stub.state).toEqual(publicBefore);
    expect(f.stub.privateState.size).toBe(before.size + 1);
    for (const [key, value] of before) expect(f.stub.privateState.get(key)).toEqual(value);
    const stored = [...f.stub.privateState.entries()].filter(([key]) => !before.has(key));
    expect(stored[0]?.[0]).toContain('commercial_AB_v1:["dispute-freeze"');
    expect(Buffer.from(stored[0]?.[1] ?? []).toString()).toContain("PRIVATE-DISPUTE");
    await expect(f.record({ ...f.freeze, headDigest: `sha256:${"c".repeat(64)}` })).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await expect(f.record(f.freeze, identity(2))).rejects.toThrow("POLICY_DENIED");
    f.stub.fcn = "GetRecordReceipt";
    f.stub.params = [domainId, "dispute-freeze", f.opening.caseId];
    f.stub.transient.clear();
    expect(JSON.parse((await f.ledger.invoke(f.stub, identity())).toString())).toEqual({ receipt });
    await expect(f.ledger.invoke(f.stub, identity(2))).rejects.toThrow("POLICY_DENIED");
  }
});
test("dispute attestation rejects wrong case binding, mode, future dates and unilateral signatures", async () => {
  const f = await disputeAttestationFixture(),
    before = new Map(f.stub.privateState);
  for (const patch of [
    { taskId: randomUUID() },
    { attempt: 2 },
    { caseDigest: `sha256:${"f".repeat(64)}` },
    { agreementRevisionId: randomUUID() },
    { mode: "bilateral_direct" as const },
    { mode: "ledger_coordinated" as const },
    { issuedAt: new Date(+now + 60001).toISOString() },
    { issuedAt: new Date(+now - 1).toISOString() },
  ])
    await expect(f.record({ ...f.freeze, ...patch })).rejects.toThrow("POLICY_DENIED");
  const envelope = await f.envelope();
  await expect(
    f.call("RecordDisputeFreeze", f.freeze.caseId, { ...envelope, targetJws: envelope.sourceJws }),
  ).rejects.toThrow();
  await expect(
    f.call("RecordDisputeFreeze", f.freeze.caseId, { ...envelope, openingSiteId: sites[1] }),
  ).rejects.toThrow();
  expect(f.stub.privateState).toEqual(before);
});
test("dispute attestation needs dedicated purposes and available original private contract bytes", async () => {
  const f = await disputeAttestationFixture();
  for (const kind of ["commercial-dispute", "commercial-dispute-freeze"] as const) {
    const changed = structuredClone(trust);
    for (const purpose of changed.keyPurposes)
      purpose.kinds = purpose.kinds.filter((x) => x !== kind);
    const ledger = new CommercialLedger(changed);
    f.stub.state.set("kq.commercial.trust.v1", Buffer.from(JSON.stringify(changed)));
    f.stub.fcn = "RecordDisputeFreeze";
    f.stub.params = [domainId, f.freeze.caseId];
    f.stub.transient = new Map([["commercial", Buffer.from(JSON.stringify(await f.envelope()))]]);
    await expect(ledger.invoke(f.stub, identity())).rejects.toThrow();
  }
  f.stub.state.set("kq.commercial.trust.v1", Buffer.from(JSON.stringify(trust)));
  f.stub.privateState.delete(
    `commercial_AB_v1:${f.stub.createCompositeKey("agreement", [domainId, f.terms.agreement.agreementRevisionId])}`,
  );
  await expect(f.record()).rejects.toThrow("DATA_WAITING");
});

async function nativeDispute(
  f: Awaited<ReturnType<typeof install>>,
  task: { taskId: string; attempt: number },
  records: {
    recordType: "bill" | "settlement" | "adjustment";
    recordId: string;
    recordDigest: string;
  }[] = [],
) {
  const opener = keys[0];
  if (!opener) throw new Error("Missing opener");
  const opening = CommercialDisputeSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute",
    caseId: randomUUID(),
    domainId,
    agreementRevisionId: f.terms.agreement.agreementRevisionId,
    agreementDigest: f.receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    openingSiteId: sites[0],
    taskId: task.taskId,
    attempt: task.attempt,
    subject: {
      recordType: "usage",
      recordId: randomUUID(),
      recordDigest: `sha256:${"a".repeat(64)}`,
    },
    reason: "PRIVATE-NATIVE-DISPUTE",
    requestedResolution: "Review accounting",
    issuedAt: f.stub.timestamp.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  const openingJws = await signFederationMessage(CommercialDisputeSchema, opening, opener);
  const headIdentity = {
    caseId: opening.caseId,
    caseDigest: `sha256:${createHash("sha256")
      .update(Buffer.from(openingJws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`,
    agreementRevisionId: opening.agreementRevisionId,
    taskId: task.taskId,
    attempt: task.attempt,
    mode: "ledger_coordinated" as const,
  };
  const ordered = records
    .map((r) => ({ ...r, state: "ready" }))
    .sort((a, b) => (`${a.recordType}:${a.recordId}` < `${b.recordType}:${b.recordId}` ? -1 : 1));
  const freeze = CommercialDisputeFreezeSchema.parse({
    ...headIdentity,
    protocolVersion: 1,
    kind: "commercial-dispute-freeze",
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    headDigest: `sha256:${createHash("sha256")
      .update(federationCanonicalJson({ ...headIdentity, records: ordered }))
      .digest("hex")}`,
    issuedAt: opening.issuedAt,
    salt: randomBytes(32).toString("hex"),
  });
  const envelope = async (value = freeze) => ({
    ...(await bilateral(CommercialDisputeFreezeSchema, value)),
    openingSiteId: sites[0],
    openingJws,
  });
  const record = async (value = freeze, actor = identity()) =>
    f.call("FreezeDisputedTask", value.caseId, await envelope(value), actor);
  return { opening, freeze, record, envelope };
}

test("native dispute freezes new bills without changing funds, preserves multiple cases and replay", async () => {
  const f = await billFixture(true),
    d = await nativeDispute(f, f.bill.request),
    before = new Map(f.stub.privateState),
    publicBefore = new Map(f.stub.state);
  await d.record();
  await expect(f.confirm()).rejects.toThrow("DATA_WAITING");
  for (const [key, value] of before) expect(f.stub.privateState.get(key)).toEqual(value);
  expect(f.stub.state).toEqual(publicBefore);
  expect(f.stub.privateState.size).toBe(before.size + 2);
  const marker = `commercial_AB_v1:${f.stub.createCompositeKey("dispute-task", [domainId, f.bill.request.agreementRevisionId, f.bill.request.taskId, String(f.bill.request.attempt)])}`;
  expect(
    JSON.parse(Buffer.from(f.stub.privateState.get(marker) ?? []).toString()).activeCases,
  ).toBe(1);
  await d.record();
  expect(
    JSON.parse(Buffer.from(f.stub.privateState.get(marker) ?? []).toString()).activeCases,
  ).toBe(1);
  const second = await nativeDispute(f, f.bill.request);
  await second.record();
  expect(
    JSON.parse(Buffer.from(f.stub.privateState.get(marker) ?? []).toString()).activeCases,
  ).toBe(2);
  await expect(d.record({ ...d.freeze, headDigest: `sha256:${"e".repeat(64)}` })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(d.record(d.freeze, identity(2))).rejects.toThrow("POLICY_DENIED");
});

test("native dispute requires the complete financial history and blocks new settlement adjustments while allowing original replay", async () => {
  const f = await adjustmentFixture(),
    receipt = CommercialReceiptSchema.parse(JSON.parse((await f.adjust()).toString()));
  const entries = [
    { recordType: "bill" as const, recordId: f.bill.billId, recordDigest: f.value.billDigest },
    {
      recordType: "settlement" as const,
      recordId: f.value.settlementId,
      recordDigest: f.adjustment.settlementDigest,
    },
    {
      recordType: "adjustment" as const,
      recordId: f.adjustment.adjustmentId,
      recordDigest: receipt.digest,
    },
  ];
  const incomplete = await nativeDispute(f, f.bill.request, entries.slice(0, 2));
  await expect(incomplete.record()).rejects.toThrow("OPERATION_CONFLICT");
  const d = await nativeDispute(f, f.bill.request, entries),
    before = new Map(f.stub.privateState),
    budget = f.stub.privateState.get(f.budgetKey);
  await d.record();
  await expect(
    f.adjust({
      ...f.adjustment,
      adjustmentId: randomUUID(),
      previous: { adjustmentId: receipt.recordId, digest: receipt.digest },
      previousChargedAmount: "0",
      chargedAmount: "1",
    }),
  ).rejects.toThrow("DATA_WAITING");
  expect(f.stub.privateState.get(f.budgetKey)).toEqual(budget);
  await f.adjust();
  await f.settle();
  for (const [key, value] of before) expect(f.stub.privateState.get(key)).toEqual(value);
  const missing = `commercial_AB_v1:${f.stub.createCompositeKey("adjustment", [domainId, receipt.recordId])}`;
  f.stub.privateState.delete(missing);
  const other = await nativeDispute(f, f.bill.request, entries);
  await expect(other.record()).rejects.toThrow("DATA_WAITING");
});

test("native dispute rejects a new settlement after bill freeze and never rewrites the bill", async () => {
  const f = await settlementFixture(),
    d = await nativeDispute(f, f.bill.request, [
      { recordType: "bill", recordId: f.bill.billId, recordDigest: f.value.billDigest },
    ]);
  await d.record();
  await expect(f.settle()).rejects.toThrow("DATA_WAITING");
  await f.confirm();
  const before = new Map(f.stub.privateState);
  await expect(f.call("RecordDisputeFreeze", d.freeze.caseId, await d.envelope())).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(f.stub.privateState).toEqual(before);
});

test("native dispute fences reserve and release but permits terminal evidence and unaffected tasks", async () => {
  const f = await reservationFixture(),
    d = await nativeDispute(f, f.reservation.request);
  await d.record();
  await expect(f.reserve()).rejects.toThrow("DATA_WAITING");
  const other = {
    ...f.reservation,
    reservationId: randomUUID(),
    request: { ...f.reservation.request, taskId: randomUUID(), operationId: randomUUID() },
  };
  f.stub.market = { ...f.market, claim: { ...f.market.claim, claimId: other.reservationId } };
  await f.reserve(other);
  const g = await reservationFixture(),
    receipt = await g.reserve(),
    freeze = await nativeDispute(g, g.reservation.request);
  await freeze.record();
  expect(await g.reserve()).toEqual(receipt);
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    releaseId: randomUUID(),
    domainId,
    reservationId: g.reservation.reservationId,
    reservationDigest: receipt.digest,
    sourceSiteId: sites[0],
    targetSiteId: sites[1],
    expectedGateVersion: 1,
    reason: "cancelled",
    issuedAt: now.toISOString(),
    salt: randomBytes(32).toString("hex"),
  });
  await expect(
    g.call(
      "ReleaseExecution",
      release.releaseId,
      await bilateral(CommercialReleaseSchema, release),
    ),
  ).rejects.toThrow("DATA_WAITING");
  const terminal = await terminalFixture(),
    opening = await nativeDispute(terminal, terminal.reservation.request),
    budget = terminal.budget();
  await opening.record();
  await terminal.record();
  expect(terminal.budget()).toEqual(budget);
});

async function arbitrationResolutionFixture() {
  const f = await arbitrationReservationFixture(true);
  await f.reserve(f.reservation);
  const dispute = await nativeDispute(f, f.request);
  await dispute.record();
  const second = await nativeDispute(f, f.request);
  await second.record();
  const [a, b, r] = keys;
  if (!a || !b || !r) throw new Error("Missing key");
  const digest = (jws: string) =>
    `sha256:${createHash("sha256")
      .update(Buffer.from(jws.split(".")[1] ?? "", "base64url"))
      .digest("hex")}`;
  const requestJws = await signFederationMessage(FederationDelegationSchema, f.request, a);
  const requestDigest = digest(requestJws);
  const accepted = FederationAcceptanceSchema.parse({
    protocolVersion: 1,
    kind: "acceptance",
    senderSiteId: sites[1],
    recipientSiteId: sites[0],
    operationId: f.request.operationId,
    agreementRevisionId: f.request.agreementRevisionId,
    mode: f.request.mode,
    budgetDomainId: f.request.budgetDomainId,
    epoch: f.request.epoch,
    taskId: f.request.taskId,
    attempt: f.request.attempt,
    requestDigest,
    reservationId: f.reservation.reservationId,
    reservedAmount: f.request.maxAmount,
    unit: f.request.unit,
    acceptedAt: now.toISOString(),
    status: "RESERVED",
  });
  const acceptanceJws = await signFederationMessage(FederationAcceptanceSchema, accepted, b);
  const make = async (d: typeof dispute) => {
    const freeze = await d.envelope();
    const decision = ArbitrationDecisionSchema.parse({
      protocolVersion: 1,
      kind: "arbitration-decision",
      issuedAt: now.toISOString(),
      basisExpiresAt: new Date(now.getTime() + 30000).toISOString(),
      basisDigest: `sha256:${"b".repeat(64)}`,
      intent: {
        decisionId: randomUUID(),
        binding: {
          caseId: d.opening.caseId,
          caseDigest: d.freeze.caseDigest,
          domainId,
          agreementRevisionId: f.request.agreementRevisionId,
          agreementDigest: f.receipt.digest,
          sourceSiteId: sites[0],
          targetSiteId: sites[1],
          arbitratorSiteId: sites[2],
          taskId: f.request.taskId,
          attempt: f.request.attempt,
          operationId: f.request.operationId,
          reservationId: f.reservation.reservationId,
          requestDigest,
          acceptanceDigest: digest(acceptanceJws),
          policyId: f.policy.policyId,
          policyDigest: f.binding.policyDigest,
          mode: f.request.mode,
          unit: f.request.unit,
        },
        subject: d.opening.subject,
        financial: {
          headDigest: d.freeze.headDigest,
          freezeDigest: digest(freeze.sourceJws),
          records: [],
          evidenceReferences: [],
          targets: [],
          ledgerReceipt: { recordId: d.opening.caseId, digest: digest(freeze.sourceJws) },
        },
        evidence: [
          {
            recordType: "bill",
            recordId: randomUUID(),
            recordDigest: `sha256:${"a".repeat(64)}`,
            grantId: randomUUID(),
            disclosureDigest: `sha256:${"b".repeat(64)}`,
            fields: ["dueAmount"],
          },
        ],
        outcome: { action: "resolve-without-financial-change" },
        reason: "Resolve without modifying finances",
        salt: randomBytes(32).toString("hex"),
      },
    });
    const decisionJws = await signFederationMessage(ArbitrationDecisionSchema, decision, r);
    const envelope = {
      sourceSiteId: sites[0],
      targetSiteId: sites[1],
      decisionJws,
      requestJws,
      acceptanceJws,
    };
    return {
      decision,
      envelope,
      resolve: () => f.call("ResolveArbitratedCase", decision.intent.decisionId, envelope),
    };
  };
  const taskKey = `commercial_AB_v1:${f.stub.createCompositeKey("dispute-task", [domainId, f.request.agreementRevisionId, f.request.taskId, String(f.request.attempt)])}`;
  const active = () =>
    z
      .object({ activeCases: z.number() })
      .parse(JSON.parse(Buffer.from(f.stub.privateState.get(taskKey) ?? []).toString()))
      .activeCases;
  return { ...f, dispute, second, make, active, first: await make(dispute) };
}

test("arbitration resolution decrements only its native case freeze with no budget mutation and immutable replay", async () => {
  const f = await arbitrationResolutionFixture(),
    before = f.budget();
  expect(f.active()).toBe(2);
  await f.first.resolve();
  expect(f.active()).toBe(1);
  expect(f.budget()).toEqual(before);
  await f.first.resolve();
  expect(f.active()).toBe(1);
  const other = await f.make(f.second);
  await other.resolve();
  expect(f.active()).toBe(0);
  expect(f.budget()).toEqual(before);
  const conflicting = await f.make(f.dispute);
  await expect(conflicting.resolve()).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.call(
      "ResolveArbitratedCase",
      f.first.decision.intent.decisionId,
      f.first.envelope,
      identity(2),
    ),
  ).rejects.toThrow("POLICY_DENIED");
});

test("arbitration resolution refuses revoked authority, altered heads and financial outcomes", async () => {
  const f = await arbitrationResolutionFixture();
  const signer = keys[2];
  if (!signer) throw new Error("Missing R");
  const d = f.first.decision;
  const altered = {
    ...d,
    intent: {
      ...d.intent,
      financial: { ...d.intent.financial, headDigest: `sha256:${"f".repeat(64)}` },
    },
  };
  await expect(
    f.call("ResolveArbitratedCase", d.intent.decisionId, {
      ...f.first.envelope,
      decisionJws: await signFederationMessage(ArbitrationDecisionSchema, altered, signer),
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const monetary = {
    ...d,
    intent: {
      ...d.intent,
      outcome: {
        action: "settle" as const,
        bill: { recordId: randomUUID(), recordDigest: `sha256:${"f".repeat(64)}` },
        chargedAmount: "1",
      },
    },
  };
  await expect(
    f.call("ResolveArbitratedCase", d.intent.decisionId, {
      ...f.first.envelope,
      decisionJws: await signFederationMessage(ArbitrationDecisionSchema, monetary, signer),
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await f.revoke(f.withdrawal());
  await expect(f.first.resolve()).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect(f.active()).toBe(2);
});
