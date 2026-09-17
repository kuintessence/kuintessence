import { describe, expect, test } from "bun:test";
import { expandGenerate } from "./expand-generate";

describe("expandGenerate — deterministic rules", () => {
  test("Enumeration yields its values", () => {
    expect(expandGenerate({ kind: "Enumeration", values: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  test("rejects a Range that would exceed the size cap (anti-OOM, fail-fast)", () => {
    // 0..2,000,000 step 1 → ~2M items > 1M cap. Checked from start/stop/step
    // BEFORE materializing, so this is cheap.
    expect(() => expandGenerate({ kind: "Range", start: 0, stop: 2_000_000, step: 1 })).toThrow(
      /exceed|cap/i,
    );
  });

  test("rejects a CartesianProduct whose product exceeds the cap", () => {
    expect(() =>
      expandGenerate({
        kind: "CartesianProduct",
        axes: [
          { name: "a", kind: "Range", start: 0, stop: 1001, step: 1 },
          { name: "b", kind: "Range", start: 0, stop: 1000, step: 1 },
        ],
      }),
    ).toThrow(/exceed|cap/i);
  });

  test("Range is an inclusive arithmetic sequence", () => {
    expect(expandGenerate({ kind: "Range", start: 0, stop: 30, step: 10 })).toEqual([
      0, 10, 20, 30,
    ]);
  });

  test("Linspace yields num evenly spaced points incl. endpoints", () => {
    expect(expandGenerate({ kind: "Linspace", start: 0, stop: 1, num: 5 })).toEqual([
      0, 0.25, 0.5, 0.75, 1,
    ]);
  });

  test("FixedCount with AutoNumber filler", () => {
    expect(
      expandGenerate({
        kind: "FixedCount",
        count: 3,
        filler: { kind: "AutoNumber", start: 0, step: 10 },
      }),
    ).toEqual(["0", "10", "20"]);
  });

  test("CartesianProduct is the full combination of axes", () => {
    expect(
      expandGenerate({
        kind: "CartesianProduct",
        axes: [
          { name: "reynolds", kind: "Enumeration", values: [100, 200] },
          { name: "angle", kind: "Range", start: 0, stop: 10, step: 10 },
        ],
      }),
    ).toEqual([
      { reynolds: 100, angle: 0 },
      { reynolds: 100, angle: 10 },
      { reynolds: 200, angle: 0 },
      { reynolds: 200, angle: 10 },
    ]);
  });

  test("Zip pairs axes element-wise", () => {
    expect(
      expandGenerate({
        kind: "Zip",
        axes: [
          { name: "a", kind: "Enumeration", values: [1, 2] },
          { name: "b", kind: "Enumeration", values: [10, 20] },
        ],
      }),
    ).toEqual([
      { a: 1, b: 10 },
      { a: 2, b: 20 },
    ]);
  });

  test("rejects Zip axes with different lengths instead of truncating", () => {
    expect(() =>
      expandGenerate({
        kind: "Zip",
        axes: [
          { name: "a", kind: "Enumeration", values: [1, 2, 3] },
          { name: "b", kind: "Enumeration", values: [10, 20] },
        ],
      }),
    ).toThrow(/same length|Zip/i);
  });

  test("throws NotImplemented for runtime/external rules", () => {
    expect(() =>
      expandGenerate({ kind: "Sampling", method: "Random", count: 4, dims: [] }),
    ).toThrow();
  });
});
