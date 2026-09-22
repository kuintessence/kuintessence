import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  MeCapabilitiesSchema,
  RecipeBootstrapManifestSchema,
  RecipeRepositorySchema,
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  SpackMaterialCatalogSchema,
  SpackMaterialImportSchema,
  SpackMaterialManifestSchema,
} from "@kuintessence/shared/browser";
import { expect, type Page, type Response, test } from "patchright/test";
import materials from "../src/locales/materials.en.json" with { type: "json" };
import recipes from "../src/locales/recipes.en.json" with { type: "json" };
import type { ArtifactStage } from "./material-artifacts.reporter";

const materialLabels = materials.materials;
const recipeLabels = recipes.recipes;
const materialApi = "/software/api/spack/material-repositories";
const recipeApi = "/software/api/spack/recipe-repositories/import";
const allowedSpecs = new Set([
  "hello@2.12.1",
  "samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^ncurses+symlinks %pkgconf ^zlib@1.3.1",
]);

async function stage<T>(name: ArtifactStage, action: () => Promise<T>): Promise<T> {
  return test.step(name, async () => {
    try {
      return await action();
    } catch {
      throw new Error(`artifact-web stage=${name} code=failed`);
    }
  });
}

async function readManifest(path: string): Promise<unknown> {
  const info = await lstat(path);
  assert(info.isFile() && info.size > 0 && info.size <= 2 * 1024 ** 2);
  return JSON.parse(await readFile(path, "utf8"));
}

function owner(repository: string): string {
  const parts = repository.split("/");
  assert(parts[0] === "public" || parts[0] === "org");
  return parts[0] === "public" ? "public" : `org/${parts[1]}`;
}

async function inputs() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.KQ_ARTIFACT_WEB_URL, "http://127.0.0.1:15173");
  const directory = process.env.KQ_ARTIFACT_DIRECTORY;
  const output = process.env.KQ_ARTIFACT_RESULT_PATH;
  assert(directory && output && isAbsolute(directory) && isAbsolute(output));
  const root = await realpath(directory);
  const result = join(await realpath(dirname(output)), basename(output));
  const resultRelative = relative(root, result);
  assert(resultRelative.startsWith(`..${sep}`) || isAbsolute(resultRelative));
  const resultExists = await lstat(result).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  assert(!resultExists);
  const recipePack = join(root, "recipe-pack");
  const materialPack = join(root, "material-pack");
  for (const directory of [recipePack, materialPack, join(materialPack, "blobs")]) {
    assert((await lstat(directory)).isDirectory());
  }
  const recipeManifest = RecipeBootstrapManifestSchema.parse(
    await readManifest(join(recipePack, "manifest.json")),
  );
  const pack = SpackMaterialImportSchema.parse(
    await readManifest(join(materialPack, "manifest.json")),
  );
  assert.equal(recipeManifest.repositories.length, 1);
  assert.equal(pack.releases.length, 1);
  const recipe = recipeManifest.repositories[0];
  const release = pack.releases[0];
  assert(recipe && release);
  assert.equal(recipe.bundlePath, "recipes.bundle");
  assert.equal(owner(recipe.repository), owner(release.repository));
  assert(allowedSpecs.has(release.spec));
  assert.equal(release.target, "linux-ubuntu20.04-x86_64");
  assert.equal(release.spackVersion, "1.0.0");
  assert.equal(release.recipes.length, 1);
  const selection = release.recipes[0];
  assert(selection);
  assert.equal(
    selection.repositoryId,
    createHash("sha256").update(recipe.repository).digest("hex"),
  );
  assert((await lstat(join(recipePack, recipe.bundlePath))).isFile());
  assert.deepEqual((await readdir(materialPack)).sort(), ["blobs", "manifest.json"]);
  for (const file of pack.files) {
    assert.equal(file.path, `blobs/${file.blob.digest.slice("sha256:".length)}`);
    const info = await lstat(join(materialPack, file.path));
    assert(info.isFile() && info.size === file.blob.size);
  }
  assert.deepEqual(
    (await readdir(join(materialPack, "blobs"))).sort(),
    pack.files.map((file) => basename(file.path)).sort(),
  );
  return { result, recipePack, materialPack, recipe, pack, release, selection };
}

