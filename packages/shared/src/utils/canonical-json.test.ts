import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  test("sorts object keys recursively while retaining array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });

  test("rejects values without a portable JSON representation", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson({ value: 1n })).toThrow("bigint");
  });
});
