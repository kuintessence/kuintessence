import { describe, expect, test } from "bun:test";
import { loadAgentConfig } from "../config";
import { buildSandboxCapability, refreshKubernetesSandboxCapability } from "./capability";

const BASE = {
  SERVER_GRPC_URL: "http://localhost:3001",
  AGENT_ID: "agent-test",
  AGENT_SITE_NAME: "site-test",
};

describe("buildSandboxCapability", () => {
  test("reports critical while disabled instead of preventing Agent startup", () => {
    const capability = buildSandboxCapability(loadAgentConfig(BASE), "slurm", {
      username: "agent",
      uid: 501,
      gid: 20,
    });
    expect(capability.readiness).toBe("critical");
    expect(capability.missingRequirements).toContain("sandbox-disabled");
  });

  test("reports ready only with the complete scheduler-specific security posture", () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const config = loadAgentConfig({
      ...BASE,
      AGENT_SANDBOX_ENABLED: "true",
      AGENT_SANDBOX_EXECUTION_MODE: "self-account",
      AGENT_SANDBOX_NETWORK_ISOLATION: "true",
      AGENT_SANDBOX_CGROUPS: "true",
      AGENT_SANDBOX_SECCOMP: "true",
      AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION: "true",
      AGENT_SANDBOX_ECL: "true",
      AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
      AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
        [digest]: { kind: "SIF", localPath: "/runtime/python.sif", signatureVerified: true },
      }),
    });
    const capability = buildSandboxCapability(
      config,
      "slurm",
      { username: "kqagent", uid: 2001, gid: 2001 },
      {
        runtimeCache: {
          [digest]: {
            kind: "SIF",
            localPath: "/runtime/python.sif",
            signatureVerified: true,
            runtimeAttestationId: "a".repeat(64),
            apptainerPath: "/usr/bin/apptainer",
            seccompProfilePath: "/etc/kuintessence/seccomp.json",
            attestedNodes: ["slurm-2"],
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
      },
    );
    expect(capability.readiness).toBe("ready");
    expect(capability.managedRoot).toBe("/var/lib/kuintessence/sandbox");
    expect(capability.rootMode).toBe(false);
    expect(capability.executionMode).toBe("SelfAccount");
    expect(capability.runtimeCache[0]?.digest).toBe(digest);
  });

  test("keeps the root impersonation capability on PBS Pro independent of SelfAccount attestation", () => {
    const digest = `sha256:${"2".repeat(64)}`;
    const capability = buildSandboxCapability(
      loadAgentConfig({
        ...BASE,
        AGENT_SANDBOX_ENABLED: "true",
        AGENT_SANDBOX_EXECUTION_MODE: "root-impersonation",
        AGENT_SANDBOX_ROOT_IMPERSONATION: "true",
        AGENT_SANDBOX_NETWORK_ISOLATION: "true",
        AGENT_SANDBOX_CGROUPS: "true",
        AGENT_SANDBOX_SECCOMP: "true",
        AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION: "true",
        AGENT_SANDBOX_ECL: "true",
        AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
        AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
          [digest]: { kind: "SIF", localPath: "/runtime/python.sif", signatureVerified: true },
        }),
      }),
      "pbs-pro",
      { username: "root", uid: 0, gid: 0 },
    );

    expect(capability.executionMode).toBe("RootImpersonation");
    expect(capability.readiness).toBe("ready");
    expect(capability.runtimeCache).toEqual([{ digest, kind: "SIF", signatureVerified: true }]);
  });

  test("requires a locally attested Kubernetes seccomp profile without a root process", () => {
    const digest = `sha256:${"3".repeat(64)}`;
    const capability = buildSandboxCapability(
      loadAgentConfig({
        ...BASE,
        AGENT_SANDBOX_ENABLED: "true",
        AGENT_SANDBOX_NETWORK_ISOLATION: "true",
        AGENT_SANDBOX_CGROUPS: "true",
        AGENT_SANDBOX_SECCOMP: "true",
        AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
        AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
          [digest]: {
            kind: "OCI",
            localPath: `registry.example/kq/python@${digest}`,
            signatureVerified: true,
          },
        }),
      }),
      "kubernetes",
      { username: "kqagent", uid: 2001, gid: 2001 },
      undefined,
      {
        ready: true,
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        canonicalPath: "/var/lib/kubelet/seccomp/kuintessence/kq-no-network.json",
        sha256: "a".repeat(64),
        missingRequirements: [],
      },
    );

    expect(capability.executionMode).toBe("RootImpersonation");
    expect(capability.rootMode).toBe(false);
    expect(capability.readiness).toBe("ready");
    expect(capability.runtimeCache[0]).toMatchObject({ digest, kind: "OCI" });
  });

  test("keeps Kubernetes critical when only boolean network controls are configured", () => {
    const digest = `sha256:${"4".repeat(64)}`;
    const capability = buildSandboxCapability(
      loadAgentConfig({
        ...BASE,
        AGENT_SANDBOX_ENABLED: "true",
        AGENT_SANDBOX_NETWORK_ISOLATION: "true",
        AGENT_SANDBOX_CGROUPS: "true",
        AGENT_SANDBOX_SECCOMP: "true",
        AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
        AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
          [digest]: {
            kind: "OCI",
            localPath: `registry.example/kq/python@${digest}`,
            signatureVerified: true,
          },
        }),
      }),
      "kubernetes",
      { username: "kqagent", uid: 2001, gid: 2001 },
    );

    expect(capability.readiness).toBe("critical");
    expect(capability.networkIsolation).toBe(false);
    expect(capability.seccomp).toBe(false);
    expect(capability.missingRequirements).toContain("kubernetes-localhost-seccomp-profile");
  });

  test("downgrades the live Kubernetes capability when periodic profile attestation drifts", async () => {
    const digest = `sha256:${"5".repeat(64)}`;
    const config = loadAgentConfig({
      ...BASE,
      AGENT_SANDBOX_ENABLED: "true",
      AGENT_SANDBOX_NETWORK_ISOLATION: "true",
      AGENT_SANDBOX_CGROUPS: "true",
      AGENT_SANDBOX_SECCOMP: "true",
      AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
      AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
        [digest]: {
          kind: "OCI",
          localPath: `registry.example/kq/python@${digest}`,
          signatureVerified: true,
        },
      }),
    });
    const identity = { username: "kqagent", uid: 2001, gid: 2001 };
    const capability = buildSandboxCapability(config, "kubernetes", identity, undefined, {
      ready: true,
      localhostProfile: "kuintessence/kq-no-network.json",
      nodeName: "k3s-1",
      canonicalPath: "/var/lib/kubelet/seccomp/kuintessence/kq-no-network.json",
      sha256: "a".repeat(64),
      missingRequirements: [],
    });

    await refreshKubernetesSandboxCapability(
      capability,
      config,
      "kubernetes",
      identity,
      async () => ({
        ready: false,
        missingRequirements: ["kubernetes-seccomp-sha256-mismatch"],
      }),
    );

    expect(capability.readiness).toBe("critical");
    expect(capability.networkIsolation).toBe(false);
    expect(capability.missingRequirements).toContain("kubernetes-seccomp-sha256-mismatch");
  });

  test("does not advertise SelfAccount on an adapter without Slurm attestation and node pinning", () => {
    const capability = buildSandboxCapability(
      loadAgentConfig({
        ...BASE,
        AGENT_SANDBOX_ENABLED: "true",
        AGENT_SANDBOX_EXECUTION_MODE: "self-account",
      }),
      "torque",
      { username: "kqagent", uid: 2001, gid: 2001 },
    );

    expect(capability.executionMode).toBe("Disabled");
    expect(capability.readiness).toBe("critical");
    expect(capability.missingRequirements).toContain("self-account-adapter-unsupported");
  });
});
