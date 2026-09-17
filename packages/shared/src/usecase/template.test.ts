import { describe, expect, test } from "bun:test";
import { renderTemplate } from "./template";

describe(`renderTemplate (CEL-embedded \${...})`, () => {
  test("substitutes a single CEL expression", () => {
    expect(renderTemplate(`angle = \${loop.item.angle}`, { loop: { item: { angle: 10 } } })).toBe(
      "angle = 10",
    );
  });

  test("substitutes multiple and adjacent expressions", () => {
    const ctx = { loop: { item: { re: 100, ang: 5 } } };
    expect(renderTemplate(`Re=\${loop.item.re} A=\${loop.item.ang}`, ctx)).toBe("Re=100 A=5");
    expect(renderTemplate(`\${loop.item.re}\${loop.item.ang}`, ctx)).toBe("1005");
  });

  test("leaves literal text without expressions unchanged", () => {
    expect(renderTemplate("no placeholders here", {})).toBe("no placeholders here");
  });

  test("stringifies booleans and strings", () => {
    expect(
      renderTemplate(`flag=\${params.on} name=\${params.n}`, {
        params: { on: true, n: "foam" },
      }),
    ).toBe("flag=true name=foam");
  });

  test("rejects structured placeholder values instead of stringifying them", () => {
    expect(() =>
      renderTemplate(`data=\${params.payload}`, {
        params: { payload: { fileMetadataId: "f1", fileMetadataName: "a.txt" } },
      }),
    ).toThrow(/scalar/i);
  });

  test("throws on an unterminated placeholder", () => {
    expect(() => renderTemplate("x = ${loop.item.a", {})).toThrow();
  });

  test("propagates an expression evaluation error", () => {
    expect(() => renderTemplate(`\${ghost}`, {})).toThrow();
  });
});
