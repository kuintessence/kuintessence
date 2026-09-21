import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { type SpackMaterialBlob, SpackMaterialDigestSchema } from "@kuintessence/shared";

export interface SpackMaterialCacheRef extends SpackMaterialBlob {
  path: string;
}

export function isSpackCacheDir(value: string): boolean {
  return (
    isAbsolute(value) &&
    value !== parse(value).root &&
    normalize(value) === value &&
    !value.endsWith("/") &&
    !value.includes("\0") &&
    !value.includes("\\")
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isAgentPrivate(stat: Stats): boolean {
  return (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.();
}

function assertPrivateCacheFile(stat: Stats): void {
  if (!isAgentPrivate(stat)) {
    throw new Error(
      "Spack material cache file must be Agent-owned with no group/other permissions",
    );
  }
}

// Walk without recursive mkdir: existing symlink components must never be followed.
async function secureDirectory(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split("/")) {
    current = join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Spack material cache path contains a symlink or non-directory");
    }
    if ((current === path || current === dirname(path)) && !isAgentPrivate(stat)) {
      throw new Error(
        "Spack material cache directory must be Agent-owned with no group/other permissions",
      );
    }
    if (created) await syncDirectory(dirname(current));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SpackMaterialCache {
  private readonly directory: string;

  constructor(cacheDir: string) {
    if (!isSpackCacheDir(cacheDir)) {
      throw new Error("AGENT_SPACK_CACHE_DIR must be a dedicated absolute canonical path");
    }
    this.directory = join(cacheDir, "sha256");
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.directory);
  }

  private path(blob: SpackMaterialBlob): string {
    return join(this.directory, SpackMaterialDigestSchema.parse(blob.digest).slice(7));
  }

  async reuse(blob: SpackMaterialBlob, signal: AbortSignal): Promise<SpackMaterialCacheRef | null> {
    return (await this.readVerified(blob, signal))?.ref ?? null;
  }

  async readMetadata(
    blob: SpackMaterialBlob,
    maximum: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > maximum) {
      throw new Error("Spack cached metadata exceeds the byte limit");
    }
    const result = await this.readVerified(blob, signal, true);
    if (!result?.bytes) throw new Error("Spack cached metadata is missing");
    return result.bytes;
  }

  private async readVerified(
    blob: SpackMaterialBlob,
    signal: AbortSignal,
    collect = false,
  ): Promise<{ ref: SpackMaterialCacheRef; bytes?: Uint8Array } | null> {
    signal.throwIfAborted();
    await secureDirectory(this.directory);
    const path = this.path(blob);
    let entry: Stats;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Spack material cache entry is a symlink or non-regular file");
    }
    assertPrivateCacheFile(entry);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      assertPrivateCacheFile(stat);
      if (
        !stat.isFile() ||
        stat.ino !== entry.ino ||
        stat.dev !== entry.dev ||
        stat.uid !== entry.uid ||
        stat.mode !== entry.mode ||
        stat.size !== blob.size
      ) {
        throw new Error("Spack material cache file identity or size mismatch");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = collect ? new Uint8Array(blob.size) : undefined;
      let total = 0;
      while (true) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > blob.size) throw new Error("Spack material cache size exceeded");
        hash.update(buffer.subarray(0, bytesRead));
        bytes?.set(buffer.subarray(0, bytesRead), total - bytesRead);
      }
      if (total !== blob.size || `sha256:${hash.digest("hex")}` !== blob.digest) {
        throw new Error("Spack material cache SHA-256 or size mismatch");
      }
      for (const final of [await file.stat(), await lstat(path)]) {
        assertPrivateCacheFile(final);
        if (
          !final.isFile() ||
          final.ino !== stat.ino ||
          final.dev !== stat.dev ||
          final.uid !== stat.uid ||
          final.mode !== stat.mode ||
          final.size !== stat.size ||
          final.mtimeMs !== stat.mtimeMs
        ) {
          throw new Error("Spack material cache file identity or mode changed during verification");
        }
      }
      return { ref: { ...blob, path }, bytes };
    } finally {
      await file.close();
    }
  }

  async store(
    blob: SpackMaterialBlob,
    signal: AbortSignal,
    produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  ): Promise<SpackMaterialCacheRef> {
    const cached = await this.reuse(blob, signal);
    if (cached) return cached;
    const path = this.path(blob);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      let total = 0;
      await produce(async (chunk) => {
        signal.throwIfAborted();
        total += chunk.byteLength;
        if (total > blob.size) throw new Error("Spack material blob size exceeded");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal.throwIfAborted();
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Spack material cache write made no progress");
          offset += bytesWritten;
        }
      });
      if (total !== blob.size) throw new Error("Spack material blob size mismatch");
      if (`sha256:${hash.digest("hex")}` !== blob.digest) {
        throw new Error("Spack material blob SHA-256 mismatch");
      }
      signal.throwIfAborted();
      await file.chmod(0o400);
      await file.sync();
      await secureDirectory(this.directory);
      // Hard-link publication is atomic and, unlike rename, cannot overwrite a digest entry.
      try {
        await link(temporary, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existing = await this.reuse(blob, signal);
        if (!existing) throw new Error("Spack material cache publication race");
      }
      await syncDirectory(this.directory);
      await syncDirectory(dirname(this.directory));
      return { ...blob, path };
    } finally {
      try {
        await file.close();
      } finally {
        await unlink(temporary);
      }
    }
  }
}
