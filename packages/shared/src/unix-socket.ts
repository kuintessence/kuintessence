import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";

/** Serialize stale-socket removal and binding; the callback must finish setting permissions. */
export async function withPrivateUnixSocketStartup<T>(path: string, bind: () => Promise<T>) {
  if (!isAbsolute(path)) throw new Error("Unix socket path must be absolute");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Unix socket directory must be private (0700), owned by the process UID");
  // Other platforms retain bind's refusal to replace existing paths.
  if (process.platform !== "linux") return bind();
  const lock = await open(
    `${path}.lock`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
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
      throw new Error("Unix socket startup lock must be a private owned file");
    // flock on an inherited descriptor stays held by our open file description after child exit.
    // Keep the lock inode: unlike network-local locks, it also serializes containers sharing a volume.
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
      timeout: 2000,
    });
    if (result.status === 1) throw new Error("Unix socket startup is already in progress");
    if (result.error || result.status !== 0)
      throw new Error("Unix socket startup requires working util-linux flock");
    await removeStaleSocket(path);
    return await bind();
  } finally {
    await lock.close();
  }
}

async function removeStaleSocket(path: string) {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!before) return;
  if (!before.isSocket() || before.uid !== process.getuid?.())
    throw new Error("Unix socket path must be a socket owned by the process UID");
  await new Promise<void>((resolve, reject) => {
    const peer = createConnection(path);
    peer.once("connect", () => {
      peer.destroy();
      reject(new Error("Unix socket already has an active listener"));
    });
    peer.once("error", (error: NodeJS.ErrnoException) => {
      peer.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
    peer.setTimeout(1000, () => {
      peer.destroy();
      reject(new Error("Unix socket liveness check timed out"));
    });
  });
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isSocket())
    throw new Error("Unix socket changed during startup");
  await unlink(path);
}
