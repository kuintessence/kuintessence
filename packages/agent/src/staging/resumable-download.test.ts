import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpRequest, HttpResponse } from "./http-client";
import { resumableDownload } from "./resumable-download";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  // The Uint8Array may be backed by SharedArrayBuffer in pooled Buffers;
  // copy to a fresh ArrayBuffer so the typecheck stays clean.
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}

/** Serve `body` honouring `Range: bytes=start-end`; optionally fail once at a byte offset. */
function rangeServer(
  body: Buffer,
  opts: { failAfterBytes?: number } = {},
): {
  http: HttpClient;
  served: number;
} {
  let served = 0;
  let failed = false;
  const http: HttpClient = async (req: HttpRequest) => {
    const range = req.headers?.Range ?? req.headers?.range;
    let start = 0;
    let end = body.length - 1;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : body.length - 1;
      }
    }
    end = Math.min(end, body.length - 1);
    if (opts.failAfterBytes !== undefined && !failed && start >= opts.failAfterBytes) {
      failed = true;
      return errResponse(500);
    }
    const slice = body.subarray(start, end + 1);
    served += slice.length;
    return {
      status: 206,
      ok: true,
      headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      text: async () => "",
      arrayBuffer: async () => toArrayBuffer(slice),
      json: async () => ({}) as never,
    } satisfies HttpResponse;
  };
  return { http, served };
}

function errResponse(status: number): HttpResponse {
  return {
    status,
    ok: false,
    headers: {},
    text: async () => "err",
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}) as never,
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}

describe("resumableDownload", () => {
  test("downloads the whole object in windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const local = join(dir, "f.dat");
    const body = Buffer.from("0123456789ABCDEF"); // 16 bytes
    const sha = await sha256Hex(body);
    const { http } = rangeServer(body);
    const res = await resumableDownload({
      downloadUrl: "https://minio.test/get",
      localPath: local,
      size: body.length,
      sha256: sha,
      window: 5,
      http,
    });
    expect(res.size).toBe(16);
    expect((await readFile(local)).toString()).toBe("0123456789ABCDEF");
    await rm(dir, { recursive: true, force: true });
  });

  test("resumes from a partial download and verifies sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const local = join(dir, "f.dat");
    const body = Buffer.from("THE-QUICK-BROWN-FOX-JUMPS"); // 25 bytes
    const sha = await sha256Hex(body);

    // First attempt fails after 10 bytes.
    await expect(
      resumableDownload({
        downloadUrl: "https://minio.test/get",
        localPath: local,
        size: body.length,
        sha256: sha,
        window: 5,
        http: rangeServer(body, { failAfterBytes: 10 }).http,
      }),
    ).rejects.toThrow();
    const partial = await readFile(local);
    expect(partial.length).toBeGreaterThanOrEqual(5);
    expect(partial.length).toBeLessThan(body.length);

    // Resume with a fresh (non-failing) server: completes + verifies.
    const res = await resumableDownload({
      downloadUrl: "https://minio.test/get",
      localPath: local,
      size: body.length,
      sha256: sha,
      window: 5,
      http: rangeServer(body).http,
    });
    expect(res.sha256).toBe(sha);
    expect((await readFile(local)).toString()).toBe("THE-QUICK-BROWN-FOX-JUMPS");
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects on sha256 mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const local = join(dir, "f.dat");
    const body = Buffer.from("hello");
    const { http } = rangeServer(body);
    await expect(
      resumableDownload({
        downloadUrl: "https://minio.test/get",
        localPath: local,
        size: body.length,
        sha256: "f".repeat(64),
        window: 2,
        http,
      }),
    ).rejects.toThrow(/sha256/i);
    await rm(dir, { recursive: true, force: true });
  });
});
