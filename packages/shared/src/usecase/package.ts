import { z } from "zod";
import {
  DataAccessModeSchema,
  DataAssetKindSchema,
  DataDeliveryPolicySchema,
  DataRequirementsSchema,
  DataSensitivitySchema,
} from "../data-market";
import { LicenseRequirementSchema } from "../software-governance";
import { ValueOutputSchema } from "../workflow-dsl/extract";
import { AssetSelectorSchema } from "../workflow-dsl/refs";

/**
 * Structured usecase/software package, the stored form a
 * SoftwareUsecaseComputing node resolves to. Defines the capability-layer
 * model in Zod; the inferred type is structurally
 * compatible with the `materialize()` input and the executor's ResolvedPackage,
 * so a parsed package feeds materialization directly. registry validates
 * and stores this; the engine's resolvePackage returns it.
 */

const SoftwareSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("Spack"),
    name: z.string(),
    version: z.string().optional(),
    compiler: z.string().optional(),
    moduleName: z.string().optional(),
    variantRef: z.string().optional(),
    argumentList: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal("Singularity"), image: z.string(), tag: z.string() }),
  z.strictObject({ kind: z.literal("Bare") }),
]);

const MaterialRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ArgRef"), descriptor: z.string(), sort: z.number().int() }),
  z.strictObject({ kind: z.literal("EnvRef"), descriptor: z.string() }),
  z.strictObject({ kind: z.literal("FileInputRef"), descriptor: z.string() }),
  z.strictObject({ kind: z.literal("StdinRef"), descriptor: z.string() }),
]);

const UsecaseInputSlotSchema = z.strictObject({
  kind: z.enum(["Text", "File"]),
  descriptor: z.string(),
  refMaterials: z.array(MaterialRefSchema),
});

const ArgumentMaterialSchema = z.strictObject({
  descriptor: z.string(),
  valueFormat: z.string().default("{}"),
});

const EnvironmentMaterialSchema = z.strictObject({
  descriptor: z.string(),
  key: z.string(),
  valueFormat: z.string().default("{}"),
});

const FileKindSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("Normal"), name: z.string() }),
  z.strictObject({ kind: z.literal("Batched"), pattern: z.string() }),
]);

const FilesomeInputMaterialSchema = z.strictObject({
  descriptor: z.string(),
  fileKind: FileKindSchema,
});

const FilesomeOutputMaterialSchema = z.strictObject({
  descriptor: z.string(),
  fileKind: FileKindSchema,
});

export const MaterializationPackageSchema = z.strictObject({
  usecase: z.strictObject({
    commandFile: z.string(),
    inputSlots: z.array(UsecaseInputSlotSchema),
  }),
  software: SoftwareSpecSchema,
  arguments: z.array(ArgumentMaterialSchema).default([]),
  environments: z.array(EnvironmentMaterialSchema).default([]),
  filesomeInputs: z.array(FilesomeInputMaterialSchema).default([]),
  filesomeOutputs: z.array(FilesomeOutputMaterialSchema).default([]),
  valueOutputs: z.array(ValueOutputSchema).default([]),
});

const TypedUsecaseValueSchema = z.enum([
  "String",
  "Integer",
  "Number",
  "Boolean",
  "Enum",
  "File",
  "FileBatch",
  "Dataset",
]);

export const DataAssetSelectorSchema = z.strictObject({
  kind: DataAssetKindSchema,
  selector: z.string().min(1).max(255),
  version: z.string().min(1).max(100).optional(),
});
export type DataAssetSelector = z.infer<typeof DataAssetSelectorSchema>;

export const DatasetDataRequirementsSchema = DataRequirementsSchema.extend({
  dataAssets: z.array(DataAssetSelectorSchema).default([]),
  allowUserPrivate: z.boolean().default(false),
});
export type DatasetDataRequirements = z.infer<typeof DatasetDataRequirementsSchema>;

export const DataAssetRequirementSchema = z.strictObject({
  asset: DataAssetSelectorSchema,
  targetPath: z
    .string()
    .min(1)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes("..")),
  accessMode: DataAccessModeSchema.default("open"),
  maxSensitivity: DataSensitivitySchema.optional(),
  deliveryPolicy: DataDeliveryPolicySchema.default({
    download: "deny",
    derive: "deny",
    redistribution: "deny",
    crossCenterReplication: "deny",
    retention: "source-controlled",
  }),
  entitlementRequired: z.boolean().default(false),
  allowUserPrivate: z.boolean().default(false),
});
export type DataAssetRequirement = z.infer<typeof DataAssetRequirementSchema>;

