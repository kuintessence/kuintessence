import { z } from "zod";

export const ClusterFileRootIdSchema = z.string().uuid();
export const ClusterFileRootPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((path) => path.startsWith("/"), "Cluster file root path must be absolute");

export const ClusterFileRootCreateSchema = z.object({
  label: z.string().min(1).max(255),
  providerOrgId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(255).nullable().optional(),
  path: ClusterFileRootPathSchema,
  capacityBytes: z.number().int().positive().nullable().optional(),
  visibleOrgIds: z.array(z.string().uuid()).default([]),
  enabled: z.boolean().default(true),
});

export const ClusterFileRootUpdateSchema = ClusterFileRootCreateSchema.omit({
  providerOrgId: true,
}).partial();

export const ClusterFileRootViewSchema = ClusterFileRootCreateSchema.extend({
  id: ClusterFileRootIdSchema,
  providerOrgId: z.string().uuid(),
  agentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ClusterFileRootCheckStatusSchema = z.enum([
  "unavailable",
  "ok",
  "missing",
  "not_readable",
  "not_writable",
]);

export const ClusterFileRootCheckResponseSchema = z.object({
  rootId: ClusterFileRootIdSchema,
  path: ClusterFileRootPathSchema,
  agentId: z.string().nullable(),
  status: ClusterFileRootCheckStatusSchema,
  checkedAt: z.string(),
});

export type ClusterFileRootCreate = z.infer<typeof ClusterFileRootCreateSchema>;
export type ClusterFileRootUpdate = z.infer<typeof ClusterFileRootUpdateSchema>;
export type ClusterFileRootView = z.infer<typeof ClusterFileRootViewSchema>;
export type ClusterFileRootCheckStatus = z.infer<typeof ClusterFileRootCheckStatusSchema>;
export type ClusterFileRootCheckResponse = z.infer<typeof ClusterFileRootCheckResponseSchema>;
