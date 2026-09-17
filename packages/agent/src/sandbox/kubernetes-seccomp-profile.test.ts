import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadAgentConfig } from "../config";
import {
  assertKubernetesSeccompProfileCurrent,
  attestKubernetesSeccompProfile,
  enforceKubernetesSeccompStartupBinding,
} from "./kubernetes-seccomp-profile";

const BASE = {
  SERVER_GRPC_URL: "http://localhost:3001",
  AGENT_ID: "agent-test",
  AGENT_SITE_NAME: "site-test",
};

const PROFILE = JSON.stringify({
  defaultAction: "SCMP_ACT_ALLOW",
  architectures: ["SCMP_ARCH_X86_64"],
  syscalls: [
    {
      names: ["io_uring_setup"],
      action: "SCMP_ACT_ERRNO",
      errnoRet: 1,
    },
    {
      names: ["socket"],
      action: "SCMP_ACT_ERRNO",
      args: [{ index: 0, value: 1, op: "SCMP_CMP_NE" }],
      errnoRet: 1,
    },
  ],
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function config(profileSha256 = digest(PROFILE)) {
  return loadAgentConfig({
    ...BASE,
    AGENT_SANDBOX_K8S_SECCOMP_ROOT: "/var/lib/kubelet/seccomp",
    AGENT_SANDBOX_K8S_SECCOMP_PROFILE: "kuintessence/kq-no-network.json",
    AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256: profileSha256,
    AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME: "k3s-1",
  });
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    canonicalPath: "/var/lib/kubelet/seccomp/kuintessence/kq-no-network.json",
    contents: PROFILE,
    isRegularFile: true,
    isSymbolicLink: false,
    mode: 0o100444,
    uid: 0,
    sha256: digest(PROFILE),
    ancestorsRootOwnedWriteProtected: true,
    ...overrides,
  };
}

describe("attestKubernetesSeccompProfile", () => {
  test("binds a root-owned digest-pinned Localhost profile that denies IPv4 and IPv6 sockets", async () => {
    const attestation = await attestKubernetesSeccompProfile(config(), {
      hostName: () => "k3s-1",
      inspectProfile: async () => metadata(),
    });

    expect(attestation).toEqual({
      ready: true,
      localhostProfile: "kuintessence/kq-no-network.json",
      nodeName: "k3s-1",
      canonicalPath: "/var/lib/kubelet/seccomp/kuintessence/kq-no-network.json",
      sha256: digest(PROFILE),
      missingRequirements: [],
    });
  });

  test("fails closed when the trusted file identity or digest is invalid", async () => {
    for (const changed of [
      { uid: 1000 },
      { mode: 0o100664 },
      { isRegularFile: false },
      { isSymbolicLink: true },
      { canonicalPath: "/tmp/kq-no-network.json" },
      { sha256: "b".repeat(64) },
      { ancestorsRootOwnedWriteProtected: false },
    ]) {
      const attestation = await attestKubernetesSeccompProfile(config(), {
        hostName: () => "k3s-1",
        inspectProfile: async () => metadata(changed),
      });
      expect(attestation.ready).toBe(false);
      expect(attestation.missingRequirements).not.toEqual([]);
    }
  });

  test("rejects a pinned profile that leaves other socket families or io_uring available", async () => {
    const ipv4AndIpv6Only = JSON.stringify({
      defaultAction: "SCMP_ACT_ALLOW",
      architectures: ["SCMP_ARCH_X86_64"],
      syscalls: [
        {
          names: ["socket"],
          action: "SCMP_ACT_ERRNO",
          args: [{ index: 0, value: 2, op: "SCMP_CMP_EQ" }],
          errnoRet: 1,
        },
        {
          names: ["socket"],
          action: "SCMP_ACT_ERRNO",
          args: [{ index: 0, value: 10, op: "SCMP_CMP_EQ" }],
          errnoRet: 1,
        },
      ],
    });
    const attestation = await attestKubernetesSeccompProfile(config(digest(ipv4AndIpv6Only)), {
      hostName: () => "k3s-1",
      inspectProfile: async () =>
        metadata({ contents: ipv4AndIpv6Only, sha256: digest(ipv4AndIpv6Only) }),
    });

    expect(attestation.ready).toBe(false);
    expect(attestation.missingRequirements).toContain("kubernetes-seccomp-network-deny");
  });

  test("requires explicit x86-64 and EPERM semantics", async () => {
    const parsed = JSON.parse(PROFILE) as {
      architectures?: string[];
      syscalls: Array<Record<string, unknown>>;
    };
    const variants = [
      { ...parsed, architectures: undefined },
      { ...parsed, architectures: ["SCMP_ARCH_AARCH64"] },
      {
        ...parsed,
        syscalls: parsed.syscalls.map((rule) => ({ ...rule, errnoRet: 13 })),
      },
    ];
    for (const variant of variants) {
      const contents = JSON.stringify(variant);
      const attestation = await attestKubernetesSeccompProfile(config(digest(contents)), {
        hostName: () => "k3s-1",
        inspectProfile: async () => metadata({ contents, sha256: digest(contents) }),
      });
      expect(attestation.ready).toBe(false);
      expect(attestation.missingRequirements).toContain("kubernetes-seccomp-network-deny");
    }
  });

  test("rejects conflicting io_uring rules", async () => {
    const parsed = JSON.parse(PROFILE) as { syscalls: Array<Record<string, unknown>> };
    parsed.syscalls.push({ names: ["io_uring_setup"], action: "SCMP_ACT_LOG" });
    const contents = JSON.stringify(parsed);
    const attestation = await attestKubernetesSeccompProfile(config(digest(contents)), {
      hostName: () => "k3s-1",
      inspectProfile: async () => metadata({ contents, sha256: digest(contents) }),
    });
    expect(attestation.ready).toBe(false);
    expect(attestation.missingRequirements).toContain("kubernetes-seccomp-network-deny");
  });

  test("requires an Agent restart when no adapter profile was bound at startup", () => {
    const effective = enforceKubernetesSeccompStartupBinding(
      {
        ready: true,
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        canonicalPath: "/var/lib/kubelet/seccomp/kuintessence/kq-no-network.json",
        sha256: digest(PROFILE),
        missingRequirements: [],
      },
      false,
    );
    expect(effective.ready).toBe(false);
    expect(effective.missingRequirements).toEqual(["kubernetes-seccomp-agent-restart-required"]);
  });

  test("rechecks the exact profile identity immediately before scheduler submission", async () => {
    const expected = await attestKubernetesSeccompProfile(config(), {
      hostName: () => "k3s-1",
      inspectProfile: async () => metadata(),
    });
    await expect(
      assertKubernetesSeccompProfileCurrent(config(), expected, {
        hostName: () => "k3s-1",
        inspectProfile: async () => metadata({ sha256: "b".repeat(64) }),
      }),
    ).rejects.toThrow("attestation changed");
  });
});
