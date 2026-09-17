// Tests for `MeteringCron`.
//
// Uses a hand-rolled `AggregatorPort` fake so the suite is fully Docker /
// PG free. The cron is exercised through its public `tick()` entry point
// rather than the real `setInterval` loop — that lets us assert daily /
// monthly boundary detection deterministically without sleeping.

import { describe, expect, it } from "bun:test";
import pino from "pino";
import {
  type AggregatorPort,
  MeteringCron,
  shouldRunDaily,
  shouldRunMonthly,
} from "../metering-cron";

class FakeAggregator implements AggregatorPort {
  hourlyCalls = 0;
  dailyCalls = 0;
  monthlyCalls = 0;
  shouldThrowOn: "hourly" | "daily" | "monthly" | null = null;

  async runHourlyRollup() {
    this.hourlyCalls += 1;
    if (this.shouldThrowOn === "hourly") throw new Error("boom-hourly");
    return { bucketsWritten: 0, sourceRowsDeleted: 0 };
  }
  async runDailyRollup() {
    this.dailyCalls += 1;
    if (this.shouldThrowOn === "daily") throw new Error("boom-daily");
    return { bucketsWritten: 0, sourceRowsDeleted: 0 };
  }
  async runMonthlyRollup() {
    this.monthlyCalls += 1;
    if (this.shouldThrowOn === "monthly") throw new Error("boom-monthly");
    return { bucketsWritten: 0, sourceRowsDeleted: 0 };
  }
}

const silentLogger = pino({ level: "silent" });

describe("MeteringCron", () => {
  it("ticks call hourly + daily + monthly on the first run", async () => {
    const agg = new FakeAggregator();
    const cron = new MeteringCron({
      aggregator: agg,
      logger: silentLogger,
      now: () => new Date("2026-04-30T12:00:00Z"),
    });
    await cron.tick();
    expect(agg.hourlyCalls).toBe(1);
    expect(agg.dailyCalls).toBe(1);
    expect(agg.monthlyCalls).toBe(1);
  });

  it("daily/monthly only run again when their boundary crosses", async () => {
    const agg = new FakeAggregator();
    let now = new Date("2026-04-30T12:00:00Z");
    const cron = new MeteringCron({
      aggregator: agg,
      logger: silentLogger,
      now: () => now,
    });
    await cron.tick();
    expect(agg.dailyCalls).toBe(1);
    expect(agg.monthlyCalls).toBe(1);

    // Hour passes, same day, same month — only hourly should re-run.
    now = new Date("2026-04-30T13:00:00Z");
    await cron.tick();
    expect(agg.hourlyCalls).toBe(2);
    expect(agg.dailyCalls).toBe(1);
    expect(agg.monthlyCalls).toBe(1);

    // Day flips — daily fires, monthly does not.
    now = new Date("2026-05-01T00:30:00Z");
    await cron.tick();
    expect(agg.hourlyCalls).toBe(3);
    expect(agg.dailyCalls).toBe(2);
    expect(agg.monthlyCalls).toBe(2); // Month also flipped (April → May)

    // Day flips again, same month — daily fires, monthly does not.
    now = new Date("2026-05-02T00:30:00Z");
    await cron.tick();
    expect(agg.dailyCalls).toBe(3);
    expect(agg.monthlyCalls).toBe(2);
  });

  it("stop() prevents further ticks and awaits in-flight work", async () => {
    const agg = new FakeAggregator();
    const cron = new MeteringCron({
      aggregator: agg,
      intervalMs: 60_000,
      logger: silentLogger,
    });
    await cron.start();
    expect(agg.hourlyCalls).toBeGreaterThanOrEqual(1);
    await cron.stop();
    const callsAfterStop = agg.hourlyCalls;
    // After stop, calling tick() returns immediately without calling agg.
    await cron.tick();
    expect(agg.hourlyCalls).toBe(callsAfterStop);
  });

  it("catches and logs aggregator errors without aborting subsequent stages", async () => {
    const agg = new FakeAggregator();
    agg.shouldThrowOn = "hourly";
    const cron = new MeteringCron({
      aggregator: agg,
      logger: silentLogger,
      now: () => new Date("2026-04-30T12:00:00Z"),
    });
    await cron.tick();
    // Hourly threw, but daily and monthly should still have been attempted.
    expect(agg.hourlyCalls).toBe(1);
    expect(agg.dailyCalls).toBe(1);
    expect(agg.monthlyCalls).toBe(1);
  });
});

