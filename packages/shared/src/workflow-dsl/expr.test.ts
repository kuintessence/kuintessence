import { describe, expect, test } from "bun:test";
import { ExprSchema, IntOrExprSchema, ValueTypeSchema } from "./expr";

describe("ExprSchema", () => {
  test("parses a bare expression and defaults lang to cel", () => {
    expect(ExprSchema.parse({ expr: "a > b" })).toEqual({ expr: "a > b", lang: "cel" });
  });

  test("rejects a missing expr", () => {
    expect(() => ExprSchema.parse({})).toThrow();
  });

  test("rejects unknown fields", () => {
    expect(() => ExprSchema.parse({ expr: "x", bogus: 1 })).toThrow();
  });
});

describe("IntOrExprSchema", () => {
  test("accepts a positive integer", () => {
    expect(IntOrExprSchema.parse(5)).toBe(5);
  });

  test("accepts an Expr object", () => {
    expect(IntOrExprSchema.parse({ expr: "params.n" })).toEqual({ expr: "params.n", lang: "cel" });
  });

  test("rejects zero and negatives", () => {
    expect(() => IntOrExprSchema.parse(0)).toThrow();
    expect(() => IntOrExprSchema.parse(-1)).toThrow();
  });
});

describe("ValueTypeSchema", () => {
  test("accepts a scalar type name", () => {
    expect(ValueTypeSchema.parse("double")).toBe("double");
  });

  test("accepts a nested list type", () => {
    expect(ValueTypeSchema.parse({ list: "json" })).toEqual({ list: "json" });
  });

  test("rejects an unknown scalar", () => {
    expect(() => ValueTypeSchema.parse("complex128")).toThrow();
  });
});