// Credentials remain in the browser; only read-only JSON responses leave this function.
async function getJson(page: Page, path: string): Promise<unknown> {
  const response = await page.evaluate(async (apiPath) => {
    const token = localStorage.getItem("kq_token");
    if (!token) return { status: 0, body: null };
    const result = await fetch(apiPath, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok) return { status: result.status, body: null };
    return { status: result.status, body: await result.json() };
  }, path);
  assert.equal(response.status, 200);
  return response.body;
}

function isResponse(response: Response, path: string, method: string): boolean {
  const url = new URL(response.url());
  return (
    url.origin === "http://127.0.0.1:15173" &&
    url.pathname === path &&
    response.request().method() === method
  );
}

async function assertEmpty(page: Page, repository: string): Promise<void> {
  const catalog = SpackMaterialCatalogSchema.parse(
    await getJson(page, `${materialApi}?repository=${encodeURIComponent(repository)}`),
  );
  assert.equal(catalog.releases.length, 0);
}

async function selectMaterialPack(page: Page, manifest: string, directory: string): Promise<void> {
  const panel = page.getByTestId("spack-materials-panel");
  await panel.getByLabel(materialLabels.manifestFile, { exact: true }).setInputFiles(manifest);
  await expect(panel.getByRole("table", { name: materialLabels.queue })).toBeVisible();
  await expect(panel.getByLabel(materialLabels.directory, { exact: true })).toBeEnabled();
  await panel.getByLabel(materialLabels.directory, { exact: true }).setInputFiles(directory);
  await panel.getByRole("checkbox", { name: materialLabels.redistribution, exact: true }).check();
}

