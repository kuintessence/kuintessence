import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpResponse } from "./http-client";
import { stageIn } from "./stage-in";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  // The Uint8Array may be backed by SharedArrayBuffer in pooled Buffers;
  // copy to a fresh ArrayBuffer so the typecheck stays clean.
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: async () => text,
    arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(text)),
    json: async <T>() => body as T,
  };
}

function bytesResponse(status: number, body: Buffer): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: async () => body.toString("utf-8"),
    arrayBuffer: async () => toArrayBuffer(body),
    json: async () => {
      throw new Error("not json");
    },
  };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("stageIn", () => {
  let stagingDir: string;

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "kq-stage-in-"));
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  test("downloads, verifies sha256, and writes the file under stagingDir", async () => {
    const body = "stage-in-payload";
    const buf = Buffer.from(body);
    const sha = await sha256Hex(body);

    const calls: string[] = [];
    const http: HttpClient = async (req) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url.endsWith("/api/netdrive/files/file-1")) {
        return jsonResponse(200, {
          success: true,
          data: {
            id: "file-1",
            ownerId: "u",
            path: "out/data.bin",
            size: buf.length,
            sha256: sha,
            contentType: "application/octet-stream",
          },
        });
      }
      if (req.url.endsWith("/api/netdrive/files/file-1/download-url")) {
        return jsonResponse(200, {
          success: true,
          data: {
            downloadUrl: "https://fake-minio.test/download/key?expires=60",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        });
      }
      if (req.url.startsWith("https://fake-minio.test/download/")) {
        return bytesResponse(200, buf);
      }
      throw new Error(`unexpected url ${req.url}`);
    };

    const result = await stageIn({
      serverBaseUrl: "https://server.test/",
      token: "tok",
      fileId: "file-1",
      stagingDir,
      http,
    });

    expect(result.size).toBe(buf.length);
    expect(result.sha256).toBe(sha);
    expect(result.localPath).toBe(join(stagingDir, "out/data.bin"));
    const onDisk = await readFile(result.localPath);
    expect(onDisk.toString()).toBe(body);
    expect(calls.length).toBe(3);
  });

  test("rejects when downloaded size differs from metadata", async () => {
    const sha = await sha256Hex("expected");
    const http: HttpClient = async (req) => {
      if (req.url.endsWith("/api/netdrive/files/file-2")) {
        return jsonResponse(200, {
          success: true,
          data: {
            id: "file-2",
            ownerId: "u",
            path: "size.bin",
            size: 8,
            sha256: sha,
            contentType: "application/octet-stream",
          },
        });
      }
      if (req.url.endsWith("/api/netdrive/files/file-2/download-url")) {
        return jsonResponse(200, {
          success: true,
          data: { downloadUrl: "https://fake/dl", expiresAt: "z" },
        });
      }
      return bytesResponse(200, Buffer.from("short"));
    };
    await expect(
      stageIn({
        serverBaseUrl: "https://server.test",
        token: "t",
        fileId: "file-2",
        stagingDir,
        http,
      }),
    ).rejects.toThrow(/size mismatch/);
  });

  test("rejects when sha256 disagrees with metadata", async () => {
    const buf = Buffer.from("real");
    const wrongSha = await sha256Hex("fake");
    const http: HttpClient = async (req) => {
      if (req.url.endsWith("/api/netdrive/files/file-3")) {
        return jsonResponse(200, {
          success: true,
          data: {
            id: "file-3",
            ownerId: "u",
            path: "sha.bin",
            size: buf.length,
            sha256: wrongSha,
            contentType: "application/octet-stream",
          },
        });
      }
      if (req.url.endsWith("/api/netdrive/files/file-3/download-url")) {
        return jsonResponse(200, {
          success: true,
          data: { downloadUrl: "https://fake/dl", expiresAt: "z" },
        });
      }
      return bytesResponse(200, buf);
    };
    await expect(
      stageIn({
        serverBaseUrl: "https://server.test",
        token: "t",
        fileId: "file-3",
        stagingDir,
        http,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  test("propagates Server HTTP errors", async () => {
    const http: HttpClient = async () => jsonResponse(500, { error: "boom" });
    await expect(
      stageIn({
        serverBaseUrl: "https://server.test",
        token: "t",
        fileId: "file-x",
        stagingDir,
        http,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
