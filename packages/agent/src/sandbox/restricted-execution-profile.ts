import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import type { SandboxTrustedExecutionProfile } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import type { AgentConfig } from "../config";
import type { AgentSandboxCapability } from "./capability";

interface RestrictedRuntimeCacheFact {
  kind: "OCI" | "SIF";
  localPath: string;
  signatureVerified: boolean;
}

export interface TrustedExecutableIdentity {
  device: number;
  inode: number;
  sha256: string;
}

export interface TrustedExecutableMetadata extends TrustedExecutableIdentity {
  canonicalPath: string;
  isRegularFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
}

export interface RestrictedExecutionProfile {
  enabled: boolean;
  ready: boolean;
  runtimeDigest?: string;
  runtimePath?: string;
  apptainerPath: string;
  apptainerIdentity?: TrustedExecutableIdentity;
  profileId?: string;
  trustedWrapperPath: string;
  trustedWrapperExpectedSha256?: string;
  trustedWrapperIdentity?: TrustedExecutableIdentity;
  executionProfile?: SandboxTrustedExecutionProfile;
  missingRequirements: string[];
}

export interface RestrictedExecutionProfileValidationDeps {
  lstatFile?: typeof lstat;
  canonicalPath?: typeof realpath;
  sha256File?: (path: string) => Promise<string>;
  inspectExecutable?: (path: string) => Promise<TrustedExecutableMetadata>;
}

export function buildRestrictedExecutionProfile(
  config: AgentConfig,
  sandboxCapability: AgentSandboxCapability,
  adapterType: string,
  attestedRuntimeCache: Readonly<Record<string, RestrictedRuntimeCacheFact>> = {},
): RestrictedExecutionProfile {
  const enabled = config.AGENT_RESTRICTED_DATA_ISOLATION;
  const missingRequirements: string[] = [];
  const runtimeDigest = config.AGENT_RESTRICTED_EXECUTION_SIF_DIGEST;
  const runtime = runtimeDigest ? attestedRuntimeCache[runtimeDigest] : undefined;
  if (!enabled) missingRequirements.push("restricted-execution-disabled");
  if (adapterType === "kubernetes") missingRequirements.push("hpc-sif-profile-required");
  if (sandboxCapability.readiness !== "ready") {
    missingRequirements.push("sandbox-security-posture");
  }
  if (!runtimeDigest) missingRequirements.push("pinned-sif-digest");
  if (!runtime || runtime.kind !== "SIF" || !runtime.signatureVerified) {
    missingRequirements.push("pinned-signature-verified-sif");
  }
  return {
    enabled,
    ready: false,
    runtimeDigest,
    runtimePath: runtime?.localPath,
    apptainerPath: config.AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH,
    profileId: config.AGENT_RESTRICTED_EXECUTION_PROFILE_ID,
    trustedWrapperPath: config.AGENT_RESTRICTED_EXECUTION_WRAPPER_PATH,
    trustedWrapperExpectedSha256: config.AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256,
    missingRequirements,
  };
}

/**
 * Proves the local SIF and the exact Apptainer binary before advertising the
 * restricted profile. The binary must be a canonical root-owned path shared by
 * the Agent and every eligible compute node; PATH lookup is never trusted.
 */
