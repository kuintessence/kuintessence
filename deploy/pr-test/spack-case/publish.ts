import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RecipeRepositorySchema,
  SpackMaterialBindingSchema,
  SpackMaterialManifestSchema,
  SpackMaterialPathSchema,
  SpackMaterialPublishSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { z } from "zod";
import { jsonRequest, login, ReleaseSchema } from "./api";

assert.equal(process.env.KQ_PR_TEST, "1");
const registry = "http://registry:3100";
const token = await login("http://server:3000");
const repository = "public/pr-hello-sources";
const recipes = "public/pr-hello-recipes";
const pack = "/opt/kq-case";
const metadata = z
  .object({
    spec: z.string(),
    target: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    roots: z.array(SpackMaterialPathSchema),
    sources: z.array(z.object({ path: SpackMaterialPathSchema, file: SpackMaterialPathSchema })),
    lockfile: SpackMaterialPathSchema,
  })
  .parse(JSON.parse(await readFile(join(pack, "metadata.json"), "utf8")));

if (process.argv.includes("--verify")) {
  const release = ReleaseSchema.parse(
    JSON.parse(await readFile("/case-control/release.json", "utf8")),
  );
  const snapshot = RecipeRepositorySchema.parse(
    await jsonRequest(registry, token, `/spack/recipe-repositories/${release.recipeId}`),
  );
  assert(snapshot.snapshots.some((item) => item.commit === release.commit));
  const response = await fetch(
    `${registry}/api/spack/material-repositories/${release.binding.repositoryId}/releases/${release.binding.manifestDigest}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, release.binding.manifestDigest);
  const manifest = SpackMaterialManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(manifest.spec, metadata.spec);
  async function verifyBytes(path: string, expected: { digest: string; size: number }) {
    const downloaded = await fetch(`${registry}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    assert.equal(downloaded.status, 200, "Persisted material download failed");
    assert(downloaded.body);
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of downloaded.body) {
      size += chunk.byteLength;
      assert(size <= expected.size, "Persisted material exceeds declared size");
      hash.update(chunk);
    }
    assert.equal(size, expected.size);
    assert.equal(`sha256:${hash.digest("hex")}`, expected.digest);
  }
  const unique = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob]));
  for (const blob of unique.values()) {
    await verifyBytes(
      `/spack/material-repositories/${release.binding.repositoryId}/releases/${release.binding.manifestDigest}/blobs/${blob.digest}`,
      blob,
    );
  }
  for (const selection of manifest.recipes) {
    await verifyBytes(
      `/spack/recipe-repositories/${selection.repositoryId}/snapshots/${selection.commit}/archive`,
      selection.archive,
    );
  }
  console.log("Spack case: Git snapshot archives and every material blob verified after Registry restart");
} else {
  const imported = await fetch(
    `${registry}/api/spack/recipe-repositories/import?repository=${encodeURIComponent(recipes)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: Bun.file(join(pack, "recipes.bundle")),
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    },
  );
  assert.equal(imported.status, 201, "Recipe bundle HTTP import failed");
  const recipe = RecipeRepositorySchema.parse(await imported.json());
  const selected = recipe.snapshots.find((item) => item.commit === metadata.commit);
  assert(selected, "Imported recipe commit differs from concretized recipe");
  assert.deepEqual(
    selected.diagnostics
      .filter((item) => item.severity === "error")
      .map(({ code, path }) => ({ code, path })),
    [],
    "Pinned recipe snapshot has blocking diagnostics",
  );

  async function upload(path: string) {
    const file = Bun.file(join(pack, path));
    const hasher = createHash("sha256");
    for await (const chunk of file.stream()) hasher.update(chunk);
    const blob = { digest: `sha256:${hasher.digest("hex")}`, size: file.size };
    const response = await fetch(
      `${registry}/api/spack/material-repositories/blobs?repository=${encodeURIComponent(repository)}&digest=${blob.digest}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: file,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
    );
    assert.equal(response.status, 201, `Material blob HTTP upload failed: ${path} (${blob.size} bytes)`);
    await response.body?.cancel();
    return blob;
  }

  const lockfile = await upload(metadata.lockfile);
  const sources = [];
  for (const source of metadata.sources) {
    sources.push({ path: source.path, blob: await upload(source.file) });
  }
  const input = SpackMaterialPublishSchema.parse({
    version: 1,
    repository,
    spec: metadata.spec,
    target: metadata.target,
    spackVersion: "1.0.0",
    redistribution: "unrestricted",
    recipes: [{ repositoryId: recipe.id, commit: metadata.commit, roots: metadata.roots }],
    sources,
    lockfile,
  });
  const preflight = z.object({ valid: z.boolean() }).parse(
    await jsonRequest(registry, token, "/spack/material-repositories/lock-preflight", input),
  );
  assert(preflight.valid, "Real Linux lock failed Registry preflight");
  const binding = SpackMaterialBindingSchema.parse(
    await jsonRequest(registry, token, "/spack/material-repositories/releases", input),
  );
  const response = await fetch(
    `${registry}/api/spack/material-repositories/${binding.repositoryId}/releases/${binding.manifestDigest}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(response.status, 200);
  const bytes = await response.arrayBuffer();
  assert.equal(`sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`, binding.manifestDigest);
  await writeFile("/case-control/bindings.json", JSON.stringify({ [metadata.spec]: binding }));
  await writeFile(
    "/case-control/release.json",
    JSON.stringify(ReleaseSchema.parse({
      binding,
      spec: metadata.spec,
      target: metadata.target,
      manifestSize: bytes.byteLength,
      recipeId: recipe.id,
      commit: metadata.commit,
    })),
  );
  console.log(`Spack case: imported Git recipes, real lock and ${sources.length} source mirror entries`);
}
