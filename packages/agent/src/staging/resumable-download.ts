import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertStorageCapacity, normalizeStorageCapacityError } from "../storage-capacity";
import { createDefaultHttpClient, type HttpClient, type HttpResponse } from "./http-client";

/** Range windows and prefix rehashing both use bounded memory. */
export interface ResumableDownloadOptions {
  downloadUrl: string;
  localPath: string;
  size: number;
  sha256: string;
  window: number;
  http?: HttpClient;
  signal?: AbortSignal;
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
  if (
    !Number.isSafeInteger(opts.size) ||
    opts.size < 0 ||
    !/^[a-f0-9]{64}$/i.test(opts.sha256) ||
    !Number.isSafeInteger(opts.window) ||
    opts.window < 1 ||
    opts.window > 64 * 1024 * 1024
  )
    throw new Error("Invalid bounded download size, window or digest");
  opts.signal?.throwIfAborted();
  const http = opts.http ?? createDefaultHttpClient();
  const sidecarPath = `${opts.localPath}${SIDECAR_SUFFIX}`;
  await assertStorageCapacity({
    path: dirname(opts.localPath),
    additionalBytes: 0,
    additionalInodes: 3,
  });
  await mkdir(dirname(opts.localPath), { recursive: true, mode: 0o700 });
  const fh = await open(
    opts.localPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let actual: string;
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw new Error("Download target must be a regular file");
    const saved = await readSidecar(sidecarPath);
    let offset =
      saved?.version === 1 &&
      saved.size === opts.size &&
      saved.sha256.toLowerCase() === opts.sha256.toLowerCase() &&
      Number.isSafeInteger(saved.bytesWritten) &&
      saved.bytesWritten >= 0 &&
      saved.bytesWritten <= opts.size
        ? Math.min(saved.bytesWritten, stat.size)
        : 0;
    await fh.truncate(offset);
    const prefix = Buffer.alloc(Math.min(64 * 1024, offset));
    for (let at = 0; at < offset; ) {
      opts.signal?.throwIfAborted();
      const { bytesRead } = await fh.read(prefix, 0, Math.min(prefix.length, offset - at), at);
      if (!bytesRead) throw new Error("Partial download changed during prefix verification");
      hash.update(prefix.subarray(0, bytesRead));
      at += bytesRead;
    }
    const checkpoint = async () => {
      await fh.sync();
      await saveSidecar(sidecarPath, {
        version: 1,
        size: opts.size,
        sha256: opts.sha256,
        bytesWritten: offset,
      });
    };
    await checkpoint();
    while (offset < opts.size) {
      opts.signal?.throwIfAborted();
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
        signal: opts.signal,
        redirect: "error",
      });
      const chunk = await readDownloadRange(res, offset, end, opts.size, opts.signal);
      const previous = offset;
      let written = 0;
      try {
        while (written < chunk.length) {
          opts.signal?.throwIfAborted();
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
        if (offset > previous) await checkpoint();
      }
    }
    opts.signal?.throwIfAborted();
    actual = hash.digest("hex");
  } catch (error) {
    throw normalizeStorageCapacityError(error);
  } finally {
    await fh.close();
  }
  if (actual !== opts.sha256.toLowerCase()) {
    await rm(sidecarPath, { force: true });
    await rm(opts.localPath, { force: true });
    throw new Error("Resumable download sha256 mismatch");
  }
  await rm(sidecarPath, { force: true });
  return { localPath: opts.localPath, size: opts.size, sha256: actual };
}

export async function readDownloadRange(
  res: HttpResponse,
  offset: number,
  end: number,
  size: number,
  signal?: AbortSignal,
) {
  const length = end - offset + 1;
  const contentRange = res.headers["content-range"] ?? res.headers["Content-Range"];
  const contentLength = res.headers["content-length"] ?? res.headers["Content-Length"];
  const encoding = res.headers["content-encoding"] ?? res.headers["Content-Encoding"];
  if (
    !res.ok ||
    res.status !== 206 ||
    contentRange !== `bytes ${offset}-${end}/${size}` ||
    (contentLength !== undefined && Number(contentLength) !== length) ||
    (encoding && encoding !== "identity")
  ) {
    await res.body?.cancel();
    throw new Error("Download server did not return the exact unencoded requested range");
  }
  return readBoundedResponse(res, length, signal);
}

export async function readBoundedResponse(
  res: HttpResponse,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  // Injected legacy clients return an already buffered response; real HTTP always exposes its stream.
  if (!res.body) {
    const bytes = Buffer.from(await res.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.length !== length) throw new Error("Download range length mismatch");
    return bytes;
  }
  const reader = res.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const bytes = Buffer.alloc(length);
  let at = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      if (at + chunk.value.length > length)
        throw new Error("Download range exceeds its bounded window");
      bytes.set(chunk.value, at);
      at += chunk.value.length;
    }
    if (at !== length) throw new Error("Download range length mismatch");
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readSidecar(path: string): Promise<DownloadSidecar | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid download checkpoint");
      const saved = JSON.parse(await file.readFile("utf8"));
      if (!saved || typeof saved.sha256 !== "string") return null;
      return saved;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    )
      return null;
    throw error;
  }
}
async function saveSidecar(path: string, value: DownloadSidecar) {
  const temporary = `${path}.${crypto.randomUUID()}`;
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
