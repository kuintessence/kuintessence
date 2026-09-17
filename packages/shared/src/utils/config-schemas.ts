import { z } from "zod";

/** Shared LOG_LEVEL enum, default "info". */
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]).default("info");

/** A positive-integer env value (coerced from string), with a default. Use for
 *  ports, intervals, and other positive counts across package configs. */
export function positiveInt(defaultValue: number) {
  return z.coerce.number().int().positive().default(defaultValue);
}

/** A non-negative-integer env value (coerced from string), with a default. Use
 *  for timeouts/retention counts where 0 is a valid "disabled" sentinel. */
export function nonNegativeInt(defaultValue: number) {
  return z.coerce.number().int().nonnegative().default(defaultValue);
}

/** A boolean parsed from an env string ("true"/"false", case-insensitive),
 *  with a boolean default. Mirrors the `z.string().default(...).transform(...)`
 *  pattern duplicated across package configs. */
export function envBool(defaultValue: boolean) {
  return z
    .string()
    .default(String(defaultValue))
    .transform((s) => s.toLowerCase() === "true");
}
