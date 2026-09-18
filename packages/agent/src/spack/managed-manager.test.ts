import { afterEach, describe, expect, test } from "bun:test";
import type { InstalledSpec, SpackPolicy } from "@kuintessence/shared";
import { SpackManager } from "./index";
import type { SpackManagedInstallation } from "./install-contract";
import { installRootHash, makeInstallFixture } from "./install-test-fixture";
import type { SoftwareOperationOutcome } from "./installer";

const fixtures: Awaited<ReturnType<typeof makeInstallFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const legacy: InstalledSpec = {
  name: "existing",
  version: "2.0",
  hash: "legacy",
  spec: "existing@2.0",
};
const managed: InstalledSpec = {
  name: "hello",
  version: "1.0",
  hash: installRootHash,
  spec: "hello@1.0",
};
const success: SoftwareOperationOutcome = {
  outcome: "succeeded",
  stdout: "",
  installed: [managed],
};

async function fixture(
  options: { failedAudit?: boolean; failedInventory?: boolean; backend?: boolean } = {},
) {
  const f = await makeInstallFixture();
  fixtures.push(f);
  const calls: string[] = [];
  const policies: SpackPolicy[] = [];
  const backend: SpackManagedInstallation = {
    async install(_prepared, input) {
      calls.push(`install:${input.spec}`);
      return success;
    },
    async installedList() {
      return [managed];
    },
    async operation(action, spec, policy) {
      policies.push(policy);
      calls.push(`${action}:${spec}`);
      if (spec.startsWith("existing")) return null;
      if (action === "uninstall") return { ...success, invalidatedHashes: [managed.hash] };
      return action === "load" ? { ...success, stdout: "export PATH=/srv/kq/bin:$PATH;" } : success;
    },
  };
  const manager = await SpackManager.bootstrap({
    requireServerMaterials: true,
    materialClient: f.client,
    materialAuditor: {
      async audit() {
        calls.push("audit");
        return {
          version: 1,
          validation: "isolated-source-audit",
          manifestDigest: f.input.manifestDigest,
          spackVersion: "1.0.0",
          rootHash: installRootHash,
          nodeCount: 1,
          externalCount: 0,
          verifiedNodeCount: options.failedAudit ? 0 : 1,
          passed: !options.failedAudit,
          issues: options.failedAudit ? [{ severity: "error", code: "source-mismatch" }] : [],
        };
      },
    },
    managedInstallation: options.backend === false ? undefined : backend,
    spawner: {
      async run(command) {
        calls.push(command.join(" "));
        if (command[1] === "--version") return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        if (command[1] === "find")
          return {
            exitCode: options.failedInventory ? 1 : 0,
            stdout: JSON.stringify([legacy]),
            stderr: "",
          };
        if (["uninstall", "load"].includes(command[1] ?? ""))
          return { exitCode: 0, stdout: "", stderr: "" };
        throw new Error("Unexpected Spack command");
      },
    },
  });
  return { ...f, manager, calls, policies };
}

describe("managed Spack manager integration", () => {
  test("merges legacy and managed inventory and installs only after successful source audit", async () => {
    const f = await fixture();
    expect(await f.manager.installedList()).toEqual([legacy, managed]);
    expect(await f.manager.runSoftwareOperation("install", f.input.spec, f.input)).toMatchObject({
      outcome: "succeeded",
      installed: [legacy, managed],
    });
    expect(f.calls.indexOf("audit")).toBeLessThan(f.calls.indexOf("install:hello@1.0"));
    expect(f.calls.some((call) => call.startsWith("spack install"))).toBe(false);
  });

  test("never dispatches installation after a failed source audit", async () => {
    const f = await fixture({ failedAudit: true });
    expect(await f.manager.runSoftwareOperation("install", f.input.spec, f.input)).toMatchObject({
      outcome: "failed",
      stderr: expect.stringContaining("source-mismatch"),
    });
    expect(f.calls.includes("install:hello@1.0")).toBe(false);
  });

  test("audit-only configuration remains rejected and does not mutate host software", async () => {
    const f = await fixture({ backend: false });
    expect(await f.manager.runSoftwareOperation("install", f.input.spec, f.input)).toMatchObject({
      outcome: "rejected",
    });
    expect(f.calls.includes("install:hello@1.0")).toBe(false);
  });

  test("passes current policy for authoritative selector resolution and preserves legacy operations", async () => {
    const f = await fixture();
    await f.manager.applyPolicy({
      policyVersion: "v1",
      lockEnabled: true,
      allowList: ["hello@*", "existing@*"],
    });
    expect(await f.manager.runSoftwareOperation("load", `/${installRootHash}`)).toMatchObject({
      outcome: "succeeded",
      installed: [legacy, managed],
    });
    expect(f.policies[0]).toMatchObject({
      lockEnabled: true,
      allowList: ["hello@*", "existing@*"],
    });
    expect(await f.manager.runSoftwareOperation("uninstall", "existing@2.0")).toMatchObject({
      outcome: "succeeded",
      installed: [legacy, managed],
    });
    expect(f.calls.some((call) => call.startsWith("spack uninstall"))).toBe(true);
  });

  test("reports inventory refresh failure honestly after backend success", async () => {
    const f = await fixture({ failedInventory: true });
    expect(await f.manager.runSoftwareOperation("install", f.input.spec, f.input)).toEqual({
      outcome: "failed",
      exitCode: 1,
      stderr: "Spack operation completed but installed inventory refresh failed",
    });
    expect(f.calls.includes("install:hello@1.0")).toBe(true);
  });

  test("retains withdrawal metadata if legacy refresh fails after managed uninstall", async () => {
    const f = await fixture({ failedInventory: true });
    expect(await f.manager.runSoftwareOperation("uninstall", managed.spec)).toMatchObject({
      outcome: "failed",
      invalidatedHashes: [managed.hash],
    });
  });
});
