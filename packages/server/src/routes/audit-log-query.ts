import { z } from "zod";

export const AuditLogQuerySchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    action: z.string().trim().max(200).default(""),
    actor: z.string().trim().max(255).default(""),
    target: z.string().trim().max(500).default(""),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    offset: z.coerce.number().int().min(0).max(2_000_000_000).default(0),
  })
  .refine(
    (q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to),
    "起始时间不能晚于结束时间",
  );

export function auditSearchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
