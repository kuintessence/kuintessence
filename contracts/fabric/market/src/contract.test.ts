import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  type FabricMarketTrust,
  MarketDemandSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
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
  return { ...f, authorization };
}

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
