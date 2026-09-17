import { describe, expect, test } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  test("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  test("drops falsy entries", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  test("dedupes via tailwind-merge for conflicting utilities", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500 text-blue-500")).toBe("text-blue-500");
  });
});
