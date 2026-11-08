import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createLogger } from "@kuintessence/shared";
import { z } from "zod";
import {
  cancelAndConfirmStopped,
  type JobSpec,
  type KuintessenceJobLookup,
  type SchedulerAdapter,
  shellQuote,
} from "../adapters/base";

interface NativeRuntimeProbeOptions {
  /** Managed root already validated for ownership, permissions and canonical path by the caller. */
  root: string;
  queue: string;
  script: string;
  adapter: (logDir: string) => SchedulerAdapter;
  // A root Agent keeps the script protected and gives only the log directory to the probe user.
  account?: { username: string; uid: number; gid: number };
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const logger = createLogger("sandbox-native-probe");
const executionUserSchema = z.strictObject({
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
});
const schedulerJobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/);
const receiptSchema = z
  .strictObject({
    version: z.literal(1),
    jobId: z.uuid(),
    scheduler: z.enum(["slurm", "pbs-pro", "torque"]),
    queue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    executionUser: executionUserSchema,
    submittedAtUnixMs: z.number().int().positive().safe(),
    phase: z.enum(["prepared", "submitting", "submitted", "stopped"]),
    schedulerJobId: schedulerJobIdSchema.optional(),
  })
  .refine((receipt) =>
    receipt.phase === "stopped"
      ? true
      : receipt.phase === "submitted"
        ? receipt.schedulerJobId !== undefined
        : receipt.schedulerJobId === undefined,
  );
type ProbeReceipt = z.infer<typeof receiptSchema>;

