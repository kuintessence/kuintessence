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

test("real HTTP cannot bypass a bounded window by ignoring Range or lying about response length", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-bound-"));
  const body = Buffer.from("0123456789");
  let mode = "ignore";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      if (mode === "ignore") return new Response(body);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 4));
            setTimeout(() => {
              controller.enqueue(body.subarray(4));
              controller.close();
            }, 10);
          },
        }),
        { status: 206, headers: { "content-range": "bytes 0-3/10" } },
      );
    },
  });
  try {
    const options = {
      downloadUrl: `http://127.0.0.1:${server.port}/file`,
      localPath: join(dir, "data"),
      size: body.length,
      sha256: await sha256Hex(body),
      window: 4,
    };
    await expect(resumableDownload(options)).rejects.toThrow("exact unencoded requested range");
    mode = "oversize";
    await expect(resumableDownload(options)).rejects.toThrow("exceeds its bounded window");
    expect((await readFile(options.localPath)).length).toBe(0);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled streaming download closes its body and preserves only checkpointed bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-abort-"));
  let cancelled = false;
  const stop = new AbortController();
  const http: HttpClient = async () => ({
    status: 206,
    ok: true,
    headers: { "content-range": "bytes 0-3/4" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        setTimeout(() => stop.abort(), 15);
      },
      cancel() {
        cancelled = true;
      },
    }),
    arrayBuffer: async () => {
      throw new Error("Streaming path cannot buffer the response");
    },
    text: async () => "",
    json: async () => {
      throw new Error("unused");
    },
  });
  try {
    await expect(
      resumableDownload({
        downloadUrl: "https://source.invalid/object",
        localPath: join(dir, "data"),
        size: 4,
        sha256: "a".repeat(64),
        window: 4,
        signal: stop.signal,
        http,
      }),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect((await readFile(join(dir, "data"))).length).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bad digest is discarded and cannot poison a later correct retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-digest-"));
  const localPath = join(dir, "data"),
    good = Buffer.from("right"),
    bad = Buffer.from("wrong");
  const options = {
    downloadUrl: "https://source.invalid/object",
    localPath,
    size: 5,
    sha256: await sha256Hex(good),
    window: 2,
  };
  try {
    await expect(resumableDownload({ ...options, http: rangeServer(bad).http })).rejects.toThrow(
      "sha256",
    );
    expect(await Bun.file(localPath).exists()).toBe(false);
    await resumableDownload({ ...options, http: rangeServer(good).http });
    expect(await readFile(localPath)).toEqual(good);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
