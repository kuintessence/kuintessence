import { describe, expect, test } from "bun:test";
import { mkdtemp, open, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usecase } from "@kuintessence/shared";
import {
  createHostValidatedOutputReader,
  createOutputCollector,
  hostOutputReader,
  type OutputReader,
} from "./output-collector";

function makeTestReader(read: (path: string) => Promise<string>): OutputReader {
  const reader: OutputReader = read;
  reader.readValidated = async (outputPath) => read(await realpath(outputPath));
  return reader;
}

describe("createOutputCollector", () => {
  test("reads each non-batch output file content into collected, keyed by descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    const files: Record<string, string> = {
      [join(dir, "residual.log")]: "final residual = 0.003\n",
      [join(dir, "summary.txt")]: "ok",
    };
    await Promise.all(Object.entries(files).map(([path, value]) => writeFile(path, value)));
    const canonicalFiles = Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([path, value]) => [await realpath(path), value]),
      ),
    );
    const collect = createOutputCollector(
      makeTestReader(async (p) => {
        const v = canonicalFiles[p];
        if (v === undefined) {
          throw new Error(`no file ${p}`);
        }
        return v;
      }),
    );
    const collected = await collect(
      [
        { descriptor: "log", path: "residual.log", isBatch: false },
        { descriptor: "summary", path: "summary.txt", isBatch: false },
      ],
      dir,
    );
    expect(collected).toEqual({ log: "final residual = 0.003\n", summary: "ok" });
  });

  test("passes an absolute output path through unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    const path = join(dir, "out.txt");
    await writeFile(path, "x");
    const seen: string[] = [];
    const collect = createOutputCollector(
      makeTestReader(async (p) => {
        seen.push(p);
        return "x";
      }),
    );
    await collect([{ descriptor: "d", path, isBatch: false }], dir);
    expect(seen).toEqual([await realpath(path)]);
  });

  test("uses the injected atomic output reader", async () => {
    const seen: Array<{
      outputPath: string;
      workingDir: string;
      protectedPaths: readonly string[];
    }> = [];
    const reader: OutputReader = async () => "unreachable";
    reader.readValidated = async (outputPath, workingDir, protectedPaths) => {
      seen.push({ outputPath, workingDir, protectedPaths });
      return "value=42\n";
    };
    const collect = createOutputCollector(reader);

    const collected = await collect(
      [
        {
          descriptor: "result",
          path: "result.txt",
          isBatch: false,
          protectedPaths: ["/container/run/inputs/restricted"],
        },
      ],
      "/container/run",
    );

    expect(collected).toEqual({ result: "value=42\n" });
    expect(seen).toEqual([
      {
        outputPath: "/container/run/result.txt",
        workingDir: "/container/run",
        protectedPaths: ["/container/run/inputs/restricted"],
      },
    ]);
  });

  test("uses the injected atomic output reader for each batched match", async () => {
    const validated: string[] = [];
    const reader: OutputReader = async () => "unreachable";
    reader.readValidated = async (outputPath) => {
      validated.push(outputPath);
      return outputPath;
    };
    const collect = createOutputCollector(reader, undefined, () => ["second.txt", "first.txt"]);

    const collected = await collect(
      [{ descriptor: "results", path: "*.txt", isBatch: true }],
      "/container/run",
    );

    expect(validated).toEqual(["/container/run/first.txt", "/container/run/second.txt"]);
    expect(collected.results).toBe(
      JSON.stringify(["/container/run/first.txt", "/container/run/second.txt"]),
    );
  });

  test("expands a batched output glob into a deterministic JSON array of file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-batch-"));
    await writeFile(join(dir, "out_2.txt"), "two");
    await writeFile(join(dir, "out_1.txt"), "one");
    await writeFile(join(dir, "out_3.txt"), "three");
    await writeFile(join(dir, "skip.log"), "ignored");
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [{ descriptor: "results", path: "out_*.txt", isBatch: true }],
      dir,
    );
    expect(collected.results).toBe(JSON.stringify(["one", "two", "three"]));
    expect(collected[usecase.batchOutputPathsDescriptor("results")]).toBe(
      JSON.stringify(["out_1.txt", "out_2.txt", "out_3.txt"]),
    );
  });

  test("a batched output with zero matches collects an empty JSON array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-batch-empty-"));
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [{ descriptor: "results", path: "none_*.txt", isBatch: true }],
      dir,
    );
    expect(collected.results).toBe("[]");
    expect(collected[usecase.batchOutputPathsDescriptor("results")]).toBe("[]");
  });

  test("records artifact paths without reading file contents", async () => {
    const readPaths: string[] = [];
    const validatedPaths: string[] = [];
    const reader: OutputReader = async () => "unreachable";
    reader.readValidated = async (outputPath) => {
      readPaths.push(outputPath);
      return "binary";
    };
    reader.validatePath = async (outputPath) => {
      validatedPaths.push(outputPath);
    };
    const collect = createOutputCollector(reader, undefined, () => ["b.tar.gz", "a.tar.gz"]);

    const collected = await collect(
      [
        { descriptor: "archive", path: "one.tar.gz", isBatch: false, pathsOnly: true },
        { descriptor: "archives", path: "*.tar.gz", isBatch: true, pathsOnly: true },
      ],
      "/container/run",
    );

    expect(readPaths).toEqual([]);
    expect(validatedPaths).toEqual([
      "/container/run/one.tar.gz",
      "/container/run/a.tar.gz",
      "/container/run/b.tar.gz",
    ]);
    expect(collected.archive).toBeUndefined();
    expect(collected.archives).toBeUndefined();
    expect(collected[usecase.batchOutputPathsDescriptor("archive")]).toBe(
      JSON.stringify(["one.tar.gz"]),
    );
    expect(collected[usecase.batchOutputPathsDescriptor("archives")]).toBe(
      JSON.stringify(["a.tar.gz", "b.tar.gz"]),
    );
  });

  test("rejects a protected path-only artifact before publishing path metadata", async () => {
    const reader: OutputReader = async () => "unreachable";
    reader.readValidated = async () => "unreachable";
    reader.validatePath = async () => {
      throw new Error("protected licensed material");
    };
    const collect = createOutputCollector(reader);

    const collected = await collect(
      [
        {
          descriptor: "archive",
          path: "protected/archive.tar.gz",
          isBatch: false,
          pathsOnly: true,
          protectedPaths: ["/container/run/protected"],
        },
      ],
      "/container/run",
    );

    expect(collected).toEqual({});
  });

  test("a batched output reads each matched file through the injected reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    await Promise.all([writeFile(join(dir, "a.txt"), "a"), writeFile(join(dir, "b.txt"), "b")]);
    const seen: string[] = [];
    const collect = createOutputCollector(
      makeTestReader(async (p) => {
        seen.push(p);
        return p.endsWith("a.txt") ? "A" : "B";
      }),
      undefined,
      () => ["b.txt", "a.txt"],
    );
    const collected = await collect([{ descriptor: "results", path: "*.txt", isBatch: true }], dir);
    expect(collected.results).toBe(JSON.stringify(["A", "B"]));
    expect(collected[usecase.batchOutputPathsDescriptor("results")]).toBe(
      JSON.stringify(["a.txt", "b.txt"]),
    );
    expect(seen).toEqual([await realpath(join(dir, "a.txt")), await realpath(join(dir, "b.txt"))]);
  });

  test("a batched output can use an async glob scanner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    await Promise.all([writeFile(join(dir, "a.txt"), "a"), writeFile(join(dir, "b.txt"), "b")]);
    const collect = createOutputCollector(
      makeTestReader(async (p) => (p.endsWith("a.txt") ? "A" : "B")),
      undefined,
      async () => ["b.txt", "a.txt"],
    );
    const collected = await collect([{ descriptor: "results", path: "*.txt", isBatch: true }], dir);

    expect(collected.results).toBe(JSON.stringify(["A", "B"]));
  });

  test("a read failure is swallowed; other outputs still collected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    await writeFile(join(dir, "ok.txt"), "present");
    const collect = createOutputCollector(
      makeTestReader(async (p) => {
        if (p === join(dir, "missing.txt")) {
          throw new Error("ENOENT");
        }
        return "present";
      }),
    );
    const collected = await collect(
      [
        { descriptor: "gone", path: "missing.txt", isBatch: false },
        { descriptor: "here", path: "ok.txt", isBatch: false },
      ],
      dir,
    );
    expect(collected).toEqual({ here: "present" });
  });

  test("hostOutputReader reads real file text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-"));
    await writeFile(join(dir, "r.log"), "residual = 0.01\n");
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect([{ descriptor: "log", path: "r.log", isBatch: false }], dir);
    expect(collected.log).toBe("residual = 0.01\n");
  });

  test("rejects a direct expected output for protected licensed material", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-protected-"));
    const potcar = join(dir, "POTCAR");
    await writeFile(potcar, "licensed");
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [{ descriptor: "potcar", path: "POTCAR", isBatch: false, protectedPaths: [potcar] }],
      dir,
    );
    expect(collected).toEqual({});
  });

  test("rejects symlinked outputs even when their target is inside the work root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-symlink-"));
    await writeFile(join(dir, "actual.txt"), "safe");
    await symlink(join(dir, "actual.txt"), join(dir, "linked.txt"));
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [{ descriptor: "linked", path: "linked.txt", isBatch: false }],
      dir,
    );
    expect(collected).toEqual({});
  });

  test("rejects a symlinked work root before canonicalizing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-work-root-"));
    const linkedRoot = `${dir}-link`;
    await writeFile(join(dir, "result.txt"), "safe");
    await symlink(dir, linkedRoot);
    const collect = createOutputCollector(hostOutputReader);

    const collected = await collect(
      [{ descriptor: "result", path: "result.txt", isBatch: false }],
      linkedRoot,
    );

    expect(collected).toEqual({});
  });

  test("does not read a protected target swapped in after path validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-race-"));
    const output = join(dir, "result.txt");
    const protectedPath = join(dir, "POTCAR");
    await writeFile(output, "safe");
    await writeFile(protectedPath, "licensed");
    const readValidated = createHostValidatedOutputReader({
      openFile: async (path, flags) => {
        await unlink(path);
        await symlink(protectedPath, path);
        return open(path, flags);
      },
    });

    await expect(readValidated(output, dir, [protectedPath])).rejects.toThrow();
  });

  test("reads the opened safe file when its path is replaced afterward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-open-race-"));
    const output = join(dir, "result.txt");
    const protectedPath = join(dir, "POTCAR");
    await writeFile(output, "safe");
    await writeFile(protectedPath, "licensed");
    const readValidated = createHostValidatedOutputReader({
      afterOpen: async (path) => {
        await unlink(path);
        await symlink(protectedPath, path);
      },
    });

    await expect(readValidated(output, dir, [protectedPath])).resolves.toBe("safe");
  });

  test("rejects output paths outside the canonical work root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-out-root-"));
    const outside = await mkdtemp(join(tmpdir(), "kq-outside-"));
    const outsidePath = join(outside, "result.txt");
    await writeFile(outsidePath, "outside");
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [{ descriptor: "outside", path: outsidePath, isBatch: false }],
      dir,
    );
    expect(collected).toEqual({});
  });
});
