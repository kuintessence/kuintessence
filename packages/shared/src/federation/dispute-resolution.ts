import { z } from "zod";
import { CommercialAdjustmentSchema, CommercialSettlementSchema } from "./commercial";
import { FederationDigestSchema } from "./references";

/** A new bilateral agreement after permanent withdrawal; never an R award or a payment. */
export const CommercialDisputeResolutionSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-dispute-resolution"),
    resolutionId: z.uuid(),
    caseId: z.uuid(),
    caseDigest: FederationDigestSchema,
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(2147483647),
    mode: z.enum(["bilateral_direct", "bilateral_attested"]),
    decisionId: z.uuid(),
    withdrawalDigest: FederationDigestSchema,
    headDigest: FederationDigestSchema,
    financial: z.union([CommercialSettlementSchema, CommercialAdjustmentSchema]).nullable(),
    reason: z.string().trim().min(1).max(4096),
    issuedAt: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (v) =>
      v.sourceSiteId !== v.targetSiteId &&
      (!v.financial ||
        (v.financial.domainId === v.domainId &&
          v.financial.agreementRevisionId === v.agreementRevisionId &&
          v.financial.sourceSiteId === v.sourceSiteId &&
          v.financial.targetSiteId === v.targetSiteId)),
    "Inconsistent settlement parties",
  );
export type CommercialDisputeResolution = z.infer<typeof CommercialDisputeResolutionSchema>;

export const CommercialDisputeResolutionViewSchema = z.object({
  payload: CommercialDisputeResolutionSchema,
  digest: FederationDigestSchema,
  counterpartyApproved: z.boolean(),
  appliedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  financialApproved: z.boolean(),
  financialAppliedAt: z.iso.datetime().nullable(),
  exchange: z
    .object({
      state: z.enum(["pending", "complete", "needs_review"]),
      lastError: z.string().nullable(),
    })
    .nullable(),
  ledger: z
    .object({
      id: z.uuid(),
      state: z.enum(["pending", "committed", "needs_review"]),
      lastError: z.string().nullable(),
      transactionId: z.string().nullable(),
      blockNumber: z.string().nullable(),
    })
    .nullable(),
});
export type CommercialDisputeResolutionView = z.infer<typeof CommercialDisputeResolutionViewSchema>;
