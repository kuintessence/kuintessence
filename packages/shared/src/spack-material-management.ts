import { z } from "zod";
import { SpackMaterialSummarySchema } from "./spack-material-catalog";
import { RecipeRepositoryNameSchema } from "./spack-repositories";

export const SPACK_MATERIAL_MANAGEMENT_MAX_PAGE = 20;
export const SpackMaterialManagementCursorSchema = z.string().regex(/^v1\.[A-Za-z0-9_-]{40,512}$/);

export const SpackMaterialManagementQuerySchema = z.strictObject({
  repository: RecipeRepositoryNameSchema,
  state: z.enum(["all", "available", "withdrawn"]).default("all"),
  after: SpackMaterialManagementCursorSchema.optional(),
  limit: z.number().int().min(1).max(SPACK_MATERIAL_MANAGEMENT_MAX_PAGE).default(10),
});
export type SpackMaterialManagementQuery = z.infer<typeof SpackMaterialManagementQuerySchema>;

export const SpackMaterialManagementSummarySchema = SpackMaterialSummarySchema.extend({
  state: z.enum(["available", "withdrawn"]),
  revision: z.number().int().min(0).max(2_147_483_647),
}).refine((value) => value.revision !== 0 || value.state === "available");

export const SpackMaterialManagementCatalogSchema = z.strictObject({
  releases: z.array(SpackMaterialManagementSummarySchema).max(SPACK_MATERIAL_MANAGEMENT_MAX_PAGE),
  nextCursor: SpackMaterialManagementCursorSchema.nullable(),
});
export type SpackMaterialManagementCatalog = z.infer<typeof SpackMaterialManagementCatalogSchema>;
