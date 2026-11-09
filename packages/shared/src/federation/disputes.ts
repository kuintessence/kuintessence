import { z } from "zod";
import { FederationDigestSchema } from "./references";

export const CommercialDisputeSubjectSchema = z.strictObject({
  recordType: z.enum(["usage", "bill", "settlement", "adjustment", "payment"]),
  recordId: z.uuid(),
  recordDigest: FederationDigestSchema,
});
export const CommercialDisputeDraftSchema = z.strictObject({
  caseId: z.uuid(),
  subject: CommercialDisputeSubjectSchema,
  reason: z.string().trim().min(1).max(4096),
  requestedResolution: z.string().trim().min(1).max(4096),
});
/** An institutional allegation, not agreed evidence, arbitration authority or a financial award. */
export const CommercialDisputeSchema = z
  .strictObject({
    ...CommercialDisputeDraftSchema.shape,
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-dispute"),
    domainId: z.uuid(),
    agreementRevisionId: z.uuid(),
    agreementDigest: FederationDigestSchema,
    sourceSiteId: z.uuid(),
    targetSiteId: z.uuid(),
    openingSiteId: z.uuid(),
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(2147483647),
    issuedAt: z.iso.datetime(),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (v) =>
      v.sourceSiteId !== v.targetSiteId &&
      [v.sourceSiteId, v.targetSiteId].includes(v.openingSiteId),
    "Invalid dispute parties",
  );
export type CommercialDispute = z.infer<typeof CommercialDisputeSchema>;
export const CommercialDisputeStateSchema = z.enum([
  "FREEZE_PENDING",
  "DISPUTED",
  "EVIDENCE_WAITING",
  "DECIDED",
  "APPLICATION_WAITING",
  "RESOLVED",
]);
export type CommercialDisputeState = z.infer<typeof CommercialDisputeStateSchema>;
export const CommercialDisputeRecordSchema = z
  .object({
    localSiteId: z.uuid(),
    localOrgId: z.uuid(),
    agreementRevisionId: z.uuid(),
    caseId: z.uuid(),
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(2147483647),
    payload: CommercialDisputeSchema,
    digest: FederationDigestSchema,
    openingJws: z.string().min(1).max(524288),
    openedBy: z.uuid(),
    state: CommercialDisputeStateSchema,
    createdAt: z.iso.datetime(),
  })
  .refine(
    (v) =>
      v.caseId === v.payload.caseId &&
      v.agreementRevisionId === v.payload.agreementRevisionId &&
      v.taskId === v.payload.taskId &&
      v.attempt === v.payload.attempt &&
      [v.payload.sourceSiteId, v.payload.targetSiteId].includes(v.localSiteId),
    "Inconsistent dispute record",
  );
export const CommercialDisputeListSchema = z.object({
  data: CommercialDisputeRecordSchema.array(),
  hasMore: z.boolean(),
});
