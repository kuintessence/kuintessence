import { z } from "zod";
import { SpackMaterialBindingSchema } from "./spack-materials";
import { RecipeRepositoryNameSchema } from "./spack-repositories";

export const SPACK_MATERIAL_CATALOG_MAX_RELEASES = 200;

export const SpackMaterialCatalogQuerySchema = z.strictObject({
  repository: RecipeRepositoryNameSchema.optional(),
});
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
  releases: z.array(SpackMaterialSummarySchema).max(SPACK_MATERIAL_CATALOG_MAX_RELEASES),
});
export type SpackMaterialCatalog = z.infer<typeof SpackMaterialCatalogSchema>;
