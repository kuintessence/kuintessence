import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { auditLog, federationCompletionClaims as claims, createPgDb } from "@kuintessence/db";
import { eq, sql } from "drizzle-orm";
import {
  allocateMarketCompletion,
  allocateTaskCompletion,
  FederationCompletionCapacity,
} from "./completion-capacity";
import { testAgreement, testCompletionStorage, testDelegation } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Completion capacity tests require an isolated kuintessence_unit_* database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const replica = createPgDb(url, { max: 4, idle_timeout: 1 });
afterAll(async () => {
  await db.$client.end();
  await replica.$client.end();
});

async function fixture() {
  const siteId = randomUUID(),
    actor = randomUUID(),
    storage = testCompletionStorage();
  const service = new FederationCompletionCapacity(db, siteId, storage.guard);
  const policy = {
    reserveId: storage.reserveId,
    capacityBytes: "100",
    taskBytes: "60",
    marketBytes: "20",
  };
  await service.configure(policy, actor);
  const request = testDelegation(testAgreement(siteId, randomUUID()));
  return { siteId, actor, storage, service, policy, request };
}

test("completion pool serializes separate database clients across agreement revisions and rolls back failed business writes", async () => {
  const f = await fixture();
  const second = testDelegation(testAgreement(f.siteId, randomUUID(), "bilateral_attested"));
  const results = await Promise.allSettled(
    [db, replica].map((client, i) =>
      client.transaction(async (tx) => {
        await allocateTaskCompletion(tx, f.siteId, i === 0 ? f.request : second, f.storage.guard);
        await tx
          .insert(auditLog)
          .values({ actor: f.actor, action: "test.accept", target: f.siteId });
      }),
    ),
  );
  expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect(await f.service.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  expect(await db.select().from(auditLog).where(eq(auditLog.action, "test.accept"))).toHaveLength(
    1,
  );
  const winner = results[0]?.status === "fulfilled" ? f.request : second;
  f.storage.pressure();
  await replica.transaction((tx) => allocateTaskCompletion(tx, f.siteId, winner, f.storage.guard));
  await expect(
    replica.transaction((tx) =>
      allocateTaskCompletion(tx, f.siteId, { ...winner, maxAmount: "1" }, f.storage.guard),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const g = await fixture();
  await expect(
    db.transaction(async (tx) => {
      await allocateTaskCompletion(tx, g.siteId, g.request, g.storage.guard);
      throw new Error("Business write failed");
    }),
  ).rejects.toThrow("Business write failed");
  expect(await g.service.inspect()).toMatchObject({ allocatedBytes: "0", obligations: 0 });
  await replica.transaction((tx) =>
    allocateTaskCompletion(tx, g.siteId, g.request, g.storage.guard),
  );
  expect(await g.service.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
});

test("completion pool does not shrink previous charges, reset by reconfiguration, or move physical backing", async () => {
  const f = await fixture();
  await db.transaction((tx) => allocateTaskCompletion(tx, f.siteId, f.request, f.storage.guard));
  await f.service.configure({ ...f.policy, capacityBytes: "50", taskBytes: "10" }, f.actor);
  expect(await f.service.inspect()).toMatchObject({ allocatedBytes: "60", overcommitted: true });
  await expect(
    db.transaction((tx) =>
      allocateTaskCompletion(
        tx,
        f.siteId,
        { ...f.request, taskId: randomUUID(), operationId: randomUUID() },
        f.storage.guard,
      ),
    ),
  ).rejects.toThrow("STORAGE_PRESSURE");
  await f.service.configure({ ...f.policy, capacityBytes: "100", taskBytes: "10" }, f.actor);
  await db.transaction((tx) =>
    allocateTaskCompletion(
      tx,
      f.siteId,
      { ...f.request, taskId: randomUUID(), operationId: randomUUID() },
      f.storage.guard,
    ),
  );
  expect(await f.service.inspect()).toMatchObject({ allocatedBytes: "70", obligations: 2 });
  await expect(
    f.service.configure({ ...f.policy, reserveId: randomUUID() }, f.actor),
  ).rejects.toThrow();
  await expect(
    f.service.configure({ ...f.policy, capacityBytes: "10001" }, f.actor),
  ).rejects.toThrow("STORAGE_PRESSURE");
  await expect(
    db.transaction((tx) =>
      allocateTaskCompletion(tx, f.siteId, { ...f.request, taskId: randomUUID() }),
    ),
  ).rejects.toThrow("STORAGE_PRESSURE");
});

test("completion pool lock contention retries instead of waiting behind institutional locks", async () => {
  const f = await fixture();
  await db.transaction(async (tx) => {
    await allocateTaskCompletion(tx, f.siteId, f.request, f.storage.guard);
    await expect(
      replica.transaction((other) =>
        allocateTaskCompletion(other, f.siteId, f.request, f.storage.guard),
      ),
    ).rejects.toThrow("STORAGE_PRESSURE");
    await expect(
      new FederationCompletionCapacity(replica, f.siteId, f.storage.guard).configure(
        f.policy,
        f.actor,
      ),
    ).rejects.toThrow("STORAGE_PRESSURE");
  });
  await replica.transaction((tx) =>
    allocateTaskCompletion(tx, f.siteId, f.request, f.storage.guard),
  );
  expect(await f.service.inspect()).toMatchObject({ obligations: 1 });
});

test("completion pool shares a limit between task and public market obligations without charging cancellation", async () => {
  const f = await fixture();
  await db.transaction((tx) => allocateTaskCompletion(tx, f.siteId, f.request, f.storage.guard));
  const input = {
    operation: "claim-demand" as const,
    claim: {
      demandId: randomUUID(),
      claimId: randomUUID(),
      providerSiteId: f.siteId,
      expectedVersion: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  await db.transaction((tx) => allocateMarketCompletion(tx, f.siteId, input, f.storage.guard));
  await replica.transaction((tx) => allocateMarketCompletion(tx, f.siteId, input, f.storage.guard));
  await db.transaction((tx) =>
    allocateMarketCompletion(
      tx,
      f.siteId,
      { ...input, claim: { ...input.claim, claimId: randomUUID() } },
      f.storage.guard,
    ),
  );
  expect(await f.service.inspect()).toMatchObject({ allocatedBytes: "100", obligations: 3 });
  await expect(
    db.transaction((tx) =>
      allocateMarketCompletion(
        tx,
        f.siteId,
        { ...input, claim: { ...input.claim, claimId: randomUUID() } },
        f.storage.guard,
      ),
    ),
  ).rejects.toThrow("STORAGE_PRESSURE");
  f.storage.pressure();
  await db.transaction((tx) =>
    allocateMarketCompletion(
      tx,
      f.siteId,
      {
        operation: "cancel-open-demand",
        cancellation: {
          demandId: input.claim.demandId,
          cancellationId: randomUUID(),
          expectedVersion: 1,
        },
      },
      f.storage.guard,
    ),
  );
  expect(await f.service.inspect()).toMatchObject({ obligations: 3 });
});

test("completion allocation database constraints reject invalid byte accounting", async () => {
  const f = await fixture();
  for (const allocatedBytes of ["0", "-1", "NaN"]) {
    await expect(
      db
        .insert(claims)
        .values({
          localSiteId: f.siteId,
          kind: "task",
          intentId: randomUUID(),
          digest: `sha256:${"a".repeat(64)}`,
          allocatedBytes,
        })
        .execute(),
    ).rejects.toThrow();
  }
  await expect(
    db
      .execute(
        sql`UPDATE federation_completion_pools SET capacity_bytes = 'NaN' WHERE local_site_id = ${f.siteId}`,
      )
      .then((v) => v),
  ).rejects.toThrow();
});

test("completion pool administrator API is local-site scoped, audited and unavailable to organization roles", async () => {
  const { Hono } = await import("hono");
  const { createAdminFederationRoutes } = await import("../routes/admin-federation");
  const { FederationTrustRegistry } = await import("./trust-registry");
  const { createErrorHandler } = await import("../middleware/error-handler");
  const { default: pino } = await import("pino");
  const f = await fixture();
  function app(role: string) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, { role, userId: f.actor } as never);
      await next();
    });
    r.route(
      "/api",
      createAdminFederationRoutes(new FederationTrustRegistry(db), undefined, undefined, f.service),
    );
    return r;
  }
  const body = {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.policy),
  };
  for (const role of ["operator", "compute_provider", "user", "guest"])
    expect((await app(role).request("/api/admin/federation/storage/completion", body)).status).toBe(
      403,
    );
  const admin = app("platform_admin");
  const saved = await admin.request("/api/admin/federation/storage/completion", body);
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toBe("no-store");
  const response = await admin.request("/api/admin/federation/storage");
  expect(await response.json()).toMatchObject({
    data: {
      completion: {
        policy: { localSiteId: f.siteId, capacityBytes: "100" },
        allocatedBytes: "0",
        obligations: 0,
      },
    },
  });
  expect(
    (
      await admin.request("/api/admin/federation/storage/completion", {
        ...body,
        body: JSON.stringify({ ...f.policy, siteId: randomUUID() }),
      })
    ).status,
  ).toBe(400);
  f.storage.pressure();
  const pressure = await admin.request("/api/admin/federation/storage/completion", body);
  expect(pressure.status).toBe(503);
  expect(await pressure.json()).toEqual({ error: { code: "STORAGE_PRESSURE" } });
});

test("completion pool lets accepted work proceed while another replica holds the admission lock", async () => {
  const f = await fixture();
  await f.service.configure({ ...f.policy, capacityBytes: "200" }, f.actor);
  await db.transaction((tx) => allocateTaskCompletion(tx, f.siteId, f.request, f.storage.guard));
  await db.transaction(async (tx) => {
    await allocateTaskCompletion(
      tx,
      f.siteId,
      { ...f.request, taskId: randomUUID(), operationId: randomUUID() },
      f.storage.guard,
    );
    await replica.transaction((other) => allocateTaskCompletion(other, f.siteId, f.request));
  });
  expect(await f.service.inspect()).toMatchObject({ allocatedBytes: "120", obligations: 2 });
});

test("completion pool activation cannot pass a transaction admitted before the policy existed", async () => {
  const siteId = randomUUID(),
    storage = testCompletionStorage(),
    actor = randomUUID();
  const service = new FederationCompletionCapacity(replica, siteId, storage.guard);
  const policy = {
    reserveId: storage.reserveId,
    capacityBytes: "100",
    taskBytes: "60",
    marketBytes: "20",
  };
  await db.transaction(async (tx) => {
    await allocateTaskCompletion(tx, siteId, testDelegation(testAgreement(siteId, randomUUID())));
    await expect(service.configure(policy, actor)).rejects.toThrow("STORAGE_PRESSURE");
  });
  expect(await service.inspect()).toMatchObject({ policy: null });
  await service.configure(policy, actor);
  expect(await service.inspect()).toMatchObject({ policy: { capacityBytes: "100" } });
});
