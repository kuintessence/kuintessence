import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMaterialImportFile, readMaterialImportManifest } from "./material-import-files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "material-input-")));
  roots.push(root);
  const bytes = new Uint8Array(256 * 1024).fill(42);
  await mkdir(join(root, "files"));
  await writeFile(join(root, "files", "source"), bytes);
  return { root, bytes };
}

describe("bounded material import reader", () => {
  test("reads regular files in bounded chunks and supports early cancellation", async () => {
    const f = await fixture();
    const stream = await openMaterialImportFile(
      f.root,
      "files/source",
      f.bytes.length,
      f.bytes.length,
      AbortSignal.timeout(5000),
    );
    const reader = stream.getReader();
    expect((await reader.read()).value?.length).toBe(64 * 1024);
    await reader.cancel();
    reader.releaseLock();
    const again = await openMaterialImportFile(
      f.root,
      "files/source",
      f.bytes.length,
      f.bytes.length,
      AbortSignal.timeout(5000),
    );
    expect(await new Response(again).arrayBuffer()).toEqual(f.bytes.buffer);
  });

  test.each([
    "content",
    "truncate",
    "extend",
    "replace",
    "parent",
    "abort",
  ] as const)("does not finish a file changed during reading: %s", async (kind) => {
    const f = await fixture();
    const controller = new AbortController();
    const stream = await openMaterialImportFile(
      f.root,
      "files/source",
      f.bytes.length,
      f.bytes.length,
      controller.signal,
    );
    const reader = stream.getReader();
    await reader.read();
    const path = join(f.root, "files", "source");
    if (kind === "content") await writeFile(path, new Uint8Array(f.bytes.length).fill(43));
    if (kind === "truncate") await writeFile(path, "short");
    if (kind === "extend") await writeFile(path, new Uint8Array(f.bytes.length + 1));
    if (kind === "replace") {
      await rm(path);
      await writeFile(path, f.bytes);
    }
    if (kind === "parent") {
      await rename(join(f.root, "files"), join(f.root, "moved"));
      await symlink(join(f.root, "moved"), join(f.root, "files"));
    }
    if (kind === "abort") controller.abort();
    try {
      await expect(
        (async () => {
          while (!(await reader.read()).done) {
            /* Drain fixture. */
          }
        })(),
      ).rejects.toThrow();
    } finally {
      reader.releaseLock();
    }
  });

  test("rejects a writable or symlinked package directory without modifying it", async () => {
    const f = await fixture();
    await chmod(join(f.root, "files"), 0o777);
    await expect(
      openMaterialImportFile(
        f.root,
        "files/source",
        f.bytes.length,
        f.bytes.length,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    await chmod(join(f.root, "files"), 0o755);
    await symlink(join(f.root, "files"), join(f.root, "alias"));
    await expect(
      openMaterialImportFile(
        f.root,
        "alias/source",
        f.bytes.length,
        f.bytes.length,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
  });

  test("rejects empty inputs, size mismatches and file limits before streaming", async () => {
    const f = await fixture();
    for (const [size, maximum] of [
      [f.bytes.length - 1, f.bytes.length],
      [f.bytes.length, f.bytes.length - 1],
    ] as const) {
      await expect(
        openMaterialImportFile(f.root, "files/source", size, maximum, AbortSignal.timeout(5000)),
      ).rejects.toThrow();
    }
    await writeFile(join(f.root, "files", "source"), "");
    await expect(
      openMaterialImportFile(
        f.root,
        "files/source",
        undefined,
        f.bytes.length,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
  });

  test("requires valid UTF-8 JSON within the manifest byte budget", async () => {
    const f = await fixture();
    const path = join(f.root, "manifest.json");
    await writeFile(path, '{"version":1}');
    expect(
      await readMaterialImportManifest(f.root, "manifest.json", 100, AbortSignal.timeout(5000)),
    ).toEqual({ version: 1 });
    for (const bytes of [new Uint8Array([0xff]), Buffer.from("{"), Buffer.from(" ".repeat(101))]) {
      await writeFile(path, bytes);
      await expect(
        readMaterialImportManifest(f.root, "manifest.json", 100, AbortSignal.timeout(5000)),
      ).rejects.toThrow();
    }
  });
});
