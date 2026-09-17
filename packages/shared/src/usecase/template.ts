import { type CelValue, evalCel } from "../workflow-dsl/cel";

/**
 * Template rendering with CEL-embedded `${ ... }` placeholders.
 * Reuses the single expression language (`evalCel`) instead
 * of a separate template engine, so there is one grammar and zero new deps.
 * Each `${expr}` is evaluated against `ctx` (loop.item / params / nodes / …)
 * and substituted; literal text passes through. A missing reference or parse
 * error propagates — a template that can't render is an authoring bug.
 */
export function renderTemplate(template: string, ctx: Record<string, CelValue>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf("${", i);
    if (start === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, start);
    const end = template.indexOf("}", start + 2);
    if (end === -1) {
      throw new Error("template: unterminated placeholder (missing closing brace)");
    }
    const expr = template.slice(start + 2, end);
    out += stringify(evalCel(expr, ctx));
    i = end + 1;
  }
  return out;
}

function stringify(value: CelValue): string {
  if (value === undefined) {
    throw new Error("template: expression produced no value");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error("template: expression must produce a scalar text value");
}
