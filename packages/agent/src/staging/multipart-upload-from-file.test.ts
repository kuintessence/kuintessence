import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multipartUploadFromFile, rewriteUrlWithConnectTo } from "./multipart-upload-from-file";

const PART_URL_PREFIX = "mock://part/";

function partNumberFromUrl(url: string): number {
  return Number.parseInt(url.slice(PART_URL_PREFIX.length), 10);
}

describe("multipartUploadFromFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpuff-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function spool(body: string): Promise<{ filePath: string; bytes: Buffer }> {
    const bytes = Buffer.from(body, "utf8");
    const filePath = join(dir, `${crypto.randomUUID()}.bin`);
    await writeFile(filePath, bytes);
    return { filePath, bytes };
  }
  test("uploads each part slice, returns ordered parts + whole-file sha256", async () => {
    const { filePath, bytes } = await spool("AAAABBBBCC");

    const requested: number[][] = [];
    const putByPart = new Map<number, Buffer>();

    const result = await multipartUploadFromFile({
      filePath,
      size: bytes.byteLength,
      partSize: 4,
      getPartUrls: async (partNumbers) => {
        requested.push(partNumbers);
        return partNumbers.map((n) => ({ partNumber: n, url: `${PART_URL_PREFIX}${n}` }));
      },
      put: async (url, body) => {
        putByPart.set(partNumberFromUrl(url), Buffer.from(await body.arrayBuffer()));
        return { ok: true, status: 200, etag: `etag-${partNumberFromUrl(url)}` };
      },
    });

    expect(requested).toEqual([[1], [2], [3]]);
    expect(putByPart.get(1)?.toString("utf8")).toBe("AAAA");
    expect(putByPart.get(2)?.toString("utf8")).toBe("BBBB");
    expect(putByPart.get(3)?.toString("utf8")).toBe("CC");
    expect(result.parts).toEqual([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" },
    ]);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.size).toBe(10);
  });
  test("rejects when a part PUT returns ok:false", async () => {
    const { filePath, bytes } = await spool("AAAABBBBCC");

    await expect(
      multipartUploadFromFile({
        filePath,
        size: bytes.byteLength,
        partSize: 4,
        getPartUrls: async (partNumbers) =>
          partNumbers.map((n) => ({ partNumber: n, url: `${PART_URL_PREFIX}${n}` })),
        put: async (url) => {
          const n = partNumberFromUrl(url);
          if (n === 2) return { ok: false, status: 500, etag: "" };
          return { ok: true, status: 200, etag: `etag-${n}` };
        },
      }),
    ).rejects.toThrow();
  });
  test("retries a transient network failure before failing", async () => {
    const { filePath, bytes } = await spool("ABCD");

    let attempts = 0;
    const result = await multipartUploadFromFile({
      filePath,
      size: bytes.byteLength,
      partSize: 4,
      maxRetries: 2,
      getPartUrls: async (partNumbers) =>
        partNumbers.map((n) => ({ partNumber: n, url: `${PART_URL_PREFIX}${n}` })),
      put: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("The socket connection was closed unexpectedly");
        }
        return { ok: true, status: 200, etag: "etag-1" };
      },
    });

    expect(attempts).toBe(2);
    expect(result.parts).toEqual([{ partNumber: 1, etag: "etag-1" }]);
    expect(result.size).toBe(4);
  });
  test("single-part upload: one PUT, correct sha256", async () => {
    const { filePath, bytes } = await spool("X");

    const requested: number[][] = [];
    let putCount = 0;

    const result = await multipartUploadFromFile({
      filePath,
      size: bytes.byteLength,
      partSize: 4,
      getPartUrls: async (partNumbers) => {
        requested.push(partNumbers);
        return partNumbers.map((n) => ({ partNumber: n, url: `${PART_URL_PREFIX}${n}` }));
      },
      put: async (url) => {
        putCount += 1;
        return { ok: true, status: 200, etag: `etag-${partNumberFromUrl(url)}` };
      },
    });

    expect(requested).toEqual([[1]]);
    expect(putCount).toBe(1);
    expect(result.parts).toEqual([{ partNumber: 1, etag: "etag-1" }]);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.size).toBe(1);
  });
  test.each([
    "success",
    "failure",
    "cancel",
    "read-revoked",
  ] as const)("caller-owned file handle stays pinned and open after %s", async (mode) => {
    const { filePath, bytes } = await spool("original");
    const handle = await open(filePath, "r");
    try {
      await rename(filePath, `${filePath}.old`);
      await writeFile(filePath, "replaced");
      const controller = new AbortController();
      let requests = 0;
      const result = multipartUploadFromFile({
        fileHandle: handle,
        size: bytes.length,
        partSize: 4,
        maxRetries: 0,
        signal: controller.signal,
        authorizeRead: async () => {
          if (mode === "read-revoked") throw new Error("revoked");
        },
        getPartUrls: async ([partNumber]) => [{ partNumber: partNumber ?? 0, url: "mock://part" }],
        put: async (_url, body) => {
          const chunk = Buffer.from(await body.arrayBuffer());
          expect(chunk.equals(bytes.subarray(requests * 4, (requests + 1) * 4))).toBe(true);
          requests++;
          if (mode === "cancel") controller.abort();
          return { ok: mode !== "failure", status: mode === "failure" ? 500 : 200, etag: "part" };
        },
      });
      if (mode === "success")
        expect((await result).sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      else await expect(result).rejects.toThrow();
      expect((await handle.stat()).size).toBe(bytes.length);
      if (mode === "read-revoked") expect(requests).toBe(0);
    } finally {
      await handle.close();
    }
  });
});

