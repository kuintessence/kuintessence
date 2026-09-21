import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanupMaterials, materialFixture } from "../routes/spack-materials.test-helpers";
import type { MaterialBootstrapResult } from "./material-bootstrap";
import type { RecipeBootstrapResult } from "./recipe-bootstrap";
import { bootstrapConfiguredSpack } from "./spack-bootstrap";

afterEach(cleanupMaterials);

describe("configured Spack bootstrap", () => {
  const paths = {
    recipeManifest: "/imports/recipes.json",
    materialManifest: "/imports/materials.json",
  };

  test("does not read any local input when bootstrap is unconfigured", async () => {
    const recipes = mock(async (): Promise<RecipeBootstrapResult[]> => []);
    const materials = mock(async (): Promise<MaterialBootstrapResult[]> => []);
    expect(await bootstrapConfiguredSpack({}, { recipes, materials })).toEqual({
      status: "completed",
      recipes: [],
      materials: [],
    });
    expect(recipes).not.toHaveBeenCalled();
    expect(materials).not.toHaveBeenCalled();
  });

  test.each([
    "imported",
    "skipped-existing",
  ] as const)("waits for recipe bootstrap before materials: %s", async (status) => {
    const f = await materialFixture();
    const calls: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recipes = mock(async (): Promise<RecipeBootstrapResult[]> => {
      calls.push("recipes");
      await gate;
      calls.push("recipes-finished");
      return [{ repository: f.input.repository, status }];
    });
    const materials = mock(async (): Promise<MaterialBootstrapResult[]> => {
      calls.push("materials");
      return [];
    });
    const running = bootstrapConfiguredSpack(
      {
        ...paths,
        recipeStore: f.recipes,
        materialStore: f.store,
      },
      { recipes, materials },
    );
    expect(calls).toEqual(["recipes"]);
    release();
    expect((await running).status).toBe("completed");
    expect(calls).toEqual(["recipes", "recipes-finished", "materials"]);
  });

  test("recipe failure prevents material import and redacts the underlying error", async () => {
    const f = await materialFixture();
    const recipes = mock(async (): Promise<RecipeBootstrapResult[]> => {
      throw new Error("secret local path");
    });
    const materials = mock(async (): Promise<MaterialBootstrapResult[]> => []);
    const report = await bootstrapConfiguredSpack(
      {
        ...paths,
        recipeStore: f.recipes,
        materialStore: f.store,
      },
      { recipes, materials },
    );
    expect(report).toEqual({
      status: "failed",
      failedStage: "recipes",
      recipes: [],
      materials: [],
    });
    expect(materials).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("supports material-only maintenance against existing recipes", async () => {
    const f = await materialFixture();
    const recipes = mock(async (): Promise<RecipeBootstrapResult[]> => []);
    const materials = mock(async (): Promise<MaterialBootstrapResult[]> => []);
    const report = await bootstrapConfiguredSpack(
      {
        materialManifest: paths.materialManifest,
        recipeStore: f.recipes,
        materialStore: f.store,
      },
      { recipes, materials },
    );
    expect(report.status).toBe("completed");
    expect(recipes).not.toHaveBeenCalled();
    expect(materials).toHaveBeenCalledWith(f.store, paths.materialManifest);
  });

  test("material manifest failure preserves the completed recipe report", async () => {
    const f = await materialFixture();
    const results: RecipeBootstrapResult[] = [
      { repository: f.input.repository, status: "imported" },
    ];
    const report = await bootstrapConfiguredSpack(
      {
        ...paths,
        recipeStore: f.recipes,
        materialStore: f.store,
      },
      {
        recipes: async () => results,
        materials: async () => {
          throw new Error("secret");
        },
      },
    );
    expect(report).toEqual({
      status: "failed",
      failedStage: "materials",
      recipes: results,
      materials: [],
    });
  });

  test.each(["partial", "failed"] as const)("reports %s publication results", async (status) => {
    const f = await materialFixture();
    await f.seed();
    const binding = await f.store.publish(f.input, {
      sub: "bootstrap",
      role: "super_admin",
      orgIds: [],
    });
    const identity = { repository: f.input.repository, spec: f.input.spec, target: f.input.target };
    const materials: MaterialBootstrapResult[] = [
      { ...identity, status: "failed", error: "material-import-failed" },
      ...(status === "partial" ? [{ ...identity, status: "published" as const, binding }] : []),
    ];
    const report = await bootstrapConfiguredSpack(
      {
        ...paths,
        recipeStore: f.recipes,
        materialStore: f.store,
      },
      { recipes: async () => [], materials: async () => materials },
    );
    expect(report.status).toBe(status);
    expect(report.failedStage).toBe("materials");
    expect(report.materials).toEqual(materials);
  });

  test("rejects incomplete store configuration before either importer starts", async () => {
    const f = await materialFixture();
    const recipes = mock(async (): Promise<RecipeBootstrapResult[]> => []);
    const materials = mock(async (): Promise<MaterialBootstrapResult[]> => []);
    for (const stores of [{}, { recipeStore: f.recipes }, { materialStore: f.store }]) {
      expect(
        (await bootstrapConfiguredSpack({ ...paths, ...stores }, { recipes, materials }))
          .failedStage,
      ).toBe("configuration");
    }
    expect(recipes).not.toHaveBeenCalled();
    expect(materials).not.toHaveBeenCalled();
  });
});
