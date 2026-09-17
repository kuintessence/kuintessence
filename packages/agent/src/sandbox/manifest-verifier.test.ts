import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  canonicalJson,
  type SandboxSignedManifest,
  type SandboxUnsignedManifest,
} from "@kuintessence/shared";
import { SandboxManifestVerifier } from "./manifest-verifier";

const NOW = 1_720_915_200_000;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function unsigned(): SandboxUnsignedManifest {
  const content = Buffer.from("print('ok')\n");
  const script = {
    language: "python" as const,
    entrypoint: "main.py",
    contentBase64: content.toString("base64"),
    sha256: sha256(content),
    bundleSha256: "",
  };
  script.bundleSha256 = sha256(
    canonicalJson({
      language: script.language,
      entrypoint: script.entrypoint,
      sha256: script.sha256,
    }),
  );
  return {
    jobId: "00000000-0000-0000-0000-000000000111",
    script,
    runtime: {
      profileId: "00000000-0000-0000-0000-000000000222",
      kind: "SIF",
      digest: `sha256:${"1".repeat(64)}`,
    },
    executionMode: "RootImpersonation",
    identity: {
      mode: "MappedAccount",
      accountId: "00000000-0000-0000-0000-000000000333",
      backend: "Unix",
      username: "scientist",
      uid: 1001,
      gid: 1001,
      schedulerAccount: "science",
      allowedQueues: ["compute"],
    },
    mounts: [],
    limits: { pids: 32, outputBytes: 1_000_000, logBytes: 100_000 },
    networkDisabled: true,
  };
}

function signed(
  privateKey: KeyObject,
  value: SandboxUnsignedManifest = unsigned(),
): SandboxSignedManifest {
  const json = canonicalJson(value);
  return {
    ...value,
    envelope: {
      keyId: "platform-key",
      nonce: "nonce-1234567890123456",
      issuedAtUnixMs: NOW,
      expiresAtUnixMs: NOW + 60_000,
      manifestSha256: sha256(json),
      signatureBase64: sign(null, Buffer.from(json), privateKey).toString("base64"),
    },
  };
}

