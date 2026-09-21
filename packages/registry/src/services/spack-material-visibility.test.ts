import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SpackMaterialCatalogSchema, SpackMaterialManifestSchema } from "@kuintessence/shared";
import { BASE, cleanupMaterials, SOURCE_BLOB } from "../routes/spack-materials.test-helpers";
import { COMMIT, headers, ORG, OTHER_ORG } from "../routes/spack-repositories.test-helpers";
import { RecipeStoreError } from "./recipe-git";
import { materialDigest } from "./spack-material-storage";
import { HIDE, OWNER, READER, visibilityFixture } from "./spack-material-visibility.test-helpers";

afterEach(cleanupMaterials);

describe("visibility immutable identity and recipe snapshots", () => {
  test("uses the stored byte digest, never a reserialized parsed manifest identity", async () => {
    const f = await visibilityFixture();
    const source = join(
      f.root,
      "manifests",
      f.binding.repositoryId,
      `${f.binding.manifestDigest.slice(7)}.json`,
    );
    const original = await readFile(source, "utf8");
    const bytes = Buffer.from(`${JSON.stringify(JSON.parse(original), null, 2)}\n`);
    const binding = { ...f.binding, manifestDigest: materialDigest(bytes) };
    expect(binding.manifestDigest).not.toBe(f.binding.manifestDigest);
    await writeFile(
      join(f.root, "manifests", binding.repositoryId, `${binding.manifestDigest.slice(7)}.json`),
      bytes,
    );
    const path = `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
    const allowed = await f.app.request(path, { headers: headers(OWNER) });
    expect(allowed.status).toBe(200);
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(f.port.assertReadable).toHaveBeenLastCalledWith(
      binding,
      OWNER.sub,
      expect.any(Function),
      expect.any(Function),
    );
    const update = await f.app.request(`${path}/visibility`, {
      method: "POST",
      headers: headers(OWNER),
      body: JSON.stringify(HIDE),
    });
    expect(update.status).toBe(200);
    for (const target of [path, `${path}/blobs/${SOURCE_BLOB.digest}`]) {
      expect((await f.app.request(target, { headers: headers(OWNER) })).status).toBe(404);
    }
    const catalog = await f.app.request(BASE, { headers: headers(OWNER) });
    expect(catalog.status).toBe(200);
    expect(SpackMaterialCatalogSchema.parse(await catalog.json()).releases).toMatchObject([
      f.binding,
    ]);
    expect((await f.app.request(f.path, { headers: headers(OWNER) })).status).toBe(200);
  });

  test("ordinary authorization without an explicit binding fails closed with a visibility port", async () => {
    const f = await visibilityFixture();
    const { manifest } = await f.store.getManifest(
      f.binding.repositoryId,
      f.binding.manifestDigest,
    );
    await expect(f.store.authorizeManifest(manifest, OWNER)).rejects.toMatchObject({
      code: "MATERIAL_VISIBILITY_UNAVAILABLE",
      status: 503,
    });
    expect(f.port.assertReadable).not.toHaveBeenCalled();
  });

  test.each([
    "manifest",
    "blob",
    "inspect",
    "transition",
  ] as const)("%s loads exact deduplicated snapshots before the DB callback", async (operation) => {
    const f = await visibilityFixture();
    const bytes = await readFile(
      join(
        f.root,
        "manifests",
        f.binding.repositoryId,
        `${f.binding.manifestDigest.slice(7)}.json`,
      ),
    );
    const manifest = SpackMaterialManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const repeated = Buffer.from(
      JSON.stringify({ ...manifest, recipes: [...manifest.recipes, ...manifest.recipes] }),
    );
    const binding = { ...f.binding, manifestDigest: materialDigest(repeated) };
    await writeFile(
      join(f.root, "manifests", binding.repositoryId, `${binding.manifestDigest.slice(7)}.json`),
      repeated,
    );
    const path = `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
    f.recipes.get.mockClear();
    f.recipes.getSnapshot.mockClear();
    const snapshot = f.recipe.snapshots[0];
    if (!snapshot) throw new Error("Missing snapshot");
    f.recipes.get.mockImplementation(async () => {
      throw new Error("Full history is forbidden");
    });
    f.recipes.getSnapshot.mockImplementation(async (id, commit, checkpoint) => {
      expect(f.control.inTransaction).toBe(false);
      expect(f.port.assertReadable).not.toHaveBeenCalled();
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
      expect(commit).toBe(COMMIT);
      checkpoint?.();
      return { id, repository: f.recipe.repository, snapshot };
    });
    const suffix =
      operation === "blob"
        ? `/blobs/${SOURCE_BLOB.digest}`
        : operation === "manifest"
          ? ""
          : "/visibility";
    const response = await f.app.request(`${path}${suffix}`, {
      headers: headers(OWNER),
      ...(operation === "transition" ? { method: "POST", body: JSON.stringify(HIDE) } : {}),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.recipes.get).not.toHaveBeenCalled();
  });

  test.each([
    "manifest",
    "blob",
    "catalog",
    "inspect",
    "transition",
  ] as const)("%s rejects canonical membership revoked while snapshots are loading", async (operation) => {
    const f = await visibilityFixture(`org/${ORG}/materials`);
    const getSnapshot = f.recipes.getSnapshot.getMockImplementation();
    if (!getSnapshot) throw new Error("Missing snapshot fixture");
    f.recipes.getSnapshot.mockImplementation(async (...args) => {
      const snapshot = await getSnapshot(...args);
      f.control.canonical = { ...OWNER, orgIds: [] };
      return snapshot;
    });
    const management = operation === "inspect" || operation === "transition";
    const path =
      operation === "catalog"
        ? BASE
        : operation === "blob"
          ? `${f.path}/blobs/${SOURCE_BLOB.digest}`
          : management
            ? `${f.path}/visibility`
            : f.path;
    const response = await f.app.request(path, {
      headers: headers(OWNER),
      ...(operation === "transition" ? { method: "POST", body: JSON.stringify(HIDE) } : {}),
    });
    expect(response.status).toBe(operation === "catalog" ? 200 : management ? 403 : 404);
    if (operation === "catalog") {
      expect(SpackMaterialCatalogSchema.parse(await response.json()).releases).toEqual([]);
    }
    expect(f.current(f.binding).revision).toBe(0);
  });

  test.each([
    "namespace",
    "roots",
    "diagnostics",
    "missing",
  ] as const)("referenced recipe %s cannot be bypassed by allowlist or management", async (mode) => {
    const f = await visibilityFixture();
    f.control.canonical = { ...OWNER, role: "super_admin", orgIds: [ORG, OTHER_ORG] };
    if (mode === "namespace") f.recipe.repository = `org/${OTHER_ORG}/recipes`;
    else if (mode === "missing") f.recipe.snapshots = [];
    else {
      const snapshot = f.recipe.snapshots[0];
      if (!snapshot) throw new Error("Missing snapshot");
      if (mode === "roots") snapshot.roots = [];
      else {
        snapshot.diagnostics = [
          { severity: "error", code: "broken", message: "Private recipe detail" },
        ];
      }
    }
    const download = await f.app.request(f.path, { headers: headers(OWNER) });
    expect(download.status).toBe(404);
    const management = await f.app.request(`${f.path}/visibility`, { headers: headers(OWNER) });
    expect(management.status).toBe(403);
    expect(await management.text()).not.toContain("Private recipe detail");
  });

  test("snapshot corruption is unavailable, not a filtered catalog entry", async () => {
    const f = await visibilityFixture();
    f.recipes.getSnapshot.mockImplementation(async () => {
      throw new SyntaxError("private snapshot JSON");
    });
    for (const path of [BASE, f.path, `${f.path}/visibility`]) {
      const response = await f.app.request(path, { headers: headers(OWNER) });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private snapshot JSON");
    }
    expect(f.port.assertReadable).not.toHaveBeenCalled();
  });
});

describe("visibility bounded metadata admission", () => {
  test("deadline exhaustion before canonical admission cannot commit or return a release", async () => {
    const f = await visibilityFixture();
    const getSnapshot = f.recipes.getSnapshot.getMockImplementation();
    if (!getSnapshot) throw new Error("Missing fixture");
    const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      f.recipes.getSnapshot.mockImplementation(async (...args) => {
        const result = await getSnapshot(...args);
        clock.mockReturnValue(1_800_000_010_001);
        return result;
      });
      await expect(
        f.store.manageVisibility(f.binding.repositoryId, f.binding.manifestDigest, OWNER.sub, HIDE),
      ).rejects.toMatchObject({ status: 503, code: "MATERIAL_VISIBILITY_UNAVAILABLE" });
      expect(f.port.transition).not.toHaveBeenCalled();
      expect(f.current(f.binding).revision).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps both slots occupied until cancelled snapshot I/O settles", async () => {
    const f = await visibilityFixture();
    const snapshot = f.recipe.snapshots[0];
    if (!snapshot) throw new Error("Missing snapshot");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    f.recipes.getSnapshot.mockImplementation(async (id) => {
      if (++count === 2) entered.resolve();
      await release.promise;
      return { id, repository: f.recipe.repository, snapshot };
    });
    const controller = new AbortController();
    const read = () =>
      f.store.manageVisibility(
        f.binding.repositoryId,
        f.binding.manifestDigest,
        OWNER.sub,
        undefined,
        undefined,
        controller.signal,
      );
    const pending = Promise.allSettled([read(), read()]);
    try {
      await entered.promise;
      controller.abort();
      await expect(read()).rejects.toMatchObject({ status: 503 });
      expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
    }
    for (const result of await pending) {
      expect(result).toMatchObject({ status: "rejected", reason: { status: 503 } });
    }
    expect(f.port.inspect).not.toHaveBeenCalled();
    const restored = await f.store.manageVisibility(
      f.binding.repositoryId,
      f.binding.manifestDigest,
      OWNER.sub,
    );
    expect(restored.revision).toBe(0);
  });

  test.each([
    "before",
    "snapshot",
    "canonical",
  ] as const)("cancellation at %s cannot commit a policy", async (phase) => {
    const f = await visibilityFixture();
    const controller = new AbortController();
    const getSnapshot = f.recipes.getSnapshot.getMockImplementation();
    const transition = f.port.transition.getMockImplementation();
    if (!getSnapshot || !transition) throw new Error("Missing fixture");
    if (phase === "before") controller.abort();
    if (phase === "snapshot") {
      f.recipes.getSnapshot.mockImplementation(async (...args) => {
        const result = await getSnapshot(...args);
        controller.abort();
        return result;
      });
    }
    if (phase === "canonical") {
      f.port.transition.mockImplementation(async (...args) => {
        controller.abort();
        return transition(...args);
      });
    }
    await expect(
      f.store.manageVisibility(
        f.binding.repositoryId,
        f.binding.manifestDigest,
        OWNER.sub,
        HIDE,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.current(f.binding).revision).toBe(0);
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  });

  test("a missing snapshot is hidden but an unavailable snapshot is never hidden", async () => {
    const f = await visibilityFixture();
    f.control.canonical = READER;
    for (const status of [404, 503] as const) {
      f.recipes.getSnapshot.mockImplementation(async () => {
        throw new RecipeStoreError(status, "Private recipe diagnostic");
      });
      const response = await f.app.request(BASE, { headers: headers(READER) });
      expect(response.status).toBe(status === 404 ? 200 : 503);
      expect(await response.text()).not.toContain("Private recipe diagnostic");
    }
  });
});
