import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawner } from "../adapters/base";
import { SpackCli } from "./cli";
import { getInstalledList, parseSpackFindJson } from "./installed";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const FIND_JSON = readFileSync(join(FIXTURES, "spack-find.json"), "utf-8");

interface MockResp {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function mockSpawner(responses: MockResp[]): Spawner {
  let i = 0;
  return {
    async run() {
      const r = responses[i++];
      if (!r) throw new Error("No more mock responses");
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
}

describe("parseSpackFindJson", () => {
  test("parses gromacs/openmpi/lammps fixture", () => {
    const list = parseSpackFindJson(FIND_JSON);
    expect(list).toHaveLength(3);
    const gromacs = list[0];
    expect(gromacs?.name).toBe("gromacs");
    expect(gromacs?.version).toBe("2024.1");
    expect(gromacs?.hash).toBe("abc123def456gromacs2024");
    expect(gromacs?.compiler).toBe("gcc@13.2.0");
    expect(gromacs?.spec).toBe("gromacs@2024.1%gcc@13.2.0");
    expect(gromacs?.arch).toBe("linux-rocky9-x86_64");
  });

  test("returns [] for empty array", () => {
    expect(parseSpackFindJson("[]")).toEqual([]);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseSpackFindJson("not json")).toThrow();
  });

  test("throws when top-level is not an array", () => {
    expect(() => parseSpackFindJson('{"name":"x"}')).toThrow();
  });

  test("rejects the whole snapshot when any entry is incomplete", () => {
    const partial = JSON.stringify([
      { name: "good", version: "1.0", hash: "h1" },
      { name: "incomplete-no-hash", version: "1.0" },
      { name: "incomplete-no-version", hash: "h3" },
    ]);
    expect(() => parseSpackFindJson(partial)).toThrow(
      "parseSpackFindJson: invalid installed entry",
    );
  });

  test.each([
    "[{}]",
    "[null]",
    "[[]]",
    "[42]",
    '["invalid"]',
    '[{"name":"hello","version":"1.0","hash":""}]',
    '[{"name":42,"version":"1.0","hash":"h1"}]',
    '[{"name":"hello","version":1,"hash":"h1"}]',
  ])("rejects malformed entries instead of fabricating empty inventory: %s", (stdout) => {
    expect(() => parseSpackFindJson(stdout)).toThrow("parseSpackFindJson: invalid installed entry");
  });

  test("synthesizes spec without compiler when compiler is missing", () => {
    const noCompiler = JSON.stringify([{ name: "gromacs", version: "2024.1", hash: "h" }]);
    const list = parseSpackFindJson(noCompiler);
    expect(list[0]?.spec).toBe("gromacs@2024.1");
    expect(list[0]?.compiler).toBeUndefined();
  });

  test("uses pre-existing spec field when present", () => {
    const withSpec = JSON.stringify([
      { name: "x", version: "1", hash: "h", spec: "x@1+mpi%gcc@12" },
    ]);
    const list = parseSpackFindJson(withSpec);
    expect(list[0]?.spec).toBe("x@1+mpi%gcc@12");
  });
});

describe("getInstalledList", () => {
  test("returns parsed list when CLI succeeds", async () => {
    const cli = new SpackCli({ spawner: mockSpawner([{ exitCode: 0, stdout: FIND_JSON }]) });
    const list = await getInstalledList(cli);
    expect(list).toHaveLength(3);
    expect(list[0]?.name).toBe("gromacs");
  });

  test("returns [] when CLI exits 0 but stdout is empty (no installs)", async () => {
    const cli = new SpackCli({ spawner: mockSpawner([{ exitCode: 0, stdout: "[]\n" }]) });
    const list = await getInstalledList(cli);
    expect(list).toEqual([]);
  });

  test("throws with stderr context when CLI fails", async () => {
    const cli = new SpackCli({
      spawner: mockSpawner([{ exitCode: 1, stdout: "", stderr: "spack: not found" }]),
    });
    await expect(getInstalledList(cli)).rejects.toThrow(/spack: not found/);
  });

  test.each([
    "[{}]",
    '[{"name":"hello","version":"1.0","hash":"h1"},{}]',
  ])("does not accept incomplete CLI-success output as authoritative: %s", async (stdout) => {
    const cli = new SpackCli({ spawner: mockSpawner([{ exitCode: 0, stdout }]) });
    await expect(getInstalledList(cli)).rejects.toThrow(
      "parseSpackFindJson: invalid installed entry",
    );
  });
});
