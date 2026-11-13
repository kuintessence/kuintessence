import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateMediaDirectory } from "./media-archive";

/** Only the lock holder may reclaim unfinished work; completed packages live outside this directory. */
export async function withMediaWorkspace<T>(parent: string, run: (path: string) => Promise<T>) {
  if (process.platform !== "linux") throw new Error("MEDIA_WORKSPACE_PLATFORM_UNSUPPORTED");
  await privateMediaDirectory(parent);
  const workspace = join(parent, ".media-work");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await privateMediaDirectory(workspace);
  const lock = await open(
    join(workspace, "lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await lock.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("MEDIA_WORKSPACE_LOCK_INVALID");
    // The inherited open description retains flock after its child exits. Never unlink this inode.
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
      timeout: 2000,
    });
    if (result.status === 1) throw new Error("MEDIA_WORKSPACE_BUSY");
    if (result.error || result.status !== 0) throw new Error("MEDIA_WORKSPACE_LOCK_UNAVAILABLE");
    const pending = join(workspace, "pending");
    async function clean() {
      try {
        await privateMediaDirectory(pending);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      await rm(pending, { recursive: true, force: true });
    }
    await clean();
    try {
      return await run(pending);
    } finally {
      await clean();
    }
  } finally {
    await lock.close();
  }
}
