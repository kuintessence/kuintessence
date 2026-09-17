import { z } from "zod";
import { UuidSchema } from "./workflow-dsl/common";
import {
  ArtifactDurabilitySchema,
  ExecutionIdentitySchema,
  PlacementConstraintSchema,
  SandboxLanguageSchema,
  ScriptIoTypeSchema,
} from "./workflow-dsl/script";

export type {
  ArtifactDurability,
  ExecutionIdentity,
  PlacementConstraint,
  SandboxLanguage,
  ScriptInputSpec,
  ScriptIoType,
  ScriptOutputSpec,
} from "./workflow-dsl/script";

export const SandboxAdapterSchema = z.enum(["slurm", "pbs-pro", "torque", "kubernetes"]);
export type SandboxAdapter = z.infer<typeof SandboxAdapterSchema>;

/**
 * The signed Agent-side execution model. `SelfAccount` is deliberately
 * separate from privileged Unix impersonation and can only execute as the
 * Agent process account.
 */
export const SandboxExecutionModeSchema = z.enum(["RootImpersonation", "SelfAccount"]);
export type SandboxExecutionMode = z.infer<typeof SandboxExecutionModeSchema>;

export const SandboxSelfAccountSchema = z.strictObject({
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/),
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
});
export type SandboxSelfAccount = z.infer<typeof SandboxSelfAccountSchema>;

export const SandboxRuntimeAttestationIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type SandboxRuntimeAttestationId = z.infer<typeof SandboxRuntimeAttestationIdSchema>;

export const SandboxRuntimeLifecycleSchema = z.enum(["draft", "active", "deprecated", "revoked"]);
export type SandboxRuntimeLifecycle = z.infer<typeof SandboxRuntimeLifecycleSchema>;

export const RuntimeDependencySchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1).optional(),
});
export type RuntimeDependency = z.infer<typeof RuntimeDependencySchema>;

export const SandboxRuntimeProfileSchema = z
  .strictObject({
    id: UuidSchema,
    name: z.string().min(1),
    language: SandboxLanguageSchema,
    languageVersion: z.string().min(1),
    ociDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullish(),
    sifDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullish(),
    signature: z.string().min(1),
    dependencies: z.array(RuntimeDependencySchema).default([]),
    documentation: z.record(z.string().min(2), z.string()).default({}),
    adapters: z.array(SandboxAdapterSchema).min(1),
    security: z.strictObject({
      networkDisabled: z.literal(true),
      readOnlyRootFilesystem: z.literal(true),
      runAsNonRoot: z.literal(true),
      seccompRequired: z.boolean(),
      signatureVerificationRequired: z.literal(true),
    }),
    lifecycle: SandboxRuntimeLifecycleSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .superRefine((profile, ctx) => {
    if (profile.ociDigest == null && profile.sifDigest == null) {
      ctx.addIssue({ code: "custom", message: "at least one runtime digest is required" });
    }
    if (profile.adapters.includes("kubernetes") && profile.ociDigest == null) {
      ctx.addIssue({ code: "custom", message: "kubernetes runtime requires ociDigest" });
    }
    if (profile.adapters.some((adapter) => adapter !== "kubernetes") && profile.sifDigest == null) {
      ctx.addIssue({ code: "custom", message: "HPC runtime requires sifDigest" });
    }
  });
export type SandboxRuntimeProfile = z.infer<typeof SandboxRuntimeProfileSchema>;

export const ClusterExecutionAccountBackendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("Unix"),
    username: z.string().min(1),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    schedulerAccount: z.string().min(1).nullish(),
    allowedQueues: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({
    type: z.literal("Kubernetes"),
    namespace: z.string().min(1),
    serviceAccount: z.string().min(1),
    quotaPolicy: z.record(z.string(), z.string()).default({}),
  }),
]);
export type ClusterExecutionAccountBackend = z.infer<typeof ClusterExecutionAccountBackendSchema>;

