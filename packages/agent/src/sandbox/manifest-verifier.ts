import { createHash, verify } from "node:crypto";
import {
  canonicalJson,
  type SandboxDispatchIdentity,
  type SandboxExecutionMode,
  type SandboxSignedManifest,
  SandboxSignedManifestSchema,
  type SandboxTrustedExecutionProfile,
  type SandboxUnsignedManifest,
  SandboxUnsignedManifestSchema,
} from "@kuintessence/shared";
import type { SandboxProcessIdentity } from "./runtime-attestation";

export interface SandboxRuntimeCacheFact {
  kind: "OCI" | "SIF";
  localPath: string;
  signatureVerified: boolean;
  runtimeAttestationId?: string;
  apptainerPath?: string;
  seccompProfilePath?: string;
  attestedNodes?: string[];
  expiresAtUnixMs?: number;
}

export interface SandboxNonceConsumer {
  consume(nonce: string, jobId: string, expiresAt: Date): Promise<boolean>;
}

export interface SandboxAccountVerifier {
  verify(identity: SandboxDispatchIdentity): Promise<boolean>;
}

export interface SandboxManifestVerifierOptions {
  publicKeys: Readonly<Record<string, string>>;
  runtimeCache: Readonly<Record<string, SandboxRuntimeCacheFact>>;
  nonceConsumer: SandboxNonceConsumer;
  accountVerifier: SandboxAccountVerifier;
  adapterType: "slurm" | "pbs-pro" | "torque" | "kubernetes";
  localExecutionMode: "Disabled" | SandboxExecutionMode;
  processIdentity?: SandboxProcessIdentity;
  rootImpersonationEnabled: boolean;
  sharedServiceAllowed: boolean;
  restrictedExecutionProfile?: SandboxTrustedExecutionProfile;
  now?: () => number;
  maxClockSkewMs?: number;
  maxLifetimeMs?: number;
}

