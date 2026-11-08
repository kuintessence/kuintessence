import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  type FabricMarketTrust,
  MarketDemandSchema,
  MarketDemandStateSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
  MarketExecutionStopSchema,
  MarketProposalInputSchema,
} from "@kuintessence/shared/federation/market";
import { MarketLedger } from "./contract";

const sites = [randomUUID(), randomUUID(), randomUUID()];
const now = new Date("2026-11-07T12:00:00.000Z");
const trust: FabricMarketTrust = {
  version: 1,
  generationId: randomUUID(),
  organizations: sites.map((siteId, index) => ({ siteId, mspId: `Org${index}MSP` })),
};
function identity(index = 0, role = "market") {
  return {
    getMSPID: () => `Org${index}MSP`,
    getAttributeValue: (name: string) =>
      name === "kq.federation.site"
        ? (sites[index] ?? null)
        : name === "kq.federation.role"
          ? role
          : null,
  };
}
class State {
  state = new Map<string, Uint8Array>();
  policies = new Map<string, Uint8Array>();
  params: string[] = [];
  fcn = "Init";
  transient = new Map<string, Uint8Array>();
  timestamp = now;
  getChannelID = () => "cooperation";
  onInvoke?: (
    name: string,
    args: string[],
    channel: string,
  ) => Promise<{ status: number; payload: Uint8Array }>;
  invokeChaincode = async (name: string, args: string[], channel: string) => {
    if (!this.onInvoke) throw new Error("Unexpected cross-chaincode call");
    return this.onInvoke(name, args, channel);
  };
  closed = 0;
  getStateByPartialCompositeKeyWithPagination = (
    _name: string,
    _parts: string[],
    limit: number,
    bookmark = "",
  ) => {
    const rows = [...this.state]
      .filter(([key]) => key.startsWith('["demand",'))
      .sort(([a], [b]) => a.localeCompare(b));
    const start = bookmark ? rows.findIndex(([key]) => key === bookmark) : 0;
    if (start < 0) throw new Error("Invalid fixture bookmark");
    const page = rows
      .slice(start, start + limit)
      .map(([key, value]) => ({ namespace: "market", key, value }));
    let index = 0;
    return Object.assign(
      Promise.resolve({
        metadata: { fetchedRecordsCount: page.length, bookmark: rows[start + limit]?.[0] ?? "" },
        iterator: {
          next: async () => ({
            value: page[index++] ?? { namespace: "market", key: "", value: new Uint8Array() },
            done: index > page.length,
          }),
          close: async () => {
            this.closed++;
          },
        },
      }),
      {
        [Symbol.asyncIterator]: async function* () {
          yield* page;
        },
      },
    );
  };
  getState = async (key: string) => this.state.get(key) ?? new Uint8Array();
  putState = async (key: string, value: Uint8Array) => {
    this.state.set(key, value);
  };
  createCompositeKey = (name: string, parts: string[]) => JSON.stringify([name, ...parts]);
  getFunctionAndParameters = () => ({ fcn: this.fcn, params: this.params });
  getDateTimestamp = () => this.timestamp;
  getTransient = () => this.transient;
  setStateValidationParameter = async (key: string, value: Uint8Array) => {
    this.policies.set(key, value);
  };
}
async function fixture() {
  const stub = new State(),
    ledger = new MarketLedger(trust);
  await ledger.initialize(stub, identity(0, "trust-admin"));
  const demand = MarketDemandSchema.parse({
    protocolVersion: 1,
    demandId: randomUUID(),
    sourceSiteId: sites[0],
    createdAt: now.toISOString(),
    expiresAt: new Date(+now + 3600000).toISOString(),
    title: "Public small computation",
    description: "Approved public summary",
    platform: "linux",
    architecture: "x86_64",
    resources: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
  });
  const invoke = async (fcn: string, value: unknown, index = 0, role = "market") => {
    stub.fcn = fcn;
    stub.params = [demand.demandId];
    stub.transient = new Map(
      value === undefined ? [] : [["market", Buffer.from(JSON.stringify(value))]],
    );
    return JSON.parse((await ledger.invoke(stub, identity(index, role))).toString());
  };
  const claim = (index = 1) => ({
    demandId: demand.demandId,
    claimId: randomUUID(),
    providerSiteId: sites[index],
    expectedVersion: 1,
    expiresAt: new Date(+now + 600000).toISOString(),
  });
  return { stub, ledger, demand, invoke, claim };
}
test("market publish and claim retries retain one immutable demand and one claimant", async () => {
  const f = await fixture();
  const published = await f.invoke("PublishDemand", f.demand);
  const claim = f.claim(),
    receipt = await f.invoke("ClaimDemand", claim, 1);
  expect(await f.invoke("ClaimDemand", claim, 1)).toEqual(receipt);
  expect(await f.invoke("PublishDemand", f.demand)).toEqual(published);
  expect(await f.invoke("GetDemand", undefined, 2)).toMatchObject({
    status: "CLAIMED",
    version: 2,
    claim,
  });
  await expect(f.invoke("ClaimDemand", f.claim(2), 2)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.invoke("ClaimDemand", { ...claim, expiresAt: f.demand.expiresAt }, 1),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.invoke("PublishDemand", { ...f.demand, title: "Changed" })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});
test("market binds organization role, public source and claimant identities", async () => {
  const f = await fixture();
  await expect(f.invoke("PublishDemand", f.demand, 1)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("PublishDemand", f.demand, 0, "commercial")).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await f.invoke("PublishDemand", f.demand);
  await expect(f.invoke("ClaimDemand", f.claim(0))).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("ClaimDemand", f.claim(1), 2)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("GetDemand", undefined, 4)).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect((await f.invoke("GetDemand", undefined, 1, "commercial")).status).toBe("OPEN");
});
test("expired claims never reopen automatically and stale versions cannot reserve", async () => {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const claim = f.claim();
  await expect(f.invoke("ClaimDemand", { ...claim, expectedVersion: 2 }, 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    f.invoke("ClaimDemand", { ...claim, expiresAt: now.toISOString() }, 1),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await expect(
    f.invoke("ClaimDemand", { ...claim, expiresAt: new Date(+now + 3600001).toISOString() }, 1),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await f.invoke("ClaimDemand", claim, 1);
  f.stub.timestamp = new Date(+now + 7200000);
  expect((await f.invoke("GetDemand", undefined)).status).toBe("CLAIMED");
  await expect(f.invoke("ClaimDemand", f.claim(2), 2)).rejects.toThrow("OPERATION_CONFLICT");
});
test("only publisher cancels an open demand and cancellation cannot release a claim", async () => {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const cancel = { demandId: f.demand.demandId, cancellationId: randomUUID(), expectedVersion: 1 };
  await expect(f.invoke("CancelOpenDemand", cancel, 1)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("CancelOpenDemand", { ...cancel, expectedVersion: 2 })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const receipt = await f.invoke("CancelOpenDemand", cancel);
  expect(await f.invoke("CancelOpenDemand", cancel)).toEqual(receipt);
  await expect(f.invoke("ClaimDemand", f.claim(), 1)).rejects.toThrow("OPERATION_CONFLICT");
  const g = await fixture();
  await g.invoke("PublishDemand", g.demand);
  await g.invoke("ClaimDemand", g.claim(), 1);
  await expect(
    g.invoke("CancelOpenDemand", { ...cancel, demandId: g.demand.demandId, expectedVersion: 2 }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});
test("public market rejects private fields, oversized payloads and undeveloped activation", async () => {
  const f = await fixture();
  await expect(f.invoke("PublishDemand", { ...f.demand, price: "private" })).rejects.toThrow();
  await expect(
    f.invoke("PublishDemand", {
      ...f.demand,
      resources: { ...f.demand.resources, contract: "private" },
    }),
  ).rejects.toThrow();
  await expect(
    f.invoke("PublishDemand", { ...f.demand, description: "x".repeat(33000) }),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(f.invoke("Activate", f.claim())).rejects.toThrow("INVALID_MESSAGE");
  expect(f.stub.state.size).toBe(1);
});
test("market trust changes and duplicate initialization are refused", async () => {
  const f = await fixture();
  await expect(
    new MarketLedger({ ...trust, generationId: randomUUID() }).invoke(f.stub, identity()),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(f.ledger.initialize(f.stub, identity(0, "trust-admin"))).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(f.stub.policies.size).toBe(1);
  const organization = trust.organizations[0];
  if (!organization) throw new Error("Missing market organization");
  expect(
    () =>
      new MarketLedger({
        ...trust,
        organizations: [organization, organization],
      }),
  ).toThrow();
});

test("market public directory paginates only demand keys and closes iterators without writes", async () => {
  const f = await fixture();
  const second = { ...f.demand, demandId: randomUUID() };
  await f.invoke("PublishDemand", f.demand);
  f.stub.params = [second.demandId];
  f.stub.transient = new Map([["market", Buffer.from(JSON.stringify(second))]]);
  await f.ledger.invoke(f.stub, identity());
  const before = new Map(f.stub.state);
  const list = async (bookmark: string, role = "market") => {
    f.stub.fcn = "ListDemands";
    f.stub.params = ["1", bookmark];
    f.stub.transient.clear();
    return JSON.parse((await f.ledger.invoke(f.stub, identity(2, role))).toString());
  };
  const first = await list("");
  expect(first.demands).toHaveLength(1);
  expect(first.bookmark).not.toBe("");
  const last = await list(first.bookmark, "commercial");
  expect(last.demands).toHaveLength(1);
  expect(last.bookmark).toBe("");
  expect(new Set([first.demands[0].demand.demandId, last.demands[0].demand.demandId])).toEqual(
    new Set([f.demand.demandId, second.demandId]),
  );
  expect(f.stub.closed).toBe(2);
  expect(f.stub.state).toEqual(before);
  await expect(list("", "evidence")).rejects.toThrow("UNTRUSTED_IDENTITY");
  f.stub.params = ["51", ""];
  await expect(f.ledger.invoke(f.stub, identity())).rejects.toThrow();
  f.stub.params = ["1", ""];
  f.stub.transient.set("private", Buffer.from("forbidden"));
  await expect(f.ledger.invoke(f.stub, identity())).rejects.toThrow("INVALID_MESSAGE");
});

test("market activation requires the current same-channel private gate hash and remains immutable", async () => {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const claim = { ...f.claim(), commercialDomainId: randomUUID() };
  await f.invoke("ClaimDemand", claim, 1);
  const gate = {
    domainId: claim.commercialDomainId,
    reservationId: claim.claimId,
    demandId: f.demand.demandId,
    claimVersion: 2,
    version: 1,
    state: "READY",
    reservationDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: claim.expiresAt,
  };
  let hash = "0".repeat(64);
  f.stub.onInvoke = async (name, args, channel) => {
    expect([name, ...args, channel]).toEqual([
      "kq-commercial",
      "GetExecutionGateHash",
      gate.domainId,
      gate.reservationId,
      "cooperation",
    ]);
    return { status: 200, payload: Buffer.from(JSON.stringify({ hash })) };
  };
  const activation = {
    demandId: f.demand.demandId,
    activationId: randomUUID(),
    expectedVersion: 2,
    gate,
  };
  await expect(f.invoke("ActivateDemand", activation, 1)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("ActivateDemand", activation)).rejects.toThrow("OPERATION_CONFLICT");
  hash = createHash("sha256").update(JSON.stringify(gate)).digest("hex");
  const receipt = await f.invoke("ActivateDemand", activation);
  expect((await f.invoke("GetDemand", undefined)).status).toBe("ACTIVE");
  hash = "0".repeat(64);
  expect(await f.invoke("ActivateDemand", activation)).toEqual(receipt);
  await expect(
    f.invoke("ActivateDemand", { ...activation, activationId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

async function activated() {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const claim = { ...f.claim(), commercialDomainId: randomUUID() };
  await f.invoke("ClaimDemand", claim, 1);
  const gate = MarketExecutionGateSchema.parse({
    domainId: claim.commercialDomainId,
    reservationId: claim.claimId,
    demandId: f.demand.demandId,
    claimVersion: 2,
    version: 1,
    state: "READY",
    reservationDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: claim.expiresAt,
  });
  f.stub.onInvoke = async () => ({
    status: 200,
    payload: Buffer.from(
      JSON.stringify({ hash: createHash("sha256").update(JSON.stringify(gate)).digest("hex") }),
    ),
  });
  const activationId = randomUUID();
  await f.invoke("ActivateDemand", {
    demandId: f.demand.demandId,
    activationId,
    expectedVersion: 2,
    gate,
  });
  const authorization = MarketExecutionAuthorizationSchema.parse({
    demandId: f.demand.demandId,
    authorizationId: randomUUID(),
    issuerSiteId: sites[1],
    activationId,
    gate,
    issuedAt: now.toISOString(),
    expiresAt: new Date(+now + 300000).toISOString(),
  });
  return { ...f, authorization, gate, activationId };
}

test("either execution participant can stop; both requests converge without releasing or renewing", async () => {
  for (const first of [0, 1]) {
    const f = await activated();
    await f.invoke("AuthorizeExecution", f.authorization, 1);
    const previous = await f.invoke("GetDemand", undefined);
    const count = f.stub.state.size;
    const requests = [0, 1].map((index) =>
      MarketExecutionStopSchema.parse({
        demandId: f.demand.demandId,
        stopId: randomUUID(),
        issuerSiteId: sites[index],
        activationId: f.authorization.activationId,
        expectedVersion: 3,
      }),
    );
    for (const index of [first, 1 - first]) {
      const request = requests[index];
      const receipt = await f.invoke("RequestExecutionStop", request, index);
      expect(receipt.recordId).toBe(request?.stopId);
      expect(await f.invoke("RequestExecutionStop", request, index)).toEqual(receipt);
      await expect(
        f.invoke("RequestExecutionStop", { ...request, stopId: randomUUID() }, index),
      ).rejects.toThrow("OPERATION_CONFLICT");
    }
    const current = await f.invoke("GetDemand", undefined);
    expect(current).toEqual({
      ...previous,
      version: 4,
      status: "STOPPING",
      stopRequest: requests[first],
    });
    for (const malformed of [
      { ...current, stopRequest: undefined },
      { ...current, stopRequest: { ...requests[first], issuerSiteId: sites[2] } },
      { ...current, version: 5 },
    ])
      expect(MarketDemandStateSchema.safeParse(malformed).success).toBe(false);
    expect(f.stub.state.size).toBe(count + 2);
    for (const index of [0, 1])
      await expect(
        f.invoke(
          "AuthorizeExecution",
          { ...f.authorization, issuerSiteId: sites[index], authorizationId: randomUUID() },
          index,
        ),
      ).rejects.toThrow("OPERATION_CONFLICT");
    await expect(
      f.invoke("CancelOpenDemand", {
        demandId: f.demand.demandId,
        cancellationId: randomUUID(),
        expectedVersion: 4,
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await expect(f.invoke("ClaimDemand", { ...f.claim(2), expectedVersion: 4 }, 2)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
  }
});

test("stop binds the activation, organization and public schema but remains possible after execution expiry", async () => {
  const f = await activated();
  const stop = MarketExecutionStopSchema.parse({
    demandId: f.demand.demandId,
    stopId: randomUUID(),
    issuerSiteId: sites[0],
    activationId: f.authorization.activationId,
    expectedVersion: 3,
  });
  const before = [...f.stub.state];
  for (const input of [
    { ...stop, activationId: randomUUID() },
    { ...stop, expectedVersion: 2 },
  ])
    await expect(f.invoke("RequestExecutionStop", input)).rejects.toThrow("OPERATION_CONFLICT");
  for (const [input, index] of [
    [stop, 1],
    [{ ...stop, issuerSiteId: sites[2] }, 2],
  ] as const)
    await expect(f.invoke("RequestExecutionStop", input, index)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("RequestExecutionStop", stop, 0, "commercial")).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  for (const input of [
    { ...stop, price: "private" },
    { ...stop, reason: "private contract detail" },
  ])
    await expect(f.invoke("RequestExecutionStop", input)).rejects.toThrow();
  expect(
    MarketProposalInputSchema.safeParse({ operation: "request-execution-stop", stop }).success,
  ).toBe(false);
  expect([...f.stub.state]).toEqual(before);
  f.stub.timestamp = new Date(+now + 7200000);
  f.stub.onInvoke = async () => {
    throw new Error("Stop must not depend on the commercial gate query");
  };
  const receipt = await f.invoke("RequestExecutionStop", stop);
  expect(await f.invoke("RequestExecutionStop", stop)).toEqual(receipt);
  const key = f.stub.createCompositeKey("demand", [f.demand.demandId]);
  const latest = {
    ...(await f.invoke("GetDemand", undefined)),
    activation: null,
    status: "OPEN",
    stopRequest: undefined,
    claim: null,
    version: 5,
  };
  await f.stub.putState(key, Buffer.from(JSON.stringify(latest)));
  expect(await f.invoke("RequestExecutionStop", stop)).toEqual(receipt);
  expect(await f.invoke("GetDemand", undefined)).toEqual(JSON.parse(JSON.stringify(latest)));
});

test("a stop cannot cancel an OPEN or merely CLAIMED demand", async () => {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const stop = {
    demandId: f.demand.demandId,
    stopId: randomUUID(),
    issuerSiteId: sites[0],
    activationId: randomUUID(),
    expectedVersion: 1,
  };
  await expect(f.invoke("RequestExecutionStop", stop)).rejects.toThrow("OPERATION_CONFLICT");
  await f.invoke("ClaimDemand", f.claim(), 1);
  await expect(f.invoke("RequestExecutionStop", { ...stop, expectedVersion: 2 })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("execution confirmations bind current activation, issuer and private gate without exposing private terms", async () => {
  const f = await activated();
  const receipt = await f.invoke("AuthorizeExecution", f.authorization, 1);
  expect(await f.invoke("AuthorizeExecution", f.authorization, 1)).toEqual(receipt);
  const size = f.stub.state.size;
  for (const input of [
    { ...f.authorization, activationId: randomUUID() },
    { ...f.authorization, gate: { ...f.authorization.gate, reservationId: randomUUID() } },
    { ...f.authorization, expiresAt: new Date(+now + 200000).toISOString() },
  ])
    await expect(f.invoke("AuthorizeExecution", input, 1)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.invoke("AuthorizeExecution", f.authorization, 0)).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.invoke("AuthorizeExecution", { ...f.authorization, issuerSiteId: sites[2] }, 2),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.invoke("AuthorizeExecution", { ...f.authorization, price: "private" }, 1),
  ).rejects.toThrow();
  expect(f.stub.state.size).toBe(size);
  f.stub.onInvoke = async () => ({
    status: 200,
    payload: Buffer.from(JSON.stringify({ hash: "0".repeat(64) })),
  });
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  f.stub.onInvoke = async () => ({ status: 500, payload: Buffer.alloc(0) });
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "LEDGER_REQUIRED",
  );
});

test("confirmation renewals retain one latest state per party and cannot extend an old authorization", async () => {
  const f = await activated();
  await f.invoke("AuthorizeExecution", f.authorization, 1);
  const size = f.stub.state.size;
  f.stub.timestamp = new Date(+now + 1000);
  const renewed = {
    ...f.authorization,
    authorizationId: randomUUID(),
    issuedAt: f.stub.timestamp.toISOString(),
    expiresAt: new Date(+f.stub.timestamp + 300000).toISOString(),
  };
  await f.invoke("AuthorizeExecution", renewed, 1);
  expect(f.stub.state.size).toBe(size);
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.invoke("AuthorizeExecution", {
    ...renewed,
    issuerSiteId: sites[0],
    authorizationId: randomUUID(),
  });
  expect(f.stub.state.size).toBe(size + 1);
  f.stub.timestamp = new Date(+now + 400000);
  await expect(f.invoke("AuthorizeExecution", renewed, 1)).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("confirmation requires ACTIVE, enforces a five-minute ceiling and rejects stale or future proposals", async () => {
  const f = await activated();
  await expect(
    f.invoke(
      "AuthorizeExecution",
      {
        ...f.authorization,
        expiresAt: new Date(+now + 300001).toISOString(),
      },
      1,
    ),
  ).rejects.toThrow();
  await expect(
    f.invoke(
      "AuthorizeExecution",
      {
        ...f.authorization,
        issuedAt: new Date(+now + 1).toISOString(),
      },
      1,
    ),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  f.stub.timestamp = new Date(+now + 60001);
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  f.stub.timestamp = now;
  const key = f.stub.createCompositeKey("demand", [f.demand.demandId]);
  const state = await f.invoke("GetDemand", undefined);
  await f.stub.putState(key, Buffer.from(JSON.stringify({ ...state, status: "CLAIMED" })));
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test.each([
  false,
  true,
])("terminal gate closes an activation once, including after stop=%s", async (stopped) => {
  const f = await activated();
  if (stopped)
    await f.invoke("RequestExecutionStop", {
      demandId: f.demand.demandId,
      stopId: randomUUID(),
      issuerSiteId: sites[0],
      activationId: f.activationId,
      expectedVersion: 3,
    });
  const gate = MarketExecutionGateSchema.parse({
    ...f.gate,
    state: "TERMINAL",
    version: 2,
    terminal: {
      terminalId: randomUUID(),
      activationId: f.activationId,
      digest: `sha256:${"f".repeat(64)}`,
    },
  });
  if (!gate.terminal) throw new Error("Missing terminal");
  const closure = {
    demandId: f.demand.demandId,
    closureId: gate.terminal.terminalId,
    expectedVersion: 3,
    gate,
  };
  await expect(f.invoke("CloseDemand", closure, 2)).rejects.toThrow("POLICY_DENIED");
  await expect(f.invoke("CloseDemand", closure)).rejects.toThrow("OPERATION_CONFLICT");
  f.stub.onInvoke = async (name, args, channel) => {
    expect([name, ...args, channel]).toEqual([
      "kq-commercial",
      "GetExecutionGateHash",
      gate.domainId,
      gate.reservationId,
      "cooperation",
    ]);
    return {
      status: 200,
      payload: Buffer.from(
        JSON.stringify({ hash: createHash("sha256").update(JSON.stringify(gate)).digest("hex") }),
      ),
    };
  };
  for (const patch of [
    { expectedVersion: 4 },
    { gate: { ...gate, version: 3 } },
    { gate: { ...gate, terminal: { ...gate.terminal, activationId: randomUUID() } } },
  ])
    await expect(f.invoke("CloseDemand", { ...closure, ...patch })).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
  const receipt = await f.invoke("CloseDemand", closure, 1);
  const state = await f.invoke("GetDemand", undefined);
  expect(state).toMatchObject({ status: "CLOSED", version: stopped ? 5 : 4, closure });
  expect(MarketDemandStateSchema.safeParse(state).success).toBe(true);
  f.stub.onInvoke = async () => {
    throw new Error("Historical replay must not require current gate");
  };
  expect(await f.invoke("CloseDemand", closure)).toEqual(receipt);
  await expect(f.invoke("AuthorizeExecution", f.authorization, 1)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(f.invoke("ClaimDemand", f.claim(2), 2)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(
    f.invoke(
      "RequestExecutionStop",
      {
        demandId: f.demand.demandId,
        stopId: randomUUID(),
        issuerSiteId: sites[1],
        activationId: f.activationId,
        expectedVersion: 3,
      },
      1,
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.invoke("GetDemand", undefined)).version).toBe(state.version);
});

test("pre-execution closure requires a committed revoked gate and prevents every later activation", async () => {
  const f = await fixture();
  await f.invoke("PublishDemand", f.demand);
  const claim = { ...f.claim(), commercialDomainId: randomUUID() };
  await f.invoke("ClaimDemand", claim, 1);
  const gate = MarketExecutionGateSchema.parse({
    domainId: claim.commercialDomainId,
    reservationId: claim.claimId,
    demandId: claim.demandId,
    claimVersion: 2,
    version: 2,
    state: "REVOKED",
    reservationDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: claim.expiresAt,
  });
  const closure = { demandId: claim.demandId, closureId: randomUUID(), expectedVersion: 2, gate };
  let hash = "0".repeat(64);
  f.stub.onInvoke = async (name, args, channel) => {
    expect([name, ...args, channel]).toEqual([
      "kq-commercial",
      "GetExecutionGateHash",
      gate.domainId,
      gate.reservationId,
      "cooperation",
    ]);
    return { status: 200, payload: Buffer.from(JSON.stringify({ hash })) };
  };
  await expect(f.invoke("CloseDemand", closure)).rejects.toThrow("OPERATION_CONFLICT");
  for (const caller of [1, 2])
    await expect(f.invoke("CloseDemand", closure, caller)).rejects.toThrow("POLICY_DENIED");
  for (const changed of [
    { ...closure, expectedVersion: 3 },
    { ...closure, gate: { ...gate, version: 3 } },
    { ...closure, gate: { ...gate, reservationId: randomUUID() } },
    { ...closure, gate: { ...gate, domainId: randomUUID() } },
    { ...closure, contract: "private" },
  ])
    await expect(f.invoke("CloseDemand", changed)).rejects.toThrow();
  hash = createHash("sha256").update(JSON.stringify(gate)).digest("hex");
  f.stub.timestamp = new Date(+now + 7200000);
  const receipt = await f.invoke("CloseDemand", closure);
  const closed = await f.invoke("GetDemand", undefined);
  expect(closed).toMatchObject({ status: "CLOSED", version: 3, activation: null, closure });
  expect(MarketDemandStateSchema.safeParse(closed).success).toBe(true);
  expect(MarketProposalInputSchema.safeParse({ operation: "close-demand", closure }).success).toBe(
    false,
  );
  f.stub.onInvoke = async () => {
    throw new Error("Replay must not access private state");
  };
  expect(await f.invoke("CloseDemand", closure)).toEqual(receipt);
  await expect(f.invoke("CloseDemand", { ...closure, closureId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    f.invoke("ActivateDemand", {
      demandId: claim.demandId,
      activationId: randomUUID(),
      expectedVersion: 2,
      gate: { ...gate, state: "READY", version: 1 },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.invoke("ClaimDemand", f.claim(2), 2)).rejects.toThrow("OPERATION_CONFLICT");
  for (const changed of [
    { ...closed, version: 4 },
    { ...closed, claim: { ...closed.claim, claimId: randomUUID() } },
    { ...closed, closure: { ...closure, expectedVersion: 3 } },
  ])
    expect(MarketDemandStateSchema.safeParse(changed).success).toBe(false);
});

test("pre-execution closure cannot replace termination of an active task", async () => {
  const f = await activated();
  await expect(
    f.invoke("CloseDemand", {
      demandId: f.demand.demandId,
      closureId: randomUUID(),
      expectedVersion: 2,
      gate: { ...f.authorization.gate, state: "REVOKED", version: 2 },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.invoke("GetDemand", undefined)).status).toBe("ACTIVE");
});

test("unreserved closure binds the claimant and explicit absence; either participant can close but a funded gate cannot", async () => {
  for (const issuer of [0, 1]) {
    const f = await fixture();
    await f.invoke("PublishDemand", f.demand);
    const claim = { ...f.claim(), commercialDomainId: randomUUID() };
    await f.invoke("ClaimDemand", claim, 1);
    const closure = {
      demandId: f.demand.demandId,
      closureId: randomUUID(),
      claimId: claim.claimId,
      commercialDomainId: claim.commercialDomainId,
      issuerSiteId: sites[issuer],
      expectedVersion: 2,
    };
    let response: { status: number; payload: Buffer } = {
      status: 500,
      payload: Buffer.from("ASSET_UNAVAILABLE"),
    };
    f.stub.onInvoke = async (name, args, channel) => {
      expect([name, ...args, channel]).toEqual([
        "kq-commercial",
        "GetExecutionGatePresence",
        claim.commercialDomainId,
        claim.claimId,
        "cooperation",
      ]);
      return response;
    };
    await expect(f.invoke("CloseUnreservedDemand", closure, issuer)).rejects.toThrow(
      "LEDGER_REQUIRED",
    );
    response = { status: 200, payload: Buffer.from(JSON.stringify({ hash: "a".repeat(64) })) };
    await expect(f.invoke("CloseUnreservedDemand", closure, issuer)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    response = { status: 200, payload: Buffer.from(JSON.stringify({ hash: null })) };
    await expect(
      f.invoke("CloseUnreservedDemand", { ...closure, issuerSiteId: sites[2] }, 2),
    ).rejects.toThrow("POLICY_DENIED");
    for (const patch of [
      { claimId: randomUUID() },
      { commercialDomainId: randomUUID() },
      { expectedVersion: 1 },
    ])
      await expect(
        f.invoke("CloseUnreservedDemand", { ...closure, ...patch }, issuer),
      ).rejects.toThrow("OPERATION_CONFLICT");
    const receipt = await f.invoke("CloseUnreservedDemand", closure, issuer);
    expect(await f.invoke("CloseUnreservedDemand", closure, issuer)).toEqual(receipt);
    const state = await f.invoke("GetDemand", undefined);
    expect(state).toMatchObject({
      status: "CLOSED",
      version: 3,
      activation: null,
      claim,
      unreservedClosure: closure,
    });
    expect(MarketDemandStateSchema.safeParse(state).success).toBe(true);
    for (const patch of [
      { status: "CLAIMED" },
      { version: 4 },
      { claim: null },
      {
        cancellation: {
          demandId: f.demand.demandId,
          cancellationId: randomUUID(),
          expectedVersion: 1,
        },
      },
    ])
      expect(MarketDemandStateSchema.safeParse({ ...state, ...patch }).success).toBe(false);
    expect(
      MarketDemandStateSchema.safeParse({
        ...state,
        unreservedClosure: { ...closure, issuerSiteId: sites[2] },
      }).success,
    ).toBe(false);
    await expect(
      f.invoke("CloseUnreservedDemand", { ...closure, closureId: randomUUID() }, issuer),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await expect(f.invoke("ClaimDemand", f.claim(2), 2)).rejects.toThrow("OPERATION_CONFLICT");
  }
});
