import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Metering aggregation tables (PRD F23).
 *
 * The platform records per-job resource consumption only — billing math
 * and tariff lookup are external. The four tables below form a four-tier
 * roll-up pipeline:
 *
 *    metering_usage_raw        (one row per finished job, immutable)
 *      │  hourly rollup (>= 7 days old → collapse, then DELETE)
 *      ▼
 *    metering_usage_hourly     (org/user/cluster bucket, 1-hour grain)
 *      │  daily rollup (>= 90 days old → collapse, then DELETE)
 *      ▼
 *    metering_usage_daily      (org/user/cluster bucket, 1-day grain)
 *      │  monthly rollup (kept indefinitely)
 *      ▼
 *    metering_usage_monthly
 *
 * The composite primary key on each rollup table makes
 * `INSERT … ON CONFLICT DO UPDATE` the natural idempotent upsert path.
 *
 * `metering_webhook` lets a CP/admin attach an external billing system as
 * a subscriber for `usage.daily` / `usage.monthly` events. The dispatcher
 * signs payloads with HMAC-SHA256 using the per-row `secret`. Failures
 * are tracked in `failures` so the UI can disable a flapping endpoint.
 *
 * Foreign keys to `jobs` and `users` are intentionally omitted on
 * `metering_usage_raw` — the metering ingest path must never block on
 * a parent constraint and the soft references are checked by the service
 * layer at write time.
 */

export const meteringUsageRaw = pgTable(
  "metering_usage_raw",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Soft reference to jobs.id. No FK to keep ingestion fast. */
    jobId: uuid("job_id").notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    agentId: text("agent_id").notNull(),
    clusterName: text("cluster_name").notNull(),
    appTemplateKey: text("app_template_key"),
    cpuCoreSeconds: bigint("cpu_core_seconds", { mode: "number" }).notNull(),
    gpuSeconds: bigint("gpu_seconds", { mode: "number" }).notNull().default(0),
    memoryMbSeconds: bigint("memory_mb_seconds", { mode: "number" }).notNull(),
    storageMbSeconds: bigint("storage_mb_seconds", { mode: "number" }).notNull().default(0),
    networkEgressMb: numeric("network_egress_mb", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => ({
    jobIdUniq: uniqueIndex("metering_usage_raw_job_id_idx").on(t.jobId),
    orgStartedIdx: index("metering_usage_raw_org_started_idx").on(t.orgId, t.startedAt),
    userStartedIdx: index("metering_usage_raw_user_started_idx").on(t.userId, t.startedAt),
    clusterStartedIdx: index("metering_usage_raw_cluster_started_idx").on(
      t.clusterName,
      t.startedAt,
    ),
    finishedAtIdx: index("metering_usage_raw_finished_at_idx").on(t.finishedAt),
  }),
);

export const meteringUsageHourly = pgTable(
  "metering_usage_hourly",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    clusterName: text("cluster_name").notNull(),
    cpuCoreSeconds: bigint("cpu_core_seconds", { mode: "number" }).notNull().default(0),
    gpuSeconds: bigint("gpu_seconds", { mode: "number" }).notNull().default(0),
    memoryMbSeconds: bigint("memory_mb_seconds", { mode: "number" }).notNull().default(0),
    storageMbSeconds: bigint("storage_mb_seconds", { mode: "number" }).notNull().default(0),
    networkEgressMb: numeric("network_egress_mb", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    jobCount: integer("job_count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.bucketStart, t.orgId, t.userId, t.clusterName],
      name: "metering_usage_hourly_pk",
    }),
    orgBucketIdx: index("metering_usage_hourly_org_bucket_idx").on(t.orgId, t.bucketStart),
  }),
);

export const meteringUsageDaily = pgTable(
  "metering_usage_daily",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    clusterName: text("cluster_name").notNull(),
    cpuCoreSeconds: bigint("cpu_core_seconds", { mode: "number" }).notNull().default(0),
    gpuSeconds: bigint("gpu_seconds", { mode: "number" }).notNull().default(0),
    memoryMbSeconds: bigint("memory_mb_seconds", { mode: "number" }).notNull().default(0),
    storageMbSeconds: bigint("storage_mb_seconds", { mode: "number" }).notNull().default(0),
    networkEgressMb: numeric("network_egress_mb", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    jobCount: integer("job_count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.bucketStart, t.orgId, t.userId, t.clusterName],
      name: "metering_usage_daily_pk",
    }),
    orgBucketIdx: index("metering_usage_daily_org_bucket_idx").on(t.orgId, t.bucketStart),
  }),
);

export const meteringUsageMonthly = pgTable(
  "metering_usage_monthly",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    clusterName: text("cluster_name").notNull(),
    cpuCoreSeconds: bigint("cpu_core_seconds", { mode: "number" }).notNull().default(0),
    gpuSeconds: bigint("gpu_seconds", { mode: "number" }).notNull().default(0),
    memoryMbSeconds: bigint("memory_mb_seconds", { mode: "number" }).notNull().default(0),
    storageMbSeconds: bigint("storage_mb_seconds", { mode: "number" }).notNull().default(0),
    networkEgressMb: numeric("network_egress_mb", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    jobCount: integer("job_count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.bucketStart, t.orgId, t.userId, t.clusterName],
      name: "metering_usage_monthly_pk",
    }),
    orgBucketIdx: index("metering_usage_monthly_org_bucket_idx").on(t.orgId, t.bucketStart),
  }),
);

export const meteringWebhook = pgTable(
  "metering_webhook",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    url: text("url").notNull(),
    /** HMAC-SHA256 signing key for webhook payloads. */
    secret: text("secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Subscribed event types — e.g. ['usage.daily', 'usage.monthly']. */
    events: text("events").array().notNull().default(sql`ARRAY[]::text[]`),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    failures: integer("failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("metering_webhook_org_idx").on(t.orgId),
    enabledCheck: check("metering_webhook_failures_check", sql`${t.failures} >= 0`),
  }),
);

/**
 * Convenience namespace re-export so the integrator can `import { MeteringSchemaTables }`
 * and merge the whole bundle into the root schema barrel without naming each table.
 */
export const MeteringSchemaTables = {
  meteringUsageRaw,
  meteringUsageHourly,
  meteringUsageDaily,
  meteringUsageMonthly,
  meteringWebhook,
} as const;

export type MeteringUsageRawRow = typeof meteringUsageRaw.$inferSelect;
export type MeteringUsageRawInsert = typeof meteringUsageRaw.$inferInsert;
export type MeteringUsageBucketRow = typeof meteringUsageHourly.$inferSelect;
export type MeteringUsageBucketInsert = typeof meteringUsageHourly.$inferInsert;
export type MeteringWebhookRow = typeof meteringWebhook.$inferSelect;
export type MeteringWebhookInsert = typeof meteringWebhook.$inferInsert;
