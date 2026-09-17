import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const decoder = new TextDecoder();

describe("compiled SQLite migration", () => {
  test("embeds the initial schema in a Bun single-file executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-compiled-sqlite-"));
    const binary = join(dir, "compiled-migration");
    try {
      const build = Bun.spawnSync({
        cmd: [
          process.execPath,
          "build",
          "--compile",
          join(import.meta.dir, "__fixtures__/compiled-migration.ts"),
          "--outfile",
          binary,
        ],
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(build.exitCode, decoder.decode(build.stderr)).toBe(0);

      const execution = Bun.spawnSync({
        cmd: [binary],
        cwd: dir,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(execution.exitCode, decoder.decode(execution.stderr)).toBe(0);
      expect(decoder.decode(execution.stdout).trim()).toBe("compiled-sqlite-ok");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
