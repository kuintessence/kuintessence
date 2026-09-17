import { describe, expect, test } from "bun:test";
import { AssetSelectorSchema, LoopOutputRefSchema, NodeOutputRefSchema } from "./refs";

describe("NodeOutputRefSchema", () => {
  test("accepts a node/output pair", () => {
    expect(NodeOutputRefSchema.parse({ node: "solveOne", output: "result" })).toEqual({
      node: "solveOne",
      output: "result",
    });
  });

  test("rejects a hyphenated node id", () => {
    expect(() => NodeOutputRefSchema.parse({ node: "solve-one", output: "result" })).toThrow();
  });

  test("rejects a missing output", () => {
    expect(() => NodeOutputRefSchema.parse({ node: "solveOne" })).toThrow();
  });
});

describe("AssetSelectorSchema", () => {
  test("requires an immutable source/name/version selector", () => {
    expect(
      AssetSelectorSchema.parse({
        source: "official-upstream",
        name: "gromacs",
        version: "2025.2",
      }),
    ).toMatchObject({ name: "gromacs" });
  });

  test("requires a provider organization for CP-private assets", () => {
    expect(() =>
      AssetSelectorSchema.parse({ source: "cp-private", name: "vasp", version: "6.5.1" }),
    ).toThrow();
    expect(
      AssetSelectorSchema.parse({
        source: "cp-private",
        name: "vasp",
        version: "6.5.1",
        providerOrgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).toMatchObject({ source: "cp-private" });
  });
});

describe("LoopOutputRefSchema", () => {
  test("accepts a loop/output pair", () => {
    expect(LoopOutputRefSchema.parse({ loop: "sweep", output: "results" })).toEqual({
      loop: "sweep",
      output: "results",
    });
  });
});
