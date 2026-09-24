import { describe, expect, test } from "bun:test";
import { SPACK_EXECUTION_PLACEHOLDER } from "@kuintessence/shared";
import type { SoftwareOperationOutcome } from "./installer";
import {
  activateWorkflowSpack,
  SPACK_ACTIVATION_FAILURE,
  type SpackActivationInput,
} from "./workflow-activation";

const shell = "export PATH='/srv/kq/store/releases/release/hello/bin':\"$PATH\";\n";
const execution = { spec: "hello@1.0 +mpi", command: "hello 'two words'" };
const success: SoftwareOperationOutcome = { outcome: "succeeded", stdout: shell, installed: [] };

function input(overrides: Partial<SpackActivationInput> = {}): SpackActivationInput {
  return {
    execution,
    command: SPACK_EXECUTION_PLACEHOLDER,
    signal: new AbortController().signal,
    manager: { available: true, runSoftwareOperation: async () => success },
    spawner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    ...overrides,
  };
}

describe("workflow Spack activation", () => {
  test("loads the full spec only via the manager, then checks shell without executing it", async () => {
    let loads = 0;
    let checks = 0;
    const command = await activateWorkflowSpack(
      input({
        manager: {
          available: true,
          runSoftwareOperation: async (action, spec, materials, signal) => {
            loads++;
            expect(action).toBe("load");
            expect(spec).toBe(execution.spec);
            expect(materials).toBeUndefined();
            expect(signal?.aborted).toBe(false);
            return success;
          },
        },
        spawner: {
          run: async (argv, options) => {
            checks++;
            expect(argv).toEqual(["/bin/sh", "-n"]);
            expect(options?.stdin).toBe(`${shell}\n`);
            expect(options?.timeoutMs).toBe(5_000);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      }),
    );
    expect(loads).toBe(1);
    expect(checks).toBe(1);
    expect(command.startsWith("set -e\neval '")).toBe(true);
    expect(command).toContain(
      "'/srv/kq/store/releases/release/hello/bin'".replaceAll("'", "'\\''"),
    );
    expect(command.endsWith(`\n${execution.command}`)).toBe(true);
    expect(command).not.toContain("spack load");
  });

  test.each([
    { execution: { spec: "", command: "hello" } },
    { execution: { spec: "hello", command: "" } },
    { execution: { spec: "hello", command: "hello", extra: true } },
    { execution: { spec: "x".repeat(4097), command: "hello" } },
    { command: 'eval "$(spack load --sh hello)" && hello' },
    { command: "exit 125; hello" },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
  ])("rejects invalid intent or placeholder before manager work %#", async (overrides) => {
    let called = false;
    await expect(
      activateWorkflowSpack(
        input({
          manager: {
            available: true,
            runSoftwareOperation: async () => {
              called = true;
              return success;
            },
          },
          ...overrides,
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(called).toBe(false);
  });

  test("unavailable manager never uses a CLI fallback", async () => {
    let called = false;
    for (const manager of [
      undefined,
      {
        available: false,
        runSoftwareOperation: async () => {
          called = true;
          return success;
        },
      },
    ]) {
      await expect(activateWorkflowSpack(input({ manager }))).rejects.toThrow(
        SPACK_ACTIVATION_FAILURE,
      );
    }
    expect(called).toBe(false);
  });

  test.each<SoftwareOperationOutcome>([
    { outcome: "rejected", reason: "private policy or non-root runtime reason" },
    { outcome: "failed", exitCode: 7, stderr: "private installation path or credentials" },
    { outcome: "succeeded", stdout: "", installed: [] },
    { outcome: "succeeded", stdout: " \n", installed: [] },
    { outcome: "succeeded", stdout: "export PATH=\0", installed: [] },
    { outcome: "succeeded", stdout: "x".repeat(256 * 1024 + 1), installed: [] },
  ])("fails generically before shell validation for unusable manager results %#", async (result) => {
    let checked = false;
    await expect(
      activateWorkflowSpack(
        input({
          manager: { available: true, runSoftwareOperation: async () => result },
          spawner: {
            run: async () => {
              checked = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(checked).toBe(false);
  });

  test("rejects bad shell and conceals the parser diagnostic", async () => {
    await expect(
      activateWorkflowSpack(
        input({
          manager: {
            available: true,
            runSoftwareOperation: async () => ({ ...success, stdout: "export PATH='" }),
          },
          spawner: {
            run: async () => ({ exitCode: 2, stdout: "", stderr: "private parser diagnostic" }),
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
  });

  test("conceals exceptions and never retries the manager", async () => {
    let calls = 0;
    await expect(
      activateWorkflowSpack(
        input({
          manager: {
            available: true,
            runSoftwareOperation: async () => {
              calls++;
              throw new Error("private material details");
            },
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(calls).toBe(1);
  });

  test("applies invalidations even when cancellation wins before the load completes", async () => {
    const controller = new AbortController();
    let finish: (outcome: SoftwareOperationOutcome) => void = () => {};
    const deferred = new Promise<SoftwareOperationOutcome>((resolve) => {
      finish = resolve;
    });
    const invalidations: string[][] = [];
    let loadSignal: AbortSignal | undefined;
    let cleanup: Promise<void> | undefined;
    let cleaned = false;
    const activation = activateWorkflowSpack(
      input({
        signal: controller.signal,
        manager: {
          available: true,
          runSoftwareOperation: async (_action, _spec, _materials, signal) => {
            loadSignal = signal;
            return deferred;
          },
        },
        invalidate: (hashes) => invalidations.push(hashes),
        trackCleanup: (pending) => {
          cleanup = pending;
          void pending.then(() => {
            cleaned = true;
          });
        },
      }),
    );
    controller.abort(new Error("private cancellation reason"));
    await expect(activation).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(loadSignal?.aborted).toBe(true);
    expect(cleanup).toBeDefined();
    expect(cleaned).toBe(false);
    finish({ outcome: "failed", exitCode: 1, stderr: "withdrawn", invalidatedHashes: ["hash"] });
    await deferred;
    await Promise.resolve();
    await Promise.resolve();
    await cleanup;
    expect(cleaned).toBe(true);
    expect(invalidations).toEqual([["hash"]]);
  });

  test("bounds a non-cooperative load and aborts its lifecycle signal", async () => {
    let loadSignal: AbortSignal | undefined;
    await expect(
      activateWorkflowSpack(
        input({
          timeoutMs: 1,
          manager: {
            available: true,
            runSoftwareOperation: async (_action, _spec, _materials, signal) => {
              loadSignal = signal;
              return new Promise<SoftwareOperationOutcome>(() => {});
            },
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(loadSignal?.aborted).toBe(true);
  });

  test("a deadline while queued cannot start a late load", async () => {
    let release: () => void = () => {};
    const previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleanup: Promise<void> | undefined;
    let loads = 0;
    await expect(
      activateWorkflowSpack(
        input({
          timeoutMs: 1,
          schedule: (prepare) => previous.then(prepare),
          trackCleanup: (pending) => {
            cleanup = pending;
          },
          manager: {
            available: true,
            runSoftwareOperation: async () => {
              loads++;
              return success;
            },
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(loads).toBe(0);
    release();
    await cleanup;
    expect(loads).toBe(0);
  });

  test("cancellation after load prevents syntax checking and command preparation", async () => {
    const controller = new AbortController();
    let checked = false;
    await expect(
      activateWorkflowSpack(
        input({
          signal: controller.signal,
          manager: {
            available: true,
            runSoftwareOperation: async () => {
              controller.abort();
              return success;
            },
          },
          spawner: {
            run: async () => {
              checked = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        }),
      ),
    ).rejects.toThrow(SPACK_ACTIVATION_FAILURE);
    expect(checked).toBe(false);
  });
});
