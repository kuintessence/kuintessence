import { rm } from "node:fs/promises";

export interface StreamUploadResult {
  size: number;
  sha256: string;
}

export type FilePutter = (
  uploadUrl: string,
  file: ReturnType<typeof Bun.file>,
  contentType: string,
) => Promise<{ ok: boolean; status: number; statusText: string }>;

export interface StreamUploadOptions {
  source: AsyncIterable<Uint8Array>;
  uploadUrl: string;
  /** Temp file the bytes are spooled to (bounded memory). Always removed. */
  tmpPath: string;
  contentType?: string;
  onProgress?: (copiedBytes: number) => void;
  /** Runs after spooling, before the PUT. Throw to abort (e.g. source failed). */
  beforePut?: () => Promise<void>;
  /** Injectable for tests; defaults to a real fetch PUT of Bun.file(tmpPath). */
  put?: FilePutter;
  signal?: AbortSignal;
}

const FLUSH_THRESHOLD = 8 * 1024 * 1024;

const defaultPutter = async (
  uploadUrl: string,
  file: ReturnType<typeof Bun.file>,
  contentType: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; statusText: string }> => {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
    signal,
  });
  return { ok: res.ok, status: res.status, statusText: res.statusText };
};

/**
 * Spool an async byte stream to a temp file (bounded heap), then PUT the file
 * to a presigned URL via `Bun.file(tmpPath)` so Bun streams from disk with a
 * correct Content-Length. A streaming ReadableStream body is rejected by MinIO
 * (411 Length Required), hence the on-disk spool. The temp file is always
 * removed, even on failure.
 */
export async function streamUploadToPresignedUrl(
  opts: StreamUploadOptions,
): Promise<StreamUploadResult> {
  const contentType = opts.contentType ?? "application/octet-stream";
  try {
    throwIfAborted(opts.signal);
    const hasher = new Bun.CryptoHasher("sha256");
    const sink = Bun.file(opts.tmpPath).writer();
    let copied = 0;
    let sinceFlush = 0;
    // Close the sink even if the source iterator throws mid-spool, so a broken
    // pipe / killed producer never leaks an un-ended writer in the daemon.
    try {
      for await (const chunk of opts.source) {
        throwIfAborted(opts.signal);
        hasher.update(chunk);
        sink.write(chunk);
        copied += chunk.byteLength;
        sinceFlush += chunk.byteLength;
        if (sinceFlush >= FLUSH_THRESHOLD) {
          await sink.flush();
          sinceFlush = 0;
        }
        opts.onProgress?.(copied);
      }
    } finally {
      await sink.end();
    }

    if (opts.beforePut) {
      await opts.beforePut();
    }
    throwIfAborted(opts.signal);

    const res = opts.put
      ? await opts.put(opts.uploadUrl, Bun.file(opts.tmpPath), contentType)
      : await defaultPutter(opts.uploadUrl, Bun.file(opts.tmpPath), contentType, opts.signal);
    if (!res.ok) {
      throw new Error(`upload PUT failed: ${res.status} ${res.statusText}`);
    }

    return { size: copied, sha256: hasher.digest("hex") };
  } finally {
    await rm(opts.tmpPath, { force: true });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("TRANSFER_CANCELLED");
}
