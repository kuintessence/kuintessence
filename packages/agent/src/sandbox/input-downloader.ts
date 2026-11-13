import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DataAssetEntryPathSchema } from "@kuintessence/shared";
import type { AgentDataRoots } from "../data-market/local-data-security";
import { rewriteUrlWithConnectTo } from "../staging/multipart-upload-from-file";
import { assertStorageCapacity, normalizeStorageCapacityError } from "../storage-capacity";

export interface SandboxInputDownload {
  sourceUrl: string;
  targetPath: string;
  maxBytes: number;
  localDataSource?: { locationId: string; managedRootId: string; relativePath: string };
  signal?: AbortSignal;
}

export interface SandboxInputDownloaderOptions extends SandboxInputDownload {
  connectTo?: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  roots?: Pick<AgentDataRoots, "resolveManagedDataPath">;
}

export async function downloadSandboxInput(options: SandboxInputDownloaderOptions): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("Sandbox input size limit is invalid");
  }
  options.signal?.throwIfAborted();
  if (options.localDataSource) return copyLocalInput(options);
  await assertStorageCapacity({
    path: dirname(options.targetPath),
    additionalBytes: options.maxBytes,
    additionalInodes: 2,
  });
  const source = new URL(options.sourceUrl);
  if (source.protocol !== "https:" && source.protocol !== "http:") {
    throw new Error("Sandbox input URL must use HTTP or HTTPS");
  }
  const target = rewriteUrlWithConnectTo(source.toString(), options.connectTo);
  const response = await (options.fetcher ?? fetch)(target.url, {
    method: "GET",
    signal: options.signal,
    headers: target.hostHeader ? { Host: target.hostHeader } : undefined,
    redirect: "error",
  }).catch((error: unknown) => {
    options.signal?.throwIfAborted();
    throw error;
  });
  if (!response.ok || !response.body) {
    throw new Error(`Sandbox input download failed: HTTP ${response.status}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > options.maxBytes) {
    await response.body.cancel();
    throw new Error("Sandbox input download exceeds its signed size limit");
  }

  await mkdir(dirname(options.targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${options.targetPath}.part-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  let completed = false;
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    let copiedBytes = 0;
    while (true) {
      const chunk = await reader.read();
      options.signal?.throwIfAborted();
      if (chunk.done) break;
      copiedBytes += chunk.value.byteLength;
      if (copiedBytes > options.maxBytes) {
        await reader.cancel();
        throw new Error("Sandbox input download exceeds its signed size limit");
      }
      await assertStorageCapacity({
        path: temporary,
        additionalBytes: options.maxBytes - copiedBytes + chunk.value.byteLength,
        additionalInodes: 0,
      });
      await file.writeFile(chunk.value);
    }
    await file.sync();
    await file.close();
    options.signal?.throwIfAborted();
    await rename(temporary, options.targetPath);
    completed = true;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw normalizeStorageCapacityError(error);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (!completed) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
}

async function copyLocalInput(options: SandboxInputDownloaderOptions) {
  const source = options.localDataSource;
  if (!source?.locationId || !source.managedRootId || options.sourceUrl || !options.roots)
    throw new Error("Sandbox local data source is invalid or unavailable");
  const relative = DataAssetEntryPathSchema.parse(source.relativePath);
  let path = await options.roots.resolveManagedDataPath(source.managedRootId, ".");
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)
    )
      throw new Error("Sandbox local input must be a managed regular file without links");
  }
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const temporary = `${options.targetPath}.part-${randomUUID()}`;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > options.maxBytes)
      throw new Error("Sandbox local input exceeds its signed size limit or is invalid");
    await mkdir(dirname(options.targetPath), { recursive: true, mode: 0o700 });
    const output = await open(temporary, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error("Sandbox local input changed during staging");
        await output.writeFile(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await input.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Sandbox local input changed during staging");
      await output.sync();
    } finally {
      await output.close();
    }
    options.signal?.throwIfAborted();
    await rename(temporary, options.targetPath);
  } finally {
    await input.close();
    await rm(temporary, { force: true });
  }
}
