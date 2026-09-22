import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  RecipeBootstrapManifestSchema,
  SPACK_LOCK_MAX_BYTES,
  SPACK_MATERIAL_IMPORT_MAX_BYTES,
  type SpackMaterialBlob,
  SpackMaterialImportSchema,
  SpackMaterialPublishSchema,
} from "@kuintessence/shared";
import {
  type ExportMaterialPackOptions,
  LIMITS,
  MaterialPackExportError,
  OptionsSchema,
  type PreparedMetadata,
  repositoryId,
  requireExport,
  UPSTREAM_COMMIT,
  UPSTREAM_TREE,
  validateLock,
  validateMetadata,
  validateNamespaces,
} from "./export-contract";
import {
  copyHashed,
  inputInventory,
  readBounded,
  requireAbsent,
  safeDirectory,
  unchanged,
  verifyInventory,
} from "./export-files";
import { validateBundle } from "./export-recipes";

export type { ExportMaterialPackOptions } from "./export-contract";

function digest(bytes: Uint8Array): SpackMaterialBlob {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
  };
}

function nested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("../") && path !== "..");
}

async function writeOutput(
  staging: string,
  path: string,
  bytes: Uint8Array,
  outputs: Map<string, SpackMaterialBlob>,
): Promise<void> {
  await writeFile(join(staging, path), bytes, { flag: "wx", mode: 0o644 });
  await chmod(join(staging, path), 0o644);
  outputs.set(path, digest(bytes));
}

function json(value: unknown, maximum: number): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  requireExport(bytes.byteLength <= maximum, "Export manifest byte budget exceeded");
  return bytes;
}

