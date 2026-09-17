import { z } from "zod";
import { SlugSchema } from "./common";
import { NodeOutputRefSchema } from "./refs";

/** A value a loop exposes to the outer workflow (aggregated across iterations). */
export const LoopOutputSchema = z.strictObject({
  descriptor: z.string(),
  from: NodeOutputRefSchema,
  aggregate: z.enum(["Collect", "Concat", "Reduce"]).optional(),
});
export type LoopOutput = z.infer<typeof LoopOutputSchema>;

/** Cross-iteration state hand-off for While loops (this round's output → next round's input). */
export const LoopCarrySchema = z.strictObject({
  from: NodeOutputRefSchema,
  to: z.strictObject({ input: z.string() }),
  initial: z.union([NodeOutputRefSchema, z.strictObject({ param: SlugSchema })]).optional(),
});
export type LoopCarry = z.infer<typeof LoopCarrySchema>;
