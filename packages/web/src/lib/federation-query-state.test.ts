import { ApiError } from "@kuintessence/shared/browser";
import { expect, test } from "vitest";
import { federationReadFailed } from "./federation-query-state";

test("cached data survives transport failures but never denied or invalid responses", () => {
  const query = {
    isError: true,
    data: [{ id: "original" }],
    error: new TypeError("Failed to fetch"),
  };
  expect(federationReadFailed(query)).toBe(false);
  expect(
    federationReadFailed({ ...query, error: new ApiError(503, "UNAVAILABLE", "unavailable") }),
  ).toBe(false);
  for (const status of [401, 403, 404, 409])
    expect(
      federationReadFailed({ ...query, error: new ApiError(status, "DENIED", "denied") }),
    ).toBe(true);
  expect(federationReadFailed({ ...query, error: new Error("Scope mismatch") })).toBe(true);
  expect(federationReadFailed({ ...query, data: undefined })).toBe(true);
});
