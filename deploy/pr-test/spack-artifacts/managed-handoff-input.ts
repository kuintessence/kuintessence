import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  RecipeBootstrapManifestSchema,
  RecipeCommitSchema,
  RecipeRepositoryNameSchema,
  SPACK_LOCK_MAX_BYTES,
  SPACK_MATERIAL_IMPORT_MAX_BYTES,
  type SpackMaterialBlob,
  SpackMaterialBlobSchema,
  SpackMaterialImportSchema,
  SpackMaterialPathSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { openMaterialImportFile } from "../../../packages/registry/src/services/material-import-files";
import { selectedCase } from "../spack-case/fixture";
import {
  type CaseId,
  CaseSchema,
  caseRoots,
  LIMITS,
  repositoryId,
  TARGET,
  UPSTREAM_COMMIT,
  UPSTREAM_TREE,
  validateLock,
  validateMetadata,
} from "./export-contract";
import {
  inputInventory,
  readBounded,
  safeDirectory,
  unchanged,
  verifyInventory,
} from "./export-files";

const ProvenanceSchema = z.strictObject({
  version: z.literal(1),
  case: CaseSchema,
  spec: z.string().max(4096),
  target: z.literal(TARGET),
  spackVersion: z.literal("1.0.0"),
  preparationContract: z.strictObject({
    upstreamRepository: z.literal("spack/spack-packages"),
    upstreamCommit: z.literal(UPSTREAM_COMMIT),
    upstreamTree: z.literal(UPSTREAM_TREE),
    clingoVersion: z.literal("5.7.1"),
  }),
  recipe: z.strictObject({
    repository: RecipeRepositoryNameSchema,
    repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
    commit: RecipeCommitSchema,
    roots: z.array(SpackMaterialPathSchema).min(1).max(2),
    bundle: SpackMaterialBlobSchema,
  }),
  materialRepository: RecipeRepositoryNameSchema,
  materialRepositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  preparedMetadata: SpackMaterialBlobSchema,
  lockfile: SpackMaterialBlobSchema,
  rootHash: z.string().regex(/^[a-z2-7]{32}$/),
  sources: z
    .array(z.strictObject({ path: SpackMaterialPathSchema, blob: SpackMaterialBlobSchema }))
    .min(1)
    .max(LIMITS.sourceEntries),
  validation: z.strictObject({
    kind: z.literal("static-only"),
    nativeDAGHashes: z.literal("not-recomputed"),
    sourceCoverage: z.literal("not-revalidated"),
    upstreamTree: z.literal("preparation-contract-only"),
    licenseReview: z.literal("not-performed"),
  }),
});

export type ManagedProvenance = z.infer<typeof ProvenanceSchema>;

export function handoffDigest(bytes: Uint8Array): SpackMaterialBlob {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
  };
}

