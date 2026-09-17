import { z } from "zod";
import { SlugSchema, UuidSchema } from "./common";
import { ValueTypeSchema } from "./expr";
import { WorkflowSpecSchema } from "./node";

/** Workflow-level input parameter (referenced by expressions via `params.<name>`). */
export const ParameterSchema = z.strictObject({
  name: SlugSchema,
  type: ValueTypeSchema,
  default: z.unknown().optional(),
  required: z.boolean().default(false),
  description: z.string().nullish(),
});
export type Parameter = z.infer<typeof ParameterSchema>;

/** Creation-time advanced switches (D7a). */
export const AdvancedSchema = z.strictObject({
  skipStaticValidation: z.boolean().default(false),
});
export type Advanced = z.infer<typeof AdvancedSchema>;

/** Top-level workflow document. */
export const WorkflowSchema = z.strictObject({
  id: UuidSchema.optional(),
  name: z.string().min(1),
  description: z.string().nullish(),
  logo: z.string().nullish(),
  parameters: z.array(ParameterSchema).default([]),
  advanced: AdvancedSchema.optional(),
  spec: WorkflowSpecSchema,
});
export type Workflow = z.infer<typeof WorkflowSchema>;
