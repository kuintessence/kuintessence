import { z } from "zod";

export const DEFAULT_USER_PLATFORM_RETENTION_DAYS = 365;
export const DEFAULT_PLATFORM_CLUSTER_RETENTION_DAYS = 180;

export const FileTransferDownloadEvidenceModeSchema = z.enum([
  "controlled_gateway",
  "direct_authorization_only",
]);
export type FileTransferDownloadEvidenceMode = z.infer<
  typeof FileTransferDownloadEvidenceModeSchema
>;

const RetentionDaysSchema = z.number().int().min(1).max(3650);

export const FileTransferAuditConfigUpdateSchema = z.object({
  userPlatformRetentionDays: RetentionDaysSchema,
  platformClusterRetentionDays: RetentionDaysSchema,
  downloadEvidenceMode: FileTransferDownloadEvidenceModeSchema,
  changeReason: z.string().trim().min(3).max(500),
});
export type FileTransferAuditConfigUpdate = z.infer<typeof FileTransferAuditConfigUpdateSchema>;

export const FileTransferAuditConfigViewSchema = FileTransferAuditConfigUpdateSchema.omit({
  changeReason: true,
}).extend({
  policyVersion: z.number().int().positive(),
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type FileTransferAuditConfigView = z.infer<typeof FileTransferAuditConfigViewSchema>;
