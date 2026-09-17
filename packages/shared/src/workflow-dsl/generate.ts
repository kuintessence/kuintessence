import { z } from "zod";
import { SlugSchema } from "./common";

/** Rule-based data generation (D2b). `kind` is the extensible discriminator. */

const NonZeroStepSchema = z.number().refine((step) => step !== 0, {
  message: "Range step must not be 0",
});

const FillerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("AutoNumber"),
    start: z.number().int(),
    step: z.number().int(),
  }),
  z.strictObject({ kind: z.literal("Enumeration"), items: z.array(z.string()).min(1) }),
]);
export type Filler = z.infer<typeof FillerSchema>;

/** An axis of a CartesianProduct / Zip — a named sub-generator (scalar-producing). */
const GenAxisSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    name: SlugSchema,
    kind: z.literal("Enumeration"),
    values: z.array(z.unknown()),
  }),
  z.strictObject({
    name: SlugSchema,
    kind: z.literal("Range"),
    start: z.number(),
    stop: z.number(),
    step: NonZeroStepSchema,
  }),
  z.strictObject({
    name: SlugSchema,
    kind: z.literal("Linspace"),
    start: z.number(),
    stop: z.number(),
    num: z.number().int().positive(),
  }),
]);
export type GenAxis = z.infer<typeof GenAxisSchema>;

const DistributionSchema = z.union([
  z
    .strictObject({ kind: z.literal("Uniform"), min: z.number(), max: z.number() })
    .refine((dist) => dist.max >= dist.min, {
      message: "Uniform max must be greater than or equal to min",
      path: ["max"],
    }),
  z.strictObject({ kind: z.literal("Normal"), mean: z.number(), std: z.number().positive() }),
  z.strictObject({ kind: z.literal("Choice"), items: z.array(z.unknown()).min(1) }),
]);

const SamplingDimSchema = z.strictObject({ name: SlugSchema, dist: DistributionSchema });

const FromFileSourceSchema = z.union([
  z.strictObject({ node: SlugSchema, output: z.string() }),
  z.literal("upload"),
]);

export const GenRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("Enumeration"), values: z.array(z.unknown()) }),
  z.strictObject({
    kind: z.literal("Range"),
    start: z.number(),
    stop: z.number(),
    step: NonZeroStepSchema,
  }),
  z.strictObject({
    kind: z.literal("Linspace"),
    start: z.number(),
    stop: z.number(),
    num: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("FixedCount"),
    count: z.number().int().positive(),
    filler: FillerSchema,
  }),
  z.strictObject({ kind: z.literal("CartesianProduct"), axes: z.array(GenAxisSchema).min(1) }),
  z.strictObject({ kind: z.literal("Zip"), axes: z.array(GenAxisSchema).min(1) }),
  z.strictObject({
    kind: z.literal("FromFile"),
    source: FromFileSourceSchema,
    format: z.enum(["CSV", "JSON", "JSONL"]),
    mapping: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    kind: z.literal("Sampling"),
    method: z.enum(["Random", "LatinHypercube", "Sobol", "Grid"]),
    count: z.number().int().positive(),
    seed: z.number().int().nullish(),
    dims: z.array(SamplingDimSchema).min(1),
  }),
]);
export type GenRule = z.infer<typeof GenRuleSchema>;

export const GenOutputSchema = z.strictObject({
  descriptor: z.string(),
  as: z.enum(["List", "BatchFiles"]),
});
export type GenOutput = z.infer<typeof GenOutputSchema>;