export interface VerifiedSandboxManifest {
  manifest: SandboxSignedManifest;
  unsigned: SandboxUnsignedManifest;
  scriptContent: Uint8Array;
  runtimePath: string;
  runtimeAttestationId?: string;
  apptainerPath?: string;
  seccompProfilePath?: string;
  attestedNodes?: string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bundleSha256(script: SandboxUnsignedManifest["script"]): string {
  return sha256(
    canonicalJson({
      language: script.language,
      entrypoint: script.entrypoint,
      sha256: script.sha256,
    }),
  );
}

function validateMounts(manifest: SandboxUnsignedManifest): void {
  const descriptors = new Set<string>();
  const containerPaths = new Set<string>();
  for (const mount of manifest.mounts) {
    if (descriptors.has(mount.descriptor) || containerPaths.has(mount.containerPath)) {
      throw new Error("Sandbox artifact mount descriptors and paths must be unique");
    }
    descriptors.add(mount.descriptor);
    containerPaths.add(mount.containerPath);
    if (mount.mode === "ReadOnly") {
      if (!mount.containerPath.startsWith("/kq/inputs/") || !mount.expectedSha256) {
        throw new Error("Sandbox read-only input requires /kq/inputs path and content hash");
      }
      if (mount.inlineContentBase64) {
        const content = Buffer.from(mount.inlineContentBase64, "base64");
        if (content.byteLength > mount.sizeLimitBytes || sha256(content) !== mount.expectedSha256) {
          throw new Error("Sandbox inline input does not match its signed size/hash contract");
        }
      }
      if (mount.ioType === "FileBatch") {
        if (mount.inlineContentBase64) {
          throw new Error("Sandbox FileBatch inputs cannot use one inline payload");
        }
        const paths = mount.batchEntries.map((entry) => entry.relativePath);
        if (new Set(paths).size !== paths.length) {
          throw new Error("Sandbox FileBatch entry paths must be unique");
        }
      } else if (mount.batchEntries.length > 0) {
        throw new Error("Sandbox batch entries are only valid for FileBatch mounts");
      }
    } else if (!mount.containerPath.startsWith("/kq/outputs/")) {
      throw new Error("Sandbox writable output must use /kq/outputs path");
    } else if (mount.inlineContentBase64) {
      throw new Error("Sandbox output mounts cannot carry inline content");
    } else if (mount.batchEntries.length > 0) {
      throw new Error("Sandbox output mounts cannot declare expected batch inputs");
    }
  }
}

function isCanonicalAbsolutePath(value: string | undefined): value is string {
  return !!value && /^\/[^\0\r\n ]+$/.test(value) && !value.split("/").includes("..");
}

export function assertSelfAccountIdentity(
  identity: SandboxDispatchIdentity,
  processIdentity: SandboxProcessIdentity | undefined,
): SandboxProcessIdentity {
  if (
    identity.backend !== "Unix" ||
    identity.mode !== "MappedAccount" ||
    !processIdentity ||
    processIdentity.uid <= 0 ||
    processIdentity.gid <= 0 ||
    identity.username !== processIdentity.username ||
    identity.uid !== processIdentity.uid ||
    identity.gid !== processIdentity.gid
  ) {
    throw new Error(
      "SelfAccount Sandbox identity does not match the current Agent process account",
    );
  }
  return processIdentity;
}

function validateIdentity(
  manifest: SandboxUnsignedManifest,
  identity: SandboxDispatchIdentity,
  options: SandboxManifestVerifierOptions,
): void {
  if (identity.mode === "SharedService" && !options.sharedServiceAllowed) {
    throw new Error("Sandbox shared service identity is disabled by effective policy");
  }
  if (options.adapterType === "kubernetes") {
    if (identity.backend !== "Kubernetes") {
      throw new Error("Kubernetes Sandbox requires a Kubernetes execution account");
    }
    if (manifest.executionMode !== "RootImpersonation") {
      throw new Error("Kubernetes Sandbox does not support SelfAccount execution");
    }
    return;
  }
  if (identity.backend !== "Unix") {
    throw new Error("HPC Sandbox requires a Unix execution account");
  }
  if (manifest.executionMode === "SelfAccount") {
    if (options.adapterType !== "slurm") {
      throw new Error("SelfAccount Sandbox is supported only by the Slurm adapter");
    }
    if (manifest.executionProfile) {
      throw new Error("SelfAccount Sandbox cannot use a restricted execution profile");
    }
    assertSelfAccountIdentity(identity, options.processIdentity);
    return;
  }
  if (
    manifest.executionMode !== "RootImpersonation" ||
    !options.rootImpersonationEnabled ||
    options.processIdentity?.uid !== 0
  ) {
    throw new Error("Unix Sandbox impersonation requires an enabled root Agent");
  }
}

function validateRuntimeAttestation(
  manifest: SandboxUnsignedManifest,
  runtime: SandboxRuntimeCacheFact,
  options: SandboxManifestVerifierOptions,
  now: number,
): void {
  if (manifest.executionMode !== options.localExecutionMode) {
    throw new Error("Sandbox execution mode does not match the local Agent mode");
  }
  if (manifest.executionMode !== "SelfAccount") {
    if (
      manifest.runtimeAttestationId &&
      manifest.runtimeAttestationId !== runtime.runtimeAttestationId
    ) {
      throw new Error("Sandbox runtime attestation does not match local runtime facts");
    }
    return;
  }
  if (
    !manifest.runtimeAttestationId ||
    manifest.runtimeAttestationId !== runtime.runtimeAttestationId ||
    !isCanonicalAbsolutePath(runtime.apptainerPath) ||
    !isCanonicalAbsolutePath(runtime.seccompProfilePath) ||
    !runtime.attestedNodes?.length ||
    runtime.attestedNodes.some((node) => !/^[A-Za-z0-9._-]{1,255}$/.test(node)) ||
    runtime.expiresAtUnixMs === undefined ||
    runtime.expiresAtUnixMs <= now
  ) {
    throw new Error("SelfAccount Sandbox runtime attestation is missing, expired, or invalid");
  }
}

function validateExecutionProfile(
  manifest: SandboxUnsignedManifest,
  runtime: SandboxRuntimeCacheFact,
  expected: SandboxTrustedExecutionProfile | undefined,
): void {
  const profile = manifest.executionProfile;
  if (!profile) return;
  if (!expected) throw new Error("Sandbox trusted execution profile is unavailable locally");
  if (manifest.runtime.kind !== "SIF") {
    throw new Error("Sandbox trusted execution profile requires a SIF runtime");
  }
  if (
    profile.profileId !== expected.profileId ||
    profile.apptainerCanonicalPath !== expected.apptainerCanonicalPath ||
    profile.apptainerSha256 !== expected.apptainerSha256 ||
    profile.sifCanonicalPath !== expected.sifCanonicalPath ||
    profile.sifSha256 !== expected.sifSha256 ||
    profile.trustedWrapperCanonicalPath !== expected.trustedWrapperCanonicalPath ||
    profile.trustedWrapperSha256 !== expected.trustedWrapperSha256
  ) {
    throw new Error("Sandbox trusted execution profile does not match local immutable profile");
  }
  if (
    runtime.localPath !== profile.sifCanonicalPath ||
    manifest.runtime.digest !== `sha256:${profile.sifSha256}`
  ) {
    throw new Error("Sandbox trusted execution profile does not pin the verified SIF");
  }
}

export class SandboxManifestVerifier {
  private readonly now: () => number;
  private readonly maxClockSkewMs: number;
  private readonly maxLifetimeMs: number;

