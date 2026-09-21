import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createRecipeTextReader,
  DEFAULT_RECIPE_LIMITS,
  parseRecipeTree,
  RecipeStoreError,
  runRecipeGit,
  writeRecipeBundle,
} from "./recipe-git";

const exec = promisify(execFile);
const directories: string[] = [];
const temporaryRoot = new URL("../../../../temp/", import.meta.url);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(fileURLToPath(new URL("recipe-git-", temporaryRoot)));
  directories.push(directory);
  return directory;
}

async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Test operation did not settle")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function killFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

describe("writeRecipeBundle resource limits", () => {
  test("a steady trickle cannot extend the total upload deadline", async () => {
    const path = join(await fixture(), "input.bundle");
    let interval: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
        interval = setInterval(() => source.enqueue(new Uint8Array([1])), 10);
      },
      cancel() {
        canceled = true;
        clearInterval(interval);
      },
    });
    const started = performance.now();
    try {
      await expect(
        within(
          writeRecipeBundle(path, stream, 10_000, {
            idleTimeoutMs: 500,
            totalTimeoutMs: 80,
          }),
        ),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("deadline") });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(stream.locked).toBe(false);
    } finally {
      clearInterval(interval);
      if (!canceled) controller?.close();
    }
  });

  test("an idle stream expires before its total deadline and a hanging cancel cannot block cleanup", async () => {
    const path = join(await fixture(), "input.bundle");
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => {});
      },
    });
    try {
      await expect(
        within(
          writeRecipeBundle(path, stream, 10, {
            idleTimeoutMs: 40,
            totalTimeoutMs: 1000,
          }),
        ),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("idle") });
      expect(stream.locked).toBe(false);
    } finally {
      if (!canceled) controller?.close();
    }
  });

  test("a rejecting cancellation preserves the upload limit error and releases the reader", async () => {
    const path = join(await fixture(), "input.bundle");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });
    await expect(writeRecipeBundle(path, stream, 1)).rejects.toMatchObject({
      name: "RecipeStoreError",
      status: 413,
    });
    expect(stream.locked).toBe(false);
  });

  test("stream read failures keep their identity and release the reader", async () => {
    const failure = new Error("upstream disconnected");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    await expect(writeRecipeBundle(join(await fixture(), "input.bundle"), stream, 10)).rejects.toBe(
      failure,
    );
    expect(stream.locked).toBe(false);
  });

  test.each([
    "locked",
    "oversize",
    "timeout",
    "success",
  ])("closes the real file after %s", async (mode) => {
    const path = join(await fixture(), "input.bundle");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "timeout" || mode === "locked") return;
        controller.enqueue(new Uint8Array([1, 2]));
        if (mode === "success") controller.close();
      },
    });
    const reader = mode === "locked" ? stream.getReader() : undefined;
    const opened: fs.FileHandle[] = [];
    const original = fs.open;
    const observation = spyOn(fs, "open").mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        opened.push(file);
        return file;
      },
    );
    try {
      const upload = writeRecipeBundle(path, stream, mode === "oversize" ? 1 : 10, {
        idleTimeoutMs: 40,
        totalTimeoutMs: 1000,
      });
      if (mode === "success") await upload;
      else await expect(upload).rejects.toThrow();
      expect(opened).toHaveLength(1);
      expect(opened[0]?.fd).toBe(-1);
      expect(stream.locked).toBe(mode === "locked");
    } finally {
      observation.mockRestore();
      reader?.releaseLock();
      await Promise.all(opened.map((file) => file.close()));
    }
  });

  test("hashes all chunks, closes the file, and releases a successful stream", async () => {
    const directory = await fixture();
    const bytes = Buffer.from("recipe bundle content");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    });
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await writeRecipeBundle(join(directory, "stream.bundle"), stream, bytes.length)).toBe(
      expected,
    );
    expect(await fs.readFile(join(directory, "stream.bundle"))).toEqual(bytes);
    expect(stream.locked).toBe(false);
    expect(await writeRecipeBundle(join(directory, "bytes.bundle"), bytes, bytes.length)).toBe(
      expected,
    );
  });

  test("invalid deadlines cannot disable timeouts or create an output file", async () => {
    const path = join(await fixture(), "input.bundle");
    for (const totalTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(
        writeRecipeBundle(path, new Uint8Array([1]), 1, { totalTimeoutMs }),
      ).rejects.toMatchObject({ status: 500 });
      expect(await Bun.file(path).exists()).toBe(false);
    }
  });
});

