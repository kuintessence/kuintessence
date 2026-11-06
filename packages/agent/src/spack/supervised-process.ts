import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  realSpackAuditProcess,
  type SpackAuditProcess,
  validatedEnvironment,
} from "./audit-process";
import { isSpackAuditPath, SPACK_MANAGED_MEMORY_BYTES } from "./audit-runtime";
import {
  ExecutionIdentitySchema,
  executionIdentity,
  executionState,
  LOCK_HELD,
  RECOVERY_REQUIRED,
  SpackInstallationPending,
} from "./execution-identity";
import authorizationGuard from "./worker/authorization_guard.py" with { type: "text" };

const UnitSchema = z.string().regex(/^kq-spack-[a-f0-9-]{36}\.service$/);
const AuthorizationSchema = z.strictObject({
  unit: UnitSchema,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bootDeadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const SpackProcessSupervisionSchema = z.strictObject({
  directory: z.string().refine(isSpackAuditPath),
  unit: UnitSchema,
});
export type SpackProcessSupervision = z.infer<typeof SpackProcessSupervisionSchema>;
const RecordSchema = z.strictObject({
  version: z.literal(1),
  unit: UnitSchema,
  identity: ExecutionIdentitySchema,
  cwd: z.string().refine(isSpackAuditPath),
  managerGroup: z.string().regex(/^\/user\.slice\/user-\d+\.slice\/user@\d+\.service$/),
  authorizationRequired: z.literal(true).optional(),
  memoryBytes: z
    .number()
    .int()
    .min(1024 ** 3)
    .max(SPACK_MANAGED_MEMORY_BYTES)
    .multipleOf(1024 ** 2),
});
type Record = z.infer<typeof RecordSchema>;
type RunOptions = Parameters<SpackAuditProcess["run"]>[1];

/** Only raised after the launch gate is durable and the entire unit cgroup is empty. */
export class SpackProcessStoppedError extends Error {}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function privateDirectory(path: string, create = false): Promise<void> {
  if (!isSpackAuditPath(path) || (await realpath(dirname(path))) !== dirname(path))
    throw new Error(RECOVERY_REQUIRED);
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const stat = await lstat(ancestor);
    const sticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      ((stat.mode & 0o022) !== 0 && !sticky)
    )
      throw new Error(RECOVERY_REQUIRED);
    if (ancestor === "/") break;
  }
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(RECOVERY_REQUIRED);
}

async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function save(path: string, value: unknown) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function read(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16384
    )
      throw new Error(RECOVERY_REQUIRED);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function managerEnvironment() {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) throw new Error(RECOVERY_REQUIRED);
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

async function control(args: string[]) {
  return realSpackAuditProcess.run(["/usr/bin/systemctl", "--user", "--no-ask-password", ...args], {
    cwd: "/",
    env: managerEnvironment(),
    timeoutMs: 10000,
    maxOutputBytes: 65536,
  });
}

async function managerGroup(): Promise<string> {
  const result = await control(["show", "--property=ControlGroup", "--value"]);
  const group = result.stdout.trim();
  const uid = process.getuid?.();
  if (result.exitCode !== 0 || group !== `/user.slice/user-${uid}.slice/user@${uid}.service`)
    throw new Error(RECOVERY_REQUIRED);
  // A hidden/foreign cgroup namespace must not make an existing unit look absent.
  const path = join("/sys/fs/cgroup", group);
  if (
    (await statfs(path)).type !== 0x63677270 ||
    !(await readFile(join(path, "cgroup.events"), "utf8")).split("\n").includes("populated 1")
  )
    throw new Error(RECOVERY_REQUIRED);
  return group;
}

export async function prepareSpackProcessSupervision(
  cwd: string,
  memoryBytes: number,
  authorizedUntil?: number,
): Promise<SpackProcessSupervision> {
  RecordSchema.shape.memoryBytes.parse(memoryBytes);
  await privateDirectory(cwd);
  const unit = `kq-spack-${randomUUID()}.service`;
  const record = RecordSchema.parse({
    version: 1,
    unit,
    cwd,
    memoryBytes,
    identity: await executionIdentity(),
    managerGroup: await managerGroup(),
    ...(authorizedUntil !== undefined ? { authorizationRequired: true } : {}),
  });
  const root = join(dirname(cwd), ".supervisors");
  await privateDirectory(root, true);
  await syncDirectory(dirname(root));
  const directory = join(root, unit);
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(root);
  await save(join(directory, "record.json"), record);
  const ref = { directory, unit };
  if (authorizedUntil !== undefined) {
    try {
      await writeSpackProcessAuthorization(ref, authorizedUntil, true);
      await writeFile(join(directory, "authorization_guard.py"), authorizationGuard, {
        mode: 0o400,
        flag: "wx",
      });
    } catch (error) {
      await stopSpackSupervisedProcess(ref);
      throw error;
    }
  }
  return ref;
}

