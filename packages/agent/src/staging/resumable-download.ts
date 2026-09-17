import { createHash, type Hash } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  const http = opts.http ?? createDefaultHttpClient();
  const sidecarPath = `${opts.localPath}${SIDECAR_SUFFIX}`;
  await mkdir(dirname(opts.localPath), { recursive: true });

  let offset = 0;
  const hash = createHash("sha256");
  const resumed = await resumeFrom(sidecarPath, opts);
  if (resumed) {
    offset = resumed;
    await rehashPrefix(opts.localPath, offset, hash);
  } else {
    await writeFile(opts.localPath, Buffer.alloc(0)); // truncate any stale partial
  }

  const fh = await open(opts.localPath, resumed ? "r+" : "w");
  try {
    while (offset < opts.size) {
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
      await fh.write(chunk, 0, chunk.length, offset);
      hash.update(chunk);
      offset += chunk.length;
      await writeFile(
        sidecarPath,
        JSON.stringify({
          version: 1,
          size: opts.size,
          sha256: opts.sha256,
          bytesWritten: offset,
        } satisfies DownloadSidecar),
      );
    }
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
  const buf = await readFile(path);
  hash.update(buf.subarray(0, length));
}
