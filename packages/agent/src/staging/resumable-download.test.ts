import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { type FileHandle, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function withFilePatch(
  patch: (path: string, flags: string | number, file: FileHandle) => void,
  run: () => Promise<void>,
): Promise<void> {
  const original = fs.open;
  const mocked = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const file = await original(path, flags ?? "r", mode);
    patch(String(path), flags ?? "r", file);
    return file;
  });
  try {
    await run();
  } finally {
    mocked.mockRestore();
  }
}

async function checkpoint(local: string, body: Buffer, offset: number): Promise<void> {
  await writeFile(
    `${local}.netdrive-download.json`,
    JSON.stringify({
      version: 1,
      size: body.length,
      sha256: await sha256Hex(body),
      bytesWritten: offset,
    }),
  );
}

test("rehashes only the acknowledged prefix in bounded reads, tolerating short reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-rehash-"));
  const local = join(dir, "data");
  const body = Buffer.alloc(3 * 64 * 1024 + 17, 42);
  await writeFile(local, Buffer.concat([body, Buffer.alloc(128 * 1024, 99)]));
  await checkpoint(local, body, body.length);
  let read = 0;
  let calls = 0;
  try {
    await withFilePatch(
      (path, flags, file) => {
        if (path !== local || flags !== "r") return;
        const original = file.read.bind(file);
        Object.assign(file, {
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            expect(buffer.length).toBeLessThanOrEqual(64 * 1024);
            expect(position + length).toBeLessThanOrEqual(body.length);
            expect(position).toBe(read);
            const result = await original(buffer, offset, Math.min(length, 7001), position);
            read += result.bytesRead;
            calls++;
            return result;
          },
        });
      },
      async () => {
        await resumableDownload({
          downloadUrl: "https://object.invalid/renewed",
          localPath: local,
          size: body.length,
          sha256: await sha256Hex(body),
          window: 32,
          http: async () => {
            throw new Error("completed prefix must not request");
          },
        });
      },
    );
    expect(read).toBe(body.length);
    expect(calls).toBeGreaterThan(3);
    expect((await stat(local)).size).toBe(body.length);
    expect(await readFile(local)).toEqual(body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails a truncated prefix before requesting or altering its checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-eof-"));
  const local = join(dir, "data");
  const body = Buffer.from("abcdef");
  await writeFile(local, body.subarray(0, 4));
  await checkpoint(local, body, 4);
  const before = await readFile(`${local}.netdrive-download.json`, "utf8");
  try {
    await withFilePatch(
      (path, flags, file) => {
        if (path !== local || flags !== "r") return;
        const original = file.read.bind(file);
        Object.assign(file, {
          read: async (buffer: Buffer, offset: number, length: number, position: number) =>
            position === 0
              ? original(buffer, offset, Math.min(length, 2), position)
              : { bytesRead: 0, buffer },
        });
      },
      async () => {
        await expect(
          resumableDownload({
            downloadUrl: "https://object.invalid",
            localPath: local,
            size: body.length,
            sha256: await sha256Hex(body),
            window: 3,
            http: async () => {
              throw new Error("must not request");
            },
          }),
        ).rejects.toThrow("prefix ended before checkpoint");
      },
    );
    expect(await readFile(`${local}.netdrive-download.json`, "utf8")).toBe(before);
    expect(await readFile(local)).toEqual(body.subarray(0, 4));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loops short writes at the correct source and file offsets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-short-"));
  const local = join(dir, "data");
  const body = Buffer.from("abcdefgh");
  const positions: number[] = [];
  try {
    await withFilePatch(
      (path, flags, file) => {
        if (path !== local || flags !== "w") return;
        const original = file.write.bind(file);
        Object.assign(file, {
          write: async (buffer: Buffer, offset: number, length: number, position: number) => {
            positions.push(position);
            return original(buffer, offset, Math.min(length, 2), position);
          },
        });
      },
      async () => {
        await resumableDownload({
          downloadUrl: "https://object.invalid",
          localPath: local,
          size: body.length,
          sha256: await sha256Hex(body),
          window: body.length,
          http: rangeServer(body).http,
        });
      },
    );
    expect(positions).toEqual([0, 2, 4, 6]);
    expect(await readFile(local)).toEqual(body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  "zero",
  "ENOSPC",
])("keeps the actually written prefix after %s and resumes at that offset", async (failure) => {
  const dir = await mkdtemp(join(tmpdir(), "dl-write-fault-"));
  const local = join(dir, "data");
  const body = Buffer.from("abcdefgh");
  try {
    await withFilePatch(
      (path, flags, file) => {
        if (path !== local || flags !== "w") return;
        const original = file.write.bind(file);
        let writes = 0;
        Object.assign(file, {
          write: async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (writes++ === 0) return original(buffer, offset, Math.min(length, 2), position);
            if (failure === "ENOSPC")
              throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
            return { bytesWritten: 0, buffer };
          },
        });
      },
      async () => {
        await expect(
          resumableDownload({
            downloadUrl: "https://object.invalid",
            localPath: local,
            size: body.length,
            sha256: await sha256Hex(body),
            window: body.length,
            http: rangeServer(body).http,
          }),
        ).rejects.toThrow(failure === "ENOSPC" ? "STORAGE_CAPACITY_BYTES" : "made no progress");
      },
    );
    expect(await readFile(local, "utf8")).toBe("ab");
    expect(JSON.parse(await readFile(`${local}.netdrive-download.json`, "utf8")).bytesWritten).toBe(
      2,
    );
    const server = rangeServer(body);
    let requests = 0;
    await resumableDownload({
      downloadUrl: "https://object.invalid/renewed",
      localPath: local,
      size: body.length,
      sha256: await sha256Hex(body),
      window: body.length,
      http: async (request) => {
        requests++;
        expect(request.headers?.Range).toBe("bytes=2-7");
        return server.http(request);
      },
    });
    expect(requests).toBe(1);
    expect(await readFile(local)).toEqual(body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint ENOSPC preserves the prior offset and overwrites only the unacknowledged tail on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-checkpoint-fault-"));
  const local = join(dir, "data");
  const body = Buffer.from("abcdefgh");
  await writeFile(local, body.subarray(0, 2));
  await checkpoint(local, body, 2);
  let checkpoints = 0;
  try {
    await withFilePatch(
      (path, flags, file) => {
        if (!path.startsWith(`${local}.netdrive-download.json.`) || flags !== "wx") return;
        if (++checkpoints !== 2) return;
        const original = file.writeFile.bind(file);
        Object.assign(file, {
          writeFile: async () => {
            await original("{");
            throw Object.assign(new Error("checkpoint disk full"), { code: "ENOSPC" });
          },
        });
      },
      async () => {
        await expect(
          resumableDownload({
            downloadUrl: "https://object.invalid",
            localPath: local,
            size: body.length,
            sha256: await sha256Hex(body),
            window: 3,
            http: rangeServer(body).http,
          }),
        ).rejects.toThrow("STORAGE_CAPACITY_BYTES");
      },
    );
    expect(await readFile(local, "utf8")).toBe("abcde");
    expect(JSON.parse(await readFile(`${local}.netdrive-download.json`, "utf8")).bytesWritten).toBe(
      2,
    );
    const server = rangeServer(body);
    let first = true;
    await resumableDownload({
      downloadUrl: "https://object.invalid/renewed",
      localPath: local,
      size: body.length,
      sha256: await sha256Hex(body),
      window: body.length,
      http: async (request) => {
        if (first) expect(request.headers?.Range).toBe("bytes=2-7");
        first = false;
        return server.http(request);
      },
    });
    expect(await readFile(local)).toEqual(body);
    expect((await stat(local)).size).toBe(body.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
