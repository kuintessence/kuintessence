import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createRegistryHttpHandler, REGISTRY_LEGACY_BODY_BYTES } from "../registry-http";
import { BASE, cleanupMaterials, materialFixture } from "../routes/spack-materials.test-helpers";
import { byteStream, headers, OWNER } from "../routes/spack-repositories.test-helpers";
import {
  consumeMaterialStream,
  MATERIAL_METADATA_BYTES,
  materialDigest,
} from "./spack-material-storage";

afterEach(cleanupMaterials);

test("uploads a multi-chunk body over a real Bun HTTP socket and persists every byte", async () => {
  const f = await materialFixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...createRegistryHttpHandler(f.app.fetch, f.store.limits.maxBlobBytes),
  });
  const bytes = new Uint8Array(1_033_297);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const digest = materialDigest(bytes);
  try {
    const path = join(f.root, "fixture-source");
    await writeFile(path, bytes);
    const url = new URL(
      `${BASE}/blobs?repository=${encodeURIComponent(f.input.repository)}&digest=${digest}`,
      server.url,
    );
    for (const body of [Bun.file(path), bytes]) {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ digest, size: bytes.length });
    }
    expect(
      new Uint8Array(await readFile(join(f.root, "blobs", digest.slice(7, 9), digest.slice(7)))),
    ).toEqual(bytes);
  } finally {
    await server.stop(true);
  }
});

