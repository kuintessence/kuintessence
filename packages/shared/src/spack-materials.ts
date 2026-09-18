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
export const SpackMaterialPublishSchema = z
  .strictObject({
    ...releaseFields,
    recipes: z.array(z.strictObject(recipeSelection)).min(1).max(32),
  })
  .superRefine(validateSources)
  .superRefine((value, ctx) =>
    validateBlobSet([value.lockfile, ...value.sources.map((source) => source.blob)], ctx),
  );
export type SpackMaterialPublish = z.infer<typeof SpackMaterialPublishSchema>;

export const SpackMaterialManifestSchema = z
  .strictObject({
    ...releaseFields,
    recipes: z
      .array(z.strictObject({ ...recipeSelection, archive: SpackMaterialBlobSchema }))
      .min(1)
      .max(32),
  })
  .superRefine(validateSources)
  .superRefine((value, ctx) =>
    validateBlobSet(
      [
        value.lockfile,
        ...value.sources.map((source) => source.blob),
        ...value.recipes.map((recipe) => recipe.archive),
      ],
      ctx,
    ),
  );
export type SpackMaterialManifest = z.infer<typeof SpackMaterialManifestSchema>;

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
    manifest.lockfile,
    ...manifest.sources.map((source) => source.blob),
  ];
}

export const SpackMaterialBindingSchema = z.strictObject({
  repositoryId: RecipeRepositoryIdSchema,
  manifestDigest: SpackMaterialDigestSchema,
});
export type SpackMaterialBinding = z.infer<typeof SpackMaterialBindingSchema>;
