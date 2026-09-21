import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflate } from "node:zlib";
import { DEFAULT_RECIPE_LIMITS, type RecipeStoreLimits } from "./recipe-git";
import { preflightRecipeBundle } from "./recipe-pack-preflight";

const exec = promisify(execFile);
const directories: string[] = [];
const V2 = `# v2 git bundle\n${"a".repeat(40)} HEAD\n\n`;
const V3 = `# v3 git bundle\n@object-format=sha1\n${"a".repeat(40)} HEAD\n\n`;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "kq-pack-preflight-"));
  directories.push(path);
  return path;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Buffer.from(bytes);
}

function objectHeader(type: number, size: number): Buffer {
  const first = (type << 4) | (size % 16);
  const rest = Math.floor(size / 16);
  return rest ? Buffer.concat([Buffer.from([first | 128]), varint(rest)]) : Buffer.from([first]);
}

function object(type: number, body: Buffer, base = Buffer.alloc(0), size = body.length): Buffer {
  return Buffer.concat([objectHeader(type, size), base, deflateSync(body)]);
}

function bundle(
  objects: Buffer[],
  options: { count?: number; header?: string; version?: number } = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(options.version ?? 2, 4);
  header.writeUInt32BE(options.count ?? objects.length, 8);
  const pack = Buffer.concat([header, ...objects]);
  return Buffer.concat([
    Buffer.from(options.header ?? V2),
    pack,
    createHash("sha1").update(pack).digest(),
  ]);
}

async function check(bytes: Buffer, limits: Partial<RecipeStoreLimits> = {}): Promise<void> {
  const path = join(await directory(), "input.bundle");
  await writeFile(path, bytes);
  await preflightRecipeBundle(path, { ...DEFAULT_RECIPE_LIMITS, ...limits });
}

function delta(source: number, target: number, instructions = Buffer.from([1, 65])): Buffer {
  return Buffer.concat([varint(source), varint(target), instructions]);
}

