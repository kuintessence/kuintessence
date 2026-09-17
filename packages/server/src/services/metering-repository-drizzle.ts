// Drizzle PG implementation of {@link MeteringRepository}.
//
// The companion file `metering.ts` ships an `InMemoryMeteringRepository`
// that the unit tests use. This module is the production adapter: it
// shares the same surface so `MeteringService`, `MeteringAggregator`,
// `metering-export`, and `metering-webhook` see the exact same contract
// regardless of whether the Server is running with PG or with the in-memory
// fake.
//
// Important Drizzle / postgres-js notes captured here so the next reader
// does not need to re-derive them:
//
//   - `bigint({ mode: "number" })` round-trips as JS `number`. That is
//     fine for our totals because the values are clamped at the schema
//     boundary (cpu_core_seconds etc. are bounded by wall-clock seconds
//     × CPUs, which never overflows Number.MAX_SAFE_INTEGER for any
//     plausible job).
//   - `numeric(20, 4)` round-trips as a `string` in postgres-js. The
//     repository converts to `number` on read and back to a string on
//     write so the in-memory and PG repos stay perfectly interchangeable
//     from the service's point of view.
//   - The hourly / daily / monthly tables share the composite PK
//     `(bucket_start, org_id, user_id, cluster_name)`. That tuple is the
//     `target` of `onConflictDoUpdate` for the upsert path.
//   - `metering_usage_raw` has a UNIQUE index on `job_id`. The insert
//     probes the row first and returns null when present (the service's
//     "already recorded" idempotency contract), and the insert itself
//     uses `onConflictDoNothing` so a concurrent insert that wins the
//     race cannot create a second row — the race-loser also returns null.

import {
  type MeteringUsageBucketRow as DbBucketRow,
  type MeteringUsageRawRow as DbRawRow,
  type MeteringUsageBucketInsert,
  meteringUsageDaily,
  meteringUsageHourly,
  meteringUsageMonthly,
  meteringUsageRaw,
  type PgDb,
} from "@kuintessence/db";
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type {
  JobUsageRecord,
  MeteringRepository,
  Period,
  RawQueryFilter,
  TenantScope,
  UsageBucketRow,
  UsageRawRow,
} from "./metering";

type BucketTable =
  | typeof meteringUsageHourly
  | typeof meteringUsageDaily
  | typeof meteringUsageMonthly;

export class DrizzleMeteringRepository implements MeteringRepository {
  constructor(private readonly db: PgDb) {}

  async insertRaw(record: JobUsageRecord, recordedAt: Date): Promise<UsageRawRow | null> {
    // Idempotent on jobId: if a row already exists, return null so the
    // service surfaces "already recorded" semantics. The probe + insert
    // is intentionally not transactional because a duplicate insert is
    // acceptable noise (subsequent reads still see a single logical
    // record) — but we do return null on the race-loser path by checking
    // the existing row at the end.
    const existing = await this.db
      .select({ id: meteringUsageRaw.id })
      .from(meteringUsageRaw)
      .where(eq(meteringUsageRaw.jobId, record.jobId))
      .limit(1);
    if (existing.length > 0) {
      return null;
    }

    const inserted = await this.db
      .insert(meteringUsageRaw)
      .values({
        jobId: record.jobId,
        userId: record.userId,
        orgId: record.orgId,
        agentId: record.agentId,
        clusterName: record.clusterName,
        appTemplateKey: record.appTemplateKey,
        cpuCoreSeconds: record.cpuCoreSeconds,
        gpuSeconds: record.gpuSeconds,
        memoryMbSeconds: record.memoryMbSeconds,
        storageMbSeconds: record.storageMbSeconds,
        networkEgressMb: record.networkEgressMb.toString(),
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        recordedAt,
        metadata: record.metadata,
      })
      .onConflictDoNothing({ target: meteringUsageRaw.jobId })
      .returning();
    const row = inserted[0];
    if (!row) {
      return null;
    }
    return rawDbRowToDomain(row);
  }

  async selectRaw(filter: RawQueryFilter): Promise<UsageRawRow[]> {
    const conditions = [];
    if (filter.from) conditions.push(gte(meteringUsageRaw.startedAt, filter.from));
    if (filter.to) conditions.push(lte(meteringUsageRaw.startedAt, filter.to));
    const scopeCond = scopeToCondition(meteringUsageRaw.orgId, filter.scope);
    if (scopeCond) conditions.push(scopeCond);
    if (filter.finishedBefore) {
      conditions.push(lt(meteringUsageRaw.finishedAt, filter.finishedBefore));
    }

    const rows = await this.db
      .select()
      .from(meteringUsageRaw)
      .where(and(...conditions));
    return rows.map(rawDbRowToDomain);
  }

  async selectBuckets(
    period: Exclude<Period, "raw">,
    filter: { scope: TenantScope; from: Date; to: Date },
  ): Promise<UsageBucketRow[]> {
    const table = bucketTableFor(period);
    const conditions = [gte(table.bucketStart, filter.from), lte(table.bucketStart, filter.to)];
    const scopeCond = scopeToCondition(table.orgId, filter.scope);
    if (scopeCond) conditions.push(scopeCond);

    const rows = await this.db
      .select()
      .from(table)
      .where(and(...conditions));
    return rows.map(bucketDbRowToDomain);
  }

