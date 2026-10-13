import { z } from "zod";
import { SpackMaterialBindingSchema } from "./spack-materials";

export const EcosystemMaterialRequirementSchema = z.strictObject({
  ecosystemKey: z.string().min(1).max(255),
  binding: SpackMaterialBindingSchema,
  spec: z.string().min(1).max(4096),
  target: z.string().min(1).max(256),
  spackVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type EcosystemMaterialRequirement = z.infer<typeof EcosystemMaterialRequirementSchema>;
