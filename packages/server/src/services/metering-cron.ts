// Metering rollup cron driver.
//
// Wraps {@link MeteringAggregator} with a `setInterval`-based ticker so the
// production Server keeps the rollup pipeline (raw → hourly → daily → monthly)
// running without an external scheduler.
//
// Tick policy:
//   - Hourly rollup: every tick (default interval 1h).
//   - Daily rollup: only when the UTC day has changed since `lastDailyRunAt`.
//   - Monthly rollup: only when the UTC month has changed since
//     `lastMonthlyRunAt`.
//
// The cron logs every tick and never throws — exceptions are caught and
// logged so a transient DB hiccup doesn't kill the cron loop. `start()`
// runs an immediate tick before scheduling, `stop()` clears the interval
// and awaits any in-flight tick before returning.

import { createLogger } from "@kuintessence/shared";
import type { Logger } from "pino";

export interface AggregatorPort {
  runHourlyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }>;
  runDailyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }>;
  runMonthlyRollup(): Promise<{ bucketsWritten: number; sourceRowsDeleted: number }>;
}

export interface WebhookEmitterPort {
  emitDailySummary(from: Date, to: Date): Promise<unknown>;
  emitMonthlySummary(from: Date, to: Date): Promise<unknown>;
}

export interface MeteringCronOptions {
  aggregator: AggregatorPort;
  /**
   * Optional daily usage-summary emitter. When present, a day-boundary tick
   * fires a `usage.daily` webhook for the previous UTC day after the daily
   * rollup. Best-effort — a failure here never aborts the tick.
   */
  webhookEmitter?: WebhookEmitterPort;
  /** Tick interval in ms. Defaults to 1 hour. */
  intervalMs?: number;
  /** Logger override — defaults to pino('metering-cron'). */
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class MeteringCron {
  private readonly aggregator: AggregatorPort;
  private readonly webhookEmitter: WebhookEmitterPort | null;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastDailyRunAt: Date | null = null;
  private lastMonthlyRunAt: Date | null = null;
  private stopped = false;

  constructor(opts: MeteringCronOptions) {
    this.aggregator = opts.aggregator;
    this.webhookEmitter = opts.webhookEmitter ?? null;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.logger = opts.logger ?? createLogger("metering-cron");
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Run an immediate tick, then schedule periodic ticks. Safe to call
   * twice — the second call is a no-op.
   */
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    // Kick off the first tick immediately so a freshly-started Server does not
    // wait a full interval before any rollup work happens.
    this.inFlight = this.tick();
    await this.inFlight.catch(() => undefined);
    this.timer = setInterval(() => {
      // Each scheduled tick reuses `inFlight` so `stop()` can await it.
      this.inFlight = this.tick().catch((err: unknown) => {
        this.logger.error({ err }, "metering-cron: scheduled tick failed");
      });
    }, this.intervalMs);
    // Bun and Node both expose `unref` on the interval handle so it doesn't
    // keep the process alive after a graceful shutdown signal.
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
  }

  /**
   * Stop the cron. Clears the interval and awaits any in-flight tick.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
      this.inFlight = null;
    }
  }

  /**
   * Public entry-point for tests so they can drive a tick deterministically
   * without spinning the real interval.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    try {
      const hourly = await this.aggregator.runHourlyRollup();
      this.logger.info(
        { stage: "hourly", buckets: hourly.bucketsWritten, deleted: hourly.sourceRowsDeleted },
        "metering-cron: hourly rollup",
      );
    } catch (err) {
      this.logger.error({ err, stage: "hourly" }, "metering-cron: hourly rollup failed");
    }

    if (shouldRunDaily(this.lastDailyRunAt, now)) {
      try {
        const daily = await this.aggregator.runDailyRollup();
        this.lastDailyRunAt = now;
        this.logger.info(
          { stage: "daily", buckets: daily.bucketsWritten, deleted: daily.sourceRowsDeleted },
          "metering-cron: daily rollup",
        );
      } catch (err) {
        this.logger.error({ err, stage: "daily" }, "metering-cron: daily rollup failed");
      }

      if (this.webhookEmitter) {
        const dayEnd = utcMidnight(now);
        const dayStart = new Date(dayEnd.getTime() - 24 * 60 * 60 * 1000);
        try {
          await this.webhookEmitter.emitDailySummary(dayStart, dayEnd);
        } catch (err) {
          this.logger.error({ err, stage: "daily-webhook" }, "metering-cron: daily webhook failed");
        }
      }
    }

    if (shouldRunMonthly(this.lastMonthlyRunAt, now)) {
      try {
        const monthly = await this.aggregator.runMonthlyRollup();
        this.lastMonthlyRunAt = now;
        this.logger.info(
          {
            stage: "monthly",
            buckets: monthly.bucketsWritten,
            deleted: monthly.sourceRowsDeleted,
          },
          "metering-cron: monthly rollup",
        );
      } catch (err) {
        this.logger.error({ err, stage: "monthly" }, "metering-cron: monthly rollup failed");
      }

      if (this.webhookEmitter) {
        const monthEnd = utcMonthStart(now);
        const monthStart = new Date(
          Date.UTC(monthEnd.getUTCFullYear(), monthEnd.getUTCMonth() - 1, 1),
        );
        try {
          await this.webhookEmitter.emitMonthlySummary(monthStart, monthEnd);
        } catch (err) {
          this.logger.error(
            { err, stage: "monthly-webhook" },
            "metering-cron: monthly webhook failed",
          );
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure boundary-detection helpers — exported for testability.
// ─────────────────────────────────────────────────────────────────────────────

/** Floor a timestamp to 00:00:00.000 UTC of the same calendar day. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Floor a timestamp to 00:00:00.000 UTC of the 1st of the same calendar month. */
export function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function shouldRunDaily(lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true;
  return (
    lastRunAt.getUTCFullYear() !== now.getUTCFullYear() ||
    lastRunAt.getUTCMonth() !== now.getUTCMonth() ||
    lastRunAt.getUTCDate() !== now.getUTCDate()
  );
}

export function shouldRunMonthly(lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true;
  return (
    lastRunAt.getUTCFullYear() !== now.getUTCFullYear() ||
    lastRunAt.getUTCMonth() !== now.getUTCMonth()
  );
}
