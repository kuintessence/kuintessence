import {
  bootstrapSpackMaterials,
  type MaterialBootstrapResult,
  type MaterialBootstrapStore,
} from "./material-bootstrap";
import { bootstrapRecipeRepositories, type RecipeBootstrapResult } from "./recipe-bootstrap";

interface SpackBootstrapOptions {
  recipeStore?: Parameters<typeof bootstrapRecipeRepositories>[0];
  recipeManifest?: string;
  materialStore?: MaterialBootstrapStore;
  materialManifest?: string;
}

interface SpackBootstrapDependencies {
  recipes: typeof bootstrapRecipeRepositories;
  materials: typeof bootstrapSpackMaterials;
}

export interface SpackBootstrapReport {
  status: "completed" | "partial" | "failed";
  failedStage?: "configuration" | "recipes" | "materials";
  recipes: RecipeBootstrapResult[];
  materials: MaterialBootstrapResult[];
}

export async function bootstrapConfiguredSpack(
  options: SpackBootstrapOptions,
  dependencies: SpackBootstrapDependencies = {
    recipes: bootstrapRecipeRepositories,
    materials: bootstrapSpackMaterials,
  },
): Promise<SpackBootstrapReport> {
  const report: SpackBootstrapReport = { status: "completed", recipes: [], materials: [] };
  if (
    (options.recipeManifest && !options.recipeStore) ||
    (options.materialManifest && (!options.materialStore || !options.recipeStore))
  ) {
    return { ...report, status: "failed", failedStage: "configuration" };
  }
  let stage: "recipes" | "materials" = "recipes";
  try {
    if (options.recipeManifest && options.recipeStore) {
      report.recipes = await dependencies.recipes(options.recipeStore, options.recipeManifest);
    }
    stage = "materials";
    if (options.materialManifest && options.materialStore) {
      report.materials = await dependencies.materials(
        options.materialStore,
        options.materialManifest,
      );
      const failed = report.materials.filter((result) => result.status === "failed").length;
      if (failed) {
        report.status = failed === report.materials.length ? "failed" : "partial";
        report.failedStage = "materials";
      }
    }
    return report;
  } catch {
    // Startup logs must not expose local paths, parser input or arbitrary store errors.
    return { ...report, status: "failed", failedStage: stage };
  }
}
