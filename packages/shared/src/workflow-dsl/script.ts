import { z } from "zod";
import { UuidSchema } from "./common";
import { AssetSelectorSchema } from "./refs";

export const SandboxLanguageSchema = z.enum(["python", "nodejs", "bash"]);
export type SandboxLanguage = z.infer<typeof SandboxLanguageSchema>;

export const ScriptIoTypeSchema = z.enum(["Text", "JSON", "File", "FileBatch"]);
export type ScriptIoType = z.infer<typeof ScriptIoTypeSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest");

export const ScriptSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("AssetRevision"),
    assetId: UuidSchema,
    assetRevisionId: UuidSchema.optional(),
    revision: z.number().int().positive(),
    sha256: Sha256Schema,
  }),
  z.strictObject({
    type: z.literal("Inline"),
    language: SandboxLanguageSchema,
    content: z.string(),
  }),
]);
export type ScriptSource = z.infer<typeof ScriptSourceSchema>;

export const ExecutionIdentitySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Inherit") }),
  z.strictObject({ type: z.literal("SharedService") }),
  z.strictObject({ type: z.literal("MappedAuto") }),
  z.strictObject({ type: z.literal("MappedAccount"), mappingId: UuidSchema }),
]);
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export const ScriptInputSpecSchema = z.strictObject({
  type: ScriptIoTypeSchema,
  required: z.boolean().default(true),
});
export type ScriptInputSpec = z.infer<typeof ScriptInputSpecSchema>;

export const OutputLocalitySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Auto") }),
  z.strictObject({ type: z.literal("FollowInput"), input: z.string().min(1) }),
  z.strictObject({ type: z.literal("FollowConsumer") }),
  z.strictObject({ type: z.literal("TargetSite"), siteId: z.string().min(1) }),
  z.strictObject({ type: z.literal("TargetStorage"), storageId: z.string().min(1) }),
]);
export type OutputLocality = z.infer<typeof OutputLocalitySchema>;

export const ArtifactDurabilitySchema = z.enum(["Ephemeral", "Checkpoint", "Persistent"]);
export type ArtifactDurability = z.infer<typeof ArtifactDurabilitySchema>;

export const OutputSizeHintSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("FixedBytes"), bytes: z.number().int().nonnegative() }),
  z.strictObject({
    type: z.literal("InputRatio"),
    input: z.string().min(1),
    ratio: z.number().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("SizeClass"),
    value: z.enum(["Tiny", "Small", "Medium", "Large", "Huge", "Unknown"]),
  }),
]);
export type OutputSizeHint = z.infer<typeof OutputSizeHintSchema>;

export const ScriptOutputSpecSchema = z.strictObject({
  type: ScriptIoTypeSchema,
  required: z.boolean().default(true),
  validator: z.unknown().nullish(),
  locality: OutputLocalitySchema.default({ type: "Auto" }),
  durability: ArtifactDurabilitySchema.default("Ephemeral"),
  sizeHint: OutputSizeHintSchema.default({ type: "SizeClass", value: "Unknown" }),
});
export type ScriptOutputSpec = z.infer<typeof ScriptOutputSpecSchema>;

export const PlacementConstraintSchema = z.strictObject({
  mode: z.enum(["Require", "Prefer"]).default("Prefer"),
  siteIds: z.array(z.string().min(1)).default([]),
  clusterIds: z.array(z.string().min(1)).default([]),
  dataMovement: z.enum(["Allow", "Forbid"]).default("Allow"),
});
export type PlacementConstraint = z.infer<typeof PlacementConstraintSchema>;

/** Script origins used by the Reduce Command reducer. */
export const ScriptOriginKindSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Git"), url: z.string() }),
  z.strictObject({ type: z.literal("Edit"), content: z.string() }),
]);
export type ScriptOriginKind = z.infer<typeof ScriptOriginKindSchema>;

export const UsecaseRefSchema = z.strictObject({
  usecaseVersionId: UuidSchema,
  softwareVersionId: UuidSchema,
});
export type UsecaseRef = z.infer<typeof UsecaseRefSchema>;

/** Logical runtime requirements are bound to a signed profile by a CP at dispatch time. */
export const SandboxRuntimeContractRefSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type SandboxRuntimeContractRef = z.infer<typeof SandboxRuntimeContractRefSchema>;

export const ScriptRefSchema = AssetSelectorSchema;
export type ScriptRef = z.infer<typeof ScriptRefSchema>;
