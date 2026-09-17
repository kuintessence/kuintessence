import { z } from "zod";
import { AssetSelectorSourceSchema } from "./workflow-dsl/refs";
import {
  ExecutionIdentitySchema,
  SandboxLanguageSchema,
  ScriptInputSpecSchema,
  ScriptOutputSpecSchema,
} from "./workflow-dsl/script";

export const SoftwareAssetKindSchema = z.enum([
  "spack-package",
  "usecase",
  "workflow-template",
  "sandbox-script",
]);
export type SoftwareAssetKind = z.infer<typeof SoftwareAssetKindSchema>;

export const SoftwareAssetSourceSchema = AssetSelectorSourceSchema;
export type SoftwareAssetSource = z.infer<typeof SoftwareAssetSourceSchema>;

export const LicenseClassificationSchema = z.enum([
  "open-source",
  "source-available",
  "proprietary",
  "unknown",
]);
export type LicenseClassification = z.infer<typeof LicenseClassificationSchema>;

export const LicenseIdentifierSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("spdx"), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal("custom"), value: z.string().min(1) }),
]);
export type LicenseIdentifier = z.infer<typeof LicenseIdentifierSchema>;

export const LicenseEntitlementSchema = z.enum([
  "acceptance",
  "provider-source",
  "provider-install",
  "consumer-use",
]);
export type LicenseEntitlement = z.infer<typeof LicenseEntitlementSchema>;

export const LicenseRequirementSchema = z.strictObject({
  identifier: z.string().min(1),
  requiredEntitlements: z.array(LicenseEntitlementSchema).default([]),
});
export type LicenseRequirement = z.infer<typeof LicenseRequirementSchema>;

/**
 * Governance metadata only. Evidence references never contain license keys,
 * contracts, or licensed material bytes.
 */
export const LicensePolicySchema = z.strictObject({
  classification: LicenseClassificationSchema,
  identifiers: z.array(LicenseIdentifierSchema).min(1),
  termsUrl: z.string().url().optional(),
  noticeUrl: z.string().url().optional(),
  provenance: z.strictObject({
    source: AssetSelectorSourceSchema,
    reference: z.string().min(1),
  }),
  acceptanceRequired: z.boolean().default(false),
  providerEntitlements: z.array(z.enum(["source-access", "install"])).default([]),
  consumerEntitlements: z.array(z.enum(["use"])).default([]),
  redistribution: z.enum(["permitted", "restricted", "prohibited"]).default("restricted"),
  autoInstall: z.enum(["allowed", "denied", "review-required"]).default("review-required"),
});
export type LicensePolicy = z.infer<typeof LicensePolicySchema>;

/** Deterministically unions upstream License requirements for usecases and workflows. */
export function propagateLicenseRequirements(
  requirements: ReadonlyArray<ReadonlyArray<LicenseRequirement>>,
): LicenseRequirement[] {
  const combined = new Map<string, Set<LicenseEntitlement>>();
  for (const requirementSet of requirements) {
    for (const requirement of requirementSet) {
      const entitlements = combined.get(requirement.identifier) ?? new Set<LicenseEntitlement>();
      for (const entitlement of requirement.requiredEntitlements) entitlements.add(entitlement);
      combined.set(requirement.identifier, entitlements);
    }
  }
  return [...combined.entries()].map(([identifier, entitlements]) => ({
    identifier,
    requiredEntitlements: [...entitlements].sort(),
  }));
}

export const SandboxRuntimeContractSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  language: z.literal("python"),
  pythonVersion: z.string().regex(/^3\.12(?:\.\d+)?$/),
  stdlibOnly: z.literal(true),
});
export type SandboxRuntimeContract = z.infer<typeof SandboxRuntimeContractSchema>;

export const SandboxRuntimeContractRefSchema = SandboxRuntimeContractSchema.pick({
  name: true,
  version: true,
});
export type SandboxRuntimeContractRef = z.infer<typeof SandboxRuntimeContractRefSchema>;

export const SoftwareAssetLifecycleSchema = z.enum([
  "draft",
  "submitted",
  "approved",
  "forked",
  "published",
  "hidden",
  "deprecated",
  "revoked",
  "archived",
]);
export type SoftwareAssetLifecycle = z.infer<typeof SoftwareAssetLifecycleSchema>;

export const SoftwareAssetCapabilitySchema = z.enum([
  "view",
  "use",
  "install",
  "edit",
  "publish",
  "review",
  "admin",
]);
export type SoftwareAssetCapability = z.infer<typeof SoftwareAssetCapabilitySchema>;

