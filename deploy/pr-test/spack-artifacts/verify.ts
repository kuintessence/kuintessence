import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  RecipeBootstrapManifestSchema,
  RecipeRepositorySchema,
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  SpackMaterialCatalogSchema,
  SpackMaterialImportSchema,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { z } from "zod";
import { waitFor } from "../runtime";

const phaseSchema = z.enum(["bootstrap", "bootstrap-restart", "empty", "web", "web-restart"]);
type Phase = z.infer<typeof phaseSchema>;
const base = "/spack/material-repositories";

export function loopbackOrigin(value: string | undefined): string {
  assert(value);
  const url = new URL(value);
  assert(value === url.origin || value === `${url.origin}/`);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert(/^[1-9][0-9]{0,4}$/.test(url.port));
  assert(Number(url.port) <= 65535);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  return url.origin;
}

function canonicalPath(value: string | undefined): string {
  assert(value && isAbsolute(value) && resolve(value) === value);
  return value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyMaterialImport(phase: Phase) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const server = loopbackOrigin(process.env.KQ_WEB_SERVER_PROXY_TARGET);
  const registry = loopbackOrigin(process.env.KQ_WEB_REGISTRY_PROXY_TARGET);
  const directory = canonicalPath(process.env.KQ_ARTIFACT_DIRECTORY);
  const resultPath = canonicalPath(process.env.KQ_ARTIFACT_RESULT_PATH);
  const referencePath = canonicalPath(process.env.KQ_ARTIFACT_REFERENCE_PATH);
  const pack = SpackMaterialImportSchema.parse(
    JSON.parse(await readFile(join(directory, "material-pack/manifest.json"), "utf8")),
  );
  const recipes = RecipeBootstrapManifestSchema.parse(
    JSON.parse(await readFile(join(directory, "recipe-pack/manifest.json"), "utf8")),
  );
  assert.equal(pack.releases.length, 1);
  assert.equal(recipes.repositories.length, 1);
  const release = pack.releases[0];
  const recipeInput = recipes.repositories[0];
  assert(release && recipeInput && release.recipes.length === 1);
  const catalogPath = `${base}?repository=${encodeURIComponent(release.repository)}`;
  const recipeId = sha256(recipeInput.repository);
  const selection = release.recipes[0];
  assert(selection && selection.repositoryId === recipeId);
  assert.equal(recipeInput.bundlePath, "recipes.bundle");

  const login = await fetch(`${server}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "material-export@kuintessence.test", role: "super_admin" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(login.status, 200);
  const { token } = z.object({ token: z.string().min(1) }).parse(await login.json());

  async function request(path: string, body?: unknown, authenticated = true) {
    return fetch(`${registry}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  }

  async function catalog() {
    const response = await request(catalogPath);
    assert.equal(response.status, 200);
    return SpackMaterialCatalogSchema.parse(await response.json());
  }

  if (phase === "empty") {
    assert.equal((await catalog()).releases.length, 0);
    const missing = await request(`/spack/recipe-repositories/${recipeId}`);
    assert.equal(missing.status, 404);
    await missing.body?.cancel();
    console.log("Spack artifact import: phase=empty status=succeeded");
    return;
  }

  const listed = await waitFor(
    "material artifact import",
    catalog,
    (value) => value.releases.length > 0,
    300_000,
  );
  assert.equal(listed.releases.length, 1);
  const summary = listed.releases[0];
  assert(summary);
  const binding = SpackMaterialBindingSchema.parse({
    repositoryId: summary.repositoryId,
    manifestDigest: summary.manifestDigest,
  });
  assert.equal(binding.repositoryId, sha256(release.repository));
  if (phase === "web" || phase === "web-restart") {
    const uiBinding = SpackMaterialBindingSchema.parse(
      JSON.parse(await readFile(resultPath, "utf8")),
    );
    assert.deepEqual(binding, uiBinding);
  }
  if (phase !== "bootstrap") {
    const previous = SpackMaterialBindingSchema.parse(
      JSON.parse(await readFile(referencePath, "utf8")),
    );
    // A different database/session must not change the material identity.
    assert.deepEqual(binding, previous);
  }

  async function verifyBytes(path: string, expected: { digest: string; size: number }) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert(response.body);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert(size <= expected.size);
      hash.update(chunk);
    }
    assert.equal(size, expected.size);
    assert.equal(`sha256:${hash.digest("hex")}`, expected.digest);
  }

  const manifestResponse = await request(
    `${base}/${binding.repositoryId}/releases/${binding.manifestDigest}`,
  );
  assert.equal(manifestResponse.status, 200);
  const bytes = new Uint8Array(await manifestResponse.arrayBuffer());
  assert(bytes.byteLength <= 2 * 1024 ** 2);
  assert.equal(`sha256:${sha256(bytes)}`, binding.manifestDigest);
  const manifest = SpackMaterialManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  assert.deepEqual(
    { ...manifest, recipes: manifest.recipes.map(({ archive: _archive, ...recipe }) => recipe) },
    release,
  );
  const recipeResponse = await request(`/spack/recipe-repositories/${recipeId}`);
  assert.equal(recipeResponse.status, 200);
  const recipe = RecipeRepositorySchema.parse(await recipeResponse.json());
  assert.equal(recipe.repository, recipeInput.repository);
  assert.equal(recipe.activeCommit, null);
  assert.equal(recipe.snapshots.length, 1);
  const snapshot = recipe.snapshots[0];
  assert(snapshot && snapshot.commit === selection.commit);
  assert.equal(
    snapshot.bundleSha256,
    sha256(await readFile(join(directory, "recipe-pack/recipes.bundle"))),
  );
  assert(snapshot.diagnostics.every((item) => item.severity !== "error"));
  for (const root of selection.roots) assert(snapshot.roots.some((item) => item.path === root));
  for (const blob of new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob])).values()) {
    await verifyBytes(
      `${base}/${binding.repositoryId}/releases/${binding.manifestDigest}/blobs/${blob.digest}`,
      blob,
    );
  }
  for (const recipe of manifest.recipes) {
    await verifyBytes(
      `/spack/recipe-repositories/${recipe.repositoryId}/snapshots/${recipe.commit}/archive`,
      recipe.archive,
    );
  }

  if (phase === "web") {
    // Invalid requests must not create a second release or poison the existing content.
    const unauthenticated = await request(`${base}/releases`, release, false);
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.body?.cancel();
    const readerLogin = await fetch(`${server}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "material-reader@kuintessence.test", role: "user" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(readerLogin.status, 200);
    const reader = z.object({ token: z.string().min(1) }).parse(await readerLogin.json());
    const denied = await fetch(`${registry}/api${base}/releases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(release),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    const missingRecipe = await request(`${base}/releases`, {
      ...release,
      recipes: [{ ...selection, commit: "0".repeat(40) }],
    });
    assert([404, 422].includes(missingRecipe.status));
    await missingRecipe.body?.cancel();
    const wrongSize = await request(`${base}/releases`, {
      ...release,
      lockfile: { ...release.lockfile, size: release.lockfile.size + 1 },
    });
    assert.equal(wrongSize.status, 422);
    await wrongSize.body?.cancel();
    const file = pack.files.find((item) => item.blob.digest === release.lockfile.digest);
    assert(file);
    const changed = new Uint8Array(
      await readFile(join(directory, "material-pack", file.path)),
    );
    assert(changed.byteLength > 0 && changed.byteLength <= 16 * 1024 ** 2);
    changed[0] = (changed[0] ?? 0) ^ 1;
    const corrupted = await fetch(
      `${registry}/api${base}/blobs?repository=${encodeURIComponent(release.repository)}&digest=${file.blob.digest}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: changed,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
    );
    assert.equal(corrupted.status, 422);
    await corrupted.body?.cancel();
    await verifyBytes(
      `${base}/${binding.repositoryId}/releases/${binding.manifestDigest}/blobs/${file.blob.digest}`,
      file.blob,
    );
    assert.deepEqual(await catalog(), listed);
    console.log(
      "Spack artifact import: negative=unauthorized,forbidden,missing-recipe,wrong-size,corrupt-blob status=succeeded",
    );
  }
  if (phase === "bootstrap") await writeReceipt(referencePath, binding);
  console.log(`Spack artifact import: phase=${phase} status=succeeded`);
}

async function writeReceipt(path: string, binding: SpackMaterialBinding) {
  await writeFile(path, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: "wx" });
}

if (import.meta.main) {
  let phase: Phase | "arguments" = "arguments";
  try {
    assert.equal(process.argv.length, 3);
    phase = phaseSchema.parse(process.argv[2]);
    await verifyMaterialImport(phase);
  } catch {
    // Do not print response bodies, credentials, arbitrary paths or assertion values.
    console.error(`Spack artifact import: phase=${phase} status=failed`);
    process.exitCode = 1;
  }
}
