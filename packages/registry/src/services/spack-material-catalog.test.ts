import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupMaterials,
  materialFixture,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import {
  ORG,
  OTHER_ORG,
  OWNER,
  PLATFORM,
  repository,
  SUPER,
  USER,
} from "../routes/spack-repositories.test-helpers";
import { RecipeStoreError } from "./recipe-git";
import { SpackMaterialCatalogReader } from "./spack-material-catalog";
import type { MaterialMetadataReadOptions } from "./spack-material-storage";
import { materialDigest } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

async function published() {
  const f = await materialFixture({}, repository("public/recipes"));
  await f.seed("public/materials");
  const binding = await f.store.publish({ ...f.input, repository: "public/materials" }, SUPER);
  return { ...f, binding };
}

describe("material catalog persistent scan", () => {
  test("empty stores return no entries without creating directories", async () => {
    const f = await materialFixture();
    expect(await f.store.list({}, USER)).toEqual({ releases: [] });
  });

  test("discovers existing immutable publications after restart and emits only summaries", async () => {
    const f = await published();
    const bytesBefore = await readFile(
      join(
        f.root,
        "manifests",
        f.binding.repositoryId,
        `${f.binding.manifestDigest.slice(7)}.json`,
      ),
    );
    const restarted = new SpackMaterialStore(f.root, f.recipes);
    const result = await restarted.list({}, USER);
    const { manifest } = await restarted.getManifest(
      f.binding.repositoryId,
      f.binding.manifestDigest,
    );
    expect(result.releases).toEqual([
      {
        ...f.binding,
        repository: manifest.repository,
        spec: manifest.spec,
        target: manifest.target,
        spackVersion: manifest.spackVersion,
        redistribution: "unrestricted",
        sourceCount: 1,
        totalBytes: manifest.lockfile.size + SOURCE_BLOB.size + 4,
      },
    ]);
    expect(
      await readFile(
        join(
          f.root,
          "manifests",
          f.binding.repositoryId,
          `${f.binding.manifestDigest.slice(7)}.json`,
        ),
      ),
    ).toEqual(bytesBefore);
    expect(f.recipes.archive).toHaveBeenCalledTimes(1);
  });

  test("sorts deterministically and counts shared blobs once per release", async () => {
    const f = await published();
    await f.seed("public/aaa");
    await f.store.publish(
      {
        ...f.input,
        repository: "public/aaa",
        sources: [...f.input.sources, { path: "other/source.tar.gz", blob: SOURCE_BLOB }],
      },
      SUPER,
    );
    const { releases } = await f.store.list({}, USER);
    expect(releases.map((item) => item.repository)).toEqual(["public/aaa", "public/materials"]);
    expect(releases[0]?.sourceCount).toBe(2);
    expect(releases[0]?.totalBytes).toBe(releases[1]?.totalBytes);
  });

  test("hides foreign org and personal materials and does not treat platform admin as member", async () => {
    const f = await published();
    for (const name of [`org/${ORG}/materials`, `org/${OTHER_ORG}/materials`, "user/reader/mine"]) {
      await f.seed(name);
      await f.store.publish({ ...f.input, repository: name }, SUPER);
    }
    expect((await f.store.list({}, USER)).releases.map((item) => item.repository)).toEqual([
      `org/${ORG}/materials`,
      "public/materials",
      "user/reader/mine",
    ]);
    expect((await f.store.list({}, PLATFORM)).releases.map((item) => item.repository)).toEqual([
      "public/materials",
    ]);
    expect((await f.store.list({}, SUPER)).releases).toHaveLength(4);
    expect(await f.store.list({ repository: `org/${OTHER_ORG}/materials` }, USER)).toEqual({
      releases: [],
    });
  });

  test("rechecks recipe access for each request and hides missing recipe references", async () => {
    const f = await materialFixture();
    await f.seed();
    await f.store.publish(f.input, OWNER);
    expect((await f.store.list({}, USER)).releases).toHaveLength(1);
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    expect(await f.store.list({}, USER)).toEqual({ releases: [] });
    f.recipes.get.mockImplementationOnce(async () => {
      throw new RecipeStoreError(404, "Missing recipe");
    });
    expect(await f.store.list({}, SUPER)).toEqual({ releases: [] });
    f.recipes.get.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Unexpected storage failure"), { code: "EIO" });
    });
    await expect(f.store.list({}, SUPER)).rejects.toMatchObject({ code: "EIO" });
  });

  test("exact repository filter bypasses unrelated directories and unknown names return empty", async () => {
    const f = await published();
    await mkdir(join(f.root, "manifests", "c".repeat(64)));
    await writeFile(join(f.root, "manifests", "c".repeat(64), `${"d".repeat(64)}.json`), "bad");
    expect((await f.store.list({ repository: "public/materials" }, USER)).releases).toHaveLength(1);
    expect(await f.store.list({ repository: "public/unknown" }, USER)).toEqual({ releases: [] });
    await expect(f.store.list({}, SUPER)).rejects.toMatchObject({ status: 500 });
  });

  test("ignores temporary and unrelated files but fails on valid-name symlink manifests", async () => {
    const f = await published();
    const path = join(f.root, "manifests", f.binding.repositoryId);
    await writeFile(join(path, "staged.json.tmp"), "not published");
    await writeFile(join(path, "notes.txt"), "not a release");
    expect((await f.store.list({}, USER)).releases).toHaveLength(1);
    await symlink(
      join(path, `${f.binding.manifestDigest.slice(7)}.json`),
      join(path, `${"1".repeat(64)}.json`),
    );
    await expect(f.store.list({}, USER)).rejects.toMatchObject({ status: 500 });
  });

  test.each([
    "root",
    "repository",
  ])("rejects a symlink %s directory on both query paths", async (kind) => {
    const f = await published();
    const path =
      kind === "root"
        ? join(f.root, "manifests")
        : join(f.root, "manifests", f.binding.repositoryId);
    const moved = join(f.root, "relocated");
    await rename(path, moved);
    await symlink(moved, path);
    await expect(f.store.list({}, USER)).rejects.toMatchObject({ status: 500 });
    await expect(f.store.list({ repository: "public/materials" }, USER)).rejects.toMatchObject({
      status: 500,
    });
  });

  test("malformed filter and an already aborted request do not touch the store", async () => {
    const f = await published();
    await expect(f.store.list({ repository: "../escape" }, USER)).rejects.toMatchObject({
      status: 422,
    });
    const controller = new AbortController();
    const reason = new Error("cancel before scan");
    controller.abort(reason);
    await expect(f.store.list({}, USER, controller.signal)).rejects.toBe(reason);
    expect(f.recipes.get).toHaveBeenCalledTimes(1);
  });

  test("identical publication is listed only once", async () => {
    const f = await published();
    expect(await f.store.publish({ ...f.input, repository: "public/materials" }, SUPER)).toEqual(
      f.binding,
    );
    expect((await f.store.list({}, USER)).releases).toHaveLength(1);
  });

  test("a repository removed after enumeration cannot produce a successful partial catalog", async () => {
    const f = await published();
    await f.seed("public/another");
    const other = await f.store.publish({ ...f.input, repository: "public/another" }, SUPER);
    let changed = false;
    const reader = new SpackMaterialCatalogReader(f.root, {
      getManifest: async (id, digest, options) => {
        if (!changed) {
          changed = true;
          const removed =
            id === f.binding.repositoryId ? other.repositoryId : f.binding.repositoryId;
          await rename(join(f.root, "manifests", removed), join(f.root, "removed-repository"));
        }
        return f.store.getManifest(id, digest, options);
      },
      authorizeManifest: f.store.authorizeManifest.bind(f.store),
    });
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 500 });
  });
});

