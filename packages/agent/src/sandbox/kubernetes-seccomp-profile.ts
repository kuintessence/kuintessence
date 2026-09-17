import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../config";

const SeccompArgumentSchema = z.object({
  index: z.number().int(),
  value: z.number().int(),
  op: z.string(),
});

const SeccompSyscallSchema = z.object({
  names: z.array(z.string()),
  action: z.string(),
  args: z.array(SeccompArgumentSchema).optional(),
  errnoRet: z.number().int().optional(),
});

const SeccompProfileSchema = z.object({
  defaultAction: z.string(),
  architectures: z.array(z.string()).optional(),
  syscalls: z.array(SeccompSyscallSchema),
});

export interface KubernetesSeccompProfileMetadata {
  canonicalPath: string;
  contents: string;
  isRegularFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
  sha256: string;
  ancestorsRootOwnedWriteProtected: boolean;
}

export interface KubernetesSeccompProfileAttestation {
  ready: boolean;
  localhostProfile?: string;
  nodeName?: string;
  canonicalPath?: string;
  sha256?: string;
  missingRequirements: string[];
}

export interface KubernetesSeccompProfileAttestationDeps {
  hostName?: () => string;
  inspectProfile?: (path: string) => Promise<KubernetesSeccompProfileMetadata>;
}

export async function attestKubernetesSeccompProfile(
  config: AgentConfig,
  deps: KubernetesSeccompProfileAttestationDeps = {},
): Promise<KubernetesSeccompProfileAttestation> {
  const localhostProfile = config.AGENT_SANDBOX_K8S_SECCOMP_PROFILE;
  const expectedSha256 = config.AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256;
  const nodeName = config.AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME;
  if (!localhostProfile || !expectedSha256 || !nodeName) {
    return { ready: false, missingRequirements: ["kubernetes-localhost-seccomp-profile"] };
  }
  const expectedPath = join(config.AGENT_SANDBOX_K8S_SECCOMP_ROOT, localhostProfile);
  const missingRequirements: string[] = [];
  try {
    const inspectProfile =
      deps.inspectProfile ??
      ((path: string) => inspectProfileAtPath(path, config.AGENT_SANDBOX_K8S_SECCOMP_ROOT));
    const profile = await inspectProfile(expectedPath);
    if (profile.canonicalPath !== expectedPath) {
      missingRequirements.push("kubernetes-seccomp-canonical-path");
    }
    if (!profile.isRegularFile || profile.isSymbolicLink) {
      missingRequirements.push("kubernetes-seccomp-regular-file");
    }
    if (
      profile.uid !== 0 ||
      (profile.mode & 0o022) !== 0 ||
      !profile.ancestorsRootOwnedWriteProtected
    ) {
      missingRequirements.push("kubernetes-seccomp-root-owned-write-protected");
    }
    if (profile.sha256 !== expectedSha256) {
      missingRequirements.push("kubernetes-seccomp-sha256-mismatch");
    }
    if ((deps.hostName ?? hostname)() !== nodeName) {
      missingRequirements.push("kubernetes-seccomp-local-node-mismatch");
    }
    if (!deniesInternetSockets(profile.contents)) {
      missingRequirements.push("kubernetes-seccomp-network-deny");
    }
    return {
      ready: missingRequirements.length === 0,
      localhostProfile,
      nodeName,
      canonicalPath: profile.canonicalPath,
      sha256: profile.sha256,
      missingRequirements,
    };
  } catch {
    return {
      ready: false,
      localhostProfile,
      nodeName,
      missingRequirements: ["kubernetes-seccomp-profile-validation"],
    };
  }
}

export async function assertKubernetesSeccompProfileCurrent(
  config: AgentConfig,
  expected: KubernetesSeccompProfileAttestation,
  deps: KubernetesSeccompProfileAttestationDeps = {},
): Promise<void> {
  const current = await attestKubernetesSeccompProfile(config, deps);
  if (
    !current.ready ||
    current.localhostProfile !== expected.localhostProfile ||
    current.nodeName !== expected.nodeName ||
    current.canonicalPath !== expected.canonicalPath ||
    current.sha256 !== expected.sha256
  ) {
    throw new Error(
      "Kubernetes Sandbox Localhost seccomp attestation changed before scheduler submission",
    );
  }
}

export function enforceKubernetesSeccompStartupBinding(
  profile: KubernetesSeccompProfileAttestation,
  startupBound: boolean,
): KubernetesSeccompProfileAttestation {
  if (startupBound || !profile.ready) return profile;
  return {
    ...profile,
    ready: false,
    missingRequirements: ["kubernetes-seccomp-agent-restart-required"],
  };
}

function deniesInternetSockets(contents: string): boolean {
  const parsed = SeccompProfileSchema.safeParse(JSON.parse(contents));
  if (!parsed.success || parsed.data.defaultAction !== "SCMP_ACT_ALLOW") return false;
  if (
    parsed.data.architectures?.length !== 1 ||
    parsed.data.architectures[0] !== "SCMP_ARCH_X86_64"
  ) {
    return false;
  }
  const socketRules = parsed.data.syscalls.filter((rule) => rule.names.includes("socket"));
  if (socketRules.length !== 1) return false;
  const socketRule = socketRules[0];
  const argument = socketRule?.args?.[0];
  const blocksNonUnixSockets =
    socketRule?.names.length === 1 &&
    socketRule.action === "SCMP_ACT_ERRNO" &&
    socketRule.errnoRet === 1 &&
    socketRule.args?.length === 1 &&
    argument?.index === 0 &&
    argument.value === 1 &&
    argument.op === "SCMP_CMP_NE";
  const ioUringRules = parsed.data.syscalls.filter((rule) => rule.names.includes("io_uring_setup"));
  const ioUringRule = ioUringRules[0];
  const blocksIoUring =
    ioUringRules.length === 1 &&
    ioUringRule?.action === "SCMP_ACT_ERRNO" &&
    ioUringRule.errnoRet === 1 &&
    ioUringRule.args === undefined;
  return blocksNonUnixSockets && blocksIoUring;
}

async function inspectProfileAtPath(
  path: string,
  profileRoot: string,
): Promise<KubernetesSeccompProfileMetadata> {
  const [file, canonicalPath, contents, sha256] = await Promise.all([
    lstat(path),
    realpath(path),
    readFile(path, "utf8"),
    sha256FileAtPath(path),
  ]);
  return {
    canonicalPath,
    contents,
    isRegularFile: file.isFile(),
    isSymbolicLink: file.isSymbolicLink(),
    mode: file.mode,
    uid: file.uid,
    sha256,
    ancestorsRootOwnedWriteProtected: await trustedDirectoryChain(dirname(path), profileRoot),
  };
}

async function trustedDirectoryChain(start: string, root: string): Promise<boolean> {
  const directories: string[] = [];
  let current = start;
  while (true) {
    if (current !== root && !current.startsWith(`${root}/`)) return false;
    directories.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  const values = await Promise.all(directories.map((directory) => lstat(directory)));
  return values.every(
    (value) =>
      value.isDirectory() &&
      !value.isSymbolicLink() &&
      value.uid === 0 &&
      (value.mode & 0o022) === 0,
  );
}

async function sha256FileAtPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
