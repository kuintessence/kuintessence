import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  federationMarketAttempts as attempts,
  auditLog,
  federationUnreservedClosures as closures,
  createPgDb,
  federationSites,
  orgs,
  federationMarketSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  type MarketAdapterProposalInput,
  type MarketAdvanceResult,
  MarketDemandSchema,
  MarketDemandStateSchema,
  type MarketProposalInput,
  type MarketQueryInput,
  type MarketQueryResult,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationMarketRoutes } from "../routes/federation-market";
import { federationMaterialDigest } from "./assets";
import { FabricClientFailure } from "./fabric-client";
import { FederationMarketService } from "./market";
import type { MarketClient } from "./market-client";
import { FederationPermissionService } from "./permissions";
import { assertUnreservedDemandOpen, observeUnreservedClosure } from "./unreserved-closure";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Market tests require isolated kuintessence_unit_* database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
afterAll(() => db.$client.end());
class Adapter implements MarketClient {
  queries = 0;
  onQuery?: (input: MarketQueryInput) => Promise<MarketQueryResult>;
  async query(input: MarketQueryInput): Promise<MarketQueryResult> {
    this.queries++;
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    if (this.onQuery) return this.onQuery(input);
    return input.operation === "get-demand"
      ? { operation: "get-demand", demand: null }
      : { operation: "list-demands", demands: [], bookmark: "" };
  }
  prepares = 0;
  advances = 0;
  outcome: "pending" | "committed" | "invalid" = "committed";
  offline = false;
  onPrepare?: () => Promise<void>;
  onAdvance?: () => Promise<void>;
  async prepare(_input: MarketAdapterProposalInput) {
    this.prepares++;
    await this.onPrepare?.();
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const transactionId = randomBytes(32).toString("hex");
    return { transactionId, recovery: Buffer.from(`proposal:${transactionId}`).toString("base64") };
  }
  async advance(recovery: string): Promise<MarketAdvanceResult> {
    this.advances++;
    const [stage, id] = Buffer.from(recovery, "base64").toString().split(":");
    if (!id) throw new Error("Missing test transaction");
    const [saved] = await db.select().from(attempts).where(eq(attempts.transactionId, id));
    expect(saved?.recovery).toBe(recovery);
    expect(saved?.stage).toBe(stage);
    await this.onAdvance?.();
    if (this.offline) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    if (stage === "proposal")
      return {
        state: "prepared",
        transactionId: id,
        recovery: Buffer.from(`transaction:${id}`).toString("base64"),
      };
    if (this.outcome === "pending") return { state: "pending", transactionId: id, recovery };
    if (this.outcome === "invalid")
      return { state: "invalid", transactionId: id, validationCode: 11, blockNumber: "8" };
    return { state: "committed", transactionId: id, blockNumber: "9" };
  }
}
async function fixture(grant = true) {
  const actor = { orgId: randomUUID(), userId: randomUUID() },
    siteId = randomUUID();
  await db.insert(orgs).values({ id: actor.orgId, name: "Market isolation" });
  await db.insert(users).values({
    id: actor.userId,
    orgId: actor.orgId,
    email: `${actor.userId}@test.invalid`,
    role: "platform_admin",
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
  const permissions = new FederationPermissionService(db);
  if (grant)
    await permissions.set({ ...actor, capability: "market.publish", enabled: true }, actor.userId);
  const adapter = new Adapter(),
    service = new FederationMarketService(db, siteId, adapter);
  const input: MarketProposalInput = {
    operation: "publish-demand",
    demand: MarketDemandSchema.parse({
      protocolVersion: 1,
      demandId: randomUUID(),
      sourceSiteId: siteId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      title: "Explicit public task",
      description: "Approved public summary",
      platform: "linux",
      architecture: "x86_64",
      resources: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
    }),
  };
  const id = input.demand.demandId;
  const due = () =>
    db
      .update(submissions)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(submissions.id, id));
  const view = () => service.get(actor, id);
  return { actor, siteId, permissions, adapter, service, input, id, due, view };
}
test("market enqueue is concurrent-idempotent, immutable, audited and organization-scoped", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 6 }, () => f.service.enqueue(f.actor, f.input)));
  expect(await db.select().from(submissions).where(eq(submissions.id, f.id))).toHaveLength(1);
  expect(await db.select().from(auditLog).where(eq(auditLog.target, f.id))).toHaveLength(1);
  expect(f.adapter.prepares).toBe(0);
  const view = await f.view();
  expect(view.operation.state).toBe("pending");
  expect(JSON.stringify(view)).not.toContain("leaseToken");
  expect(JSON.stringify(view)).not.toContain("recovery");
  const changed = { ...f.input, demand: { ...f.input.demand, title: "Changed" } };
  await expect(f.service.enqueue(f.actor, changed)).rejects.toThrow("OPERATION_CONFLICT");
  const foreign = await fixture();
  await expect(f.service.enqueue(foreign.actor, f.input)).rejects.toThrow("POLICY_DENIED");
  await expect(f.service.get(foreign.actor, f.id)).rejects.toThrow("ASSET_UNAVAILABLE");
  expect((await f.service.list(foreign.actor, 10, 0)).data).toHaveLength(0);
});
test("market persists every checkpoint and resumes the same submitted transaction after offline and restart", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  expect(await new FederationMarketService(db, f.siteId).advanceNext()).toBe(false);
  await f.service.advanceNext();
  await new FederationMarketService(db, f.siteId, f.adapter).advanceNext();
  const before = (await f.view()).transactions[0];
  expect(before?.stage).toBe("transaction");
  f.adapter.outcome = "pending";
  await f.service.advanceNext();
  expect((await f.view()).operation.lastError).toBe("LEDGER_PENDING");
  await f.due();
  f.adapter.offline = true;
  await f.service.advanceNext();
  expect((await f.view()).operation.state).toBe("pending");
  await f.due();
  f.adapter.offline = false;
  f.adapter.outcome = "committed";
  await new FederationMarketService(db, f.siteId, f.adapter).advanceNext();
  const final = await f.view();
  expect(final.operation.state).toBe("committed");
  expect(final.transactions).toHaveLength(1);
  expect(final.transactions[0]?.transactionId).toBe(before?.transactionId);
  expect(f.adapter.prepares).toBe(1);
  expect(await f.service.advanceNext()).toBe(false);
});
test("market lease fences concurrent workers and stale prepare replies", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  let started!: () => void, release!: () => void;
  const begun = new Promise<void>((r) => {
      started = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  f.adapter.onPrepare = async () => {
    started();
    await wait;
  };
  const stale = f.service.advanceNext();
  await begun;
  expect(await new FederationMarketService(db, f.siteId, f.adapter).advanceNext()).toBe(false);
  await db
    .update(submissions)
    .set({ leaseUntil: new Date(0) })
    .where(eq(submissions.id, f.id));
  f.adapter.onPrepare = undefined;
  await new FederationMarketService(db, f.siteId, f.adapter).advanceNext();
  release();
  await stale;
  expect((await f.view()).transactions).toHaveLength(1);
  expect((await db.select().from(attempts).where(eq(attempts.submissionId, f.id)))[0]?.number).toBe(
    1,
  );
});
test("market review retries never abandon an unknown submitted result and preserve invalid history", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  await f.service.advanceNext();
  await f.service.advanceNext();
  const before = (await f.view()).transactions[0];
  f.adapter.onAdvance = async () => {
    throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
  };
  await f.service.advanceNext();
  expect((await f.view()).operation.state).toBe("needs_review");
  await f.service.retry(f.actor, f.id);
  f.adapter.onAdvance = undefined;
  f.adapter.outcome = "invalid";
  await f.service.advanceNext();
  expect((await f.view()).transactions[0]?.transactionId).toBe(before?.transactionId);
  expect((await f.view()).transactions[0]?.stage).toBe("invalid");
  await f.service.retry(f.actor, f.id);
  await f.service.advanceNext();
  expect((await f.view()).transactions).toHaveLength(2);
  expect((await f.view()).transactions[1]?.stage).toBe("invalid");
});
test("market privileges are explicit; claim grant does not publish or cancel another organization demand", async () => {
  const f = await fixture(false);
  await expect(f.service.enqueue(f.actor, f.input)).rejects.toThrow("POLICY_DENIED");
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: true },
    f.actor.userId,
  );
  await expect(f.service.enqueue(f.actor, f.input)).rejects.toThrow("POLICY_DENIED");
  const claim: MarketProposalInput = {
    operation: "claim-demand",
    claim: {
      demandId: randomUUID(),
      claimId: randomUUID(),
      providerSiteId: f.siteId,
      expectedVersion: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  await f.service.enqueue(f.actor, claim);
  expect((await f.service.list(f.actor, 10, 0)).data).toHaveLength(1);
  await expect(
    f.service.enqueue(f.actor, {
      ...claim,
      claim: { ...claim.claim, claimId: randomUUID(), providerSiteId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await f.permissions.set(
    { ...f.actor, capability: "market.publish", enabled: true },
    f.actor.userId,
  );
  await expect(
    f.service.enqueue(f.actor, {
      operation: "cancel-open-demand",
      cancellation: { demandId: randomUUID(), cancellationId: randomUUID(), expectedVersion: 1 },
    }),
  ).rejects.toThrow("ASSET_UNAVAILABLE");
  await f.service.enqueue(f.actor, f.input);
  const cancellation = {
    operation: "cancel-open-demand" as const,
    cancellation: { demandId: f.id, cancellationId: randomUUID(), expectedVersion: 1 },
  };
  await expect(f.service.enqueue(f.actor, cancellation)).rejects.toThrow("ASSET_UNAVAILABLE");
  await db.update(submissions).set({ state: "committed" }).where(eq(submissions.id, f.id));
  await f.service.enqueue(f.actor, cancellation);
  await f.permissions.set(
    { ...f.actor, capability: "market.publish", enabled: false },
    f.actor.userId,
  );
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: false },
    f.actor.userId,
  );
  await expect(f.view()).rejects.toThrow("POLICY_DENIED");
});
test("market HTTP requires human organization context and only projects public operation fields", async () => {
  const f = await fixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { userId: f.actor.userId, orgId: f.actor.orgId } as never);
    if (c.req.header("x-test-automation")) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/api", createFederationMarketRoutes(f.service));
  const base = "/api/federation/market/operations";
  const submitted = await app.request(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.input),
  });
  expect(submitted.status).toBe(202);
  expect(submitted.headers.get("cache-control")).toBe("no-store");
  await f.service.advanceNext();
  const response = await app.request(`${base}/${f.id}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("recovery");
  expect(text).not.toContain("leaseToken");
  expect(text).toContain("transactionId");
  expect((await app.request(base, { headers: { "x-test-automation": "1" } })).status).toBe(403);
  expect(
    (
      await app.request(`${base}/${f.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"state":"committed"}',
      })
    ).status,
  ).toBe(400);
});

