import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb, softwareAssets, softwareMirrorCache } from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { SoftwareMirrorWorker } from "./mirror-worker";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Mirror tests require an isolated unit database");
const db = createPgDb(url);
afterAll(() => db.$client.end());
test("mirror sources and native binaries publish as one inventory and shared bytes survive partial release", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-mirror-"));
  const ids = [randomUUID(), randomUUID()] as const;
  try {
    for (const id of ids)
      await db
        .insert(softwareAssets)
        .values({ id, kind: "spack-package", name: "hello", version: "1", source: "sp-published" });
    const src = "source",
      binary = "binary",
      hash = (v: string) => createHash("sha256").update(v).digest("hex");
    let wrong = true,
      calls = 0;
    const fetcher = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls++;
        return new Response(input.toString().endsWith("src") ? src : wrong ? "bad" : binary);
      },
      { preconnect: fetch.preconnect },
    );
    const worker = () => new SoftwareMirrorWorker(db, root, ["https://mirror.test"], fetcher);
    const a = worker(),
      b = worker();
    const files = [
      {
        kind: "source",
        path: "archive/hello.tar.gz",
        sizeBytes: src.length,
        sha256: hash(src),
        sourceUrl: "https://mirror.test/src",
      },
      {
        kind: "buildcache",
        path: "build_cache/hello.spack",
        sizeBytes: binary.length,
        sha256: hash(binary),
        sourceUrl: "https://mirror.test/bin",
      },
    ] as const;
    const inventory = { files };
    await Promise.all([a.enqueue(ids[0], inventory), b.enqueue(ids[0], inventory)]);
    await Promise.all([a.tick(), b.tick()]);
    await a.tick();
    expect(
      (await db.select().from(softwareMirrorCache).where(eq(softwareMirrorCache.assetId, ids[0])))
        .map((r) => r.status)
        .sort(),
    ).toEqual(["cached", "failed"]);
    await expect(a.openFile(ids[0], files[0].path)).rejects.toThrow();
    wrong = false;
    await b.enqueue(ids[0], inventory);
    await b.tick();
    expect(await (await b.openFile(ids[0], files[1].path)).text()).toBe(binary);
    await expect(
      b.enqueue(ids[0], { files: [{ ...files[0], sha256: hash("other") }] }),
    ).rejects.toThrow();
    await expect(
      b.enqueue(ids[1], { files: [{ ...files[0], sourceUrl: "https://other.test/src" }] }),
    ).rejects.toThrow();
    await b.enqueue(ids[1], { files: [files[0]] });
    const prior = calls;
    await b.tick();
    expect(calls).toBe(prior);
    await a.release(ids[0]);
    await a.tick();
    expect(await readdir(join(root, "kq-mirror-objects"))).toEqual([hash(src)]);
    await db.delete(softwareAssets).where(eq(softwareAssets.id, ids[1]));
    await a.tick();
    expect(await readdir(join(root, "kq-mirror-objects"))).toEqual([]);
  } finally {
    await db.delete(softwareAssets).where(inArray(softwareAssets.id, [...ids]));
    await rm(root, { recursive: true, force: true });
  }
});