export function handoffJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function hashHandoffStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<SpackMaterialBlob> {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      assert(size <= maximum);
      hash.update(chunk.value);
    }
    signal.throwIfAborted();
    return { digest: `sha256:${hash.digest("hex")}`, size };
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function readManagedDelivery(
  directory: string,
  caseId: CaseId,
  signal: AbortSignal,
) {
  const root = await safeDirectory(directory);
  const fixture = selectedCase(caseId);
  const metadataFiles = new Map([
    ["material-pack/manifest.json", SPACK_MATERIAL_IMPORT_MAX_BYTES],
    ["recipe-pack/manifest.json", 1024 ** 2],
    ["provenance.json", LIMITS.metadata],
    ["checksums.txt", LIMITS.metadata],
  ]);
  const snapshots = new Map<string, BigIntStats>();
  const documents = new Map<string, Buffer>();
  for (const [path, limit] of metadataFiles) {
    snapshots.set(path, await lstat(join(root, path), { bigint: true }));
    documents.set(path, await readBounded(root, path, limit, signal));
  }
  const document = (path: string) => {
    const bytes = documents.get(path);
    assert(bytes);
    return bytes;
  };
  const pack = SpackMaterialImportSchema.parse(
    handoffJson(document("material-pack/manifest.json")),
  );
  const recipes = RecipeBootstrapManifestSchema.parse(
    handoffJson(document("recipe-pack/manifest.json")),
  );
  const provenance = ProvenanceSchema.parse(handoffJson(document("provenance.json")));
  assert.equal(pack.releases.length, 1);
  assert.equal(recipes.repositories.length, 1);
  assert(pack.files.length <= LIMITS.sourceEntries + 1);
  const release = pack.releases[0];
  const recipe = recipes.repositories[0];
  assert(release && recipe && release.recipes.length === 1);
  const selection = release.recipes[0];
  assert(selection);
  assert.equal(release.repository, fixture.repository);
  assert.equal(recipe.repository, fixture.recipes);
  assert.equal(recipe.bundlePath, "recipes.bundle");
  assert.equal(release.spec, fixture.spec);
  assert.equal(release.target, TARGET);
  assert.equal(release.spackVersion, "1.0.0");
  assert.equal(selection.repositoryId, repositoryId(fixture.recipes));
  assert.deepEqual(selection.roots, caseRoots(caseId));
  assert.equal(provenance.case, caseId);
  assert.equal(provenance.spec, release.spec);
  assert.equal(provenance.materialRepository, release.repository);
  assert.equal(provenance.materialRepositoryId, repositoryId(release.repository));
  assert.deepEqual(provenance.recipe, {
    repository: recipe.repository,
    ...selection,
    bundle: provenance.recipe.bundle,
  });
  assert.deepEqual(provenance.lockfile, release.lockfile);
  assert.deepEqual(provenance.sources, release.sources);
  assert(provenance.preparedMetadata.size <= LIMITS.metadata);
  assert(provenance.recipe.bundle.size <= LIMITS.bundle);
  assert(release.lockfile.size <= SPACK_LOCK_MAX_BYTES);
  assert(release.sources.length <= LIMITS.sourceEntries);
  assert(release.sources.reduce((sum, entry) => sum + entry.blob.size, 0) <= LIMITS.sources);

  const expected = new Map(metadataFiles);
  expected.set("README.md", LIMITS.metadata);
  expected.set("recipe-pack/recipes.bundle", provenance.recipe.bundle.size);
  for (const file of pack.files) {
    assert.equal(file.path, `blobs/${file.blob.digest.slice(7)}`);
    expected.set(`material-pack/${file.path}`, file.blob.size);
  }
  const inventory = await inputInventory(root, expected);
  for (const [path, before] of snapshots) {
    const after = inventory.get(path);
    assert(after && unchanged(before, after));
  }
  const hashes = new Map<string, SpackMaterialBlob>();
  for (const [path, maximum] of expected) {
    if (path === "checksums.txt") continue;
    const stream = await openMaterialImportFile(root, path, undefined, maximum, signal);
    hashes.set(path, await hashHandoffStream(stream, maximum, signal));
  }
  assert.deepEqual(hashes.get("recipe-pack/recipes.bundle"), provenance.recipe.bundle);
  for (const file of pack.files) {
    assert.deepEqual(hashes.get(`material-pack/${file.path}`), file.blob);
  }
  const checksums = [...hashes.keys()]
    .sort()
    .map((path) => {
      const blob = hashes.get(path);
      assert(blob);
      return `${blob.digest.slice(7)}  ${path}\n`;
    })
    .join("");
  assert.equal(document("checksums.txt").toString("utf8"), checksums);

  const lockFile = pack.files.find((file) => file.blob.digest === release.lockfile.digest);
  assert(lockFile);
  const lock = await readBounded(root, `material-pack/${lockFile.path}`, SPACK_LOCK_MAX_BYTES, signal);
  assert.deepEqual(handoffDigest(lock), release.lockfile);
  const metadata = validateMetadata(
    {
      case: caseId,
      spec: release.spec,
      target: release.target,
      commit: selection.commit,
      roots: selection.roots,
      sources: release.sources.map(({ path }) => ({ path, file: `sources/${path}` })),
      lockfile: "spack.lock",
    },
    caseId,
  );
  assert.equal(validateLock(lock, metadata).rootHash, provenance.rootHash);
  await verifyInventory(root, inventory);
  signal.throwIfAborted();
  return {
    root,
    inventory,
    release,
    selection,
    recipe,
    bundle: provenance.recipe.bundle,
    lock,
  };
}

export type ManagedDelivery = Awaited<ReturnType<typeof readManagedDelivery>>;