test("market commits status with the transaction result atomically and rejects an unrelated transaction response", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  await f.service.advanceNext();
  await f.service.advanceNext();
  const before = (await f.view()).transactions[0];
  const bad: MarketClient = {
    query: (input) => f.adapter.query(input),
    prepare: (input) => f.adapter.prepare(input),
    advance: async () => ({ state: "committed", transactionId: "0".repeat(64), blockNumber: "10" }),
  };
  await new FederationMarketService(db, f.siteId, bad).advanceNext();
  expect((await f.view()).operation.lastError).toBe("INVALID_ADAPTER_RESPONSE");
  expect((await f.view()).transactions[0]).toEqual(before);
  await f.service.retry(f.actor, f.id);
  const constraint = `market_test_${randomBytes(8).toString("hex")}`;
  await db.execute(
    sql.raw(
      `ALTER TABLE federation_market_submissions ADD CONSTRAINT ${constraint} CHECK (id <> '${f.id}' OR state <> 'committed')`,
    ),
  );
  try {
    await f.service.advanceNext();
    const rollback = await f.view();
    expect(rollback.operation.state).toBe("pending");
    expect(rollback.transactions[0]).toEqual(before);
  } finally {
    await db.execute(
      sql.raw(`ALTER TABLE federation_market_submissions DROP CONSTRAINT ${constraint}`),
    );
  }
  await f.due();
  await f.service.advanceNext();
  expect((await f.view()).operation.state).toBe("committed");
  expect((await f.view()).transactions).toHaveLength(1);
  expect(f.adapter.prepares).toBe(1);
});

