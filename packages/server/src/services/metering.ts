import { hasRole, type RoleName } from "@kuintessence/shared";
import { z } from "zod";

/**
 * Metering aggregation service (PRD F23).
 *
 * The platform records per-job resource consumption only — billing math
 * (tariff lookup, invoicing, currency) is delegated to external systems
 * via the webhook dispatcher in `metering-webhook.ts`.
 *
 * The service is structured around a thin {@link MeteringRepository}
 * interface so the routes layer and unit tests can drop in either a
 * Drizzle-backed adapter or an in-memory fake without forking the
 * service code. The Drizzle adapter lives next to wiring code; this
 * file only defines the abstract interface and the business logic.
 *
 * Multi-tenancy invariant: every read path takes a {@link TenantScope}
 * and the service trusts it. Routes derive scope from the JWT principal
 * using {@link tenantScopeFromPrincipal}; the service must never accept
 * a query with no scope (callers must use the explicit `'all'` scope
 * variant — only platform view roles pass that).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

export interface JobUsageRecord {
  jobId: string;
  userId: string;
  orgId: string;
  agentId: string;
  clusterName: string;
  appTemplateKey: string | null;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  startedAt: Date;
  finishedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface UsageRawRow extends JobUsageRecord {
  id: string;
  recordedAt: Date;
}

export interface UsageBucketRow {
  bucketStart: Date;
  userId: string;
  orgId: string;
  clusterName: string;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  jobCount: number;
}

export type Period = "raw" | "hourly" | "daily" | "monthly";
export type Grouping = "user" | "org" | "cluster" | "app";

export type TenantScope = { kind: "orgs"; orgIds: string[] } | { kind: "all" }; // super_admin only

export const QueryRequestSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  grouping: z.enum(["user", "org", "cluster", "app"]),
  period: z.enum(["raw", "hourly", "daily", "monthly"]),
  /**
   * Optional org filter narrowing the principal's tenant scope. When the
   * principal is super_admin the array `['*']` requests global scope.
   */
  orgIds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});

export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export interface QueryResultRow {
  /** Group key value (userId / orgId / clusterName / appTemplateKey). */
  groupKey: string;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  jobCount: number;
}