  constructor(private readonly options: SandboxManifestVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 30_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? 15 * 60_000;
  }

  async verify(jobId: string, input: SandboxSignedManifest): Promise<VerifiedSandboxManifest> {
    const manifest = SandboxSignedManifestSchema.parse(input);
    if (manifest.jobId !== jobId) throw new Error("Sandbox manifest job id mismatch");
    const { envelope, ...unsignedValue } = manifest;
    const unsigned = SandboxUnsignedManifestSchema.parse(unsignedValue);
    const now = this.now();
    if (envelope.issuedAtUnixMs > now + this.maxClockSkewMs) {
      throw new Error("Sandbox signature is issued in the future");
    }
    if (envelope.expiresAtUnixMs <= now) throw new Error("Sandbox signature has expired");
    if (
      envelope.expiresAtUnixMs <= envelope.issuedAtUnixMs ||
      envelope.expiresAtUnixMs - envelope.issuedAtUnixMs > this.maxLifetimeMs
    ) {
      throw new Error("Sandbox signature lifetime is invalid");
    }
    const manifestJson = canonicalJson(unsigned);
    if (sha256(manifestJson) !== envelope.manifestSha256) {
      throw new Error("Sandbox manifest hash mismatch");
    }
    const publicKey = this.options.publicKeys[envelope.keyId];
    if (!publicKey) throw new Error("Sandbox signature key is not trusted");
    if (
      !verify(
        null,
        Buffer.from(manifestJson),
        publicKey,
        Buffer.from(envelope.signatureBase64, "base64"),
      )
    ) {
      throw new Error("Sandbox signature verification failed");
    }
    const scriptContent = Buffer.from(unsigned.script.contentBase64, "base64");
    if (scriptContent.byteLength > 1_000_000 || scriptContent.includes(0)) {
      throw new Error("Sandbox script exceeds the size limit or contains NUL bytes");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(scriptContent);
    if (sha256(scriptContent) !== unsigned.script.sha256) {
      throw new Error("Sandbox script content hash mismatch");
    }
    if (bundleSha256(unsigned.script) !== unsigned.script.bundleSha256) {
      throw new Error("Sandbox script bundle hash mismatch");
    }
    const runtime = this.options.runtimeCache[unsigned.runtime.digest];
    if (!runtime || runtime.kind !== unsigned.runtime.kind || !runtime.signatureVerified) {
      throw new Error("Sandbox runtime is not cached and signature-verified");
    }
    validateRuntimeAttestation(unsigned, runtime, this.options, now);
    validateExecutionProfile(unsigned, runtime, this.options.restrictedExecutionProfile);
    if (
      (this.options.adapterType === "kubernetes" && runtime.kind !== "OCI") ||
      (this.options.adapterType !== "kubernetes" && runtime.kind !== "SIF")
    ) {
      throw new Error("Sandbox runtime kind is incompatible with scheduler adapter");
    }
    validateMounts(unsigned);
    validateIdentity(unsigned, unsigned.identity, this.options);
    if (!(await this.options.accountVerifier.verify(unsigned.identity))) {
      throw new Error("Sandbox execution account does not match local facts");
    }
    if (
      !(await this.options.nonceConsumer.consume(
        envelope.nonce,
        jobId,
        new Date(envelope.expiresAtUnixMs),
      ))
    ) {
      throw new Error("Sandbox signature nonce replay detected");
    }
    return {
      manifest,
      unsigned,
      scriptContent,
      runtimePath: runtime.localPath,
      ...(runtime.runtimeAttestationId
        ? { runtimeAttestationId: runtime.runtimeAttestationId }
        : {}),
      ...(runtime.apptainerPath ? { apptainerPath: runtime.apptainerPath } : {}),
      ...(runtime.seccompProfilePath ? { seccompProfilePath: runtime.seccompProfilePath } : {}),
      ...(runtime.attestedNodes ? { attestedNodes: [...runtime.attestedNodes] } : {}),
    };
  }
}
