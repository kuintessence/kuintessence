import { describe, expect, test } from "bun:test";
import { PreferenceSpecSchema } from "./preference";

describe("PreferenceSpec costRates", () => {
  test("accepts a per-cluster cost table", () => {
    const spec = PreferenceSpecSchema.parse({
      costRates: { "cluster-a": 0.12, "cluster-b": 0.3 },
    });
    expect(spec.costRates?.["cluster-a"]).toBe(0.12);
  });

  test("rejects a negative rate", () => {
    expect(() => PreferenceSpecSchema.parse({ costRates: { "cluster-a": -1 } })).toThrow();
  });

  test("costRates is optional", () => {
    expect(PreferenceSpecSchema.parse({}).costRates).toBeUndefined();
  });
});
