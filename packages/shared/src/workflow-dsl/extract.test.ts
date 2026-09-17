import { describe, expect, test } from "bun:test";
import { ExtractSchema, ValueOutputSchema } from "./extract";

describe("ExtractSchema", () => {
  test("accepts a Regex extractor with a capture group", () => {
    expect(ExtractSchema.parse({ kind: "Regex", pattern: "r=([0-9.]+)", group: 1 }).kind).toBe(
      "Regex",
    );
  });

  test("accepts a bare Whole extractor", () => {
    expect(ExtractSchema.parse({ kind: "Whole" }).kind).toBe("Whole");
  });

  test("rejects an unknown extractor kind", () => {
    expect(() => ExtractSchema.parse({ kind: "Xpath" })).toThrow();
  });
});

describe("ValueOutputSchema", () => {
  test("accepts a typed value extracted from a collected output", () => {
    const r = ValueOutputSchema.parse({
      descriptor: "residual",
      type: "double",
      from: { collectedOutDescriptor: "solverLog" },
      extract: { kind: "Regex", pattern: "r=([0-9.]+)", group: 1 },
    });
    expect(r.descriptor).toBe("residual");
  });

  test("rejects a missing extract", () => {
    expect(() =>
      ValueOutputSchema.parse({
        descriptor: "residual",
        type: "double",
        from: { collectedOutDescriptor: "solverLog" },
      }),
    ).toThrow();
  });
});