describe("SandboxManifestVerifier", () => {
  test("verifies signature, runtime, account and consumes the nonce once", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const consumed = new Set<string>();
    const verifier = new SandboxManifestVerifier({
      publicKeys: {
        "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      runtimeCache: {
        [`sha256:${"1".repeat(64)}`]: {
          kind: "SIF",
          localPath: "/managed/runtime.sif",
          signatureVerified: true,
        },
      },
      nonceConsumer: {
        consume: async (nonce) => {
          if (consumed.has(nonce)) return false;
          consumed.add(nonce);
          return true;
        },
      },
      accountVerifier: { verify: async () => true },
      adapterType: "slurm",
      localExecutionMode: "RootImpersonation",
      processIdentity: { username: "root", uid: 0, gid: 0 },
      rootImpersonationEnabled: true,
      sharedServiceAllowed: false,
      now: () => NOW + 1,
    });
    const manifest = signed(privateKey);
    const result = await verifier.verify(manifest.jobId, manifest);
    expect(result.runtimePath).toBe("/managed/runtime.sif");
    expect(Buffer.from(result.scriptContent).toString()).toBe("print('ok')\n");
    await expect(verifier.verify(manifest.jobId, manifest)).rejects.toThrow("nonce replay");
  });

  test("rejects expiry, unsigned runtime cache, uid0 and root-mode downgrade", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const options = {
      publicKeys: {
        "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      runtimeCache: {
        [`sha256:${"1".repeat(64)}`]: {
          kind: "SIF" as const,
          localPath: "/managed/runtime.sif",
          signatureVerified: true,
        },
      },
      nonceConsumer: { consume: async () => true },
      accountVerifier: { verify: async () => true },
      adapterType: "slurm" as const,
      localExecutionMode: "RootImpersonation" as const,
      processIdentity: { username: "root", uid: 0, gid: 0 },
      rootImpersonationEnabled: true,
      sharedServiceAllowed: false,
      now: () => NOW + 60_001,
    };
    await expect(
      new SandboxManifestVerifier(options).verify(unsigned().jobId, signed(privateKey)),
    ).rejects.toThrow("expired");

    const noRoot = new SandboxManifestVerifier({
      ...options,
      now: () => NOW + 1,
      rootImpersonationEnabled: false,
    });
    await expect(noRoot.verify(unsigned().jobId, signed(privateKey))).rejects.toThrow("root Agent");

    const uid0 = unsigned();
    if (uid0.identity.backend !== "Unix") throw new Error("expected Unix fixture");
    uid0.identity.uid = 0;
    await expect(noRoot.verify(uid0.jobId, signed(privateKey, uid0))).rejects.toThrow();
  });

  test("rejects a signed execution profile whose path or binary hash is replaced", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const value = unsigned();
    value.executionProfile = {
      profileId: "00000000-0000-4000-8000-000000000444",
      apptainerCanonicalPath: "/opt/kq/bin/apptainer",
      apptainerSha256: "a".repeat(64),
      sifCanonicalPath: "/managed/runtime.sif",
      sifSha256: "1".repeat(64),
      trustedWrapperCanonicalPath: "/usr/libexec/kuintessence/kq-sandbox-wrapper",
      trustedWrapperSha256: "b".repeat(64),
    };
    const profile = value.executionProfile;
    const verifier = new SandboxManifestVerifier({
      publicKeys: {
        "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      runtimeCache: {
        [`sha256:${"1".repeat(64)}`]: {
          kind: "SIF",
          localPath: profile.sifCanonicalPath,
          signatureVerified: true,
        },
      },
      nonceConsumer: { consume: async () => true },
      accountVerifier: { verify: async () => true },
      adapterType: "slurm",
      localExecutionMode: "RootImpersonation",
      processIdentity: { username: "root", uid: 0, gid: 0 },
      rootImpersonationEnabled: true,
      sharedServiceAllowed: false,
      restrictedExecutionProfile: profile,
      now: () => NOW + 1,
    });
    const manifest = signed(privateKey, value);
    await expect(verifier.verify(value.jobId, manifest)).resolves.toBeDefined();
    const changedPath = structuredClone(manifest);
    if (!changedPath.executionProfile) throw new Error("execution profile fixture missing");
    changedPath.executionProfile.apptainerCanonicalPath = "/tmp/apptainer";
    await expect(verifier.verify(value.jobId, changedPath)).rejects.toThrow(
      "manifest hash mismatch",
    );
    const changedHash = structuredClone(manifest);
    if (!changedHash.executionProfile) throw new Error("execution profile fixture missing");
    changedHash.executionProfile.apptainerSha256 = "f".repeat(64);
    await expect(verifier.verify(value.jobId, changedHash)).rejects.toThrow(
      "manifest hash mismatch",
    );
  });

  test("permits only a current non-root Unix account with the matching runtime attestation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const processIdentity = { username: "kqagent", uid: 2001, gid: 2001 };
    const value = unsigned();
    value.executionMode = "SelfAccount";
    value.runtimeAttestationId = "a".repeat(64);
    if (value.identity.backend !== "Unix") throw new Error("expected Unix fixture");
    value.identity = {
      ...value.identity,
      username: processIdentity.username,
      uid: processIdentity.uid,
      gid: processIdentity.gid,
    };
    const verifier = new SandboxManifestVerifier({
      publicKeys: {
        "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      runtimeCache: {
        [`sha256:${"1".repeat(64)}`]: {
          kind: "SIF",
          localPath: "/managed/runtime.sif",
          signatureVerified: true,
          runtimeAttestationId: value.runtimeAttestationId,
          apptainerPath: "/usr/bin/apptainer",
          seccompProfilePath: "/etc/kuintessence/seccomp.json",
          attestedNodes: ["slurm-2"],
          expiresAtUnixMs: NOW + 60_000,
        },
      },
      nonceConsumer: { consume: async () => true },
      accountVerifier: { verify: async () => true },
      adapterType: "slurm",
      localExecutionMode: "SelfAccount",
      processIdentity,
      rootImpersonationEnabled: false,
      sharedServiceAllowed: false,
      now: () => NOW + 1,
    });

    await expect(verifier.verify(value.jobId, signed(privateKey, value))).resolves.toMatchObject({
      runtimeAttestationId: value.runtimeAttestationId,
      apptainerPath: "/usr/bin/apptainer",
      seccompProfilePath: "/etc/kuintessence/seccomp.json",
    });

    const wrongAdapter = new SandboxManifestVerifier({
      publicKeys: {
        "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      runtimeCache: {
        [`sha256:${"1".repeat(64)}`]: {
          kind: "SIF",
          localPath: "/managed/runtime.sif",
          signatureVerified: true,
          runtimeAttestationId: value.runtimeAttestationId,
          apptainerPath: "/usr/bin/apptainer",
          seccompProfilePath: "/etc/kuintessence/seccomp.json",
          attestedNodes: ["slurm-2"],
          expiresAtUnixMs: NOW + 60_000,
        },
      },
      nonceConsumer: { consume: async () => true },
      accountVerifier: { verify: async () => true },
      adapterType: "pbs-pro",
      localExecutionMode: "SelfAccount",
      processIdentity,
      rootImpersonationEnabled: false,
      sharedServiceAllowed: false,
      now: () => NOW + 1,
    });
    await expect(wrongAdapter.verify(value.jobId, signed(privateKey, value))).rejects.toThrow(
      "supported only by the Slurm adapter",
    );

    const differentAccount = structuredClone(value);
    if (differentAccount.identity.backend !== "Unix") throw new Error("expected Unix fixture");
    differentAccount.identity.uid = 2002;
    await expect(
      verifier.verify(value.jobId, signed(privateKey, differentAccount)),
    ).rejects.toThrow("does not match the current Agent process account");

    const staleRuntime = new SandboxManifestVerifier({
      ...{
        publicKeys: {
          "platform-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        runtimeCache: {
          [`sha256:${"1".repeat(64)}`]: {
            kind: "SIF" as const,
            localPath: "/managed/runtime.sif",
            signatureVerified: true,
            runtimeAttestationId: value.runtimeAttestationId,
            apptainerPath: "/usr/bin/apptainer",
            seccompProfilePath: "/etc/kuintessence/seccomp.json",
            attestedNodes: ["slurm-2"],
            expiresAtUnixMs: NOW,
          },
        },
        nonceConsumer: { consume: async () => true },
        accountVerifier: { verify: async () => true },
        adapterType: "slurm" as const,
        localExecutionMode: "SelfAccount" as const,
        processIdentity,
        rootImpersonationEnabled: false,
        sharedServiceAllowed: false,
        now: () => NOW + 1,
      },
    });
    await expect(staleRuntime.verify(value.jobId, signed(privateKey, value))).rejects.toThrow(
      "runtime attestation",
    );
  });
});
