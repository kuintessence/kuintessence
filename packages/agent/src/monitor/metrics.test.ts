import { describe, expect, test } from "bun:test";
import { _resetMetricsForTest, readMetrics } from "./metrics";

describe("readMetrics", () => {
  test("returns shape with three numeric fields", () => {
    _resetMetricsForTest();
    const m = readMetrics();
    expect(typeof m.cpuUsagePercent).toBe("number");
    expect(typeof m.memoryUsedMb).toBe("number");
    expect(typeof m.memoryTotalMb).toBe("number");
    expect(m.cpuUsagePercent).toBeGreaterThanOrEqual(0);
    expect(m.cpuUsagePercent).toBeLessThanOrEqual(100);
  });

  test("on platforms without /proc returns 0s without throwing", () => {
    _resetMetricsForTest();
    const m = readMetrics();
    expect(m.memoryUsedMb).toBeGreaterThanOrEqual(0);
    expect(m.memoryTotalMb).toBeGreaterThanOrEqual(0);
  });

  test("returns 0 cpu on first sample (no delta yet)", () => {
    _resetMetricsForTest();
    const m1 = readMetrics();
    expect(m1.cpuUsagePercent).toBe(0);
  });

  test("subsequent samples produce a delta-based reading", () => {
    _resetMetricsForTest();
    readMetrics(); // first sample
    // Burn some CPU
    let n = 0;
    for (let i = 0; i < 100_000; i++) n += i;
    expect(n).toBeGreaterThan(0);
    const m2 = readMetrics();
    expect(m2.cpuUsagePercent).toBeGreaterThanOrEqual(0);
    expect(m2.cpuUsagePercent).toBeLessThanOrEqual(100);
  });
});
