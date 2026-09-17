import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { parseDfPercent, readDiskUsedPercent } from "./disk";

function fixedSpawner(result: { exitCode: number; stdout: string; stderr: string }): Spawner {
  return {
    async run() {
      return result;
    },
  };
}

function throwingSpawner(message: string): Spawner {
  return {
    async run() {
      throw new Error(message);
    },
  };
}

describe("parseDfPercent", () => {
  test("parses GNU df -P output (Linux)", () => {
    const out = parseDfPercent(
      [
        "Filesystem     1024-blocks     Used  Available Capacity Mounted on",
        "/dev/sda1         51474044 38605516   10250812      80% /",
      ].join("\n"),
    );
    expect(out).toBe(80);
  });

  test("parses macOS df -P output", () => {
    const out = parseDfPercent(
      [
        "Filesystem    1024-blocks      Used  Available Capacity  iused      ifree %iused  Mounted on",
        "/dev/disk1s1  244277768  50000000  194277768   21%   500000  500000     0%   /",
      ].join("\n"),
    );
    expect(out).toBe(21);
  });

  test("returns null for missing data line", () => {
    expect(
      parseDfPercent("Filesystem     1024-blocks     Used  Available Capacity Mounted on"),
    ).toBeNull();
    expect(parseDfPercent("")).toBeNull();
  });

  test("returns null when no percent column", () => {
    expect(parseDfPercent("/dev/sda1         51474044 38605516   10250812      ?? /")).toBeNull();
  });
});

describe("readDiskUsedPercent", () => {
  test("returns parsed percent on clean df exit", async () => {
    const spawner = fixedSpawner({
      exitCode: 0,
      stdout: [
        "Filesystem     1024-blocks     Used  Available Capacity Mounted on",
        "/dev/sda1         51474044 38605516   10250812      55% /",
      ].join("\n"),
      stderr: "",
    });
    const out = await readDiskUsedPercent({ spawner });
    expect(out).toBe(55);
  });

  test("returns null when df missing", async () => {
    const out = await readDiskUsedPercent({ spawner: throwingSpawner("ENOENT") });
    expect(out).toBeNull();
  });

  test("returns null when df exits non-zero", async () => {
    const out = await readDiskUsedPercent({
      spawner: fixedSpawner({ exitCode: 1, stdout: "", stderr: "fail" }),
    });
    expect(out).toBeNull();
  });
});
