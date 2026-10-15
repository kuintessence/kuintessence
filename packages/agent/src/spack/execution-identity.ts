import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, statfs } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";

export const RECOVERY_REQUIRED = "SPACK_RECOVERY_REQUIRED: store writer recovery required";
export const LOCK_HELD = "SPACK_LOCK_HELD: store writer lock held";
export const INTERRUPTED = "SPACK_INTERRUPTED: software operation interrupted";
const instance = randomUUID();
const NativeExecutionIdentitySchema = z.strictObject({
  host: z.string().regex(/^[a-f0-9]{64}$/),
  boot: z.string().uuid(),
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/),
  token: z.string().uuid(),
  instance: z.string().uuid().optional(),
});
export const ExecutionIdentitySchema = z.union([
  NativeExecutionIdentitySchema,
  NativeExecutionIdentitySchema.extend({
    host: z.null(),
    boot: z.null(),
    start: z.null(),
    instance: z.string().uuid(),
  }),
]);
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export async function processStart(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) throw new Error(RECOVERY_REQUIRED);
    return start;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(RECOVERY_REQUIRED);
  }
}

async function rootIdentityFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 256) {
      throw new Error(RECOVERY_REQUIRED);
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}

export function hostIdentity(machine: string, host: string): string {
  if (
    !/^[a-f0-9]{32}$/.test(machine) ||
    /^0+$/.test(machine) ||
    host.length > 253 ||
    !host.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  ) {
    throw new Error(RECOVERY_REQUIRED);
  }
  return createHash("sha256").update(`${machine}:${host.toLowerCase()}`).digest("hex");
}

export async function executionIdentity(): Promise<ExecutionIdentity> {
  try {
    // Only trusted native identity can prove a host reboot or a stopped foreign instance.
    if (
      process.platform !== "linux" ||
      (await readlink("/proc/self/ns/pid")) !== "pid:[4026531836]" ||
      (await readlink("/proc/self/ns/uts")) !== "uts:[4026531838]" ||
      (await statfs("/proc/sys/kernel/random/boot_id")).type !== 0x9fa0
    ) {
      throw new Error(RECOVERY_REQUIRED);
    }
    const parent = await lstat("/etc");
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0
    ) {
      throw new Error(RECOVERY_REQUIRED);
    }
    const machine = await rootIdentityFile("/etc/machine-id");
    const host = await rootIdentityFile("/etc/hostname");
    if (host !== hostname()) throw new Error(RECOVERY_REQUIRED);
    return ExecutionIdentitySchema.parse({
      host: hostIdentity(machine, host),
      boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      pid: process.pid,
      start: await processStart(process.pid),
      token: randomUUID(),
      instance,
    });
  } catch {
    // An untrusted namespace can write normally, but cannot prove an old execution stopped.
    return { host: null, boot: null, start: null, pid: process.pid, token: randomUUID(), instance };
  }
}

export async function executionState(
  owner: ExecutionIdentity,
  current: ExecutionIdentity,
): Promise<"alive" | "stopped" | "rebooted" | "unknown"> {
  if (owner.host === null || current.host === null) {
    return owner.instance && owner.instance === current.instance && owner.pid === current.pid
      ? "alive"
      : "unknown";
  }
  if (owner.host !== current.host) return "unknown";
  if (owner.boot !== current.boot) return "rebooted";
  try {
    return (await processStart(owner.pid)) === owner.start ? "alive" : "stopped";
  } catch {
    return "unknown";
  }
}

export const softwareExecution = new AsyncLocalStorage<{
  identity: ExecutionIdentity;
  operationId: string;
  bindStore: (root: string) => Promise<void>;
}>();
export const installWorkerExecution = new AsyncLocalStorage<{
  start: (recordId: string) => Promise<void>;
  finish: () => Promise<void>;
}>();
