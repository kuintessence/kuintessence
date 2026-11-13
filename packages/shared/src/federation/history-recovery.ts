import { z } from "zod";
import { FederationDigestSchema } from "./references";

/** Current parties acknowledge an archived fact; this is never renewed execution authority. */
export const CommercialHistoryRecoverySchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-history-recovery"),
    recoveryId: z.uuid(),
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    mode: z.literal("bilateral_attested"),
    assertion: z.literal("acknowledge-original-record"),
    originalOperation: z.enum([
      "register-agreement",
      "record-usage",
      "record-discount",
      "confirm-bill",
      "settle-bill",
      "adjust-settlement",
      "record-refund",
      "record-payment",
      "record-dispute-freeze",
      "record-dispute-resolution",
      "record-arbitration-resolution",
    ]),
    originalRecordId: z.uuid(),
    originalDigest: FederationDigestSchema,
    originalInputDigest: FederationDigestSchema,
    reason: z.string().trim().min(1).max(4096),
    issuedAt: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.sourceSiteId !== value.targetSiteId, "Distinct institutions required");
export type CommercialHistoryRecovery = z.infer<typeof CommercialHistoryRecoverySchema>;
export const CommercialHistoryApprovalSnapshotSchema = z.strictObject({
  approvalJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).nullable(),
  recordedAt: z.iso.datetime(),
  approvedBy: z.uuid(),
  transactionId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type CommercialHistoryApprovalSnapshot = z.infer<
  typeof CommercialHistoryApprovalSnapshotSchema
>;
export const CommercialHistoryRecoveryFileSchema = z.strictObject({
  payload: CommercialHistoryRecoverySchema,
  jws: z.string().min(1).max(524288),
  originalInput: z.string().min(1).max(524288),
});

export const CommercialHistoryEnvelopeSchema = z.strictObject({
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  sourceJws: z.string().min(1).max(524288),
  targetJws: z.string().min(1).max(524288),
  originalInput: z.string().min(1).max(524288),
});

export const CommercialHistoryRecoveryViewSchema = z.strictObject({
  payload: CommercialHistoryRecoverySchema,
  digest: FederationDigestSchema,
  approvalJws: z.string().min(1).max(524288),
  originalInput: z.string().min(1).max(524288),
  counterpartyApproved: z.boolean(),
  approvalHistoryCount: z.number().int().nonnegative(),
  canReauthorize: z.boolean().default(false),
  original: z.strictObject({
    id: z.uuid(),
    operation: z.string(),
    recordId: z.uuid(),
    digest: FederationDigestSchema,
    state: z.enum(["pending", "committed", "needs_review", "closed"]),
    archiveOnly: z.boolean(),
  }),
  ledger: z
    .strictObject({
      id: z.uuid(),
      state: z.enum(["pending", "committed", "needs_review", "closed"]),
      lastError: z.string().nullable(),
      transactionId: z.string().nullable(),
      blockNumber: z.string().nullable(),
    })
    .nullable(),
});
