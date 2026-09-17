import { describe, expect, test } from "bun:test";
import {
  type EffectiveSandboxPolicy,
  SandboxRuntimeProfileSchema,
  SandboxUnsignedManifestSchema,
  tightenSandboxPolicy,
  WorkflowPlacementConfigSchema,
} from "./sandbox";

const PROFILE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function unsignedManifest() {
  return {
    jobId: JOB_ID,
    script: {
      language: "bash" as const,
      entrypoint: "main.sh",
      contentBase64: Buffer.from("echo ok\n").toString("base64"),
      sha256: "1".repeat(64),
      bundleSha256: "2".repeat(64),
    },
    runtime: {
      profileId: PROFILE_ID,
      kind: "SIF" as const,
      digest: `sha256:${"3".repeat(64)}`,
    },
    executionMode: "SelfAccount" as const,
    identity: {
      mode: "MappedAccount" as const,
      accountId: ACCOUNT_ID,
      backend: "Unix" as const,
      username: "kqagent",
      uid: 1001,
      gid: 1001,
      schedulerAccount: null,
      allowedQueues: [],
    },
    mounts: [],
    limits: { pids: 16, outputBytes: 1_024, logBytes: 1_024 },
    networkDisabled: true as const,
  };
}

describe("SandboxRuntimeProfileSchema", () => {
  test("accepts a profile that supports HPC and Kubernetes", () => {
    const profile = SandboxRuntimeProfileSchema.parse({
      id: PROFILE_ID,
      name: "Python scientific base",
      language: "python",
      languageVersion: "3.13.5",
      ociDigest: `sha256:${"a".repeat(64)}`,
      sifDigest: `sha256:${"b".repeat(64)}`,
      signature: "sigstore-envelope",
      adapters: ["slurm", "pbs-pro", "torque", "kubernetes"],
      security: {
        networkDisabled: true,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        seccompRequired: true,
        signatureVerificationRequired: true,
      },
      lifecycle: "active",
      createdAt: "2026-07-14T00:00:00Z",
      updatedAt: "2026-07-14T00:00:00Z",
    });

    expect(profile.dependencies).toEqual([]);
    expect(profile.documentation).toEqual({});
  });

  test("rejects an HPC profile without a SIF digest", () => {
    expect(() =>
      SandboxRuntimeProfileSchema.parse({
        id: PROFILE_ID,
        name: "Broken",
        language: "bash",
        languageVersion: "5.2",
        ociDigest: `sha256:${"a".repeat(64)}`,
        signature: "signature",
        adapters: ["slurm"],
        security: {
          networkDisabled: true,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          seccompRequired: true,
          signatureVerificationRequired: true,
        },
        lifecycle: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });
});

describe("tightenSandboxPolicy", () => {
  const platform: EffectiveSandboxPolicy = {
    sandboxEnabled: true,
    impersonationEnabled: false,
    selfAccountEnabled: false,
    degradedImpersonationAllowed: false,
    sharedServiceAllowed: true,
    runtimePrecacheRequired: false,
    limits: {
      maxCpuCores: 32,
      maxMemoryMb: 131_072,
      maxWallTimeSec: 86_400,
      maxPids: 512,
      maxOutputBytes: 10_000_000_000,
      maxLogBytes: 100_000_000,
    },
    disabledRuntimeProfileIds: [],
  };

  test("cannot enable impersonation above the platform ceiling", () => {
    const effective = tightenSandboxPolicy(platform, [{ impersonationEnabled: true }]);
    expect(effective.impersonationEnabled).toBe(false);
  });

  test("cannot enable self-account execution above the platform ceiling", () => {
    const effective = tightenSandboxPolicy(platform, [{ selfAccountEnabled: true }]);
    expect(effective.selfAccountEnabled).toBe(false);
  });

  test("merges stricter booleans, limits, precache, and runtime denies", () => {
    const effective = tightenSandboxPolicy(
      { ...platform, impersonationEnabled: true, selfAccountEnabled: true },
      [
        {
          sharedServiceAllowed: false,
          selfAccountEnabled: false,
          runtimePrecacheRequired: true,
          limits: { maxCpuCores: 16, maxWallTimeSec: 7_200 },
          disabledRuntimeProfileIds: [PROFILE_ID],
        },
        { limits: { maxCpuCores: 8 }, disabledRuntimeProfileIds: [PROFILE_ID] },
      ],
    );

    expect(effective).toMatchObject({
      impersonationEnabled: true,
      selfAccountEnabled: false,
      sharedServiceAllowed: false,
      runtimePrecacheRequired: true,
      limits: { maxCpuCores: 8, maxWallTimeSec: 7_200 },
      disabledRuntimeProfileIds: [PROFILE_ID],
    });
  });
});

describe("SandboxUnsignedManifestSchema", () => {
  test("requires a runtime attestation for SelfAccount execution", () => {
    expect(() => SandboxUnsignedManifestSchema.parse(unsignedManifest())).toThrow(
      "runtime attestation id",
    );
  });

  test("binds SelfAccount execution to a mapped Unix identity and forbids restricted profiles", () => {
    const attested = {
      ...unsignedManifest(),
      runtimeAttestationId: "4".repeat(64),
    };
    expect(SandboxUnsignedManifestSchema.parse(attested)).toMatchObject({
      executionMode: "SelfAccount",
      runtimeAttestationId: "4".repeat(64),
    });
    expect(() =>
      SandboxUnsignedManifestSchema.parse({
        ...attested,
        identity: {
          mode: "MappedAccount",
          accountId: ACCOUNT_ID,
          backend: "Kubernetes",
          namespace: "default",
          serviceAccount: "runner",
          quotaPolicy: null,
        },
      }),
    ).toThrow("mapped Unix identity");
    expect(() =>
      SandboxUnsignedManifestSchema.parse({
        ...attested,
        executionProfile: {
          profileId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          apptainerCanonicalPath: "/opt/kq/apptainer",
          apptainerSha256: "5".repeat(64),
          sifCanonicalPath: "/opt/kq/runtime.sif",
          sifSha256: "3".repeat(64),
          trustedWrapperCanonicalPath: "/opt/kq/wrapper",
          trustedWrapperSha256: "6".repeat(64),
        },
      }),
    ).toThrow("cannot use a restricted execution profile");
  });
});

describe("WorkflowPlacementConfigSchema", () => {
  test("applies global planner and mapped-account defaults", () => {
    expect(WorkflowPlacementConfigSchema.parse({})).toEqual({
      plannerMode: "Global",
      defaultExecutionIdentity: { type: "MappedAuto" },
      budgetCap: null,
      runConstraint: null,
      subgraphConstraints: {},
      nodeConstraints: {},
    });
  });

  test("rejects a negative budget cap", () => {
    expect(() => WorkflowPlacementConfigSchema.parse({ budgetCap: -1 })).toThrow();
  });
});
