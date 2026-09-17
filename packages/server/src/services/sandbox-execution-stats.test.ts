import { describe, expect, test } from "bun:test";
import { correctedOutputEstimate, sandboxInputSizeBucket } from "./sandbox-execution-stats";

describe("Sandbox execution statistics", () => {
  test("uses deterministic input size buckets", () => {
    expect(sandboxInputSizeBucket(0)).toBe("lt-1mib");
    expect(sandboxInputSizeBucket(1_048_576)).toBe("1-100mib");
    expect(sandboxInputSizeBucket(104_857_600)).toBe("100mib-1gib");
    expect(sandboxInputSizeBucket(1_073_741_824)).toBe("gte-1gib");
  });

  test("keeps manifest primary until history accumulates", () => {
    expect(
      correctedOutputEstimate({ manifestBytes: 1_000, historicalBytes: 9_000, sampleCount: 1 }),
    ).toBe(1_400);
    expect(
      correctedOutputEstimate({ manifestBytes: 1_000, historicalBytes: 9_000, sampleCount: 20 }),
    ).toBe(7_000);
  });
});
