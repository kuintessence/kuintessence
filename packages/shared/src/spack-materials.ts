import { z } from "zod";
import {
  RecipeCommitSchema,
  RecipeRepositoryIdSchema,
  RecipeRepositoryNameSchema,
} from "./spack-repositories";

export const SpackMaterialDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SpackMaterialPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value
        .split("/")
        .every((part) => /^[a-zA-Z0-9_.+-]+$/.test(part) && ![".", "..", ".git"].includes(part)),
    "Use a relative path without traversal, escaping, or Git metadata",
  );
export const SpackMaterialBlobSchema = z.strictObject({
  digest: SpackMaterialDigestSchema,
  size: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 ** 3),
});
export type SpackMaterialBlob = z.infer<typeof SpackMaterialBlobSchema>;

export const SpackMaterialEvidenceSchema = z.strictObject({
  version: z.literal(1),
  materials: z
    .array(
      z.strictObject({
        subject: SpackMaterialBlobSchema,
        license: z.strictObject({
          expression: z.string().min(1).max(4096),
          status: z.enum(["pending", "approved", "rejected", "unknown"]),
        }),
        provenance: z
          .array(
            z.strictObject({
              origin: z.string().min(1).max(4096),
              original: SpackMaterialBlobSchema,
              evidence: SpackMaterialBlobSchema,
            }),
          )
          .min(1)
          .max(100),
        attachments: z
          .array(
            z.strictObject({
              path: SpackMaterialPathSchema,
              kind: z.enum(["license", "notice", "provenance", "conversion"]),
              blob: SpackMaterialBlobSchema,
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(10000),
});

const recipeSelection = {
  repositoryId: RecipeRepositoryIdSchema,
  commit: RecipeCommitSchema,
  roots: z
    .array(z.union([z.literal("."), SpackMaterialPathSchema]))
    .min(1)
    .max(32),
};
const releaseFields = {
  version: z.literal(1),
  repository: RecipeRepositoryNameSchema,
  spec: z.string().trim().min(1).max(4096),
  spackVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  target: z.string().min(1).max(256),
  // Restricted/vendor materials need their own license-grant integration before publication.
  redistribution: z.literal("unrestricted"),
  sources: z
    .array(
      z.strictObject({
        path: SpackMaterialPathSchema,
        blob: SpackMaterialBlobSchema,
      }),
    )
    .min(1)
    .max(10_000),
  lockfile: SpackMaterialBlobSchema,
};
const publishFields = {
  ...releaseFields,
  recipes: z.array(z.strictObject(recipeSelection)).min(1).max(32),
};
const manifestFields = {
  ...releaseFields,
  recipes: z
    .array(z.strictObject({ ...recipeSelection, archive: SpackMaterialBlobSchema }))
    .min(1)
    .max(32),
};
export const SpackMaterialPublishSchema = z
  .discriminatedUnion("version", [
    z.strictObject(publishFields),
    z.strictObject({
      ...publishFields,
      version: z.literal(2),
      evidence: SpackMaterialEvidenceSchema,
    }),
  ])
  .superRefine(validateSources)
  .superRefine(validateEvidence)
  .superRefine((value, ctx) => validateBlobSet(spackMaterialInputBlobs(value), ctx));
export type SpackMaterialPublish = z.infer<typeof SpackMaterialPublishSchema>;

export const SpackMaterialManifestSchema = z
  .discriminatedUnion("version", [
    z.strictObject(manifestFields),
    z.strictObject({
      ...manifestFields,
      version: z.literal(2),
      evidence: SpackMaterialEvidenceSchema,
    }),
  ])
  .superRefine(validateSources)
  .superRefine(validateEvidence)
  .superRefine((value, ctx) => validateBlobSet(spackMaterialBlobs(value), ctx));
export type SpackMaterialManifest = z.infer<typeof SpackMaterialManifestSchema>;

function validateEvidence(
  value: {
    sources: { blob: SpackMaterialBlob }[];
    evidence?: z.infer<typeof SpackMaterialEvidenceSchema>;
  },
  ctx: z.RefinementCtx,
) {
  if (!value.evidence) return;
  const sources = new Map(value.sources.map(({ blob }) => [blob.digest, blob.size]));
  const seen = new Set<string>();
  for (const material of value.evidence.materials) {
    if (
      seen.has(material.subject.digest) ||
      sources.get(material.subject.digest) !== material.subject.size
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Evidence subject must identify a unique source blob",
      });
    }
    seen.add(material.subject.digest);
    if (
      new Set(material.attachments.map((item) => item.path)).size !== material.attachments.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate evidence attachment path" });
    }
  }
  if (seen.size !== sources.size)
    ctx.addIssue({ code: "custom", message: "Evidence required for every source blob" });
}

export function spackMaterialInputBlobs(value: {
  lockfile: SpackMaterialBlob;
  sources: { blob: SpackMaterialBlob }[];
  evidence?: z.infer<typeof SpackMaterialEvidenceSchema>;
}): SpackMaterialBlob[] {
  return [
    value.lockfile,
    ...value.sources.map((source) => source.blob),
    ...(value.evidence?.materials.flatMap((material) => [
      ...material.provenance.flatMap((entry) => [entry.original, entry.evidence]),
      ...material.attachments.map((entry) => entry.blob),
    ]) ?? []),
  ];
}

function validateSources(
  value: { sources: { path: string; blob: SpackMaterialBlob }[] },
  ctx: z.RefinementCtx,
) {
  const paths = new Set<string>();
  let size = 0;
  for (const source of value.sources) {
    if (paths.has(source.path)) {
      ctx.addIssue({ code: "custom", message: "Duplicate source mirror path" });
    }
    paths.add(source.path);
    size += source.blob.size;
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join("/"))) {
        ctx.addIssue({ code: "custom", message: "Source mirror paths overlap" });
      }
    }
  }
  if (size > 512 * 1024 ** 3) {
    ctx.addIssue({ code: "custom", message: "Source material set exceeds 512 GiB" });
  }
}

function validateBlobSet(blobs: SpackMaterialBlob[], ctx: z.RefinementCtx) {
  const sizes = new Map<string, number>();
  for (const blob of blobs) {
    const existing = sizes.get(blob.digest);
    if (existing !== undefined && existing !== blob.size) {
      ctx.addIssue({ code: "custom", message: "A digest has conflicting declared sizes" });
    }
    sizes.set(blob.digest, blob.size);
  }
  if ([...sizes.values()].reduce((total, size) => total + size, 0) > 512 * 1024 ** 3) {
    ctx.addIssue({ code: "custom", message: "Material set exceeds 512 GiB" });
  }
}

export function spackMaterialBlobs(manifest: SpackMaterialManifest): SpackMaterialBlob[] {
  return [
    ...manifest.recipes.map((recipe) => recipe.archive),
    ...spackMaterialInputBlobs(manifest),
  ];
}

export const SpackMaterialBindingSchema = z.strictObject({
  repositoryId: RecipeRepositoryIdSchema,
  manifestDigest: SpackMaterialDigestSchema,
});
export type SpackMaterialBinding = z.infer<typeof SpackMaterialBindingSchema>;
