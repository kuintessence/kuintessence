import { z } from "zod";
import { evalCel } from "./cel";

export const OutputValidatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("finite") }),
  z.strictObject({ kind: z.literal("cel"), expr: z.string().min(1).max(4096) }),
]);

export function validateOutput(
  descriptor: string,
  rule: z.infer<typeof OutputValidatorSchema>,
  value: unknown,
) {
  const valid =
    rule.kind === "finite"
      ? typeof value === "number" && Number.isFinite(value)
      : value !== undefined && evalCel(rule.expr, { value }) === true;
  if (!valid) throw new Error(`Output '${descriptor}' failed its ${rule.kind} validator`);
}