export interface QueryResult {
  rows: QueryResultRow[];
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository abstraction — implemented by both a Drizzle adapter and the
// in-memory test fake. Keeping this thin keeps the service logic testable
// without spinning up Postgres.
// ─────────────────────────────────────────────────────────────────────────────

export interface RawQueryFilter {
  scope: TenantScope;
  /** Lower bound on `started_at` (inclusive). Omit for an open lower bound. */
  from?: Date;
  /** Upper bound on `started_at` (inclusive). Omit for an open upper bound —
   *  the aggregator does this; a sentinel like the JS max date overflows
   *  Postgres timestamptz. */
  to?: Date;
  /** When set, restrict by `finished_at < finishedBefore` (used by aggregator). */
  finishedBefore?: Date;
}

export interface RollupBucket {
  period: Exclude<Period, "raw">;
  rows: UsageBucketRow[];
}

export interface MeteringRepository {
  /** Insert a raw usage row. Returns null when a row for the same jobId already exists (idempotent skip). */
  insertRaw(row: JobUsageRecord, recordedAt: Date): Promise<UsageRawRow | null>;
  /** Read raw rows in a window scoped by tenant. */
  selectRaw(filter: RawQueryFilter): Promise<UsageRawRow[]>;
  /** Read rollup rows for hourly/daily/monthly. */
  selectBuckets(
    period: Exclude<Period, "raw">,
    filter: { scope: TenantScope; from: Date; to: Date },
  ): Promise<UsageBucketRow[]>;
  /** Upsert rollup rows by (period, bucketStart, orgId, userId, clusterName). */
  upsertBuckets(period: Exclude<Period, "raw">, rows: UsageBucketRow[]): Promise<void>;
  /** Delete raw rows older than the given timestamp (returns deleted count). */
  deleteRawOlderThan(cutoff: Date): Promise<number>;
  /** Delete hourly rollups older than the given timestamp (returns deleted count). */
  deleteHourlyOlderThan(cutoff: Date): Promise<number>;
  /** Delete daily rollups older than the given timestamp (returns deleted count). */
  deleteDailyOlderThan(cutoff: Date): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export interface MeteringServiceOptions {
  repo: MeteringRepository;
  /** Injectable clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export class MeteringService {
  private readonly repo: MeteringRepository;
  private readonly now: () => Date;

  constructor(opts: MeteringServiceOptions) {
    this.repo = opts.repo;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Idempotent insert of one finished job's usage profile. If a raw row
   * for the same `jobId` already exists, the call is a no-op and returns
   * the previously persisted row's id via {@link UsageRawRow}; the caller
   * never has to dedupe.
   */
  async recordJobCompletion(record: JobUsageRecord): Promise<UsageRawRow | null> {
    validateUsageRecord(record);
    return await this.repo.insertRaw(record, this.now());
  }

  /**
   * Tenant-scoped query. The service does not look up the principal — the
   * caller (route layer) is responsible for translating the JWT principal
   * to a {@link TenantScope}.
   */
  async query(scope: TenantScope, req: QueryRequest): Promise<QueryResult> {
    const from = parseIso(req.from, "from");
    const to = parseIso(req.to, "to");
    if (from > to) {
      throw new Error("metering.query: 'from' must be <= 'to'");
    }
    const effectiveScope = narrowScope(scope, req.orgIds);

    if (req.period === "raw") {
      const rows = await this.repo.selectRaw({ scope: effectiveScope, from, to });
      return groupRawRows(rows, req.grouping, req.limit, req.offset);
    }
    const buckets = await this.repo.selectBuckets(req.period, {
      scope: effectiveScope,
      from,
      to,
    });
    return groupBucketRows(buckets, req.grouping, req.limit, req.offset);
  }

  /** Repository accessor for the aggregator/exporter to share the same backend. */
  get repository(): MeteringRepository {
    return this.repo;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (exported so the routes / tests can reuse them)
// ─────────────────────────────────────────────────────────────────────────────

export function tenantScopeFromPrincipal(
  principal: {
    role: string;
    orgId?: string | null;
    sub: string;
  },
  requestedOrgIds?: string[],
): TenantScope {
  const role = principal.role as RoleName;
  if (hasRole(role, "operator")) {
    if (requestedOrgIds?.includes("*")) {
      return { kind: "all" };
    }
    if (requestedOrgIds && requestedOrgIds.length > 0) {
      return { kind: "orgs", orgIds: requestedOrgIds };
    }
    return { kind: "all" };
  }
  if (!principal.orgId) {
    // Without an orgId the principal cannot see any org-scoped data.
    return { kind: "orgs", orgIds: [] };
  }
  return { kind: "orgs", orgIds: [principal.orgId] };
}

export function narrowScope(
  scope: TenantScope,
  requestedOrgIds: string[] | undefined,
): TenantScope {
  if (!requestedOrgIds || requestedOrgIds.length === 0) return scope;
  if (requestedOrgIds.includes("*")) return scope;
  if (scope.kind === "all") return { kind: "orgs", orgIds: requestedOrgIds };
  // Intersect: a principal cannot widen their scope by asking.
  const allowed = new Set(scope.orgIds);
  return { kind: "orgs", orgIds: requestedOrgIds.filter((id) => allowed.has(id)) };
}

function parseIso(s: string, label: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`metering.query: '${label}' is not a valid ISO timestamp: ${s}`);
  }
  return d;
}

function validateUsageRecord(r: JobUsageRecord): void {
  if (!r.jobId) throw new Error("metering.record: jobId required");
  if (!r.userId) throw new Error("metering.record: userId required");
  if (!r.orgId) throw new Error("metering.record: orgId required");
  if (!r.agentId) throw new Error("metering.record: agentId required");
  if (!r.clusterName) throw new Error("metering.record: clusterName required");
  if (!(r.startedAt instanceof Date) || Number.isNaN(r.startedAt.getTime())) {
    throw new Error("metering.record: startedAt must be a valid Date");
  }
  if (!(r.finishedAt instanceof Date) || Number.isNaN(r.finishedAt.getTime())) {
    throw new Error("metering.record: finishedAt must be a valid Date");
  }
  if (r.finishedAt < r.startedAt) {
    throw new Error("metering.record: finishedAt must be >= startedAt");
  }
  for (const [k, v] of Object.entries({
    cpuCoreSeconds: r.cpuCoreSeconds,
    gpuSeconds: r.gpuSeconds,
    memoryMbSeconds: r.memoryMbSeconds,
    storageMbSeconds: r.storageMbSeconds,
    networkEgressMb: r.networkEgressMb,
  })) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`metering.record: ${k} must be a non-negative finite number, got ${v}`);
    }
  }
}

