import { z } from "zod";

export const TransferStateEnum = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const TransferDirectionEnum = z.enum(["cloud_to_cluster", "cluster_to_cloud"]);

const POSIX_KEY = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9._/-]+$/, "Must be a POSIX-safe path");

export const CloudObjectCreateSchema = z.object({
  key: POSIX_KEY,
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(255).default("application/octet-stream"),
});

export const CloudObjectRenameSchema = z.object({
  key: POSIX_KEY,
});

export const CloudObjectSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  key: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  etag: z.string(),
  uploadUrl: z.string().optional(),
  canUse: z.boolean().optional(),
  canDelete: z.boolean().optional(),
});

export const ClusterEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["dir", "file"]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string(),
});

export const TransferCreateSchema = z.object({
  direction: TransferDirectionEnum,
  source: z.string().min(1).max(2048),
  target: z.string().min(1).max(2048),
  sourceFileId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(255).optional(),
  siteId: z.string().min(1).max(255).optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  jobId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  netdriveFileIds: z.array(z.string().uuid()).optional(),
});

export const TransferSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  direction: TransferDirectionEnum,
  source: z.string(),
  target: z.string(),
  sourceFileId: z.string().uuid().optional(),
  agentId: z.string().nullable().optional(),
  siteId: z.string().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  copiedBytes: z.number().int().nonnegative(),
  state: TransferStateEnum,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  clusterRootId: z.string().uuid().nullable().optional(),
  clusterRootRevision: z.string().nullable().optional(),
  rootPolicyChangedAt: z.string().nullable().optional(),
  jobId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  netdriveFileIds: z.array(z.string().uuid()).optional(),
});

export type TransferState = z.infer<typeof TransferStateEnum>;
export type TransferDirection = z.infer<typeof TransferDirectionEnum>;
export type CloudObjectCreate = z.infer<typeof CloudObjectCreateSchema>;
export type CloudObjectRename = z.infer<typeof CloudObjectRenameSchema>;
export type CloudObject = z.infer<typeof CloudObjectSchema>;
export type ClusterEntry = z.infer<typeof ClusterEntrySchema>;
export type TransferCreate = z.infer<typeof TransferCreateSchema>;
export type Transfer = z.infer<typeof TransferSchema>;
