import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadToFile } from "./download-to-file";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(body = "abcdef") {
  const directory = await mkdtemp(join(tmpdir(), "kq-download-"));
  directories.push(directory);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const targetPath = join(directory, "input");
  return {
    body,
    partial: `${targetPath}.kq-sha256-${sha256}.part`,
    options: {
      url: "https://object.invalid/key?signature=first",
      targetPath,
      sha256,
      size: Buffer.byteLength(body),
      signal: new AbortController().signal,
      retryBackoffMs: 0,
      maxAttempts: 1,
    },
  };
}
function fetcher(
  run: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(run(String(input), init ?? {})),
    { preconnect: fetch.preconnect },
  );
}

test("interrupted download survives restart and URL renewal; only verified content replaces target", async () => {
  const { options, partial } = await setup();
  await writeFile(options.targetPath, "old-input");
  await expect(
    downloadToFile({ ...options, fetch: fetcher(() => new Response("abc")) }),
  ).rejects.toThrow("truncated");
  expect(await readFile(partial, "utf8")).toBe("abc");
  expect(await readFile(options.targetPath, "utf8")).toBe("old-input");
  let requests = 0;
  await downloadToFile({
    ...options,
    url: "https://object.invalid/key?signature=renewed",
    fetch: fetcher((url, init) => {
      requests++;
      expect(url).toContain("signature=renewed");
      expect(new Headers(init.headers).get("Range")).toBe("bytes=3-");
      return new Response("def", { status: 206, headers: { "Content-Range": "bytes 3-5/6" } });
    }),
  });
  expect(requests).toBe(1);
  expect(await readFile(options.targetPath, "utf8")).toBe("abcdef");
  expect(await stat(partial).catch(() => null)).toBeNull();
});

test("short normal EOF automatically resumes in the same operation", async () => {
  const { options } = await setup();
  let requests = 0;
  await downloadToFile({
    ...options,
    maxAttempts: 2,
    fetch: fetcher((_url, init) => {
      requests++;
      if (requests === 1) return new Response("ab");
      expect(new Headers(init.headers).get("Range")).toBe("bytes=2-");
      return new Response("cdef", { status: 206, headers: { "Content-Range": "bytes 2-5/6" } });
    }),
  });
  expect(requests).toBe(2);
  expect(await readFile(options.targetPath, "utf8")).toBe("abcdef");
});

test("200 after a Range request safely restarts without concatenation", async () => {
  const { options, partial } = await setup();
  await writeFile(partial, "abc", { mode: 0o600 });
  await downloadToFile({ ...options, fetch: fetcher(() => new Response("abcdef")) });
  expect(await readFile(options.targetPath, "utf8")).toBe("abcdef");
});

test("completed partial is verified and published without a request, including empty objects", async () => {
  for (const body of ["abcdef", ""]) {
    const { options, partial } = await setup(body);
    await writeFile(partial, body, { mode: 0o600 });
    await downloadToFile({
      ...options,
      fetch: fetcher(() => {
        throw new Error("must not request");
      }),
    });
    expect(await readFile(options.targetPath, "utf8")).toBe(body);
  }
});

test("same-size corrupt content never publishes and clears poisoned resume bytes", async () => {
  const { options, partial } = await setup();
  await writeFile(options.targetPath, "original");
  await expect(
    downloadToFile({ ...options, fetch: fetcher(() => new Response("ABCDEF")) }),
  ).rejects.toThrow("SHA-256 mismatch");
  expect(await readFile(options.targetPath, "utf8")).toBe("original");
  expect((await stat(partial)).size).toBe(0);
});

test("mismatched Content-Range and expired authorization retain valid partial bytes", async () => {
  const { options, partial } = await setup();
  await writeFile(partial, "abc", { mode: 0o600 });
  await expect(
    downloadToFile({
      ...options,
      fetch: fetcher(
        () => new Response("def", { status: 206, headers: { "Content-Range": "bytes 2-4/6" } }),
      ),
    }),
  ).rejects.toThrow("Content-Range");
  let requests = 0;
  await expect(
    downloadToFile({
      ...options,
      maxAttempts: 3,
      fetch: fetcher(() => {
        requests++;
        return new Response("", { status: 403 });
      }),
    }),
  ).rejects.toThrow("renew the transfer authorization");
  expect(requests).toBe(1);
  expect(await readFile(partial, "utf8")).toBe("abc");
});

test("oversized response never overwrites existing target", async () => {
  const { options } = await setup();
  await writeFile(options.targetPath, "original");
  await expect(
    downloadToFile({ ...options, fetch: fetcher(() => new Response("abcdefg")) }),
  ).rejects.toThrow("exceeds");
  expect(await readFile(options.targetPath, "utf8")).toBe("original");
});

test("a partial symlink cannot redirect writes outside the staging file", async () => {
  const { options, partial } = await setup();
  await writeFile(options.targetPath, "original");
  await symlink(options.targetPath, partial);
  await expect(
    downloadToFile({ ...options, fetch: fetcher(() => new Response("abcdef")) }),
  ).rejects.toThrow();
  expect(await readFile(options.targetPath, "utf8")).toBe("original");
});

