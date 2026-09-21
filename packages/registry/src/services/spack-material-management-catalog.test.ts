import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupMaterials } from "../routes/spack-materials.test-helpers";
import { OTHER_ORG } from "../routes/spack-repositories.test-helpers";
import { RecipeStoreError } from "./recipe-git";
import {
  ACTOR,
  CURSOR_SECRET,
  managementFixture,
  QUERY,
} from "./spack-material-management.test-helpers";
import { SpackMaterialManagementCatalogReader } from "./spack-material-management-catalog";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

describe("maintainer catalog pagination and authorization", () => {
  test("paginates deterministically and survives a reader restart with the same signing key", async () => {
    const f = await managementFixture(3);
    const first = await f.list({ ...QUERY, limit: 1 });
    expect(first.releases).toHaveLength(1);
    expect(first.nextCursor).toBeString();
    if (!first.nextCursor) throw new Error("Missing continuation");
    const restarted = new SpackMaterialStore(f.root, f.recipes, {}, undefined, f.port);
    const second = await restarted.listManaged(
      { ...QUERY, limit: 1, after: first.nextCursor },
      ACTOR.sub,
      { cursorSecret: CURSOR_SECRET },
    );
    if (!second.nextCursor) throw new Error("Missing continuation");
    const third = await f.list({ ...QUERY, limit: 1, after: second.nextCursor });
    expect(third.nextCursor).toBeNull();
    expect(
      [...first.releases, ...second.releases, ...third.releases].map(
        (value) => value.manifestDigest,
      ),
    ).toEqual(f.bindings.map((binding) => binding.manifestDigest));
    expect(f.recipes.archive).toHaveBeenCalledTimes(3);
  });

  test("an empty filtered page advances without disclosing the skipped binding", async () => {
    const f = await managementFixture(2);
    const second = f.bindings[1];
    if (!second) throw new Error("Missing fixture");
    f.control.withdrawn.add(second.manifestDigest);
    const first = await f.list({ ...QUERY, state: "withdrawn", limit: 1 });
    expect(first.releases).toEqual([]);
    if (!first.nextCursor) throw new Error("Missing continuation");
    for (const binding of f.bindings) {
      expect(first.nextCursor).not.toContain(binding.manifestDigest);
    }
    const next = await f.list({
      ...QUERY,
      state: "withdrawn",
      limit: 1,
      after: first.nextCursor,
    });
    expect(next.releases.map((value) => value.manifestDigest)).toEqual([second.manifestDigest]);
    expect(next.nextCursor).toBeNull();
  });

  test("hides missing or inaccessible recipe snapshots, and refuses snapshot corruption", async () => {
    const f = await managementFixture();
    f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    expect(await f.list()).toEqual({ releases: [], nextCursor: null });
    f.recipes.getSnapshot.mockImplementationOnce(async () => {
      throw new RecipeStoreError(404, "Private missing recipe");
    });
    expect(await f.list()).toEqual({ releases: [], nextCursor: null });
    f.recipes.getSnapshot.mockImplementationOnce(async () => {
      throw new RecipeStoreError(500, "Broken immutable snapshot");
    });
    await expect(f.list()).rejects.toMatchObject({ status: 500 });
  });

  test("loads each distinct snapshot once per page without reading lifecycle histories", async () => {
    const f = await managementFixture(3);
    f.recipes.getSnapshot.mockClear();
    expect((await f.list()).releases).toHaveLength(3);
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.port.inspectCatalog).toHaveBeenCalledTimes(2);
    expect(f.port.inspect).not.toHaveBeenCalled();
  });

  test("a role revoked during disk reads is checked again before returning any result", async () => {
    const f = await managementFixture();
    const getSnapshot = f.recipes.getSnapshot.getMockImplementation();
    if (!getSnapshot) throw new Error("Missing fixture");
    f.recipes.getSnapshot.mockImplementationOnce(async (...args) => {
      const snapshot = await getSnapshot(...args);
      f.control.canonical = { ...ACTOR, role: "user" };
      return snapshot;
    });
    await expect(f.list()).rejects.toMatchObject({ status: 403 });
  });

  test("invalid query and pre-aborted calls do not load recipes", async () => {
    const f = await managementFixture();
    f.recipes.getSnapshot.mockClear();
    await expect(f.list({ ...QUERY, repository: "../private" })).rejects.toMatchObject({
      status: 422,
    });
    const controller = new AbortController();
    controller.abort(new Error("Request cancelled"));
    await expect(f.list(QUERY, controller.signal)).rejects.toThrow("Request cancelled");
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
  });
});

