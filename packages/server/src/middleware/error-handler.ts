import { AppError, type AppErrorJson, ErrorCode, type ErrorCodeName } from "@kuintessence/shared";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "pino";
import { ZodError } from "zod";

const HTTP_STATUS_TO_CODE: Record<number, ErrorCodeName> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
};

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) {
      const json: AppErrorJson = err.toJSON();
      return c.json(
        json,
        err.statusCode as 200 | 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 501 | 503,
      );
    }
    // zValidator wraps malformed-JSON SyntaxError as an HTTPException(400,
    // "Malformed JSON in request body"). Catch HTTPException (and the raw
    // SyntaxError fallback for callers that bypass the validator) and map
    // both into the AppError envelope so clients see one consistent shape.
    if (err instanceof HTTPException) {
      const code = HTTP_STATUS_TO_CODE[err.status] ?? ErrorCode.INTERNAL_ERROR;
      const json: AppErrorJson = {
        error: { code, message: err.message },
      };
      return c.json(json, err.status as 400 | 401 | 403 | 404 | 500);
    }
    if (err instanceof SyntaxError) {
      const json: AppErrorJson = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: "Invalid JSON body",
        },
      };
      return c.json(json, 400);
    }
    if (err instanceof ZodError) {
      const json: AppErrorJson = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: err.message,
        },
      };
      return c.json(json, 400);
    }
    logger.error({ err, path: c.req.path, method: c.req.method }, "Unhandled error");
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      },
      500,
    );
  };
}

// Hono's default notFound returns "404 Not Found" as text/plain, which breaks
// the AppError JSON envelope contract that every other API failure follows.
// ISSUE-012: route this through the shared envelope so clients see one shape.
export function createNotFoundHandler(): NotFoundHandler {
  return (c) => {
    const json: AppErrorJson = {
      error: { code: ErrorCode.NOT_FOUND, message: "Route not found" },
    };
    return c.json(json, 404);
  };
}
