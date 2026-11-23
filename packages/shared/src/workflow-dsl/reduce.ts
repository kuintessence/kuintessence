import { z } from "zod";
import { SlugSchema, UuidSchema } from "./common";
import { ValueTypeSchema } from "./expr";
import { ExtractSchema } from "./extract";
import {
  AssetSelectorSchema,
  FrozenUsecaseAssetRevisionsSchema,
  NodeOutputRefSchema,
} from "./refs";
import {
  ExecutionIdentitySchema,
  SandboxRuntimeContractRefSchema,
  ScriptRefSchema,
  ScriptSourceSchema,
  UsecaseRefSchema,
} from "./script";

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

const commandScriptFields = { executionIdentity: ExecutionIdentitySchema.optional() };
const CommandScriptSchema = z.union([
  z.strictObject({
    ...commandScriptFields,
    source: ScriptSourceSchema,
    runtimeProfileId: UuidSchema,
  }),
  z.strictObject({
    ...commandScriptFields,
    source: ScriptSourceSchema,
    runtimeContractRef: SandboxRuntimeContractRefSchema,
  }),
  z.strictObject({
    ...commandScriptFields,
    scriptRef: ScriptRefSchema,
    runtimeContractRef: SandboxRuntimeContractRefSchema,
  }),
]);

/** Extensible reducer (D2c). */
export const ReducerSchema = z.union([
  z.strictObject({ kind: z.literal("ExtractTable"), columns: z.array(ReduceColumnSchema).min(1) }),
  z.strictObject({
    kind: z.literal("Command"),
    usecaseRef: UsecaseRefSchema,
    frozenAssetRevisions: FrozenUsecaseAssetRevisionsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("Command"),
    usecaseRef: AssetSelectorSchema,
    softwareRef: AssetSelectorSchema,
  }),
  z.strictObject({ kind: z.literal("Command"), script: CommandScriptSchema }),
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
  kind: z.enum(["Value", "SingleFile", "OrderedFolder"]),
  descriptor: z.string(),
  fileName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\\/\p{Cc}]+$/u)
    .refine((name) => name !== "." && name !== "..")
    .nullish(),
});
export type ReduceOutput = z.infer<typeof ReduceOutputSchema>;
