import { meteringCronPeriods, type PgDb, type PgTransaction } from "@kuintessence/db";
import { eq, lt } from "drizzle-orm";
import type { MeteringStage } from "./metering-cron";

export async function runMeteringPeriod(
  db: PgDb,
  stage: MeteringStage,
  periodStart: Date,
  work: (tx: PgTransaction, previousStart: Date | null) => Promise<void>,
) {
  try {
    await db.transaction(
      async (tx) => {
        const [previous] = await tx
          .select()
          .from(meteringCronPeriods)
          .where(eq(meteringCronPeriods.stage, stage));
        if (previous && previous.periodStart >= periodStart) return;
        const claimed = await tx
          .insert(meteringCronPeriods)
          .values({ stage, periodStart })
          .onConflictDoUpdate({
            target: meteringCronPeriods.stage,
            set: { periodStart },
            setWhere: lt(meteringCronPeriods.periodStart, periodStart),
          })
          .returning({ stage: meteringCronPeriods.stage });
        if (claimed.length) await work(tx, previous?.periodStart ?? null);
      },
      { isolationLevel: "repeatable read" },
    );
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "40001"))
      throw err;
    const [completed] = await db
      .select()
      .from(meteringCronPeriods)
      .where(eq(meteringCronPeriods.stage, stage));
    if (!completed || completed.periodStart < periodStart) throw err;
  }
}
