import { expect, test } from "bun:test";
import { createPgDb, meteringCronPeriods } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { IncompleteMeteringSummary } from "./metering-cron";
import { runDueMeteringPeriods, runMeteringPeriod } from "./metering-cron-period";

const url = process.env.KQ_PG_URL ?? process.env.DATABASE_URL;
test.skipIf(!url || !new URL(url).pathname.startsWith("/kuintessence_unit_"))(
  "independent cron clients share completion and take over rolled-back work",
  async () => {
    if (!url) throw new Error("Missing test database");
    const first = createPgDb(url);
    const second = createPgDb(url);
    const stage = "daily";
    const period = new Date("2026-10-02T00:00:00Z");
    let invoked = 0;
    const count = async () => {
      invoked++;
    };
    try {
      await first.delete(meteringCronPeriods).where(eq(meteringCronPeriods.stage, stage));
      await expect(
        runMeteringPeriod(first, stage, period, async () => {
          throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      await Promise.all([first, second].map((db) => runMeteringPeriod(db, stage, period, count)));
      await runMeteringPeriod(first, stage, new Date("2026-10-01T00:00:00Z"), count);
      await runMeteringPeriod(second, stage, period, count);
      expect(invoked).toBe(1);
      await runMeteringPeriod(second, stage, new Date("2026-10-03T00:00:00Z"), count);
      expect(invoked).toBe(2);
    } finally {
      await first.delete(meteringCronPeriods).where(eq(meteringCronPeriods.stage, stage));
      await Promise.all([first.$client.end(), second.$client.end()]);
    }
  },
);

test.skipIf(!url || !new URL(url).pathname.startsWith("/kuintessence_unit_"))(
  "daily and monthly summaries resume at the first uncommitted window",
  async () => {
    if (!url) throw new Error("Missing test database");
    const db = createPgDb(url, { max: 3 });
    try {
      for (const [stage, dates] of [
        ["daily-summary", ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]],
        ["monthly-summary", ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]],
      ] as const) {
        await db.delete(meteringCronPeriods).where(eq(meteringCronPeriods.stage, stage));
        const ends: string[] = [];
        const run = (day: string, fail?: string) =>
          runDueMeteringPeriods(db, stage, new Date(day), async (_, end) => {
            const stamp = end.toISOString().slice(0, 10);
            if (stamp === fail) throw new IncompleteMeteringSummary("receiver failed");
            ends.push(stamp);
          });
        await expect(run(dates[0], dates[0])).rejects.toThrow("receiver failed");
        await expect(run(dates[3], dates[2])).rejects.toThrow("receiver failed");
        await Promise.all([run(dates[3]), run(dates[3])]);
        expect(ends).toEqual([...dates]);
      }
    } finally {
      await db.$client.end();
    }
  },
);