export async function validateRestrictedExecutionProfile(
  profile: RestrictedExecutionProfile,
  spawner: Spawner,
  deps: RestrictedExecutionProfileValidationDeps = {},
): Promise<RestrictedExecutionProfile> {
  const missingRequirements = [...profile.missingRequirements];
  if (missingRequirements.length > 0 || !profile.runtimeDigest || !profile.runtimePath) {
    return { ...profile, missingRequirements };
  }
  const statFile = deps.lstatFile ?? lstat;
  const canonicalPath = deps.canonicalPath ?? realpath;
  const sha256File = deps.sha256File ?? sha256FileAtPath;
  try {
    const executable = await inspectTrustedExecutable(
      profile.apptainerPath,
      deps,
      statFile,
      canonicalPath,
      sha256File,
    );
    if (!profile.apptainerPath.startsWith("/")) {
      missingRequirements.push("apptainer-binary-absolute-path");
    }
    if (!executable.isRegularFile || executable.isSymbolicLink) {
      missingRequirements.push("apptainer-binary-regular-file");
    }
    if (executable.canonicalPath !== profile.apptainerPath) {
      missingRequirements.push("apptainer-binary-canonical-path");
    }
    if (executable.uid !== 0 || (executable.mode & 0o022) !== 0) {
      missingRequirements.push("apptainer-binary-nonprivileged-write-protection");
    }
    if ((executable.mode & 0o111) === 0) missingRequirements.push("apptainer-binary-executable");

    const wrapper = await inspectTrustedExecutable(
      profile.trustedWrapperPath,
      deps,
      statFile,
      canonicalPath,
      sha256File,
    );
    if (
      wrapper.canonicalPath !== profile.trustedWrapperPath ||
      !wrapper.isRegularFile ||
      wrapper.isSymbolicLink ||
      wrapper.uid !== 0 ||
      (wrapper.mode & 0o022) !== 0 ||
      (wrapper.mode & 0o111) === 0
    ) {
      missingRequirements.push("trusted-wrapper-root-owned-write-protected");
    }
    if (!profile.trustedWrapperExpectedSha256) {
      missingRequirements.push("trusted-wrapper-sha256");
    } else if (wrapper.sha256 !== profile.trustedWrapperExpectedSha256) {
      missingRequirements.push("trusted-wrapper-sha256-mismatch");
    }
    const runtime = await statFile(profile.runtimePath);
    if (!runtime.isFile() || runtime.isSymbolicLink()) {
      missingRequirements.push("pinned-sif-regular-file");
    } else if ((runtime.mode & 0o222) !== 0) {
      missingRequirements.push("pinned-sif-readonly");
    }
    const canonical = await canonicalPath(profile.runtimePath);
    if (canonical !== profile.runtimePath) missingRequirements.push("pinned-sif-canonical-path");
    if (missingRequirements.length === 0) {
      const digest = `sha256:${await sha256File(profile.runtimePath)}`;
      if (digest !== profile.runtimeDigest) missingRequirements.push("pinned-sif-digest-mismatch");
    }
    if (missingRequirements.length === 0) {
      const result = await spawner.run([executable.canonicalPath, "verify", profile.runtimePath], {
        timeoutMs: 15_000,
      });
      if (result.exitCode !== 0) missingRequirements.push("apptainer-sif-signature-verification");
    }
    return {
      ...profile,
      apptainerPath: executable.canonicalPath,
      apptainerIdentity:
        missingRequirements.length === 0
          ? { device: executable.device, inode: executable.inode, sha256: executable.sha256 }
          : undefined,
      trustedWrapperIdentity:
        missingRequirements.length === 0
          ? { device: wrapper.device, inode: wrapper.inode, sha256: wrapper.sha256 }
          : undefined,
      executionProfile:
        missingRequirements.length === 0 && profile.profileId
          ? {
              profileId: profile.profileId,
              apptainerCanonicalPath: executable.canonicalPath,
              apptainerSha256: executable.sha256,
              sifCanonicalPath: profile.runtimePath,
              sifSha256: profile.runtimeDigest.slice("sha256:".length),
              trustedWrapperCanonicalPath: wrapper.canonicalPath,
              trustedWrapperSha256: wrapper.sha256,
            }
          : undefined,
      ready: missingRequirements.length === 0,
      missingRequirements,
    };
  } catch {
    return {
      ...profile,
      ready: false,
      missingRequirements: [...missingRequirements, "restricted-execution-profile-validation"],
    };
  }
}

/** Re-checks the binary directly before scheduler submission. A replacement,
 * unavailable shared path, or node-local binary is a fail-closed condition. */
export async function assertRestrictedExecutionProfileIdentity(
  profile: RestrictedExecutionProfile,
  deps: RestrictedExecutionProfileValidationDeps = {},
): Promise<void> {
  if (!profile.ready || !profile.apptainerIdentity || !profile.trustedWrapperIdentity) {
    throw new Error("Restricted execution profile has no verified Apptainer identity");
  }
  const statFile = deps.lstatFile ?? lstat;
  const canonicalPath = deps.canonicalPath ?? realpath;
  const sha256File = deps.sha256File ?? sha256FileAtPath;
  const executable = await inspectTrustedExecutable(
    profile.apptainerPath,
    deps,
    statFile,
    canonicalPath,
    sha256File,
  );
  const identity = profile.apptainerIdentity;
  if (
    executable.canonicalPath !== profile.apptainerPath ||
    !executable.isRegularFile ||
    executable.isSymbolicLink ||
    executable.uid !== 0 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0 ||
    executable.device !== identity.device ||
    executable.inode !== identity.inode ||
    executable.sha256 !== identity.sha256
  ) {
    throw new Error(
      "Restricted Apptainer executable identity changed or is unavailable on this node",
    );
  }
  const wrapper = await inspectTrustedExecutable(
    profile.trustedWrapperPath,
    deps,
    statFile,
    canonicalPath,
    sha256File,
  );
  const wrapperIdentity = profile.trustedWrapperIdentity;
  if (
    wrapper.canonicalPath !== profile.trustedWrapperPath ||
    !wrapper.isRegularFile ||
    wrapper.isSymbolicLink ||
    wrapper.uid !== 0 ||
    (wrapper.mode & 0o022) !== 0 ||
    (wrapper.mode & 0o111) === 0 ||
    wrapper.device !== wrapperIdentity.device ||
    wrapper.inode !== wrapperIdentity.inode ||
    wrapper.sha256 !== wrapperIdentity.sha256
  ) {
    throw new Error("Restricted trusted wrapper identity changed or is unavailable on this node");
  }
}

async function inspectTrustedExecutable(
  path: string,
  deps: RestrictedExecutionProfileValidationDeps,
  statFile: typeof lstat,
  canonicalPath: typeof realpath,
  sha256File: (path: string) => Promise<string>,
): Promise<TrustedExecutableMetadata> {
  if (deps.inspectExecutable) return deps.inspectExecutable(path);
  const executable = await statFile(path);
  return {
    canonicalPath: await canonicalPath(path),
    isRegularFile: executable.isFile(),
    isSymbolicLink: executable.isSymbolicLink(),
    mode: executable.mode,
    uid: executable.uid,
    device: executable.dev,
    inode: executable.ino,
    sha256: await sha256File(path),
  };
}

async function sha256FileAtPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