/** Only the original live Agent can extend its unit; expiry alone never grants restart rights. */
export async function renewSpackProcessAuthorization(
  ref: SpackProcessSupervision,
  expiresAt: number,
): Promise<void> {
  await writeSpackProcessAuthorization(ref, expiresAt, false);
}

async function writeSpackProcessAuthorization(
  ref: SpackProcessSupervision,
  expiresAt: number,
  initial: boolean,
): Promise<void> {
  const record = await load(ref);
  if (
    !record.authorizationRequired ||
    record.identity.instance !== (await executionIdentity()).instance
  )
    throw new Error(RECOVERY_REQUIRED);
  try {
    await read(join(ref.directory, "revoked.json"));
    throw new Error("Spack process authorization revoked");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  // /proc uptime and Python CLOCK_BOOTTIME share a host clock, including suspend time.
  const uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
  const remaining = expiresAt - Date.now();
  if (!Number.isFinite(uptime) || !Number.isSafeInteger(expiresAt) || remaining > 30_000)
    throw new Error("Invalid federation installation grant expiry");
  if (remaining <= 0) {
    if (initial) throw new SpackInstallationPending();
    throw new Error("Spack process authorization expired");
  }
  if (!initial) {
    const previous = AuthorizationSchema.parse(
      await read(join(ref.directory, "authorization.json")),
    );
    if (
      previous.unit !== ref.unit ||
      previous.expiresAt <= Date.now() ||
      previous.bootDeadline <= uptime * 1000
    )
      throw new Error("Spack process authorization expired");
  }
  const temporary = join(ref.directory, `lease-${randomUUID()}.json`);
  try {
    await save(temporary, {
      unit: ref.unit,
      expiresAt,
      bootDeadline: Math.floor(uptime * 1000) + remaining,
    });
    await rename(temporary, join(ref.directory, "authorization.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function load(ref: SpackProcessSupervision): Promise<Record> {
  SpackProcessSupervisionSchema.parse(ref);
  await privateDirectory(ref.directory);
  const record = RecordSchema.parse(await read(join(ref.directory, "record.json")));
  if (
    record.unit !== ref.unit ||
    ref.directory !== join(dirname(record.cwd), ".supervisors", record.unit)
  )
    throw new Error(RECOVERY_REQUIRED);
  return record;
}

/** No launch can pass the persistent gate after this returns, even after a lost StartUnit reply. */
export async function stopSpackSupervisedProcess(ref: SpackProcessSupervision): Promise<void> {
  const record = await load(ref);
  try {
    if ((await read(join(ref.directory, "stopped.json"))) !== ref.unit)
      throw new Error(RECOVERY_REQUIRED);
    if ((await read(join(ref.directory, "revoked.json"))) !== ref.unit)
      throw new Error(RECOVERY_REQUIRED);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const current = await executionIdentity();
  const state = await executionState(record.identity, current);
  const sameInstance = record.identity.instance === current.instance;
  if (state === "unknown" || (state === "alive" && !sameInstance))
    throw new Error(RECOVERY_REQUIRED);
  try {
    await save(join(ref.directory, "revoked.json"), ref.unit);
  } catch (error) {
    if (!hasCode(error, "EEXIST") || (await read(join(ref.directory, "revoked.json"))) !== ref.unit)
      throw error;
  }
  if (state !== "rebooted") {
    if ((await managerGroup()) !== record.managerGroup) throw new Error(RECOVERY_REQUIRED);
    // StopUnit may fail because the unit was never created or has already been collected.
    await control(["stop", ref.unit]);
    const shown = await control([
      "show",
      ref.unit,
      "--property=LoadState,ActiveState,ControlGroup",
    ]);
    const fields = new Map(
      shown.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as const;
        }),
    );
    if (
      !(
        (fields.get("LoadState") === "not-found" && fields.get("ActiveState") === "inactive") ||
        (shown.exitCode === 0 && ["inactive", "failed"].includes(fields.get("ActiveState") ?? ""))
      )
    )
      throw new Error(RECOVERY_REQUIRED);
    const group = join("/sys/fs/cgroup", record.managerGroup, "app.slice", ref.unit);
    const actualGroup = fields.get("ControlGroup");
    if (actualGroup && actualGroup !== `${record.managerGroup}/app.slice/${ref.unit}`)
      throw new Error(RECOVERY_REQUIRED);
    try {
      if (
        (await statfs(group)).type !== 0x63677270 ||
        !(await readFile(join(group, "cgroup.events"), "utf8")).split("\n").includes("populated 0")
      )
        throw new Error(RECOVERY_REQUIRED);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  try {
    await save(join(ref.directory, "stopped.json"), ref.unit);
  } catch (error) {
    if (!hasCode(error, "EEXIST") || (await read(join(ref.directory, "stopped.json"))) !== ref.unit)
      throw error;
  }
}

export async function removeSpackSupervisedInputs(ref: SpackProcessSupervision): Promise<void> {
  const record = await load(ref);
  if (!/^run-[a-zA-Z0-9]+$/.test(basename(record.cwd))) throw new Error(RECOVERY_REQUIRED);
  await stopSpackSupervisedProcess(ref);
  try {
    await privateDirectory(record.cwd);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  await rm(record.cwd, { recursive: true, force: true });
}

/** Reclaim only stopped owners; a second live auditor cannot cancel another instance's work. */
export async function recoverSpackSupervisedProcesses(runs: string): Promise<void> {
  const root = join(runs, ".supervisors");
  try {
    await privateDirectory(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const current = await executionIdentity();
  for await (const entry of await opendir(root)) {
    const ref = { directory: join(root, entry.name), unit: entry.name };
    const record = await load(ref);
    try {
      if ((await read(join(ref.directory, "stopped.json"))) !== ref.unit)
        throw new Error(RECOVERY_REQUIRED);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const state = await executionState(record.identity, current);
      if (state === "alive") throw new Error(LOCK_HELD);
      if (state === "unknown") throw new Error(RECOVERY_REQUIRED);
    }
    await removeSpackSupervisedInputs(ref);
  }
}

export async function runSpackSupervisedProcess(
  command: string[],
  options: RunOptions,
  ref: SpackProcessSupervision,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = validatedEnvironment(command, options);
  const record = await load(ref);
  if (record.cwd !== options.cwd) throw new Error(RECOVERY_REQUIRED);
  let runtimeMs = options.timeoutMs;
  let operationDeadline: number | undefined;
  if (record.authorizationRequired) {
    const lease = AuthorizationSchema.parse(await read(join(ref.directory, "authorization.json")));
    const uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
    operationDeadline = Math.floor(uptime * 1000) + options.timeoutMs;
    runtimeMs = Math.floor(
      Math.min(runtimeMs, lease.expiresAt - Date.now(), lease.bootDeadline - uptime * 1000),
    );
    if (
      lease.unit !== ref.unit ||
      !Number.isSafeInteger(runtimeMs) ||
      runtimeMs <= 0 ||
      runtimeMs > 30_000
    ) {
      await stopSpackSupervisedProcess(ref);
      throw new SpackProcessStoppedError("Expired Spack process authorization");
    }
  }
  const commandPrefix = record.authorizationRequired
    ? [
        "/usr/bin/python3",
        join(ref.directory, "authorization_guard.py"),
        join(ref.directory, "authorization.json"),
        ref.unit,
        String(operationDeadline),
      ]
    : [];
  let result: Awaited<ReturnType<SpackAuditProcess["run"]>> | undefined;
  let failed = false;
  try {
    result = await realSpackAuditProcess.run(
      [
        "/usr/bin/systemd-run",
        "--user",
        "--no-ask-password",
        "--quiet",
        "--pipe",
        "--wait",
        "--collect",
        `--service-type=${record.authorizationRequired ? "notify" : "exec"}`,
        "--expand-environment=no",
        `--unit=${ref.unit}`,
        "--slice=app.slice",
        `--working-directory=${record.cwd}`,
        `--property=ConditionPathExists=!${join(ref.directory, "revoked.json").replaceAll("%", "%%")}`,
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--property=TimeoutStopSec=5s",
        "--property=Restart=no",
        ...(record.authorizationRequired
          ? ["--property=NotifyAccess=main", `--property=TimeoutStartSec=${runtimeMs / 1000}s`]
          : []),
        "--property=Delegate=no",
        "--property=TasksMax=128",
        `--property=MemoryMax=${record.memoryBytes}`,
        "--property=MemorySwapMax=0",
        "--property=CPUQuota=200%",
        `--property=RuntimeMaxSec=${runtimeMs / 1000}s`,
        "--",
        ...commandPrefix,
        "/usr/bin/env",
        "-i",
        "--",
        ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ...command,
      ],
      { ...options, env: managerEnvironment() },
    );
  } catch {
    failed = true;
  }
  await stopSpackSupervisedProcess(ref);
  if (failed || !result)
    throw new SpackProcessStoppedError("Spack worker failed after confirmed stop");
  return result;
}
