import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type FabricMarketTrust, MarketDemandSchema } from "@kuintessence/shared/federation/market";
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
