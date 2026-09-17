import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadSandboxInput } from "./input-downloader";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("downloadSandboxInput", () => {
  test("streams a bounded presigned download through the host connect mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-download-"));
    roots.push(root);
    const requests: Array<{ input: string; host: string | null }> = [];
    const targetPath = join(root, "job", "inputs", "data.bin");
    await downloadSandboxInput({
      sourceUrl: "http://localhost:9000/bucket/data?signature=one",
      targetPath,
      maxBytes: 16,
      connectTo: "localhost:9000:host.docker.internal:19000",
      fetcher: async (input, init) => {
        requests.push({ input, host: new Headers(init.headers).get("host") });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "3" },
        });
      },
    });
    expect(requests).toEqual([
      {
        input: "http://host.docker.internal:19000/bucket/data?signature=one",
        host: "localhost:9000",
      },
    ]);
    expect(await readFile(targetPath)).toEqual(Buffer.from([1, 2, 3]));
  });

  test("removes partial data when the streamed response exceeds the signed limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-download-limit-"));
    roots.push(root);
    const targetPath = join(root, "job", "inputs", "data.bin");
    await expect(
      downloadSandboxInput({
        sourceUrl: "https://storage.example/data",
        targetPath,
        maxBytes: 2,
        fetcher: async () => new Response(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow("exceeds its signed size limit");
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects redirect and non-HTTP sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-download-url-"));
    roots.push(root);
    await expect(
      downloadSandboxInput({
        sourceUrl: "file:///etc/passwd",
        targetPath: join(root, "data"),
        maxBytes: 10,
      }),
    ).rejects.toThrow("HTTP or HTTPS");
    await expect(
      downloadSandboxInput({
        sourceUrl: "https://storage.example/data",
        targetPath: join(root, "redirect"),
        maxBytes: 10,
        fetcher: async () => new Response(null, { status: 302 }),
      }),
    ).rejects.toThrow("HTTP 302");
  });
});
