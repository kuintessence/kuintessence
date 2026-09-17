import { describe, expect, test } from "bun:test";
import { evalCel } from "./cel";

describe("evalCel — literals & arithmetic", () => {
  test("respects operator precedence", () => {
    expect(evalCel("1 + 2 * 3", {})).toBe(7);
  });
  test("respects parentheses", () => {
    expect(evalCel("(1 + 2) * 3", {})).toBe(9);
  });
  test("handles division and modulo", () => {
    expect(evalCel("10 / 4", {})).toBe(2.5);
    expect(evalCel("10 % 3", {})).toBe(1);
  });
  test("parses scientific notation", () => {
    expect(evalCel("1e-5", {})).toBe(1e-5);
  });
});

describe("evalCel — comparison, equality, logical, unary, ternary", () => {
  test("comparison", () => {
    expect(evalCel("3 <= 3", {})).toBe(true);
    expect(evalCel("4 < 3", {})).toBe(false);
  });
  test("equality on strings", () => {
    expect(evalCel("'a' == 'a'", {})).toBe(true);
    expect(evalCel('"a" != "b"', {})).toBe(true);
  });
  test("logical with precedence", () => {
    expect(evalCel("true && false || true", {})).toBe(true);
  });
  test("unary not and negation", () => {
    expect(evalCel("!false", {})).toBe(true);
    expect(evalCel("-5 + 2", {})).toBe(-3);
  });
  test("ternary", () => {
    expect(evalCel("1 < 2 ? 'y' : 'n'", {})).toBe("y");
  });
});

describe("evalCel — context resolution", () => {
  test("resolves nested member access", () => {
    expect(
      evalCel("nodes.solve.values.residual", { nodes: { solve: { values: { residual: 0.001 } } } }),
    ).toBe(0.001);
  });
  test("evaluates a realistic convergence guard", () => {
    const ctx = {
      nodes: { check: { values: { residual: 1e-6 } } },
      params: { target: 1e-5 },
    };
    expect(evalCel("nodes.check.values.residual <= params.target", ctx)).toBe(true);
  });
  test("throws on an unknown top-level identifier", () => {
    expect(() => evalCel("ghost", {})).toThrow();
  });
});

describe("evalCel — builtins", () => {
  test("size() of a list", () => {
    expect(evalCel("size(params.items)", { params: { items: [1, 2, 3] } })).toBe(3);
  });
  test("has() is true for a present field and false for a missing one", () => {
    const ctx = { nodes: { solve: { values: { residual: 1 } } } };
    expect(evalCel("has(nodes.solve.values.residual)", ctx)).toBe(true);
    expect(evalCel("has(nodes.solve.values.missing)", ctx)).toBe(false);
    expect(evalCel("has(ghost)", ctx)).toBe(false);
  });
});

describe("evalCel — list literals", () => {
  test("string list literal", () => {
    expect(evalCel("['a', 'b', 'c']", {})).toEqual(["a", "b", "c"]);
  });
  test("empty list literal", () => {
    expect(evalCel("[]", {})).toEqual([]);
  });
  test("list literal evaluates element expressions", () => {
    expect(evalCel("[1, 2+3]", {})).toEqual([1, 5]);
  });
  test("postfix index access still works", () => {
    expect(evalCel("foo[0]", { foo: ["x", "y"] })).toBe("x");
  });
  test("indexing into a list literal", () => {
    expect(evalCel("[10, 20, 30][1]", {})).toBe(20);
  });
});

describe("evalCel — string() builtin", () => {
  test("number to decimal string", () => {
    expect(evalCel("string(42)", {})).toBe("42");
    expect(evalCel("string(1.5)", {})).toBe("1.5");
  });
  test("bool to string", () => {
    expect(evalCel("string(true)", {})).toBe("true");
    expect(evalCel("string(false)", {})).toBe("false");
  });
  test("string passes through", () => {
    expect(evalCel("string('x')", {})).toBe("x");
  });
  test("throws on a list argument", () => {
    expect(() => evalCel("string([1, 2])", {})).toThrow();
  });
});

describe("evalCel — errors", () => {
  test("throws on a parse error", () => {
    expect(() => evalCel("1 +", {})).toThrow();
    expect(() => evalCel("(1 + 2", {})).toThrow();
  });
});
