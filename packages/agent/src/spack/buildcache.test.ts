import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { Buildcache } from "./buildcache";
import { SpackCli } from "./cli";

interface MockResp {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function makeSpawner(responses: MockResp[]): { spawner: Spawner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const spawner: Spawner = {
    async run(cmd) {
      calls.push(cmd);
      const r = responses[i++];
      if (!r) throw new Error(`No more mock responses (call #${calls.length})`);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
  return { spawner, calls };
}

describe("Buildcache.importBuildcache", () => {
  test("invokes `buildcache install` once per spec", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const bc = new Buildcache(cli);

    const r = await bc.importBuildcache(["gromacs@2024.1", "openmpi@4.1.5"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["spack", "buildcache", "install", "gromacs@2024.1"]);
    expect(calls[1]).toEqual(["spack", "buildcache", "install", "openmpi@4.1.5"]);
    expect(r.installed).toEqual(["gromacs@2024.1", "openmpi@4.1.5"]);
    expect(r.failed).toEqual([]);
  });

  test("collects per-spec failures without short-circuiting", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 1, stdout: "", stderr: "no signing key" },
      { exitCode: 0, stdout: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const bc = new Buildcache(cli);

    const r = await bc.importBuildcache(["bad@1.0", "good@2.0"]);

    expect(r.installed).toEqual(["good@2.0"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.spec).toBe("bad@1.0");
    expect(r.failed[0]?.stderr).toMatch(/signing key/);
  });

  test("empty input is a no-op", async () => {
    const { spawner, calls } = makeSpawner([]);
    const cli = new SpackCli({ spawner });
    const bc = new Buildcache(cli);

    const r = await bc.importBuildcache([]);

    expect(calls).toHaveLength(0);
    expect(r.installed).toEqual([]);
  });
});

describe("Buildcache.exportBuildcache", () => {
  test("invokes `buildcache push` with given mirror and spec", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "" }]);
    const cli = new SpackCli({ spawner });
    const bc = new Buildcache(cli);

    const r = await bc.exportBuildcache("gromacs@2024.1", "internal");

    expect(r.outcome).toBe("pushed");
    expect(calls[0]).toEqual([
      "spack",
      "buildcache",
      "push",
      "--keys",
      "none",
      "--rebuild-index",
      "internal",
      "gromacs@2024.1",
    ]);
  });

  test("non-zero exit reports as failed", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 2, stdout: "", stderr: "==> Error: mirror not found" },
    ]);
    const cli = new SpackCli({ spawner });
    const bc = new Buildcache(cli);

    const r = await bc.exportBuildcache("gromacs@2024.1", "missing-mirror");

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/mirror not found/);
    }
  });
});
