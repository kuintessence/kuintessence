import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpackMaterialCache } from "./material-cache";

test("a new cache instance resumes verified publication from a retained partial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-material-resume-"));
  try {
    const cache = new SpackMaterialCache(join(directory, "cache"));
    await cache.initialize();
    const bytes = Buffer.from("first-half-second-half");
    const blob = {
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.length,
    };
    await expect(
      cache.store(
        blob,
        AbortSignal.timeout(1000),
        async (write) => {
          await write(bytes.subarray(0, 7));
          throw new Error("disconnected");
        },
        true,
      ),
    ).rejects.toThrow("disconnected");
    const restarted = new SpackMaterialCache(join(directory, "cache"));
    let offset = 0;
    const result = await restarted.store(
      blob,
      AbortSignal.timeout(1000),
      async (write, position) => {
        offset = position;
        await write(bytes.subarray(position));
      },
      true,
    );
    expect(offset).toBe(7);
    expect(await readFile(result.path)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt partial cannot poison every subsequent resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-material-corrupt-"));
  try {
    const cache = new SpackMaterialCache(join(directory, "cache"));
    await cache.initialize();
    const bytes = Buffer.from("correct");
    const blob = {
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.length,
    };
    await expect(
      cache.store(
        blob,
        AbortSignal.timeout(1000),
        async (write) => {
          await write(Buffer.from("bad"));
          throw new Error("interrupted");
        },
        true,
      ),
    ).rejects.toThrow();
    await expect(
      cache.store(
        blob,
        AbortSignal.timeout(1000),
        async (write, position) => write(bytes.subarray(position)),
        true,
      ),
    ).rejects.toThrow("SHA-256");
    let offset = -1;
    const result = await cache.store(
      blob,
      AbortSignal.timeout(1000),
      async (write, position) => {
        offset = position;
        await write(bytes.subarray(position));
      },
      true,
    );
    expect(offset).toBe(0);
    expect(await readFile(result.path)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
