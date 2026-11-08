import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportFederationMedia } from "./media-export";
import { importFederationMedia } from "./media-import";
import { mediaImportFixture } from "./media-import-test-fixture";
import { mediaExportFixture } from "./media-test-fixtures";

// Explicit opt-in: run only inside a private mount namespace; each mount is limited to 96 MiB.
const live =
  process.env.KQ_MEDIA_ENOSPC_TEST === "1" && process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
function mount(path: string) {
  if (process.getuid?.() !== 0) throw new Error("Requires root in a private mount namespace");
  if (
    execFileSync("readlink", ["/proc/self/ns/mnt"], { encoding: "utf8" }) ===
    execFileSync("readlink", ["/proc/1/ns/mnt"], { encoding: "utf8" })
  )
    throw new Error("Run this test with unshare --mount --fork --propagation private");
  execFileSync("mount", [
    "-t",
    "tmpfs",
    "-o",
    "size=96m,mode=0700,nodev,nosuid,noexec",
    "tmpfs",
    path,
  ]);
}
async function fill(path: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    const block = Buffer.alloc(1024 * 1024, 0x42);
    for (let i = 0; i < 98; i++) await handle.writeFile(block);
    throw new Error("Isolated filesystem did not fill");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOSPC") throw error;
  } finally {
    await handle.close();
  }
}

live(
  "real export ENOSPC after space preflight cleans partial ciphertext and recovers",
  async () => {
    const f = await mediaExportFixture();
    const volume = join(f.root, "volume");
    let mounted = false;
    try {
      await mkdir(volume, { mode: 0o700 });
      mount(volume);
      mounted = true;
      const filler = join(volume, "owned-filler");
      const options = { ...f.options, mediaDirectory: join(volume, "media") };
      await expect(
        exportFederationMedia({
          ...options,
          age: {
            async *encrypt(...args) {
              let filled = false;
              for await (const bytes of f.age.encrypt(...args)) {
                if (!filled) {
                  await fill(filler);
                  filled = true;
                }
                yield bytes;
              }
            },
          },
        }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      const outbox = join(options.mediaDirectory, "outbox");
      expect(await readdir(outbox)).toEqual([".media-work"]);
      expect(await readdir(join(outbox, ".media-work"))).toEqual(["lock"]);
      await rm(filler);
      const receipt = await exportFederationMedia(options);
      expect(receipt.sizeBytes).toBeGreaterThan(0);
      await fill(filler);
      expect(await exportFederationMedia(options)).toEqual(receipt);
    } finally {
      if (mounted) execFileSync("umount", [volume]);
      await f.cleanup();
    }
  },
  30_000,
);

live(
  "real import ENOSPC after space preflight cleans plaintext and recovers",
  async () => {
    const f = await mediaImportFixture();
    const volume = join(f.root, "receiver-data");
    let mounted = false;
    try {
      mount(volume);
      mounted = true;
      const filler = join(volume, "owned-filler");
      await expect(
        importFederationMedia({
          ...f.options,
          age: {
            async *decrypt(...args) {
              let filled = false;
              for await (const bytes of f.age.decrypt(...args)) {
                // Yield small slices until the real importer has created its quarantine and output file.
                for (let offset = 0; offset < bytes.length; offset += 4096) {
                  if (!filled) {
                    const pending = join(f.parent, ".media-work", "pending");
                    for (const entry of await readdir(pending)) {
                      if (await Bun.file(join(pending, entry, "files", "input.dat")).exists()) {
                        await fill(filler);
                        filled = true;
                      }
                    }
                  }
                  yield bytes.subarray(offset, offset + 4096);
                }
              }
            },
          },
        }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      expect(await readdir(f.parent)).toEqual([".media-work"]);
      expect(await readdir(join(f.parent, ".media-work"))).toEqual(["lock"]);
      await rm(filler);
      expect((await importFederationMedia(f.options)).state).toBe("verified");
      expect(await readFile(join(f.target, "files", "input.dat"))).toEqual(f.bytes);
      await fill(filler);
      expect((await importFederationMedia(f.options)).state).toBe("verified");
    } finally {
      if (mounted) execFileSync("umount", [volume]);
      await f.cleanup();
    }
  },
  30_000,
);
