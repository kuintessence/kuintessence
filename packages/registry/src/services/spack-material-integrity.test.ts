import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { appendFile, readdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE,
  cleanupMaterials,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import { byteStream, headers, OWNER, USER } from "../routes/spack-repositories.test-helpers";
import {
  materialDigest,
  readMaterialJson,
  SpackMaterialBlobStore,
  writeMaterialMetadata,
} from "./spack-material-storage";

afterEach(cleanupMaterials);

test("metadata cancellation immediately before commit removes the staged file", async () => {
  const f = await materialFixture();
  const directory = join(f.root, "metadata");
  const path = join(directory, "release.json");
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  const gate = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
    if (gate.mock.calls.length === 2) {
      expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(true);
      controller.abort();
    }
    check();
  });
  try {
    await expect(writeMaterialMetadata(path, SOURCE, controller.signal)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    gate.mockRestore();
  }
  await writeMaterialMetadata(path, SOURCE);
  expect(await readdir(directory)).toEqual(["release.json"]);
});

describe("material integrity after upload receipts", () => {
  test.each([
    "source",
    "lockfile",
  ])("publication rehashes a same-size corrupted %s", async (kind) => {
    const f = await materialFixture();
    await f.seed();
    const blob = kind === "source" ? SOURCE_BLOB : LOCK_BLOB;
    await writeFile(
      join(f.root, "blobs", blob.digest.slice(7, 9), blob.digest.slice(7)),
      new Uint8Array(blob.size).fill(120),
    );
    expect((await f.publish()).status).toBe(500);
    expect(f.recipes.archive).not.toHaveBeenCalled();
    await expect(readdir(join(f.root, "manifests"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("deduplicates digest verification across repeated source and lockfile references", async () => {
    const f = await materialFixture();
    await f.seed();
    f.input.sources = [
      { path: "first/source.tar.gz", blob: LOCK_BLOB },
      { path: "second/source.tar.gz", blob: LOCK_BLOB },
    ];
    const verify = spyOn(SpackMaterialBlobStore.prototype, "verify");
    try {
      await f.store.publish(f.input, OWNER);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith(LOCK_BLOB.digest, LOCK_BLOB.size);
    } finally {
      verify.mockRestore();
    }
  });

  test("deduplication never hides conflicting sizes for the same digest", async () => {
    const f = await materialFixture();
    await f.seed();
    f.input.sources.push({
      path: "second/source.tar.gz",
      blob: { ...SOURCE_BLOB, size: SOURCE_BLOB.size + 1 },
    });
    expect((await f.publish()).status).toBe(422);
    expect(f.recipes.archive).not.toHaveBeenCalled();
  });

  test.each([
    "before-request",
    "after-headers",
  ])("direct Registry GET detects same-size corruption %s without completing Content-Length", async (when) => {
    const f = await materialFixture();
    await f.seed();
    const binding = await f.store.publish(f.input, OWNER);
    const corrupt = () =>
      writeFile(
        join(f.root, "blobs", SOURCE_BLOB.digest.slice(7, 9), SOURCE_BLOB.digest.slice(7)),
        new Uint8Array(SOURCE_BLOB.size).fill(120),
      );
    if (when === "before-request") await corrupt();
    const response = await f.app.request(
      `${BASE}/${binding.repositoryId}/releases/${binding.manifestDigest}/blobs/${SOURCE_BLOB.digest}`,
      { headers: headers(USER) },
    );
    expect(response.status).toBe(200);
    if (when === "after-headers") await corrupt();
    await expect(response.arrayBuffer()).rejects.toMatchObject({ status: 500 });
  });
});

async function largeBlobFixture(chunks = 3) {
  const f = await materialFixture();
  await f.seed();
  const bytes = new Uint8Array(chunks * 64 * 1024 + 31).fill(42);
  const blob = { digest: materialDigest(bytes), size: bytes.byteLength };
  await f.store.upload(f.input.repository, blob.digest, byteStream(bytes));
  const path = join(f.root, "blobs", blob.digest.slice(7, 9), blob.digest.slice(7));
  return { ...f, bytes, blob, path };
}

describe("bounded verified material reads", () => {
  test("bounded JSON reading handles fragmented UTF-8 and rejects invalid encoding", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "\u6d4b\u8bd5", version: 1 }));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    });
    expect(await readMaterialJson(stream)).toEqual({ name: "\u6d4b\u8bd5", version: 1 });
    await expect(readMaterialJson(byteStream(new Uint8Array([0xff])))).rejects.toMatchObject({
      status: 400,
    });
  });

  test("streams intact blobs in bounded chunks without retaining the whole file", async () => {
    const f = await largeBlobFixture();
    const store = new SpackMaterialBlobStore(f.root);
    const { stream } = await store.get(f.blob.digest, f.blob.size);
    const reader = stream.getReader();
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        expect(result.value.byteLength).toBeLessThanOrEqual(64 * 1024);
        expect(result.value).toEqual(f.bytes.subarray(size, size + result.value.byteLength));
        size += result.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    expect(size).toBe(f.blob.size);
  });

  test.each([
    "same-size",
    "truncated",
    "extended",
  ])("fails on %s mutation after opening without delivering a complete invalid blob", async (corruption) => {
    const f = await largeBlobFixture();
    const store = new SpackMaterialBlobStore(f.root);
    const { stream } = await store.get(f.blob.digest, f.blob.size);
    if (corruption === "truncated") await truncate(f.path, f.blob.size - 1);
    else if (corruption === "extended") await appendFile(f.path, new Uint8Array([0]));
    else {
      f.bytes[f.bytes.length - 1] = 43;
      await writeFile(f.path, f.bytes);
    }
    const reader = stream.getReader();
    let size = 0;
    const consume = async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done) return;
        size += result.value.byteLength;
        expect(result.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      }
    };
    try {
      await expect(consume()).rejects.toMatchObject({ status: 500 });
    } finally {
      reader.releaseLock();
    }
    expect(size).toBeLessThan(f.blob.size);
    // Integrity failures release read capacity, including when repeated.
    for (let index = 0; index < 5; index += 1) {
      await store.verify(SOURCE_BLOB.digest, SOURCE_BLOB.size);
    }
  });

  test("bounds simultaneous reads at four and releases capacity on cancellation", async () => {
    const f = await largeBlobFixture();
    const store = new SpackMaterialBlobStore(f.root);
    const reads = await Promise.all(
      Array.from({ length: 4 }, () => store.get(f.blob.digest, f.blob.size)),
    );
    try {
      await expect(store.get(f.blob.digest, f.blob.size)).rejects.toMatchObject({ status: 429 });
      const first = reads[0];
      if (!first) throw new Error("Missing fixture stream");
      const reader = first.stream.getReader();
      try {
        expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      await store.verify(SOURCE_BLOB.digest, SOURCE_BLOB.size);
    } finally {
      await Promise.all(reads.map(({ stream }) => stream.cancel()));
    }
  });

  test.each([
    "idle",
    "lifetime",
  ])("expires unread streams on %s timeout and frees capacity", async (kind) => {
    const f = await materialFixture();
    await f.seed();
    const store = new SpackMaterialBlobStore(f.root, {
      idleTimeoutMs: kind === "idle" ? 40 : 1000,
      lifetimeMs: kind === "lifetime" ? 40 : 1000,
    });
    const reads = await Promise.all(
      Array.from({ length: 4 }, () => store.get(SOURCE_BLOB.digest, SOURCE_BLOB.size)),
    );
    await Bun.sleep(120);
    for (const { stream } of reads) {
      const reader = stream.getReader();
      try {
        await expect(reader.read()).rejects.toMatchObject({ status: 408 });
      } finally {
        reader.releaseLock();
      }
    }
    const recovered = await store.get(SOURCE_BLOB.digest, SOURCE_BLOB.size);
    await recovered.stream.cancel();
  });

  test("absolute lifetime still expires while a slow reader makes progress", async () => {
    const f = await largeBlobFixture(64);
    const store = new SpackMaterialBlobStore(f.root, { lifetimeMs: 120, idleTimeoutMs: 1000 });
    const { stream } = await store.get(f.blob.digest, f.blob.size);
    const reader = stream.getReader();
    let size = 0;
    try {
      await expect(
        (async () => {
          for (;;) {
            const result = await reader.read();
            if (result.done) return;
            size += result.value.byteLength;
            await Bun.sleep(10);
          }
        })(),
      ).rejects.toMatchObject({ status: 408, message: "Material read lifetime exceeded" });
    } finally {
      reader.releaseLock();
    }
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(f.blob.size);
    const recovered = await store.get(SOURCE_BLOB.digest, SOURCE_BLOB.size);
    await recovered.stream.cancel();
  });

  test("missing or invalid-size files release capacity before streaming begins", async () => {
    const f = await materialFixture();
    await f.seed();
    const store = new SpackMaterialBlobStore(f.root);
    for (let index = 0; index < 5; index += 1) {
      await expect(store.get(`sha256:${"f".repeat(64)}`, 1)).rejects.toMatchObject({ status: 404 });
      await expect(store.get(SOURCE_BLOB.digest, SOURCE.length + 1)).rejects.toMatchObject({
        status: 500,
      });
    }
    await store.verify(SOURCE_BLOB.digest, SOURCE_BLOB.size);
  });
});
