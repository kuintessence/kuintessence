import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE,
  cleanupMaterials,
  materialFixture,
} from "../routes/spack-materials.test-helpers";
import { byteStream, headers, OWNER } from "../routes/spack-repositories.test-helpers";
import { consumeMaterialStream, materialDigest } from "./spack-material-storage";

afterEach(cleanupMaterials);

test("uploads a multi-chunk body over a real Bun HTTP socket and persists every byte", async () => {
  const f = await materialFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  const bytes = new Uint8Array(1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const digest = materialDigest(bytes);
  try {
    const response = await fetch(
      new URL(`${BASE}/blobs?repository=${encodeURIComponent(f.input.repository)}&digest=${digest}`, server.url),
      {
        method: "POST",
        headers: headers(OWNER, "application/octet-stream"),
        body: bytes,
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ digest, size: bytes.length });
    expect(
      new Uint8Array(await readFile(join(f.root, "blobs", digest.slice(7, 9), digest.slice(7)))),
    ).toEqual(bytes);
  } finally {
    await server.stop(true);
  }
});

test.each([false, true])("reader cleanup cannot replace consumption outcome (failure=%s)", async (failure) => {
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
