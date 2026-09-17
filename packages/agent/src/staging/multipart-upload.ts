import { createHash } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createDefaultHttpClient, type HttpClient } from "./http-client";

/**
 * Resumable multipart stage-out: upload a large local file to NetDrive in
 * fixed-size parts, each PUT directly to MinIO via a presigned URL. Progress
 * is tracked in a sidecar (`<localPath>.netdrive-upload.json`) so an
 * interrupted upload resumes without re-sending completed parts. The Server
 * never sees file bytes — only the init/part-urls/complete control calls.
 */
export interface MultipartStageOutOptions {
  serverBaseUrl: string;
  token: string;
  localPath: string;
  remotePath: string;
  /** Bytes per part (except the last). Must match what the Server bound in the token. */
  partSize: number;
  contentType?: string;
  http?: HttpClient;
}

export interface MultipartStageOutResult {
  fileId: string;
  remotePath: string;
  size: number;
  sha256: string;
}

interface UploadSidecar {
  version: 1;
  storageKey: string;
  uploadId: string;
  commitToken: string;
  partSize: number;
  size: number;
  contentType: string;
  completed: { partNumber: number; etag: string }[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

const SIDECAR_SUFFIX = ".netdrive-upload.json";

export async function multipartStageOut(
  opts: MultipartStageOutOptions,
): Promise<MultipartStageOutResult> {
  const http = opts.http ?? createDefaultHttpClient();
  const contentType = opts.contentType ?? "application/octet-stream";
  const sidecarPath = `${opts.localPath}${SIDECAR_SUFFIX}`;
  const { size } = await stat(opts.localPath);

  let sidecar = await loadSidecar(sidecarPath);
  if (sidecar && (sidecar.size !== size || sidecar.partSize !== opts.partSize)) {
    // Local file changed since the sidecar was written — start fresh.
    sidecar = null;
  }

  if (!sidecar) {
    const init = await postJson<{
      storageKey: string;
      uploadId: string;
      commitToken: string;
      partSize: number;
    }>(http, `${trim(opts.serverBaseUrl)}/api/netdrive/uploads/multipart`, opts.token, {
      path: opts.remotePath,
      size,
      contentType,
    });
    sidecar = {
      version: 1,
      storageKey: init.storageKey,
      uploadId: init.uploadId,
      commitToken: init.commitToken,
      partSize: init.partSize,
      size,
      contentType,
      completed: [],
    };
    await writeFile(sidecarPath, JSON.stringify(sidecar));
  }

  const partSize = sidecar.partSize;
  const totalParts = Math.max(1, Math.ceil(size / partSize));
  const done = new Map(sidecar.completed.map((p) => [p.partNumber, p.etag]));

  // Compute the whole-file sha256 in part order (cheap re-read; bounded memory).
  const hash = createHash("sha256");
  const fh = await open(opts.localPath, "r");
  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const offset = (partNumber - 1) * partSize;
      const len = Math.min(partSize, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      hash.update(buf);

      if (done.has(partNumber)) continue;

      const { urls } = await postJson<{ urls: { partNumber: number; url: string }[] }>(
        http,
        `${trim(opts.serverBaseUrl)}/api/netdrive/uploads/multipart/part-urls`,
        opts.token,
        {
          storageKey: sidecar.storageKey,
          uploadId: sidecar.uploadId,
          commitToken: sidecar.commitToken,
          partNumbers: [partNumber],
        },
      );
      const url = urls.find((u) => u.partNumber === partNumber)?.url;
      if (!url) throw new Error(`Multipart: Server returned no URL for part ${partNumber}`);

      const put = await http({ method: "PUT", url, body: buf });
      if (!put.ok) {
        throw new Error(`Multipart: part ${partNumber} PUT failed: HTTP ${put.status}`);
      }
      const etag = stripQuotes(put.headers.etag ?? put.headers.ETag ?? "");
      sidecar.completed.push({ partNumber, etag });
      done.set(partNumber, etag);
      await writeFile(sidecarPath, JSON.stringify(sidecar));
    }
  } finally {
    await fh.close();
  }

  const sha256 = hash.digest("hex");
  const parts = [...done.entries()]
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  const file = await postJson<{ id: string; path: string; size: number; sha256: string }>(
    http,
    `${trim(opts.serverBaseUrl)}/api/netdrive/uploads/multipart/complete`,
    opts.token,
    {
      path: opts.remotePath,
      size,
      sha256,
      contentType,
      storageKey: sidecar.storageKey,
      uploadId: sidecar.uploadId,
      commitToken: sidecar.commitToken,
      parts,
    },
  );

  await rm(sidecarPath, { force: true });
  return { fileId: file.id, remotePath: opts.remotePath, size, sha256 };
}

async function loadSidecar(path: string): Promise<UploadSidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as UploadSidecar;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function postJson<T>(
  http: HttpClient,
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  const res = await http({
    method: "POST",
    url,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Multipart: POST ${url} → HTTP ${res.status}`);
  }
  const env = (await res.json()) as ApiEnvelope<T>;
  if (!env || env.success !== true) {
    throw new Error(`Multipart: POST ${url} returned non-success envelope`);
  }
  return env.data;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function trim(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