export const SoftwareProviderCapabilitySchema = z.enum(["software_provider"]);
export type SoftwareProviderCapability = z.infer<typeof SoftwareProviderCapabilitySchema>;

export const SoftwareAssetVisibilitySchema = z.enum([
  "private",
  "shared-to-orgs",
  "platform-public",
  "pending-review",
  "hidden",
]);
export type SoftwareAssetVisibility = z.infer<typeof SoftwareAssetVisibilitySchema>;

export const UpstreamVersionSupersessionSchema = z.strictObject({
  kind: z.literal("versioned-upstream"),
  canonicalIdentity: z.string().min(1),
  legacyRevisionId: z.string().uuid(),
  replacementAssetId: z.string().uuid(),
  replacementRevisionId: z.string().uuid(),
  reason: z.string().min(1),
  supersededAt: z.string().datetime(),
  supersededBy: z.string().min(1),
});
export type UpstreamVersionSupersession = z.infer<typeof UpstreamVersionSupersessionSchema>;

export const UpstreamVersionSupersededReviewStateSchema = z
  .object({ upstreamVersionSupersession: UpstreamVersionSupersessionSchema })
  .passthrough();
export type UpstreamVersionSupersededReviewState = z.infer<
  typeof UpstreamVersionSupersededReviewStateSchema
>;

export const UpstreamVersionSnapshotLicensePolicySourceSchema = z.strictObject({
  releaseId: z.string().uuid(),
  releaseAssetId: z.string().uuid(),
});
export type UpstreamVersionSnapshotLicensePolicySource = z.infer<
  typeof UpstreamVersionSnapshotLicensePolicySourceSchema
>;

export const UpstreamVersionSnapshotProvenanceSchema = z.strictObject({
  source: z.literal("official-upstream"),
  snapshot: z.literal("versioned-upstream"),
  sourceAssetId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  sourceRevision: z.number().int().positive(),
  upstreamName: z.string().min(1),
  upstreamVersion: z.string().min(1),
  licensePolicySource: UpstreamVersionSnapshotLicensePolicySourceSchema,
});
export type UpstreamVersionSnapshotProvenance = z.infer<
  typeof UpstreamVersionSnapshotProvenanceSchema
>;

export const SoftwareGrantSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("org"), orgId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("provider-org"), orgId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("platform"), platform: z.literal(true) }),
]);
export type SoftwareGrantSubject = z.infer<typeof SoftwareGrantSubjectSchema>;

export const SoftwareAssetGrantSchema = z.strictObject({
  subject: SoftwareGrantSubjectSchema,
  capabilities: z.array(SoftwareAssetCapabilitySchema).min(1),
  inheritedFromAssetId: z.string().uuid().optional(),
  reason: z.string().optional(),
});
export type SoftwareAssetGrant = z.infer<typeof SoftwareAssetGrantSchema>;

export const SoftwareAssetRefSchema = z.strictObject({
  kind: SoftwareAssetKindSchema,
  id: z.string().uuid().optional(),
  source: z.string().optional(),
  name: z.string().min(1).optional(),
  version: z.string().optional(),
  providerOrgId: z.string().uuid().optional(),
});
export type SoftwareAssetRef = z.infer<typeof SoftwareAssetRefSchema>;

export const SoftwareAssetProvenanceSchema = z.strictObject({
  source: SoftwareAssetSourceSchema,
  upstreamName: z.string().optional(),
  upstreamRef: z.string().optional(),
  supplierUserId: z.string().uuid().optional(),
  supplierOrgId: z.string().uuid().optional(),
  officialForkOfAssetId: z.string().uuid().optional(),
  recipeSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type SoftwareAssetProvenance = z.infer<typeof SoftwareAssetProvenanceSchema>;

export const SpackRecipePayloadSchema = z.strictObject({
  packageName: z.string().min(1),
  packageFile: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  defaultSpec: z.string().min(1).optional(),
  dependencies: z.array(z.string()).default([]),
  providers: z.array(z.string()).default([]),
  variants: z.array(z.string()).default([]),
});
export type SpackRecipePayload = z.infer<typeof SpackRecipePayloadSchema>;

export const SoftwareAssetPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("spack-package"),
    legacyAppTemplateId: z.string().uuid().optional(),
    spack: SpackRecipePayloadSchema,
  }),
  z.strictObject({
    kind: z.literal("usecase"),
    usecasePackageId: z.string().uuid().optional(),
    packageRefs: z.array(SoftwareAssetRefSchema).default([]),
    spec: z.record(z.string(), z.unknown()).default({}),
  }),
  z.strictObject({
    kind: z.literal("workflow-template"),
    workflowTemplateId: z.string().uuid().optional(),
    usecaseRefs: z.array(SoftwareAssetRefSchema).default([]),
    packageRefs: z.array(SoftwareAssetRefSchema).default([]),
    yamlContent: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("sandbox-script"),
    language: SandboxLanguageSchema,
    runtimeProfileId: z.string().uuid().optional(),
    runtimeContractRef: SandboxRuntimeContractRefSchema.optional(),
    executionIdentity: ExecutionIdentitySchema.optional(),
    entrypoint: z.string().min(1),
    content: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputs: z.record(z.string().min(1), ScriptInputSpecSchema).default({}),
    outputs: z.record(z.string().min(1), ScriptOutputSpecSchema).default({}),
  }),
]);
export type SoftwareAssetPayload = z.infer<typeof SoftwareAssetPayloadSchema>;

