import { readFile } from "node:fs/promises";
import { createDefaultHttpClient, type HttpClient } from "./http-client";

/**
 * register a local job-output file with the Server and upload
 * it to MinIO via the presigned PUT URL.
 *
 * Sequence:
 *   1. Read the local file body into a single buffer.
 *   2. Compute SHA-256 over the bytes.
 *   3. POST `/api/netdrive/upload-url` → presigned PUT URL + commit token.
 *   4. PUT the bytes directly to MinIO.
 *   5. POST `/api/netdrive/files` with the commit token → final metadata.
 *
 * Returns the committed `NetDriveFile` so the Agent can record the id
 * against the job's outputs.
 */
export interface StageOutOptions {
  serverBaseUrl: string;
  /** Bearer token used to call the Server HTTP API. */
  token: string;
  /** Absolute local path to read from. */
  localPath: string;
  /** Logical path the Server will record (POSIX-safe). */
  remotePath: string;
  contentType?: string;
  http?: HttpClient;
  /** Files at or above this size use resumable multipart upload. Omit to always single-shot. */
  multipartThresholdBytes?: number;
  /** Part size for multipart uploads (bytes). Defaults to the threshold when omitted. */
  multipartPartSize?: number;
}

export interface StageOutResult {
  fileId: string;
  remotePath: string;
  size: number;
  sha256: string;
}

interface UploadUrlResp {
  uploadUrl: string;
  storageKey: string;
  commitToken: string;
  expiresAt: string;
}

interface CommitResp {
  id: string;
  ownerId: string;
  path: string;
  size: number;
  sha256: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

export async function stageOut(opts: StageOutOptions): Promise<StageOutResult> {
  const http = opts.http ?? createDefaultHttpClient();
  const contentType = opts.contentType ?? "application/octet-stream";

  if (opts.multipartThresholdBytes !== undefined) {
    const { stat } = await import("node:fs/promises");
    const { size } = await stat(opts.localPath);
    if (size >= opts.multipartThresholdBytes) {
      const { multipartStageOut } = await import("./multipart-upload");
      return multipartStageOut({
        serverBaseUrl: opts.serverBaseUrl,
        token: opts.token,
        localPath: opts.localPath,
        remotePath: opts.remotePath,
        partSize: opts.multipartPartSize ?? opts.multipartThresholdBytes,
        contentType: opts.contentType,
        http: opts.http,
      });
    }
  }

  const buf = await readFile(opts.localPath);
  const sha = await sha256Hex(buf);

  // 1. Mint the upload URL + commit token.
  const minted = await fetchJson<UploadUrlResp>(http, {
    method: "POST",
    url: `${trimTrailingSlash(opts.serverBaseUrl)}/api/netdrive/upload-url`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: opts.remotePath,
      size: buf.length,
      contentType,
      sha256: sha,
    }),
  });

  // 2. PUT bytes directly to MinIO via the presigned URL. We capture the
  // ETag header (S3 echoes it on success) so the commit can persist it.
  const putRes = await http({
    method: "PUT",
    url: minted.uploadUrl,
    headers: { "Content-Type": contentType },
    body: buf,
  });
  if (!putRes.ok) {
    throw new Error(`Stage-out: presigned PUT failed: HTTP ${putRes.status}`);
  }
  const etag = stripQuotes(putRes.headers.etag ?? putRes.headers.ETag ?? "");

  // 3. Commit metadata.
  const file = await fetchJson<CommitResp>(http, {
    method: "POST",
    url: `${trimTrailingSlash(opts.serverBaseUrl)}/api/netdrive/files`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: opts.remotePath,
      size: buf.length,
      contentType,
      sha256: sha,
      storageKey: minted.storageKey,
      commitToken: minted.commitToken,
      etag: etag || undefined,
    }),
  });

  return {
    fileId: file.id,
    remotePath: file.path,
    size: file.size,
    sha256: file.sha256,
  };
}

async function fetchJson<T>(
  http: HttpClient,
  req: { method: string; url: string; headers: Record<string, string>; body?: string | Buffer },
): Promise<T> {
  const res = await http(req);
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Stage-out: ${req.method} ${req.url} → HTTP ${res.status}: ${detail}`);
  }
  const env = (await res.json()) as ApiEnvelope<T>;
  if (!env || env.success !== true) {
    throw new Error(`Stage-out: ${req.method} ${req.url} returned non-success envelope`);
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

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
