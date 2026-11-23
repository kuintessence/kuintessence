import { z } from "zod";
import { LicensePolicySchema } from "./software-governance";
import { SpackInstallBindingChangeSchema } from "./spack-install-bindings";
import {
  SpackMaterialBlobSchema,
  SpackMaterialDigestSchema,
  SpackMaterialPathSchema,
  SpackMaterialPublishSchema,
} from "./spack-materials";
import { RecipeCommitSchema, RecipeRepositoryNameSchema } from "./spack-repositories";

export const OFFLINE_DELIVERY_MAX_BYTES = 2 * 1024 ** 2;
export const SignedOfflineDeliverySchema = z.strictObject({
  format: z.literal("kq-signed-offline-delivery-v1"),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  payload: z.string().min(1).max(OFFLINE_DELIVERY_MAX_BYTES),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type SignedOfflineDelivery = z.infer<typeof SignedOfflineDeliverySchema>;
const item = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  dependsOn: z.array(z.string()).max(200).default([]),
};
// A repository reader can fetch published bytes without a per-download entitlement check.
const distributableBinaryLicense = LicensePolicySchema.extend({
  classification: z.enum(["open-source", "source-available", "proprietary"]),
  redistribution: z.literal("permitted"),
  acceptanceRequired: z.literal(false),
  providerEntitlements: LicensePolicySchema.shape.providerEntitlements.unwrap().length(0),
  consumerEntitlements: LicensePolicySchema.shape.consumerEntitlements.unwrap().length(0),
});
export const OfflineDeliverySchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    release: z.string().min(1).max(100),
    repository: RecipeRepositoryNameSchema,
    files: z
      .array(z.strictObject({ path: SpackMaterialPathSchema, blob: SpackMaterialBlobSchema }))
      .max(20000),
    items: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            ...item,
            kind: z.literal("recipe"),
            repository: RecipeRepositoryNameSchema,
            commit: RecipeCommitSchema,
            file: SpackMaterialPathSchema,
          }),
          z.strictObject({
            ...item,
            kind: z.literal("material"),
            release: SpackMaterialPublishSchema,
          }),
          z.strictObject({
            ...item,
            kind: z.literal("binding"),
            change: z.union([
              SpackInstallBindingChangeSchema,
              SpackInstallBindingChangeSchema.options[0].omit({ binding: true }).extend({
                action: z.literal("bind-imported"),
                materialItem: z.string().min(1).max(64),
              }),
            ]),
          }),
          z.strictObject({
            ...item,
            kind: z.literal("vendor-binary"),
            file: SpackMaterialPathSchema,
            licensePolicy: distributableBinaryLicense,
          }),
          z.strictObject({
            ...item,
            kind: z.literal("vendor-local"),
            mappingId: z.string().uuid(),
            licenseSubject: z.string().min(1).max(255),
            fingerprint: SpackMaterialDigestSchema,
          }),
          z.strictObject({
            ...item,
            kind: z.literal("buildcache"),
            archive: SpackMaterialPathSchema,
            metadata: SpackMaterialPathSchema,
            licensePolicy: distributableBinaryLicense,
          }),
          z.strictObject({ ...item, kind: z.literal("ecosystem"), file: SpackMaterialPathSchema }),
          z.strictObject({
            ...item,
            kind: z.literal("activate"),
            stagedItem: z.string(),
            expectedActiveReleaseId: z.string().uuid().nullable(),
          }),
        ]),
      )
      .min(1)
      .max(200),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    const files = new Set(plan.files.map((file) => file.path));
    if (
      files.size !== plan.files.length ||
      new Set(plan.files.map((file) => file.blob.digest)).size !== plan.files.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate delivery file path or digest" });
    }
    if (plan.files.reduce((sum, file) => sum + file.blob.size, 0) > 512 * 1024 ** 3)
      ctx.addIssue({ code: "custom", message: "Delivery exceeds 512 GiB" });
    for (const entry of plan.items) {
      if (ids.has(entry.id) || entry.dependsOn.some((id) => !ids.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "Items must have unique IDs and follow their dependencies",
        });
      if (
        (entry.kind === "recipe" || entry.kind === "ecosystem" || entry.kind === "vendor-binary") &&
        !files.has(entry.file)
      )
        ctx.addIssue({ code: "custom", message: "Missing delivery file" });
      if (
        entry.kind === "buildcache" &&
        (!files.has(entry.archive) ||
          !files.has(entry.metadata) ||
          entry.archive === entry.metadata)
      )
        ctx.addIssue({
          code: "custom",
          message: "Buildcache requires distinct archive and metadata files",
        });
      if (
        entry.kind === "vendor-local" &&
        (!plan.repository.startsWith("org/") ||
          plan.files.some((file) => file.blob.digest === entry.fingerprint))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Provider-local binaries require an organization repository and must stay outside delivery files",
        });
      if (
        entry.kind === "activate" &&
        (!entry.dependsOn.includes(entry.stagedItem) ||
          !plan.items.some((other) => other.id === entry.stagedItem && other.kind === "ecosystem"))
      )
        ctx.addIssue({ code: "custom", message: "Activation must depend on an ecosystem stage" });
      if (entry.kind === "binding" && entry.change.action === "bind-imported") {
        const change = entry.change;
        const material = plan.items.find(
          (other) => other.id === change.materialItem && other.kind === "material",
        );
        if (
          !entry.dependsOn.includes(change.materialItem) ||
          material?.kind !== "material" ||
          material.release.spec !== change.spec
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Imported binding must depend on a material item with the exact spec",
          });
        }
      }
      ids.add(entry.id);
    }
  });
export type OfflineDelivery = z.infer<typeof OfflineDeliverySchema>;
export type OfflineDeliveryItem = OfflineDelivery["items"][number];
export interface OfflineDeliveryResult {
  id: string;
  kind: OfflineDeliveryItem["kind"];
  status:
    | "planned"
    | "existing"
    | "missing"
    | "conflict"
    | "unsupported"
    | "failed"
    | "blocked"
    | "completed";
  code?: string;
  receipt?: unknown;
}
export interface OfflineDeliveryReport {
  signature?: { keyId: string; payloadSha256: string };
  digest: string;
  status: "planned" | "completed" | "partial" | "failed";
  items: OfflineDeliveryResult[];
}

export const FORGE_DELIVERY_GAPS = {
  code: "FORGE_SOURCE_CANDIDATE",
  artifactType: "application/vnd.kq.forge.bundle.v1",
  accepted: false,
  missing: [
    "complete-recipe-snapshot",
    "native-lock",
    "exact-spec-target-spack-version",
    "signed-ecosystem-release",
  ],
  conversion:
    "Export offline-delivery v1 from kq-bundles; recipes -> Git bundles, nativeLocks/sources -> material-pack, companions -> material v2 evidence, signed catalog -> ecosystem bundle. No solve/build/install is performed by Registry.",
} as const;
