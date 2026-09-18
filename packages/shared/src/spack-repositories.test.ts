import { describe, expect, test } from "bun:test";
import {
  RecipeActivationSchema,
  RecipeRepositoryNameSchema,
  RecipeSnapshotSchema,
} from "./spack-repositories";

describe("recipe repository contracts", () => {
  test("accepts canonical namespaces and rejects path aliases", () => {
    expect(RecipeRepositoryNameSchema.parse("public/builtin")).toBe("public/builtin");
    expect(RecipeRepositoryNameSchema.parse("org/demo/science")).toBe("org/demo/science");
    for (const value of [
      "/public/builtin",
      "public/../private",
      "public//builtin",
      "org/demo/../../escape",
      "public/a\\b",
      "public/.git",
      "https://example.com/repo",
    ]) {
      expect(RecipeRepositoryNameSchema.safeParse(value).success).toBe(false);
    }
  });

  test("requires explicit trust acknowledgement and a compare-and-swap value", () => {
    const input = {
      commit: "a".repeat(40),
      expectedActiveCommit: null,
      acknowledgeExecutableRecipes: true,
    };
    expect(RecipeActivationSchema.safeParse(input).success).toBe(true);
    expect(
      RecipeActivationSchema.safeParse({ ...input, acknowledgeExecutableRecipes: false }).success,
    ).toBe(false);
    expect(
      RecipeActivationSchema.safeParse({ commit: input.commit, acknowledgeExecutableRecipes: true })
        .success,
    ).toBe(false);
  });

  test("does not label static import diagnostics as concretization", () => {
    const input = {
      commit: "a".repeat(40),
      importedAt: "2026-09-17T00:00:00.000Z",
      importedBy: "operator",
      bundleSha256: "b".repeat(64),
      fileCount: 2,
      totalBytes: 200,
      roots: [{ path: "repo", namespace: "science", api: "v2.0", packageCount: 1 }],
      diagnostics: [],
      validation: "static-only",
    };
    expect(RecipeSnapshotSchema.safeParse(input).success).toBe(true);
    expect(RecipeSnapshotSchema.safeParse({ ...input, validation: "installed" }).success).toBe(
      false,
    );
  });
});
