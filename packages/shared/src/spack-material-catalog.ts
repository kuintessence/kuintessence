import { z } from "zod";
import { type SpackMaterialBinding, SpackMaterialBindingSchema } from "./spack-materials";
import { RecipeRepositoryNameSchema } from "./spack-repositories";

export const SPACK_MATERIAL_CATALOG_MAX_RELEASES = 200;

const cursorSchema = z.string().regex(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);

export function spackMaterialCatalogPosition(binding: SpackMaterialBinding) {
  return `${binding.repositoryId}.${binding.manifestDigest.slice(7)}`;
}

export const SpackMaterialCatalogQuerySchema = z
  .strictObject({
    repository: RecipeRepositoryNameSchema.optional(),
    limit: z.number().int().min(1).max(SPACK_MATERIAL_CATALOG_MAX_RELEASES).optional(),
    after: cursorSchema.optional(),
  })
  .refine(
    (query) => !query.after || query.limit !== undefined,
    "A catalog cursor requires a page size",
  );
export type SpackMaterialCatalogQuery = z.infer<typeof SpackMaterialCatalogQuerySchema>;

export const SpackMaterialSummarySchema = SpackMaterialBindingSchema.extend({
  repository: RecipeRepositoryNameSchema,
  spec: z.string().trim().min(1).max(4096),
  spackVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  target: z.string().min(1).max(256),
  redistribution: z.literal("unrestricted"),
  sourceCount: z.number().int().min(1).max(10_000),
  totalBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 ** 3),
});
export type SpackMaterialSummary = z.infer<typeof SpackMaterialSummarySchema>;

export const SpackMaterialCatalogSchema = z.strictObject({
  nextCursor: cursorSchema.optional(),
  releases: z.array(SpackMaterialSummarySchema).max(SPACK_MATERIAL_CATALOG_MAX_RELEASES),
});
export type SpackMaterialCatalog = z.infer<typeof SpackMaterialCatalogSchema>;
