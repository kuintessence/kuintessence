import { describe, expect, test } from "bun:test";
import { ApiError } from "./api-client";
import { formatCliError } from "./cli-error";

describe("formatCliError", () => {
  test("maps a 401 to an actionable login hint (mentioning --local too)", () => {
    const msg = formatCliError(new ApiError(401, "UNAUTHENTICATED", "missing token"));
    expect(msg).toContain("kq login");
    expect(msg).toContain("--local");
    expect(msg).not.toContain("UNAUTHENTICATED"); // raw code not surfaced for auth
  });

  test("maps a 403 to an access-denied message", () => {
    const msg = formatCliError(new ApiError(403, "FORBIDDEN", "no permission"));
    expect(msg).toContain("Access denied");
    expect(msg).toContain("403");
  });

  test("other ApiErrors keep the status/code/message", () => {
    const msg = formatCliError(new ApiError(500, "INTERNAL", "boom"));
    expect(msg).toContain("500");
    expect(msg).toContain("INTERNAL");
    expect(msg).toContain("boom");
  });

  test("non-ApiError values fall back to their message/string form", () => {
    expect(formatCliError(new Error("plain"))).toBe("plain");
    expect(formatCliError("weird")).toBe("weird");
  });
});