test("market directory rechecks scoped read permission after network and never converts outage into empty state", async () => {
  const f = await fixture(false);
  const query: MarketQueryInput = { operation: "list-demands", limit: 1, bookmark: "" };
  await expect(f.service.query(f.actor, query)).rejects.toThrow("POLICY_DENIED");
  expect(f.adapter.queries).toBe(0);
  await f.permissions.set({ ...f.actor, capability: "market.read", enabled: true }, f.actor.userId);
  expect(await f.service.query(f.actor, query)).toMatchObject({
    operation: "list-demands",
    demands: [],
    bookmark: "",
    observedAt: expect.any(String),
  });
  await expect(f.service.enqueue(f.actor, f.input)).rejects.toThrow("POLICY_DENIED");
  f.adapter.offline = true;
  await expect(f.service.query(f.actor, query)).rejects.toThrow("LEDGER_UNAVAILABLE");
  await expect(new FederationMarketService(db, f.siteId).query(f.actor, query)).rejects.toThrow(
    "LEDGER_UNAVAILABLE",
  );
  f.adapter.offline = false;
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: null });
  await expect(f.service.query(f.actor, query)).rejects.toThrow("INVALID_ADAPTER_RESPONSE");
  f.adapter.onQuery = async () => {
    await f.permissions.set(
      { ...f.actor, capability: "market.read", enabled: false },
      f.actor.userId,
    );
    return { operation: "list-demands", demands: [], bookmark: "" };
  };
  await expect(f.service.query(f.actor, query)).rejects.toThrow("POLICY_DENIED");
  expect(
    await db.select().from(submissions).where(eq(submissions.localSiteId, f.siteId)),
  ).toHaveLength(0);
});