describe("catalog resource budgets", () => {
  test.each([
    "symlink",
    "larger",
    "directory",
  ])("rejects a %s replacement between scan and read", async (replacement) => {
    const f = await published();
    const directory = join(f.root, "manifests", f.binding.repositoryId);
    const path = join(directory, `${f.binding.manifestDigest.slice(7)}.json`);
    const original = await readFile(path);
    const target = join(f.root, "replaced.json");
    await writeFile(
      target,
      replacement === "larger" ? Buffer.concat([original, original]) : original,
    );
    const getManifest = async (
      id: string,
      digest: string,
      options?: MaterialMetadataReadOptions,
    ) => {
      if (replacement === "directory") {
        const moved = join(f.root, "moved-repository");
        await rename(directory, moved);
        await symlink(moved, directory);
      } else {
        await rm(path);
        if (replacement === "symlink") await symlink(target, path);
        else await writeFile(path, Buffer.concat([original, original]));
      }
      return f.store.getManifest(id, digest, options);
    };
    const reader = new SpackMaterialCatalogReader(
      f.root,
      { getManifest, authorizeManifest: f.store.authorizeManifest.bind(f.store) },
      { maxMetadataBytes: original.byteLength },
    );
    await expect(reader.list({}, USER)).rejects.toMatchObject({
      status: replacement === "larger" ? 503 : 500,
    });
  });

  test("cancellation after a pending recipe lookup prevents all subsequent lookups", async () => {
    const f = await published();
    const controller = new AbortController();
    const reason = new Error("cancel during recipe lookup");
    const { manifest } = await f.store.getManifest(
      f.binding.repositoryId,
      f.binding.manifestDigest,
    );
    const first = manifest.recipes[0];
    if (!first) throw new Error("Missing recipe fixture");
    const changed = { ...manifest, recipes: [first, first, first] };
    const bytes = new TextEncoder().encode(JSON.stringify(changed));
    await writeFile(
      join(f.root, "manifests", f.binding.repositoryId, `${materialDigest(bytes).slice(7)}.json`),
      bytes,
    );
    await rm(
      join(
        f.root,
        "manifests",
        f.binding.repositoryId,
        `${f.binding.manifestDigest.slice(7)}.json`,
      ),
    );
    f.recipes.get.mockClear();
    f.recipes.get.mockImplementation(async () => {
      controller.abort(reason);
      await Bun.sleep(1);
      return f.recipe;
    });
    await expect(f.store.list({}, USER, controller.signal)).rejects.toBe(reason);
    expect(f.recipes.get).toHaveBeenCalledTimes(1);
  });

  test("bounds raw directory entries, including ignored staging filenames", async () => {
    const f = await published();
    const reader = new SpackMaterialCatalogReader(f.root, f.store, { maxEntries: 1 });
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 503 });
    // Filtering avoids the top-level directory entry and can complete within the same budget.
    expect((await reader.list({ repository: "public/materials" }, USER)).releases).toHaveLength(1);
    await writeFile(join(f.root, "manifests", f.binding.repositoryId, "ignored.tmp"), "");
    await expect(reader.list({ repository: "public/materials" }, USER)).rejects.toMatchObject({
      status: 503,
    });
  });

  test("checks the metadata byte budget on the actual open handle before reading", async () => {
    const f = await published();
    const getManifest = mock(f.store.getManifest.bind(f.store));
    const reader = new SpackMaterialCatalogReader(
      f.root,
      { getManifest, authorizeManifest: f.store.authorizeManifest.bind(f.store) },
      { maxMetadataBytes: 1 },
    );
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 503 });
    expect(getManifest).toHaveBeenCalledTimes(1);
    expect(getManifest.mock.calls[0]?.[2]?.checkSize).toBeFunction();
  });

  test("does not return a silently truncated list when the response limit is reached", async () => {
    const f = await published();
    await f.seed("public/another");
    await f.store.publish({ ...f.input, repository: "public/another" }, SUPER);
    const reader = new SpackMaterialCatalogReader(f.root, f.store, { maxReleases: 1 });
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 503 });
    expect((await reader.list({ repository: "public/materials" }, USER)).releases).toHaveLength(1);
  });

  test("the production 200-item response bound rejects the 201st authorized manifest", async () => {
    const f = await published();
    const { manifest } = await f.store.getManifest(
      f.binding.repositoryId,
      f.binding.manifestDigest,
    );
    for (let index = 0; index < 200; index++) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...manifest,
          sources: [{ path: `source-${index}.tar.gz`, blob: SOURCE_BLOB }],
        }),
      );
      await writeFile(
        join(f.root, "manifests", f.binding.repositoryId, `${materialDigest(bytes).slice(7)}.json`),
        bytes,
      );
    }
    f.recipes.get.mockClear();
    await expect(f.store.list({}, USER)).rejects.toMatchObject({ status: 503 });
    expect(f.recipes.get).toHaveBeenCalledTimes(201);
    expect(
      await f.store.getManifest(f.binding.repositoryId, f.binding.manifestDigest),
    ).toMatchObject({
      manifest,
    });
  });

  test("cancellation during authorization discards results and releases concurrency capacity", async () => {
    const f = await published();
    const controller = new AbortController();
    const reason = new Error("caller left");
    const authorizeManifest = mock(async () => controller.abort(reason));
    const reader = new SpackMaterialCatalogReader(
      f.root,
      { getManifest: f.store.getManifest.bind(f.store), authorizeManifest },
      { maxConcurrent: 1 },
    );
    await expect(reader.list({}, USER, controller.signal)).rejects.toBe(reason);
    authorizeManifest.mockImplementation(async () => {});
    expect((await reader.list({}, USER)).releases).toHaveLength(1);
  });

  test("limits concurrent scans until their pending I/O has actually settled", async () => {
    const f = await published();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = new SpackMaterialCatalogReader(
      f.root,
      {
        getManifest: f.store.getManifest.bind(f.store),
        authorizeManifest: async () => {
          entered();
          await blocked;
        },
      },
      { maxConcurrent: 1 },
    );
    const pending = reader.list({}, USER);
    await enteredPromise;
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 429 });
    release();
    expect((await pending).releases).toHaveLength(1);
    expect((await reader.list({}, USER)).releases).toHaveLength(1);
  });

  test("rejects after a cooperative deadline even if a slow authorization succeeds", async () => {
    const f = await published();
    const reader = new SpackMaterialCatalogReader(
      f.root,
      {
        getManifest: f.store.getManifest.bind(f.store),
        authorizeManifest: async () => {
          await Bun.sleep(30);
        },
      },
      { timeoutMs: 20 },
    );
    await expect(reader.list({}, USER)).rejects.toMatchObject({ status: 503 });
  });

  test("rejects invalid limits instead of disabling budgets", async () => {
    const f = await published();
    for (const limits of [{ maxConcurrent: 0 }, { maxEntries: Infinity }, { maxReleases: 201 }]) {
      expect(() => new SpackMaterialCatalogReader(f.root, f.store, limits)).toThrow();
    }
  });
});
