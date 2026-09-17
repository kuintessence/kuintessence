import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { SpackManager } from "./index";

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

describe("SpackManager.bootstrap", () => {
  test("returns available=true when spack --version succeeds", async () => {
    const { spawner } = makeSpawner([{ exitCode: 0, stdout: "0.22.1 (abcdef)" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    expect(mgr.available).toBe(true);
    expect(mgr.version).toMatch(/0\.22/);
  });

  test("returns available=false when spack --version exits non-zero", async () => {
    const { spawner } = makeSpawner([{ exitCode: 127, stdout: "", stderr: "command not found" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    expect(mgr.available).toBe(false);
    expect(mgr.version).toBeUndefined();
  });

  test("returns available=false when spawner throws", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("ENOENT");
      },
    };
    const mgr = await SpackManager.bootstrap({ spawner });
    expect(mgr.available).toBe(false);
  });

  test("respects custom binary path", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "0.22.1" }]);
    await SpackManager.bootstrap({ spawner, binary: "/opt/spack/bin/spack" });
    expect(calls[0]?.[0]).toBe("/opt/spack/bin/spack");
  });

  test("disabled=true short-circuits without invoking spawner", async () => {
    const { spawner, calls } = makeSpawner([]);
    const mgr = await SpackManager.bootstrap({ spawner, enabled: false });
    expect(mgr.available).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("SpackManager.installedList", () => {
  test("delegates to installer.refreshInstalled", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 0, stdout: "0.22.1" },
      { exitCode: 0, stdout: "[]" },
    ]);
    const mgr = await SpackManager.bootstrap({ spawner });
    const list = await mgr.installedList();
    expect(list).toEqual([]);
  });

  test("throws when called on an unavailable manager", async () => {
    const { spawner } = makeSpawner([{ exitCode: 127, stdout: "" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    await expect(mgr.installedList()).rejects.toThrow(/unavailable/i);
  });
});

describe("SpackManager.applyPolicy", () => {
  test("idempotent: same policy_version twice → applied only once", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 0, stdout: "0.22.1" },
      // First applyPolicy: list mirrors, then we'd add one (we'll start empty)
      { exitCode: 0, stdout: "" }, // mirror list (empty)
      { exitCode: 0, stdout: "Added mirror central" }, // mirror add central
    ]);
    const mgr = await SpackManager.bootstrap({ spawner });
    const ack1 = await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: false,
      mirrors: [{ name: "central", url: "https://mirror.example.com" }],
    });
    expect(ack1.applied).toBe(true);
    expect(ack1.policyVersion).toBe("v1");

    // Same version again — should short-circuit, no spawner calls.
    const ack2 = await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: false,
      mirrors: [{ name: "central", url: "https://mirror.example.com" }],
    });
    expect(ack2.applied).toBe(true);
    expect(ack2.policyVersion).toBe("v1");
  });

  test("stores policy so subsequent install requests use it", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 0, stdout: "0.22.1" },
      // applyPolicy does NOT touch mirrors when none provided
    ]);
    const mgr = await SpackManager.bootstrap({ spawner });
    const ack = await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: true,
      allowList: ["gromacs@*"],
    });
    expect(ack.applied).toBe(true);
    expect(mgr.currentPolicy()).toEqual({
      lockEnabled: true,
      allowList: ["gromacs@*"],
      denyList: undefined,
    });
  });

  test("returns applied=false with error when manager unavailable", async () => {
    const { spawner } = makeSpawner([{ exitCode: 127, stdout: "" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    const ack = await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: false,
    });
    expect(ack.applied).toBe(false);
    expect(ack.error).toMatch(/unavailable/i);
  });
});

describe("SpackManager.runSoftwareOperation", () => {
  test("prechecks cached policy without invoking Spack operations", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "0.22.1" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: true,
      allowList: ["gromacs@*"],
    });

    expect(mgr.policyRejectionForOperation("install", "lammps@2024.1")).toMatch(/allowList/);
    expect(mgr.policyRejectionForOperation("load", "gromacs@2024.1 +mpi")).toBeNull();
    expect(mgr.policyRejectionForOperation("import_preinstalled", "lammps@2024.1")).toBeNull();
    expect(calls).toEqual([["spack", "--version"]]);
  });

  test("uses cached policy for uninstall operations", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "0.22.1" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: true,
      allowList: ["gromacs@*"],
    });

    const result = await mgr.runSoftwareOperation("uninstall", "lammps@2024.1");

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toMatch(/lammps/);
    }
    expect(calls).toEqual([["spack", "--version"]]);
  });
});

describe("SpackManager exposes composable submodules", () => {
  test("installer / mirrorManager / buildcache are accessible when available", async () => {
    const { spawner } = makeSpawner([{ exitCode: 0, stdout: "0.22.1" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    expect(mgr.available).toBe(true);
    expect(mgr.installer).toBeDefined();
    expect(mgr.mirrorManager).toBeDefined();
    expect(mgr.buildcache).toBeDefined();
  });

  test("submodules are undefined when manager unavailable", async () => {
    const { spawner } = makeSpawner([{ exitCode: 127, stdout: "" }]);
    const mgr = await SpackManager.bootstrap({ spawner });
    expect(mgr.installer).toBeUndefined();
    expect(mgr.mirrorManager).toBeUndefined();
    expect(mgr.buildcache).toBeUndefined();
  });
});
