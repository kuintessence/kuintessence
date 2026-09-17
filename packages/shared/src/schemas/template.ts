import { z } from "zod";

export const SpecKindEnum = z.enum(["spack", "oci", "module"]);

export const AppTemplateCreateSchema = z.object({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(50),
  description: z.string().optional(),
  spec: z.string().min(1).max(500),
  specKind: SpecKindEnum,
  tags: z.array(z.string()).optional(),
});

export const WorkflowTemplateCreateSchema = z.object({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(50),
  description: z.string().optional(),
  yamlContent: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export const AppTemplateUpdateSchema = AppTemplateCreateSchema;
export const WorkflowTemplateUpdateSchema = WorkflowTemplateCreateSchema;

export type SpecKind = z.infer<typeof SpecKindEnum>;
export type AppTemplateCreate = z.infer<typeof AppTemplateCreateSchema>;
export type AppTemplateUpdate = z.infer<typeof AppTemplateUpdateSchema>;
export type WorkflowTemplateCreate = z.infer<typeof WorkflowTemplateCreateSchema>;
export type WorkflowTemplateUpdate = z.infer<typeof WorkflowTemplateUpdateSchema>;
