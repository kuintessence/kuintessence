import { z } from "zod";

/**
 * Safe expression (D1 = CEL subset). The string is not evaluated here — it is
 * carried verbatim and type-checked / evaluated by the engine's CEL host. We
 * keep `lang` open for a future second backend but default it to `cel`.
 */
export const ExprSchema = z.strictObject({
  expr: z.string().min(1),
  lang: z.string().default("cel"),
});
export type Expr = z.infer<typeof ExprSchema>;

/**
 * A bounded count that may be a literal positive integer or an expression
 * resolving to one (e.g. `maxIterations: { expr: "params.maxIter" }`).
 */
export const IntOrExprSchema = z.union([z.number().int().positive(), ExprSchema]);
export type IntOrExpr = z.infer<typeof IntOrExprSchema>;

const SCALAR_TYPES = [
  "bool",
  "int",
  "double",
  "string",
  "bytes",
  "json",
  "timestamp",
  "duration",
] as const;

/** Value type for parameters, value-outputs and reduce columns. */
export type ValueType = (typeof SCALAR_TYPES)[number] | { list: ValueType } | { map: ValueType };

export const ValueTypeSchema: z.ZodType<ValueType> = z.lazy(() =>
  z.union([
    z.enum(SCALAR_TYPES),
    z.strictObject({ list: ValueTypeSchema }),
    z.strictObject({ map: ValueTypeSchema }),
  ]),
);