test("real artifact import through the application", async ({ page }) => {
  const fixture = await stage("inputs", inputs);
  const writes = { blobs: 0, releases: 0 };
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === `${materialApi}/blobs`) writes.blobs++;
    if (path === `${materialApi}/releases`) writes.releases++;
  });

  await stage("login", async () => {
    await page.addInitScript(() => localStorage.setItem("kq.lang", "en"));
    await page.goto("/login?redirect=%2Fcp%2Fsoftware");
    await page.getByTestId("login-email").fill("artifact-web-admin@example.test");
    await page.getByTestId("login-role").selectOption("super_admin");
    const [response] = await Promise.all([
      page.waitForResponse((item) => isResponse(item, "/platform/api/auth/login", "POST")),
      page.getByTestId("login-submit").click(),
    ]);
    assert.equal(response.status(), 200);
    await expect(page).toHaveURL("http://127.0.0.1:15173/cp/software");
    await expect(page.getByTestId("cp-layout")).toBeVisible();
    const capabilities = MeCapabilitiesSchema.parse(
      await getJson(page, "/platform/api/me/capabilities"),
    );
    assert.equal(capabilities.principal.role, "super_admin");
    assert(capabilities.principal.userId);
    assert(capabilities.capabilities.includes("software.publish"));
  });
  await stage("empty-store", () => assertEmpty(page, fixture.release.repository));

  await stage("recipe-import", async () => {
    const panel = page.getByTestId("recipe-repositories-panel");
    await panel
      .getByLabel(recipeLabels.files, { exact: true })
      .setInputFiles(join(fixture.recipePack, fixture.recipe.bundlePath));
    await panel
      .getByRole("textbox", {
        name: recipeLabels.namespace.replace("{{file}}", fixture.recipe.bundlePath),
        exact: true,
      })
      .fill(fixture.recipe.repository);
    const [response] = await Promise.all([
      page.waitForResponse((item) => isResponse(item, recipeApi, "POST"), { timeout: 180_000 }),
      panel.getByRole("button", { name: recipeLabels.import, exact: true }).click(),
    ]);
    assert.equal(response.status(), 201);
    const imported = RecipeRepositorySchema.parse(await response.json());
    assert.equal(imported.repository, fixture.recipe.repository);
    assert.equal(imported.id, fixture.selection.repositoryId);
    assert.equal(imported.activeCommit, null);
    const snapshot = imported.snapshots.find((item) => item.commit === fixture.selection.commit);
    assert(snapshot);
    assert(!snapshot.diagnostics.some((item) => item.severity === "error"));
    await expect(
      panel.getByRole("status").filter({ hasText: "1 imported, 0 failed" }),
    ).toBeVisible();
  });

  let scratch: string | undefined;
  let binding: SpackMaterialBinding | undefined;
  try {
    for (const kind of ["missing-file", "extra-file"] as const) {
      await stage(kind, async () => {
        scratch ??= await mkdtemp(join(tmpdir(), "kq-artifact-web-"));
        const directory = join(scratch, kind);
        await mkdir(join(directory, "blobs"), { recursive: true });
        await copyFile(
          join(fixture.materialPack, "manifest.json"),
          join(directory, "manifest.json"),
        );
        for (const [index, file] of fixture.pack.files.entries()) {
          if (kind === "missing-file" && index === 0) continue;
          await copyFile(join(fixture.materialPack, file.path), join(directory, file.path));
        }
        if (kind === "extra-file") {
          await writeFile(join(directory, "unexpected.txt"), "artifact-negative-fixture\n");
        }
        const before = { ...writes };
        await selectMaterialPack(page, join(fixture.materialPack, "manifest.json"), directory);
        const panel = page.getByTestId("spack-materials-panel");
        await expect(
          panel.getByRole("alert").filter({ hasText: materialLabels.invalidFiles }),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", { name: materialLabels.import, exact: true }),
        ).toBeDisabled();
        await assertEmpty(page, fixture.release.repository);
        assert.deepEqual(writes, before);
      });
    }

    binding = await stage("material-import", async () => {
      await selectMaterialPack(
        page,
        join(fixture.materialPack, "manifest.json"),
        fixture.materialPack,
      );
      const panel = page.getByTestId("spack-materials-panel");
      const [response] = await Promise.all([
        page.waitForResponse((item) => isResponse(item, `${materialApi}/releases`, "POST"), {
          timeout: 240_000,
        }),
        panel.getByRole("button", { name: materialLabels.import, exact: true }).click(),
      ]);
      assert.equal(response.status(), 201);
      const published = SpackMaterialBindingSchema.parse(await response.json());
      assert.equal(
        published.repositoryId,
        createHash("sha256").update(fixture.release.repository).digest("hex"),
      );
      await expect(
        panel.getByRole("status").filter({ hasText: "1 published, 0 failed, 0 unconfirmed" }),
      ).toBeVisible();
      assert.equal(writes.blobs, fixture.pack.files.length);
      assert.equal(writes.releases, 1);
      await panel
        .getByRole("table", { name: materialLabels.queue })
        .getByRole("button", { name: materialLabels.inspect, exact: true })
        .click();
      await expect(panel.getByTestId("material-release-detail")).toBeVisible();
      await expect(panel.getByLabel(materialLabels.repositoryId, { exact: true })).toHaveValue(
        published.repositoryId,
      );
      await expect(panel.getByLabel(materialLabels.manifestDigest, { exact: true })).toHaveValue(
        published.manifestDigest,
      );
      return published;
    });

    await stage("readback", async () => {
      assert(binding);
      const manifest = SpackMaterialManifestSchema.parse(
        await getJson(
          page,
          `${materialApi}/${binding.repositoryId}/releases/${encodeURIComponent(binding.manifestDigest)}`,
        ),
      );
      assert.deepEqual(
        {
          ...manifest,
          recipes: manifest.recipes.map(({ repositoryId, commit, roots }) => ({
            repositoryId,
            commit,
            roots,
          })),
        },
        fixture.release,
      );
      const catalog = SpackMaterialCatalogSchema.parse(
        await getJson(
          page,
          `${materialApi}?repository=${encodeURIComponent(fixture.release.repository)}`,
        ),
      );
      assert.equal(catalog.releases.length, 1);
      assert.deepEqual(
        SpackMaterialBindingSchema.parse({
          repositoryId: catalog.releases[0]?.repositoryId,
          manifestDigest: catalog.releases[0]?.manifestDigest,
        }),
        binding,
      );
    });
  } finally {
    await stage("cleanup", async () => {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    });
  }
  await stage("binding-output", async () => {
    const result = SpackMaterialBindingSchema.parse(binding);
    await writeFile(fixture.result, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  });
});
