import { describe, expect, test } from "bun:test";
import { LoopCarrySchema, LoopOutputSchema } from "./loop";

describe("LoopOutputSchema", () => {
  test("accepts a node-sourced output with an aggregate", () => {
    const r = LoopOutputSchema.parse({
      descriptor: "results",
      from: { node: "solveOne", output: "result" },
      aggregate: "Collect",
    });
    expect(r.descriptor).toBe("results");
  });

  test("rejects an unknown aggregate", () => {
    expect(() =>
      LoopOutputSchema.parse({
        descriptor: "r",
        from: { node: "n", output: "o" },
        aggregate: "Sum",
      }),
    ).toThrow();
  });
});

describe("LoopCarrySchema", () => {
  test("accepts carry with a node-output initial", () => {
    const r = LoopCarrySchema.parse({
      from: { node: "solve", output: "field" },
      to: { input: "fieldIn" },
      initial: { node: "prep", output: "mesh" },
    });
    expect(r.to.input).toBe("fieldIn");
  });

  test("accepts carry with a param initial", () => {
    const r = LoopCarrySchema.parse({
      from: { node: "solve", output: "field" },
      to: { input: "fieldIn" },
      initial: { param: "seedField" },
    });
    expect(r.to.input).toBe("fieldIn");
  });

  test("rejects carry missing `to`", () => {
    expect(() => LoopCarrySchema.parse({ from: { node: "s", output: "f" } })).toThrow();
  });
});
