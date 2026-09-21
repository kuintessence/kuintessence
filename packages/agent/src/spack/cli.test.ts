import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawner } from "../adapters/base";
import { SpackCli } from "./cli";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const FIND_JSON = readFileSync(join(FIXTURES, "spack-find.json"), "utf-8");
const VERSION_TXT = readFileSync(join(FIXTURES, "spack-version.txt"), "utf-8");
const MIRROR_LIST_TXT = readFileSync(join(FIXTURES, "spack-mirror-list.txt"), "utf-8");

interface MockResp {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function mockSpawner(responses: MockResp[]): { spawner: Spawner; calls: string[][] } {
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

describe("SpackCli.version", () => {
  test("returns version string on success", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]);
    const cli = new SpackCli({ spawner });
    const v = await cli.version();
    expect(v.exitCode).toBe(0);
    expect(v.stdout).toContain("0.22.1");
    expect(calls[0]).toEqual(["spack", "--version"]);
  });

  test("respects custom binary path", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]);
    const cli = new SpackCli({ spawner, binary: "/opt/spack/bin/spack" });
    await cli.version();
    expect(calls[0]?.[0]).toBe("/opt/spack/bin/spack");
  });

  test("captures stderr on failure", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 127, stdout: "", stderr: "command not found: spack" },
    ]);
    const cli = new SpackCli({ spawner });
    const v = await cli.version();
    expect(v.exitCode).toBe(127);
    expect(v.stderr).toContain("command not found");
  });
});

describe("SpackCli.findJson", () => {
  test("invokes `spack find --json`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: FIND_JSON }]);
    const cli = new SpackCli({ spawner });
    const r = await cli.findJson();
    expect(r.exitCode).toBe(0);
    expect(calls[0]).toEqual(["spack", "find", "--json"]);
    expect(r.stdout).toContain("gromacs");
  });

  test("invokes `spack find --json <spec>` when filtered", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: FIND_JSON }]);
    const cli = new SpackCli({ spawner });
    await cli.findJson("gromacs@2024.1");
    expect(calls[0]).toEqual(["spack", "find", "--json", "gromacs@2024.1"]);
  });
});

describe("SpackCli.install", () => {
  test("invokes `spack install --yes <spec>`", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: "==> gromacs@2024.1 installed", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const r = await cli.install("gromacs@2024.1");
    expect(r.exitCode).toBe(0);
    expect(calls[0]).toEqual(["spack", "install", "--yes", "gromacs@2024.1"]);
  });

  test("rejects empty spec", async () => {
    const { spawner } = mockSpawner([]);
    const cli = new SpackCli({ spawner });
    await expect(cli.install("")).rejects.toThrow();
  });

  test("returns nonzero exit code on install failure without throwing", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "==> Error: package not found" },
    ]);
    const cli = new SpackCli({ spawner });
    const r = await cli.install("nonexistent@1.0");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Error");
  });
});

describe("SpackCli.uninstall", () => {
  test("invokes `spack uninstall --yes <spec>`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "removed" }]);
    const cli = new SpackCli({ spawner });
    await cli.uninstall("gromacs@2024.1");
    expect(calls[0]).toEqual(["spack", "uninstall", "--yes", "gromacs@2024.1"]);
  });
});

describe("SpackCli.loadShell", () => {
  test("invokes `spack load --sh <spec>`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "export PATH=/x:$PATH" }]);
    const cli = new SpackCli({ spawner });
    await cli.loadShell("gromacs@2024.1");
    expect(calls[0]).toEqual(["spack", "load", "--sh", "gromacs@2024.1"]);
  });
});

describe("SpackCli.mirrorAdd", () => {
  test("invokes `spack mirror add <name> <url>`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const cli = new SpackCli({ spawner });
    await cli.mirrorAdd("internal", "https://mirrors.example.com/spack");
    expect(calls[0]).toEqual([
      "spack",
      "mirror",
      "add",
      "internal",
      "https://mirrors.example.com/spack",
    ]);
  });

  test("rejects empty name", async () => {
    const { spawner } = mockSpawner([]);
    const cli = new SpackCli({ spawner });
    await expect(cli.mirrorAdd("", "https://x")).rejects.toThrow();
  });

  test("rejects empty url", async () => {
    const { spawner } = mockSpawner([]);
    const cli = new SpackCli({ spawner });
    await expect(cli.mirrorAdd("name", "")).rejects.toThrow();
  });
});

describe("SpackCli.mirrorList", () => {
  test("invokes `spack mirror list`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: MIRROR_LIST_TXT }]);
    const cli = new SpackCli({ spawner });
    const r = await cli.mirrorList();
    expect(calls[0]).toEqual(["spack", "mirror", "list"]);
    expect(r.stdout).toContain("internal");
  });
});

describe("SpackCli.mirrorRemove", () => {
  test("invokes `spack mirror rm <name>`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const cli = new SpackCli({ spawner });
    await cli.mirrorRemove("internal");
    expect(calls[0]).toEqual(["spack", "mirror", "rm", "internal"]);
  });

  test("rejects empty name", async () => {
    const { spawner } = mockSpawner([]);
    const cli = new SpackCli({ spawner });
    await expect(cli.mirrorRemove("")).rejects.toThrow();
  });
});

describe("SpackCli.buildcachePush", () => {
  test("invokes correct command with --keys none --rebuild-index", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const cli = new SpackCli({ spawner });
    await cli.buildcachePush("internal", "gromacs@2024.1");
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
});

describe("SpackCli.buildcacheInstall", () => {
  test("invokes `spack buildcache install <spec>`", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const cli = new SpackCli({ spawner });
    await cli.buildcacheInstall("gromacs@2024.1");
    expect(calls[0]).toEqual(["spack", "buildcache", "install", "gromacs@2024.1"]);
  });
});

describe("SpackCli managed execution gate", () => {
  test("blocks direct install/buildcache/mirror-add calls without spawning", async () => {
    const { spawner, calls } = mockSpawner([]);
    const cli = new SpackCli({ spawner, requireServerMaterials: true });
    for (const operation of [
      () => cli.install("zlib@1.3.1"),
      () => cli.buildcacheInstall("zlib@1.3.1"),
      () => cli.buildcachePush("mirror", "zlib@1.3.1"),
      () => cli.mirrorAdd("mirror", "https://upstream.example"),
    ]) {
      await expect(operation()).rejects.toThrow(
        "managed offline Spack execution is not enabled yet",
      );
    }
    expect(calls).toEqual([]);
  });
});
