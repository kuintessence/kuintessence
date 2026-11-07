import { type SchedulerAccounting, SchedulerAccountingSchema } from "@kuintessence/shared";

export function accountingInteger(value: unknown): string | undefined {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return;
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value).trim();
  if (!/^[0-9]{1,38}$/.test(text)) return;
  return BigInt(text).toString();
}

/** Slurm may use MM:SS.fraction; PBS uses HH:MM:SS. Sub-millisecond tails are truncated. */
export function accountingDuration(value: unknown, short = false): string | undefined {
  if (typeof value !== "string") return;
  const match = /^(?:(\d{1,20})-)?(\d{1,20}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/.exec(
    value.trim(),
  );
  if (!match) return;
  const [, days, first, second, third, fraction] = match;
  if (!first || !second || (!third && (!short || days))) return;
  const seconds = BigInt(third ?? second);
  const minutes = BigInt(third ? second : first);
  const hours = BigInt(third ? first : "0");
  if (seconds > 59n || (third && minutes > 59n) || (days && hours > 23n)) return;
  return (
    ((BigInt(days ?? "0") * 24n + hours) * 3600n + minutes * 60n + seconds) * 1000n +
    BigInt((fraction ?? "").padEnd(3, "0").slice(0, 3))
  ).toString();
}

export function schedulerAccounting(
  source: SchedulerAccounting["source"],
  schedulerJobId: string,
  quantities: Pick<
    SchedulerAccounting,
    "elapsedMilliseconds" | "cpuTimeMilliseconds" | "allocatedCpus"
  >,
): SchedulerAccounting | undefined {
  const parsed = SchedulerAccountingSchema.safeParse({
    version: 1,
    source,
    schedulerJobId,
    observedAt: new Date().toISOString(),
    ...quantities,
  });
  return parsed.success ? parsed.data : undefined;
}
