import { z } from "zod";

export const StorageScopeSchema = z.enum(["cloud", "cluster_root"]);
export const StorageQuotaRequestModeSchema = z.enum(["auto", "manual", "disabled"]);
export const StorageQuotaRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
]);

export const StorageQuotaPolicyInputSchema = z
  .object({
    scope: StorageScopeSchema,
    scopeId: z.string().min(1).max(255).default("global"),
    providerOrgId: z.string().uuid().nullable().optional(),
    defaultQuotaBytes: z.number().int().min(0),
    maxQuotaBytes: z.number().int().positive().nullable().optional(),
    requestMode: StorageQuotaRequestModeSchema,
    autoApproveLimitBytes: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "cloud" && value.scopeId !== "global") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "Cloud storage scopeId must be global",
      });
    }
    if (value.maxQuotaBytes != null && value.defaultQuotaBytes > value.maxQuotaBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultQuotaBytes"],
        message: "Default quota cannot exceed the maximum quota",
      });
    }
    if (
      value.maxQuotaBytes != null &&
      value.autoApproveLimitBytes != null &&
      value.autoApproveLimitBytes > value.maxQuotaBytes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoApproveLimitBytes"],
        message: "Automatic approval limit cannot exceed the maximum quota",
      });
    }
  });

export const StorageQuotaRequestCreateSchema = z
  .object({
    scope: StorageScopeSchema,
    scopeId: z.string().min(1).max(255).default("global"),
    requestedQuotaBytes: z.number().int().positive(),
    requestedExpiresAt: z.string().datetime().nullable().optional(),
    reason: z.string().trim().min(1).max(2000),
  })
  .superRefine(validateScopeReference);

export const StorageQuotaRequestDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2000).default(""),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const StorageQuotaGrantCreateSchema = z
  .object({
    userId: z.string().uuid(),
    scope: StorageScopeSchema,
    scopeId: z.string().min(1).max(255).default("global"),
    quotaBytes: z.number().int().positive(),
    expiresAt: z.string().datetime().nullable().optional(),
    note: z.string().trim().max(2000).default(""),
  })
  .superRefine(validateScopeReference);

export type StorageScope = z.infer<typeof StorageScopeSchema>;
export type StorageQuotaRequestMode = z.infer<typeof StorageQuotaRequestModeSchema>;
export type StorageQuotaRequestStatus = z.infer<typeof StorageQuotaRequestStatusSchema>;
export type StorageQuotaPolicyInput = z.infer<typeof StorageQuotaPolicyInputSchema>;
export type StorageQuotaRequestCreate = z.infer<typeof StorageQuotaRequestCreateSchema>;
export type StorageQuotaRequestDecision = z.infer<typeof StorageQuotaRequestDecisionSchema>;
export type StorageQuotaGrantCreate = z.infer<typeof StorageQuotaGrantCreateSchema>;

export interface StorageQuotaSummary {
  scope: StorageScope;
  scopeId: string;
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  usagePercent: number;
  fileCount: number;
  uploadedBytes30d: number;
  downloadedBytes30d: number;
  storedByteHours30d: number;
  policy: {
    defaultQuotaBytes: number;
    maxQuotaBytes: number | null;
    requestMode: StorageQuotaRequestMode;
    autoApproveLimitBytes: number | null;
  };
  activeGrant: {
    quotaBytes: number;
    expiresAt: string | null;
    source: string;
  } | null;
}

export interface CloudStorageOverview {
  usedBytes: number;
  fileCount: number;
  uploadedBytes30d: number;
  downloadedBytes30d: number;
  storedByteHours30d: number;
  activeGrantCount: number;
  pendingRequestCount: number;
}

function validateScopeReference(
  value: { scope: "cloud" | "cluster_root"; scopeId: string },
  ctx: z.RefinementCtx,
): void {
  if (value.scope === "cloud" && value.scopeId !== "global") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scopeId"],
      message: "Cloud storage scopeId must be global",
    });
  }
}
