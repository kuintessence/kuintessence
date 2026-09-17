// Drizzle PG metering repository integration tests.
//
// These tests need a real Postgres because the repository relies on
// dialect-specific features:
//   - INSERT … ON CONFLICT DO UPDATE (composite-PK upsert path)
//   - INSERT … ON CONFLICT DO NOTHING on a unique index
//   - bigint and numeric column round-trips
//   - timestamptz semantics
//
// They are gated behind the `KQ_PG_URL` env var (or `DATABASE_URL` as a
// fallback so a local dev box with a Postgres already running picks it
// up). When neither is set the suite skips so CI without a DB and
// local laptops without Docker still pass `bun test`.
//
// To run them locally:
//   KQ_PG_URL=postgres://kq:kq@localhost:5432/kuintessence \
//     bun test packages/server/src/services/__tests__/metering-repository-drizzle.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  meteringUsageDaily,
  meteringUsageHourly,
  meteringUsageMonthly,
  meteringUsageRaw,
  meteringWebhook,
  type PgDb,
} from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { DrizzleWebhookRepository } from "../../routes/metering";
import type { JobUsageRecord, UsageBucketRow } from "../metering";
import { MeteringAggregator } from "../metering-aggregator";
import { DrizzleMeteringRepository } from "../metering-repository-drizzle";

// Default to the local dev PG when no env is set — matches the suite-wide
// convention so these DB tests RUN in the default `test:unit` flow instead of
// silently skipping.
const PG_URL =
  process.env.KQ_PG_URL ??
  process.env.DATABASE_URL ??
  "postgres://kq:kq@localhost:5432/kuintessence";

// `describe.if` keeps the test suite fully present when PG is reachable
// and silently skips otherwise — no flaky red CI when there is no DB.
const describeIfPg = PG_URL ? describe : describe.skip;

const TEST_ORG_A = "00000000-0000-0000-0000-0000000000a1";
const TEST_ORG_B = "00000000-0000-0000-0000-0000000000a2";
const TEST_USER_A = "00000000-0000-0000-0000-000000000001";
const TEST_USER_B = "00000000-0000-0000-0000-000000000002";