describe("management catalog storage bounds", () => {
  test.each(["root", "repository", "manifest"])("rejects a symlink %s", async (kind) => {
    const f = await managementFixture();
    const binding = f.bindings[0];
    if (!binding) throw new Error("Missing fixture");
    const root = join(f.root, "manifests");
    const directory = join(root, binding.repositoryId);
    const path =
      kind === "root"
        ? root
        : kind === "repository"
          ? directory
          : join(directory, `${binding.manifestDigest.slice(7)}.json`);
    const moved = join(f.root, "moved");
    await rename(path, moved);
    await symlink(moved, path);
    await expect(f.list()).rejects.toMatchObject({ status: 500 });
  });

  test("counts ignored entries and checks open-handle metadata bytes before reading", async () => {
    const f = await managementFixture();
    const binding = f.bindings[0];
    if (!binding) throw new Error("Missing fixture");
    const directory = join(f.root, "manifests", binding.repositoryId);
    await writeFile(join(directory, "staging.tmp"), "");
    const entries = new SpackMaterialManagementCatalogReader(f.root, { maxEntries: 1 });
    await expect(entries.list(QUERY, f.readerPort)).rejects.toMatchObject({ status: 503 });
    const bytes = new SpackMaterialManagementCatalogReader(f.root, { maxMetadataBytes: 1 });
    await expect(bytes.list(QUERY, f.readerPort)).rejects.toMatchObject({ status: 503 });
    expect(f.readerPort.inspect).not.toHaveBeenCalled();
  });

  test("rejects digest corruption without returning a partial page", async () => {
    const f = await managementFixture(2);
    const binding = f.bindings[1];
    if (!binding) throw new Error("Missing fixture");
    const path = join(
      f.root,
      "manifests",
      binding.repositoryId,
      `${binding.manifestDigest.slice(7)}.json`,
    );
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(f.list()).rejects.toMatchObject({ status: 500 });
    expect(f.port.inspectCatalog).toHaveBeenCalledTimes(1);
  });

  test("rejects directory replacement during the final authorization", async () => {
    const f = await managementFixture();
    const binding = f.bindings[0];
    if (!binding) throw new Error("Missing fixture");
    const directory = join(f.root, "manifests", binding.repositoryId);
    const port = {
      ...f.readerPort,
      inspect: async () => {
        await rename(directory, join(f.root, "removed"));
        return [];
      },
    };
    const reader = new SpackMaterialManagementCatalogReader(f.root);
    await expect(reader.list(QUERY, port)).rejects.toMatchObject({ status: 500 });
  });

  test("retains a concurrency slot until cancelled pending I/O settles", async () => {
    const f = await managementFixture();
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = new SpackMaterialManagementCatalogReader(f.root, { maxConcurrent: 1 });
    const controller = new AbortController();
    const port = {
      ...f.readerPort,
      inspect: async () => {
        enter();
        await blocked;
        return [];
      },
    };
    const pending = reader.list(QUERY, port, controller.signal);
    await entered;
    controller.abort(new Error("Caller left"));
    await expect(reader.list(QUERY, f.readerPort)).rejects.toMatchObject({ status: 429 });
    release();
    await expect(pending).rejects.toThrow("Caller left");
    expect((await reader.list(QUERY, f.readerPort)).releases).toHaveLength(1);
  });

  test("a cooperative deadline rejects late success and releases capacity", async () => {
    const f = await managementFixture();
    const reader = new SpackMaterialManagementCatalogReader(f.root, { timeoutMs: 20 });
    const port = {
      ...f.readerPort,
      authorize: mock(async () => {
        await Bun.sleep(40);
      }),
    };
    await expect(reader.list(QUERY, port)).rejects.toMatchObject({ status: 503 });
  });

  test("files removed during a scan do not yield a partial successful response", async () => {
    const f = await managementFixture();
    const binding = f.bindings[0];
    if (!binding) throw new Error("Missing fixture");
    const reader = new SpackMaterialManagementCatalogReader(f.root);
    const port = {
      ...f.readerPort,
      read: async (...args: Parameters<typeof f.readerPort.read>) => {
        await rm(join(f.root, "manifests", binding.repositoryId), { recursive: true });
        return f.readerPort.read(...args);
      },
    };
    await expect(reader.list(QUERY, port)).rejects.toMatchObject({ status: 500 });
  });

  test("rejects invalid budgets", async () => {
    const f = await managementFixture();
    for (const limits of [{ maxEntries: 0 }, { timeoutMs: Infinity }, { maxConcurrent: 3 }]) {
      expect(() => new SpackMaterialManagementCatalogReader(f.root, limits)).toThrow();
    }
  });
});