async function gitFixture() {
  const root = await directory();
  const source = join(root, "source");
  await mkdir(source);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Preflight Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Preflight Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", source, ...args], { env })).stdout;
  const pack = (...args: string[]) =>
    new Promise<Buffer>((resolve, reject) => {
      execFile(
        "git",
        ["-C", source, "pack-objects", "--stdout", "--revs", "--all", ...args],
        { env, encoding: "buffer", timeout: 10_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ).stdin?.end();
    });
  await git("init", "--template=", "--initial-branch=main", "--object-format=sha1");
  return { root, source, git, pack };
}

async function verifyBundle(path: string, git: (...args: string[]) => Promise<string>) {
  const bytes = await readFile(path);
  const pack = bytes.subarray(bytes.indexOf("\n\n") + 2);
  const packPath = `${path}.pack`;
  await writeFile(packPath, pack);
  await git("index-pack", packPath);
  const verification = await git("verify-pack", "-v", `${path}.idx`);
  return verification
    .split("\n")
    .filter((line) => /^[a-f0-9]{40} \w+\s+\d+ \d+ \d+ \d+ [a-f0-9]{40}$/.test(line))
    .map((line) => {
      const fields = line.split(/\s+/);
      return { type: (pack.readUInt8(Number(fields[4])) >> 4) & 7, depth: Number(fields[5]) };
    });
}

describe("recipe pack preflight", () => {
  test("accepts v2/v3 SHA-1, all base object types, pack versions 2/3 and empty blobs", async () => {
    for (const header of [V2, V3, V3.replace("@object-format=sha1\n", "")]) {
      for (const version of [2, 3]) {
        await check(
          bundle(
            [1, 2, 3, 4]
              .map((type) => object(type, Buffer.from("content")))
              .concat(object(3, Buffer.alloc(0))),
            { header, version },
          ),
        );
      }
    }
  });

  test("leaves HEAD existence and reference resolution to Git", async () => {
    await check(
      bundle([object(3, Buffer.from("content"))], {
        header: V2.replace(" HEAD", " refs/heads/main"),
      }),
    );
  });

  test("bounds actual inflated bytes even when a tiny pack lies about its object size", async () => {
    const bytes = bundle([object(3, Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(0), 8)]);
    expect(bytes.length).toBeLessThan(4096);
    await expect(check(bytes, { maxFileBytes: 32 })).rejects.toMatchObject({ status: 413 });
  });

  test("rejects oversized advertised objects before attempting malformed compressed data", async () => {
    await expect(
      check(bundle([Buffer.concat([objectHeader(3, 33), Buffer.from("not zlib")])]), {
        maxFileBytes: 32,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("enforces cumulative bytes and inclusive per-object limits", async () => {
    const bytes = bundle([object(3, Buffer.alloc(16)), object(3, Buffer.alloc(16))]);
    await check(bytes, { maxFileBytes: 16, maxExpandedBytes: 32 });
    await expect(check(bytes, { maxExpandedBytes: 31 })).rejects.toMatchObject({ status: 413 });
  });

  test("caps packed object count before parsing entries using the history limit", async () => {
    await expect(check(bundle([], { count: 11 }), { maxFiles: 1 })).rejects.toMatchObject({
      status: 413,
    });
    await check(bundle(Array.from({ length: 10 }, () => object(3, Buffer.alloc(0)))), {
      maxFiles: 1,
    });
  });

  test("enforces upload size without relying on the caller", async () => {
    await expect(check(bundle([]), { maxBundleBytes: 1 })).rejects.toMatchObject({ status: 413 });
  });

  test("enforces a whole-preflight deadline while allowing the event loop to run", async () => {
    const bytes = bundle(Array.from({ length: 30_000 }, () => object(3, Buffer.alloc(0))));
    const path = join(await directory(), "many.bundle");
    await writeFile(path, bytes);
    let ticks = 0;
    const interval = setInterval(() => ticks++, 1);
    const started = performance.now();
    try {
      await expect(
        preflightRecipeBundle(path, { ...DEFAULT_RECIPE_LIMITS, gitTimeoutMs: 20 }),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("deadline") });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(interval);
    }
    await expect(check(bytes, { gitTimeoutMs: 0 })).rejects.toMatchObject({ status: 422 });
  });

  test("rejects non-finite, negative and unsafe budgets instead of disabling safeguards", async () => {
    for (const limits of [
      { maxFileBytes: Number.NaN },
      { maxExpandedBytes: Number.POSITIVE_INFINITY },
      { maxFiles: Number.MAX_SAFE_INTEGER },
      { maxBundleBytes: -1 },
      { gitTimeoutMs: -1 },
    ]) {
      await expect(check(bundle([]), limits)).rejects.toMatchObject({ status: 500 });
    }
  });

  test("bounds OFS chains and conservatively charges unresolved REF chains", async () => {
    for (const type of [6, 7]) {
      const entries = [object(3, Buffer.from("A"))];
      for (let depth = 1; depth <= 65; depth++) {
        const previous = entries[entries.length - 1];
        if (!previous) throw new Error("Missing test base");
        const base = type === 6 ? Buffer.from([previous.length]) : Buffer.alloc(20, 1);
        entries.push(object(type, delta(1, 1), base));
        if (depth === 64) await check(bundle(entries));
      }
      await expect(check(bundle(entries))).rejects.toMatchObject({ status: 413 });
    }
  });

  test("bounds mixed REF/OFS depth even when each known segment is short", async () => {
    const entries = [object(3, Buffer.from("A"))];
    for (let index = 0; index < 33; index++) {
      const ref = object(7, delta(1, 1), Buffer.alloc(20, 1));
      entries.push(ref, object(6, delta(1, 1), Buffer.from([ref.length])));
    }
    await expect(check(bundle(entries))).rejects.toMatchObject({ status: 413 });
  });

  test("resolves forward REF bases and independent REF/OFS branches without applying deltas", async () => {
    const fullBase = object(3, Buffer.from("A"));
    const baseId = createHash("sha1").update("blob 1\0A").digest();
    const branches: Buffer[] = [];
    for (let index = 0; index < 100; index++) {
      const ref = object(7, delta(1, 1), baseId);
      branches.push(ref, object(6, delta(1, 1), Buffer.from([ref.length])));
    }
    await check(bundle([...branches, fullBase]));
  });

  for (const type of [6, 7]) {
    const first = object(3, Buffer.from("A"));
    const base = type === 6 ? Buffer.from([first.length]) : Buffer.alloc(20, 1);
    test(`bounds type ${type} delta source and target sizes separately from instructions`, async () => {
      await check(bundle([first, object(type, delta(1, 1), base)]));
      for (const body of [delta(65, 1), delta(1, 65)]) {
        await expect(
          check(bundle([first, object(type, body, base)]), { maxFileBytes: 64 }),
        ).rejects.toMatchObject({ status: 413 });
      }
    });

    test(`charges type ${type} delta instructions AND targets to the total budget`, async () => {
      const second = object(type, delta(1, 12), base);
      const thirdBase = type === 6 ? Buffer.from([first.length + second.length]) : base;
      const bytes = bundle([first, second, object(type, delta(1, 12), thirdBase)]);
      await check(bytes, { maxExpandedBytes: 33 });
      await expect(check(bytes, { maxExpandedBytes: 32 })).rejects.toMatchObject({ status: 413 });
      await expect(check(bytes, { maxExpandedBytes: 4 })).rejects.toMatchObject({ status: 413 });
    });

    test(`bounds type ${type} delta instruction expansion, including a lying size`, async () => {
      const body = delta(1, 1, Buffer.alloc(1024 * 1024));
      for (const size of [body.length, 4]) {
        await expect(
          check(bundle([first, object(type, body, base, size)]), { maxFileBytes: 64 }),
        ).rejects.toMatchObject({ status: 413 });
      }
    });

    test(`rejects truncated or overflowing type ${type} delta size varints`, async () => {
      for (const body of [
        Buffer.alloc(0),
        Buffer.from([128]),
        Buffer.from([1, 128]),
        Buffer.alloc(16, 255),
      ]) {
        await expect(check(bundle([first, object(type, body, base)]))).rejects.toMatchObject({
          status: 422,
        });
      }
    });
  }

  test("rejects invalid OFS base offsets and truncated REF base IDs", async () => {
    const first = object(3, Buffer.from("A"));
    for (const base of [
      Buffer.from([0]),
      Buffer.from([127]),
      Buffer.from([first.length - 1]),
      Buffer.alloc(16, 255),
    ]) {
      await expect(check(bundle([first, object(6, delta(1, 1), base)]))).rejects.toMatchObject({
        status: 422,
      });
    }
    await expect(check(bundle([Buffer.from([0x71, 0])]))).rejects.toMatchObject({ status: 422 });
  });

  test("rejects malformed, unsupported, prerequisite and oversized bundle headers", async () => {
    for (const header of [
      V2.replace("v2", "v1"),
      V3.replace("sha1", "sha256"),
      V3.replace("@object-format=sha1", "@filter=blob:none"),
      V3.replace("@object-format=sha1", "@object-format=sha1\n@object-format=sha1"),
      V2.replace("\n\n", "\n@object-format=sha1\n\n"),
      V2.replace("a".repeat(40), "a".repeat(39)),
      V2.replace(" HEAD", " "),
      V2.replace(" HEAD", "\tHEAD"),
      V2.replace(" HEAD", " HE AD"),
      V2.replace(" HEAD", " HE\tAD"),
      V2.replace(" HEAD", " HE\u007fAD"),
      V2.replace(" HEAD", " HE\0AD"),
      V2.replace(" HEAD", " HEAD\r"),
      `# v2 git bundle\n-${"b".repeat(40)} prerequisite\n${"a".repeat(40)} HEAD\n\n`,
      `# v2 git bundle\n${"a".repeat(70 * 1024)}\n\n`,
      "# v2 git bundle\n",
    ]) {
      await expect(check(bundle([], { header }))).rejects.toMatchObject({ status: 422 });
    }
  });

  test("rejects malformed pack headers, types, varints and mismatched uncompressed sizes", async () => {
    for (const bytes of [
      bundle([], { version: 1 }),
      bundle([], { count: 1 }),
      bundle([object(0, Buffer.alloc(0))]),
      bundle([object(5, Buffer.alloc(0))]),
      bundle([Buffer.from([0xb0])]),
      bundle([Buffer.concat([Buffer.from([0xb0]), Buffer.alloc(16, 255)])]),
      bundle([object(3, Buffer.from("small"), Buffer.alloc(0), 6)]),
      bundle([object(3, Buffer.from("nonempty"), Buffer.alloc(0), 0)]),
    ]) {
      await expect(check(bytes)).rejects.toThrow();
    }
    await expect(check(Buffer.from(V2))).rejects.toMatchObject({ status: 422 });
    const wrongMagic = bundle([]);
    wrongMagic[Buffer.byteLength(V2)] = 0;
    await expect(check(wrongMagic)).rejects.toMatchObject({ status: 422 });
    const highBitMagic = bundle([]);
    highBitMagic[Buffer.byteLength(V2)] = 0xd0;
    const packEnd = highBitMagic.length - 20;
    createHash("sha1")
      .update(highBitMagic.subarray(Buffer.byteLength(V2), packEnd))
      .digest()
      .copy(highBitMagic, packEnd);
    await expect(check(highBitMagic)).rejects.toMatchObject({ status: 422 });
  });

  test("rejects truncation, invalid zlib checksum, extra compressed streams and pack hash mismatch", async () => {
    const entry = object(3, Buffer.from("content"));
    const badAdler = Buffer.from(entry);
    badAdler[badAdler.length - 1] = badAdler.readUInt8(badAdler.length - 1) ^ 1;
    const badHash = bundle([entry]);
    badHash[badHash.length - 1] = badHash.readUInt8(badHash.length - 1) ^ 1;
    for (const bytes of [
      bundle([entry.subarray(0, -1)]),
      bundle([badAdler]),
      bundle([Buffer.concat([entry, deflateSync(Buffer.from("extra"))])]),
      bundle([entry, Buffer.from("trailing")], { count: 1 }),
      Buffer.concat([bundle([entry]), Buffer.from("trailing")]),
      bundle([entry]).subarray(0, -1),
      badHash,
    ]) {
      await expect(check(bytes)).rejects.toMatchObject({ status: 422 });
    }
  });

  test("Bun inflate is asynchronous, exposes consumed input and honors maxOutputLength", async () => {
    const compressed = deflateSync(Buffer.alloc(1024 * 1024));
    let returned = false;
    const completed = new Promise<void>((resolve, reject) => {
      inflate(
        Buffer.concat([compressed, Buffer.from("tail")]),
        { info: true, maxOutputLength: 1024 * 1024 },
        (error, result: unknown) => {
          if (error) return reject(error);
          try {
            expect(returned).toBe(true);
            expect(result).toMatchObject({ engine: { bytesWritten: compressed.length } });
            resolve();
          } catch (failure) {
            reject(failure);
          }
        },
      );
    });
    returned = true;
    await completed;
    await expect(
      new Promise((resolve, reject) => {
        inflate(compressed, { info: true, maxOutputLength: 32 }, (error, result) =>
          error ? reject(error) : resolve(result),
        );
      }),
    ).rejects.toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" });
  });

  test("accepts real v2/v3 HEAD bundles containing UTF-8 refs with a 0xa0 continuation byte", async () => {
    const { root, source, git } = await gitFixture();
    const branch = "\u4f60\u597d";
    expect(Buffer.from(branch).includes(0xa0)).toBe(true);
    await writeFile(join(source, "recipe.py"), "recipe\n");
    await git("add", ".");
    await git("commit", "-m", "UTF-8 reference fixture");
    await git("branch", branch);
    for (const version of [2, 3]) {
      const path = join(root, `utf8-v${version}.bundle`);
      await git("bundle", "create", `--version=${version}`, path, "HEAD", `refs/heads/${branch}`);
      await git("bundle", "verify", path);
      const heads = await git("bundle", "list-heads", path);
      expect(heads).toContain(" HEAD\n");
      expect(heads).toContain(` refs/heads/${branch}\n`);
      await preflightRecipeBundle(path, DEFAULT_RECIPE_LIMITS);
    }
  }, 20_000);

  test("accepts ordinary real local HEAD bundles with actual Git-generated deltas", async () => {
    const { root, source, git } = await gitFixture();
    const lines = Array.from(
      { length: 1000 },
      (_, index) => `recipe-${index}: ${"content".repeat(8)}\n`,
    );
    for (let revision = 0; revision < 5; revision++) {
      lines[revision * 20] = `changed-${revision}\n`;
      await writeFile(join(source, "recipes.txt"), lines.join(""));
      await git("add", ".");
      await git("commit", "-m", `revision ${revision}`);
    }
    await git("repack", "-adf", "--depth=20", "--window=20");
    for (const version of [2, 3]) {
      const path = join(root, `v${version}.bundle`);
      await git("bundle", "create", `--version=${version}`, path, "HEAD");
      await preflightRecipeBundle(path, DEFAULT_RECIPE_LIMITS);
      expect((await verifyBundle(path, git)).length).toBeGreaterThan(0);
    }
  }, 20_000);

  test("accepts a default root-commit bundle with more than 64 similar independent files", async () => {
    const { root, source, git, pack } = await gitFixture();
    const common = Array.from({ length: 1000 }, (_, index) => `common recipe line ${index}\n`).join(
      "",
    );
    for (let index = 0; index < 100; index++) {
      await writeFile(join(source, `recipe-${index}.py`), `${common}package variant ${index}\n`);
    }
    await git("add", ".");
    await git("commit", "-m", "one root snapshot");
    const path = join(root, "default.bundle");
    await git("bundle", "create", path, "HEAD");
    const deltas = await verifyBundle(path, git);
    expect(deltas.length).toBeGreaterThan(64);
    await preflightRecipeBundle(path, DEFAULT_RECIPE_LIMITS);

    const original = await readFile(path);
    const refPath = join(root, "refs.bundle");
    await writeFile(
      refPath,
      Buffer.concat([
        original.subarray(0, original.indexOf("\n\n") + 2),
        await pack("--no-delta-base-offset"),
      ]),
    );
    const refDeltas = await verifyBundle(refPath, git);
    expect(refDeltas.filter((entry) => entry.type === 7).length).toBeGreaterThan(64);
    await preflightRecipeBundle(refPath, DEFAULT_RECIPE_LIMITS);

    const flatPath = join(root, "flat.bundle");
    await git("-c", "pack.window=0", "bundle", "create", flatPath, "HEAD");
    expect(await verifyBundle(flatPath, git)).toHaveLength(0);
    await preflightRecipeBundle(flatPath, DEFAULT_RECIPE_LIMITS);
  }, 20_000);
});
