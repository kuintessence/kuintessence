import { describe, expect, test } from "bun:test";
import { ApiError, apiErrorReason, unwrapApiResponse } from "./api-error";

describe("apiErrorReason", () => {
  test("returns a structured string reason", () => {
    const error = new ApiError(403, "FORBIDDEN", "denied", {
      reason: "PATH_OUTSIDE_ALLOWED_ROOT",
    });

    expect(apiErrorReason(error)).toBe("PATH_OUTSIDE_ALLOWED_ROOT");
  });

  test("returns null for missing or malformed details", () => {
    expect(apiErrorReason(new ApiError(403, "FORBIDDEN", "denied"))).toBeNull();
    expect(apiErrorReason(new ApiError(403, "FORBIDDEN", "denied", { reason: 403 }))).toBeNull();
  });
});

describe("unwrapApiResponse", () => {
  test("preserves legacy string error details", async () => {
    const response = new Response(JSON.stringify({ error: "runtime profile unavailable" }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" },
    });

    await expect(unwrapApiResponse(response)).rejects.toMatchObject({
      message: "runtime profile unavailable",
      status: 400,
    });
  });
});
