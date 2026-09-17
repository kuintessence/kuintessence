import { describe, expect, test } from "bun:test";
import { percentile } from "./percentile";

describe("percentile", () => {
  test("p95 of a uniform 1..100 set is ~95", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 0.95)).toBe(95);
  });
  test("single value returns that value", () => {
    expect(percentile([42], 0.95)).toBe(42);
  });
  test("empty input returns 0", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
  test("unsorted input is handled (nearest-rank)", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
  });
  test("clamps p into [0,1]", () => {
    expect(percentile([1, 2, 3], 2)).toBe(3);
    expect(percentile([1, 2, 3], -1)).toBe(1);
  });
});
