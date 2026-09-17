import { describe, expect, test } from "bun:test";
import { GenOutputSchema, GenRuleSchema } from "./generate";

describe("GenRuleSchema", () => {
  test("accepts CartesianProduct with sub-generator axes", () => {
    const r = GenRuleSchema.parse({
      kind: "CartesianProduct",
      axes: [
        { name: "reynolds", kind: "Enumeration", values: [100, 200] },
        { name: "angle", kind: "Range", start: 0, stop: 30, step: 10 },
      ],
    });
    expect(r.kind).toBe("CartesianProduct");
  });

  test("accepts FixedCount with an AutoNumber filler", () => {
    const r = GenRuleSchema.parse({
      kind: "FixedCount",
      count: 5,
      filler: { kind: "AutoNumber", start: 0, step: 1 },
    });
    expect(r.kind).toBe("FixedCount");
  });

  test("rejects FixedCount with an empty Enumeration filler", () => {
    expect(() =>
      GenRuleSchema.parse({
        kind: "FixedCount",
        count: 3,
        filler: { kind: "Enumeration", items: [] },
      }),
    ).toThrow();
  });

  test("accepts Sampling with LatinHypercube and a seed", () => {
    const r = GenRuleSchema.parse({
      kind: "Sampling",
      method: "LatinHypercube",
      count: 64,
      seed: 42,
      dims: [{ name: "x", dist: { kind: "Uniform", min: 0, max: 1 } }],
    });
    expect(r.kind).toBe("Sampling");
  });

  test("rejects Sampling without dimensions", () => {
    expect(() =>
      GenRuleSchema.parse({
        kind: "Sampling",
        method: "Random",
        count: 3,
        dims: [],
      }),
    ).toThrow();
  });

  test("rejects invalid Sampling distributions", () => {
    expect(() =>
      GenRuleSchema.parse({
        kind: "Sampling",
        method: "Random",
        count: 3,
        dims: [{ name: "x", dist: { kind: "Uniform", min: 2, max: 1 } }],
      }),
    ).toThrow();
    expect(() =>
      GenRuleSchema.parse({
        kind: "Sampling",
        method: "Random",
        count: 3,
        dims: [{ name: "x", dist: { kind: "Normal", mean: 0, std: 0 } }],
      }),
    ).toThrow();
    expect(() =>
      GenRuleSchema.parse({
        kind: "Sampling",
        method: "Random",
        count: 3,
        dims: [{ name: "x", dist: { kind: "Choice", items: [] } }],
      }),
    ).toThrow();
  });

  test("rejects an unknown rule kind", () => {
    expect(() => GenRuleSchema.parse({ kind: "Nope" })).toThrow();
  });

  test("rejects an axis with an unknown sub-generator kind", () => {
    expect(() =>
      GenRuleSchema.parse({
        kind: "CartesianProduct",
        axes: [{ name: "x", kind: "Sampling", count: 3 }],
      }),
    ).toThrow();
  });

  test("rejects Range rules with a zero step", () => {
    expect(() => GenRuleSchema.parse({ kind: "Range", start: 0, stop: 10, step: 0 })).toThrow();
    expect(() =>
      GenRuleSchema.parse({
        kind: "CartesianProduct",
        axes: [{ name: "x", kind: "Range", start: 0, stop: 10, step: 0 }],
      }),
    ).toThrow();
  });

  test("rejects compound generators without axes", () => {
    expect(() => GenRuleSchema.parse({ kind: "CartesianProduct", axes: [] })).toThrow();
    expect(() => GenRuleSchema.parse({ kind: "Zip", axes: [] })).toThrow();
  });
});

describe("GenOutputSchema", () => {
  test("accepts List output", () => {
    expect(GenOutputSchema.parse({ descriptor: "caseList", as: "List" }).as).toBe("List");
  });

  test("rejects an unknown 'as'", () => {
    expect(() => GenOutputSchema.parse({ descriptor: "x", as: "Stream" })).toThrow();
  });
});
