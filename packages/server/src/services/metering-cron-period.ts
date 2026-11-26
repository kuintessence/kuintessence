import { meteringCronPeriods, type PgDb, type PgTransaction } from "@kuintessence/db";
import { eq, lt } from "drizzle-orm";
import { IncompleteMeteringSummary, type MeteringStage } from "./metering-cron";

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

/** Each missed summary commits separately so a receiver failure resumes at that window. */
export async function runDueMeteringPeriods(
  db: PgDb,
  stage: MeteringStage,
  latest: Date,
  work: (tx: PgTransaction, end: Date) => Promise<void>,
) {
  if (stage !== "daily-summary" && stage !== "monthly-summary")
    return runMeteringPeriod(db, stage, latest, (tx) => work(tx, latest));
  const baseline =
    stage === "daily-summary"
      ? new Date(latest.getTime() - 86_400_000)
      : new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() - 1, 1));
  // Persist the starting boundary even if the first ever delivery fails.
  await db
    .insert(meteringCronPeriods)
    .values({ stage, periodStart: baseline })
    .onConflictDoNothing();
  const [cursor] = await db
    .select()
    .from(meteringCronPeriods)
    .where(eq(meteringCronPeriods.stage, stage));
  const next = (date: Date) =>
    stage === "daily-summary"
      ? new Date(date.getTime() + 86_400_000)
      : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  if (!cursor) throw new Error("Missing metering summary cursor");
  for (let end = next(cursor.periodStart); end <= latest; end = next(end)) {
    let incomplete: IncompleteMeteringSummary | undefined;
    await runMeteringPeriod(db, stage, end, async (tx, previous) => {
      try {
        await work(tx, end);
      } catch (error) {
        if (!(error instanceof IncompleteMeteringSummary) || !previous) throw error;
        // Commit receiver failure counters without advancing the summary cursor.
        await tx
          .update(meteringCronPeriods)
          .set({ periodStart: previous })
          .where(eq(meteringCronPeriods.stage, stage));
        incomplete = error;
      }
    });
    if (incomplete) throw incomplete;
  }
}
