/// <reference path="./lobos.d.ts" />
import { Sobol } from "lobos";
import { probit } from "simple-statistics";
import type { GenRule } from "./generate";

type Sampling = Extract<GenRule, { kind: "Sampling" }>;

// Mulberry32 gives every replay the same stream from a 32-bit seed.
function randomStream(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function strata(count: number, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
}

function coordinates(rule: Sampling) {
  const { count, dims } = rule;
  const random = randomStream(rule.seed ?? 0);
  switch (rule.method) {
    case "Random":
      return () => dims.map(() => random());
    case "LatinHypercube": {
      const orders = dims.map(() => strata(count, random));
      return (i: number) => orders.map((order) => ((order[i] as number) + random()) / count);
    }
    case "Sobol": {
      const sequence = new Sobol(dims.length);
      const shifts = dims.map(() => (rule.seed == null ? 0 : Math.floor(random() * 0x100000000)));
      // Exclude the origin, whose normal quantile is unbounded.
      void sequence.next;
      return () =>
        sequence.next.map(
          (u, j) => (((u * 0x100000000) ^ (shifts[j] as number)) >>> 0) / 0x100000000,
        );
    }
    case "Grid": {
      let cells = 1;
      const widths = dims.map((_, j) => {
        const width = Math.max(1, Math.ceil((count / cells) ** (1 / (dims.length - j))));
        cells *= width;
        return width;
      });
      return (i: number) => {
        let cell = Math.floor(((i + 0.5) * cells) / count);
        return widths.map((width) => {
          const center = ((cell % width) + 0.5) / width;
          cell = Math.floor(cell / width);
          return center;
        });
      };
    }
  }
}

export function sample(rule: Sampling): Record<string, unknown>[] {
  if (!rule.dims.length || new Set(rule.dims.map((dim) => dim.name)).size !== rule.dims.length)
    throw new Error("Sampling requires distinct, named dimensions");
  const point = coordinates(rule);
  return Array.from({ length: rule.count }, (_, i) => {
    const values = point(i);
    return Object.fromEntries(
      rule.dims.map(({ name, dist }, j) => {
        const u = values[j] as number;
        if (dist.kind === "Choice") return [name, dist.items[Math.floor(u * dist.items.length)]];
        if (dist.kind === "Normal")
          return [name, dist.mean + dist.std * probit(Math.max(2 ** -33, u))];
        return [name, (1 - u) * dist.min + u * dist.max];
      }),
    );
  });
}
