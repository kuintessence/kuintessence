import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFederationMedia } from "./media-export";
import { importFederationMedia } from "./media-import";
import { mediaImportFixture } from "./media-import-test-fixture";
import { mediaExportFixture } from "./media-test-fixtures";
import { withMediaWorkspace } from "./media-workspace";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
async function child(input: object) {
  const process = Bun.spawn(
    [Bun.which("bun") ?? "bun", join(import.meta.dir, "media-recovery.fixture.ts")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  process.stdin.write(JSON.stringify(input));
  process.stdin.end();
  const reader = process.stdout.getReader();
  try {
    const message = await reader.read();
    if (message.done) throw new Error(await new Response(process.stderr).text());
    expect(new TextDecoder().decode(message.value).trim()).toBe(Reflect.get(input, "stage"));
    return process;
  } catch (error) {
    process.kill("SIGKILL");
    await process.exited;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

live.each(["partial", "complete"] as const)(
  "export recovers after real SIGKILL at %s without deleting active work or replacing completed ciphertext",
  async (stage) => {
    const f = await mediaExportFixture();
    let worker: Awaited<ReturnType<typeof child>> | undefined;
    try {
      worker = await child({
        mode: "export",
        stage,
        options: f.options,
        roots: {
          datasetRoot: join(f.root, "source"),
          jobWorkRoot: join(f.root, "jobs"),
          managedRoots: { [f.options.task.managedRootId]: "." },
        },
      });
      const outbox = join(f.options.mediaDirectory, "outbox");
      const pending = join(outbox, ".media-work", "pending");
      const completed = join(outbox, f.manifest.packageId, "bundle.age");
      let inode: number | undefined;
      if (stage === "partial") {
        const entries = await readdir(pending);
        expect(entries.length).toBe(1);
        const partial = join(pending, entries[0] ?? "", "bundle.age");
        expect((await stat(partial)).size).toBeGreaterThan(0);
        await expect(exportFederationMedia(f.options)).rejects.toThrow("MEDIA_WORKSPACE_BUSY");
        expect(await readdir(pending)).toEqual(entries);
      } else inode = (await stat(completed)).ino;
      worker.kill("SIGKILL");
      await worker.exited;
      const recovered = await exportFederationMedia(f.options);
      expect(recovered.sizeBytes).toBe((await stat(completed)).size);
      expect(await readdir(join(outbox, ".media-work"))).toEqual(["lock"]);
      if (inode) expect((await stat(completed)).ino).toBe(inode);
    } finally {
      worker?.kill("SIGKILL");
      await worker?.exited;
      await f.cleanup();
    }
  },
  30_000,
);

live.each(["partial", "complete"] as const)(
  "import recovers after real SIGKILL at %s and rechecks current authorization",
  async (stage) => {
    const f = await mediaImportFixture();
    let worker: Awaited<ReturnType<typeof child>> | undefined;
    try {
      worker = await child({
        mode: "import",
        stage,
        options: f.options,
        privateKey: await crypto.subtle.exportKey("jwk", f.options.privateKey),
        grant: await f.options.authorize(),
        roots: {
          datasetRoot: join(f.root, "receiver-data"),
          jobWorkRoot: join(f.root, "receiver-jobs"),
          managedRoots: { [f.options.task.managedRootId]: "." },
        },
      });
      const pending = join(f.parent, ".media-work", "pending");
      const completed = join(f.target, "files", "input.dat");
      let inode: number | undefined;
      if (stage === "partial") {
        const entries = await readdir(pending);
        expect(entries.length).toBe(1);
        const partial = join(pending, entries[0] ?? "", "files", "input.dat");
        expect((await stat(partial)).size).toBeGreaterThan(0);
        await expect(importFederationMedia(f.options)).rejects.toThrow("MEDIA_WORKSPACE_BUSY");
        expect(await readdir(pending)).toEqual(entries);
      } else {
        inode = (await stat(completed)).ino;
        await rm(f.cipher);
      }
      worker.kill("SIGKILL");
      await worker.exited;
      await expect(
        importFederationMedia({
          ...f.options,
          authorize: async () => {
            throw new Error("revoked");
          },
        }),
      ).rejects.toThrow("revoked");
      expect(await readdir(join(f.parent, ".media-work"))).toEqual(["lock"]);
      expect((await importFederationMedia(f.options)).state).toBe("verified");
      expect(await readFile(completed)).toEqual(f.bytes);
      if (inode) expect((await stat(completed)).ino).toBe(inode);
    } finally {
      worker?.kill("SIGKILL");
      await worker?.exited;
      await f.cleanup();
    }
  },
  30_000,
);

test("workspace refuses unsafe lock/cleanup paths and never follows links into other data", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-media-workspace-"));
  try {
    await withMediaWorkspace(root, async (path) => {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "discard"), "partial");
    });
    const work = join(root, ".media-work");
    const outside = join(root, "completed");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "keep"), "completed");
    await symlink(outside, join(work, "pending"));
    await expect(withMediaWorkspace(root, async () => {})).rejects.toThrow("MEDIA_ROOT_INVALID");
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("completed");
    await rm(join(work, "pending"));
    await mkdir(join(work, "pending"), { mode: 0o700 });
    await symlink(outside, join(work, "pending", "link"));
    await withMediaWorkspace(root, async () => {});
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("completed");
    const lock = join(work, "lock");
    await chmod(lock, 0o644);
    await expect(withMediaWorkspace(root, async () => {})).rejects.toThrow(
      "MEDIA_WORKSPACE_LOCK_INVALID",
    );
    await chmod(lock, 0o600);
    await link(lock, join(root, "linked-lock"));
    await expect(withMediaWorkspace(root, async () => {})).rejects.toThrow(
      "MEDIA_WORKSPACE_LOCK_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
