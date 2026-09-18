import {
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  spawn,
} from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

/** Bounded process transport only. The caller must supply an isolation runtime. */
export interface SpackAuditProcess {
  run(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface ProcessDependencies {
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
  ) => ChildProcessByStdio<null, Readable, Readable>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
  platform?: NodeJS.Platform;
}

type RunOptions = Parameters<SpackAuditProcess["run"]>[1];
const CLOSE_GRACE_MS = 250;
const processError = (message: string) => new Error(`Spack audit process ${message}`);

function validatedEnvironment(command: string[], options: RunOptions): Record<string, string> {
  const invalid = () => new Error("Invalid Spack audit process options");
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    typeof command[0] !== "string" ||
    !isAbsolute(command[0]) ||
    !options ||
    typeof options.cwd !== "string" ||
    !isAbsolute(options.cwd) ||
    options.cwd.includes("\0") ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30 * 60 * 1_000 ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0 ||
    options.maxOutputBytes > 4 * 1024 * 1024 ||
    !options.env ||
    typeof options.env !== "object" ||
    Array.isArray(options.env) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw invalid();
  }
  for (const argument of command) {
    if (typeof argument !== "string" || argument.includes("\0")) throw invalid();
  }
  // Null prototype prevents inherited keys from reaching spawn's environment enumeration.
  const env: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(options.env)) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw invalid();
    }
    env[key] = value;
  }
  return env;
}

/**
 * Injectable process transport, not a sandbox. The caller must supply the isolation
 * runtime and an outer PID namespace/reaper: descendants can otherwise escape a
 * process group with setsid(), and orphaned zombies cannot be reaped here.
 */
export function createSpackAuditProcess({
  spawnProcess = spawn,
  killProcess = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
}: ProcessDependencies = {}): SpackAuditProcess {
  return {
    async run(command, options) {
      if (platform !== "linux" && platform !== "darwin") {
        throw processError("platform not supported");
      }
      const env = validatedEnvironment(command, options);
      const { cwd, signal, timeoutMs, maxOutputBytes } = options;
      if (signal?.aborted) throw processError("aborted");
      const output = Buffer.alloc(maxOutputBytes);
      const deadline = performance.now() + timeoutMs;
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawnProcess(command[0] as string, command.slice(1), {
          cwd,
          env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        throw processError("spawn failed");
      }

      return new Promise((resolve, reject) => {
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let settled = false;
        let groupChecked = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

        function killGroup(): boolean {
          if (groupChecked || child.pid === undefined) return false;
          groupChecked = true;
          try {
            if (killProcess(-child.pid, "SIGKILL")) return true;
            failure = processError("group cleanup failed");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
              failure = processError("group cleanup failed");
            }
          }
          return false;
        }

        function finish(exitCode?: number) {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          clearTimeout(graceTimer);
          signal?.removeEventListener("abort", onAbort);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("close", onClose);
          child.stdout.removeListener("data", onStdout);
          child.stderr.removeListener("data", onStderr);
          child.stdout.removeListener("error", onOutputError);
          child.stderr.removeListener("error", onOutputError);
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          if (failure) {
            reject(failure);
          } else if (exitCode === undefined) {
            reject(processError("terminated"));
          } else {
            try {
              const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
              resolve({
                exitCode,
                stdout: decoder.decode(output.subarray(0, stdoutBytes)),
                stderr: decoder.decode(output.subarray(maxOutputBytes - stderrBytes).reverse()),
              });
            } catch {
              reject(processError("output is not valid UTF-8"));
            }
          }
        }

        function fail(error: Error) {
          if (settled) return;
          failure ??= error;
          killGroup();
          // close may never arrive if a descendant outside the group retained a pipe.
          graceTimer ??= setTimeout(() => finish(), CLOSE_GRACE_MS);
        }

        function capture(chunk: Buffer, stderr: boolean) {
          if (settled || failure) return;
          if (!Buffer.isBuffer(chunk)) {
            fail(processError("output failed"));
            return;
          }
          if (chunk.length > maxOutputBytes - stdoutBytes - stderrBytes) {
            fail(processError("output limit exceeded"));
            return;
          }
          if (stderr) {
            // stdout grows forward, stderr backward in byte-reversed order. One
            // fixed buffer bounds both streams, even with millions of tiny writes.
            const start = maxOutputBytes - stderrBytes - chunk.length;
            chunk.copy(output, start);
            output.subarray(start, start + chunk.length).reverse();
            stderrBytes += chunk.length;
          } else {
            chunk.copy(output, stdoutBytes);
            stdoutBytes += chunk.length;
          }
        }

        function onStdout(chunk: Buffer) {
          capture(chunk, false);
        }
        function onStderr(chunk: Buffer) {
          capture(chunk, true);
        }
        function onAbort() {
          fail(processError("aborted"));
        }
        function onError() {
          fail(processError("spawn failed"));
        }
        function onOutputError() {
          fail(processError("output failed"));
        }
        function onExit(code: number | null, terminationSignal: NodeJS.Signals | null) {
          if (code === null || terminationSignal !== null || child.killed) {
            fail(processError("terminated"));
          } else if (killGroup()) {
            // Killing surviving writers can truncate output, so never claim success.
            fail(processError("left running descendants"));
          } else if (failure) {
            fail(failure);
          }
        }
        function onClose(code: number | null, terminationSignal: NodeJS.Signals | null) {
          if (settled) return;
          if (performance.now() >= deadline) fail(processError("timed out"));
          onExit(code, terminationSignal);
          finish(code ?? undefined);
        }

        child.on("error", onError);
        child.on("exit", onExit);
        child.on("close", onClose);
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdout.on("error", onOutputError);
        child.stderr.on("error", onOutputError);
        deadlineTimer = setTimeout(
          () => fail(processError("timed out")),
          Math.max(0, deadline - performance.now()),
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
}

export const realSpackAuditProcess: SpackAuditProcess = createSpackAuditProcess();
