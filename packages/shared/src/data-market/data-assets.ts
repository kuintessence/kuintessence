import { z } from "zod";

const UuidSchema = z.string().uuid();

export const DataAssetKindSchema = z.enum([
  "training-dataset",
  "scientific-dataset",
  "reference-data",
  "model-artifact",
  "pseudopotential",
  "licensed-material",
]);
export type DataAssetKind = z.infer<typeof DataAssetKindSchema>;

export const DataAssetLifecycleSchema = z.enum([
  "draft",
  "reviewing",
  "published",
  "deprecated",
  "revoked",
]);
export type DataAssetLifecycle = z.infer<typeof DataAssetLifecycleSchema>;

export const DataAssetVersionStatusSchema = z.enum([
  "draft",
  "validating",
  "ready",
  "failed",
  "deprecated",
  "revoked",
]);
export type DataAssetVersionStatus = z.infer<typeof DataAssetVersionStatusSchema>;

export const DataLocationKindSchema = z.enum([
  "platform-object",
  "user-private-object",
  "cp-local",
]);
export type DataLocationKind = z.infer<typeof DataLocationKindSchema>;

export const DataLocationStatusSchema = z.enum(["available", "unavailable", "deleted"]);
export type DataLocationStatus = z.infer<typeof DataLocationStatusSchema>;

export const DataReplicaStatusSchema = z.enum([
  "pending",
  "syncing",
  "available",
  "failed",
  "stale",
  "deleted",
  "mismatch",
  "expired",
]);
export type DataReplicaStatus = z.infer<typeof DataReplicaStatusSchema>;

export const DataVisibilitySchema = z.enum(["public", "organization", "private"]);
export type DataVisibility = z.infer<typeof DataVisibilitySchema>;

export const DataAccessModeSchema = z.enum(["open", "request", "entitlement"]);
export type DataAccessMode = z.infer<typeof DataAccessModeSchema>;

export const DataSensitivitySchema = z.enum(["open", "internal", "restricted", "regulated"]);
export type DataSensitivity = z.infer<typeof DataSensitivitySchema>;

export const DataAssetOwnerKindSchema = z.enum(["user", "org", "provider", "platform"]);
export type DataAssetOwnerKind = z.infer<typeof DataAssetOwnerKindSchema>;

export const DataAccessCapabilitySchema = z.enum(["view", "use", "download", "derive", "manage"]);
export type DataAccessCapability = z.infer<typeof DataAccessCapabilitySchema>;

export const DataPolicyActionSchema = z.enum(["allow", "deny"]);
export type DataPolicyAction = z.infer<typeof DataPolicyActionSchema>;

export const DataRetentionPolicySchema = z.enum([
  "source-controlled",
  "retain",
  "delete-on-expiry",
]);
export type DataRetentionPolicy = z.infer<typeof DataRetentionPolicySchema>;

export const DataDeliveryPolicySchema = z.strictObject({
  download: DataPolicyActionSchema.default("deny"),
  derive: DataPolicyActionSchema.default("deny"),
  redistribution: DataPolicyActionSchema.default("deny"),
  crossCenterReplication: DataPolicyActionSchema.default("deny"),
  retention: DataRetentionPolicySchema.default("source-controlled"),
});
export type DataDeliveryPolicy = z.infer<typeof DataDeliveryPolicySchema>;

export const DataGrantSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: UuidSchema }),
  z.strictObject({ kind: z.literal("org"), orgId: UuidSchema }),
  z.strictObject({ kind: z.literal("provider-org"), orgId: UuidSchema }),
  z.strictObject({ kind: z.literal("platform"), platform: z.literal(true) }),
]);
export type DataGrantSubject = z.infer<typeof DataGrantSubjectSchema>;

export const DataAccessPolicyEffectSchema = z.enum(["allow", "deny"]);
export type DataAccessPolicyEffect = z.infer<typeof DataAccessPolicyEffectSchema>;