async function stagePayloads(
  input: string,
  staging: string,
  metadata: PreparedMetadata,
  outputs: Map<string, SpackMaterialBlob>,
  signal: AbortSignal,
) {
  const unique = new Map<string, { path: string; blob: SpackMaterialBlob }>();
  const copy = async (path: string, maximum: number) => {
    const temporary = join(staging, ".payload");
    const blob = await copyHashed(input, path, temporary, maximum, signal);
    const existing = unique.get(blob.digest);
    if (existing) {
      requireExport(existing.blob.size === blob.size, "Conflicting payload digest size");
      await rm(temporary);
    } else {
      const destination = `blobs/${blob.digest.slice("sha256:".length)}`;
      await rename(temporary, join(staging, "material-pack", destination));
      unique.set(blob.digest, { path: destination, blob });
      outputs.set(`material-pack/${destination}`, blob);
    }
    return blob;
  };
  const lockfile = await copy(metadata.lockfile, SPACK_LOCK_MAX_BYTES);
  const lockPath = unique.get(lockfile.digest)?.path;
  requireExport(lockPath, "Staged lock is missing");
  const lock = validateLock(
    await readBounded(join(staging, "material-pack"), lockPath, SPACK_LOCK_MAX_BYTES, signal),
    metadata,
  );
  const sources: { path: string; blob: SpackMaterialBlob }[] = [];
  let sourceBytes = 0;
  const ordered = [...metadata.sources].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const source of ordered) {
    const blob = await copy(source.file, LIMITS.sources - sourceBytes);
    sourceBytes += blob.size;
    sources.push({ path: source.path, blob });
  }
  return {
    lockfile,
    ...lock,
    sources,
    files: [...unique.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
}

function readme(options: ExportMaterialPackOptions): Buffer {
  return Buffer.from(
    [
      "# Fixed Spack material pack",
      "",
      `Case: ${options.caseId}. Spack 1.0.0; linux-ubuntu20.04-x86_64.`,
      `Recipe repository: ${options.recipeRepository}`,
      `Material repository: ${options.materialRepository}`,
      "",
      "Import recipes before materials. For bootstrap, use the absolute paths of",
      "recipe-pack/manifest.json and material-pack/manifest.json after extraction.",
      "An existing recipe repository with any snapshot is skipped by bootstrap:",
      "use a fresh repository name or import this exact snapshot through Web/API first.",
      "",
      "For Web, import recipe-pack/recipes.bundle into the exact recipe repository",
      "above, then select material-pack/manifest.json and the material-pack directory.",
      "Do not select the delivery root or add README/checksum files to material-pack.",
      "Archives are transport only; extract before importing. Keep ordinary files",
      "with mode 0644 and directories 0755; no symlinks or hardlinks.",
      "",
      "Import does not activate recipes, install software, set Server bindings,",
      "grant download access, or reset visibility/lifecycle policies. Imports are",
      "not an atomic transaction across repositories. Keep the returned binding.",
      "",
      "The lock requires the reference host externals and site profile, including",
      "/usr/bin/python3 and /usr/bin/perl for samtools. This is not a portable binary.",
      "Static export validation does not execute recipes, recompute native DAG",
      "hashes, prove source coverage, or certify installation readiness.",
      "",
      "LICENSE REVIEW REQUIRED: Do not redistribute without reviewing the licenses",
      "of every recipe, source, patch and dependency and satisfying their obligations.",
      "The protocol value redistribution=unrestricted is not a license determination.",
      "No license_ack value, checksum, CI result or export success constitutes approval.",
      "Recipe notices remain inside the unchanged Git bundle; source notices remain",
      "inside the unchanged source archives. No independent license audit was performed.",
      "",
      "checksums.txt covers every delivered file except itself, using relative paths.",
      "Checksums bind transport bytes; they are not a publisher signature or attestation.",
      "provenance.json records only the fixed preparation contract and verified bytes.",
      "",
    ].join("\n"),
  );
}

async function assemble(
  options: ExportMaterialPackOptions,
  input: string,
  staging: string,
  signal: AbortSignal,
): Promise<void> {
  const metadataBefore = await lstat(join(input, "metadata.json"), { bigint: true });
  const metadataBytes = await readBounded(input, "metadata.json", LIMITS.metadata, signal);
  const metadata = validateMetadata(
    JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(metadataBytes)),
    options.caseId,
  );
  const expected = new Map([
    ["metadata.json", LIMITS.metadata],
    ["recipes.bundle", LIMITS.bundle],
    ["spack.lock", SPACK_LOCK_MAX_BYTES],
    ...metadata.sources.map((source): [string, number] => [source.file, LIMITS.sources]),
  ]);
  const inventory = await inputInventory(input, expected);
  const metadataAfter = inventory.get("metadata.json");
  requireExport(
    metadataAfter && unchanged(metadataBefore, metadataAfter),
    "Prepared metadata changed during export",
  );
  let sourceBytes = 0n;
  for (const source of metadata.sources) {
    sourceBytes += inventory.get(source.file)?.size ?? 0n;
  }
  requireExport(sourceBytes <= BigInt(LIMITS.sources), "Source alias byte budget exceeded");
  for (const path of ["recipe-pack", "material-pack", "material-pack/blobs"]) {
    await mkdir(join(staging, path), { mode: 0o755 });
    await chmod(join(staging, path), 0o755);
  }
  const outputs = new Map<string, SpackMaterialBlob>();
  const bundle = await copyHashed(
    input,
    "recipes.bundle",
    join(staging, "recipe-pack", "recipes.bundle"),
    LIMITS.bundle,
    signal,
  );
  outputs.set("recipe-pack/recipes.bundle", bundle);
  const payload = await stagePayloads(input, staging, metadata, outputs, signal);
  await validateBundle(staging, metadata, payload.recipePaths, signal);
  await rm(join(staging, ".recipe-check.git"), { recursive: true });
  const recipeId = repositoryId(options.recipeRepository);
  const release = SpackMaterialPublishSchema.parse({
    version: 1,
    repository: options.materialRepository,
    spec: metadata.spec,
    target: metadata.target,
    spackVersion: "1.0.0",
    redistribution: "unrestricted",
    recipes: [{ repositoryId: recipeId, commit: metadata.commit, roots: metadata.roots }],
    sources: payload.sources,
    lockfile: payload.lockfile,
  });
  const material = SpackMaterialImportSchema.parse({
    version: 1,
    files: payload.files,
    releases: [release],
  });
  const recipe = RecipeBootstrapManifestSchema.parse({
    version: 1,
    repositories: [{ repository: options.recipeRepository, bundlePath: "recipes.bundle" }],
  });
  await writeOutput(staging, "recipe-pack/manifest.json", json(recipe, 1024 ** 2), outputs);
  await writeOutput(
    staging,
    "material-pack/manifest.json",
    json(material, SPACK_MATERIAL_IMPORT_MAX_BYTES),
    outputs,
  );
  const provenance = {
    version: 1,
    case: metadata.case,
    spec: metadata.spec,
    target: metadata.target,
    spackVersion: "1.0.0",
    preparationContract: {
      upstreamRepository: "spack/spack-packages",
      upstreamCommit: UPSTREAM_COMMIT,
      upstreamTree: UPSTREAM_TREE,
      clingoVersion: "5.7.1",
    },
    recipe: {
      repository: options.recipeRepository,
      repositoryId: recipeId,
      commit: metadata.commit,
      roots: metadata.roots,
      bundle,
    },
    materialRepository: options.materialRepository,
    materialRepositoryId: repositoryId(options.materialRepository),
    preparedMetadata: digest(metadataBytes),
    lockfile: payload.lockfile,
    rootHash: payload.rootHash,
    sources: payload.sources,
    validation: {
      kind: "static-only",
      nativeDAGHashes: "not-recomputed",
      sourceCoverage: "not-revalidated",
      upstreamTree: "preparation-contract-only",
      licenseReview: "not-performed",
    },
  };
  await writeOutput(staging, "provenance.json", json(provenance, LIMITS.metadata), outputs);
  await writeOutput(staging, "README.md", readme(options), outputs);
  const checksums = [...outputs.keys()]
    .sort()
    .map((path) => {
      const blob = outputs.get(path);
      requireExport(blob, "Missing output checksum");
      return `${blob.digest.slice("sha256:".length)}  ${path}\n`;
    })
    .join("");
  await writeOutput(staging, "checksums.txt", Buffer.from(checksums), outputs);
  await inputInventory(
    staging,
    new Map([...outputs].map(([path, blob]) => [path, blob.size])),
  );
  await verifyInventory(input, inventory);
  signal.throwIfAborted();
}

