import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancelAndConfirmStopped,
  type JobSpec,
  type SchedulerAdapter,
  shellQuote,
} from "../adapters/base";

interface NativeRuntimeProbeOptions {
  root: string;
  queue: string;
  script: string;
  adapter: (logDir: string) => SchedulerAdapter;
  // A root Agent keeps the script protected and gives only the log directory to the probe user.
  account?: { uid: number; gid: number };
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/** Do not delete a probe's files until its original scheduler job is known to have stopped. */
export async function runNativeRuntimeProbe(options: NativeRuntimeProbeOptions): Promise<string[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.queue)) {
    throw new Error("Native Sandbox probe requires an explicit safe queue");
  }
  if (
    options.account &&
    (process.getuid?.() !== 0 ||
      !Number.isSafeInteger(options.account.uid) ||
      !Number.isSafeInteger(options.account.gid) ||
      options.account.uid <= 0 ||
      options.account.gid <= 0)
  ) {
    throw new Error("Native Sandbox probe account must be non-root");
  }
  if ((await readdir(options.root)).some((entry) => entry.startsWith(".attest-"))) {
    throw new Error(
      "Native Sandbox probe is active or unresolved; retain and inspect its job receipt",
    );
  }
  const root = join(options.root, ".attest-active");
  // Atomic creation also prevents two Agent processes from submitting probes at the same time.
  await mkdir(root, { mode: 0o700 });
  const logDir = join(root, "logs");
  const scriptPath = join(root, "probe.sh");
  let adapter: SchedulerAdapter | undefined;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? Bun.sleep;
  const jobId = randomUUID();
  let submissionAttempted = false;
  let stopped = false;
  let schedulerJobId: string | undefined;
  try {
    adapter = options.adapter(logDir);
    if (!["slurm", "pbs-pro", "torque"].includes(adapter.type)) {
      throw new Error("Native Sandbox probe scheduler is unsupported");
    }
    const logPrefix =
      adapter.type === "slurm" ? "kq-" : adapter.type === "pbs-pro" ? "kq-pbs-" : "kq-torque-";
    const stdoutPath = join(logDir, `${logPrefix}${jobId}.out`);
    const stderrPath =
      adapter.type === "slurm" ? stdoutPath : join(logDir, `${logPrefix}${jobId}.err`);
    await mkdir(logDir, { mode: 0o700 });
    await writeFile(scriptPath, options.script, { flag: "wx", mode: 0o444 });
    if (options.account) {
      await chown(logDir, options.account.uid, options.account.gid);
      await chmod(root, 0o711);
    }
    const spec: JobSpec = {
      jobId,
      name: "kq-sandbox-attest",
      command: `/bin/bash ${shellQuote(scriptPath)}`,
      cpus: 1,
      memoryMb: 128,
      gpus: 0,
      wallTimeSec: 120,
      workingDir: logDir,
      envVars: {},
      queueName: options.queue,
    };
    const receiptPath = join(root, "job.json");
    const receipt = {
      jobId,
      scheduler: adapter.type,
      queue: options.queue,
      submittedAtUnixMs: Date.now(),
    };
    await writeFile(receiptPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    submissionAttempted = true;
    schedulerJobId = (await adapter.submit(spec)).schedulerJobId;
    await writeFile(`${receiptPath}.tmp`, JSON.stringify({ ...receipt, schedulerJobId }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(`${receiptPath}.tmp`, receiptPath);
    const deadline = now() + (options.timeoutMs ?? 150_000);
    while (now() < deadline) {
      const status = await adapter.status(schedulerJobId);
      if (status.status === "completed" || status.status === "failed") {
        stopped = true;
        const stdout = await readFile(stdoutPath, "utf8").catch(() => "");
        const stderr = await readFile(stderrPath, "utf8").catch(() => "");
        if (status.status !== "completed" || status.exitCode !== 0) {
          throw new Error(`Native Sandbox probe failed: ${status.exitCode}: ${stderr}`);
        }
        const nodes = stdout
          .split("\n")
          .flatMap((line) => (line.startsWith("KQ_ATTESTED_NODE=") ? [line.slice(17).trim()] : []));
        if (!nodes.length || nodes.some((node) => !/^[A-Za-z0-9._-]{1,255}$/.test(node))) {
          throw new Error("Native Sandbox probe did not report a safe compute node");
        }
        return [...new Set(nodes)].toSorted();
      }
      await sleep(500);
    }
    throw new Error("Native Sandbox probe timed out");
  } finally {
    if (adapter && schedulerJobId && !stopped) {
      // A successful cancel RPC is insufficient: retain the files if stop cannot be confirmed.
      await cancelAndConfirmStopped(adapter, schedulerJobId, { jobId });
      stopped = true;
    }
    if (!submissionAttempted || stopped) await rm(root, { recursive: true, force: true });
  }
}
