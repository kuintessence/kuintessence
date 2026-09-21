import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { SpackManager } from "./index";
import type {
  PreparedSpackMaterials,
  SpackMaterialPrepareInput,
  SpackMaterialProvider,
} from "./material-client";

const context = {
  operationId: "operation-1",
  ticket: "test-ticket",
  manifestDigest: `sha256:${"a".repeat(64)}`,
};

// The provider stub deliberately makes no semantic-verification claims.
const prepared: PreparedSpackMaterials = {
  manifestDigest: context.manifestDigest,
  manifestPath: "/cache/manifest",
  manifestSize: 1,
  blobs: [],
  manifest: {
    version: 1,
    repository: "public/test",
    spec: "zlib@1.3.1",
    spackVersion: "0.22.1",
    target: "linux-x86_64",
    redistribution: "unrestricted",
    recipes: [],
    sources: [],
    lockfile: { digest: `sha256:${"b".repeat(64)}`, size: 1 },
  },
};

async function manager(materialClient?: SpackMaterialProvider) {
  const calls: string[][] = [];
  const spawner: Spawner = {
    async run(command) {
      calls.push(command);
      if (command[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
      throw new Error(`Unexpected Spack spawn: ${command.join(" ")}`);
    },
  };
  const manager = await SpackManager.bootstrap({
    spawner,
    requireServerMaterials: true,
    materialClient,
  });
  return { manager, calls };
}

describe("platform-managed Spack gate", () => {
  test("standalone remains opt-in and disabled platform manager retains the managed flag", async () => {
    expect((await SpackManager.bootstrap({ enabled: false })).requireServerMaterials).toBe(false);
    expect(
      (await SpackManager.bootstrap({ enabled: false, requireServerMaterials: true }))
        .requireServerMaterials,
    ).toBe(true);
  });

  test("rejects all missing context combinations and an unconfigured material client", async () => {
    const f = await manager();
    for (const missing of [
      undefined,
      { ...context, ticket: "" },
      { ...context, manifestDigest: "" },
    ]) {
      expect(await f.manager.runSoftwareOperation("install", "zlib@1.3.1", missing)).toMatchObject({
        outcome: "rejected",
        reason: expect.stringContaining("ticket"),
      });
    }
    expect(await f.manager.runSoftwareOperation("install", "zlib@1.3.1", context)).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("not configured"),
    });
    expect(f.calls).toEqual([["spack", "--version"]]);
  });

  test("prepares the exact operation binding but fails an unverified provider result without spawning", async () => {
    const requests: SpackMaterialPrepareInput[] = [];
    const f = await manager({
      async prepare(input) {
        requests.push(input);
        return prepared;
      },
    });
    expect(await f.manager.runSoftwareOperation("install", "zlib@1.3.1", context)).toMatchObject({
      outcome: "failed",
      stderr: expect.stringContaining("Spack material preflight failed"),
    });
    expect(requests).toEqual([{ ...context, spec: "zlib@1.3.1", spackVersion: "0.22.1" }]);
    expect(f.calls).toEqual([["spack", "--version"]]);
  });

  test.each([
    "SHA-256 mismatch",
    "HTTP 401: ticket expired",
    "HTTP 404",
    "transfer timed out",
  ])("fails closed on material preparation error %s without fallback", async (message) => {
    let attempts = 0;
    const f = await manager({
      async prepare() {
        attempts++;
        throw new Error(message);
      },
    });
    expect(await f.manager.runSoftwareOperation("install", "zlib@1.3.1", context)).toEqual({
      outcome: "failed",
      exitCode: 1,
      stderr: `Spack material preparation failed: ${message}`,
    });
    expect(attempts).toBe(1);
    expect(f.calls).toEqual([["spack", "--version"]]);
  });

  test("blocks convenience and public submodule installation/buildcache entrypoints", async () => {
    const f = await manager();
    expect(await f.manager.requestInstall("zlib@1.3.1", { lockEnabled: false })).toMatchObject({
      outcome: "rejected",
    });
    for (const operation of [
      () => f.manager.importBuildcache(["zlib@1.3.1"]),
      () => f.manager.importBuildcache([]),
      () => f.manager.exportBuildcache("zlib@1.3.1", "mirror"),
      () => f.manager.buildcache?.importBuildcache(["zlib@1.3.1"]),
      () => f.manager.buildcache?.importBuildcache([]),
      () => f.manager.buildcache?.exportBuildcache("zlib@1.3.1", "mirror"),
      () => f.manager.installer?.requestInstall("zlib@1.3.1", { lockEnabled: false }),
      () => f.manager.installer?.installAndRefresh("zlib@1.3.1", { lockEnabled: false }),
    ]) {
      await expect(operation()).rejects.toThrow(
        "managed offline Spack execution is not enabled yet",
      );
    }
    await expect(
      f.manager.applyMirrors([{ name: "upstream", url: "https://upstream.example" }]),
    ).rejects.toThrow("upstream mirrors are disabled");
    expect(f.calls).toEqual([["spack", "--version"]]);
  });

  test("caches allow/deny policy but does not apply upstream mirrors or preinstall", async () => {
    let attempts = 0;
    const f = await manager({
      async prepare() {
        attempts++;
        return prepared;
      },
    });
    const policy = {
      policyVersion: "v1",
      lockEnabled: true,
      allowList: ["zlib@*"],
      denyList: ["zlib@1.3.1"],
      mirrors: [{ name: "upstream", url: "https://upstream.example" }],
      preinstallList: ["zlib@1.3.1"],
    };
    expect(await f.manager.applyPolicy(policy)).toEqual({ applied: true, policyVersion: "v1" });
    expect(await f.manager.applyPolicy(policy)).toEqual({ applied: true, policyVersion: "v1" });
    expect(f.manager.currentPolicy()).toEqual({
      lockEnabled: true,
      allowList: policy.allowList,
      denyList: policy.denyList,
    });
    expect(await f.manager.runSoftwareOperation("install", "zlib@1.3.1", context)).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("denyList"),
    });
    expect(attempts).toBe(0);
    expect(f.calls).toEqual([["spack", "--version"]]);
  });
});
