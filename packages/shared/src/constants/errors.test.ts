import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "./errors";

describe("AppError", () => {
  test("serializes to JSON correctly", () => {
    const err = new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    const json = err.toJSON();
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.message).toBe("Job not found");
  });

  test("is instanceof Error", () => {
    const err = new AppError(ErrorCode.INTERNAL_ERROR, "oops");
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(500);
  });

  test("serializes queue availability errors", () => {
    const err = new AppError(ErrorCode.QUEUE_INVENTORY_UNAVAILABLE, "inventory is stale", 503);
    expect(err.toJSON().error.code).toBe("QUEUE_INVENTORY_UNAVAILABLE");
  });
});