/** The input and output parent must exist; the output itself must not exist. */
export async function exportMaterialPack(options: ExportMaterialPackOptions): Promise<void> {
  let staging: string | undefined;
  let reservation: string | undefined;
  try {
    const parsed = OptionsSchema.parse(options);
    validateNamespaces(parsed.recipeRepository, parsed.materialRepository);
    const input = await safeDirectory(parsed.inputDirectory);
    const output = resolve(parsed.outputDirectory);
    const parent = await safeDirectory(dirname(output));
    requireExport(
      !nested(input, output) &&
        !nested(output, input) &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(basename(output)),
      "Input and output directories must be separate",
    );
    const lock = join(parent, `.${basename(output)}.export-lock`);
    // Serialize cooperating exporters without exposing an incomplete destination.
    await mkdir(lock, { mode: 0o700 });
    reservation = lock;
    await requireAbsent(output);
    staging = await mkdtemp(join(parent, `.${basename(output)}.export-`));
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    await assemble(parsed, input, staging, signal);
    await safeDirectory(parent);
    await requireAbsent(output);
    await chmod(staging, 0o755);
    await rename(staging, output);
    staging = undefined;
  } catch (error) {
    // Never surface native Git diagnostics, input paths, environment or JSON fragments.
    throw error instanceof MaterialPackExportError
      ? error
      : new MaterialPackExportError("Material pack export failed validation or I/O");
  } finally {
    try {
      try {
        if (staging) await rm(staging, { recursive: true, force: true });
      } finally {
        if (reservation) await rm(reservation, { recursive: true, force: true });
      }
    } catch {
      throw new MaterialPackExportError("Material pack export cleanup failed");
    }
  }
}

if (import.meta.main) {
  try {
    const [inputDirectory, outputDirectory, caseId, recipeRepository, materialRepository] =
      process.argv.slice(2);
    requireExport(
      process.argv.length === 7,
      "Usage: bun export.ts INPUT OUTPUT CASE RECIPE_REPO MATERIAL_REPO",
    );
    await exportMaterialPack(
      OptionsSchema.parse({
        inputDirectory,
        outputDirectory,
        caseId,
        recipeRepository,
        materialRepository,
      }),
    );
    console.log("Fixed material pack export completed");
  } catch (error) {
    console.error(
      error instanceof MaterialPackExportError
        ? error.message
        : "Invalid material pack export arguments",
    );
    process.exitCode = 1;
  }
}