test("abort retains bytes for a later transfer", async () => {
  const { options, partial } = await setup();
  await writeFile(partial, "abc", { mode: 0o600 });
  const controller = new AbortController();
  const operation = downloadToFile({
    ...options,
    signal: controller.signal,
    maxAttempts: 3,
    retryBackoffMs: 10_000,
    fetch: fetcher(() => {
      setTimeout(() => controller.abort(new Error("shutdown")), 1);
      return new Response("", { status: 503 });
    }),
  });
  await expect(operation).rejects.toThrow("shutdown");
  expect(await readFile(partial, "utf8")).toBe("abc");
});

test("idle deadline bounds a fetch implementation that ignores cancellation", async () => {
  const { options } = await setup();
  await expect(
    downloadToFile({
      ...options,
      idleTimeoutMs: 5,
      fetch: fetcher(() => new Promise<Response>(() => {})),
    }),
  ).rejects.toThrow("timed out");
});

test("idle deadline bounds a stalled body and its stalled cancel hook", async () => {
  const { options, partial } = await setup();
  await expect(
    downloadToFile({
      ...options,
      idleTimeoutMs: 5,
      fetch: fetcher(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("abc"));
              },
              cancel() {
                return new Promise<void>(() => {});
              },
            }),
          ),
      ),
    }),
  ).rejects.toThrow("interrupted");
  expect(await readFile(partial, "utf8")).toBe("abc");
});

test("legacy connect-to preserves the original signed authority and TLS identity", async () => {
  const { options } = await setup();
  await downloadToFile({
    ...options,
    connectTo: "object.invalid:443:127.0.0.1:18443",
    fetch: fetcher((url, init) => {
      expect(url).toBe("https://127.0.0.1:18443/key?signature=first");
      expect(new Headers(init.headers).get("Host")).toBe("object.invalid");
      expect(
        (init as RequestInit & { tls?: { serverName: string; rejectUnauthorized: boolean } }).tls,
      ).toEqual({ serverName: "object.invalid", rejectUnauthorized: true });
      return new Response("abcdef");
    }),
  });
});

test("pathname replacement cannot publish bytes that were never verified", async () => {
  const { options, partial } = await setup();
  await writeFile(options.targetPath, "old-input");
  await expect(
    downloadToFile({
      ...options,
      fetch: fetcher(async () => {
        await rm(partial);
        await writeFile(partial, "UNVERIFIED", { mode: 0o600 });
        return new Response("abcdef");
      }),
    }),
  ).rejects.toThrow("path changed");
  expect(await readFile(options.targetPath, "utf8")).toBe("old-input");
});

test("different content for one target is serialized, and a cancelled waiter cannot bypass the first writer", async () => {
  const { options } = await setup();
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<Response>();
  let firstDone = false;
  const first = downloadToFile({
    ...options,
    fetch: fetcher(async () => {
      started.resolve();
      return proceed.promise;
    }),
  }).then(() => {
    firstDone = true;
  });
  await started.promise;
  const controller = new AbortController();
  const cancelled = downloadToFile({
    ...options,
    signal: controller.signal,
    fetch: fetcher(() => {
      throw new Error("cancelled waiter must never fetch");
    }),
  });
  controller.abort(new Error("cancelled waiter"));
  await expect(cancelled).rejects.toThrow("cancelled waiter");
  const second = downloadToFile({
    ...options,
    sha256: createHash("sha256").update("UVWXYZ").digest("hex"),
    fetch: fetcher(() => {
      expect(firstDone).toBe(true);
      return new Response("UVWXYZ");
    }),
  });
  proceed.resolve(new Response("abcdef"));
  await Promise.all([first, second]);
  expect(await readFile(options.targetPath, "utf8")).toBe("UVWXYZ");
});

test("capacity admission reserves only the retained download remainder and stops before network IO", async () => {
  const { options, partial } = await setup();
  await writeFile(partial, "abc", { mode: 0o600 });
  const requests: number[] = [];
  let fetched = false;
  await expect(
    downloadToFile({
      ...options,
      capacity: async (request) => {
        requests.push(request.additionalBytes);
        if (request.additionalBytes) throw new Error("STORAGE_CAPACITY_BYTES");
      },
      fetch: fetcher(() => {
        fetched = true;
        return new Response("def");
      }),
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_BYTES");
  expect(requests).toEqual([0, 3]);
  expect(fetched).toBe(false);
  expect(await readFile(partial, "utf8")).toBe("abc");
});

test("an origin ignoring Range must pass full-size admission after truncation", async () => {
  const { options, partial } = await setup();
  await writeFile(partial, "abc", { mode: 0o600 });
  const requests: number[] = [];
  await expect(
    downloadToFile({
      ...options,
      capacity: async (request) => {
        requests.push(request.additionalBytes);
        if (request.additionalBytes === 6) throw new Error("STORAGE_CAPACITY_BYTES");
      },
      fetch: fetcher(() => new Response("abcdef")),
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_BYTES");
  expect(requests).toEqual([0, 3, 6]);
});