export const ClusterExecutionAccountSchema = z.strictObject({
  id: UuidSchema,
  providerOrgId: UuidSchema,
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  backend: ClusterExecutionAccountBackendSchema,
  sharedService: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ClusterExecutionAccount = z.infer<typeof ClusterExecutionAccountSchema>;

export const AccountMappingStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "revoked",
  "expired",
]);
export type AccountMappingStatus = z.infer<typeof AccountMappingStatusSchema>;

export const UserClusterAccountMappingSchema = z.strictObject({
  id: UuidSchema,
  userId: UuidSchema,
  accountId: UuidSchema,
  status: AccountMappingStatusSchema,
  isDefault: z.boolean().default(false),
  requestedAt: z.coerce.date(),
  reviewedAt: z.coerce.date().nullish(),
  reviewedBy: UuidSchema.nullish(),
  expiresAt: z.coerce.date().nullish(),
  revokedAt: z.coerce.date().nullish(),
});
export type UserClusterAccountMapping = z.infer<typeof UserClusterAccountMappingSchema>;

export const AccountAssignmentDelegationSchema = z.strictObject({
  providerOrgId: UuidSchema,
  delegated: z.boolean(),
  updatedBy: UuidSchema,
  updatedAt: z.coerce.date(),
});
export type AccountAssignmentDelegation = z.infer<typeof AccountAssignmentDelegationSchema>;

export const ArtifactReplicaStatusSchema = z.enum([
  "pending",
  "available",
  "persisting",
  "failed",
  "expired",
]);
export type ArtifactReplicaStatus = z.infer<typeof ArtifactReplicaStatusSchema>;

