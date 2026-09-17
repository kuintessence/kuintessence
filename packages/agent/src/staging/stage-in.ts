import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDefaultHttpClient, type HttpClient } from "./http-client";

/**
 * pull a NetDrive file into a local staging directory.
 *
 * Sequence:
 *   1. GET `/api/netdrive/files/:id` → metadata (path, size, sha256, ...).
 *   2. GET `/api/netdrive/files/:id/download-url` → presigned GET URL.
 *   3. GET <presignedUrl> → download bytes directly from MinIO.
 *   4. Verify size + (optionally) SHA-256 against the metadata.
 *   5. Write to `<stagingDir>/<file.path>` (creating parent dirs).
 *
 * Returns the absolute local path the Agent can hand to the job runner.
 */
export interface StageInOptions {
  serverBaseUrl: string;
  /** Bearer token used to call the Server HTTP API. */
  token: string;
  fileId: string;
  /** Absolute local directory to stage into; created if missing. */
  stagingDir: string;
  /**
   * If true (default), recompute SHA-256 over the downloaded bytes and
   * abort when it disagrees with the Server-side metadata. Setting this
   * false trades integrity for speed on huge files where the upstream
   * cache is trusted. Ignored when `window` is set — windowed downloads
   * always verify.
   */
  verifySha256?: boolean;
  /** Range window (bytes) for resumable download. When omitted, a single GET is used. */
  window?: number;
  http?: HttpClient;
}

export interface StageInResult {
  /** Absolute local path of the staged file. */
  localPath: string;
  size: number;
  sha256: string;
}

interface NetDriveFile {
  id: string;
  ownerId: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

interface DownloadUrlResp {
  downloadUrl: string;
  expiresAt: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

export async function stageIn(opts: StageInOptions): Promise<StageInResult> {
  const http = opts.http ?? createDefaultHttpClient();
  const verifySha = opts.verifySha256 ?? true;

  const meta = await fetchJson<NetDriveFile>(http, {
    method: "GET",
    url: `${trimTrailingSlash(opts.serverBaseUrl)}/api/netdrive/files/${encodeURIComponent(opts.fileId)}`,
    headers: { Authorization: `Bearer ${opts.token}` },
  });

  const dl = await fetchJson<DownloadUrlResp>(http, {
    method: "GET",
    url: `${trimTrailingSlash(opts.serverBaseUrl)}/api/netdrive/files/${encodeURIComponent(opts.fileId)}/download-url`,
    headers: { Authorization: `Bearer ${opts.token}` },
  });

  const localPath = join(opts.stagingDir, meta.path);
  if (opts.window && opts.window > 0) {
    const { resumableDownload } = await import("./resumable-download");
    const dl2 = await resumableDownload({
      downloadUrl: dl.downloadUrl,
      localPath,
      size: meta.size,
      sha256: meta.sha256,
      window: opts.window,
      http,
    });
    return { localPath: dl2.localPath, size: dl2.size, sha256: dl2.sha256 };
  }

  const blobRes = await http({ method: "GET", url: dl.downloadUrl });
  if (!blobRes.ok) {
    throw new Error(`Stage-in: presigned GET failed: HTTP ${blobRes.status}`);
  }
  const buf = Buffer.from(await blobRes.arrayBuffer());
  if (buf.length !== meta.size) {
    throw new Error(`Stage-in: size mismatch — expected ${meta.size}, got ${buf.length}`);
  }
  if (verifySha) {
    const actual = await sha256Hex(buf);
    if (actual.toLowerCase() !== meta.sha256.toLowerCase()) {
      throw new Error(`Stage-in: sha256 mismatch — expected ${meta.sha256}, got ${actual}`);
    }
  }
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, buf);

  return { localPath, size: meta.size, sha256: meta.sha256 };
}

async function fetchJson<T>(
  http: HttpClient,
  req: { method: string; url: string; headers: Record<string, string> },
): Promise<T> {
  const res = await http(req);
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Stage-in: ${req.method} ${req.url} → HTTP ${res.status}: ${detail}`);
  }
  const env = (await res.json()) as ApiEnvelope<T>;
  if (!env || env.success !== true) {
    throw new Error(`Stage-in: ${req.method} ${req.url} returned non-success envelope`);
  }
  return env.data;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

async function sha256Hex(buf: Buffer): Promise<string> {
  // crypto.subtle.digest wants a BufferSource backed by a real
  // ArrayBuffer; Node's Buffer can be backed by SharedArrayBuffer when
  // pooled, so we copy into a fresh Uint8Array on the standard heap.
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
