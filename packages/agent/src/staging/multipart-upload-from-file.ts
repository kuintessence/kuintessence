import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

export interface MultipartFromFileResult {
  parts: { partNumber: number; etag: string }[];
  sha256: string;
  size: number;
}

export type MultipartFromFileSource =
  | { filePath: string; fileHandle?: never }
  | { fileHandle: FileHandle; filePath?: never };

export type MultipartFromFileOptions = MultipartFromFileSource & {
  /** Exact spooled size in bytes. */
  size: number;
  partSize: number;
  /** Server-backed in prod (sends PartUrlsRequest over connectRPC); a fake in tests. */
  getPartUrls: (partNumbers: number[]) => Promise<{ partNumber: number; url: string }[]>;
  /** Injectable for tests; defaults to a real fetch PUT. Returns the part ETag. */
  put?: (url: string, body: Blob) => Promise<{ ok: boolean; status: number; etag: string }>;
  connectTo?: string;
  /** Retry count per part before failing the multipart upload. */
  maxRetries?: number;
  /** Backoff between retries in ms. */
  retryBackoffMs?: number;
  onProgress?: (copiedBytes: number) => void;
  signal?: AbortSignal;
  /** Refresh source authority while hashing large private files, before reading each bounded chunk. */
  authorizeRead?: () => Promise<void>;
};

const defaultPut = async (
  url: string,
  body: Blob,
  connectTo?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; etag: string }> => {
  const target = rewriteUrlWithConnectTo(url, connectTo);
  const res = await fetch(target.url, {
    method: "PUT",
    body,
    headers: {
      ...(target.hostHeader ? { Host: target.hostHeader } : {}),
      Connection: "close",
      "Content-Length": String(body.size),
      "Content-Type": "application/octet-stream",
    },
    signal,
    redirect: "error",
  });
  return { ok: res.ok, status: res.status, etag: stripQuotes(res.headers.get("etag") ?? "") };
};

/**
 * Upload a spooled local file to MinIO in fixed-size parts. Each part URL is
 * supplied by an injected provider (Server-backed in prod), not fetched via REST —
 * this is the variant used by the agent's connectRPC multipart flow, where the
 * Server mints presigned part URLs over the bidirectional stream. The whole-file
 * sha256 is computed from the part slices in ascending order.
 */
export async function multipartUploadFromFile(
  opts: MultipartFromFileOptions,
): Promise<MultipartFromFileResult> {
  if (
    !Number.isSafeInteger(opts.size) ||
    opts.size < 0 ||
    !Number.isSafeInteger(opts.partSize) ||
    opts.partSize < 1 ||
    opts.partSize > 5 * 1024 * 1024 * 1024
  )
    throw new Error("Invalid bounded multipart size");
  const put = opts.put ?? ((url, body) => defaultPut(url, body, opts.connectTo, opts.signal));
  const maxRetries = opts.maxRetries ?? 2;
  const retryBackoffMs = opts.retryBackoffMs ?? 250;
  const partCount = Math.max(1, Math.ceil(opts.size / opts.partSize));
  if (partCount > 10_000) throw new Error("Multipart upload exceeds the S3 part limit");
  throwIfAborted(opts.signal);

  const hasher = new Bun.CryptoHasher("sha256");
  const parts: { partNumber: number; etag: string }[] = [];
  let copied = 0;

  const fh =
    opts.fileHandle ?? (await open(opts.filePath, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size !== opts.size) throw new Error("Multipart source size changed");
    const buffer = Buffer.alloc(Math.min(64 * 1024, opts.size));
    const source = Bun.file(fh.fd);
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      throwIfAborted(opts.signal);
      const offset = (partNumber - 1) * opts.partSize;
      const len = Math.min(opts.partSize, opts.size - offset);
      const body = source.slice(offset, offset + len);
      let read = 0;
      while (read < len) {
        await opts.authorizeRead?.();
        throwIfAborted(opts.signal);
        const { bytesRead } = await fh.read(
          buffer,
          0,
          Math.min(buffer.length, len - read),
          offset + read,
        );
        if (!bytesRead) throw new Error("Multipart source ended before its declared size");
        hasher.update(buffer.subarray(0, bytesRead));
        read += bytesRead;
      }

      let res: { ok: boolean; status: number; etag: string } | null = null;
      let attempt = 0;
      while (attempt <= maxRetries) {
        throwIfAborted(opts.signal);
        const urls = await opts.getPartUrls([partNumber]);
        const url =
          urls.length === 1 && urls[0]?.partNumber === partNumber ? urls[0].url : undefined;
        if (!url) throw new Error(`no presigned URL for part ${partNumber}`);
        throwIfAborted(opts.signal);
        try {
          res = await put(url, body);
          if (res.ok) {
            break;
          }
          if (attempt >= maxRetries) {
            throw new Error(`upload part ${partNumber} failed: HTTP ${res.status}`);
          }
        } catch (err) {
          if (attempt >= maxRetries) {
            throw new Error(
              `upload part ${partNumber} failed after ${attempt + 1} attempts: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          await abortableSleep(Math.min(2_000, retryBackoffMs * 2 ** attempt), opts.signal);
        }
        attempt += 1;
      }

      if (!res) {
        throw new Error(`upload part ${partNumber} failed: no response`);
      }
      if (!res.ok) {
        throw new Error(`upload part ${partNumber} failed: HTTP ${res.status}`);
      }

      if (!stripQuotes(res.etag)) throw new Error("Multipart upload response has no ETag");
      parts.push({ partNumber, etag: stripQuotes(res.etag) });
      copied += len;
      opts.onProgress?.(copied);
    }
    const final = await fh.stat();
    if (
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs ||
      final.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Multipart source changed while uploading");
  } finally {
    if (!opts.fileHandle) await fh.close();
  }

  parts.sort((a, b) => a.partNumber - b.partNumber);
  return { parts, sha256: hasher.digest("hex"), size: opts.size };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("TRANSFER_CANCELLED");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("TRANSFER_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

export function rewriteUrlWithConnectTo(
  url: string,
  connectTo?: string,
): { url: string; hostHeader?: string } {
  if (!connectTo) return { url };

  const parts = connectTo.split(":");
  if (parts.length !== 4) return { url };

  const [fromHost, fromPort, toHost, toPort] = parts;
  if (!fromHost || !fromPort || !toHost || !toPort) return { url };

  const parsed = new URL(url);
  const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (parsed.hostname !== fromHost || parsedPort !== fromPort) return { url };

  parsed.hostname = toHost;
  parsed.port = toPort;
  return { url: parsed.toString(), hostHeader: `${fromHost}:${fromPort}` };
}
