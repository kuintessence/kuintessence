import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { rewriteUrlWithConnectTo } from "../staging/multipart-upload-from-file";

export interface SandboxInputDownload {
  sourceUrl: string;
  targetPath: string;
  maxBytes: number;
}

export interface SandboxInputDownloaderOptions extends SandboxInputDownload {
  connectTo?: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
}

export async function downloadSandboxInput(options: SandboxInputDownloaderOptions): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("Sandbox input size limit is invalid");
  }
  const source = new URL(options.sourceUrl);
  if (source.protocol !== "https:" && source.protocol !== "http:") {
    throw new Error("Sandbox input URL must use HTTP or HTTPS");
  }
  const target = rewriteUrlWithConnectTo(source.toString(), options.connectTo);
  const response = await (options.fetcher ?? fetch)(target.url, {
    method: "GET",
    headers: target.hostHeader ? { Host: target.hostHeader } : undefined,
    redirect: "error",
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
  try {
    const reader = response.body.getReader();
    let copiedBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      copiedBytes += chunk.value.byteLength;
      if (copiedBytes > options.maxBytes) {
        await reader.cancel();
        throw new Error("Sandbox input download exceeds its signed size limit");
      }
      await file.write(chunk.value);
    }
    await file.sync();
    await file.close();
    await rename(temporary, options.targetPath);
    completed = true;
  } finally {
    if (!completed) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
}
