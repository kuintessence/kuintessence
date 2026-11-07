import { beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type CommercialAgreement,
  CommercialAgreementSchema,
  CommercialReceiptSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  type CommercialUsage,
  CommercialUsageSchema,
  type FabricCommercialTrust,
  FabricCommercialTrustSchema,
  fabricCommercialCollections,
} from "@kuintessence/shared/federation/commercial";
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
        "commercial-usage",
        "commercial-reservation",
        "commercial-release",
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
  f.stub.market = { ...f.market, status: "ACTIVE", version: 3 };
  f.stub.timestamp = new Date(+now + 7200000);
  await expect(
    f.call(
      "ReleaseExecution",
      release.releaseId,
      await bilateral(CommercialReleaseSchema, release),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
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
