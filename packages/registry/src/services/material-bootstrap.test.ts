import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SpackMaterialImport } from "@kuintessence/shared";
import {
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import { USER } from "../routes/spack-repositories.test-helpers";
import { bootstrapSpackMaterials } from "./material-bootstrap";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

async function fixture() {
  const f = await materialFixture();
  const root = await realpath(f.root);
  const packRoot = join(root, "imports");
  await mkdir(packRoot);
  const manifestPath = join(packRoot, "materials.json");
  const sourcePath = join(packRoot, "source.tar.gz");
  await writeFile(sourcePath, SOURCE);
  await writeFile(join(packRoot, "root.lock"), LOCK);
  const pack: SpackMaterialImport = {
    version: 1,
    files: [
      { path: "source.tar.gz", blob: SOURCE_BLOB },
      { path: "root.lock", blob: LOCK_BLOB },
    ],
    releases: [f.input],
  };
  const save = async () => writeFile(manifestPath, JSON.stringify(pack));
  await save();
  return { ...f, packRoot, manifestPath, sourcePath, pack, save };
}

describe("material bootstrap", () => {
  test("imports local blobs, publishes immutable bindings and revalidates on restart", async () => {
    const f = await fixture();
    const results = await bootstrapSpackMaterials(f.store, f.manifestPath);
    const result = results[0];
    expect(result?.status).toBe("published");
    if (result?.status !== "published") throw new Error("Missing published release");
    const restarted = new SpackMaterialStore(f.root, f.recipes);
    expect(await bootstrapSpackMaterials(restarted, f.manifestPath)).toEqual(results);
    const { manifest } = await restarted.getManifest(
      result.binding.repositoryId,
      result.binding.manifestDigest,
    );
    expect(manifest.spec).toBe(f.input.spec);
    const downloaded = await restarted.getBlob(
      result.binding.repositoryId,
      result.binding.manifestDigest,
      SOURCE_BLOB.digest,
      USER,
    );
    expect(await new Response(downloaded.stream).arrayBuffer()).toEqual(SOURCE.buffer);
    expect(await readFile(f.sourcePath)).toEqual(Buffer.from(SOURCE));
  });

  test("reports release failures without erasing successful releases or skipping later ones", async () => {
    const f = await fixture();
    f.pack.releases = [
      { ...f.input, spec: "wrong@1.0" },
      f.input,
      { ...f.input, repository: `${f.input.repository}-other` },
    ];
    await f.save();
    const results = await bootstrapSpackMaterials(f.store, f.manifestPath);
    expect(results.map((result) => result.status)).toEqual(["failed", "published", "published"]);
    expect(results[0]).toMatchObject({ spec: "wrong@1.0", error: "material-import-failed" });
    expect(f.recipes.archive).toHaveBeenCalledTimes(2);
  });

  test("does not widen private recipe visibility through bootstrap's operator principal", async () => {
    const f = await fixture();
    f.recipe.repository = "user/private/recipes";
    f.pack.releases[0] = { ...f.input, repository: "public/materials" };
    await f.save();
    expect((await bootstrapSpackMaterials(f.store, f.manifestPath))[0]?.status).toBe("failed");
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    "missing",
    "size",
    "symlink",
    "hardlink",
    "directory",
    "writable",
    "escape",
  ] as const)("validates all file layouts before uploading: %s", async (kind) => {
    const f = await fixture();
    const upload = spyOn(f.store, "upload");
    if (kind === "missing") await rm(f.sourcePath);
    if (kind === "size") await writeFile(f.sourcePath, "short");
    if (kind === "directory") {
      await rm(f.sourcePath);
      await mkdir(f.sourcePath);
    }
    if (kind === "writable") await chmod(f.sourcePath, 0o666);
    if (kind === "symlink" || kind === "hardlink") {
      const outside = join(await realpath(f.root), "outside");
      await writeFile(outside, SOURCE);
      await rm(f.sourcePath);
      if (kind === "symlink") await symlink(outside, f.sourcePath);
      else await link(outside, f.sourcePath);
    }
    if (kind === "escape") {
      const file = f.pack.files[0];
      if (!file) throw new Error("Missing fixture");
      file.path = "../outside";
      await f.save();
    }
    await expect(bootstrapSpackMaterials(f.store, f.manifestPath)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });

  test("rejects malformed, oversized and symlinked manifests before uploads", async () => {
    const f = await fixture();
    const upload = spyOn(f.store, "upload");
    for (const text of ["not JSON", " ".repeat(2 * 1024 ** 2 + 1)]) {
      await writeFile(f.manifestPath, text);
      await expect(bootstrapSpackMaterials(f.store, f.manifestPath)).rejects.toThrow();
    }
    const outside = join(await realpath(f.root), "outside.json");
    await writeFile(outside, JSON.stringify(f.pack));
    await rm(f.manifestPath);
    await symlink(outside, f.manifestPath);
    await expect(bootstrapSpackMaterials(f.store, f.manifestPath)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });

  test("detects same-size content corruption and only deduplicates verified namespace receipts", async () => {
    const f = await fixture();
    f.pack.releases = [f.input, { ...f.input, target: "linux-other-x86_64" }];
    await f.save();
    const upload = spyOn(f.store, "upload");
    expect(
      (await bootstrapSpackMaterials(f.store, f.manifestPath)).map((result) => result.status),
    ).toEqual(["published", "failed"]);
    expect(upload).toHaveBeenCalledTimes(2);
    await writeFile(f.sourcePath, new Uint8Array(SOURCE.byteLength));
    expect(
      (await bootstrapSpackMaterials(f.store, f.manifestPath)).every(
        (result) => result.status === "failed",
      ),
    ).toBe(true);
  });

  test("aborts before upload or between files without publishing", async () => {
    const f = await fixture();
    await expect(
      bootstrapSpackMaterials(f.store, f.manifestPath, AbortSignal.abort()),
    ).rejects.toThrow();
    const controller = new AbortController();
    const original = f.store.upload.bind(f.store);
    const upload = spyOn(f.store, "upload").mockImplementation(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    await expect(
      bootstrapSpackMaterials(f.store, f.manifestPath, controller.signal),
    ).rejects.toThrow();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("rechecks files replaced after layout validation and does not publish", async () => {
    const f = await fixture();
    const original = f.store.upload.bind(f.store);
    const upload = spyOn(f.store, "upload").mockImplementation(async (...args) => {
      const result = await original(...args);
      await rm(f.sourcePath);
      await symlink(join(f.packRoot, "root.lock"), f.sourcePath);
      return result;
    });
    expect((await bootstrapSpackMaterials(f.store, f.manifestPath))[0]?.status).toBe("failed");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("does not publish when upload returns an inconsistent binding", async () => {
    const f = await fixture();
    spyOn(f.store, "upload").mockImplementation(async (_repository, _digest, stream) => {
      await new Response(stream).arrayBuffer();
      return SOURCE_BLOB;
    });
    expect((await bootstrapSpackMaterials(f.store, f.manifestPath))[0]?.status).toBe("failed");
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    "recipe-check",
    "archive-open",
    "archive-read",
  ] as const)("does not commit a release canceled during publication: %s", async (stage) => {
    const f = await fixture();
    const controller = new AbortController();
    const originalArchive = f.recipes.archive;
    if (stage === "recipe-check") {
      f.recipes.get.mockImplementation(async () => {
        controller.abort();
        return f.recipe;
      });
    } else {
      const archive = await originalArchive(f.recipe.id, f.input.recipes[0]?.commit ?? "");
      const bytes = new Uint8Array(await new Response(archive.stream).arrayBuffer());
      f.recipes.archive.mockImplementation(async () => {
        if (stage === "archive-open") controller.abort();
        return {
          size: bytes.byteLength,
          stream: new ReadableStream<Uint8Array>(
            {
              pull(stream) {
                if (stage === "archive-read") controller.abort();
                stream.enqueue(bytes);
                stream.close();
              },
            },
            { highWaterMark: 0 },
          ),
        };
      });
      f.recipes.archive.mockClear();
    }
    await expect(
      bootstrapSpackMaterials(f.store, f.manifestPath, controller.signal),
    ).rejects.toThrow();
    expect((await readdir(f.root)).includes("manifests")).toBe(false);
    if (stage === "recipe-check") expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test("cancellation after a committed release is not reported as a successful batch", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = f.store.publish.bind(f.store);
    const publish = spyOn(f.store, "publish").mockImplementation(async (...args) => {
      const binding = await original(...args);
      controller.abort();
      return binding;
    });
    await expect(
      bootstrapSpackMaterials(f.store, f.manifestPath, controller.signal),
    ).rejects.toThrow();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await readdir(f.root)).includes("manifests")).toBe(true);
    publish.mockRestore();
    expect((await bootstrapSpackMaterials(f.store, f.manifestPath))[0]?.status).toBe("published");
  });
});
