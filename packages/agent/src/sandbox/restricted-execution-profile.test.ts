import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawner } from "../adapters/base";
import { loadAgentConfig } from "../config";
import { buildSandboxCapability } from "./capability";
import {
  assertRestrictedExecutionProfileIdentity,
  buildRestrictedExecutionProfile,
  validateRestrictedExecutionProfile,
} from "./restricted-execution-profile";

const BASE = {
  SERVER_GRPC_URL: "http://localhost:3001",
  AGENT_ID: "agent-test",
  AGENT_SITE_NAME: "site-test",
};

function secureConfig(digest: string, runtimePath: string) {
  return loadAgentConfig({
    ...BASE,
    AGENT_RESTRICTED_DATA_ISOLATION: "true",
    AGENT_RESTRICTED_EXECUTION_SIF_DIGEST: digest,
    AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH: "/opt/kq/bin/apptainer",
    AGENT_RESTRICTED_EXECUTION_PROFILE_ID: "00000000-0000-4000-8000-000000000444",
    AGENT_RESTRICTED_EXECUTION_WRAPPER_PATH: "/opt/kq/libexec/kq-sandbox-wrapper",
    AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256: "a".repeat(64),
    AGENT_SANDBOX_ENABLED: "true",
    AGENT_SANDBOX_ROOT_IMPERSONATION: "true",
    AGENT_SANDBOX_NETWORK_ISOLATION: "true",
    AGENT_SANDBOX_CGROUPS: "true",
    AGENT_SANDBOX_SECCOMP: "true",
    AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION: "true",
    AGENT_SANDBOX_ECL: "true",
    AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
    AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
      [digest]: { kind: "SIF", localPath: runtimePath, signatureVerified: true },
    }),
  });
}

function attestation(digest: string, runtimePath: string) {
  return {
    runtimeCache: {
      [digest]: {
        kind: "SIF" as const,
        localPath: runtimePath,
        signatureVerified: true as const,
        runtimeAttestationId: "b".repeat(64),
        apptainerPath: "/opt/kq/bin/apptainer",
        seccompProfilePath: "/etc/kuintessence/seccomp.json",
        attestedNodes: ["compute-1"],
        verifiedAtUnixMs: 1,
        expiresAtUnixMs: 2,
      },
    },
    networkIsolation: true,
    cgroups: true,
    seccomp: true,
    sifSignatureVerification: true,
    ecl: true,
    missingRequirements: [],
  };
}

function capabilityFor(digest: string, runtimePath: string) {
  const config = secureConfig(digest, runtimePath);
  const runtimeAttestation = attestation(digest, runtimePath);
  const capability = buildSandboxCapability(
    config,
    "slurm",
    { username: "root", uid: 0, gid: 0 },
    runtimeAttestation,
  );
  return { config, runtimeAttestation, capability };
}

const trustedExecutable = {
  canonicalPath: "/opt/kq/bin/apptainer",
  isRegularFile: true,
  isSymbolicLink: false,
  mode: 0o100755,
  uid: 0,
  device: 12,
  inode: 34,
  sha256: "a".repeat(64),
};

