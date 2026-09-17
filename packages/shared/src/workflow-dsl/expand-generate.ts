import type { GenAxis, GenRule } from "./generate";

/**
 * Expand a deterministic Generate rule into its list of items.
 * Scalar rules yield scalars; CartesianProduct / Zip yield maps keyed
 * by axis name. `Sampling` and `FromFile` are resolved at runtime (sampling
 * needs a seed/RNG, FromFile reads produced/uploaded data) and throw here —
 * the engine handles them with runtime inputs. Pure & deterministic.
 */
/**
 * Anti-OOM ceiling on a Generate rule's materialized list size. `expandGenerate`
 * builds the whole list in memory, so an unbounded Range/Linspace/FixedCount or
 * Cartesian product (no schema max on start/stop/step/count) could OOM the Server
 * when the Generate node runs. Sizes are computable up front, so we fail fast
 * before materializing.
 */
const MAX_GENERATE_SIZE = 1_000_000;

function assertGenerateSize(n: number, kind: string): void {
  if (n > MAX_GENERATE_SIZE) {
    throw new Error(
      `expandGenerate: ${kind} would produce ${n} items, exceeding the cap of ${MAX_GENERATE_SIZE}. Reduce the range/count.`,
    );
  }
}

export function expandGenerate(rule: GenRule): unknown[] {
  switch (rule.kind) {
    case "Enumeration":
      return [...rule.values];
    case "Range":
      return arithmetic(rule.start, rule.stop, rule.step);
    case "Linspace":
      return linspace(rule.start, rule.stop, rule.num);
    case "FixedCount": {
      assertGenerateSize(rule.count, "FixedCount");
      const out: string[] = [];
      for (let i = 0; i < rule.count; i++) {
        out.push(
          rule.filler.kind === "AutoNumber"
            ? String(rule.filler.start + i * rule.filler.step)
            : (rule.filler.items[i % rule.filler.items.length] ?? ""),
        );
      }
      return out;
    }
    case "CartesianProduct":
      return cartesian(rule.axes);
    case "Zip":
      return zip(rule.axes);
    default:
      throw new Error(`expandGenerate: "${rule.kind}" is resolved at runtime, not statically`);
  }
}

function arithmetic(start: number, stop: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.floor((stop - start) / step + 1e-9);
  // n can be negative/NaN (stop<start, or step 0) → loop produces []; only a
  // genuinely large positive n is the OOM risk.
  if (Number.isFinite(n) && n > 0) {
    assertGenerateSize(n + 1, "Range");
  }
  for (let i = 0; i <= n; i++) {
    out.push(start + i * step);
  }
  return out;
}

function linspace(start: number, stop: number, num: number): number[] {
  if (num === 1) {
    return [start];
  }
  assertGenerateSize(num, "Linspace");
  const out: number[] = [];
  for (let i = 0; i < num; i++) {
    out.push(start + (i * (stop - start)) / (num - 1));
  }
  return out;
}

function expandAxis(axis: GenAxis): unknown[] {
  if (axis.kind === "Enumeration") {
    return [...axis.values];
  }
  if (axis.kind === "Range") {
    return arithmetic(axis.start, axis.stop, axis.step);
  }
  return linspace(axis.start, axis.stop, axis.num);
}

function cartesian(axes: GenAxis[]): Record<string, unknown>[] {
  // Expand each axis (each is per-axis capped via arithmetic/linspace), then
  // check the PRODUCT before building combos — axes individually under the cap
  // can still multiply past it.
  const expandedAxes = axes.map((a) => ({ name: a.name, values: expandAxis(a) }));
  const product = expandedAxes.reduce((n, a) => n * a.values.length, 1);
  assertGenerateSize(product, "CartesianProduct");
  let combos: Record<string, unknown>[] = [{}];
  for (const axis of expandedAxes) {
    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const v of axis.values) {
        next.push({ ...combo, [axis.name]: v });
      }
    }
    combos = next;
  }
  return combos;
}

function zip(axes: GenAxis[]): Record<string, unknown>[] {
  const expanded = axes.map((a) => ({ name: a.name, values: expandAxis(a) }));
  const lengths = new Set(expanded.map((e) => e.values.length));
  if (lengths.size > 1) {
    throw new Error("expandGenerate: Zip axes must have the same length");
  }
  const len = expanded[0]?.values.length ?? 0;
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, unknown> = {};
    for (const e of expanded) {
      row[e.name] = e.values[i];
    }
    out.push(row);
  }
  return out;
}
