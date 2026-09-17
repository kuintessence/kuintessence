import { z } from "zod";

export const AuditEntrySchema = z
  .object({
    id: z.string(),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const AuditLogResponseSchema = z
  .object({
    entries: z.array(AuditEntrySchema),
  })
  .passthrough();

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;
