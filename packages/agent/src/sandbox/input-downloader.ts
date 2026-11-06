import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { rewriteUrlWithConnectTo } from "../staging/multipart-upload-from-file";

export interface SandboxInputDownload {
  sourceUrl: string;
  targetPath: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface SandboxInputDownloaderOptions extends SandboxInputDownload {
  connectTo?: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
}

export async function downloadSandboxInput(options: SandboxInputDownloaderOptions): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("Sandbox input size limit is invalid");
  }
  options.signal?.throwIfAborted();
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
      await file.writeFile(chunk.value);
    }
    await file.sync();
    await file.close();
    options.signal?.throwIfAborted();
    await rename(temporary, options.targetPath);
    completed = true;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
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
