import { describe, expect, test } from "bun:test";
import { computeViewportRows, windowByHeight, windowRows } from "./viewport";

const items = Array.from({ length: 100 }, (_, i) => i);

describe("windowRows", () => {
  test("returns the whole list when it fits", () => {
    const w = windowRows([1, 2, 3], 0, 10);
    expect(w).toEqual({ rows: [1, 2, 3], startIndex: 0, hiddenAbove: 0, hiddenBelow: 0 });
  });

  test("centres the selection in the window", () => {
    const w = windowRows(items, 50, 10);
    expect(w.startIndex).toBe(45);
    expect(w.rows[0]).toBe(45);
    expect(w.rows).toHaveLength(10);
    expect(w.hiddenAbove).toBe(45);
    expect(w.hiddenBelow).toBe(45);
  });

  test("clamps to the top edge", () => {
    const w = windowRows(items, 0, 10);
    expect(w.startIndex).toBe(0);
    expect(w.hiddenAbove).toBe(0);
    expect(w.hiddenBelow).toBe(90);
    expect(w.rows[0]).toBe(0);
  });

  test("clamps to the bottom edge", () => {
    const w = windowRows(items, 99, 10);
    expect(w.startIndex).toBe(90);
    expect(w.hiddenAbove).toBe(90);
    expect(w.hiddenBelow).toBe(0);
    expect(w.rows.at(-1)).toBe(99);
  });

  test("height<=0 renders nothing; out-of-range selection is clamped", () => {
    expect(windowRows(items, 5, 0).rows).toHaveLength(0);
    expect(windowRows(items, 999, 10).rows.at(-1)).toBe(99);
  });
});

describe("windowByHeight", () => {
  test("returns the whole list when total height fits the budget", () => {
    const w = windowByHeight([1, 2, 3], 0, () => 2, 10);
    expect(w).toEqual({ rows: [1, 2, 3], startIndex: 0, hiddenAbove: 0, hiddenBelow: 0 });
  });

  test("budget<=0 renders nothing and counts all as hidden below", () => {
    const w = windowByHeight([1, 2, 3], 0, () => 2, 0);
    expect(w).toEqual({ rows: [], startIndex: 0, hiddenAbove: 0, hiddenBelow: 3 });
  });

  test("packs variable-height rows around the selection within the budget", () => {
    // heights: [2,2,8,2,2] total 16 > budget 12; selection is the tall row (2).
    const heights = [2, 2, 8, 2, 2];
    const w = windowByHeight([0, 1, 2, 3, 4], 2, (i) => heights[i] ?? 0, 12);
    expect(w.rows).toEqual([1, 2, 3]);
    expect(w.startIndex).toBe(1);
    expect(w.hiddenAbove).toBe(1);
    expect(w.hiddenBelow).toBe(1);
  });

  test("a single row taller than the budget still renders (selection stays visible)", () => {
    const w = windowByHeight([0, 1, 2], 1, () => 9, 5);
    expect(w.rows).toEqual([1]);
    expect(w.startIndex).toBe(1);
    expect(w.hiddenAbove).toBe(1);
    expect(w.hiddenBelow).toBe(1);
  });
});

describe("computeViewportRows", () => {
  test("subtracts chrome from the terminal height", () => {
    expect(computeViewportRows(50)).toBe(41);
    expect(computeViewportRows(24)).toBe(15);
  });

  test("clamps to a minimum on tiny terminals", () => {
    expect(computeViewportRows(10)).toBe(5);
    expect(computeViewportRows(1)).toBe(5);
  });

  test("falls back to a 24-row assumption when height is unknown", () => {
    expect(computeViewportRows(undefined)).toBe(15);
    expect(computeViewportRows(0)).toBe(15);
  });
});