describe("rewriteUrlWithConnectTo", () => {
  test("rewrites matching host and preserves original Host header", () => {
    const result = rewriteUrlWithConnectTo(
      "http://localhost:19000/kq-netdrive/obj?X-Amz-Signature=abc",
      "localhost:19000:host.docker.internal:19000",
    );

    expect(result.url).toBe(
      "http://host.docker.internal:19000/kq-netdrive/obj?X-Amz-Signature=abc",
    );
    expect(result.hostHeader).toBe("localhost:19000");
  });
  test("leaves non-matching urls unchanged", () => {
    const url = "http://minio:9000/kq-netdrive/obj";
    expect(rewriteUrlWithConnectTo(url, "localhost:19000:host.docker.internal:19000")).toEqual({
      url,
    });
  });
});

test("multipart renews a part URL on retry and refuses truncated or changed source bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mp-change-"));
  const filePath = join(dir, "source");
  await writeFile(filePath, "12345678");
  let grants = 0,
    writes = 0;
  const options = {
    filePath,
    size: 8,
    partSize: 4,
    retryBackoffMs: 1,
    getPartUrls: async ([partNumber]: number[]) => {
      if (!partNumber) throw new Error("missing part");
      return [{ partNumber, url: `mock://part/${partNumber}/${++grants}` }];
    },
  };
  try {
    const result = await multipartUploadFromFile({
      ...options,
      put: async (url, body) => {
        expect(body instanceof Blob).toBe(true);
        writes++;
        if (writes === 1) throw new Error("expired upload URL");
        expect(url.endsWith(`/${grants}`)).toBe(true);
        return { ok: true, status: 200, etag: "verified" };
      },
    });
    expect(result.parts).toHaveLength(2);
    expect(grants).toBe(3);
    await writeFile(filePath, "short");
    await expect(
      multipartUploadFromFile({
        ...options,
        put: async () => {
          throw new Error("must not upload");
        },
      }),
    ).rejects.toThrow("source size changed");
    await writeFile(filePath, "12345678");
    await expect(
      multipartUploadFromFile({
        ...options,
        put: async () => {
          await writeFile(filePath, "abcdefgh");
          return { ok: true, status: 200, etag: "changed" };
        },
      }),
    ).rejects.toThrow("changed while uploading");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart resumes the same uploadId using durable part hashes and fresh URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-upload-resume-"));
  try {
    const filePath = join(directory, "source");
    await writeFile(filePath, "AAAABBBB");
    const checkpoint = { path: join(directory, "state.json"), uploadId: "same-upload" };
    const opts = {
      filePath,
      size: 8,
      partSize: 4,
      checkpoint,
      maxRetries: 0,
      getPartUrls: async (numbers: number[]) =>
        numbers.map((n) => ({ partNumber: n, url: `${PART_URL_PREFIX}${n}` })),
    };
    await expect(
      multipartUploadFromFile({
        ...opts,
        put: async (url) => {
          if (partNumberFromUrl(url) === 2) throw new Error("disconnected");
          return { ok: true, status: 200, etag: "first" };
        },
      }),
    ).rejects.toThrow("disconnected");
    const uploaded: number[] = [];
    const result = await multipartUploadFromFile({
      ...opts,
      put: async (url) => {
        uploaded.push(partNumberFromUrl(url));
        return { ok: true, status: 200, etag: "second" };
      },
    });
    expect(uploaded).toEqual([2]);
    expect(result.parts).toEqual([
      { partNumber: 1, etag: "first" },
      { partNumber: 2, etag: "second" },
    ]);
    await writeFile(filePath, "changed!");
    await expect(multipartUploadFromFile(opts)).rejects.toThrow("source content changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "timeout",
  "cancel",
])("stalled PUT %s retains completed checkpoint and releases the next resume", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "kq-upload-deadline-"));
  try {
    const filePath = join(directory, "source");
    await writeFile(filePath, "AAAABBBB");
    const checkpoint = { path: join(directory, "state.json"), uploadId: "upload" };
    const controller = new AbortController();
    const opts = {
      filePath,
      size: 8,
      partSize: 4,
      checkpoint,
      maxRetries: 0,
      getPartUrls: async (numbers: number[]) =>
        numbers.map((partNumber) => ({ partNumber, url: `${PART_URL_PREFIX}${partNumber}` })),
    };
    await expect(
      multipartUploadFromFile({
        ...opts,
        signal: controller.signal,
        partTimeoutMs: 20,
        put: async (url) => {
          if (partNumberFromUrl(url) === 1) return { ok: true, status: 200, etag: "first" };
          if (mode === "cancel") controller.abort(new Error("TRANSFER_CANCELLED"));
          return new Promise(() => {});
        },
      }),
    ).rejects.toThrow(mode === "timeout" ? "timed out" : "TRANSFER_CANCELLED");
    expect(JSON.parse(await readFile(checkpoint.path, "utf8")).parts).toHaveLength(1);
    const uploaded: number[] = [];
    const resumed = await multipartUploadFromFile({
      ...opts,
      put: async (url) => {
        uploaded.push(partNumberFromUrl(url));
        return { ok: true, status: 200, etag: "second" };
      },
    });
    expect(uploaded).toEqual([2]);
    expect(resumed.parts).toEqual([
      { partNumber: 1, etag: "first" },
      { partNumber: 2, etag: "second" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