export const DataAccessPolicySchema = z.strictObject({
  assetId: UuidSchema,
  versionId: UuidSchema.optional(),
  subject: DataGrantSubjectSchema,
  effect: DataAccessPolicyEffectSchema,
  capabilities: z.array(DataAccessCapabilitySchema).min(1),
  accessMode: DataAccessModeSchema,
  sensitivity: DataSensitivitySchema,
  deliveryPolicy: DataDeliveryPolicySchema,
  expiresAt: z.coerce.date().optional(),
  reason: z.string().min(1).max(4_000).optional(),
});
export type DataAccessPolicy = z.infer<typeof DataAccessPolicySchema>;

export const DataAccessRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "canceled",
  "expired",
]);
export type DataAccessRequestStatus = z.infer<typeof DataAccessRequestStatusSchema>;

/** Canonical relative name for an immutable Data Market manifest entry. */
export const DataAssetEntryPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === ".."),
    "Data Market targetPath must be a canonical relative path",
  );

/** A Data Market delivery target is always relative to the Agent-managed job root. */
export const DataDeliveryTargetPathSchema = DataAssetEntryPathSchema;

const NetdriveDataInputRefSchema = z.strictObject({
  source: z.literal("netdrive"),
  fileMetadataId: UuidSchema,
  fileMetadataName: z.string().min(1),
  hash: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  targetPath: DataDeliveryTargetPathSchema.optional(),
});

const DataMarketDataInputRefSchema = z.strictObject({
  source: z.literal("data-market"),
  assetId: UuidSchema,
  versionId: UuidSchema,
  manifestDigest: z.string().min(1).max(128),
  selectedEntries: z.array(DataAssetEntryPathSchema).default([]),
  targetPath: DataDeliveryTargetPathSchema.optional(),
});

const DataInputRefUnionSchema = z.discriminatedUnion("source", [
  NetdriveDataInputRefSchema,
  DataMarketDataInputRefSchema,
]);

/** Legacy file metadata input is normalized to the explicit netdrive source. */
export const DataInputRefSchema = z.preprocess((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    !("source" in value) &&
    "fileMetadataId" in value
  ) {
    return { ...value, source: "netdrive" };
  }
  return value;
}, DataInputRefUnionSchema);
export type DataInputRef = z.infer<typeof DataInputRefSchema>;

export const DatasetSchema = DataMarketDataInputRefSchema;
export type Dataset = z.infer<typeof DatasetSchema>;

export const DataRequirementsSchema = z.strictObject({
  acceptedFormats: z.array(z.string().min(1).max(128)).default([]),
  requiredSchema: z.string().min(1).max(255).optional(),
  requiredTags: z.array(z.string().min(1).max(128)).default([]),
  minBytes: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
  accessModes: z.array(DataAccessModeSchema).default([]),
  maxSensitivity: DataSensitivitySchema.optional(),
  localityRequired: z.boolean().default(false),
});
export type DataRequirements = z.infer<typeof DataRequirementsSchema>;

export const ResolvedDataBindingSchema = z
  .strictObject({
    input: DataInputRefSchema,
    assetId: UuidSchema.nullable(),
    versionId: UuidSchema.nullable(),
    manifestDigest: z.string().min(1).max(128).nullable(),
    selectedEntries: z.array(DataAssetEntryPathSchema).default([]),
    allowedLocationIds: z.array(UuidSchema).default([]),
    deliveryPolicy: DataDeliveryPolicySchema,
    assetKind: DataAssetKindSchema.nullable(),
    sensitivity: DataSensitivitySchema.nullable(),
    egressPolicy: DataPolicyActionSchema,
    stagePath: z.string().min(1).max(2_048),
  })
  .superRefine((binding, ctx) => {
    if (
      binding.input.source === "data-market" &&
      (binding.assetId === null || binding.versionId === null || binding.manifestDigest === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "data-market bindings require assetId, versionId, and manifestDigest",
      });
    }
  });
export type ResolvedDataBinding = z.infer<typeof ResolvedDataBindingSchema>;

export function bindingRequiresRestrictedNoEgress(binding: ResolvedDataBinding): boolean {
  return (
    binding.assetKind === "licensed-material" ||
    (binding.egressPolicy === "deny" &&
      (binding.sensitivity === "restricted" || binding.sensitivity === "regulated"))
  );
}