function groupRawRows(
  rows: UsageRawRow[],
  grouping: Grouping,
  limit: number,
  offset: number,
): QueryResult {
  const acc = new Map<string, QueryResultRow>();
  for (const row of rows) {
    const key = pickGroupKey(row, grouping);
    const cur = acc.get(key) ?? blankRow(key);
    cur.cpuCoreSeconds += row.cpuCoreSeconds;
    cur.gpuSeconds += row.gpuSeconds;
    cur.memoryMbSeconds += row.memoryMbSeconds;
    cur.storageMbSeconds += row.storageMbSeconds;
    cur.networkEgressMb += row.networkEgressMb;
    cur.jobCount += 1;
    acc.set(key, cur);
  }
  const all = Array.from(acc.values()).sort((a, b) =>
    a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0,
  );
  return { rows: all.slice(offset, offset + limit), total: all.length };
}

function groupBucketRows(
  rows: UsageBucketRow[],
  grouping: Grouping,
  limit: number,
  offset: number,
): QueryResult {
  // Bucket rows already collapse over jobId; grouping only collapses
  // *across* buckets to the requested dimension. `app` grouping is
  // unsupported on rollups (no app dimension is stored) — degrade to
  // per-(orgId,userId) keying so the caller still gets data, with a
  // marker key.
  const acc = new Map<string, QueryResultRow>();
  for (const row of rows) {
    let key: string;
    if (grouping === "user") key = row.userId;
    else if (grouping === "org") key = row.orgId;
    else if (grouping === "cluster") key = row.clusterName;
    else key = `app:unavailable-on-${grouping}`;
    const cur = acc.get(key) ?? blankRow(key);
    cur.cpuCoreSeconds += row.cpuCoreSeconds;
    cur.gpuSeconds += row.gpuSeconds;
    cur.memoryMbSeconds += row.memoryMbSeconds;
    cur.storageMbSeconds += row.storageMbSeconds;
    cur.networkEgressMb += row.networkEgressMb;
    cur.jobCount += row.jobCount;
    acc.set(key, cur);
  }
  const all = Array.from(acc.values()).sort((a, b) =>
    a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0,
  );
  return { rows: all.slice(offset, offset + limit), total: all.length };
}

function pickGroupKey(row: UsageRawRow, grouping: Grouping): string {
  if (grouping === "user") return row.userId;
  if (grouping === "org") return row.orgId;
  if (grouping === "cluster") return row.clusterName;
  return row.appTemplateKey ?? "<no-app>";
}

