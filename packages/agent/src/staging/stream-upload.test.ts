import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilePutter, streamUploadToPresignedUrl } from "./stream-upload";

function tmpFile(): string {
  return join(tmpdir(), `kq-stream-upload-test-${randomUUID()}.bin`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function* chunkSource(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("streamUploadToPresignedUrl", () => {
  test("spools a multi-chunk source, PUTs it, returns correct size + sha256", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7]),
      new Uint8Array([8, 9, 10, 11, 12]),
    ];
    const concatenated = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const expectedSha = createHash("sha256").update(concatenated).digest("hex");
    const tmpPath = tmpFile();

    let receivedBytes: Buffer | null = null;
    const put: FilePutter = async (_url, file) => {
      receivedBytes = Buffer.from(await file.arrayBuffer());
      return { ok: true, status: 200, statusText: "OK" };
    };

    const result = await streamUploadToPresignedUrl({
      source: chunkSource(chunks),
      uploadUrl: "https://example.invalid/upload",
      tmpPath,
      put,
    });

    expect(result.size).toBe(concatenated.byteLength);
    expect(result.sha256).toBe(expectedSha);
    expect(receivedBytes).not.toBeNull();
    expect(Buffer.compare(receivedBytes as unknown as Buffer, concatenated)).toBe(0);
    expect(await exists(tmpPath)).toBe(false);
  });

  test("a failing PUT rejects and removes the temp file", async () => {
    const tmpPath = tmpFile();
    const put: FilePutter = async () => ({ ok: false, status: 500, statusText: "Server Error" });

    await expect(
      streamUploadToPresignedUrl({
        source: chunkSource([new Uint8Array([1, 2, 3])]),
        uploadUrl: "https://example.invalid/upload",
        tmpPath,
        put,
      }),
    ).rejects.toThrow("upload PUT failed: 500 Server Error");
    expect(await exists(tmpPath)).toBe(false);
  });

  test("beforePut that throws rejects, skips the PUT, removes the temp file", async () => {
    const tmpPath = tmpFile();
    let putCalled = false;
    const put: FilePutter = async () => {
      putCalled = true;
      return { ok: true, status: 200, statusText: "OK" };
    };

    await expect(
      streamUploadToPresignedUrl({
        source: chunkSource([new Uint8Array([1, 2, 3])]),
        uploadUrl: "https://example.invalid/upload",
        tmpPath,
        beforePut: async () => {
          throw new Error("source failed");
        },
        put,
      }),
    ).rejects.toThrow("source failed");
    expect(putCalled).toBe(false);
    expect(await exists(tmpPath)).toBe(false);
  });
});
