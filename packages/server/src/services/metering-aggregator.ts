// Metering rollup orchestrator.
//
// Walks the four-tier rollup pipeline:
//   metering_usage_raw -> hourly (>= 7 days old)
//   metering_usage_hourly -> daily (>= 90 days old)
//   metering_usage_daily -> monthly (kept indefinitely)
//
// The aggregator is idempotent: each rollup uses ON CONFLICT DO UPDATE so
// re-running a rollup window is safe. The cleanup step deletes source rows
// only after the upsert has succeeded.

import type { MeteringRepository, Period, UsageBucketRow, UsageRawRow } from "./metering";

const EPOCH = new Date(0);
const ALL_SCOPE = { kind: "all" as const };

export interface AggregatorOptions {
  repo: MeteringRepository;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Retention windows (days). Rows older than this in their source tier
   * are collapsed into the next tier and deleted.
   */
  retentionRawDays?: number;
  retentionHourlyDays?: number;
  retentionDailyDays?: number;
}

export interface AggregatorRunReport {
  hourlyBucketsWritten: number;
  dailyBucketsWritten: number;
  monthlyBucketsWritten: number;
  rawRowsDeleted: number;
  hourlyRowsDeleted: number;
  dailyRowsDeleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class MeteringAggregator {
  private readonly repo: MeteringRepository;
  private readonly now: () => Date;
  private readonly retentionRawDays: number;
  private readonly retentionHourlyDays: number;
  private readonly retentionDailyDays: number;

  constructor(opts: AggregatorOptions) {
    this.repo = opts.repo;
    this.now = opts.now ?? (() => new Date());
    this.retentionRawDays = opts.retentionRawDays ?? 7;
    this.retentionHourlyDays = opts.retentionHourlyDays ?? 90;
    this.retentionDailyDays = opts.retentionDailyDays ?? 730;
  }

  /**
   * Run all three rollup stages in order. Returns a report so callers
   * (cron job / admin endpoint) can log or surface progress.
   */
  async runAll(): Promise<AggregatorRunReport> {
    const hourly = await this.runHourlyRollup();
    const daily = await this.runDailyRollup();
    const monthly = await this.runMonthlyRollup();
    return {
      hourlyBucketsWritten: hourly.bucketsWritten,
      dailyBucketsWritten: daily.bucketsWritten,
      monthlyBucketsWritten: monthly.bucketsWritten,
      rawRowsDeleted: hourly.sourceRowsDeleted,
      hourlyRowsDeleted: daily.sourceRowsDeleted,
      dailyRowsDeleted: monthly.sourceRowsDeleted,
    };
  }

  async runHourlyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }> {
    const cutoff = new Date(this.now().getTime() - this.retentionRawDays * DAY_MS);
    const rows = await this.repo.selectRaw({
      scope: ALL_SCOPE,
      finishedBefore: cutoff,
    });
    const buckets = rollupRawToHourly(rows);
    if (buckets.length > 0) {
      await this.repo.upsertBuckets("hourly", buckets);
    }
    const deleted = await this.repo.deleteRawOlderThan(cutoff);
    return { bucketsWritten: buckets.length, sourceRowsDeleted: deleted };
  }

  async runDailyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }> {
    const cutoff = new Date(this.now().getTime() - this.retentionHourlyDays * DAY_MS);
    const rows = await this.repo.selectBuckets("hourly", {
      scope: ALL_SCOPE,
      from: EPOCH,
      to: cutoff,
    });
    const buckets = rollupBuckets(rows, "daily");
    if (buckets.length > 0) {
      await this.repo.upsertBuckets("daily", buckets);
    }
    const deleted = await this.repo.deleteHourlyOlderThan(cutoff);
    return { bucketsWritten: buckets.length, sourceRowsDeleted: deleted };
  }

  async runMonthlyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }> {
    const cutoff = new Date(this.now().getTime() - this.retentionDailyDays * DAY_MS);
    const rows = await this.repo.selectBuckets("daily", {
      scope: ALL_SCOPE,
      from: EPOCH,
      to: cutoff,
    });
    const buckets = rollupBuckets(rows, "monthly");
    if (buckets.length > 0) {
      await this.repo.upsertBuckets("monthly", buckets);
    }
    const deleted = await this.repo.deleteDailyOlderThan(cutoff);
    return { bucketsWritten: buckets.length, sourceRowsDeleted: deleted };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure rollup logic (exported for testing).
// ─────────────────────────────────────────────────────────────────────────────

export function truncateTo(period: Exclude<Period, "raw">, d: Date): Date {
  const dt = new Date(d);
  if (period === "hourly") {
    dt.setMinutes(0, 0, 0);
  } else if (period === "daily") {
    dt.setUTCHours(0, 0, 0, 0);
  } else {
    dt.setUTCHours(0, 0, 0, 0);
    dt.setUTCDate(1);
  }
  return dt;
}

export function rollupRawToHourly(rows: UsageRawRow[]): UsageBucketRow[] {
  const acc = new Map<string, UsageBucketRow>();
  for (const r of rows) {
    const bucket = truncateTo("hourly", r.finishedAt);
    const key = `${bucket.toISOString()}|${r.orgId}|${r.userId}|${r.clusterName}`;
    const existing = acc.get(key);
    if (existing) {
      existing.cpuCoreSeconds += r.cpuCoreSeconds;
      existing.gpuSeconds += r.gpuSeconds;
      existing.memoryMbSeconds += r.memoryMbSeconds;
      existing.storageMbSeconds += r.storageMbSeconds;
      existing.networkEgressMb += r.networkEgressMb;
      existing.jobCount += 1;
    } else {
      acc.set(key, {
        bucketStart: bucket,
        userId: r.userId,
        orgId: r.orgId,
        clusterName: r.clusterName,
        cpuCoreSeconds: r.cpuCoreSeconds,
        gpuSeconds: r.gpuSeconds,
        memoryMbSeconds: r.memoryMbSeconds,
        storageMbSeconds: r.storageMbSeconds,
        networkEgressMb: r.networkEgressMb,
        jobCount: 1,
      });
    }
  }
  return Array.from(acc.values());
}

export function rollupBuckets(
  rows: UsageBucketRow[],
  toPeriod: Exclude<Period, "raw" | "hourly">,
): UsageBucketRow[] {
  const acc = new Map<string, UsageBucketRow>();
  for (const r of rows) {
    const bucket = truncateTo(toPeriod, r.bucketStart);
    const key = `${bucket.toISOString()}|${r.orgId}|${r.userId}|${r.clusterName}`;
    const existing = acc.get(key);
    if (existing) {
      existing.cpuCoreSeconds += r.cpuCoreSeconds;
      existing.gpuSeconds += r.gpuSeconds;
      existing.memoryMbSeconds += r.memoryMbSeconds;
      existing.storageMbSeconds += r.storageMbSeconds;
      existing.networkEgressMb += r.networkEgressMb;
      existing.jobCount += r.jobCount;
    } else {
      acc.set(key, {
        bucketStart: bucket,
        userId: r.userId,
        orgId: r.orgId,
        clusterName: r.clusterName,
        cpuCoreSeconds: r.cpuCoreSeconds,
        gpuSeconds: r.gpuSeconds,
        memoryMbSeconds: r.memoryMbSeconds,
        storageMbSeconds: r.storageMbSeconds,
        networkEgressMb: r.networkEgressMb,
        jobCount: r.jobCount,
      });
    }
  }
  return Array.from(acc.values());
}
