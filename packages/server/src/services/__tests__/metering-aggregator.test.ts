// Metering rollup orchestrator tests.
import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryMeteringRepository, MeteringService } from "../metering";
import {
  MeteringAggregator,
  rollupBuckets,
  rollupRawToHourly,
  truncateTo,
} from "../metering-aggregator";

const ONE_HOUR = 3600 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

function rec(overrides: { jobId: string; finishedAt: Date; cpu?: number; cluster?: string }) {
  return {
    jobId: overrides.jobId,
    userId: "user-1",
    orgId: "org-A",
    agentId: "agent-1",
    clusterName: overrides.cluster ?? "cluster-A",
    appTemplateKey: "gromacs",
    cpuCoreSeconds: overrides.cpu ?? 100,
    gpuSeconds: 0,
    memoryMbSeconds: 1000,
    storageMbSeconds: 0,
    networkEgressMb: 0,
    startedAt: new Date(overrides.finishedAt.getTime() - 60_000),
    finishedAt: overrides.finishedAt,
  };
}

describe("truncateTo", () => {
  it("truncates to hourly bucket", () => {
    const t = truncateTo("hourly", new Date("2026-04-15T10:42:13Z"));
    expect(t.toISOString()).toBe("2026-04-15T10:00:00.000Z");
  });
  it("truncates to daily bucket", () => {
    const t = truncateTo("daily", new Date("2026-04-15T22:42:13Z"));
    expect(t.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
  it("truncates to monthly bucket", () => {
    const t = truncateTo("monthly", new Date("2026-04-15T22:42:13Z"));
    expect(t.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("rollupRawToHourly (pure)", () => {
  it("collapses three rows in the same hour bucket", () => {
    const rows = [
      rec({ jobId: "j1", finishedAt: new Date("2026-04-15T10:05:00Z"), cpu: 100 }),
      rec({ jobId: "j2", finishedAt: new Date("2026-04-15T10:35:00Z"), cpu: 200 }),
      rec({ jobId: "j3", finishedAt: new Date("2026-04-15T10:55:00Z"), cpu: 50 }),
    ].map((r) => ({ ...r, id: r.jobId, recordedAt: new Date() }));
    const buckets = rollupRawToHourly(rows);
    expect(buckets.length).toBe(1);
    expect(buckets[0]?.cpuCoreSeconds).toBe(350);
    expect(buckets[0]?.jobCount).toBe(3);
    expect(buckets[0]?.bucketStart.toISOString()).toBe("2026-04-15T10:00:00.000Z");
  });

  it("partitions by cluster", () => {
    const rows = [
      rec({
        jobId: "j1",
        finishedAt: new Date("2026-04-15T10:05:00Z"),
        cluster: "cluster-A",
        cpu: 100,
      }),
      rec({
        jobId: "j2",
        finishedAt: new Date("2026-04-15T10:15:00Z"),
        cluster: "cluster-B",
        cpu: 200,
      }),
    ].map((r) => ({ ...r, id: r.jobId, recordedAt: new Date() }));
    const buckets = rollupRawToHourly(rows);
    expect(buckets.length).toBe(2);
    const cpuByCluster = Object.fromEntries(
      buckets.map((b) => [b.clusterName, b.cpuCoreSeconds] as const),
    );
    expect(cpuByCluster).toEqual({ "cluster-A": 100, "cluster-B": 200 });
  });
});

describe("rollupBuckets (pure)", () => {
  it("daily rollup sums hourly buckets in same day", () => {
    const hourly = [
      {
        bucketStart: new Date("2026-04-15T08:00:00Z"),
        userId: "u1",
        orgId: "o1",
        clusterName: "c1",
        cpuCoreSeconds: 100,
        gpuSeconds: 0,
        memoryMbSeconds: 1000,
        storageMbSeconds: 0,
        networkEgressMb: 0,
        jobCount: 1,
      },
      {
        bucketStart: new Date("2026-04-15T14:00:00Z"),
        userId: "u1",
        orgId: "o1",
        clusterName: "c1",
        cpuCoreSeconds: 200,
        gpuSeconds: 0,
        memoryMbSeconds: 2000,
        storageMbSeconds: 0,
        networkEgressMb: 0,
        jobCount: 2,
      },
    ];
    const daily = rollupBuckets(hourly, "daily");
    expect(daily.length).toBe(1);
    expect(daily[0]?.cpuCoreSeconds).toBe(300);
    expect(daily[0]?.jobCount).toBe(3);
  });
});

describe("MeteringAggregator", () => {
  let repo: InMemoryMeteringRepository;
  let svc: MeteringService;
  let now: Date;

  beforeEach(async () => {
    now = new Date("2026-04-30T12:00:00Z");
    repo = new InMemoryMeteringRepository();
    svc = new MeteringService({ repo });
  });

  it("hourly rollup collapses old raw rows and deletes them", async () => {
    // Three rows from 8 days ago (older than 7-day retentionRaw).
    const ancient = new Date(now.getTime() - 8 * ONE_DAY);
    await svc.recordJobCompletion(rec({ jobId: "j1", finishedAt: ancient, cpu: 100 }));
    await svc.recordJobCompletion(
      rec({ jobId: "j2", finishedAt: new Date(ancient.getTime() + 5 * 60 * 1000), cpu: 200 }),
    );
    // One fresh row that should NOT be rolled up.
    await svc.recordJobCompletion(
      rec({ jobId: "fresh", finishedAt: new Date(now.getTime() - 60_000), cpu: 999 }),
    );

    const agg = new MeteringAggregator({ repo, now: () => now });
    const result = await agg.runHourlyRollup();

    expect(result.bucketsWritten).toBe(1);
    expect(result.sourceRowsDeleted).toBe(2);
    const snap = repo.snapshot();
    expect(snap.raw.length).toBe(1); // only the fresh row remains
    expect(snap.hourly.length).toBe(1);
    expect(snap.hourly[0]?.cpuCoreSeconds).toBe(300);
  });

  it("idempotent: rerunning hourly rollup is a no-op when no new old rows", async () => {
    const ancient = new Date(now.getTime() - 8 * ONE_DAY);
    await svc.recordJobCompletion(rec({ jobId: "j1", finishedAt: ancient, cpu: 100 }));
    const agg = new MeteringAggregator({ repo, now: () => now });
    await agg.runHourlyRollup();
    const second = await agg.runHourlyRollup();
    expect(second.sourceRowsDeleted).toBe(0);
    expect(repo.snapshot().hourly.length).toBe(1);
  });

  it("runAll cascades hourly -> daily -> monthly", async () => {
    // Drop a raw row 100 days old (older than retentionRaw=7 AND retentionHourly=90).
    const veryOld = new Date(now.getTime() - 100 * ONE_DAY);
    await svc.recordJobCompletion(rec({ jobId: "old", finishedAt: veryOld, cpu: 50 }));

    const agg = new MeteringAggregator({ repo, now: () => now });
    const report = await agg.runAll();

    expect(report.hourlyBucketsWritten).toBe(1);
    expect(report.dailyBucketsWritten).toBe(1);
    expect(report.rawRowsDeleted).toBe(1);
    expect(report.hourlyRowsDeleted).toBe(1);
    const snap = repo.snapshot();
    expect(snap.raw.length).toBe(0);
    expect(snap.hourly.length).toBe(0);
    expect(snap.daily.length).toBe(1);
    expect(snap.daily[0]?.cpuCoreSeconds).toBe(50);
  });
});
