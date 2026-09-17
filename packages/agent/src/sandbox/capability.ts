import type { SandboxTrustedExecutionProfile } from "@kuintessence/shared";
import type { AgentConfig } from "../config";
import type { KubernetesSeccompProfileAttestation } from "./kubernetes-seccomp-profile";
import type { SandboxProcessIdentity, SandboxRuntimeAttestation } from "./runtime-attestation";

export interface AgentSandboxRuntimeCacheEntry {
  digest: string;
  kind: "OCI" | "SIF";
  signatureVerified: boolean;
  runtimeAttestationId?: string;
  attestedNodes?: string[];
  expiresAtUnixMs?: number;
}

export interface AgentSandboxCapability {
  enabled: boolean;
  managedRoot: string;
  executionMode: "Disabled" | "RootImpersonation" | "SelfAccount";
  selfAccount?: SandboxProcessIdentity;
  rootMode: boolean;
  networkIsolation: boolean;
  cgroups: boolean;
  seccomp: boolean;
  sifSignatureVerification: boolean;
  ecl: boolean;
  replayProtection: boolean;
  runtimeCache: AgentSandboxRuntimeCacheEntry[];
  readiness: "ready" | "degraded" | "critical";
  missingRequirements: string[];
  restrictedExecutionProfile?: SandboxTrustedExecutionProfile;
}

export function buildSandboxCapability(
  config: AgentConfig,
  adapterType: string,
  processIdentity: SandboxProcessIdentity | undefined,
  attestation?: SandboxRuntimeAttestation,
  kubernetesSeccompProfile?: KubernetesSeccompProfileAttestation,
): AgentSandboxCapability {
  const enabled = config.AGENT_SANDBOX_ENABLED;
  const selfAccountRequested = config.AGENT_SANDBOX_EXECUTION_MODE === "self-account";
  const rootRequested =
    config.AGENT_SANDBOX_EXECUTION_MODE === "root-impersonation" ||
    (config.AGENT_SANDBOX_EXECUTION_MODE === "disabled" && config.AGENT_SANDBOX_ROOT_IMPERSONATION);
  const rootMode =
    rootRequested && config.AGENT_SANDBOX_ROOT_IMPERSONATION && processIdentity?.uid === 0;
  const selfAccount =
    selfAccountRequested &&
    adapterType === "slurm" &&
    processIdentity &&
    processIdentity.uid > 0 &&
    processIdentity.gid > 0
      ? processIdentity
      : undefined;
  const executionMode = selfAccount
    ? "SelfAccount"
    : rootMode || (adapterType === "kubernetes" && !selfAccountRequested)
      ? "RootImpersonation"
      : "Disabled";
  const selfAccountMode = executionMode === "SelfAccount";
  const runtimeCache = selfAccountMode
    ? Object.entries(attestation?.runtimeCache ?? {}).map(([digest, runtime]) => ({
        digest,
        kind: runtime.kind,
        signatureVerified: runtime.signatureVerified,
        runtimeAttestationId: runtime.runtimeAttestationId,
        attestedNodes: runtime.attestedNodes,
        expiresAtUnixMs: runtime.expiresAtUnixMs,
      }))
    : Object.entries(config.AGENT_SANDBOX_RUNTIME_CACHE_JSON).map(([digest, runtime]) => ({
        digest,
        kind: runtime.kind,
        signatureVerified: runtime.signatureVerified,
      }));
  runtimeCache.sort((left, right) => left.digest.localeCompare(right.digest));
  const kubernetesMode = adapterType === "kubernetes";
  const networkIsolation = selfAccountMode
    ? (attestation?.networkIsolation ?? false)
    : config.AGENT_SANDBOX_NETWORK_ISOLATION &&
      (!kubernetesMode || kubernetesSeccompProfile?.ready === true);
  const cgroups = selfAccountMode ? (attestation?.cgroups ?? false) : config.AGENT_SANDBOX_CGROUPS;
  const seccomp = selfAccountMode
    ? (attestation?.seccomp ?? false)
    : config.AGENT_SANDBOX_SECCOMP && (!kubernetesMode || kubernetesSeccompProfile?.ready === true);
  const sifSignatureVerification = selfAccountMode
    ? (attestation?.sifSignatureVerification ?? false)
    : config.AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION;
  const ecl = selfAccountMode ? (attestation?.ecl ?? false) : config.AGENT_SANDBOX_ECL;
  const missingRequirements: string[] = [];
  if (!enabled) missingRequirements.push("sandbox-disabled");
  if (executionMode === "Disabled") missingRequirements.push("execution-mode");
  if (selfAccountRequested && adapterType !== "slurm") {
    missingRequirements.push("self-account-adapter-unsupported");
  }
  if (!networkIsolation) missingRequirements.push("network-isolation");
  if (!cgroups) missingRequirements.push("cgroups");
  if (!seccomp) missingRequirements.push("seccomp");
  if (kubernetesMode && !kubernetesSeccompProfile?.ready) {
    missingRequirements.push(
      ...(kubernetesSeccompProfile?.missingRequirements ?? [
        "kubernetes-localhost-seccomp-profile",
      ]),
    );
  }
  if (selfAccountMode) {
    missingRequirements.push(...(attestation?.missingRequirements ?? ["runtime-attestation"]));
  }
  if (Object.keys(config.AGENT_SANDBOX_PUBLIC_KEYS_JSON).length === 0) {
    missingRequirements.push("dispatch-signing-key");
  }
  if (!runtimeCache.some((runtime) => runtime.signatureVerified)) {
    missingRequirements.push("signature-verified-runtime");
  }
  if (adapterType !== "kubernetes") {
    if (!sifSignatureVerification) {
      missingRequirements.push("sif-signature-verification");
    }
    if (!selfAccountMode && !rootMode) {
      missingRequirements.push("root-impersonation");
    }
    if (!selfAccountMode && !ecl) {
      missingRequirements.push("apptainer-ecl");
    }
  }
  const uniqueMissingRequirements = [...new Set(missingRequirements)];
  const critical = uniqueMissingRequirements.some((reason) =>
    [
      "sandbox-disabled",
      "execution-mode",
      "self-account-adapter-unsupported",
      "network-isolation",
      "dispatch-signing-key",
      "signature-verified-runtime",
    ].includes(reason),
  );
  return {
    enabled,
    managedRoot: config.AGENT_SANDBOX_ROOT,
    executionMode,
    ...(selfAccount ? { selfAccount } : {}),
    rootMode,
    networkIsolation,
    cgroups,
    seccomp,
    sifSignatureVerification,
    ecl,
    replayProtection: true,
    runtimeCache,
    readiness:
      uniqueMissingRequirements.length === 0 ? "ready" : critical ? "critical" : "degraded",
    missingRequirements: uniqueMissingRequirements,
  };
}

export async function refreshKubernetesSandboxCapability(
  capability: AgentSandboxCapability,
  config: AgentConfig,
  adapterType: string,
  processIdentity: SandboxProcessIdentity | undefined,
  attest: () => Promise<KubernetesSeccompProfileAttestation>,
): Promise<KubernetesSeccompProfileAttestation> {
  const profile = await attest();
  Object.assign(
    capability,
    buildSandboxCapability(config, adapterType, processIdentity, undefined, profile),
  );
  return profile;
}
