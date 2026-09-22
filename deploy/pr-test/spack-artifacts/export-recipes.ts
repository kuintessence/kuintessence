import { join } from "node:path";
import { z } from "zod";
import { inspectRecipeTree } from "../../../packages/registry/src/services/recipe-diagnostics";
import {
  checkRecipeObjects,
  createRecipeTextReader,
  DEFAULT_RECIPE_LIMITS,
  parseRecipeTree,
  runRecipeGit,
} from "../../../packages/registry/src/services/recipe-git";
import { preflightRecipeBundle } from "../../../packages/registry/src/services/recipe-pack-preflight";
import { LIMITS, type PreparedMetadata, requireExport, UPSTREAM_COMMIT } from "./export-contract";

export async function validateBundle(
  staging: string,
  metadata: PreparedMetadata,
  recipePaths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const limits = {
    ...DEFAULT_RECIPE_LIMITS,
    maxBundleBytes: LIMITS.bundle,
    maxFiles: LIMITS.recipeFiles,
  };
  const bundle = join(staging, "recipe-pack", "recipes.bundle");
  signal.throwIfAborted();
  await preflightRecipeBundle(bundle, limits);
  signal.throwIfAborted();
  const git = (directory: string, args: string[]) =>
    runRecipeGit(directory, args, limits, false, undefined, signal);
  const directory = join(staging, ".recipe-check.git");
  await git(staging, ["init", "--bare", "--template=", directory]);
  await git(directory, ["bundle", "verify", bundle]);
  const refs = (await git(directory, ["bundle", "list-heads", bundle])).stdout.toString();
  requireExport(
    refs.split("\n").filter(Boolean).sort().join("\n") ===
      [`${metadata.commit} HEAD`, `${metadata.commit} refs/heads/case`].sort().join("\n"),
    "Bundle references do not match the prepared snapshot",
  );
  await git(directory, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    bundle,
    "HEAD:refs/heads/import",
  ]);
  await git(directory, ["fsck", "--full", "--strict", "--no-reflogs"]);
  const imported = await git(directory, ["rev-parse", "refs/heads/import^{commit}"]);
  const commits = await git(directory, ["rev-list", "--count", "refs/heads/import"]);
  requireExport(
    imported.stdout.toString().trim() === metadata.commit &&
      commits.stdout.toString().trim() === "1",
    "Bundle must contain the single prepared snapshot",
  );
  checkRecipeObjects(
    (await git(directory, ["cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"])).stdout,
    limits,
  );
  const tree = (
    await git(directory, ["ls-tree", "-r", "-z", "-l", "--full-tree", metadata.commit])
  ).stdout;
  requireExport(tree.byteLength <= LIMITS.tree, "Recipe tree metadata budget exceeded");
  const files = parseRecipeTree(tree, { ...limits, maxExpandedBytes: LIMITS.recipes });
  const filePaths = new Set(files.map((file) => file.path));
  requireExport(
    recipePaths.every((path) => filePaths.has(path)),
    "A compiled lock recipe is missing from the bundle",
  );
  const report = await inspectRecipeTree(
    files,
    createRecipeTextReader(directory, files, limits, signal),
  );
  requireExport(
    !report.diagnostics.some((item) => item.severity === "error") &&
      report.roots.length === metadata.roots.length &&
      metadata.roots.every((path) =>
        report.roots.some(
          (root) =>
            root.path === path &&
            root.namespace === (path.endsWith("/kq_case") ? "kq_case" : "builtin"),
        ),
      ),
    "Bundle recipe roots failed static inspection",
  );
  for (const name of ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT", "upstream.json"]) {
    requireExport(filePaths.has(name), "Prepared recipe provenance is missing");
  }
  const upstreamFile = files.find((file) => file.path === "upstream.json");
  requireExport(upstreamFile && upstreamFile.size <= 4096, "Invalid recipe provenance");
  const upstream = z
    .strictObject({
      repository: z.literal("spack/spack-packages"),
      commit: z.literal(UPSTREAM_COMMIT),
    })
    .safeParse(
      JSON.parse((await git(directory, ["cat-file", "blob", upstreamFile.oid])).stdout.toString()),
    );
  requireExport(upstream.success, "Recipe provenance does not match the preparation contract");
}
