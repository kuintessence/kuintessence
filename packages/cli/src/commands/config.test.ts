import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLocalDb } from "./config";

describe("migrateLocalDb", () => {
  test("copies only local.db to the target, leaving the source dir intact", () => {
    const base = mkdtempSync(join(tmpdir(), "kq-migrate-"));
    const from = join(base, "src");
    const to = join(base, "dst");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "local.db"), "data");
    // A still-active CLI config must NOT be carried into the data dir.
    writeFileSync(join(from, "config.json"), '{"token":"secret"}');

    const result = migrateLocalDb(from, to);

    expect(result).toEqual({
      copied: true,
      from: join(from, "local.db"),
      to: join(to, "local.db"),
    });
    expect(existsSync(join(to, "local.db"))).toBe(true);
    expect(readFileSync(join(to, "local.db"), "utf8")).toBe("data");
    expect(existsSync(join(to, "config.json"))).toBe(false);
    expect(existsSync(join(from, "local.db"))).toBe(true);
    expect(existsSync(join(from, "config.json"))).toBe(true);
  });

  test("returns copied:false when the source local.db does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "kq-migrate-"));
    const from = join(base, "missing");
    const to = join(base, "dst");

    const result = migrateLocalDb(from, to);

    expect(result).toEqual({
      copied: false,
      from: join(from, "local.db"),
      to: join(to, "local.db"),
    });
    expect(existsSync(to)).toBe(false);
  });

  test("is idempotent: re-running with an existing target is a no-op overwrite", () => {
    const base = mkdtempSync(join(tmpdir(), "kq-migrate-"));
    const from = join(base, "src");
    const to = join(base, "dst");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "local.db"), "data");

    migrateLocalDb(from, to);
    const result = migrateLocalDb(from, to);

    expect(result.copied).toBe(true);
    expect(readFileSync(join(to, "local.db"), "utf8")).toBe("data");
  });
});
