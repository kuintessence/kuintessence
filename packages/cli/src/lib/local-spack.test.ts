import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawner } from "@kuintessence/agent/embedded";
import {
  formatExportOutcome,
  formatImportResult,
  formatInstalledTable,
  formatInstallOutcome,
  formatMirrorList,
  LOCAL_POLICY,
  localSpack,
  localSpackErrorMessage,
} from "./local-spack";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "agent", "src", "spack", "__fixtures__");
const FIND_JSON = readFileSync(join(FIXTURES, "spack-find.json"), "utf-8");
const MIRROR_LIST_TXT = readFileSync(join(FIXTURES, "spack-mirror-list.txt"), "utf-8");
const VERSION_TXT = readFileSync(join(FIXTURES, "spack-version.txt"), "utf-8");

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

describe("LOCAL_POLICY", () => {
  test("is permissive (no lock, no lists → allow-all)", () => {
    expect(LOCAL_POLICY.lockEnabled).toBe(false);
    expect(LOCAL_POLICY.allowList).toBeUndefined();
    expect(LOCAL_POLICY.denyList).toBeUndefined();
  });
});

describe("localSpack bootstrap", () => {
  test("returns an available manager when `spack --version` succeeds", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]);
    const manager = await localSpack({ spawner });
    expect(manager.available).toBe(true);
  });

  test("throws a friendly error when spack is unavailable", async () => {
    const { spawner } = mockSpawner([{ exitCode: 127, stdout: "", stderr: "not found" }]);
    await expect(localSpack({ spawner })).rejects.toThrow(/spack not found on PATH/);
  });
});

describe("localSpack drives the real SpackManager (mocked Spawner)", () => {
  test("installedList parses `spack find --json`", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: VERSION_TXT }, // bootstrap probe
      { exitCode: 0, stdout: FIND_JSON }, // find --json
    ]);
    const manager = await localSpack({ spawner });
    const installed = await manager.installedList();
    expect(installed.map((s) => s.name)).toContain("gromacs");
  });

  test("requestInstall with LOCAL_POLICY allows + installs", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: VERSION_TXT }, // bootstrap
      { exitCode: 0, stdout: "==> installed" }, // install
      { exitCode: 0, stdout: FIND_JSON }, // cache refresh
    ]);
    const manager = await localSpack({ spawner });
    const outcome = await manager.requestInstall("gromacs@2024.1", LOCAL_POLICY);
    expect(outcome.outcome).toBe("installed");
    expect(calls[1]).toEqual(["spack", "install", "--yes", "gromacs@2024.1"]);
  });

  test("mirror list/add/rm via the manager's mirrorManager", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: VERSION_TXT }, // bootstrap
      { exitCode: 0, stdout: MIRROR_LIST_TXT }, // list
      { exitCode: 0, stdout: "" }, // add
      { exitCode: 0, stdout: "" }, // rm
    ]);
    const manager = await localSpack({ spawner });
    const mgr = manager.mirrorManager;
    if (!mgr) throw new Error("mirrorManager missing");
    const map = await mgr.list();
    expect(map.get("internal")).toBe("https://mirrors.example.com/spack");
    await mgr.add("new", "https://new.example.com");
    await mgr.remove("internal");
    expect(calls[2]).toEqual(["spack", "mirror", "add", "new", "https://new.example.com"]);
    expect(calls[3]).toEqual(["spack", "mirror", "rm", "internal"]);
  });

  test("buildcache install + push via the manager", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: VERSION_TXT }, // bootstrap
      { exitCode: 0, stdout: "" }, // buildcache install
      { exitCode: 0, stdout: "" }, // buildcache push
    ]);
    const manager = await localSpack({ spawner });
    const imp = await manager.importBuildcache(["gromacs@2024.1"]);
    expect(imp.installed).toEqual(["gromacs@2024.1"]);
    const exp = await manager.exportBuildcache("gromacs@2024.1", "internal");
    expect(exp.outcome).toBe("pushed");
    expect(calls[1]).toEqual(["spack", "buildcache", "install", "gromacs@2024.1"]);
  });
});

describe("localSpackErrorMessage", () => {
  test("formats a clean one-liner", () => {
    const msg = localSpackErrorMessage("install", new Error("boom"));
    expect(msg).toBe("kq software install (local): boom");
  });
});

describe("formatInstalledTable", () => {
  test("renders a header + one row per spec", () => {
    const out = formatInstalledTable([
      { name: "gromacs", version: "2024.1", hash: "h1", spec: "gromacs@2024.1" },
    ]);
    expect(out.split("\n")[0]).toBe("NAME\tVERSION\tSPEC");
    expect(out.split("\n")[1]).toBe("gromacs\t2024.1\tgromacs@2024.1");
  });

  test("reports empty distinctly", () => {
    expect(formatInstalledTable([])).toBe("No software installed.");
  });
});

describe("formatInstallOutcome", () => {
  test("installed → ok", () => {
    const r = formatInstallOutcome("x", { outcome: "installed", stdout: "" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Installed x");
  });

  test("rejected → not ok, includes reason", () => {
    const r = formatInstallOutcome("x", { outcome: "rejected", reason: "locked" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("locked");
  });

  test("failed → not ok, includes exit code", () => {
    const r = formatInstallOutcome("x", { outcome: "failed", exitCode: 2, stderr: "boom" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("exit 2");
  });
});

describe("formatMirrorList", () => {
  test("renders a header + rows", () => {
    const out = formatMirrorList(new Map([["internal", "https://m"]]));
    expect(out.split("\n")[0]).toBe("NAME\tURL");
    expect(out.split("\n")[1]).toBe("internal\thttps://m");
  });

  test("reports empty distinctly", () => {
    expect(formatMirrorList(new Map())).toBe("No mirrors configured.");
  });
});

describe("formatImportResult", () => {
  test("all installed → ok", () => {
    const r = formatImportResult({ installed: ["a", "b"], failed: [] });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("a, b");
  });

  test("any failure → not ok", () => {
    const r = formatImportResult({
      installed: ["a"],
      failed: [{ spec: "b", exitCode: 1, stderr: "boom" }],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Failed b");
  });
});

describe("formatExportOutcome", () => {
  test("pushed → ok", () => {
    const r = formatExportOutcome("x", "m", { outcome: "pushed" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Pushed x to m");
  });

  test("failed → not ok", () => {
    const r = formatExportOutcome("x", "m", { outcome: "failed", exitCode: 1, stderr: "boom" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("failed");
  });
});