describe("recipe Git text and identity", () => {
  test.each([
    "repo.yaml",
    "packages/example/package.py",
  ])("invalid UTF-8 names the metadata file %s", async (path) => {
    const directory = await fixture();
    await exec("git", ["init", "--bare", "--template=", directory]);
    const bytes = Buffer.from([0xc3, 0x28]);
    const input = join(directory, "invalid");
    await fs.writeFile(input, bytes);
    const oid = (await exec("git", ["-C", directory, "hash-object", "-w", input])).stdout.trim();
    const file = { path, oid, size: bytes.length };
    const read = createRecipeTextReader(directory, [file], DEFAULT_RECIPE_LIMITS);
    await expect(read(file)).rejects.toMatchObject({
      name: "RecipeStoreError",
      status: 422,
      message: expect.stringContaining(path),
    });
  });

  test("invalid UTF-8 in a tree path becomes a contextual 422", () => {
    const tree = Buffer.concat([
      Buffer.from(`100644 blob ${"a".repeat(40)} 1\tpackages/`),
      Buffer.from([0xff]),
      Buffer.from("/package.py\0"),
    ]);
    expect(() => parseRecipeTree(tree, DEFAULT_RECIPE_LIMITS)).toThrow(RecipeStoreError);
    try {
      parseRecipeTree(tree, DEFAULT_RECIPE_LIMITS);
    } catch (error) {
      expect(error).toMatchObject({ status: 422, message: expect.stringContaining("packages/") });
    }
  });

  test("commit-tree has deterministic author and committer identities without Git config", async () => {
    const directory = await fixture();
    await exec("git", ["init", "--bare", "--template=", directory]);
    const tree = await runRecipeGit(directory, ["mktree"], DEFAULT_RECIPE_LIMITS, false, "");
    const commit = await runRecipeGit(
      directory,
      ["commit-tree", tree.stdout.toString().trim()],
      DEFAULT_RECIPE_LIMITS,
      false,
      "audit event\n",
    );
    const result = await runRecipeGit(
      directory,
      ["cat-file", "-p", commit.stdout.toString().trim()],
      DEFAULT_RECIPE_LIMITS,
    );
    expect(result.stdout.toString()).toContain(
      "author Kuintessence Registry <registry@example.invalid>",
    );
    expect(result.stdout.toString()).toContain(
      "committer Kuintessence Registry <registry@example.invalid>",
    );
  });

  test("allowFailure preserves ordinary Git exit codes even when Git rejects pending stdin", async () => {
    const directory = await fixture();
    const result = await runRecipeGit(
      directory,
      ["not-a-real-subcommand"],
      DEFAULT_RECIPE_LIMITS,
      true,
      "x".repeat(1024 * 1024),
    );
    expect(result.code).not.toBe(0);
    await expect(
      runRecipeGit(directory, ["not-a-real-subcommand"], DEFAULT_RECIPE_LIMITS),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("allowFailure cannot suppress a failure to start Git", async () => {
    const directory = await fixture();
    const path = process.env.PATH;
    try {
      process.env.PATH = directory;
      await expect(
        within(runRecipeGit(directory, ["version"], DEFAULT_RECIPE_LIMITS, true)),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });
});

describe("recipe Git process deadlines", () => {
  const posixTest = process.platform === "win32" ? test.skip : test;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  posixTest("caller cancellation terminates a running staging Git process", async () => {
    const directory = await fixture();
    const ready = join(directory, "ready");
    const script = join(directory, "cancel.mjs");
    await fs.writeFile(
      script,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
    );
    const controller = new AbortController();
    const pending = runRecipeGit(
      directory,
      ["-c", `alias.cancel-test=!${quote(process.execPath)} ${quote(script)}`, "cancel-test"],
      DEFAULT_RECIPE_LIMITS,
      true,
      undefined,
      controller.signal,
    );
    const outcome = pending.then(
      () => new Error("Git unexpectedly succeeded"),
      (error: unknown) => error,
    );
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await Bun.file(ready).exists()) break;
        await pause(10);
      }
      expect(await Bun.file(ready).exists()).toBe(true);
      controller.abort();
      expect(await within(outcome)).toMatchObject({ status: 422 });
    } finally {
      controller.abort();
      await within(outcome);
    }
  });

  for (const output of ["stdout", "stderr"]) {
    posixTest(`caps ${output} even with allowFailure`, async () => {
      const directory = await fixture();
      const script = join(directory, "output.mjs");
      await fs.writeFile(script, `process.${output}.write(Buffer.alloc(33 * 1024 * 1024));`);
      await expect(
        within(
          runRecipeGit(
            directory,
            ["-c", `alias.output-test=!${quote(process.execPath)} ${quote(script)}`, "output-test"],
            { ...DEFAULT_RECIPE_LIMITS, gitTimeoutMs: 5000 },
            true,
          ),
        ),
      ).rejects.toMatchObject({ status: 422 });
    });
  }

  posixTest(
    "timeout kills the Git process group, including a SIGTERM-resistant grandchild",
    async () => {
      const directory = await fixture();
      const pidsPath = join(directory, "pids.json");
      const script = join(directory, "children.mjs");
      await fs.writeFile(
        script,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`,
      );
      const operation = runRecipeGit(
        directory,
        ["-c", `alias.deadline-test=!${quote(process.execPath)} ${quote(script)}`, "deadline-test"],
        { ...DEFAULT_RECIPE_LIMITS, gitTimeoutMs: 400 },
        true,
      );
      const outcome = operation.then(
        () => new Error("Git unexpectedly succeeded"),
        (error: unknown) => error,
      );
      let pids: number[] = [];
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await Bun.file(pidsPath).exists()) {
            pids = JSON.parse(await fs.readFile(pidsPath, "utf8")) as number[];
            break;
          }
          await pause(10);
        }
        expect(pids).toHaveLength(2);
        expect(await within(outcome)).toMatchObject({ status: 422 });
        for (const pid of pids) {
          let alive = true;
          for (let attempt = 0; attempt < 100 && alive; attempt++) {
            try {
              process.kill(pid, 0);
              if (process.platform === "linux") {
                const state = await fs.readFile(`/proc/${pid}/stat`, "utf8");
                alive = state.split(") ")[1]?.[0] !== "Z";
              }
            } catch (error) {
              if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error;
              alive = false;
            }
            if (alive) await pause(10);
          }
          expect(alive).toBe(false);
        }
      } finally {
        for (const pid of pids) {
          killFixtureProcess(pid);
        }
        await within(outcome);
      }
    },
  );
});