class FakeEmitter {
  calls: Array<{ from: Date; to: Date }> = [];
  monthlyCalls: Array<{ from: Date; to: Date }> = [];
  async emitDailySummary(from: Date, to: Date): Promise<unknown> {
    this.calls.push({ from, to });
    return { orgs: 0, sent: 0, failed: 0 };
  }
  async emitMonthlySummary(from: Date, to: Date): Promise<unknown> {
    this.monthlyCalls.push({ from, to });
    return { orgs: 0, sent: 0, failed: 0 };
  }
}

describe("MeteringCron webhook emitter", () => {
  it("emits a [prevDay, day) summary on a day-boundary tick", async () => {
    const agg = new FakeAggregator();
    const emitter = new FakeEmitter();
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => new Date("2026-04-30T12:34:56Z"),
    });
    await cron.tick();
    expect(emitter.calls.length).toBe(1);
    expect(emitter.calls[0]?.from.toISOString()).toBe("2026-04-29T00:00:00.000Z");
    expect(emitter.calls[0]?.to.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("does not emit on a same-day tick", async () => {
    const agg = new FakeAggregator();
    const emitter = new FakeEmitter();
    let now = new Date("2026-04-30T12:00:00Z");
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => now,
    });
    await cron.tick();
    expect(emitter.calls.length).toBe(1);
    now = new Date("2026-04-30T18:00:00Z");
    await cron.tick();
    expect(emitter.calls.length).toBe(1);
  });

  it("a throwing emitter never aborts the tick", async () => {
    const agg = new FakeAggregator();
    const emitter = {
      async emitDailySummary(): Promise<unknown> {
        throw new Error("emit boom");
      },
      async emitMonthlySummary(): Promise<unknown> {
        throw new Error("emit boom monthly");
      },
    };
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => new Date("2026-04-30T12:00:00Z"),
    });
    await cron.tick();
    expect(agg.dailyCalls).toBe(1);
    expect(agg.monthlyCalls).toBe(1);
  });

  it("emits a [prevMonth, month) summary on a month-boundary tick", async () => {
    const agg = new FakeAggregator();
    const emitter = new FakeEmitter();
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => new Date("2026-05-03T08:15:00Z"),
    });
    await cron.tick();
    expect(emitter.monthlyCalls.length).toBe(1);
    expect(emitter.monthlyCalls[0]?.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(emitter.monthlyCalls[0]?.to.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("month-boundary window rolls the year back for a January tick", async () => {
    const agg = new FakeAggregator();
    const emitter = new FakeEmitter();
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => new Date("2026-01-09T08:15:00Z"),
    });
    await cron.tick();
    expect(emitter.monthlyCalls.length).toBe(1);
    expect(emitter.monthlyCalls[0]?.from.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(emitter.monthlyCalls[0]?.to.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not emit monthly on a same-month tick", async () => {
    const agg = new FakeAggregator();
    const emitter = new FakeEmitter();
    let now = new Date("2026-05-03T08:00:00Z");
    const cron = new MeteringCron({
      aggregator: agg,
      webhookEmitter: emitter,
      logger: silentLogger,
      now: () => now,
    });
    await cron.tick();
    expect(emitter.monthlyCalls.length).toBe(1);
    now = new Date("2026-05-20T08:00:00Z");
    await cron.tick();
    expect(emitter.monthlyCalls.length).toBe(1);
  });
});

describe("shouldRunDaily / shouldRunMonthly", () => {
  it("treat null as 'never run yet' — always true", () => {
    expect(shouldRunDaily(null, new Date("2026-04-30T00:00:00Z"))).toBe(true);
    expect(shouldRunMonthly(null, new Date("2026-04-30T00:00:00Z"))).toBe(true);
  });

  it("daily: false when same UTC day, true when day flips", () => {
    const a = new Date("2026-04-30T01:00:00Z");
    expect(shouldRunDaily(a, new Date("2026-04-30T23:59:00Z"))).toBe(false);
    expect(shouldRunDaily(a, new Date("2026-05-01T00:00:00Z"))).toBe(true);
  });

  it("monthly: false when same UTC month, true when month flips", () => {
    const a = new Date("2026-04-15T12:00:00Z");
    expect(shouldRunMonthly(a, new Date("2026-04-30T23:59:00Z"))).toBe(false);
    expect(shouldRunMonthly(a, new Date("2026-05-01T00:00:00Z"))).toBe(true);
  });
});
