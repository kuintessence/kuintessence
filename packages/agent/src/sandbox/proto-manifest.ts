import {
  type SandboxExecution,
  SandboxIdentityMode,
  SandboxIoType,
  SandboxLanguage,
  SandboxMountMode,
  SandboxRuntimeKind,
} from "@kuintessence/proto";
import {
  type SandboxDispatchIdentity,
  type SandboxSignedManifest,
  SandboxSignedManifestSchema,
} from "@kuintessence/shared";

function language(value: SandboxLanguage): "python" | "nodejs" | "bash" {
  if (value === SandboxLanguage.PYTHON) return "python";
  if (value === SandboxLanguage.NODEJS) return "nodejs";
  if (value === SandboxLanguage.BASH) return "bash";
  throw new Error("Sandbox language is unspecified");
}

function runtimeKind(value: SandboxRuntimeKind): "OCI" | "SIF" {
  if (value === SandboxRuntimeKind.OCI) return "OCI";
  if (value === SandboxRuntimeKind.SIF) return "SIF";
  throw new Error("Sandbox runtime kind is unspecified");
}

function identityMode(value: SandboxIdentityMode): "SharedService" | "MappedAccount" {
  if (value === SandboxIdentityMode.SHARED_SERVICE) return "SharedService";
  if (value === SandboxIdentityMode.MAPPED_ACCOUNT) return "MappedAccount";
  throw new Error("Sandbox execution identity mode is unspecified");
}

function ioType(value: SandboxIoType): "Text" | "JSON" | "File" | "FileBatch" {
  if (value === SandboxIoType.TEXT) return "Text";
  if (value === SandboxIoType.JSON) return "JSON";
  if (value === SandboxIoType.FILE) return "File";
  if (value === SandboxIoType.FILE_BATCH) return "FileBatch";
  throw new Error("Sandbox artifact I/O type is unspecified");
}

function mountMode(value: SandboxMountMode): "ReadOnly" | "WriteOnly" {
  if (value === SandboxMountMode.READ_ONLY) return "ReadOnly";
  if (value === SandboxMountMode.WRITE_ONLY) return "WriteOnly";
  throw new Error("Sandbox artifact mount mode is unspecified");
}

function safeInt(value: bigint, field: string): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Sandbox ${field} is outside the safe integer range`);
  }
  return Number(value);
}

function decodeIdentity(value: NonNullable<SandboxExecution["executionIdentity"]>) {
  const common = { mode: identityMode(value.mode), accountId: value.accountId };
  if (value.backend.case === "unix") {
    const unix = value.backend.value;
    return {
      ...common,
      backend: "Unix" as const,
      username: unix.username,
      uid: unix.uid,
      gid: unix.gid,
      schedulerAccount: unix.schedulerAccount || null,
      allowedQueues: unix.allowedQueues,
    } satisfies SandboxDispatchIdentity;
  }
  if (value.backend.case === "kubernetes") {
    const kubernetes = value.backend.value;
    return {
      ...common,
      backend: "Kubernetes" as const,
      namespace: kubernetes.namespace,
      serviceAccount: kubernetes.serviceAccount,
      quotaPolicy: kubernetes.quotaPolicy || null,
    } satisfies SandboxDispatchIdentity;
  }
  throw new Error("Sandbox execution account backend is missing");
}

export function decodeSandboxExecution(
  jobId: string,
  value: SandboxExecution | undefined,
): SandboxSignedManifest {
  if (
    !value?.script ||
    !value.runtime ||
    !value.executionIdentity ||
    !value.limits ||
    !value.envelope
  ) {
    throw new Error("Sandbox execution manifest is incomplete");
  }
  return SandboxSignedManifestSchema.parse({
    jobId,
    script: {
      language: language(value.script.language),
      entrypoint: value.script.entrypoint,
      contentBase64: Buffer.from(value.script.content).toString("base64"),
      sha256: value.script.sha256,
      bundleSha256: value.script.bundleSha256,
    },
    runtime: {
      profileId: value.runtime.profileId,
      kind: runtimeKind(value.runtime.kind),
      digest: value.runtime.digest,
    },
    executionMode: value.executionMode,
    ...(value.runtimeAttestationId ? { runtimeAttestationId: value.runtimeAttestationId } : {}),
    ...(value.executionProfile
      ? {
          executionProfile: {
            profileId: value.executionProfile.profileId,
            apptainerCanonicalPath: value.executionProfile.apptainerCanonicalPath,
            apptainerSha256: value.executionProfile.apptainerSha256,
            sifCanonicalPath: value.executionProfile.sifCanonicalPath,
            sifSha256: value.executionProfile.sifSha256,
            trustedWrapperCanonicalPath: value.executionProfile.trustedWrapperCanonicalPath,
            trustedWrapperSha256: value.executionProfile.trustedWrapperSha256,
          },
        }
      : {}),
    identity: decodeIdentity(value.executionIdentity),
    mounts: value.artifactMounts.map((mount) => ({
      descriptor: mount.descriptor,
      ioType: ioType(mount.ioType),
      mode: mountMode(mount.mode),
      relativePath: mount.relativePath,
      containerPath: mount.containerPath,
      expectedSha256: mount.expectedSha256 || null,
      inlineContentBase64:
        mount.inlineContent.byteLength > 0
          ? Buffer.from(mount.inlineContent).toString("base64")
          : null,
      batchEntries: mount.batchEntries.map((entry) => ({
        relativePath: entry.relativePath,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes === 0n ? 0 : safeInt(entry.sizeBytes, "batch entry size"),
      })),
      sizeLimitBytes: safeInt(mount.sizeLimitBytes, "artifact size limit"),
      required: mount.required,
    })),
    limits: {
      pids: value.limits.pids,
      outputBytes: safeInt(value.limits.outputBytes, "output limit"),
      logBytes: safeInt(value.limits.logBytes, "log limit"),
    },
    networkDisabled: value.networkDisabled,
    envelope: {
      keyId: value.envelope.keyId,
      nonce: value.envelope.nonce,
      issuedAtUnixMs: safeInt(value.envelope.issuedAtUnixMs, "issued timestamp"),
      expiresAtUnixMs: safeInt(value.envelope.expiresAtUnixMs, "expiry timestamp"),
      manifestSha256: value.envelope.manifestSha256,
      signatureBase64: Buffer.from(value.envelope.signature).toString("base64"),
    },
  });
}
