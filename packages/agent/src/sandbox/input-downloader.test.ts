import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionAuthorization } from "../execution-authorization";
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

test.each([
  "renewed",
  "offline",
  "denied",
  "cancelled",
] as const)("slow HTTP input observes live authority: %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "kq-sandbox-http-"));
  roots.push(root);
  const parent = new AbortController();
  let renewals = 0;
  const lease = new ExecutionAuthorization(
    Date.now() + 400,
    async (signal) => {
      renewals++;
      if (mode === "offline") await delay(10_000, undefined, { signal });
      if (mode === "denied") throw new Error("permission withdrawn");
      return Date.now() + 400;
    },
    parent.signal,
  );
  let producing: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            if (mode === "cancelled") parent.abort(new Error("cancelled"));
            producing = setTimeout(() => {
              controller.enqueue(new Uint8Array([2]));
              controller.close();
            }, 900);
          },
          cancel() {
            clearTimeout(producing);
          },
        }),
      ),
  });
  const targetPath = join(root, "input");
  try {
    const download = downloadSandboxInput({
      sourceUrl: `http://127.0.0.1:${server.port}/input`,
      targetPath,
      maxBytes: 2,
      signal: lease.signal,
    });
    if (mode === "renewed") {
      await download;
      expect(renewals).toBeGreaterThan(1);
      expect(await readFile(targetPath)).toEqual(Buffer.from([1, 2]));
      lease.assertValid();
    } else {
      await expect(download).rejects.toThrow();
      await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).filter((name) => name.includes(".part-"))).toEqual([]);
    }
  } finally {
    clearTimeout(producing);
    await lease.close();
    server.stop(true);
  }
});