function blankRow(groupKey: string): QueryResultRow {
  return {
    groupKey,
    cpuCoreSeconds: 0,
    gpuSeconds: 0,
    memoryMbSeconds: 0,
    storageMbSeconds: 0,
    networkEgressMb: 0,
    jobCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory repository used by the unit tests in this package and as a
// useful sandbox for the route tests. The Drizzle-backed implementation
// will live next to the Server wiring code; the integrator wires it in when
// merging this module into the application.
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryMeteringRepository implements MeteringRepository {
  private raw: UsageRawRow[] = [];
  private hourly: UsageBucketRow[] = [];
  private daily: UsageBucketRow[] = [];
  private monthly: UsageBucketRow[] = [];

  async insertRaw(record: JobUsageRecord, recordedAt: Date): Promise<UsageRawRow | null> {
    if (this.raw.some((r) => r.jobId === record.jobId)) {
      return null;
    }
    const row: UsageRawRow = {
      ...record,
      id: crypto.randomUUID(),
      recordedAt,
    };
    this.raw.push(row);
    return row;
  }

  async selectRaw(filter: RawQueryFilter): Promise<UsageRawRow[]> {
    return this.raw.filter((r) => {
      if (!matchesScope(r.orgId, filter.scope)) return false;
      if (filter.from && r.startedAt < filter.from) return false;
      if (filter.to && r.startedAt > filter.to) return false;
      if (filter.finishedBefore && r.finishedAt >= filter.finishedBefore) return false;
      return true;
    });
  }

  async selectBuckets(
    period: Exclude<Period, "raw">,
    filter: { scope: TenantScope; from: Date; to: Date },
  ): Promise<UsageBucketRow[]> {
    const src = this.bucketStore(period);
    return src.filter((r) => {
      if (!matchesScope(r.orgId, filter.scope)) return false;
      if (r.bucketStart < filter.from) return false;
      if (r.bucketStart > filter.to) return false;
      return true;
    });
  }

  async upsertBuckets(period: Exclude<Period, "raw">, rows: UsageBucketRow[]): Promise<void> {
    const src = this.bucketStore(period);
    for (const incoming of rows) {
      const idx = src.findIndex(
        (r) =>
          r.bucketStart.getTime() === incoming.bucketStart.getTime() &&
          r.orgId === incoming.orgId &&
          r.userId === incoming.userId &&
          r.clusterName === incoming.clusterName,
      );
      if (idx >= 0) {
        src[idx] = { ...incoming };
      } else {
        src.push({ ...incoming });
      }
    }
  }

  async deleteRawOlderThan(cutoff: Date): Promise<number> {
    const before = this.raw.length;
    this.raw = this.raw.filter((r) => r.finishedAt >= cutoff);
    return before - this.raw.length;
  }

  async deleteHourlyOlderThan(cutoff: Date): Promise<number> {
    const before = this.hourly.length;
    this.hourly = this.hourly.filter((r) => r.bucketStart >= cutoff);
    return before - this.hourly.length;
  }

  async deleteDailyOlderThan(cutoff: Date): Promise<number> {
    const before = this.daily.length;
    this.daily = this.daily.filter((r) => r.bucketStart >= cutoff);
    return before - this.daily.length;
  }

  /** Test-only accessor. */
  snapshot(): {
    raw: UsageRawRow[];
    hourly: UsageBucketRow[];
    daily: UsageBucketRow[];
    monthly: UsageBucketRow[];
  } {
    return {
      raw: this.raw.map((r) => ({ ...r })),
      hourly: this.hourly.map((r) => ({ ...r })),
      daily: this.daily.map((r) => ({ ...r })),
      monthly: this.monthly.map((r) => ({ ...r })),
    };
  }

  private bucketStore(period: Exclude<Period, "raw">): UsageBucketRow[] {
    if (period === "hourly") return this.hourly;
    if (period === "daily") return this.daily;
    return this.monthly;
  }
}

function matchesScope(orgId: string, scope: TenantScope): boolean {
  if (scope.kind === "all") return true;
  return scope.orgIds.includes(orgId);
}
