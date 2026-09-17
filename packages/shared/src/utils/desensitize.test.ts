import { describe, expect, test } from "bun:test";
import {
  alias,
  applyAction,
  DESENSITIZE_HIDE,
  hash,
  hide,
  isDesensitizeAction,
  passthrough,
  redact,
} from "./desensitize";

describe("passthrough action", () => {
  test("returns string unchanged", () => {
    expect(passthrough("hello")).toBe("hello");
  });

  test("returns object unchanged (same reference)", () => {
    const o = { a: 1 };
    expect(passthrough(o)).toBe(o);
  });

  test("returns null unchanged", () => {
    expect(passthrough(null)).toBeNull();
  });

  test("returns undefined unchanged", () => {
    expect(passthrough(undefined)).toBeUndefined();
  });
});

describe("hash action", () => {
  test("returns 12-hex SHA256 prefix for string input", () => {
    const out = hash("user@example.com");
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is deterministic — same input → same output", () => {
    expect(hash("payload-A")).toBe(hash("payload-A"));
  });

  test("different inputs → different outputs (no collision in practice)", () => {
    expect(hash("a")).not.toBe(hash("b"));
  });

  test("non-string inputs are stringified before hashing", () => {
    expect(hash(42)).toMatch(/^[0-9a-f]{12}$/);
    expect(hash({ k: "v" })).toMatch(/^[0-9a-f]{12}$/);
  });

  test("null/undefined produce stable hash representations", () => {
    const a = hash(null);
    const b = hash(undefined);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("alias action", () => {
  test("returns stable opaque alias from salt + value", () => {
    const a = alias("alice@example.com", "salt-123");
    const b = alias("alice@example.com", "salt-123");
    expect(a).toBe(b);
  });

  test("different salt → different alias for same value", () => {
    const a = alias("alice@example.com", "s1");
    const b = alias("alice@example.com", "s2");
    expect(a).not.toBe(b);
  });

  test("different value → different alias for same salt", () => {
    const a = alias("alice@example.com", "s1");
    const b = alias("bob@example.com", "s1");
    expect(a).not.toBe(b);
  });

  test("alias is non-empty hex of expected length (16 hex chars by default)", () => {
    expect(alias("v", "s") as string).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("redact action", () => {
  test("returns *** for string", () => {
    expect(redact("secret")).toBe("***");
  });

  test("returns [redacted] for non-string", () => {
    expect(redact(42)).toBe("[redacted]");
    expect(redact({ a: 1 })).toBe("[redacted]");
    expect(redact(null)).toBe("[redacted]");
  });
});

describe("hide action", () => {
  test("returns the DESENSITIZE_HIDE sentinel for any input", () => {
    expect(hide("anything")).toBe(DESENSITIZE_HIDE);
    expect(hide(null)).toBe(DESENSITIZE_HIDE);
    expect(hide({ a: 1 })).toBe(DESENSITIZE_HIDE);
  });
});

describe("isDesensitizeAction", () => {
  test("recognizes the 5 valid action names", () => {
    for (const a of ["passthrough", "hash", "alias", "redact", "hide"] as const) {
      expect(isDesensitizeAction(a)).toBe(true);
    }
  });

  test("rejects unknown actions", () => {
    expect(isDesensitizeAction("scramble")).toBe(false);
    expect(isDesensitizeAction("")).toBe(false);
  });
});

describe("applyAction dispatcher", () => {
  test("dispatches by action name", () => {
    expect(applyAction("passthrough", "x", { salt: "s" })).toBe("x");
    expect(applyAction("redact", "x", { salt: "s" })).toBe("***");
    expect(applyAction("hide", "x", { salt: "s" })).toBe(DESENSITIZE_HIDE);
    expect(applyAction("hash", "x", { salt: "s" }) as string).toMatch(/^[0-9a-f]{12}$/);
    expect(applyAction("alias", "x", { salt: "s" }) as string).toMatch(/^[0-9a-f]{16}$/);
  });

  test("alias salt is required and changes output", () => {
    const a = applyAction("alias", "v", { salt: "s1" });
    const b = applyAction("alias", "v", { salt: "s2" });
    expect(a).not.toBe(b);
  });
});
