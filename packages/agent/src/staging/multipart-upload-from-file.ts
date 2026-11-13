import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readSiteTransport, siteFetch } from "@kuintessence/shared/site-transport";
import { z } from "zod";
import { assertStorageCapacity } from "../storage-capacity";

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
  /** Refresh source authority before reading each bounded chunk. */
  authorizeRead?: () => Promise<void>;
  checkpoint?: { path: string; uploadId: string };
  /** Total deadline per PUT attempt, including implementations that ignore cancellation. */
  partTimeoutMs?: number;
};

const defaultPut = async (
  url: string,
  body: Blob,
  connectTo?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; etag: string }> => {
  const target = readSiteTransport() ? { url } : rewriteUrlWithConnectTo(url, connectTo);
  const res = await siteFetch(target.url, {
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
const checkpointWriters = new Map<string, Promise<void>>();

export async function multipartUploadFromFile(
  opts: MultipartFromFileOptions,
): Promise<MultipartFromFileResult> {
  if (!opts.checkpoint) return uploadFromFile(opts);
  const key = resolve(opts.checkpoint.path);
  const previous = checkpointWriters.get(key) ?? Promise.resolve();
  let release = () => {};
  const writer = new Promise<void>((done) => {
    release = done;
  });
  const queued = previous.then(() => writer);
  checkpointWriters.set(key, queued);
  void queued.then(() => {
    if (checkpointWriters.get(key) === queued) checkpointWriters.delete(key);
  });
  try {
    await abortable(previous, opts.signal);
    throwIfAborted(opts.signal);
    return await uploadFromFile(opts);
  } finally {
    release();
  }
}

async function uploadFromFile(opts: MultipartFromFileOptions): Promise<MultipartFromFileResult> {
  const partTimeoutMs = opts.partTimeoutMs ?? 5 * 60_000;
  if (!Number.isInteger(partTimeoutMs) || partTimeoutMs <= 0 || partTimeoutMs > 5 * 60_000)
    throw new Error("Invalid upload part timeout");
  const maxRetries = opts.maxRetries ?? 2;
  const retryBackoffMs = opts.retryBackoffMs ?? 250;
  if (
    !Number.isSafeInteger(opts.size) ||
    opts.size < 0 ||
    !Number.isSafeInteger(opts.partSize) ||
    opts.partSize <= 0 ||
    opts.partSize > 128 * 1024 ** 2
  )
    throw new Error("Invalid multipart dimensions");
  const partCount = Math.max(1, Math.ceil(opts.size / opts.partSize));
  if (partCount > 10_000) throw new Error("Multipart upload exceeds the S3 part limit");
  throwIfAborted(opts.signal);
  if (partCount > 10000) throw new Error("Multipart upload exceeds 10000 parts");
  const receiptSchema = z
    .object({
      uploadId: z.string().min(1),
      size: z.number(),
      partSize: z.number(),
      parts: z
        .array(
          z
            .object({
              partNumber: z.number().int().positive(),
              etag: z.string().min(1).max(1024),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .max(10000),
    })
    .strict();
  let receipt = {
    uploadId: opts.checkpoint?.uploadId ?? "",
    size: opts.size,
    partSize: opts.partSize,
    parts: [] as { partNumber: number; etag: string; sha256: string }[],
  };
  if (opts.checkpoint) {
    await mkdir(dirname(opts.checkpoint.path), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(opts.checkpoint.path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o077
    )
      throw new Error("Upload checkpoint directory must be private");
    try {
      const info = await lstat(opts.checkpoint.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > 2 * 1024 ** 2
      )
        throw new Error("Invalid upload checkpoint");
      const previous = receiptSchema.parse(
        JSON.parse(await readFile(opts.checkpoint.path, "utf8")),
      );
      if (previous.uploadId === receipt.uploadId) {
        if (previous.size !== opts.size || previous.partSize !== opts.partSize)
          throw new Error("Upload checkpoint source binding changed");
        receipt = previous;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const completed = new Map(receipt.parts.map((part) => [part.partNumber, part]));
  if (
    completed.size !== receipt.parts.length ||
    receipt.parts.some((part) => part.partNumber > partCount)
  )
    throw new Error("Invalid upload checkpoint parts");

  const hasher = new Bun.CryptoHasher("sha256");
  const parts: { partNumber: number; etag: string }[] = [];
  let copied = 0;

  const fh =
    opts.fileHandle ??
    (await open(opts.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
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
      const partHasher = createHash("sha256");
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
        partHasher.update(buffer.subarray(0, bytesRead));
        read += bytesRead;
      }
      const partDigest = partHasher.digest("hex");
      const previous = completed.get(partNumber);
      if (previous) {
        if (previous.sha256 !== partDigest)
          throw new Error("Upload checkpoint source content changed");
        parts.push({ partNumber, etag: previous.etag });
        copied += len;
        opts.onProgress?.(copied);
        continue;
      }

      let res: { ok: boolean; status: number; etag: string } | null = null;
      let attempt = 0;
      while (attempt <= maxRetries) {
        throwIfAborted(opts.signal);
        const urls = await opts.getPartUrls([partNumber]);
        let url = urls.length === 1 && urls[0]?.partNumber === partNumber ? urls[0].url : undefined;
        if (!url) throw new Error(`no presigned URL for part ${partNumber}`);
        throwIfAborted(opts.signal);
        try {
          if (!url) throw new Error("Part URL missing");
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error("Upload part timed out")),
            partTimeoutMs,
          );
          const signal = opts.signal
            ? AbortSignal.any([opts.signal, deadline.signal])
            : deadline.signal;
          try {
            res = await abortable(
              opts.put ? opts.put(url, body) : defaultPut(url, body, opts.connectTo, signal),
              signal,
            );
            throwIfAborted(opts.signal);
          } finally {
            clearTimeout(timer);
            deadline.abort();
          }
          if (res.ok) {
            break;
          }
          if (res.status === 401 || res.status === 403) {
            const refreshed = await opts.getPartUrls([partNumber]);
            url = refreshed.find((part) => part.partNumber === partNumber)?.url;
            if (!url) throw new Error("Part URL refresh failed");
          }
          await abortableSleep(Math.min(2_000, retryBackoffMs * 2 ** attempt), opts.signal);
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

      if (!stripQuotes(res.etag) || res.etag.length > 1024)
        throw new Error("Upload part ETag missing or invalid");
      if (opts.checkpoint) {
        receipt.parts.push({ partNumber, etag: stripQuotes(res.etag), sha256: partDigest });
        const temporary = `${opts.checkpoint.path}.${crypto.randomUUID()}.tmp`;
        const checkpoint = JSON.stringify(receipt);
        await assertStorageCapacity({
          path: temporary,
          additionalBytes: Buffer.byteLength(checkpoint),
          additionalInodes: 1,
        });
        await writeFile(temporary, checkpoint, { mode: 0o600, flag: "wx" });
        const handle = await open(temporary, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, opts.checkpoint.path);
        const directory = await open(dirname(opts.checkpoint.path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
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

  throwIfAborted(opts.signal);
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

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let aborted = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason ?? new Error("TRANSFER_CANCELLED"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
