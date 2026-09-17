import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        putByPart.set(partNumberFromUrl(url), Buffer.from(body));
        return { ok: true, status: 200, etag: `etag-${partNumberFromUrl(url)}` };
      },
    });

    expect(requested).toEqual([[1, 2, 3]]);
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
