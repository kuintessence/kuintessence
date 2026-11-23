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

export type MeteringStage =
  | "hourly"
  | "daily"
  | "monthly"
  | "daily-summary"
  | "monthly-summary"
  | "storage-daily";
export interface MeteringWorkers {
  aggregator: AggregatorPort;
  webhookEmitter?: WebhookEmitterPort;
}

export interface MeteringCronOptions {
  runPeriod: (
    stage: MeteringStage,
    periodStart: Date,
    work: (workers: MeteringWorkers) => Promise<void>,
  ) => Promise<void>;
  captureStorage: () => Promise<void>;
  summariesEnabled: boolean;
  intervalMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export class MeteringCron {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = false;
  private readonly logger: Logger;

  constructor(private readonly opts: MeteringCronOptions) {
    this.logger = opts.logger ?? createLogger("metering-cron");
  }

  async start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3_600_000);
    this.timer.unref();
    await this.tick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async tick() {
    if (this.stopped) return;
    this.inFlight ??= this.runTick().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async runTick() {
    const now = this.opts.now?.() ?? new Date();
    const hour = new Date(now);
    hour.setUTCMinutes(0, 0, 0);
    const day = utcMidnight(now);
    const month = utcMonthStart(now);
    const run = async (
      stage: MeteringStage,
      start: Date,
      work: (workers: MeteringWorkers) => Promise<void>,
    ) => {
      try {
        await this.opts.runPeriod(stage, start, work);
      } catch (err) {
        this.logger.error({ err, stage }, "Metering period failed");
      }
    };
    await run("hourly", hour, async ({ aggregator }) => {
      await aggregator.runHourlyRollup();
    });
    await run("daily", day, async ({ aggregator }) => {
      await aggregator.runDailyRollup();
    });
    await run("monthly", month, async ({ aggregator }) => {
      await aggregator.runMonthlyRollup();
    });
    try {
      await this.opts.captureStorage();
    } catch (err) {
      this.logger.error({ err, stage: "storage-daily" }, "Metering period failed");
    }
    if (!this.opts.summariesEnabled) return;
    await run("daily-summary", day, async ({ webhookEmitter }) => {
      if (!webhookEmitter) throw new Error("Missing metering webhook emitter");
      await webhookEmitter.emitDailySummary(new Date(day.getTime() - 86_400_000), day);
    });
    await run("monthly-summary", month, async ({ webhookEmitter }) => {
      if (!webhookEmitter) throw new Error("Missing metering webhook emitter");
      await webhookEmitter.emitMonthlySummary(
        new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)),
        month,
      );
    });
  }
}

/** Floor a timestamp to 00:00:00.000 UTC of the same calendar day. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Floor a timestamp to 00:00:00.000 UTC of the 1st of the same calendar month. */
export function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
