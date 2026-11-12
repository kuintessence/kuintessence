import { createHash, type Hash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertStorageCapacity, normalizeStorageCapacityError } from "../storage-capacity";
import { createDefaultHttpClient, type HttpClient } from "./http-client";

/**
 * Resumable download of a presigned-GET object into a local file, fetched in
 * `window`-sized HTTP Range requests so memory stays bounded regardless of
 * object size. A sidecar (`<localPath>.netdrive-download.json`) records how
 * many bytes have been written; on resume the existing on-disk prefix is
 * re-hashed to restore the running SHA-256, then the download continues.
 */
export interface ResumableDownloadOptions {
  downloadUrl: string;
  localPath: string;
  size: number;
  sha256: string;
  /** Bytes per Range request. */
  window: number;
  http?: HttpClient;
}

export interface ResumableDownloadResult {
  localPath: string;
  size: number;
  sha256: string;
}

interface DownloadSidecar {
  version: 1;
  size: number;
  sha256: string;
  bytesWritten: number;
}

const SIDECAR_SUFFIX = ".netdrive-download.json";

export async function resumableDownload(
  opts: ResumableDownloadOptions,
): Promise<ResumableDownloadResult> {
  if (!Number.isSafeInteger(opts.size) || opts.size < 0)
    throw new Error("STORAGE_CAPACITY_INVALID");
  const http = opts.http ?? createDefaultHttpClient();
  const sidecarPath = `${opts.localPath}${SIDECAR_SUFFIX}`;
  await assertStorageCapacity({
    path: dirname(opts.localPath),
    additionalBytes: 0,
    additionalInodes: 3,
  });
  await mkdir(dirname(opts.localPath), { recursive: true });

  let offset = 0;
  const hash = createHash("sha256");
  const resumed = await resumeFrom(sidecarPath, opts);
  if (resumed) {
    offset = resumed;
    await rehashPrefix(opts.localPath, offset, hash);
  } else {
    await assertStorageCapacity({
      path: dirname(opts.localPath),
      additionalBytes: opts.size,
      additionalInodes: 2,
    });
    await writeFile(opts.localPath, Buffer.alloc(0)); // truncate any stale partial
  }

  const fh = await open(opts.localPath, resumed ? "r+" : "w");
  try {
    // Discard unacknowledged tail bytes, retaining only the rehashed prefix.
    await fh.truncate(offset);
    const checkpoint = async () => {
      await fh.sync();
      await saveCheckpoint(sidecarPath, {
        version: 1,
        size: opts.size,
        sha256: opts.sha256,
        bytesWritten: offset,
      });
    };
    await checkpoint();
    while (offset < opts.size) {
      await assertStorageCapacity({
        path: opts.localPath,
        additionalBytes: opts.size - offset,
        additionalInodes: 1,
      });
      const end = Math.min(offset + opts.window, opts.size) - 1;
      const res = await http({
        method: "GET",
        url: opts.downloadUrl,
        headers: { Range: `bytes=${offset}-${end}` },
      });
      if (!res.ok) {
        throw new Error(`Resumable download: Range ${offset}-${end} → HTTP ${res.status}`);
      }
      const chunk = Buffer.from(await res.arrayBuffer());
      if (chunk.length === 0) break;
      const previous = offset;
      let written = 0;
      try {
        while (written < chunk.length) {
          const { bytesWritten } = await fh.write(chunk, written, chunk.length - written, offset);
          if (
            !Number.isInteger(bytesWritten) ||
            bytesWritten <= 0 ||
            bytesWritten > chunk.length - written
          )
            throw new Error("Resumable download: file write made no progress");
          hash.update(chunk.subarray(written, written + bytesWritten));
          written += bytesWritten;
          offset += bytesWritten;
        }
      } finally {
        // A later short write/ENOSPC must not forget bytes already written successfully.
        if (offset > previous) await checkpoint();
      }
    }
  } catch (error) {
    throw normalizeStorageCapacityError(error);
  } finally {
    await fh.close();
  }

  if (offset !== opts.size) {
    throw new Error(`Resumable download: wrote ${offset} bytes, expected ${opts.size}`);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== opts.sha256.toLowerCase()) {
    throw new Error(`Resumable download: sha256 mismatch — expected ${opts.sha256}, got ${actual}`);
  }
  await rm(sidecarPath, { force: true });
  return { localPath: opts.localPath, size: opts.size, sha256: actual };
}

/** Returns the byte offset to resume from, or null to start fresh. */
async function resumeFrom(
  sidecarPath: string,
  opts: ResumableDownloadOptions,
): Promise<number | null> {
  try {
    const sc = JSON.parse(await readFile(sidecarPath, "utf8")) as DownloadSidecar;
    if (
      sc.version !== 1 ||
      sc.size !== opts.size ||
      !Number.isSafeInteger(sc.bytesWritten) ||
      sc.bytesWritten < 0 ||
      sc.bytesWritten > opts.size ||
      sc.sha256.toLowerCase() !== opts.sha256.toLowerCase()
    ) {
      return null;
    }
    const onDisk = (await stat(opts.localPath)).size;
    // Trust the smaller of sidecar/file to avoid hashing bytes that aren't there.
    return Math.min(sc.bytesWritten, onDisk);
  } catch {
    return null;
  }
}

async function rehashPrefix(path: string, length: number, hash: Hash): Promise<void> {
  if (length <= 0) return;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024));
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, length - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error("Resumable download: prefix ended before checkpoint");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
}

async function saveCheckpoint(path: string, value: DownloadSidecar): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
