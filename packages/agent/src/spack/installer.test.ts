import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpackPolicy } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { SpackCli } from "./cli";
import { SpackInstaller } from "./installer";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const FIND_JSON = readFileSync(join(FIXTURES, "spack-find.json"), "utf-8");

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

describe("SpackInstaller.requestInstall", () => {
  test("policy reject short-circuits before invoking CLI", async () => {
    const { spawner, calls } = makeSpawner([]);
    const cli = new SpackCli({ spawner });
    const policy: SpackPolicy = { lockEnabled: true, allowList: ["gromacs@*"] };
    const installer = new SpackInstaller(cli);

    const r = await installer.requestInstall("lammps@2024.1", policy);

    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") {
      expect(r.reason).toMatch(/lammps/);
    }
    expect(calls).toHaveLength(0);
  });

  test("policy allow drives a spack install invocation", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "==> gromacs installed", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const policy: SpackPolicy = { lockEnabled: false };
    const installer = new SpackInstaller(cli);

    const r = await installer.requestInstall("gromacs@2024.1", policy);

    expect(r.outcome).toBe("installed");
    expect(calls[0]).toEqual(["spack", "install", "--yes", "gromacs@2024.1"]);
  });

  test("CLI install failure surfaces as failed outcome with stderr", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 1, stdout: "", stderr: "==> Error: build failed" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.requestInstall("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/build failed/);
    }
  });

  test("CLI install failure falls back to stdout when stderr is empty", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 1, stdout: "==> Error: concretization failed", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.requestInstall("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("==> Error: concretization failed");
    }
  });

  test("on successful install, refreshes installed-list cache via findJson", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "==> gromacs installed" },
      { exitCode: 0, stdout: FIND_JSON },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    await installer.requestInstall("gromacs@2024.1", { lockEnabled: false });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["spack", "find", "--json"]);
    const cached = installer.cachedInstalled();
    expect(cached?.length).toBe(3);
  });

  test("on failed install, does NOT refresh installed-list cache", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 1, stdout: "", stderr: "boom" }]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    await installer.requestInstall("gromacs@2024.1", { lockEnabled: false });

    // only the install call was made; no follow-up find --json
    expect(calls).toHaveLength(1);
    expect(installer.cachedInstalled()).toBeUndefined();
  });

  test("installAndRefresh reports a failed operation when ledger refresh fails", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "==> gromacs installed" },
      { exitCode: 0, stdout: "not json" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.installAndRefresh("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("spack install succeeded but installed ledger refresh failed:");
      expect(r.stderr).toContain("Unexpected");
    }
    expect(calls).toEqual([
      ["spack", "install", "--yes", "gromacs@2024.1"],
      ["spack", "find", "--json"],
    ]);
  });

  test("installAndRefresh refreshes the installed ledger exactly once after success", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "==> gromacs installed" },
      { exitCode: 0, stdout: FIND_JSON },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.installAndRefresh("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("succeeded");
    if (r.outcome === "succeeded") {
      expect(r.installed).toHaveLength(3);
    }
    expect(calls).toEqual([
      ["spack", "install", "--yes", "gromacs@2024.1"],
      ["spack", "find", "--json"],
    ]);
  });

  test("refreshInstalled() can be called explicitly", async () => {
    const { spawner } = makeSpawner([{ exitCode: 0, stdout: FIND_JSON }]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const list = await installer.refreshInstalled();
    expect(list).toHaveLength(3);
    expect(installer.cachedInstalled()).toEqual(list);
  });
});

