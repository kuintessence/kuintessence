import type { CelValue } from "../workflow-dsl/cel";
import type { ValueType } from "../workflow-dsl/expr";
import type { Extract, ValueOutput } from "../workflow-dsl/extract";

/**
 * Pure value extraction. Turns collected job output (a named bundle
 * of stdout/stderr/file text) into typed values via the ability package's
 * `valueOutputs`, producing the `nodes.<id>.values.<descriptor>` bindings the
 * CEL evaluator reads for when/until/Switch/select. Pure & deterministic.
 */

function extractRaw(text: string, extract: Extract): unknown {
  if (extract.kind === "Whole") {
    return text.trim();
  }
  if (extract.kind === "Regex") {
    const m = new RegExp(extract.pattern ?? "").exec(text);
    if (!m) {
      return undefined;
    }
    return m[extract.group ?? 0];
  }
  // JsonPath: dotted path into parsed JSON.
  let cur: unknown = JSON.parse(text);
  for (const key of (extract.path ?? "").split(".").filter((k) => k.length > 0)) {
    if (cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function coerce(raw: unknown, type: ValueType): CelValue {
  if (typeof type !== "string") {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if ("list" in type) {
      if (!Array.isArray(parsed)) {
        throw new Error(`value-extract: cannot coerce "${String(raw)}" to list`);
      }
      return parsed.map((item) => coerce(item, type.list));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`value-extract: cannot coerce "${String(raw)}" to map`);
    }
    const values: Record<string, CelValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      values[key] = coerce(value, type.map);
    }
    return values;
  }
  switch (type) {
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new Error(`value-extract: cannot coerce "${String(raw)}" to ${type}`);
      }
      return n;
    }
    case "double": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`value-extract: cannot coerce "${String(raw)}" to ${type}`);
      }
      return n;
    }
    case "bool":
      if (typeof raw === "boolean") {
        return raw;
      }
      if (raw === "true") {
        return true;
      }
      if (raw === "false") {
        return false;
      }
      throw new Error(`value-extract: cannot coerce "${String(raw)}" to bool`);
    case "json":
      return typeof raw === "string" ? JSON.parse(raw) : (raw as CelValue);
    default:
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        throw new Error(`value-extract: cannot coerce "${String(raw)}" to ${type}`);
      }
      return String(raw);
  }
}

/** Pull a typed value out of source text via an extractor; throws when the
 *  extractor matches nothing. Reused by the Reduce `ExtractTable` reducer. */
export function extractTyped(text: string, extract: Extract, type: ValueType): CelValue {
  const raw = extractRaw(text, extract);
  if (raw === undefined) {
    throw new Error("value-extract: extractor matched nothing");
  }
  return coerce(raw, type);
}

/** Coerce an already-resolved value to a target type (no extraction). */
export function coerceTyped(raw: unknown, type: ValueType): CelValue {
  return coerce(raw, type);
}

/** Extract one typed value from a single collected-output source text. */
export function extractValue(source: string | undefined, vo: ValueOutput): CelValue {
  if (source === undefined) {
    if (vo.onMissing === "Default") {
      return coerceDefault(vo);
    }
    throw new Error(`value-extract: collected output for "${vo.descriptor}" is absent`);
  }
  const raw = extractRaw(source, vo.extract);
  if (raw === undefined) {
    if (vo.onMissing === "Default") {
      return coerceDefault(vo);
    }
    throw new Error(`value-extract: "${vo.descriptor}" extractor matched nothing`);
  }
  return coerce(raw, vo.type);
}

function coerceDefault(vo: ValueOutput): CelValue {
  if (!Object.hasOwn(vo, "default")) {
    throw new Error(`value-extract: default for "${vo.descriptor}" is absent`);
  }
  return coerce(vo.default, vo.type);
}

/**
 * Build the `values` record for a node from its ability package's
 * `valueOutputs` and a bundle of collected outputs keyed by collector
 * descriptor.
 */
export function extractValues(
  sources: Record<string, string>,
  valueOutputs: ValueOutput[],
): Record<string, CelValue> {
  const values: Record<string, CelValue> = {};
  for (const vo of valueOutputs) {
    values[vo.descriptor] = extractValue(sources[vo.from.collectedOutDescriptor], vo);
  }
  return values;
}