  async upsertBuckets(period: Exclude<Period, "raw">, rows: UsageBucketRow[]): Promise<void> {
    if (rows.length === 0) return;
    const table = bucketTableFor(period);
    const values: MeteringUsageBucketInsert[] = rows.map((r) => ({
      bucketStart: r.bucketStart,
      userId: r.userId,
      orgId: r.orgId,
      clusterName: r.clusterName,
      cpuCoreSeconds: r.cpuCoreSeconds,
      gpuSeconds: r.gpuSeconds,
      memoryMbSeconds: r.memoryMbSeconds,
      storageMbSeconds: r.storageMbSeconds,
      networkEgressMb: r.networkEgressMb.toString(),
      jobCount: r.jobCount,
    }));

    // Composite PK: (bucket_start, org_id, user_id, cluster_name) — same
    // for hourly/daily/monthly. The aggregator already collapsed any
    // intra-batch duplicates, so we can ship the values straight in.
    await this.db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        target: [table.bucketStart, table.orgId, table.userId, table.clusterName],
        set: {
          cpuCoreSeconds: sqlExcluded("cpu_core_seconds"),
          gpuSeconds: sqlExcluded("gpu_seconds"),
          memoryMbSeconds: sqlExcluded("memory_mb_seconds"),
          storageMbSeconds: sqlExcluded("storage_mb_seconds"),
          networkEgressMb: sqlExcluded("network_egress_mb"),
          jobCount: sqlExcluded("job_count"),
        },
      });
  }

  async deleteRawOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(meteringUsageRaw)
      .where(lt(meteringUsageRaw.finishedAt, cutoff))
      .returning({ id: meteringUsageRaw.id });
    return deleted.length;
  }

  async deleteHourlyOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(meteringUsageHourly)
      .where(lt(meteringUsageHourly.bucketStart, cutoff))
      .returning({ bucketStart: meteringUsageHourly.bucketStart });
    return deleted.length;
  }

  async deleteDailyOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(meteringUsageDaily)
      .where(lt(meteringUsageDaily.bucketStart, cutoff))
      .returning({ bucketStart: meteringUsageDaily.bucketStart });
    return deleted.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Reference the EXCLUDED row in the ON CONFLICT DO UPDATE clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}

function bucketTableFor(period: Exclude<Period, "raw">): BucketTable {
  if (period === "hourly") return meteringUsageHourly;
  if (period === "daily") return meteringUsageDaily;
  return meteringUsageMonthly;
}

function scopeToCondition(
  // The Drizzle column type is parameterised over the column's data
  // type; we only need to compare it against a string array, so the
  // narrowest helper signature is "any UUID-bearing column on a PG
  // table" — captured by `inArray`'s own typing.
  orgIdColumn: Parameters<typeof inArray>[0],
  scope: TenantScope,
) {
  if (scope.kind === "all") return undefined;
  if (scope.orgIds.length === 0) {
    // Empty scope = the principal can see no data. Force an always-false
    // predicate so the driver returns zero rows without us having to
    // short-circuit at every call site.
    return sql`false`;
  }
  return inArray(orgIdColumn, scope.orgIds);
}

function rawDbRowToDomain(row: DbRawRow): UsageRawRow {
  return {
    id: row.id,
    jobId: row.jobId,
    userId: row.userId,
    orgId: row.orgId,
    agentId: row.agentId,
    clusterName: row.clusterName,
    appTemplateKey: row.appTemplateKey,
    cpuCoreSeconds: row.cpuCoreSeconds,
    gpuSeconds: row.gpuSeconds,
    memoryMbSeconds: row.memoryMbSeconds,
    storageMbSeconds: row.storageMbSeconds,
    // Drizzle returns `numeric` columns as `string` to preserve precision.
    // We coerce to number at the boundary so the domain layer sees the
    // same type the in-memory repo emits.
    networkEgressMb: numericStringToNumber(row.networkEgressMb),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    recordedAt: row.recordedAt,
    ...(row.metadata ? { metadata: row.metadata as Record<string, unknown> } : {}),
  };
}

function bucketDbRowToDomain(row: DbBucketRow): UsageBucketRow {
  return {
    bucketStart: row.bucketStart,
    userId: row.userId,
    orgId: row.orgId,
    clusterName: row.clusterName,
    cpuCoreSeconds: row.cpuCoreSeconds,
    gpuSeconds: row.gpuSeconds,
    memoryMbSeconds: row.memoryMbSeconds,
    storageMbSeconds: row.storageMbSeconds,
    networkEgressMb: numericStringToNumber(row.networkEgressMb),
    jobCount: row.jobCount,
  };
}

function numericStringToNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`metering: numeric column produced non-finite value: ${value}`);
  }
  return n;
}
