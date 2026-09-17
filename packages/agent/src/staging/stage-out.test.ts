import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpResponse } from "./http-client";
import { stageOut } from "./stage-out";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => text,
    arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(text)),
    json: async <T>() => body as T,
  };
}

function emptyResponse(status: number, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}) as never,
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("stageOut", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "kq-stage-out-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("mints upload URL, PUTs bytes, then commits metadata", async () => {
    const localPath = join(workDir, "out.txt");
    const body = Buffer.from("stage-out-payload");
    await writeFile(localPath, body);
    const sha = await sha256Hex(body);

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const http: HttpClient = async (req) => {
      calls.push({ method: req.method, url: req.url, body: req.body });
      if (req.method === "POST" && req.url.endsWith("/api/netdrive/upload-url")) {
        return jsonResponse(200, {
          success: true,
          data: {
            uploadUrl: "https://fake-minio.test/upload/k1",
            storageKey: "netdrive/u/k1",
            commitToken: "tok-1",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        });
      }
      if (req.method === "PUT" && req.url.startsWith("https://fake-minio.test/upload/")) {
        return emptyResponse(200, { etag: '"abcdef0123"' });
      }
      if (req.method === "POST" && req.url.endsWith("/api/netdrive/files")) {
        return jsonResponse(201, {
          success: true,
          data: {
            id: "file-x",
            ownerId: "u",
            path: "results/out.txt",
            size: body.length,
            sha256: sha,
          },
        });
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    };

    const res = await stageOut({
      serverBaseUrl: "https://server.test",
      token: "tok",
      localPath,
      remotePath: "results/out.txt",
      http,
    });

    expect(res.fileId).toBe("file-x");
    expect(res.sha256).toBe(sha);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[2]?.method).toBe("POST");

    // Mint payload should carry the path / size / sha.
    const mintBody = JSON.parse(calls[0]?.body as string) as { sha256: string; size: number };
    expect(mintBody.sha256).toBe(sha);
    expect(mintBody.size).toBe(body.length);

    // Commit payload should echo the etag the PUT returned, stripped of quotes.
    const commitBody = JSON.parse(calls[2]?.body as string) as { etag?: string };
    expect(commitBody.etag).toBe("abcdef0123");
  });

  test("propagates a failed presigned PUT", async () => {
    const localPath = join(workDir, "fail.bin");
    await writeFile(localPath, Buffer.from("xx"));
    const http: HttpClient = async (req) => {
      if (req.url.endsWith("/api/netdrive/upload-url")) {
        return jsonResponse(200, {
          success: true,
          data: {
            uploadUrl: "https://fake-minio.test/upload/k2",
            storageKey: "netdrive/u/k2",
            commitToken: "tok-2",
            expiresAt: "z",
          },
        });
      }
      if (req.method === "PUT") return emptyResponse(403);
      throw new Error("commit must not be reached");
    };
    await expect(
      stageOut({
        serverBaseUrl: "https://server.test",
        token: "t",
        localPath,
        remotePath: "f.bin",
        http,
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  test("propagates Server commit errors", async () => {
    const localPath = join(workDir, "ok.bin");
    await writeFile(localPath, Buffer.from("ok"));
    const http: HttpClient = async (req) => {
      if (req.url.endsWith("/api/netdrive/upload-url")) {
        return jsonResponse(200, {
          success: true,
          data: {
            uploadUrl: "https://fake-minio.test/upload/k3",
            storageKey: "netdrive/u/k3",
            commitToken: "tok-3",
            expiresAt: "z",
          },
        });
      }
      if (req.method === "PUT") return emptyResponse(200, { etag: '"e"' });
      if (req.url.endsWith("/api/netdrive/files")) {
        return jsonResponse(400, { error: "bad" });
      }
      throw new Error("unexpected");
    };
    await expect(
      stageOut({
        serverBaseUrl: "https://server.test",
        token: "t",
        localPath,
        remotePath: "ok.bin",
        http,
      }),
    ).rejects.toThrow(/HTTP 400/);
  });
});
