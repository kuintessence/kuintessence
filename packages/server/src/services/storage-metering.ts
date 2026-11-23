import {
  meteringCronPeriods,
  netdriveFiles,
  netdriveStorageDaily,
  type PgDb,
} from "@kuintessence/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { runMeteringPeriod } from "./metering-cron-period";

export async function captureDailyStorage(db: PgDb) {
  // File lifetimes use the database clock while the writer holds its relation lock.
  // Defer closure if an in-flight writer's transaction start is hidden from this role.
  const [boundary] = await db
    .select({
      day: sql<string | null>`case when count(*) = count(activity.xact_start)
      then to_char(least(statement_timestamp(), min(activity.xact_start)) at time zone 'UTC', 'YYYY-MM-DD') end`,
    })
    .from(sql`pg_catalog.pg_locks locks
    left join pg_catalog.pg_stat_activity activity on activity.pid = locks.pid`)
    .where(sql`locks.locktype = 'relation' and locks.relation = 'netdrive_files'::regclass
      and locks.database = (select oid from pg_catalog.pg_database where datname = current_database())
      and locks.mode in ('RowExclusiveLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`);
  if (!boundary?.day) return;
  const endDay = boundary.day;
  await runMeteringPeriod(
    db,
    "storage-daily",
    new Date(`${endDay}T00:00:00Z`),
    async (tx, previous) => {
      await tx.execute(sql`
        with bounds as (
          select ${previous?.toISOString().slice(0, 10) ?? null}::date::timestamp as start_at,
                 ${endDay}::date::timestamp as end_at
        ), lifetimes as (
          select f.owner_id, f.size, greatest(f.created_at, b.start_at) as start_at,
                 least(f.deleted_at, b.end_at) as end_at
          from ${netdriveFiles} f cross join bounds b
          where f.created_at < b.end_at
            and (b.start_at is null or f.deleted_at is null or f.deleted_at > b.start_at)
        )
        insert into ${netdriveStorageDaily} (day, owner_id, byte_seconds)
        select day_start::date, owner_id,
               sum(size * extract(epoch from
                 least(end_at, day_start + interval '1 day') - greatest(start_at, day_start)))
        from lifetimes cross join lateral generate_series(
          date_trunc('day', start_at), end_at - interval '1 microsecond', interval '1 day'
        ) as days(day_start)
        where end_at > start_at
        group by day_start, owner_id
      `);
    },
  );
}

export async function readDailyStorage(
  db: PgDb,
  day: string,
  filter: {
    ownerId?: string;
    afterOwnerId?: string;
    limit: number;
  },
) {
  const [period] = await db
    .select()
    .from(meteringCronPeriods)
    .where(eq(meteringCronPeriods.stage, "storage-daily"));
  const ready = !!period && day < period.periodStart.toISOString().slice(0, 10);
  const rows = ready
    ? await db
        .select()
        .from(netdriveStorageDaily)
        .where(
          and(
            eq(netdriveStorageDaily.day, day),
            filter.ownerId ? eq(netdriveStorageDaily.ownerId, filter.ownerId) : undefined,
            filter.afterOwnerId ? gt(netdriveStorageDaily.ownerId, filter.afterOwnerId) : undefined,
          ),
        )
        .orderBy(asc(netdriveStorageDaily.ownerId))
        .limit(filter.limit + 1)
    : [];
  const usage = rows.slice(0, filter.limit);
  return {
    day,
    ready,
    usage,
    nextAfterOwnerId: rows.length > filter.limit ? usage.at(-1)?.ownerId : null,
  };
}
