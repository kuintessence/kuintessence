import { z } from "zod";
import { SlugSchema } from "./common";
import { ValueTypeSchema } from "./expr";

/** How to pull a typed value out of collected text/JSON output. */
export const ExtractSchema = z.strictObject({
  kind: z.enum(["Regex", "JsonPath", "Whole"]),
  pattern: z.string().optional(),
  group: z.number().int().nonnegative().optional(),
  path: z.string().optional(),
});
export type Extract = z.infer<typeof ExtractSchema>;

/**
 * Ability-package value output (D7). Defines a `nodes.<id>.values.<descriptor>`
 * binding by extracting a typed value from a collected output.
 */
export const ValueOutputSchema = z.strictObject({
  descriptor: SlugSchema,
  type: ValueTypeSchema,
  from: z.strictObject({ collectedOutDescriptor: z.string() }),
  extract: ExtractSchema,
  onMissing: z.enum(["Fail", "Default"]).optional(),
  default: z.unknown().optional(),
});
export type ValueOutput = z.infer<typeof ValueOutputSchema>;
