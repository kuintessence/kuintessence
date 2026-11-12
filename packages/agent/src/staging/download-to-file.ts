import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readSiteTransport, siteFetch } from "@kuintessence/shared/site-transport";
import { assertStorageCapacity, normalizeStorageCapacityError } from "../storage-capacity";
import { rewriteUrlWithConnectTo } from "./multipart-upload-from-file";

interface DownloadOptions {
  url: string;
  targetPath: string;
  size: number;
  sha256: string;
  signal: AbortSignal;
  maxAttempts?: number;
  retryBackoffMs?: number;
  idleTimeoutMs?: number;
  connectTo?: string;
  fetch?: typeof fetch;
  capacity?: typeof assertStorageCapacity;
  onProgress?: (bytes: number) => void;
}

class RetryDownload extends Error {}
const writers = new Map<string, Promise<void>>();

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** The trusted content digest binds retained bytes across URL renewal and Agent restarts. */
export async function downloadToFile(options: DownloadOptions): Promise<void> {
  const digest = options.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(options.size) || options.size < 0)
    throw new Error("Invalid download content binding");
  const targetPath = resolve(options.targetPath);
  const partial = `${targetPath}.kq-sha256-${digest}.part`;
  const previous = writers.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const writer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => writer);
  writers.set(targetPath, queued);
  void queued.then(() => {
    if (writers.get(targetPath) === queued) writers.delete(targetPath);
  });
  try {
    await abortable(previous, options.signal);
    options.signal.throwIfAborted();
    await download({ ...options, targetPath, sha256: digest }, partial);
  } catch (error) {
    throw normalizeStorageCapacityError(error);
  } finally {
    release();
  }
}

async function download(options: DownloadOptions, partial: string): Promise<void> {
  await (options.capacity ?? assertStorageCapacity)({
    path: dirname(partial),
    additionalBytes: 0,
    additionalInodes: 2,
  });
  await mkdir(dirname(partial), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(partial));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o022
  )
    throw new Error(
      "Download staging directory must be Agent-owned and not writable by other accounts",
    );
  const file = await open(
    partial,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.mode & 0o077)
      throw new Error("Download partial file must be private and Agent-owned");
    if (info.size > options.size) await file.truncate(0);
    const attempts = Math.max(1, options.maxAttempts ?? 3);
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted();
      let offset = (await file.stat()).size;
      if (offset === options.size) break;
      await (options.capacity ?? assertStorageCapacity)({
        path: partial,
        additionalBytes: options.size - offset,
        additionalInodes: 0,
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => controller.abort(new Error("Download idle timeout")),
          options.idleTimeoutMs ?? 60_000,
        );
      };
      resetIdle();
      let response: Response | undefined;
      try {
        try {
          const target = readSiteTransport()
            ? { url: options.url }
            : rewriteUrlWithConnectTo(options.url, options.connectTo);
          const original = new URL(options.url);
          response = await abortable(
            (options.fetch ?? siteFetch)(target.url, {
              headers: {
                ...(offset ? { Range: `bytes=${offset}-` } : {}),
                ...(target.hostHeader ? { Host: original.host } : {}),
              },
              redirect: "error",
              signal,
              ...(target.hostHeader && original.protocol === "https:"
                ? { tls: { serverName: original.hostname, rejectUnauthorized: true } }
                : {}),
            } as RequestInit),
            signal,
          );
          resetIdle();
        } catch {
          options.signal.throwIfAborted();
          throw new RetryDownload("Download request unavailable or timed out");
        }
        if (response.status === 200) {
          // An origin without Range support restarts safely instead of appending a second copy.
          await file.truncate(0);
          offset = 0;
          await (options.capacity ?? assertStorageCapacity)({
            path: partial,
            additionalBytes: options.size,
            additionalInodes: 0,
          });
        } else if (response.status === 206) {
          const expected = `bytes ${offset}-${options.size - 1}/${options.size}`;
          if (response.headers.get("content-range") !== expected)
            throw new Error("Download Content-Range does not match the fixed content");
        } else if ([408, 429].includes(response.status) || response.status >= 500) {
          throw new RetryDownload(`Download HTTP ${response.status}`);
        } else {
          throw new Error(
            `Download HTTP ${response.status}; renew the transfer authorization before resuming`,
          );
        }
        if (!response.body) throw new RetryDownload("Download body missing");
        const reader = response.body.getReader();
        try {
          while (true) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await abortable(reader.read(), signal);
              resetIdle();
            } catch {
              options.signal.throwIfAborted();
              throw new RetryDownload("Download body interrupted");
            }
            options.signal.throwIfAborted();
            if (next.done) break;
            if (offset + next.value.byteLength > options.size)
              throw new Error("Download exceeds the fixed content size");
            await (options.capacity ?? assertStorageCapacity)({
              path: partial,
              additionalBytes: options.size - offset,
              additionalInodes: 0,
            });
            let written = 0;
            while (written < next.value.byteLength) {
              const { bytesWritten } = await file.write(
                next.value,
                written,
                next.value.byteLength - written,
                offset,
              );
              if (!bytesWritten) throw new Error("Download file write made no progress");
              written += bytesWritten;
              offset += bytesWritten;
            }
            options.onProgress?.(offset);
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (offset !== options.size) throw new RetryDownload("Download body truncated");
        break;
      } catch (error) {
        if (!(error instanceof RetryDownload) || attempt + 1 >= attempts) throw error;
        await file.sync();
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            options.signal.removeEventListener("abort", aborted);
            resolve();
          };
          const timer = setTimeout(done, options.retryBackoffMs ?? 250);
          const aborted = () => {
            clearTimeout(timer);
            options.signal.removeEventListener("abort", aborted);
            reject(options.signal.reason);
          };
          options.signal.addEventListener("abort", aborted, { once: true });
          if (options.signal.aborted) aborted();
        });
      } finally {
        clearTimeout(idleTimer);
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < options.size) {
      options.signal.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, options.size - position),
        position,
      );
      if (!bytesRead) throw new Error("Download partial file changed during verification");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if ((await file.stat()).size !== options.size || hash.digest("hex") !== options.sha256) {
      await file.truncate(0);
      throw new Error("Download SHA-256 mismatch; partial content discarded");
    }
    await file.sync();
    options.signal.throwIfAborted();
    const [current, opened, directoryInfo] = await Promise.all([
      lstat(partial),
      file.stat(),
      lstat(dirname(partial)),
    ]);
    if (
      current.isSymbolicLink() ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.size !== opened.size ||
      current.mode !== opened.mode ||
      current.nlink !== 1 ||
      directoryInfo.ino !== parent.ino ||
      directoryInfo.dev !== parent.dev ||
      directoryInfo.mode !== parent.mode
    )
      throw new Error("Download staging path changed during verification");
    await rename(partial, options.targetPath);
    const directory = await open(dirname(partial), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
