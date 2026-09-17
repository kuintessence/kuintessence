import { zValidator } from "@hono/zod-validator";
import { AppError, ErrorCode } from "@kuintessence/shared";
import type { ValidationTargets } from "hono";
import type { ZodSchema } from "zod";

/**
 * Drop-in replacement for `zValidator(target, schema)` that rethrows validation
 * failures as the project's `AppError` envelope so the error handler returns
 * `{ error: { code: "VALIDATION_ERROR", message, details } }` (matching the web
 * `ApiError` parser) instead of zValidator's default
 * `{ success: false, error: { name: "ZodError", message: "<stringified JSON>" } }`.
 *
 * Without this wrapper the web client surfaces a JSON-as-string in toast on bad
 * input — see the QA report ISSUE-004.
 */
export function kqValidator<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
  message = "Invalid request body",
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, message, 400, result.error.issues);
    }
  });
}
