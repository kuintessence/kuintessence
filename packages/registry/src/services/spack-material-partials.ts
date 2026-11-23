import { constants } from "node:fs";
import { lstat, open, opendir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { SPACK_MATERIAL_CHUNK_BYTES, type SpackMaterialBlob } from "@kuintessence/shared";
import { withMaterialStorageLock } from "./spack-material-collection";
import {
  consumeMaterialStream,
  ensureMaterialDirectory,
  isMissing,
  materialDigest,
  SpackMaterialError,
  syncDirectory,
} from "./spack-material-storage";

const RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface MaterialUploadChunk {
  offset: number;
  input: ReadableStream<Uint8Array>;
}

// The caller holds a shared root lock. Only collection (exclusive root lock) removes
// session directories, so two processes always lock the same directory inode.
export async function resumeMaterialPartial(
  root: string,
  subject: string,
  repository: string,
  blob: SpackMaterialBlob,
  chunk: MaterialUploadChunk | undefined,
  timeouts: { totalTimeoutMs: number; idleTimeoutMs: number },
  finish: (path: string) => Promise<void>,
) {
  const key = materialDigest(
    Buffer.from(JSON.stringify([subject, repository, blob.digest, blob.size])),
  ).slice(7);
  const directory = join(root, "partials", key);
  if (!chunk || chunk.offset !== 0) {
    try {
      await lstat(directory);
    } catch (error) {
      if (isMissing(error)) return { offset: 0 };
      throw error;
    }
  }
  return withMaterialStorageLock(directory, true, async () => {
    const entries = await readdir(directory);
    const existing = entries[0];
    const offset = existing ? Number(existing.slice(0, -5)) : 0;
    if (
      entries.length > 1 ||
      (existing && existing !== `${offset}.part`) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > blob.size ||
      (offset !== blob.size && offset % SPACK_MATERIAL_CHUNK_BYTES !== 0)
    ) {
      throw new SpackMaterialError(500, "Invalid material upload checkpoint");
    }
    let committed = offset;
    let path = join(directory, `${offset}.part`);
    if (offset < blob.size) {
      if (existing) {
        const info = await lstat(path);
        if (!info.isFile() || info.nlink !== 1)
          throw new SpackMaterialError(500, "Invalid material upload file");
        if (info.size < offset) {
          await rm(path);
          await syncDirectory(directory);
          return { offset: 0 };
        }
      }
      if (!chunk || chunk.offset !== offset) return { offset };
      const length = Math.min(blob.size - offset, SPACK_MATERIAL_CHUNK_BYTES);
      const file = await open(
        path,
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (existing ? 0 : constants.O_CREAT | constants.O_EXCL),
        0o600,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size < offset)
          throw new SpackMaterialError(500, "Truncated material upload checkpoint");
        // After a crash the file may contain an unconfirmed tail.
        if (info.size !== offset) await file.truncate(offset);
        let position = offset;
        const received = await consumeMaterialStream(
          chunk.input,
          { ...timeouts, maxBytes: length },
          async (bytes) => {
            let written = 0;
            while (written < bytes.length) {
              const result = await file.write(bytes, written, bytes.length - written, position);
              if (!result.bytesWritten) throw new SpackMaterialError(500, "Material write stalled");
              written += result.bytesWritten;
              position += result.bytesWritten;
            }
          },
        );
        if (received !== length) throw new SpackMaterialError(400, "Incomplete material chunk");
        await file.sync();
      } finally {
        await file.close();
      }
      committed += length;
      const next = join(directory, `${committed}.part`);
      await rename(path, next);
      await syncDirectory(directory);
      path = next;
      if (committed < blob.size) return { offset: committed };
    }
    try {
      await finish(path);
    } catch (error) {
      if (error instanceof SpackMaterialError && error.status === 422) {
        await rm(path);
        await syncDirectory(directory);
      }
      throw error;
    }
    await rm(path);
    await syncDirectory(directory);
    return blob;
  });
}

// Caller holds the exclusive root lock, including during the lstat and removal.
export async function collectMaterialPartials(root: string) {
  const path = join(root, "partials");
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await ensureMaterialDirectory(path);
  for await (const entry of await opendir(path)) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name))
      throw new SpackMaterialError(500, "Invalid material upload directory");
    const session = join(path, entry.name);
    const files = await readdir(session, { withFileTypes: true });
    if (
      files.length > 1 ||
      files.some((file) => !file.isFile() || !/^(0|[1-9][0-9]{0,10})\.part$/.test(file.name))
    )
      throw new SpackMaterialError(500, "Invalid material upload checkpoint");
    if (files[0]) {
      if ((await lstat(session)).mtimeMs >= Date.now() - RETENTION_MS) continue;
      await rm(join(session, files[0].name));
    }
    await rmdir(session);
  }
}
