import { describe, expect, test } from "vitest";
import {
  canNavigateClusterUp,
  findClusterRoot,
  isClusterPathWithinRoots,
} from "./path-picker-utils";

describe("cluster root navigation", () => {
  test("selects the most specific root for an initial nested path", () => {
    expect(findClusterRoot("/projects/team-a/run-1", ["/projects", "/projects/team-a"])).toBe(
      "/projects/team-a",
    );
  });

  test("allows navigation within the selected root but not above it", () => {
    expect(canNavigateClusterUp("/projects/team-a/run-1", ["/projects/team-a"])).toBe(true);
    expect(canNavigateClusterUp("/projects/team-a", ["/projects/team-a"])).toBe(false);
    expect(isClusterPathWithinRoots("/projects/team-b", ["/projects/team-a"])).toBe(false);
  });
});