export const WorkflowArtifactSchema = z.strictObject({
  id: UuidSchema,
  workflowRunId: UuidSchema,
  producerNodeId: z.string().min(1),
  descriptor: z.string().min(1),
  ioType: ScriptIoTypeSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  durability: ArtifactDurabilitySchema,
  netdriveFileId: UuidSchema.nullish(),
  createdAt: z.coerce.date(),
  persistentAt: z.coerce.date().nullish(),
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

export const ArtifactReplicaSchema = z.strictObject({
  id: UuidSchema,
  artifactId: UuidSchema,
  agentId: z.string().min(1),
  siteId: z.string().min(1),
  clusterId: z.string().min(1),
  storageKind: z.enum(["agent-local", "netdrive"]),
  status: ArtifactReplicaStatusSchema,
  verifiedAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
  failureReason: z.string().nullish(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ArtifactReplica = z.infer<typeof ArtifactReplicaSchema>;

export const PlannerModeSchema = z.enum(["Global", "Lookahead", "Greedy"]);
export type PlannerMode = z.infer<typeof PlannerModeSchema>;

export const WorkflowPlacementConfigSchema = z.strictObject({
  plannerMode: PlannerModeSchema.default("Global"),
  defaultExecutionIdentity: ExecutionIdentitySchema.default({ type: "MappedAuto" }),
  budgetCap: z.number().nonnegative().nullish().default(null),
  runConstraint: PlacementConstraintSchema.nullish().default(null),
  subgraphConstraints: z.record(z.string().min(1), PlacementConstraintSchema).default({}),
  nodeConstraints: z.record(z.string().min(1), PlacementConstraintSchema).default({}),
});
export type WorkflowPlacementConfig = z.infer<typeof WorkflowPlacementConfigSchema>;

export const PlacementObjectiveSchema = z.strictObject({
  computeCost: z.number().nonnegative(),
  queueWaitCost: z.number().nonnegative(),
  wallTimeCost: z.number().nonnegative(),
  inputTransferCost: z.number().nonnegative(),
  outputTransferCost: z.number().nonnegative(),
  runtimeCacheCost: z.number().nonnegative(),
  failureRiskCost: z.number().nonnegative(),
  preferenceCost: z.number().nonnegative(),
  total: z.number().nonnegative(),
});
export type PlacementObjective = z.infer<typeof PlacementObjectiveSchema>;

export const PlacementPlanNodeSchema = z.strictObject({
  nodeId: z.string().min(1),
  executionIdentity: ExecutionIdentitySchema,
  preferredAgentId: z.string().min(1),
  fallbackAgentIds: z.array(z.string().min(1)).default([]),
  constraint: PlacementConstraintSchema.nullish(),
  objective: PlacementObjectiveSchema,
  estimatedInputBytes: z.number().int().nonnegative(),
  estimatedOutputBytes: z.number().int().nonnegative(),
});
export type PlacementPlanNode = z.infer<typeof PlacementPlanNodeSchema>;

export const PlacementPlanSchema = z.strictObject({
  id: UuidSchema,
  workflowRunId: UuidSchema,
  version: z.number().int().positive(),
  mode: PlannerModeSchema,
  trigger: z.string().min(1),
  nodes: z.array(PlacementPlanNodeSchema),
  objective: PlacementObjectiveSchema,
  budgetCap: z.number().nonnegative().nullish(),
  budgetStatus: z.enum(["within-cap", "awaiting-approval", "approved"]),
  supersedesPlanId: UuidSchema.nullish(),
  createdAt: z.coerce.date(),
});
export type PlacementPlan = z.infer<typeof PlacementPlanSchema>;

export const ScriptAttestationSchema = z.strictObject({
  id: UuidSchema,
  assetRevisionId: UuidSchema,
  scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  runtimeProfileId: UuidSchema,
  runtimeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  scope: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("Platform") }),
    z.strictObject({ type: z.literal("Provider"), providerOrgId: UuidSchema }),
  ]),
  scanResultHash: z.string().regex(/^[0-9a-f]{64}$/),
  allowedIdentities: z.array(ExecutionIdentitySchema).min(1),
  status: z.enum(["active", "revoked", "expired"]),
  signedBy: UuidSchema,
  signedAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullish(),
  revokedAt: z.coerce.date().nullish(),
});
export type ScriptAttestation = z.infer<typeof ScriptAttestationSchema>;

const PolicyLimitsSchema = z.strictObject({
  maxCpuCores: z.number().int().positive(),
  maxMemoryMb: z.number().int().positive(),
  maxWallTimeSec: z.number().int().positive(),
  maxPids: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxLogBytes: z.number().int().positive(),
});

export const EffectiveSandboxPolicySchema = z.strictObject({
  sandboxEnabled: z.boolean(),
  impersonationEnabled: z.boolean(),
  selfAccountEnabled: z.boolean(),
  degradedImpersonationAllowed: z.boolean(),
  sharedServiceAllowed: z.boolean(),
  runtimePrecacheRequired: z.boolean(),
  limits: PolicyLimitsSchema,
  disabledRuntimeProfileIds: z.array(UuidSchema),
});
export type EffectiveSandboxPolicy = z.infer<typeof EffectiveSandboxPolicySchema>;

export const SandboxPolicyOverlaySchema = z.strictObject({
  sandboxEnabled: z.boolean().optional(),
  impersonationEnabled: z.boolean().optional(),
  selfAccountEnabled: z.boolean().optional(),
  degradedImpersonationAllowed: z.boolean().optional(),
  sharedServiceAllowed: z.boolean().optional(),
  runtimePrecacheRequired: z.boolean().optional(),
  limits: PolicyLimitsSchema.partial().optional(),
  disabledRuntimeProfileIds: z.array(UuidSchema).optional(),
});
export type SandboxPolicyOverlay = z.infer<typeof SandboxPolicyOverlaySchema>;

function tightenBoolean(current: boolean, next: boolean | undefined): boolean {
  return next === undefined ? current : current && next;
}

export function tightenSandboxPolicy(
  platform: EffectiveSandboxPolicy,
  overlays: readonly SandboxPolicyOverlay[],
): EffectiveSandboxPolicy {
  let effective = EffectiveSandboxPolicySchema.parse(platform);
  for (const overlay of overlays) {
    const parsed = SandboxPolicyOverlaySchema.parse(overlay);
    effective = {
      sandboxEnabled: tightenBoolean(effective.sandboxEnabled, parsed.sandboxEnabled),
      impersonationEnabled: tightenBoolean(
        effective.impersonationEnabled,
        parsed.impersonationEnabled,
      ),
      selfAccountEnabled: tightenBoolean(effective.selfAccountEnabled, parsed.selfAccountEnabled),
      degradedImpersonationAllowed: tightenBoolean(
        effective.degradedImpersonationAllowed,
        parsed.degradedImpersonationAllowed,
      ),
      sharedServiceAllowed: tightenBoolean(
        effective.sharedServiceAllowed,
        parsed.sharedServiceAllowed,
      ),
      runtimePrecacheRequired:
        effective.runtimePrecacheRequired || (parsed.runtimePrecacheRequired ?? false),
      limits: {
        maxCpuCores: Math.min(
          effective.limits.maxCpuCores,
          parsed.limits?.maxCpuCores ?? Number.POSITIVE_INFINITY,
        ),
        maxMemoryMb: Math.min(
          effective.limits.maxMemoryMb,
          parsed.limits?.maxMemoryMb ?? Number.POSITIVE_INFINITY,
        ),
        maxWallTimeSec: Math.min(
          effective.limits.maxWallTimeSec,
          parsed.limits?.maxWallTimeSec ?? Number.POSITIVE_INFINITY,
        ),
        maxPids: Math.min(
          effective.limits.maxPids,
          parsed.limits?.maxPids ?? Number.POSITIVE_INFINITY,
        ),
        maxOutputBytes: Math.min(
          effective.limits.maxOutputBytes,
          parsed.limits?.maxOutputBytes ?? Number.POSITIVE_INFINITY,
        ),
        maxLogBytes: Math.min(
          effective.limits.maxLogBytes,
          parsed.limits?.maxLogBytes ?? Number.POSITIVE_INFINITY,
        ),
      },
      disabledRuntimeProfileIds: [
        ...new Set([
          ...effective.disabledRuntimeProfileIds,
          ...(parsed.disabledRuntimeProfileIds ?? []),
        ]),
      ].sort(),
    };
  }
  return effective;
}

export const SandboxCapabilityReportSchema = z.strictObject({
  rootMode: z.boolean(),
  readiness: z.enum(["ready", "degraded", "critical"]),
  adapters: z.array(SandboxAdapterSchema),
  cachedRuntimeDigests: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  networkIsolation: z.boolean(),
  cgroups: z.boolean(),
  seccomp: z.boolean(),
  apptainerEcl: z.boolean(),
  signatureVerification: z.boolean(),
  mtls: z.boolean(),
  replayProtection: z.boolean(),
  accountVerification: z.boolean(),
  reasons: z.array(z.string()).default([]),
});
export type SandboxCapabilityReport = z.infer<typeof SandboxCapabilityReportSchema>;

const SandboxDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SandboxContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const SandboxDescriptorSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const SandboxCanonicalAbsolutePathSchema = z
  .string()
  .regex(/^\/[^\0\r\n ]+$/, "Sandbox trusted path must be absolute and canonical");

/**
 * Root-managed execution identity for a restricted HPC Sandbox. Every value
 * is signed before dispatch; the compute-node wrapper compares it to its own
 * root-owned profile before it execs Apptainer.
 */
export const SandboxTrustedExecutionProfileSchema = z.strictObject({
  profileId: UuidSchema,
  apptainerCanonicalPath: SandboxCanonicalAbsolutePathSchema,
  apptainerSha256: SandboxContentHashSchema,
  sifCanonicalPath: SandboxCanonicalAbsolutePathSchema,
  sifSha256: SandboxContentHashSchema,
  trustedWrapperCanonicalPath: SandboxCanonicalAbsolutePathSchema,
  trustedWrapperSha256: SandboxContentHashSchema,
});
export type SandboxTrustedExecutionProfile = z.infer<typeof SandboxTrustedExecutionProfileSchema>;

export const SandboxDispatchIdentitySchema = z.discriminatedUnion("backend", [
  z.strictObject({
    mode: z.enum(["SharedService", "MappedAccount"]),
    accountId: UuidSchema,
    backend: z.literal("Unix"),
    username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    schedulerAccount: z.string().min(1).max(128).nullish(),
    allowedQueues: z.array(z.string().min(1).max(128)).default([]),
  }),
  z.strictObject({
    mode: z.enum(["SharedService", "MappedAccount"]),
    accountId: UuidSchema,
    backend: z.literal("Kubernetes"),
    namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    serviceAccount: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    quotaPolicy: z.string().max(255).nullish(),
  }),
]);
export type SandboxDispatchIdentity = z.infer<typeof SandboxDispatchIdentitySchema>;

export const SandboxDispatchMountSchema = z.strictObject({
  descriptor: SandboxDescriptorSchema,
  ioType: ScriptIoTypeSchema,
  mode: z.enum(["ReadOnly", "WriteOnly"]),
  relativePath: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
      message: "sandbox mount path must stay relative to the run directory",
    }),
  containerPath: z.string().regex(/^\/kq\/(inputs|outputs)\/[A-Za-z0-9._-]{1,128}$/),
  expectedSha256: SandboxContentHashSchema.nullish(),
  inlineContentBase64: z.string().max(5_600_000).nullish(),
  batchEntries: z
    .array(
      z.strictObject({
        relativePath: z
          .string()
          .min(1)
          .max(255)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
        sha256: SandboxContentHashSchema,
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .max(256)
    .default([]),
  sizeLimitBytes: z.number().int().positive(),
  required: z.boolean().default(true),
});
export type SandboxDispatchMount = z.infer<typeof SandboxDispatchMountSchema>;

export const SandboxUnsignedManifestSchema = z
  .strictObject({
    jobId: UuidSchema,
    script: z.strictObject({
      language: SandboxLanguageSchema,
      entrypoint: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      contentBase64: z.string().min(1),
      sha256: SandboxContentHashSchema,
      bundleSha256: SandboxContentHashSchema,
    }),
    runtime: z.strictObject({
      profileId: UuidSchema,
      kind: z.enum(["OCI", "SIF"]),
      digest: SandboxDigestSchema,
    }),
    executionMode: SandboxExecutionModeSchema,
    runtimeAttestationId: SandboxRuntimeAttestationIdSchema.optional(),
    /** Present only for restricted no-egress HPC dispatches; when present it is signed. */
    executionProfile: SandboxTrustedExecutionProfileSchema.optional(),
    identity: SandboxDispatchIdentitySchema,
    mounts: z.array(SandboxDispatchMountSchema).max(256),
    limits: z.strictObject({
      pids: z.number().int().positive(),
      outputBytes: z.number().int().positive(),
      logBytes: z.number().int().positive(),
    }),
    networkDisabled: z.literal(true),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.executionMode !== "SelfAccount") return;
    if (!manifest.runtimeAttestationId) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeAttestationId"],
        message: "SelfAccount Sandbox execution requires a runtime attestation id",
      });
    }
    if (manifest.identity.backend !== "Unix" || manifest.identity.mode !== "MappedAccount") {
      ctx.addIssue({
        code: "custom",
        path: ["identity"],
        message: "SelfAccount Sandbox execution requires a mapped Unix identity",
      });
    }
    if (manifest.executionProfile) {
      ctx.addIssue({
        code: "custom",
        path: ["executionProfile"],
        message: "SelfAccount Sandbox execution cannot use a restricted execution profile",
      });
    }
  });
export type SandboxUnsignedManifest = z.infer<typeof SandboxUnsignedManifestSchema>;

export const SandboxSignedManifestSchema = SandboxUnsignedManifestSchema.extend({
  envelope: z.strictObject({
    keyId: z.string().min(1).max(128),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    issuedAtUnixMs: z.number().int().positive(),
    expiresAtUnixMs: z.number().int().positive(),
    manifestSha256: SandboxContentHashSchema,
    signatureBase64: z.string().min(1),
  }),
});
export type SandboxSignedManifest = z.infer<typeof SandboxSignedManifestSchema>;
