import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpackMaterialManifest } from "@kuintessence/shared";
import {
  configureSpackMaterialClient,
  SpackMaterialClient,
  type SpackMaterialFetch,
} from "./material-client";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const body = "verified archive bytes";
const blob = { digest: digest(body), size: Buffer.byteLength(body) };
const manifest: SpackMaterialManifest = {
  version: 1,
  repository: "public/test",
  spec: "zlib@1.3.1",
  spackVersion: "0.22.1",
  target: "linux-x86_64",
  redistribution: "unrestricted",
  recipes: [{ repositoryId: "a".repeat(64), commit: "b".repeat(40), roots: ["."], archive: blob }],
  sources: [{ path: "source/zlib.tar.gz", blob }],
  lockfile: blob,
};
const manifestBytes = JSON.stringify(manifest, null, 2);
const input = {
  operationId: "00000000-0000-4000-8000-000000000001",
  ticket: "test-ticket",
  manifestDigest: digest(manifestBytes),
  spec: manifest.spec,
  spackVersion: manifest.spackVersion,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(fetchBlob: () => Response = () => new Response(body), text = manifestBytes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spack-materials-")));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const calls: string[] = [];
  const fetch: SpackMaterialFetch = async (url, init) => {
    calls.push(url);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-ticket");
    return url.endsWith("/manifest") ? new Response(text) : fetchBlob();
  };
  const client = new SpackMaterialClient({ serverUrl: "https://server.example", cacheDir, fetch });
  return { root, cacheDir, calls, fetch, client };
}

describe("SpackMaterialClient", () => {
  test("platform configuration preserves Agent startup without permitting legacy HTTP tickets", () => {
    expect(
      configureSpackMaterialClient({ enabled: false, serverUrl: "invalid", cacheDir: "/" }),
    ).toEqual({});
    const legacy = configureSpackMaterialClient({
      enabled: true,
      serverUrl: "http://server:3000",
      cacheDir: "/var/lib/kuintessence/spack-materials",
    });
    expect(legacy.client).toBeUndefined();
    expect(legacy.unavailableReason).toContain("unavailable");
    expect(configureSpackMaterialClient({ enabled: true }).unavailableReason).toContain("requires");
    expect(
      configureSpackMaterialClient({
        enabled: true,
        serverUrl: "https://server.example",
        cacheDir: "/var/lib/kuintessence/spack-materials",
      }).client,
    ).toBeInstanceOf(SpackMaterialClient);
  });

  test("verifies exact manifest bytes, deduplicates blobs, and reuses a durable cache after restart", async () => {
    const f = await fixture();
    const result = await f.client.prepare(input);
    expect(result.manifest).toEqual(manifest);
    expect(result.blobs).toHaveLength(1);
    expect(await readFile(result.manifestPath, "utf8")).toBe(manifestBytes);
    expect(await readFile(result.blobs[0]?.path ?? "", "utf8")).toBe(body);
    expect(f.calls).toEqual([
      `https://server.example/api/agent/spack/operations/${input.operationId}/manifest`,
      `https://server.example/api/agent/spack/operations/${input.operationId}/blobs/${blob.digest}`,
    ]);
    const restarted = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: f.fetch,
    });
    await restarted.prepare(input);
    expect(f.calls.filter((url) => url.includes("/blobs/"))).toHaveLength(1);
  });

  test("publishes Agent-only directories and read-only 0400 manifest/blob files", async () => {
    const f = await fixture();
    const prepared = await f.client.prepare(input);
    for (const path of [f.cacheDir, join(f.cacheDir, "sha256")]) {
      const stat = await lstat(path);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(process.getuid?.() ?? -1);
    }
    for (const path of [prepared.manifestPath, ...prepared.blobs.map((entry) => entry.path)]) {
      const stat = await lstat(path);
      expect(stat.mode & 0o777).toBe(0o400);
      expect(stat.uid).toBe(process.getuid?.() ?? -1);
    }
  });

  test.each([
    "cache",
    "sha256",
  ])("rejects preexisting %s directories with any group/other permissions", async (directory) => {
    const f = await fixture();
    await mkdir(f.cacheDir, { mode: 0o700 });
    const path = directory === "cache" ? f.cacheDir : join(f.cacheDir, "sha256");
    if (directory === "sha256") await mkdir(path, { mode: 0o700 });
    for (const mode of [0o755, 0o740, 0o710, 0o704, 0o701, 0o720, 0o702]) {
      await chmod(path, mode);
      await expect(f.client.prepare(input)).rejects.toThrow("group/other permissions");
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    }
    expect(f.calls).toEqual([]);
  });

  test.each([
    "manifest",
    "blob",
  ])("rejects reusable %s files with group/other permissions without repairing or redownloading", async (kind) => {
    const f = await fixture();
    const prepared = await f.client.prepare(input);
    const path = kind === "manifest" ? prepared.manifestPath : (prepared.blobs[0]?.path ?? "");
    for (const mode of [0o444, 0o640, 0o604, 0o410, 0o401, 0o620, 0o602]) {
      await chmod(path, mode);
      await expect(f.client.prepare(input)).rejects.toThrow("group/other permissions");
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    }
    expect(f.calls.filter((url) => url.includes("/blobs/"))).toHaveLength(1);
  });

  test.each([
    "https://user:pass@server.example",
    "https://server.example/path",
    "https://server.example/?query=1",
    "https://server.example/#fragment",
    "https://server.example/a/..",
    "https://@server.example",
    "http://server.example",
    "file:///tmp/materials",
  ])("rejects unsafe Server origin %s", (serverUrl) => {
    expect(() => new SpackMaterialClient({ serverUrl, cacheDir: "/tmp/cache" })).toThrow();
  });

  test.each([
    "https://server.example",
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://[::1]",
  ])("accepts controlled Server origin %s", (serverUrl) => {
    expect(() => new SpackMaterialClient({ serverUrl, cacheDir: "/tmp/cache" })).not.toThrow();
  });

  test.each([
    "/",
    "relative",
    "/tmp/../cache",
    "/tmp/./cache",
  ])("rejects non-dedicated or noncanonical cache path %s", (cacheDir) => {
    expect(
      () => new SpackMaterialClient({ serverUrl: "https://server.example", cacheDir }),
    ).toThrow();
  });

  test("rejects missing ticket/digest and operation path injection without fetching", async () => {
    const f = await fixture();
    for (const invalid of [
      { ticket: "" },
      { ticket: "bad\r\nticket" },
      { manifestDigest: "" },
      { operationId: "../other" },
    ]) {
      await expect(f.client.prepare({ ...input, ...invalid })).rejects.toThrow();
    }
    expect(f.calls).toEqual([]);
  });

  test("rejects manifest checksum before parsing or fetching blobs", async () => {
    const f = await fixture();
    await expect(f.client.prepare({ ...input, manifestDigest: digest("wrong") })).rejects.toThrow(
      "SHA-256",
    );
    expect(f.calls).toHaveLength(1);
  });

  test.each([
    { spec: "zlib@1.2" },
    { spackVersion: "0.23.0" },
  ])("requires the exact requested spec and Spack version", async (mismatch) => {
    const f = await fixture();
    await expect(f.client.prepare({ ...input, ...mismatch })).rejects.toThrow("binding");
    expect(f.calls).toHaveLength(1);
  });

  test("rejects manifest URLs and invalid schema despite a valid digest", async () => {
    const text = JSON.stringify({ ...manifest, url: "https://outside.example/archive" });
    const f = await fixture(undefined, text);
    await expect(f.client.prepare({ ...input, manifestDigest: digest(text) })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  test("bounds manifest bytes to 2 MiB", async () => {
    const text = " ".repeat(2 * 1024 ** 2 + 1);
    const f = await fixture(undefined, text);
    await expect(f.client.prepare({ ...input, manifestDigest: digest(text) })).rejects.toThrow(
      "size",
    );
    expect(f.calls).toHaveLength(1);
  });

  test.each([
    ["checksum", () => new Response("x".repeat(blob.size)), "SHA-256"],
    ["oversize", () => new Response(`${body}!`), "size"],
    ["partial", () => new Response(body.slice(1)), "size"],
    ["missing", () => new Response(null, { status: 404 }), "404"],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://outside.example" } }),
      "redirect",
    ],
  ] as const)("rejects %s blobs and cleans temporary files", async (_name, response, error) => {
    const f = await fixture(response);
    await expect(f.client.prepare(input)).rejects.toThrow(error);
    const files = await readdir(join(f.cacheDir, "sha256"));
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(files).not.toContain(blob.digest.slice(7));
  });

  test("rejects manifest redirects before any blob request", async () => {
    const f = await fixture();
    const client = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: async () => new Response(null, { status: 307 }),
    });
    await expect(client.prepare(input)).rejects.toThrow("redirect");
  });

  test("reverifies cached content and never replaces corrupt immutable entries", async () => {
    const f = await fixture();
    const prepared = await f.client.prepare(input);
    const path = prepared.blobs[0]?.path ?? "";
    await chmod(path, 0o600);
    await writeFile(path, "x".repeat(blob.size));
    await expect(f.client.prepare(input)).rejects.toThrow("SHA-256");
    expect(f.calls.filter((url) => url.includes("/blobs/"))).toHaveLength(1);
  });

  test("rejects cached-file and cache-directory symlinks", async () => {
    const f = await fixture();
    const prepared = await f.client.prepare(input);
    const path = prepared.blobs[0]?.path ?? "";
    await rm(path);
    const outside = join(f.root, "outside");
    await writeFile(outside, body);
    await symlink(outside, path);
    await expect(f.client.prepare(input)).rejects.toThrow();
    await rm(f.cacheDir, { recursive: true });
    await symlink(f.root, f.cacheDir);
    await expect(f.client.prepare(input)).rejects.toThrow("symlink");
  });

  test("aborts a stalled body and cleans its temporary file", async () => {
    const controller = new AbortController();
    const f = await fixture(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(body.slice(0, 2)));
              setTimeout(() => controller.abort(), 10);
            },
          }),
        ),
    );
    await expect(f.client.prepare({ ...input, signal: controller.signal })).rejects.toThrow();
    expect((await readdir(join(f.cacheDir, "sha256"))).some((p) => p.endsWith(".tmp"))).toBe(false);
  });

  test("times out stalled fetch and body implementations even if they ignore AbortSignal", async () => {
    const f = await fixture();
    for (const stalledBody of [false, true]) {
      const client = new SpackMaterialClient({
        serverUrl: "https://server.example",
        cacheDir: f.cacheDir,
        requestTimeoutMs: 10,
        fetch: async (url) => {
          if (stalledBody && url.endsWith("/manifest")) return new Response(manifestBytes);
          if (stalledBody) return new Response(new ReadableStream());
          return new Promise<Response>(() => {});
        },
      });
      await expect(client.prepare(input)).rejects.toThrow("timed out");
      expect((await readdir(join(f.cacheDir, "sha256"))).some((p) => p.endsWith(".tmp"))).toBe(
        false,
      );
    }
  });

  test("rejects expired tickets even with a fully populated cache and never retries", async () => {
    const f = await fixture();
    await f.client.prepare(input);
    let requests = 0;
    const restarted = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: async () => {
        requests++;
        return new Response(null, { status: 401 });
      },
    });
    await expect(restarted.prepare(input)).rejects.toThrow("401");
    expect(requests).toBe(1);
  });

  test("downloads distinct recipe archive, lockfile, and source blobs without extraction", async () => {
    const lock = "opaque lockfile bytes, not a concretization claim";
    const source = "source archive bytes";
    const text = JSON.stringify({
      ...manifest,
      lockfile: { digest: digest(lock), size: Buffer.byteLength(lock) },
      sources: [
        {
          path: "_source-cache/source.tar.gz",
          blob: { digest: digest(source), size: Buffer.byteLength(source) },
        },
      ],
    });
    const f = await fixture(undefined, text);
    const values = new Map([
      [blob.digest, body],
      [digest(lock), lock],
      [digest(source), source],
    ]);
    const client = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: async (url) =>
        new Response(url.endsWith("/manifest") ? text : values.get(url.split("/").at(-1) ?? "")),
    });
    const prepared = await client.prepare({ ...input, manifestDigest: digest(text) });
    expect(prepared.blobs).toHaveLength(3);
    for (const cached of prepared.blobs) {
      const expected = values.get(cached.digest);
      if (expected === undefined) throw new Error("Unexpected cached digest");
      expect(await readFile(cached.path, "utf8")).toBe(expected);
    }
    expect((await readdir(join(f.cacheDir, "sha256"))).length).toBe(4);
  });

  test("bounds concurrent preparations and releases slots after cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const client = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: async () => new Promise<Response>(() => {}),
    });
    const first = client.prepare({ ...input, signal: controller.signal });
    const second = client.prepare({ ...input, signal: controller.signal });
    await expect(client.prepare(input)).rejects.toThrow("concurrency limit");
    controller.abort();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    await expect(client.prepare({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
  });

  test("two independent clients atomically publish identical immutable entries", async () => {
    const f = await fixture();
    const other = new SpackMaterialClient({
      serverUrl: "https://server.example",
      cacheDir: f.cacheDir,
      fetch: f.fetch,
    });
    const results = await Promise.all([f.client.prepare(input), other.prepare(input)]);
    expect(results[0]).toEqual(results[1]);
    const files = await readdir(join(f.cacheDir, "sha256"));
    expect(files.sort()).toEqual([input.manifestDigest.slice(7), blob.digest.slice(7)].sort());
  });

  test("rejects digest aliases with inconsistent declared sizes before blob downloads", async () => {
    const text = JSON.stringify({ ...manifest, lockfile: { ...blob, size: blob.size + 1 } });
    const f = await fixture(undefined, text);
    await expect(f.client.prepare({ ...input, manifestDigest: digest(text) })).rejects.toThrow(
      "conflicting declared sizes",
    );
    expect(f.calls).toHaveLength(1);
  });

  test("rejects stream errors after partial writes and cleans the tempfile", async () => {
    const f = await fixture(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(body.slice(0, 2)));
            },
            pull(stream) {
              stream.error(new Error("connection interrupted"));
            },
          }),
        ),
    );
    await expect(f.client.prepare(input)).rejects.toThrow("connection interrupted");
    expect((await readdir(join(f.cacheDir, "sha256"))).some((p) => p.endsWith(".tmp"))).toBe(false);
  });

  test("rejects oversized Content-Length without reading and non-200 partial responses", async () => {
    for (const response of [
      () => new Response(body, { headers: { "Content-Length": String(blob.size + 1) } }),
      () => new Response(body, { status: 206 }),
    ]) {
      const f = await fixture(response);
      await expect(f.client.prepare(input)).rejects.toThrow();
      expect((await readdir(join(f.cacheDir, "sha256"))).some((p) => p.endsWith(".tmp"))).toBe(
        false,
      );
    }
  });
});