test("market directory HTTP bounds pages and distinguishes missing, unavailable and denied", async () => {
  const f = await fixture();
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { userId: f.actor.userId, orgId: f.actor.orgId } as never);
    await next();
  });
  app.route("/api", createFederationMarketRoutes(f.service));
  const base = "/api/federation/market/demands";
  const page = await app.request(base);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.json()).toMatchObject({
    success: true,
    data: { demands: [], observedAt: expect.any(String) },
  });
  expect((await app.request(`${base}?limit=51`)).status).toBe(400);
  expect((await app.request(`${base}?chaincode=other`)).status).toBe(400);
  expect((await app.request(`${base}/${randomUUID()}`)).status).toBe(404);
  f.adapter.onQuery = async () => MarketQueryResultSchema.parse({});
  expect((await app.request(base)).status).toBe(502);
  f.adapter.offline = true;
  expect((await app.request(base)).status).toBe(503);
  await f.permissions.set(
    { ...f.actor, capability: "market.publish", enabled: false },
    f.actor.userId,
  );
  expect((await app.request(base)).status).toBe(403);
});

test("market storage pressure blocks publish and claim, while replay, commit and cancellation remain available", async () => {
  const f = await fixture();
  let blocked = true;
  const service = new FederationMarketService(db, f.siteId, f.adapter, {
    async assertAdmission(mode) {
      expect(mode).toBe("ledger_coordinated");
      if (blocked) throw new FederationError("STORAGE_PRESSURE");
    },
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route("/api", createFederationMarketRoutes(service));
  const response = await app.request("/api/federation/market/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.input),
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code: "STORAGE_PRESSURE" } });
  expect(await db.select().from(submissions).where(eq(submissions.id, f.id))).toHaveLength(0);
  expect(await db.select().from(auditLog).where(eq(auditLog.target, f.id))).toHaveLength(0);
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: true },
    f.actor.userId,
  );
  const claim: MarketProposalInput = {
    operation: "claim-demand",
    claim: {
      demandId: f.id,
      claimId: randomUUID(),
      providerSiteId: f.siteId,
      expectedVersion: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  await expect(service.enqueue(f.actor, claim)).rejects.toThrow("STORAGE_PRESSURE");
  blocked = false;
  await service.enqueue(f.actor, f.input);
  blocked = true;
  expect((await service.enqueue(f.actor, f.input)).id).toBe(f.id);
  await expect(
    service.enqueue(f.actor, { ...f.input, demand: { ...f.input.demand, title: "Changed" } }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await service.advanceNext();
  await service.advanceNext();
  await service.advanceNext();
  expect((await f.view()).operation.state).toBe("committed");
  const cancellation: MarketProposalInput = {
    operation: "cancel-open-demand",
    cancellation: {
      demandId: f.id,
      cancellationId: randomUUID(),
      expectedVersion: 1,
    },
  };
  await service.enqueue(f.actor, cancellation);
  await service.advanceNext();
  await service.advanceNext();
  await service.advanceNext();
  expect(
    (await service.get(f.actor, cancellation.cancellation.cancellationId)).operation.state,
  ).toBe("committed");
});

test("completion pool backfills public market obligations and prevents new publish after its own shared limit", async () => {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const f = await fixture(),
    storage = testCompletionStorage();
  await f.service.enqueue(f.actor, f.input);
  const capacity = new FederationCompletionCapacity(db, f.siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "20", taskBytes: "20", marketBytes: "20" },
    f.actor.userId,
  );
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20", obligations: 1 });
  const service = new FederationMarketService(db, f.siteId, f.adapter, storage.guard);
  expect((await service.enqueue(f.actor, f.input)).id).toBe(f.id);
  await expect(
    service.enqueue(f.actor, { ...f.input, demand: { ...f.input.demand, demandId: randomUUID() } }),
  ).rejects.toThrow("STORAGE_PRESSURE");
  expect(await capacity.inspect()).toMatchObject({ allocatedBytes: "20", obligations: 1 });
});

test("unreserved source closure requires owned committed publication and serializes duplicate intents", async () => {
  const f = await fixture();
  const input = {
    operation: "close-unreserved-demand" as const,
    closure: {
      demandId: f.id,
      closureId: randomUUID(),
      claimId: randomUUID(),
      commercialDomainId: randomUUID(),
      issuerSiteId: f.siteId,
      expectedVersion: 2,
    },
  };
  await expect(f.service.enqueue(f.actor, input)).rejects.toThrow("ASSET_UNAVAILABLE");
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  await f.service.enqueue(f.actor, {
    operation: "cancel-open-demand",
    cancellation: {
      demandId: f.id,
      cancellationId: randomUUID(),
      expectedVersion: 1,
    },
  });
  f.adapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const replies = await Promise.all(
    Array.from({ length: 4 }, () => f.service.enqueue(f.actor, input)),
  );
  expect(new Set(replies.map((r) => r.id)).size).toBe(1);
  await expect(
    f.service.enqueue(f.actor, {
      ...input,
      closure: { ...input.closure, closureId: randomUUID() },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const other = await fixture();
  await expect(f.service.enqueue(other.actor, input)).rejects.toThrow("ASSET_UNAVAILABLE");
  f.adapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  expect((await f.service.get(f.actor, input.closure.closureId)).operation.state).toBe(
    "needs_review",
  );
  await db
    .update(submissions)
    .set({ digest: `sha256:${"f".repeat(64)}` })
    .where(eq(submissions.id, input.closure.closureId));
  await expect(f.service.retry(f.actor, input.closure.closureId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect((await f.service.get(f.actor, input.closure.closureId)).operation.state).toBe(
    "needs_review",
  );
});

test("unreserved provider closure and retry use claim authority and preserve original claim binding", async () => {
  const f = await fixture(false);
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: true },
    f.actor.userId,
  );
  const claim = {
    demandId: randomUUID(),
    claimId: randomUUID(),
    providerSiteId: f.siteId,
    commercialDomainId: randomUUID(),
    expectedVersion: 1,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await f.service.enqueue(f.actor, { operation: "claim-demand", claim });
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const input = {
    operation: "close-unreserved-demand" as const,
    closure: {
      demandId: claim.demandId,
      closureId: randomUUID(),
      claimId: claim.claimId,
      commercialDomainId: claim.commercialDomainId,
      issuerSiteId: f.siteId,
      expectedVersion: 2,
    },
  };
  await expect(
    f.service.enqueue(f.actor, {
      ...input,
      closure: { ...input.closure, issuerSiteId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  for (const patch of [{ commercialDomainId: randomUUID() }, { expectedVersion: 3 }])
    await expect(
      f.service.enqueue(f.actor, { ...input, closure: { ...input.closure, ...patch } }),
    ).rejects.toThrow("OPERATION_CONFLICT");
  await f.service.enqueue(f.actor, input);
  f.adapter.outcome = "invalid";
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: false },
    f.actor.userId,
  );
  await expect(f.service.retry(f.actor, input.closure.closureId)).rejects.toThrow("POLICY_DENIED");
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: true },
    f.actor.userId,
  );
  await f.service.retry(f.actor, input.closure.closureId);
  expect((await f.service.get(f.actor, input.closure.closureId)).operation.state).toBe("pending");
});

function unreservedState(
  demand: ReturnType<typeof MarketDemandSchema.parse>,
  providerSiteId = randomUUID(),
) {
  const claim = {
    demandId: demand.demandId,
    claimId: randomUUID(),
    providerSiteId,
    commercialDomainId: randomUUID(),
    expectedVersion: 1,
    expiresAt: demand.expiresAt,
  };
  return MarketDemandStateSchema.parse({
    demand,
    digest: federationMaterialDigest(demand),
    status: "CLOSED",
    version: 3,
    claim,
    cancellation: null,
    activation: null,
    unreservedClosure: {
      demandId: demand.demandId,
      closureId: randomUUID(),
      claimId: claim.claimId,
      commercialDomainId: claim.commercialDomainId,
      issuerSiteId: providerSiteId,
      expectedVersion: 2,
    },
  });
}

test("unreserved observation survives restart and accepts either party only through the local adapter", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const state = unreservedState(f.input.demand);
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: state });
  await f.service.reconcileClosures();
  const [saved] = await db.select().from(closures).where(eq(closures.localSiteId, f.siteId));
  expect(saved).toMatchObject({
    originId: f.id,
    payload: state,
    digest: federationMaterialDigest(state),
  });
  await new FederationMarketService(db, f.siteId, f.adapter).reconcileClosures();
  expect(f.adapter.queries).toBe(1);
  await expect(
    db.transaction((tx) => assertUnreservedDemandOpen(tx, f.siteId, f.id)),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  await db.transaction((tx) => assertUnreservedDemandOpen(tx, randomUUID(), f.id));
  expect(
    await db
      .select()
      .from(auditLog)
      .where(sql`action = 'federation.market.observe_unreserved_closure' AND target = ${f.id}`),
  ).toHaveLength(1);
});

test("unreserved observation rejects mismatched provider claims and never treats outage or missing state as closure", async () => {
  const f = await fixture(false);
  await f.permissions.set(
    { ...f.actor, capability: "market.claim", enabled: true },
    f.actor.userId,
  );
  const state = unreservedState({ ...f.input.demand, sourceSiteId: randomUUID() }, f.siteId);
  if (!state.claim || !state.unreservedClosure) throw new Error("Missing closure fixture");
  state.unreservedClosure.issuerSiteId = state.demand.sourceSiteId;
  await f.service.enqueue(f.actor, { operation: "claim-demand", claim: state.claim });
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const due = () =>
    db
      .update(submissions)
      .set({ closureCheckAt: new Date(0) })
      .where(eq(submissions.id, state.claim?.claimId ?? ""));
  await f.service.reconcileClosures();
  f.adapter.offline = true;
  await due();
  await expect(f.service.reconcileClosures()).rejects.toThrow("LEDGER_UNAVAILABLE");
  f.adapter.offline = false;
  const altered = structuredClone(state);
  if (!altered.claim || !altered.unreservedClosure) throw new Error("Missing claim");
  altered.claim.claimId = randomUUID();
  altered.unreservedClosure.claimId = altered.claim.claimId;
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: altered });
  await due();
  await expect(f.service.reconcileClosures()).rejects.toThrow("OPERATION_CONFLICT");
  expect(await db.select().from(closures).where(eq(closures.localSiteId, f.siteId))).toHaveLength(
    0,
  );
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: state });
  await due();
  await f.service.reconcileClosures();
  expect(await db.select().from(closures).where(eq(closures.localSiteId, f.siteId))).toHaveLength(
    1,
  );
});

