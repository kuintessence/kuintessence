import { describe, expect, test } from "bun:test";
import { ReduceColumnSchema, ReduceOutputSchema, ReducerSchema } from "./reduce";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("ReduceColumnSchema", () => {
  test("accepts a loopItem-sourced column", () => {
    expect(
      ReduceColumnSchema.parse({
        name: "reynolds",
        type: "double",
        source: { loopItem: "reynolds" },
      }).name,
    ).toBe("reynolds");
  });

  test("accepts a collectedOut column with an extractor", () => {
    const r = ReduceColumnSchema.parse({
      name: "cl",
      type: "double",
      source: { collectedOut: "solverLog" },
      extract: { kind: "Regex", pattern: "Cl=([0-9.]+)", group: 1 },
    });
    expect(r.name).toBe("cl");
  });

  test("rejects a hyphenated column name", () => {
    expect(() =>
      ReduceColumnSchema.parse({ name: "c-l", type: "double", source: { loopItem: "x" } }),
    ).toThrow();
  });
});

describe("ReducerSchema", () => {
  test("accepts ExtractTable with columns", () => {
    expect(
      ReducerSchema.parse({
        kind: "ExtractTable",
        columns: [{ name: "x", type: "double", source: { loopItem: "x" } }],
      }).kind,
    ).toBe("ExtractTable");
  });

  test("rejects ExtractTable without columns", () => {
    expect(() => ReducerSchema.parse({ kind: "ExtractTable", columns: [] })).toThrow();
  });

  test("accepts Command with a usecaseRef", () => {
    expect(
      ReducerSchema.parse({
        kind: "Command",
        usecaseRef: { usecaseVersionId: UUID, softwareVersionId: UUID },
      }).kind,
    ).toBe("Command");
  });

  test("accepts Statistics over a column", () => {
    expect(
      ReducerSchema.parse({ kind: "Statistics", over: "cl", metrics: ["mean", "std"] }).kind,
    ).toBe("Statistics");
  });

  test("rejects Statistics without metrics", () => {
    expect(() => ReducerSchema.parse({ kind: "Statistics", over: "cl", metrics: [] })).toThrow();
  });

  test("rejects an unknown reducer kind", () => {
    expect(() => ReducerSchema.parse({ kind: "Magic" })).toThrow();
  });
});

describe("ReduceOutputSchema", () => {
  test("accepts SingleFile with a fileName", () => {
    expect(
      ReduceOutputSchema.parse({ kind: "SingleFile", descriptor: "summary", fileName: "s.csv" })
        .kind,
    ).toBe("SingleFile");
  });

  test("rejects an unknown output kind", () => {
    expect(() => ReduceOutputSchema.parse({ kind: "Stream", descriptor: "x" })).toThrow();
  });
});