export const SoftwareAssetSummarySchema = z.strictObject({
  id: z.string().uuid(),
  kind: SoftwareAssetKindSchema,
  name: z.string(),
  version: z.string(),
  source: SoftwareAssetSourceSchema,
  lifecycle: SoftwareAssetLifecycleSchema,
  visibility: SoftwareAssetVisibilitySchema,
  ownerUserId: z.string().uuid().nullable(),
  ownerOrgId: z.string().uuid().nullable(),
  providerOrgId: z.string().uuid().nullable(),
  supplierUserId: z.string().uuid().nullable(),
  supplierOrgId: z.string().uuid().nullable(),
  officialForkOfAssetId: z.string().uuid().nullable(),
  trustedForGlobalUse: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SoftwareAssetSummary = z.infer<typeof SoftwareAssetSummarySchema>;

export const SoftwareInstallModeSchema = z.enum([
  "preinstalled-only",
  "trusted-public-auto-install",
  "explicit-install-grant",
]);
export type SoftwareInstallMode = z.infer<typeof SoftwareInstallModeSchema>;

export const SoftwarePolicyScopeSchema = z.enum(["provider", "cluster", "agent"]);
export type SoftwarePolicyScope = z.infer<typeof SoftwarePolicyScopeSchema>;

export const SoftwarePolicyOverlaySchema = z.strictObject({
  scope: SoftwarePolicyScopeSchema,
  providerOrgId: z.string().uuid().optional(),
  clusterId: z.string().optional(),
  agentId: z.string().optional(),
  installMode: SoftwareInstallModeSchema.default("explicit-install-grant"),
  allowList: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  lockEnabled: z.boolean().default(false),
  trustedPublicAutoInstall: z.boolean().default(false),
  usecaseDefaultAllow: z.boolean().default(true),
  usecaseAllowList: z.array(z.string()).default([]),
  usecaseDenyList: z.array(z.string()).default([]),
});
export type SoftwarePolicyOverlay = z.infer<typeof SoftwarePolicyOverlaySchema>;

export const SoftwareAccessRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "canceled",
]);
export type SoftwareAccessRequestStatus = z.infer<typeof SoftwareAccessRequestStatusSchema>;

export const SoftwareAccessRequestSchema = z.strictObject({
  id: z.string().uuid(),
  asset: SoftwareAssetSummarySchema,
  capability: z.enum(["view", "use", "install"]),
  requesterUserId: z.string(),
  requesterOrgId: z.string().uuid().nullable(),
  subject: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userId: z.string() }),
    z.strictObject({ kind: z.literal("org"), orgId: z.string().uuid() }),
  ]),
  status: SoftwareAccessRequestStatusSchema,
  reason: z.string().nullable(),
  decisionReason: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SoftwareAccessRequest = z.infer<typeof SoftwareAccessRequestSchema>;

export const PreinstalledSoftwareMappingSchema = z.strictObject({
  agentId: z.string(),
  localSpec: z.string().min(1),
  assetId: z.string().uuid(),
  confidence: z.enum(["declared", "metadata-match", "hash-match", "platform-locked"]),
  auditedBy: z.string().uuid().optional(),
  auditedAt: z.string().optional(),
});
export type PreinstalledSoftwareMapping = z.infer<typeof PreinstalledSoftwareMappingSchema>;

export const MirrorCacheKindSchema = z.enum(["recipe", "metadata", "source", "buildcache"]);
export type MirrorCacheKind = z.infer<typeof MirrorCacheKindSchema>;