test("unreserved observation serializes with already-authorized writers without holding a network transaction", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  f.adapter.onQuery = async () => ({
    operation: "get-demand",
    demand: unreservedState(f.input.demand),
  });
  let observed = false;
  let queried!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    queried = resolve;
  });
  const onQuery = f.adapter.onQuery;
  f.adapter.onQuery = async (input) => {
    queried();
    return onQuery(input);
  };
  let pending!: Promise<boolean>;
  await db.transaction(async (tx) => {
    await assertUnreservedDemandOpen(tx, f.siteId, f.id);
    pending = observeUnreservedClosure(db, f.siteId, f.adapter).then((result) => {
      observed = true;
      return result;
    });
    await queryStarted;
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const [lock] = await tx.execute<{ waiting: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND NOT granted) AS waiting`,
      );
      waiting = Boolean(lock?.waiting);
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    expect(observed).toBe(false);
    expect(await tx.select().from(closures).where(eq(closures.localSiteId, f.siteId))).toHaveLength(
      0,
    );
  });
  expect(await pending).toBe(true);
  await expect(
    db.transaction((tx) => assertUnreservedDemandOpen(tx, f.siteId, f.id)),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
});

test("unreserved observation audit failure and a late changed origin cannot persist a closure fence", async () => {
  const f = await fixture();
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const state = unreservedState(f.input.demand);
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: state });
  await db.execute(
    sql`CREATE FUNCTION unreserved_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.market.observe_unreserved_closure' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER unreserved_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION unreserved_audit_fail()`,
  );
  try {
    await expect(f.service.reconcileClosures()).rejects.toThrow();
  } finally {
    await db.execute(sql`DROP TRIGGER unreserved_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION unreserved_audit_fail()`);
  }
  expect(await db.select().from(closures).where(eq(closures.localSiteId, f.siteId))).toHaveLength(
    0,
  );
  await db.transaction((tx) => assertUnreservedDemandOpen(tx, f.siteId, f.id));
  await db
    .update(submissions)
    .set({ closureCheckAt: new Date(0) })
    .where(eq(submissions.id, f.id));
  f.adapter.onQuery = async () => {
    await db.update(submissions).set({ state: "needs_review" }).where(eq(submissions.id, f.id));
    return { operation: "get-demand", demand: state };
  };
  await expect(f.service.reconcileClosures()).rejects.toThrow("OPERATION_CONFLICT");
  expect(await db.select().from(closures).where(eq(closures.localSiteId, f.siteId))).toHaveLength(
    0,
  );
});