async function protectedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Native Sandbox probe directory is not protected by the Agent");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeReceipt(root: string, value: ProbeReceipt): Promise<void> {
  const data = JSON.stringify(receiptSchema.parse(value));
  const temporary = join(root, `job.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(root, "job.json"));
  await syncDirectory(root);
}

async function readReceipt(root: string): Promise<ProbeReceipt> {
  const file = await open(
    join(root, "job.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16_384
    ) {
      throw new Error("Native Sandbox probe receipt is not a private bounded file");
    }
    return receiptSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}

async function removeInactive(
  root: string,
  name: ".attest-retired" | ".attest-preparing",
): Promise<void> {
  const retired = join(root, name);
  if (!(await readdir(root)).includes(name)) return;
  await protectedDirectory(retired);
  await rm(retired, { recursive: true });
  await syncDirectory(root);
}

async function retire(root: string): Promise<void> {
  // The retired name is a durable stop marker even if a crash interrupts recursive deletion.
  await rename(join(root, ".attest-active"), join(root, ".attest-retired"));
  await syncDirectory(root);
  await removeInactive(root, ".attest-retired");
}

async function recoverProbe(
  options: NativeRuntimeProbeOptions,
  executionUser: ProbeReceipt["executionUser"],
): Promise<void> {
  await removeInactive(options.root, ".attest-retired");
  await removeInactive(options.root, ".attest-preparing");
  const pending = (await readdir(options.root)).filter((entry) => entry.startsWith(".attest-"));
  if (!pending.length) return;
  if (pending.length !== 1 || pending[0] !== ".attest-active") {
    throw new Error("Legacy Sandbox probe requires inspection; retaining its files");
  }
  const root = join(options.root, ".attest-active");
  await protectedDirectory(root);
  const receipt = await readReceipt(root);
  if (receipt.phase === "prepared" || receipt.phase === "stopped") {
    await retire(options.root);
    return;
  }
  const adapter = options.adapter(join(root, "logs"));
  if (
    receipt.scheduler !== adapter.type ||
    receipt.queue !== options.queue ||
    receipt.executionUser.uid !== executionUser.uid ||
    receipt.executionUser.gid !== executionUser.gid ||
    receipt.executionUser.username !== executionUser.username
  ) {
    throw new Error("Native Sandbox probe recovery context changed; retaining its receipt");
  }
  const lookup: KuintessenceJobLookup = {
    jobId: receipt.jobId,
    schedulerName: "kq-sandbox-attest",
    submittedAfterUnixMs: receipt.submittedAtUnixMs,
    executionUser,
  };
  const found = await adapter.findByKuintessenceJobId?.(lookup);
  if (
    found?.status !== "found" ||
    !schedulerJobIdSchema.safeParse(found.schedulerJobId).success ||
    (receipt.schedulerJobId && receipt.schedulerJobId !== found.schedulerJobId)
  ) {
    throw new Error(
      "Native Sandbox probe is active or unresolved; original job identity is not confirmed",
    );
  }
  if (!(await adapter.confirmStopped?.(found.schedulerJobId, lookup))) {
    await cancelAndConfirmStopped(adapter, found.schedulerJobId, lookup);
  }
  await writeReceipt(root, { ...receipt, phase: "stopped", schedulerJobId: found.schedulerJobId });
  await retire(options.root);
  logger.info(
    { jobId: receipt.jobId, schedulerJobId: found.schedulerJobId },
    "Recovered and stopped original Sandbox runtime probe",
  );
}

/** The lock survives helper exit and is released by Agent death. Never unlink its inode. */
export async function runNativeRuntimeProbe(options: NativeRuntimeProbeOptions): Promise<string[]> {
  if (process.platform !== "linux") throw new Error("Native Sandbox probe requires Linux flock");
  const lock = await open(
    join(options.root, ".attestation.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = await lock.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("Native Sandbox probe lock must be a private owned file");
    }
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
      timeout: 2000,
    });
    if (result.status === 1)
      throw new Error(
        "Native Sandbox probe is active or unresolved; another process holds its lock",
      );
    if (result.error || result.status !== 0)
      throw new Error("Native Sandbox probe requires working util-linux flock");
    return await runLockedProbe(options);
  } finally {
    await lock.close();
  }
}

/** Do not delete a probe's files until its original scheduler job is known to have stopped. */
async function runLockedProbe(options: NativeRuntimeProbeOptions): Promise<string[]> {
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
  const account = options.account ?? userInfo();
  const executionUser = executionUserSchema.parse({
    username: account.username,
    uid: account.uid,
    gid: account.gid,
  });
  await recoverProbe(options, executionUser);
  const root = join(options.root, ".attest-active");
  const logDir = join(root, "logs");
  const scriptPath = join(root, "probe.sh");
  const adapter = options.adapter(logDir);
  if (!["slurm", "pbs-pro", "torque"].includes(adapter.type)) {
    throw new Error("Native Sandbox probe scheduler is unsupported");
  }
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? Bun.sleep;
  const jobId = randomUUID();
  let submissionAttempted = false;
  let stopped = false;
  let schedulerJobId: string | undefined;
  let receipt = receiptSchema.parse({
    version: 1,
    jobId,
    scheduler: adapter.type,
    queue: options.queue,
    executionUser,
    submittedAtUnixMs: Date.now(),
    phase: "prepared",
  });
  // A crash before the receipt is durable leaves only never-submitted preparation files.
  const preparing = join(options.root, ".attest-preparing");
  await mkdir(preparing, { mode: 0o700 });
  await writeReceipt(preparing, receipt);
  await rename(preparing, root);
  await syncDirectory(options.root);
  try {
    const logPrefix =
      adapter.type === "slurm" ? "kq-" : adapter.type === "pbs-pro" ? "kq-pbs-" : "kq-torque-";
    const stdoutPath = join(logDir, `${logPrefix}${jobId}.out`);
    const stderrPath =
      adapter.type === "slurm" ? stdoutPath : join(logDir, `${logPrefix}${jobId}.err`);
    await mkdir(logDir, { mode: 0o700 });
    const script = await open(scriptPath, "wx", 0o444);
    try {
      await script.writeFile(options.script);
      await script.sync();
    } finally {
      await script.close();
    }
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
    await writeReceipt(root, { ...receipt, phase: "submitting" });
    submissionAttempted = true;
    schedulerJobId = schedulerJobIdSchema.parse((await adapter.submit(spec)).schedulerJobId);
    receipt = { ...receipt, phase: "submitted", schedulerJobId };
    await writeReceipt(root, receipt);
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
    if (schedulerJobId && !stopped) {
      // A successful cancel RPC is insufficient: retain the files if stop cannot be confirmed.
      await cancelAndConfirmStopped(adapter, schedulerJobId, { jobId });
      stopped = true;
    }
    if (!submissionAttempted || stopped) {
      await writeReceipt(root, { ...receipt, phase: "stopped", schedulerJobId });
      await retire(options.root);
    }
  }
}
