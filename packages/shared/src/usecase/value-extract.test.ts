import { describe, expect, test } from "bun:test";
import { evalCel } from "../workflow-dsl/cel";
import type { ValueOutput } from "../workflow-dsl/extract";
import { extractValue, extractValues } from "./value-extract";

const vo = (over: Partial<ValueOutput>): ValueOutput => ({
  descriptor: "residual",
  type: "double",
  from: { collectedOutDescriptor: "log" },
  extract: { kind: "Whole" },
  ...over,
});

describe("extractValue", () => {
  test("Regex capture group coerced to double", () => {
    const r = extractValue(
      "final residual = 1.5e-6\n",
      vo({
        extract: { kind: "Regex", pattern: "residual = ([0-9.eE+-]+)", group: 1 },
      }),
    );
    expect(r).toBe(1.5e-6);
  });

  test("Whole text coerced to string is trimmed", () => {
    expect(extractValue("  hello \n", vo({ type: "string" }))).toBe("hello");
  });

  test("rejects structured values for string outputs", () => {
    expect(() =>
      extractValue(
        '{"artifact":{"fileMetadataId":"f1","fileMetadataName":"a.txt"}}',
        vo({ type: "string", extract: { kind: "JsonPath", path: "artifact" } }),
      ),
    ).toThrow(/string/);
  });

  test("coerces int and bool", () => {
    expect(extractValue("42", vo({ type: "int" }))).toBe(42);
    expect(extractValue("true", vo({ type: "bool" }))).toBe(true);
  });

  test("rejects a fractional value for int outputs", () => {
    expect(() => extractValue("1.5", vo({ type: "int" }))).toThrow(/int/);
  });

  test("rejects a non-finite value for double outputs", () => {
    expect(() => extractValue("Infinity", vo({ type: "double" }))).toThrow(/double/);
  });

  test("rejects non-boolean text for bool outputs", () => {
    expect(() => extractValue("maybe", vo({ type: "bool" }))).toThrow(/bool/);
  });

  test("JsonPath into parsed JSON", () => {
    const r = extractValue(
      '{"a":{"b":3}}',
      vo({ type: "double", extract: { kind: "JsonPath", path: "a.b" } }),
    );
    expect(r).toBe(3);
  });

  test("regex miss with onMissing=Default returns the default", () => {
    const r = extractValue(
      "nothing here",
      vo({
        extract: { kind: "Regex", pattern: "r=([0-9]+)", group: 1 },
        onMissing: "Default",
        default: 0,
      }),
    );
    expect(r).toBe(0);
  });

  test("regex miss with onMissing=Default coerces the default to the declared type", () => {
    const r = extractValue(
      "nothing here",
      vo({
        type: "int",
        extract: { kind: "Regex", pattern: "r=([0-9]+)", group: 1 },
        onMissing: "Default",
        default: "42",
      }),
    );
    expect(r).toBe(42);
  });

  test("regex miss with onMissing=Fail throws", () => {
    expect(() =>
      extractValue(
        "nothing",
        vo({ extract: { kind: "Regex", pattern: "r=([0-9]+)", group: 1 }, onMissing: "Fail" }),
      ),
    ).toThrow();
  });

  test("absent source with onMissing=Default returns the default", () => {
    expect(extractValue(undefined, vo({ onMissing: "Default", default: 1 }))).toBe(1);
  });

  test("absent source with onMissing=Default rejects an invalid default", () => {
    expect(() =>
      extractValue(undefined, vo({ type: "double", onMissing: "Default", default: "Infinity" })),
    ).toThrow(/double/);
  });

  test("onMissing=Default rejects a structured string default", () => {
    expect(() =>
      extractValue(
        undefined,
        vo({
          type: "string",
          onMissing: "Default",
          default: { fileMetadataId: "f1", fileMetadataName: "a.txt" },
        }),
      ),
    ).toThrow(/string/);
  });

  test("onMissing=Default without a default fails instead of returning undefined", () => {
    expect(() => extractValue(undefined, vo({ onMissing: "Default" }))).toThrow(/default/i);
  });
});

describe("extractValues (map over a collected-output bundle)", () => {
  test("builds a descriptor->value record from sources", () => {
    const sources = { log: "Cl=0.5 Cd=0.02" };
    const values = extractValues(sources, [
      vo({ descriptor: "cl", extract: { kind: "Regex", pattern: "Cl=([0-9.]+)", group: 1 } }),
      vo({ descriptor: "cd", extract: { kind: "Regex", pattern: "Cd=([0-9.]+)", group: 1 } }),
    ]);
    expect(values).toEqual({ cl: 0.5, cd: 0.02 });
  });

  test("a JSON-array source with a list type + Whole extract yields a CelValue list", () => {
    const values = extractValues({ results: JSON.stringify(["one", "two", "three"]) }, [
      vo({
        descriptor: "results",
        type: { list: "string" },
        from: { collectedOutDescriptor: "results" },
        extract: { kind: "Whole" },
      }),
    ]);
    expect(values.results).toEqual(["one", "two", "three"]);
  });

  test("a list type recursively coerces its elements", () => {
    const values = extractValues({ results: JSON.stringify(["1", "2", "3"]) }, [
      vo({
        descriptor: "results",
        type: { list: "int" },
        from: { collectedOutDescriptor: "results" },
        extract: { kind: "Whole" },
      }),
    ]);
    expect(values.results).toEqual([1, 2, 3]);
  });

  test("a list type rejects elements that do not match its item type", () => {
    expect(() =>
      extractValues({ results: JSON.stringify(["1", "2.5"]) }, [
        vo({
          descriptor: "results",
          type: { list: "int" },
          from: { collectedOutDescriptor: "results" },
          extract: { kind: "Whole" },
        }),
      ]),
    ).toThrow(/int|list/);
  });

  test("a map type recursively coerces its values", () => {
    const values = extractValues({ metrics: JSON.stringify({ cl: "0.5", cd: "0.02" }) }, [
      vo({
        descriptor: "metrics",
        type: { map: "double" },
        from: { collectedOutDescriptor: "metrics" },
        extract: { kind: "Whole" },
      }),
    ]);
    expect(values.metrics).toEqual({ cl: 0.5, cd: 0.02 });
  });

  test("a map type rejects values that do not match its value type", () => {
    expect(() =>
      extractValues({ metrics: JSON.stringify({ cl: "Infinity" }) }, [
        vo({
          descriptor: "metrics",
          type: { map: "double" },
          from: { collectedOutDescriptor: "metrics" },
          extract: { kind: "Whole" },
        }),
      ]),
    ).toThrow(/double|map/);
  });

  test("a list CelValue is iterable by a ForEach guard over its size", () => {
    const values = extractValues({ results: JSON.stringify(["a", "b"]) }, [
      vo({
        descriptor: "results",
        type: { list: "string" },
        from: { collectedOutDescriptor: "results" },
        extract: { kind: "Whole" },
      }),
    ]);
    const ctx = { nodes: { gen: { values } } };
    expect(evalCel("size(nodes.gen.values.results)", ctx)).toBe(2);
  });

  test("extracted values feed a CEL convergence guard (closed loop)", () => {
    const values = extractValues({ log: "residual = 1e-6" }, [
      vo({
        descriptor: "residual",
        extract: { kind: "Regex", pattern: "residual = ([0-9.eE+-]+)", group: 1 },
      }),
    ]);
    const ctx = { nodes: { check: { values } }, params: { target: 1e-5 } };
    expect(evalCel("nodes.check.values.residual <= params.target", ctx)).toBe(true);
  });
});