export const MirrorCacheStatusSchema = z.enum(["cached", "missing", "syncing", "failed"]);
export type MirrorCacheStatus = z.infer<typeof MirrorCacheStatusSchema>;

export const MirrorCacheRecordSchema = z.strictObject({
  kind: MirrorCacheKindSchema,
  status: MirrorCacheStatusSchema,
  sourceUrl: z.string().optional(),
  localUrl: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  cachedAt: z.string().optional(),
  error: z.string().optional(),
});
export type MirrorCacheRecord = z.infer<typeof MirrorCacheRecordSchema>;

export const SoftwareAssetImpactSchema = z.strictObject({
  asset: SoftwareAssetSummarySchema,
  downstream: z.array(SoftwareAssetSummarySchema),
  grants: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  mirrorCache: z.array(MirrorCacheRecordSchema),
  explanations: z.array(z.string()).default([]),
});
export type SoftwareAssetImpact = z.infer<typeof SoftwareAssetImpactSchema>;

export const MirrorBundleManifestSchema = z.strictObject({
  id: z.string().uuid(),
  generatedAt: z.string(),
  generatedBy: z.string().uuid(),
  includes: z.array(MirrorCacheKindSchema),
  assetIds: z.array(z.string().uuid()).default([]),
  sourceCount: z.number().int().nonnegative(),
  buildcacheCount: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1),
});
export type MirrorBundleManifest = z.infer<typeof MirrorBundleManifestSchema>;

export const SoftwareAvailabilitySubjectSchema = z.strictObject({
  userId: z.string().uuid(),
  role: z.string(),
  orgId: z.string().uuid().nullable().optional(),
  orgIds: z.array(z.string().uuid()).default([]),
  capabilities: z.array(SoftwareProviderCapabilitySchema).default([]),
});
export type SoftwareAvailabilitySubject = z.infer<typeof SoftwareAvailabilitySubjectSchema>;

export const SoftwareAvailabilityUsecaseRefSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
});
export type SoftwareAvailabilityUsecaseRef = z.infer<typeof SoftwareAvailabilityUsecaseRefSchema>;

export const SoftwareAvailabilityRequestSchema = z.strictObject({
  subject: SoftwareAvailabilitySubjectSchema.optional(),
  assetRef: SoftwareAssetRefSchema.optional(),
  usecaseRef: SoftwareAvailabilityUsecaseRefSchema.optional(),
  rawSpec: z.string().min(1).optional(),
  targetAgentIds: z.array(z.string()).optional(),
  providerOrgIds: z.array(z.string().uuid()).optional(),
  installable: z.boolean().default(false),
});
export type SoftwareAvailabilityRequest = z.infer<typeof SoftwareAvailabilityRequestSchema>;

export const ConcretizedDependencySchema = z.strictObject({
  name: z.string(),
  spec: z.string(),
  virtual: z.boolean().default(false),
  providers: z.array(z.string()).default([]),
});
export type ConcretizedDependency = z.infer<typeof ConcretizedDependencySchema>;

export const ConcretizedDagSchema = z.strictObject({
  rootSpec: z.string(),
  contextKey: z.string(),
  dependencies: z.array(ConcretizedDependencySchema),
  generatedAt: z.string(),
  cached: z.boolean(),
});
export type ConcretizedDag = z.infer<typeof ConcretizedDagSchema>;

export const SoftwareAvailabilityNodeSchema = z.strictObject({
  agentId: z.string(),
  siteName: z.string(),
  providerOrgId: z.string().uuid().nullable(),
  status: z.string(),
  installedSpec: z.string().optional(),
  installMode: SoftwareInstallModeSchema.optional(),
  reasons: z.array(z.string()).default([]),
});
export type SoftwareAvailabilityNode = z.infer<typeof SoftwareAvailabilityNodeSchema>;

export const SoftwareAvailabilityResponseSchema = z.strictObject({
  spec: z.string(),
  asset: SoftwareAssetSummarySchema.optional(),
  installedAvailable: z.array(SoftwareAvailabilityNodeSchema),
  installableAvailable: z.array(SoftwareAvailabilityNodeSchema),
  blocked: z.array(SoftwareAvailabilityNodeSchema),
  concretizedDag: ConcretizedDagSchema.optional(),
  explanations: z.array(z.string()).default([]),
});
export type SoftwareAvailabilityResponse = z.infer<typeof SoftwareAvailabilityResponseSchema>;