describe("restricted execution profile", () => {
  test("does not treat a readonly bind setting as a restricted capability", () => {
    const config = loadAgentConfig({
      ...BASE,
      AGENT_DATA_READONLY_MOUNT_DRIVER: "linux-bind",
    });
    const capability = buildSandboxCapability(config, "slurm", {
      username: "root",
      uid: 0,
      gid: 0,
    });
    const profile = buildRestrictedExecutionProfile(config, capability, "slurm");
    expect(profile.ready).toBe(false);
    expect(profile.missingRequirements).toContain("restricted-execution-disabled");
  });

  test("requires a pinned SIF when restricted isolation is configured", () => {
    expect(() => loadAgentConfig({ ...BASE, AGENT_RESTRICTED_DATA_ISOLATION: "true" })).toThrow(
      "AGENT_RESTRICTED_EXECUTION_SIF_DIGEST",
    );
  });

  test("advertises ready only after the exact SIF file and signature verifier succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-restricted-profile-"));
    const runtimePath = join(root, "trusted.sif");
    await writeFile(runtimePath, "trusted runtime");
    await chmod(runtimePath, 0o444);
    const digest = `sha256:${createHash("sha256").update("trusted runtime").digest("hex")}`;
    const canonicalRuntimePath = await realpath(runtimePath);
    const { config, runtimeAttestation, capability } = capabilityFor(digest, canonicalRuntimePath);
    const argv: string[][] = [];
    const spawner: Spawner = {
      run: async (command) => {
        argv.push(command);
        return { exitCode: 0, stdout: "verified", stderr: "" };
      },
    };

    const profile = await validateRestrictedExecutionProfile(
      buildRestrictedExecutionProfile(config, capability, "slurm", runtimeAttestation.runtimeCache),
      spawner,
      {
        inspectExecutable: async (path) => ({ ...trustedExecutable, canonicalPath: path }),
      },
    );

    expect(profile.ready).toBe(true);
    expect(profile.apptainerIdentity).toEqual({ device: 12, inode: 34, sha256: "a".repeat(64) });
    expect(argv).toEqual([["/opt/kq/bin/apptainer", "verify", canonicalRuntimePath]]);
  });

  test("fails closed when the local SIF no longer matches the pinned digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-restricted-profile-"));
    const runtimePath = join(root, "trusted.sif");
    await writeFile(runtimePath, "modified runtime");
    await chmod(runtimePath, 0o444);
    const digest = `sha256:${"1".repeat(64)}`;
    const { config, runtimeAttestation, capability } = capabilityFor(
      digest,
      await realpath(runtimePath),
    );
    let invoked = false;
    const profile = await validateRestrictedExecutionProfile(
      buildRestrictedExecutionProfile(config, capability, "slurm", runtimeAttestation.runtimeCache),
      {
        run: async () => {
          invoked = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      {
        inspectExecutable: async (path) => ({ ...trustedExecutable, canonicalPath: path }),
      },
    );

    expect(profile.ready).toBe(false);
    expect(profile.missingRequirements).toContain("pinned-sif-digest-mismatch");
    expect(invoked).toBe(false);
  });

  test("rejects an executable replaced after profile verification", async () => {
    const profile = {
      enabled: true,
      ready: true,
      runtimeDigest: `sha256:${"1".repeat(64)}`,
      runtimePath: "/trusted/runtime.sif",
      apptainerPath: "/opt/kq/bin/apptainer",
      apptainerIdentity: { device: 12, inode: 34, sha256: "a".repeat(64) },
      trustedWrapperPath: "/opt/kq/libexec/kq-sandbox-wrapper",
      trustedWrapperExpectedSha256: "a".repeat(64),
      trustedWrapperIdentity: { device: 12, inode: 34, sha256: "a".repeat(64) },
      missingRequirements: [],
    };

    await expect(
      assertRestrictedExecutionProfileIdentity(profile, {
        inspectExecutable: async () => ({ ...trustedExecutable, inode: 35 }),
      }),
    ).rejects.toThrow("identity changed");
  });

  test("rejects a compute-node wrapper binary that no longer matches its pinned identity", async () => {
    const profile = {
      enabled: true,
      ready: true,
      runtimeDigest: `sha256:${"1".repeat(64)}`,
      runtimePath: "/trusted/runtime.sif",
      apptainerPath: "/opt/kq/bin/apptainer",
      apptainerIdentity: { device: 12, inode: 34, sha256: "a".repeat(64) },
      trustedWrapperPath: "/opt/kq/libexec/kq-sandbox-wrapper",
      trustedWrapperExpectedSha256: "a".repeat(64),
      trustedWrapperIdentity: { device: 12, inode: 34, sha256: "a".repeat(64) },
      missingRequirements: [],
    };
    await expect(
      assertRestrictedExecutionProfileIdentity(profile, {
        inspectExecutable: async (path) =>
          path === profile.trustedWrapperPath
            ? { ...trustedExecutable, canonicalPath: path, sha256: "b".repeat(64) }
            : trustedExecutable,
      }),
    ).rejects.toThrow("trusted wrapper identity changed");
  });
});