describe("SpackInstaller software operations", () => {
  test("uninstallAndRefresh removes a spec and refreshes cache", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "removed" },
      { exitCode: 0, stdout: FIND_JSON },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.uninstallAndRefresh("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("succeeded");
    expect(calls[0]).toEqual(["spack", "uninstall", "--yes", "gromacs@2024.1"]);
    expect(calls[1]).toEqual(["spack", "find", "--json"]);
  });

  test("uninstallAndRefresh honors policy and short-circuits denied specs", async () => {
    const { spawner, calls } = makeSpawner([]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.uninstallAndRefresh("lammps@2024.1", {
      lockEnabled: true,
      allowList: ["gromacs@*"],
    });

    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") {
      expect(r.reason).toMatch(/lammps/);
    }
    expect(calls).toEqual([]);
  });

  test("uninstallAndRefresh failure falls back to stdout when stderr is empty", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 1, stdout: "==> Error: no installed package matches", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.uninstallAndRefresh("missing@1.0", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("==> Error: no installed package matches");
    }
    expect(calls).toEqual([["spack", "uninstall", "--yes", "missing@1.0"]]);
  });

  test("uninstallAndRefresh reports the refresh failure reason", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: "removed" },
      { exitCode: 0, stdout: "not json" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.uninstallAndRefresh("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("spack uninstall succeeded but installed ledger refresh failed:");
      expect(r.stderr).toContain("Unexpected");
    }
    expect(calls).toEqual([
      ["spack", "uninstall", "--yes", "gromacs@2024.1"],
      ["spack", "find", "--json"],
    ]);
  });

  test("loadShell validates loadability without refreshing installed cache", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "export PATH=/x:$PATH" }]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.loadShell("gromacs@2024.1", { lockEnabled: false });

    expect(r.outcome).toBe("succeeded");
    expect(calls).toEqual([["spack", "load", "--sh", "gromacs@2024.1"]]);
  });

  test("loadShell honors policy and short-circuits denied specs", async () => {
    const { spawner, calls } = makeSpawner([]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.loadShell("lammps@2024.1", {
      lockEnabled: false,
      denyList: ["lammps@*"],
    });

    expect(r.outcome).toBe("rejected");
    expect(calls).toEqual([]);
  });

  test("loadShell failure falls back to stdout when stderr is empty", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 1, stdout: "==> Error: package is not installed", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.loadShell("missing@1.0", { lockEnabled: false });

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("==> Error: package is not installed");
    }
    expect(calls).toEqual([["spack", "load", "--sh", "missing@1.0"]]);
  });

  test("importPreinstalled rejects specs absent from spack find", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "[]" }]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.importPreinstalled("missing@1.0");

    expect(r.outcome).toBe("rejected");
    expect(calls).toEqual([["spack", "find", "--json", "missing@1.0"]]);
  });

  test("importPreinstalled find failure falls back to stdout when stderr is empty", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 1, stdout: "==> Error: repository is not available", stderr: "" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.importPreinstalled("gromacs@2024.1");

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe("==> Error: repository is not available");
    }
    expect(calls).toEqual([["spack", "find", "--json", "gromacs@2024.1"]]);
  });

  test("importPreinstalled reports malformed filtered find output as failed", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "not json" }]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.importPreinstalled("gromacs@2024.1");

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("returned invalid JSON");
    }
    expect(calls).toEqual([["spack", "find", "--json", "gromacs@2024.1"]]);
  });

  test("importPreinstalled accepts present specs and refreshes the full ledger", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: FIND_JSON },
      { exitCode: 0, stdout: FIND_JSON },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.importPreinstalled("gromacs@2024.1");

    expect(r.outcome).toBe("succeeded");
    expect(calls[0]).toEqual(["spack", "find", "--json", "gromacs@2024.1"]);
    expect(calls[1]).toEqual(["spack", "find", "--json"]);
  });

  test("importPreinstalled reports failed full-ledger refresh after a match", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: FIND_JSON },
      { exitCode: 0, stdout: "not json" },
    ]);
    const cli = new SpackCli({ spawner });
    const installer = new SpackInstaller(cli);

    const r = await installer.importPreinstalled("gromacs@2024.1");

    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain(
        "preinstalled import matched but installed ledger refresh failed:",
      );
      expect(r.stderr).toContain("Unexpected");
    }
    expect(calls[0]).toEqual(["spack", "find", "--json", "gromacs@2024.1"]);
    expect(calls[1]).toEqual(["spack", "find", "--json"]);
  });
});
