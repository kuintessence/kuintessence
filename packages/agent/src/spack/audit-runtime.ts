import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, parse } from "node:path";

const SPACK_AUDIT_MEMORY_BYTES = 2_147_483_648;
export const SPACK_MANAGED_MEMORY_BYTES = 4_294_967_296;

export interface SpackAuditRuntimeProfile {
  apptainerPath: string;
  apptainerSha256: string;
  sifPath: string;
  sifSha256: string;
}

export interface SpackAuditFileIdentity {
  canonicalPath: string;
  uid: number;
  mode: number;
  regular: boolean;
  symlink: boolean;
  protectedParents: boolean;
  sha256: string;
}

export interface SpackAuditRuntimeDeps {
  platform?: string;
  uid?: number;
  inspect?: (path: string, signal: AbortSignal) => Promise<SpackAuditFileIdentity>;
}

export function isSpackAuditPath(path: string): boolean {
  return (
    isAbsolute(path) &&
    normalize(path) === path &&
    path !== parse(path).root &&
    !path.endsWith("/") &&
    !/[:,\0\r\n\\]/.test(path)
  );
}

function assertProfile(profile: SpackAuditRuntimeProfile): void {
  if (
    !isSpackAuditPath(profile.apptainerPath) ||
    !isSpackAuditPath(profile.sifPath) ||
    !/^[a-f0-9]{64}$/.test(profile.apptainerSha256) ||
    !/^[a-f0-9]{64}$/.test(profile.sifSha256) ||
    profile.apptainerPath === profile.sifPath
  )
    throw new Error("Invalid Spack audit runtime profile");
}

async function inspectPinnedFile(
  path: string,
  signal: AbortSignal,
): Promise<SpackAuditFileIdentity> {
  signal.throwIfAborted();
  const canonicalPath = await realpath(path);
  let protectedParents = canonicalPath === path;
  for (let parent = dirname(path); ; ) {
    const stat = await lstat(parent);
    protectedParents &&=
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0;
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const entry = await lstat(path);
  if (
    !protectedParents ||
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.uid !== 0 ||
    (entry.mode & 0o022) !== 0 ||
    entry.size > 16 * 1024 ** 3
  ) {
    throw new Error("Spack audit runtime identity is not protected");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.dev !== entry.dev ||
      opened.uid !== entry.uid ||
      opened.mode !== entry.mode ||
      opened.size !== entry.size
    ) {
      throw new Error("Spack audit runtime identity changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > opened.size) throw new Error("Spack audit runtime identity changed");
      hash.update(buffer.subarray(0, bytesRead));
    }
    for (const after of [await handle.stat(), await lstat(path)]) {
      if (
        !after.isFile() ||
        after.ino !== opened.ino ||
        after.dev !== opened.dev ||
        after.uid !== opened.uid ||
        after.mode !== opened.mode ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        total !== opened.size
      ) {
        throw new Error("Spack audit runtime identity changed");
      }
    }
    return {
      canonicalPath,
      uid: opened.uid,
      mode: opened.mode,
      regular: true,
      symlink: false,
      protectedParents,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function verifySpackAuditRuntime(
  profile: SpackAuditRuntimeProfile,
  signal: AbortSignal,
  deps: SpackAuditRuntimeDeps = {},
): Promise<void> {
  signal.throwIfAborted();
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  if ((deps.platform ?? process.platform) !== "linux" || uid <= 0) {
    throw new Error("Spack audit requires a non-root Linux Agent");
  }
  assertProfile(profile);
  const inspect = deps.inspect ?? inspectPinnedFile;
  for (const [path, digest, executable] of [
    [profile.apptainerPath, profile.apptainerSha256, true],
    [profile.sifPath, profile.sifSha256, false],
  ] as const) {
    const identity = await inspect(path, signal);
    signal.throwIfAborted();
    if (
      identity.canonicalPath !== path ||
      !identity.regular ||
      identity.symlink ||
      !identity.protectedParents ||
      identity.uid !== 0 ||
      (identity.mode & 0o022) !== 0 ||
      identity.sha256 !== digest ||
      (executable ? (identity.mode & 0o111) === 0 : (identity.mode & 0o222) !== 0)
    )
      throw new Error("Spack audit runtime identity verification failed");
  }
}

export function buildSpackAuditCommand(
  profile: SpackAuditRuntimeProfile,
  inputDirectory: string,
  manifestDigest: string,
  memoryLimitBytes: number = SPACK_AUDIT_MEMORY_BYTES,
): string[] {
  assertProfile(profile);
  if (
    memoryLimitBytes !== SPACK_AUDIT_MEMORY_BYTES &&
    memoryLimitBytes !== SPACK_MANAGED_MEMORY_BYTES
  ) {
    throw new Error("Invalid Spack isolation memory budget");
  }
  if (!isSpackAuditPath(inputDirectory) || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error("Invalid Spack audit input binding");
  }
  return [
    profile.apptainerPath,
    "exec",
    "--containall",
    "--userns",
    "--cleanenv",
    "--no-home",
    "--no-eval",
    "--disable-cache",
    "--writable-tmpfs",
    "--no-mount",
    "bind-paths,hostfs,cwd,home,sys",
    "--net",
    "--network",
    "none",
    "--drop-caps",
    "all",
    "--security",
    "no-new-privs",
    "--pids-limit",
    "128",
    "--memory",
    String(memoryLimitBytes),
    "--memory-swap",
    String(memoryLimitBytes),
    "--cpus",
    "2",
    "--pwd",
    "/kq/work",
    "--bind",
    `${inputDirectory}:/kq/input:ro`,
    "--bind",
    "/sys/fs/cgroup:/sys/fs/cgroup:ro",
    "--env",
    "HOME=/kq/work/home",
    "--env",
    "SPACK_DISABLE_LOCAL_CONFIG=1",
    "--env",
    "SPACK_USER_CONFIG_PATH=/kq/work/config",
    "--env",
    "SPACK_USER_CACHE_PATH=/kq/work/cache",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    "--env",
    "XDG_RUNTIME_DIR=/kq/work/run",
    "--env",
    "DBUS_SESSION_BUS_ADDRESS=",
    profile.sifPath,
    "/opt/spack/bin/spack",
    "python",
    "/kq/input/source_audit.py",
    manifestDigest,
  ];
}