test.each([
  1, 2,
])("unreserved market retirement preserves transaction uncertainty and releases only drained allocation (checkpoints=%s)", async (checkpoints) => {
  const f = await fixture();
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const { testCompletionStorage } = await import("./test-fixtures");
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const state = unreservedState(f.input.demand);
  if (!state.unreservedClosure) throw new Error("Missing closure fixture");
  const input = {
    operation: "close-unreserved-demand" as const,
    closure: { ...state.unreservedClosure, issuerSiteId: f.siteId },
  };
  await f.service.enqueue(f.actor, input);
  for (let i = 0; i < checkpoints; i++) await f.service.advanceNext();
  const before = await f.service.get(f.actor, input.closure.closureId);
  const storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, f.siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
    f.actor.userId,
  );
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: state });
  await f.service.reconcileClosures();
  await capacity.advanceNext();
  if (checkpoints === 2) {
    expect((await capacity.inspect()).allocatedBytes).toBe("20");
    expect((await f.service.get(f.actor, input.closure.closureId)).operation.state).toBe("pending");
    f.adapter.outcome = "invalid";
    await new FederationMarketService(db, f.siteId, f.adapter).advanceNext();
    await f.service.reconcileClosures();
    await db
      .update(claims)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(claims.localSiteId, f.siteId));
    await capacity.advanceNext();
  }
  expect((await capacity.inspect()).allocatedBytes).toBe("0");
  const after = await f.service.get(f.actor, input.closure.closureId);
  expect(after.operation.state).toBe("closed");
  expect(after.transactions[0]).toMatchObject({
    transactionId: before.transactions[0]?.transactionId,
    stage: checkpoints === 1 ? "abandoned" : "invalid",
  });
  await expect(f.service.retry(f.actor, input.closure.closureId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(
    f.service.enqueue(f.actor, {
      ...input,
      closure: { ...input.closure, closureId: randomUUID() },
    }),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  expect((await f.service.enqueue(f.actor, input)).state).toBe("closed");
});

test("unreserved market retirement clears only expired committed leases after a worker dies before finally", async () => {
  const f = await fixture();
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const { testCompletionStorage } = await import("./test-fixtures");
  await f.service.enqueue(f.actor, f.input);
  for (let i = 0; i < 3; i++) await f.service.advanceNext();
  const storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, f.siteId, storage.guard);
  await capacity.configure(
    { reserveId: storage.reserveId, capacityBytes: "100", taskBytes: "60", marketBytes: "20" },
    f.actor.userId,
  );
  const state = unreservedState(f.input.demand);
  f.adapter.onQuery = async () => ({ operation: "get-demand", demand: state });
  const token = randomUUID();
  await db
    .update(submissions)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) })
    .where(eq(submissions.id, f.id));
  await f.service.reconcileClosures();
  await capacity.advanceNext();
  expect((await capacity.inspect()).allocatedBytes).toBe("20");
  expect((await db.select().from(submissions).where(eq(submissions.id, f.id)))[0]?.leaseToken).toBe(
    token,
  );
  await db
    .update(submissions)
    .set({ leaseUntil: new Date(0) })
    .where(eq(submissions.id, f.id));
  await new FederationMarketService(db, f.siteId, f.adapter).reconcileClosures();
  await db
    .update(claims)
    .set({ nextCheckAt: new Date(0) })
    .where(eq(claims.localSiteId, f.siteId));
  await capacity.advanceNext();
  expect((await capacity.inspect()).allocatedBytes).toBe("0");
  expect((await f.view()).transactions[0]?.stage).toBe("committed");
});

