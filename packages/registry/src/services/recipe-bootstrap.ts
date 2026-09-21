import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { RecipeBootstrapManifestSchema } from "@kuintessence/shared";
import { RecipeStoreError } from "./recipe-git";
import { RecipeGitStore } from "./recipe-git-store";

type BootstrapStore = Pick<RecipeGitStore, "get" | "importBundle">;

export interface RecipeBootstrapResult {
  repository: string;
  status: "imported" | "skipped-existing";
}

export async function bootstrapRecipeRepositories(
  store: BootstrapStore,
  manifestPath: string,
): Promise<RecipeBootstrapResult[]> {
  if (!isAbsolute(manifestPath)) throw new Error("Recipe bootstrap manifest must be absolute");
  const manifestStat = await stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 1024 * 1024) {
    throw new Error("Recipe bootstrap manifest must be a regular file smaller than 1 MiB");
  }
  const manifest = RecipeBootstrapManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const names = new Set<string>();
  // Validate the entire operator manifest before importing any of its entries.
  const entries = manifest.repositories.map((entry) => {
    if (names.has(entry.repository)) throw new Error("Duplicate bootstrap recipe repository");
    names.add(entry.repository);
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry.bundlePath)) {
      throw new Error("Recipe bootstrap accepts local bundle files, not URLs");
    }
    return { ...entry, bundlePath: resolve(dirname(manifestPath), entry.bundlePath) };
  });
  const results: RecipeBootstrapResult[] = [];
  for (const entry of entries) {
    try {
      const existing = await store.get(RecipeGitStore.repositoryId(entry.repository));
      if (existing.snapshots.length > 0) {
        results.push({ repository: entry.repository, status: "skipped-existing" });
        continue;
      }
    } catch (error) {
      if (!(error instanceof RecipeStoreError) || error.status !== 404) throw error;
    }
    const bundleStat = await stat(entry.bundlePath);
    if (!bundleStat.isFile()) throw new Error("Recipe bootstrap bundle must be a regular file");
    await store.importBundle(
      entry.repository,
      Bun.file(entry.bundlePath).stream(),
      "registry-bootstrap",
    );
    results.push({ repository: entry.repository, status: "imported" });
  }
  return results;
}
