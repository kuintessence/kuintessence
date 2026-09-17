import { z } from "zod";
import { SlugSchema } from "./common";
import { ValueTypeSchema } from "./expr";
import { ExtractSchema } from "./extract";
import { NodeOutputRefSchema } from "./refs";
import { ScriptOriginKindSchema, UsecaseRefSchema } from "./script";

/** Where a reduce column draws its per-iteration value from. */
const ColumnSourceSchema = z.union([
  z.strictObject({ loopItem: z.string() }),
  z.strictObject({ collectedOut: z.string() }),
  NodeOutputRefSchema,
]);

/** One CSV column = one extraction item; one iteration result = one row (D2d). */
export const ReduceColumnSchema = z.strictObject({
  name: SlugSchema,
  type: ValueTypeSchema,
  source: ColumnSourceSchema,
  extract: ExtractSchema.optional(),
});
export type ReduceColumn = z.infer<typeof ReduceColumnSchema>;

/** Built-in `Statistics` reducer metrics — the single source of truth the
 *  engine derives its metric type from (no hand-duplicated literal list). */
export const StatMetricSchema = z.enum([
  "mean",
  "std",
  "min",
  "max",
  "median",
  "p90",
  "p95",
  "p99",
]);
export type StatMetric = z.infer<typeof StatMetricSchema>;

/** Extensible reducer (D2c). */
export const ReducerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ExtractTable"), columns: z.array(ReduceColumnSchema).min(1) }),
  z.strictObject({
    kind: z.literal("Command"),
    usecaseRef: UsecaseRefSchema.optional(),
    script: ScriptOriginKindSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("Concat") }),
  z.strictObject({ kind: z.literal("Collect") }),
  z.strictObject({
    kind: z.literal("Statistics"),
    over: z.string(),
    metrics: z.array(StatMetricSchema).min(1),
  }),
]);
export type Reducer = z.infer<typeof ReducerSchema>;

export const ReduceOutputSchema = z.strictObject({
  kind: z.enum(["SingleFile", "OrderedFolder"]),
  descriptor: z.string(),
  fileName: z.string().nullish(),
});
export type ReduceOutput = z.infer<typeof ReduceOutputSchema>;
