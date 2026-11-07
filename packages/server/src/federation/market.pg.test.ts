import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  federationMarketAttempts as attempts,
  auditLog,
  createPgDb,
  orgs,
  federationMarketSubmissions as submissions,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  type MarketAdvanceResult,
  MarketDemandSchema,
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationMarketRoutes } from "../routes/federation-market";
import { FabricClientFailure } from "./fabric-client";
import { FederationMarketService } from "./market";
import type { MarketClient } from "./market-client";
import { FederationPermissionService } from "./permissions";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Market tests require isolated kuintessence_unit_* database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
afterAll(() => db.$client.end());
class Adapter implements MarketClient {
  prepares = 0;
  advances = 0;
  outcome: "pending" | "committed" | "invalid" = "committed";
  offline = false;
  onPrepare?: () => Promise<void>;
  onAdvance?: () => Promise<void>;
  async prepare(_input: MarketProposalInput) {
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
