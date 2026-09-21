import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { InstalledSpec, SpackPolicy } from "@kuintessence/shared";
import { SpackManager } from "./index";
import type { SpackManagedInstallation } from "./install-contract";
import { installRootHash, makeInstallFixture } from "./install-test-fixture";
import type { SoftwareOperationOutcome } from "./installer";
import { SpackMaterialCache } from "./material-cache";
import type { SpackMaterialProvider } from "./material-client";
import type { SpackMaterialAuditor } from "./source-auditor";

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
  const signals: Array<{ stage: string; signal: AbortSignal | undefined }> = [];
  const materialClient: SpackMaterialProvider = {
    async prepare(input) {
      calls.push("prepare");
      signals.push({ stage: "prepare", signal: input.signal });
      return f.client.prepare(input);
    },
  };
  const materialAuditor: SpackMaterialAuditor = {
    async audit(_prepared, input) {
      calls.push("audit");
      signals.push({ stage: "audit", signal: input.signal });
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
  };
  const backend: SpackManagedInstallation = {
    async install(_prepared, input) {
      calls.push(`install:${input.spec}`);
      signals.push({ stage: "install", signal: input.signal });
      return success;
    },
    async installedList() {
      return [managed];
    },
    async operation(action, spec, policy, signal) {
      policies.push(policy);
      calls.push(`${action}:${spec}`);
      signals.push({ stage: action, signal });
      if (spec.startsWith("existing")) return null;
      if (action === "uninstall") return { ...success, invalidatedHashes: [managed.hash] };
      return action === "load" ? { ...success, stdout: "export PATH=/srv/kq/bin:$PATH;" } : success;
    },
  };
  const manager = await SpackManager.bootstrap({
    requireServerMaterials: true,
    materialClient,
    materialAuditor,
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
  return { ...f, manager, calls, policies, signals, backend, materialClient, materialAuditor };
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

  test("forwards the lifecycle signal through preparation, audit, install and managed operations", async () => {
    const f = await fixture();
    const { signal } = new AbortController();
    expect(
      await f.manager.runSoftwareOperation("install", f.input.spec, f.input, signal),
    ).toMatchObject({ outcome: "succeeded" });
    for (const action of ["load", "import_preinstalled", "uninstall"] as const) {
      expect(
        await f.manager.runSoftwareOperation(action, f.input.spec, undefined, signal),
      ).toMatchObject({ outcome: "succeeded" });
    }
    expect(f.signals.map((entry) => entry.stage)).toEqual([
      "prepare",
      "audit",
      "install",
      "load",
      "import_preinstalled",
      "uninstall",
    ]);
    for (const entry of f.signals) expect(entry.signal).toBe(signal);
  });

  test("an already aborted lifecycle never prepares materials or dispatches software", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const before = [...f.calls];
    for (const action of ["install", "load", "import_preinstalled", "uninstall"] as const) {
      expect(
        await f.manager.runSoftwareOperation(action, f.input.spec, f.input, controller.signal),
      ).toEqual({
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack software operation cancelled",
      });
    }
    expect(f.calls).toEqual(before);
  });

  test.each([
    "prepare",
    "audit",
  ] as const)("cancellation during %s prevents the next stage even when the provider returns successfully", async (stage) => {
    const f = await fixture();
    const controller = new AbortController();
    if (stage === "prepare") {
      const prepare = f.materialClient.prepare.bind(f.materialClient);
      f.materialClient.prepare = async (input) => {
        const result = await prepare(input);
        controller.abort(new Error("private abort reason"));
        return result;
      };
    } else {
      const audit = f.materialAuditor.audit.bind(f.materialAuditor);
      f.materialAuditor.audit = async (prepared, input) => {
        const result = await audit(prepared, input);
        controller.abort(new Error("private abort reason"));
        return result;
      };
    }
    expect(
      await f.manager.runSoftwareOperation("install", f.input.spec, f.input, controller.signal),
    ).toEqual({
      outcome: "failed",
      exitCode: 1,
      stderr: "Spack software operation cancelled",
    });
    expect(f.calls.includes("install:hello@1.0")).toBe(false);
    expect(f.calls.includes("audit")).toBe(stage === "audit");
  });

  test("preflight cache reads receive cancellation and never proceed to audit", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const preflightSignals: AbortSignal[] = [];
    const readMetadata = spyOn(SpackMaterialCache.prototype, "readMetadata").mockImplementation(
      async (_blob, _maxBytes, signal) => {
        preflightSignals.push(signal);
        controller.abort(new Error("private abort reason"));
        signal?.throwIfAborted();
        throw new Error("preflight did not receive the lifecycle signal");
      },
    );
    try {
      expect(
        await f.manager.runSoftwareOperation("install", f.input.spec, f.input, controller.signal),
      ).toEqual({
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack software operation cancelled",
      });
      expect(readMetadata).toHaveBeenCalledTimes(1);
      expect(preflightSignals[0]?.aborted).toBe(true);
      expect(f.calls.includes("audit")).toBe(false);
      expect(f.calls.includes("install:hello@1.0")).toBe(false);
    } finally {
      readMetadata.mockRestore();
    }
  });

  test("preparation abort exceptions do not expose the abort reason", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.materialClient.prepare = async (input) => {
      controller.abort(new Error("private abort reason"));
      input.signal?.throwIfAborted();
      throw new Error("preparation did not receive the lifecycle signal");
    };
    expect(
      await f.manager.runSoftwareOperation("install", f.input.spec, f.input, controller.signal),
    ).toEqual({
      outcome: "failed",
      exitCode: 1,
      stderr: "Spack software operation cancelled",
    });
    expect(f.calls.includes("audit")).toBe(false);
  });

  test("preserves backend withdrawal and completed results after cancellation", async () => {
    const f = await fixture();
    const withdrawn: SoftwareOperationOutcome = {
      outcome: "failed",
      exitCode: 1,
      stderr: "managed verification cancelled",
      invalidatedHashes: [managed.hash],
    };
    for (const result of [withdrawn, success]) {
      const controller = new AbortController();
      f.backend.install = async (_prepared, input) => {
        expect(input.signal).toBe(controller.signal);
        controller.abort();
        return result;
      };
      expect(
        await f.manager.runSoftwareOperation("install", f.input.spec, f.input, controller.signal),
      ).toEqual(
        result.outcome === "succeeded" ? { ...result, installed: [legacy, managed] } : result,
      );
    }
    for (const result of [withdrawn, { ...success, invalidatedHashes: [managed.hash] }]) {
      const operationController = new AbortController();
      f.backend.operation = async (_action, _spec, _policy, signal) => {
        expect(signal).toBe(operationController.signal);
        operationController.abort();
        return result;
      };
      expect(
        await f.manager.runSoftwareOperation(
          "uninstall",
          f.input.spec,
          undefined,
          operationController.signal,
        ),
      ).toEqual(
        result.outcome === "succeeded" ? { ...result, installed: [legacy, managed] } : result,
      );
    }
  });

  test("does not start legacy fallback after managed selector resolution is cancelled", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.backend.operation = async () => {
      controller.abort();
      return null;
    };
    expect(
      await f.manager.runSoftwareOperation("load", legacy.spec, undefined, controller.signal),
    ).toMatchObject({ outcome: "failed", stderr: "Spack software operation cancelled" });
    expect(f.calls.some((call) => call.startsWith("spack load"))).toBe(false);
  });
});