test("the production HTTP boundary accepts >128 MiB only for material blobs", async () => {
  const size = REGISTRY_LEGACY_BODY_BYTES + 1024 * 1024;
  const f = await materialFixture({ maxBlobBytes: size });
  const path = join(f.root, "large-source");
  const digest = await writeChunkedFixture(path, size);
  let jsonCalls = 0;
  let ociCalls = 0;
  let ociBytes = 0;
  const receivedLengths: Array<string | null> = [];
  const receivedEncodings: Array<string | null> = [];
  f.app.post("/api/ordinary-json", async (c) => {
    jsonCalls++;
    return c.json(await c.req.json());
  });
  f.app.patch("/v2/public/test/blobs/uploads/id", async (c) => {
    ociCalls++;
    expect(c.req.header("Content-Length")).toBeUndefined();
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new Error("Missing fixture request body");
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) return c.json({ size: ociBytes });
        ociBytes += item.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  });
  const boundary = createRegistryHttpHandler(f.app.fetch, f.store.limits.maxBlobBytes);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...boundary,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/ordinary-json" || pathname.startsWith("/v2/")) {
        receivedLengths.push(request.headers.get("Content-Length"));
        receivedEncodings.push(request.headers.get("Transfer-Encoding"));
      }
      return boundary.fetch(request);
    },
  });
  const url = new URL(
    `${BASE}/blobs?repository=${encodeURIComponent(f.input.repository)}&digest=${digest}`,
    server.url,
  );
  try {
    const uploaded = await fetch(url, {
      method: "POST",
      headers: headers(OWNER, "application/octet-stream"),
      body: Bun.file(path),
      signal: AbortSignal.timeout(60_000),
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual({ digest, size });
    const stored = join(f.root, "blobs", digest.slice(7, 9), digest.slice(7));
    expect((await stat(stored)).size).toBe(size);
    expect(await digestFile(stored)).toBe(digest);

    const legacyEndpoints = [
      ["/api/ordinary-json", "POST", "application/json"],
      ["/v2/public/test/blobs/uploads/id", "PATCH", "application/octet-stream"],
    ] as const;
    for (const [endpoint, method, type] of legacyEndpoints) {
      // Leave the body incomplete: the server must send 413 and close, not wait for a drain
      // or advertise reuse. This also makes Content-Length independent of Bun.file/sendfile.
      const wire = await readEarlyRejection(new URL(endpoint, server.url), method, type, size);
      const parts = wire.split("\r\n\r\n");
      expect(parts).toHaveLength(2);
      const responseHeaders = parts[0] ?? "";
      const responseBody = parts[1] ?? "";
      expect(responseHeaders).toMatch(/^HTTP\/1\.1 413 /);
      expect(responseHeaders).toMatch(/\r\nconnection: close(?:\r\n|$)/i);
      const length = /\r\ncontent-length: (\d+)(?:\r\n|$)/i.exec(responseHeaders);
      expect(length).not.toBeNull();
      expect(Buffer.byteLength(responseBody)).toBe(Number(length?.[1]));
      expect(JSON.parse(responseBody)).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
      expect(jsonCalls).toBe(0);
      expect(ociCalls).toBe(0);
    }
    expect(receivedLengths).toEqual([String(size), String(size)]);
    expect(receivedEncodings).toEqual([null, null]);
    expect(jsonCalls).toBe(0);
    expect(ociCalls).toBe(0);
    receivedLengths.length = 0;
    receivedEncodings.length = 0;

    // Keep the original file-upload client and default pool across consecutive rejections;
    // explicitly declare the length instead of relying on method-specific inference.
    for (const [endpoint, method, type] of legacyEndpoints) {
      const response = await fetch(new URL(endpoint, server.url), {
        method,
        headers: { "Content-Type": type, "Content-Length": String(size) },
        body: Bun.file(path),
        signal: AbortSignal.timeout(60_000),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("Connection")).toBe("close");
      expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
      expect(jsonCalls).toBe(0);
      expect(ociCalls).toBe(0);
    }
    expect(receivedLengths).toEqual([String(size), String(size)]);
    expect(receivedEncodings).toEqual([null, null]);
    const small = await fetch(new URL("/api/ordinary-json", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({});
    expect(jsonCalls).toBe(1);
    receivedLengths.length = 0;
    receivedEncodings.length = 0;

    const chunked = await fetch(new URL("/v2/public/test/blobs/uploads/id", server.url), {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: Bun.file(path)
        .slice(0, REGISTRY_LEGACY_BODY_BYTES + 1)
        .stream()
        .pipeThrough(new TransformStream<Uint8Array, Uint8Array>()),
      signal: AbortSignal.timeout(60_000),
    });
    expect(chunked.status).toBe(413);
    expect(chunked.headers.get("Connection")).toBe("close");
    expect(await chunked.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(receivedLengths).toEqual([null]);
    expect(receivedEncodings).toEqual(["chunked"]);
    expect(ociCalls).toBe(1);
    expect(ociBytes).toBeGreaterThan(0);
    expect(ociBytes).toBeLessThanOrEqual(REGISTRY_LEGACY_BODY_BYTES);

    await appendFile(path, new Uint8Array([1]));
    const oversized = await fetch(url, {
      method: "POST",
      headers: {
        ...headers(OWNER, "application/octet-stream"),
        "Content-Length": String(size + 1),
      },
      body: Bun.file(path),
      signal: AbortSignal.timeout(60_000),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();
    expect((await stat(stored)).size).toBe(size);
    expect(await readdir(join(f.root, "staging"))).toEqual([]);
  } finally {
    await server.stop(true);
  }
}, 120_000);

test.each([
  false,
  true,
])("material byte limits still reject socket uploads (chunked=%s)", async (chunked) => {
  const f = await materialFixture({ maxBlobBytes: 1024 });
  const path = join(f.root, "oversized-source");
  const digest = await writeChunkedFixture(path, 1025);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...createRegistryHttpHandler(f.app.fetch, f.store.limits.maxBlobBytes),
  });
  try {
    const response = await fetch(
      new URL(
        `${BASE}/blobs?repository=${encodeURIComponent(f.input.repository)}&digest=${digest}`,
        server.url,
      ),
      {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body: chunked
          ? Bun.file(path).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
          : Bun.file(path),
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("Connection")).toBe("close");
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect((await readdir(f.root)).sort()).toEqual(
      chunked ? ["oversized-source", "staging"] : ["oversized-source"],
    );
    if (chunked) expect(await readdir(join(f.root, "staging"))).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("the enlarged listener preserves both 2 MiB material JSON limits", async () => {
  const f = await materialFixture();
  const path = join(f.root, "oversized-json");
  await writeChunkedFixture(path, MATERIAL_METADATA_BYTES + 1);
  const publish = spyOn(f.store, "publish");
  const preflight = spyOn(f.store, "preflightLock");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...createRegistryHttpHandler(f.app.fetch, f.store.limits.maxBlobBytes),
  });
  try {
    for (const endpoint of ["releases", "lock-preflight"]) {
      for (const chunked of [false, true]) {
        const response = await fetch(new URL(`${BASE}/${endpoint}`, server.url), {
          method: "POST",
          headers: headers(),
          body: chunked
            ? Bun.file(path).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
            : Bun.file(path),
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(413);
        expect(response.headers.get("Connection")).toBe("close");
        expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
      }
    }
    expect(publish).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["oversized-json"]);
  } finally {
    await server.stop(true);
    publish.mockRestore();
    preflight.mockRestore();
  }
});

async function readEarlyRejection(
  url: URL,
  method: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  const timer = setTimeout(() => socket.destroy(new Error("Missing early 413 and EOF")), 10_000);
  let wire = "";
  let ended = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `${method} ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n` +
            `Content-Type: ${contentType}\r\nContent-Length: ${contentLength}\r\n` +
            "Connection: keep-alive\r\n\r\n*",
        );
      });
      socket.on("data", (chunk: Buffer) => {
        if (wire.length + chunk.length > 64 * 1024) {
          socket.destroy(new Error("Oversized fixture response"));
          return;
        }
        wire += chunk.toString("latin1");
      });
      socket.once("end", () => {
        ended = true;
        resolve(wire);
      });
      socket.once("close", () => {
        if (!ended) reject(new Error("Socket closed without a complete response and EOF"));
      });
    });
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function writeChunkedFixture(path: string, size: number): Promise<string> {
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  const chunk = new Uint8Array(64 * 1024).fill(42);
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const bytes = chunk.subarray(0, Math.min(chunk.length, size - offset));
      await file.writeFile(bytes);
      hash.update(bytes);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await file.close();
  }
}

async function digestFile(path: string): Promise<string> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const chunk = new Uint8Array(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) return `sha256:${hash.digest("hex")}`;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

test.each([
  false,
  true,
])("reader cleanup cannot replace consumption outcome (failure=%s)", async (failure) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const stream = byteStream(bytes);
  const reader = stream.getReader();
  const getReader = spyOn(stream, "getReader").mockReturnValue(reader);
  const release = reader.releaseLock.bind(reader);
  const releaseLock = spyOn(reader, "releaseLock").mockImplementation(() => {
    throw new TypeError("fixture cleanup error");
  });
  const original = new Error("fixture consumption error");
  try {
    const consumed = consumeMaterialStream(
      stream,
      { maxBytes: 3, totalTimeoutMs: 1000, idleTimeoutMs: 1000 },
      async (chunk) => {
        expect(chunk).toEqual(bytes);
        if (failure) throw original;
      },
    );
    if (failure) await expect(consumed).rejects.toBe(original);
    else expect(await consumed).toBe(bytes.length);
  } finally {
    getReader.mockRestore();
    releaseLock.mockRestore();
    release();
  }
});