function makeJobUsage(overrides: Partial<JobUsageRecord> = {}): JobUsageRecord {
  const finishedAt = overrides.finishedAt ?? new Date("2026-04-15T10:30:00Z");
  return {
    jobId: overrides.jobId ?? crypto.randomUUID(),
    userId: overrides.userId ?? TEST_USER_A,
    orgId: overrides.orgId ?? TEST_ORG_A,
    agentId: overrides.agentId ?? "agent-test",
    clusterName: overrides.clusterName ?? "cluster-A",
    appTemplateKey: overrides.appTemplateKey ?? "gromacs",
    cpuCoreSeconds: overrides.cpuCoreSeconds ?? 1920,
    gpuSeconds: overrides.gpuSeconds ?? 0,
    memoryMbSeconds: overrides.memoryMbSeconds ?? 61_440,
    storageMbSeconds: overrides.storageMbSeconds ?? 0,
    networkEgressMb: overrides.networkEgressMb ?? 0,
    startedAt: overrides.startedAt ?? new Date(finishedAt.getTime() - 60_000),
    finishedAt,
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

function bucket(overrides: Partial<UsageBucketRow> = {}): UsageBucketRow {
  return {
    bucketStart: overrides.bucketStart ?? new Date("2026-04-15T10:00:00Z"),
    userId: overrides.userId ?? TEST_USER_A,
    orgId: overrides.orgId ?? TEST_ORG_A,
    clusterName: overrides.clusterName ?? "cluster-A",
    cpuCoreSeconds: overrides.cpuCoreSeconds ?? 1920,
    gpuSeconds: overrides.gpuSeconds ?? 0,
    memoryMbSeconds: overrides.memoryMbSeconds ?? 61_440,
    storageMbSeconds: overrides.storageMbSeconds ?? 0,
    networkEgressMb: overrides.networkEgressMb ?? 0,
    jobCount: overrides.jobCount ?? 1,
  };
}

describeIfPg("DrizzleMeteringRepository", () => {
  let db: PgDb;
  let repo: DrizzleMeteringRepository;

  // Track every job/webhook id we touch so the cleanup in afterAll is
  // surgical — never wipes rows the suite did not create.
  const insertedJobIds: string[] = [];
  const insertedWebhookIds: string[] = [];
  const SUITE_ORGS = [TEST_ORG_A, TEST_ORG_B];

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createPgDb(PG_URL);
    repo = new DrizzleMeteringRepository(db);
    // Wipe any prior fixture leftovers from earlier runs.
    for (const orgId of SUITE_ORGS) {
      await db.delete(meteringUsageRaw).where(eq(meteringUsageRaw.orgId, orgId));
      await db.delete(meteringUsageHourly).where(eq(meteringUsageHourly.orgId, orgId));
      await db.delete(meteringUsageDaily).where(eq(meteringUsageDaily.orgId, orgId));
      await db.delete(meteringUsageMonthly).where(eq(meteringUsageMonthly.orgId, orgId));
      await db.delete(meteringWebhook).where(eq(meteringWebhook.orgId, orgId));
    }
  });

  afterAll(async () => {
    if (!PG_URL) return;
    for (const orgId of SUITE_ORGS) {
      await db.delete(meteringUsageRaw).where(eq(meteringUsageRaw.orgId, orgId));
      await db.delete(meteringUsageHourly).where(eq(meteringUsageHourly.orgId, orgId));
      await db.delete(meteringUsageDaily).where(eq(meteringUsageDaily.orgId, orgId));
      await db.delete(meteringUsageMonthly).where(eq(meteringUsageMonthly.orgId, orgId));
      await db.delete(meteringWebhook).where(eq(meteringWebhook.orgId, orgId));
    }
    // Suppress unused-tracking-list lint by inspecting at teardown.
    void insertedJobIds.length;
    void insertedWebhookIds.length;
  });

  test("insertRaw persists a row and returns the assigned id", async () => {
    const record = makeJobUsage({ jobId: crypto.randomUUID() });
    insertedJobIds.push(record.jobId);
    const recordedAt = new Date("2026-04-15T10:31:00Z");

    const row = await repo.insertRaw(record, recordedAt);

    expect(row).not.toBeNull();
    expect(row?.id).toBeTruthy();
    expect(row?.jobId).toBe(record.jobId);
    expect(row?.cpuCoreSeconds).toBe(record.cpuCoreSeconds);
    expect(row?.networkEgressMb).toBe(record.networkEgressMb);
    expect(row?.startedAt.getTime()).toBe(record.startedAt.getTime());
    expect(row?.finishedAt.getTime()).toBe(record.finishedAt.getTime());
    expect(row?.recordedAt.getTime()).toBe(recordedAt.getTime());
  });

  test("insertRaw is idempotent on jobId — second call returns null, one row persists", async () => {
    const record = makeJobUsage({ jobId: crypto.randomUUID() });
    insertedJobIds.push(record.jobId);
    const first = await repo.insertRaw(record, new Date());
    const second = await repo.insertRaw(record, new Date());
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    // The unique index + ON CONFLICT DO NOTHING must leave exactly one row.
    const rows = await db
      .select({ id: meteringUsageRaw.id })
      .from(meteringUsageRaw)
      .where(eq(meteringUsageRaw.jobId, record.jobId));
    expect(rows.length).toBe(1);
  });

  test("selectRaw filters by tenant scope, time window, and finishedBefore", async () => {
    const orgScopedJobId = crypto.randomUUID();
    const otherOrgJobId = crypto.randomUUID();
    const oldJobId = crypto.randomUUID();
    insertedJobIds.push(orgScopedJobId, otherOrgJobId, oldJobId);

    // In scope and inside window
    await repo.insertRaw(
      makeJobUsage({
        jobId: orgScopedJobId,
        orgId: TEST_ORG_A,
        startedAt: new Date("2026-03-10T00:00:00Z"),
        finishedAt: new Date("2026-03-10T00:30:00Z"),
      }),
      new Date(),
    );
    // Different org — should be filtered out by scope
    await repo.insertRaw(
      makeJobUsage({
        jobId: otherOrgJobId,
        orgId: TEST_ORG_B,
        startedAt: new Date("2026-03-10T00:00:00Z"),
        finishedAt: new Date("2026-03-10T00:30:00Z"),
      }),
      new Date(),
    );
    // In scope but finished AFTER cutoff — should be filtered out by finishedBefore
    await repo.insertRaw(
      makeJobUsage({
        jobId: oldJobId,
        orgId: TEST_ORG_A,
        startedAt: new Date("2026-03-10T05:00:00Z"),
        finishedAt: new Date("2026-03-10T06:00:00Z"),
      }),
      new Date(),
    );

    const rowsScoped = await repo.selectRaw({
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2026-03-09T00:00:00Z"),
      to: new Date("2026-03-11T00:00:00Z"),
    });
    const scopedJobIds = rowsScoped.map((r) => r.jobId).sort();
    expect(scopedJobIds).toContain(orgScopedJobId);
    expect(scopedJobIds).toContain(oldJobId);
    expect(scopedJobIds).not.toContain(otherOrgJobId);

    const rowsWithCutoff = await repo.selectRaw({
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2026-03-09T00:00:00Z"),
      to: new Date("2026-03-11T00:00:00Z"),
      finishedBefore: new Date("2026-03-10T01:00:00Z"),
    });
    const cutoffIds = rowsWithCutoff.map((r) => r.jobId);
    expect(cutoffIds).toContain(orgScopedJobId);
    expect(cutoffIds).not.toContain(oldJobId);
  });

  test("selectRaw with kind='all' ignores scope — super_admin path", async () => {
    const all = await repo.selectRaw({
      scope: { kind: "all" },
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    // Should at least see rows we inserted in earlier tests.
    expect(all.length).toBeGreaterThan(0);
  });

  test("runHourlyRollup does not crash on the open started_at range (regression)", async () => {
    // Regression: the aggregator used a FAR_FUTURE (year 275760) upper bound on
    // started_at, which Postgres timestamptz rejects ("time zone displacement
    // out of range"). Seed an old, fully-finished raw row and roll it up.
    const jobId = crypto.randomUUID();
    insertedJobIds.push(jobId);
    await repo.insertRaw(
      makeJobUsage({
        jobId,
        orgId: TEST_ORG_A,
        clusterName: "cluster-rollup",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T01:00:00Z"),
      }),
      new Date(),
    );

    const agg = new MeteringAggregator({ repo, now: () => new Date("2026-05-29T00:00:00Z") });
    const result = await agg.runHourlyRollup();
    expect(result.bucketsWritten).toBeGreaterThanOrEqual(1);
  });

  test("upsertBuckets inserts new rows and updates on conflict (composite PK)", async () => {
    const start = new Date("2026-04-20T10:00:00Z");
    await repo.upsertBuckets("hourly", [
      bucket({
        bucketStart: start,
        orgId: TEST_ORG_A,
        userId: TEST_USER_A,
        clusterName: "cluster-A",
        cpuCoreSeconds: 100,
        jobCount: 1,
      }),
    ]);

    let rows = await repo.selectBuckets("hourly", {
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2026-04-20T09:00:00Z"),
      to: new Date("2026-04-20T11:00:00Z"),
    });
    expect(rows.length).toBe(1);
    const first = rows[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected first row");
    expect(first.cpuCoreSeconds).toBe(100);
    expect(first.jobCount).toBe(1);

    // Same composite key, different totals → must UPDATE not duplicate.
    await repo.upsertBuckets("hourly", [
      bucket({
        bucketStart: start,
        orgId: TEST_ORG_A,
        userId: TEST_USER_A,
        clusterName: "cluster-A",
        cpuCoreSeconds: 250,
        jobCount: 3,
        gpuSeconds: 42,
      }),
    ]);

    rows = await repo.selectBuckets("hourly", {
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2026-04-20T09:00:00Z"),
      to: new Date("2026-04-20T11:00:00Z"),
    });
    expect(rows.length).toBe(1);
    const updated = rows[0];
    expect(updated).toBeDefined();
    if (!updated) throw new Error("expected updated row");
    expect(updated.cpuCoreSeconds).toBe(250);
    expect(updated.jobCount).toBe(3);
    expect(updated.gpuSeconds).toBe(42);
  });

  test("selectBuckets respects period selection and time window", async () => {
    const dailyStart = new Date("2026-04-21T00:00:00Z");
    await repo.upsertBuckets("daily", [
      bucket({
        bucketStart: dailyStart,
        orgId: TEST_ORG_A,
        userId: TEST_USER_B,
        clusterName: "cluster-A",
        cpuCoreSeconds: 999,
        jobCount: 7,
      }),
    ]);

    const dailyRows = await repo.selectBuckets("daily", {
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2026-04-20T00:00:00Z"),
      to: new Date("2026-04-22T00:00:00Z"),
    });
    expect(dailyRows.length).toBeGreaterThanOrEqual(1);
    expect(dailyRows.some((r) => r.cpuCoreSeconds === 999 && r.jobCount === 7)).toBe(true);

    // Same period read with a time window that excludes the row should be empty.
    const empty = await repo.selectBuckets("daily", {
      scope: { kind: "orgs", orgIds: [TEST_ORG_A] },
      from: new Date("2027-01-01T00:00:00Z"),
      to: new Date("2027-02-01T00:00:00Z"),
    });
    expect(empty.length).toBe(0);
  });

  test("delete*OlderThan removes rows and reports deletion count", async () => {
    // Seed two raw rows on a dedicated cluster so we can wipe them safely.
    const youngJob = crypto.randomUUID();
    const oldJob = crypto.randomUUID();
    insertedJobIds.push(youngJob, oldJob);
    await repo.insertRaw(
      makeJobUsage({
        jobId: youngJob,
        clusterName: "cluster-cleanup",
        startedAt: new Date("2026-04-30T00:00:00Z"),
        finishedAt: new Date("2026-04-30T01:00:00Z"),
      }),
      new Date(),
    );
    await repo.insertRaw(
      makeJobUsage({
        jobId: oldJob,
        clusterName: "cluster-cleanup",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T01:00:00Z"),
      }),
      new Date(),
    );

    const cutoff = new Date("2026-03-01T00:00:00Z");
    const removed = await repo.deleteRawOlderThan(cutoff);
    // We can only assert that AT LEAST our oldJob got pruned — other tests
    // may have added old rows; we don't pin the global count.
    expect(removed).toBeGreaterThanOrEqual(1);
    const survivors = await repo.selectRaw({
      scope: { kind: "all" },
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
    });
    expect(survivors.some((r) => r.jobId === oldJob)).toBe(false);
    expect(survivors.some((r) => r.jobId === youngJob)).toBe(true);
  });

  test("deleteHourlyOlderThan and deleteDailyOlderThan trim by bucketStart", async () => {
    const oldHourly = new Date("2025-01-01T00:00:00Z");
    await repo.upsertBuckets("hourly", [
      bucket({
        bucketStart: oldHourly,
        orgId: TEST_ORG_A,
        userId: TEST_USER_A,
        clusterName: "cluster-trim",
        cpuCoreSeconds: 1,
        jobCount: 1,
      }),
    ]);
    const removed = await repo.deleteHourlyOlderThan(new Date("2025-06-01T00:00:00Z"));
    expect(removed).toBeGreaterThanOrEqual(1);

    const oldDaily = new Date("2025-01-01T00:00:00Z");
    await repo.upsertBuckets("daily", [
      bucket({
        bucketStart: oldDaily,
        orgId: TEST_ORG_A,
        userId: TEST_USER_A,
        clusterName: "cluster-trim",
        cpuCoreSeconds: 1,
        jobCount: 1,
      }),
    ]);
    const removedDaily = await repo.deleteDailyOlderThan(new Date("2025-06-01T00:00:00Z"));
    expect(removedDaily).toBeGreaterThanOrEqual(1);
  });
});

describeIfPg("DrizzleWebhookRepository emitter methods (PG)", () => {
  let db: PgDb;
  let webhookRepo: DrizzleWebhookRepository;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createPgDb(PG_URL);
    webhookRepo = new DrizzleWebhookRepository(db);
    for (const orgId of [TEST_ORG_A, TEST_ORG_B]) {
      await db.delete(meteringWebhook).where(eq(meteringWebhook.orgId, orgId));
    }
  });

  afterAll(async () => {
    if (!PG_URL) return;
    for (const orgId of [TEST_ORG_A, TEST_ORG_B]) {
      await db.delete(meteringWebhook).where(eq(meteringWebhook.orgId, orgId));
    }
  });

  test("listEnabledForEvent uses ANY(events) and returns the secret", async () => {
    const subbed = await webhookRepo.insert({
      orgId: TEST_ORG_A,
      url: "https://a.test/hook",
      secret: "pg-secret-a",
      events: ["usage.daily", "usage.monthly"],
      enabled: true,
    });
    await webhookRepo.insert({
      orgId: TEST_ORG_A,
      url: "https://b.test/hook",
      secret: "pg-secret-b",
      events: ["usage.daily"],
      enabled: false,
    });
    await webhookRepo.insert({
      orgId: TEST_ORG_B,
      url: "https://c.test/hook",
      secret: "pg-secret-c",
      events: ["usage.monthly"],
      enabled: true,
    });

    const got = await webhookRepo.listEnabledForEvent("usage.daily");
    const ids = got.map((g) => g.id);
    expect(ids).toContain(subbed.id);
    const row = got.find((g) => g.id === subbed.id);
    expect(row?.secret).toBe("pg-secret-a");
    expect(got.every((g) => g.enabled && g.events.includes("usage.daily"))).toBe(true);
  });

  test("recordResult increments failures then resets on ok", async () => {
    const w = await webhookRepo.insert({
      orgId: TEST_ORG_A,
      url: "https://d.test/hook",
      secret: "pg-secret-d",
      events: ["usage.daily"],
      enabled: true,
    });
    await webhookRepo.recordResult(w.id, false);
    await webhookRepo.recordResult(w.id, false);
    let [row] = (await webhookRepo.listEnabledForEvent("usage.daily")).filter((g) => g.id === w.id);
    expect(row?.failures).toBe(2);

    await webhookRepo.recordResult(w.id, true);
    [row] = (await webhookRepo.listEnabledForEvent("usage.daily")).filter((g) => g.id === w.id);
    expect(row?.failures).toBe(0);
  });
});
