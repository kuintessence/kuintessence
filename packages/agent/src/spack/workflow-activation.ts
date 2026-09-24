import { SPACK_EXECUTION_PLACEHOLDER, SpackExecutionSchema } from "@kuintessence/shared";
import { realSpawner, type Spawner } from "../adapters/base";
import type { SpackManager } from "./index";

export const SPACK_ACTIVATION_FAILURE = "Workflow Spack activation failed";
const MAX_ACTIVATION_TIMEOUT_MS = 60_000;
const MAX_SHELL_BYTES = 256 * 1024;

export interface SpackActivationInput {
  execution: unknown;
  command: string;
  manager?: Pick<SpackManager, "available" | "runSoftwareOperation">;
  signal: AbortSignal;
  timeoutMs?: number;
  spawner?: Spawner;
  invalidate?: (hashes: string[]) => void;
  schedule?: (prepare: () => Promise<string>) => Promise<string>;
  trackCleanup?: (pending: Promise<void>) => void;
}

/** Load only through the governed manager; never reinterpret legacy dispatch shell. */
export async function activateWorkflowSpack(input: SpackActivationInput): Promise<string> {
  const execution = SpackExecutionSchema.safeParse(input.execution);
  if (
    !execution.success ||
    input.command !== SPACK_EXECUTION_PLACEHOLDER ||
    !input.manager?.available ||
    input.signal.aborted
  ) {
    throw new Error(SPACK_ACTIVATION_FAILURE);
  }
  const requestedTimeout = input.timeoutMs ?? MAX_ACTIVATION_TIMEOUT_MS;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw new Error(SPACK_ACTIVATION_FAILURE);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(requestedTimeout, MAX_ACTIVATION_TIMEOUT_MS),
  );
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error(SPACK_ACTIVATION_FAILURE));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const manager = input.manager;
  const prepare = async () => {
    signal.throwIfAborted();
    const outcome = await manager.runSoftwareOperation(
      "load",
      execution.data.spec,
      undefined,
      signal,
    );
    // A cancelled/expired verification can still withdraw a previously advertised install.
    if ("invalidatedHashes" in outcome && outcome.invalidatedHashes?.length) {
      input.invalidate?.(outcome.invalidatedHashes);
    }
    signal.throwIfAborted();
    if (outcome.outcome !== "succeeded") throw new Error(SPACK_ACTIVATION_FAILURE);
    const shell = outcome.stdout;
    if (
      !shell.trim() ||
      shell.includes("\0") ||
      new TextEncoder().encode(shell).length > MAX_SHELL_BYTES
    ) {
      throw new Error(SPACK_ACTIVATION_FAILURE);
    }
    // A separate eval keeps an activation fragment from consuming the command as shell syntax.
    // The manager supplies shell, not user-provided legacy "spack load" syntax.
    const script = `${shell}\n`;
    const checked = await (input.spawner ?? realSpawner).run(["/bin/sh", "-n"], {
      stdin: script,
      timeoutMs: 5_000,
    });
    signal.throwIfAborted();
    if (checked.exitCode !== 0) throw new Error(SPACK_ACTIVATION_FAILURE);
    return `set -e\neval ${shellQuote(script)}\n${execution.data.command}`;
  };
  try {
    const preparation = input.schedule ? input.schedule(prepare) : prepare();
    // Cancellation rejects promptly, while shutdown must still account for runtime cleanup.
    input.trackCleanup?.(
      preparation.then(
        () => {},
        () => {},
      ),
    );
    return await Promise.race([preparation, aborted]);
  } catch {
    throw new Error(SPACK_ACTIVATION_FAILURE);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