const TypedUsecaseInputSchema = z
  .strictObject({
    descriptor: z.string().min(1),
    type: TypedUsecaseValueSchema,
    required: z.boolean().default(true),
    default: z.unknown().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    pattern: z.string().optional(),
    enum: z.array(z.string().min(1)).min(1).optional(),
    dataRequirements: DatasetDataRequirementsSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.minimum !== undefined &&
      input.maximum !== undefined &&
      input.minimum > input.maximum
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "minimum must not exceed maximum",
      });
    }
    if (input.type === "Enum" && input.enum === undefined) {
      ctx.addIssue({ code: "custom", path: ["enum"], message: "Enum inputs require enum values" });
    }
    if (input.type !== "Dataset" && input.dataRequirements !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dataRequirements"],
        message: "dataRequirements are only valid for Dataset inputs",
      });
    }
  });

const TypedUsecaseOutputSchema = z.strictObject({
  descriptor: z.string().min(1),
  type: TypedUsecaseValueSchema,
  validators: z.array(z.unknown()).default([]),
});

const UsecaseMaterialMappingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("argv"),
    descriptor: z.string().min(1),
    template: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("env"),
    descriptor: z.string().min(1),
    key: z.string().min(1),
    template: z.string().default("{}"),
  }),
  z.strictObject({ kind: z.literal("stdin"), descriptor: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("file"),
    descriptor: z.string().min(1),
    path: z.string().min(1),
    direction: z.enum(["input", "output"]),
  }),
]);

const LicensedMaterialSelectorSchema = z.strictObject({
  selector: z.string().min(1).max(255),
  licenseSubject: z.string().min(1).max(255),
  targetPath: z
    .string()
    .min(1)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes("..")),
  requiredElements: z.array(z.string().min(1).max(8)).default([]),
});

/**
 * Governed packages combine executable materialization fields, metadata
 * and a typed user-facing I/O contract.
 */
export const GovernedUsecasePackageSchema = MaterializationPackageSchema.extend({
  description: z.string().min(1),
  domain: z.string().min(1),
  tags: z.array(z.string().min(1)),
  citations: z.array(z.strictObject({ title: z.string().min(1), url: z.string().url() })),
  softwareRef: AssetSelectorSchema,
  inputs: z.array(TypedUsecaseInputSchema),
  outputs: z.array(TypedUsecaseOutputSchema),
  resources: z.strictObject({
    cpu: z.number().int().positive().optional(),
    memoryMiB: z.number().int().positive().optional(),
    gpus: z.number().int().nonnegative().optional(),
    walltimeSeconds: z.number().int().positive().optional(),
  }),
  materialMappings: z.array(UsecaseMaterialMappingSchema),
  dataRequirements: z.array(DataAssetRequirementSchema).default([]),
  licensedMaterials: z.array(LicensedMaterialSelectorSchema).default([]),
  licenseRequirements: z.array(LicenseRequirementSchema),
});

export const UsecasePackageSchema = z.union([
  MaterializationPackageSchema,
  GovernedUsecasePackageSchema,
]);
export type MaterializationPackage = z.infer<typeof MaterializationPackageSchema>;
export type GovernedUsecasePackage = z.infer<typeof GovernedUsecasePackageSchema>;
export type UsecasePackage = z.infer<typeof UsecasePackageSchema>;

/**
 * Legacy packages retain `licensedMaterials` on disk. Convert that selector-only
 * declaration into Data Market metadata without inventing a location or bytes.
 */
export function legacyLicensedMaterialsToDataRequirements(
  licensedMaterials: Array<{
    selector: string;
    targetPath: string;
    requiredElements?: string[];
    licenseSubject?: string;
  }>,
): DataAssetRequirement[] {
  return licensedMaterials.map((material) => ({
    asset: {
      kind: "licensed-material",
      selector: material.selector,
    },
    targetPath: material.targetPath,
    accessMode: "entitlement",
    maxSensitivity: "restricted",
    deliveryPolicy: {
      download: "deny",
      derive: "deny",
      redistribution: "deny",
      crossCenterReplication: "deny",
      retention: "source-controlled",
    },
    entitlementRequired: true,
    allowUserPrivate: false,
  }));
}

/** Create payload for storing a usecase package (registry API + service). */
export const UsecasePackageCreateSchema = z.strictObject({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(50),
  description: z.string().optional(),
  spec: UsecasePackageSchema,
});
export type UsecasePackageCreate = z.infer<typeof UsecasePackageCreateSchema>;

export const UsecasePackageUpdateSchema = UsecasePackageCreateSchema;
export type UsecasePackageUpdate = z.infer<typeof UsecasePackageUpdateSchema>;