test("market names are limited to returned parties and do not alter ledger evidence", async () => {
  const f = await fixture();
  await f.permissions.set({ ...f.actor, capability: "market.read", enabled: true }, f.actor.userId);
  const unrelated = randomUUID();
  await db.insert(federationSites).values([
    { id: f.siteId, name: "North Research", endpoint: "https://north.invalid" },
    { id: unrelated, name: "Unrelated institution", endpoint: "https://unrelated.invalid" },
  ]);
  const demand = MarketDemandStateSchema.parse({
    demand: f.input.demand,
    digest: federationMaterialDigest(f.input.demand),
    version: 1,
    status: "OPEN",
    claim: null,
    cancellation: null,
  });
  f.adapter.onQuery = async (input) =>
    input.operation === "list-demands"
      ? { operation: "list-demands", demands: [demand], bookmark: "" }
      : { operation: "get-demand", demand };
  for (const input of [
    { operation: "list-demands", limit: 20, bookmark: "" },
    { operation: "get-demand", demandId: demand.demand.demandId },
  ] as const) {
    const result = await f.service.query(f.actor, input);
    expect(result.siteNames).toEqual({ [f.siteId]: "North Research" });
    expect(result.operation === "list-demands" ? result.demands[0] : result.demand).toEqual(demand);
  }
});
