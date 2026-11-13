import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Bound reads also reject FIFOs, symlinks and keys writable/readable by another user. */
export async function readStorageFile(path: string, limit = 16384, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > limit ||
      (privateFile && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))
    )
      throw new Error("Invalid storage observer file");
    const buffer = Buffer.alloc(limit + 1);
    const result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > limit) throw new Error("Storage observer file exceeds its limit");
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function syncStorageDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** The caller verifies ownership and permissions of the containing directory. */
export async function writeStorageFile(path: string, contents: string, mode: number) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", mode);
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await syncStorageDirectory(dirname(path));
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}
