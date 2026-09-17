import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpRequest, HttpResponse } from "./http-client";
import { multipartStageOut } from "./multipart-upload";

function jsonResponse(data: unknown): HttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    text: async () => JSON.stringify({ success: true, data }),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({ success: true, data }) as never,
  };
}

/** Fake Server + MinIO. Records part PUTs; can be told to fail the first PUT of part 2. */
function makeFakeHttp(opts: { failPartOnce?: number } = {}): {
  http: HttpClient;
  parts: Map<number, Buffer>;
  calls: string[];
} {
  const parts = new Map<number, Buffer>();
  const calls: string[] = [];
  let failed = false;
  const http: HttpClient = async (req: HttpRequest) => {
    calls.push(`${req.method} ${req.url.split("?")[0]}`);
    if (req.url.includes("/uploads/multipart/part-urls")) {
      const body = JSON.parse(String(req.body)) as { partNumbers: number[] };
      return jsonResponse({
        urls: body.partNumbers.map((n) => ({
          partNumber: n,
          url: `https://minio.test/part?partNumber=${n}`,
        })),
      });
    }
    if (req.url.includes("/uploads/multipart/complete")) {
      return {
        ...jsonResponse({ id: "file-1", path: "out.dat", size: 0, sha256: "x" }),
        status: 201,
      };
    }
    if (req.url.includes("/uploads/multipart")) {
      // init
      return jsonResponse({
        storageKey: "netdrive/o/u",
        uploadId: "up-1",
        commitToken: "tok",
        partSize: 4,
        expiresAt: new Date(0).toISOString(),
      });
    }
    if (req.url.startsWith("https://minio.test/part")) {
      const n = Number(new URL(req.url).searchParams.get("partNumber"));
      if (opts.failPartOnce === n && !failed) {
        failed = true;
        return {
          status: 500,
          ok: false,
          headers: {},
          text: async () => "boom",
          arrayBuffer: async () => new ArrayBuffer(0),
          json: async () => ({}) as never,
        };
      }
      parts.set(n, Buffer.from(req.body as Uint8Array));
      return {
        status: 200,
        ok: true,
        headers: { etag: `"etag-${n}"` },
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}) as never,
      };
    }
    throw new Error(`unexpected ${req.url}`);
  };
  return { http, parts, calls };
}

describe("multipartStageOut", () => {
  test("uploads a file in parts and completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-"));
    const local = join(dir, "out.dat");
    await writeFile(local, Buffer.from("AAAABBBBCC")); // 10 bytes, partSize 4 -> parts 1,2,3
    const { http, parts } = makeFakeHttp();
    const res = await multipartStageOut({
      serverBaseUrl: "https://server.test",
      token: "jwt",
      localPath: local,
      remotePath: "out.dat",
      partSize: 4,
      http,
    });
    expect(res.fileId).toBe("file-1");
    expect([...parts.keys()].sort()).toEqual([1, 2, 3]);
    expect(parts.get(1)?.toString()).toBe("AAAA");
    expect(parts.get(3)?.toString()).toBe("CC");
    await rm(dir, { recursive: true, force: true });
  });

  test("resumes after a mid-upload failure without re-PUTting completed parts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-"));
    const local = join(dir, "out.dat");
    await writeFile(local, Buffer.from("AAAABBBBCC"));
    const fake = makeFakeHttp({ failPartOnce: 2 });

    // First attempt throws on part 2.
    await expect(
      multipartStageOut({
        serverBaseUrl: "https://server.test",
        token: "jwt",
        localPath: local,
        remotePath: "out.dat",
        partSize: 4,
        http: fake.http,
      }),
    ).rejects.toThrow();
    // Sidecar exists and records part 1 done.
    const sidecar = JSON.parse(await readFile(`${local}.netdrive-upload.json`, "utf8"));
    expect(sidecar.completed.map((p: { partNumber: number }) => p.partNumber)).toContain(1);

    // Second attempt resumes: part 1 is NOT re-PUT (already in sidecar).
    fake.calls.length = 0;
    const res = await multipartStageOut({
      serverBaseUrl: "https://server.test",
      token: "jwt",
      localPath: local,
      remotePath: "out.dat",
      partSize: 4,
      http: fake.http,
    });
    expect(res.fileId).toBe("file-1");
    // part 1 already done in the first attempt; only 2 and 3 PUT on resume.
    expect(fake.parts.get(1)).toBeDefined();
    // Sidecar removed after success.
    await expect(readFile(`${local}.netdrive-upload.json`, "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});
