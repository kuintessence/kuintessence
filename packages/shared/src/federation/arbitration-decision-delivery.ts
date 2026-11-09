import { z } from "zod";
import {
  type ArbitrationDecision,
  type ArbitrationDecisionBasis,
  ArbitrationDecisionBasisSchema,
  ArbitrationDecisionSchema,
} from "./arbitration-decision";
import { FederationDigestSchema } from "./references";

const identity = {
  protocolVersion: z.literal(1),
  deliveryId: z.uuid(),
  issuerSiteId: z.uuid(),
  receivingSiteId: z.uuid(),
  decisionId: z.uuid(),
  caseId: z.uuid(),
  decisionDigest: FederationDigestSchema,
};
/** A fresh transport attestation carries an unchanged historical decision, not a new authority. */
export const ArbitrationDecisionDeliverySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-decision-delivery"),
    decision: ArbitrationDecisionSchema,
    decisionJws: z.string().min(1).max(524288),
    contexts: ArbitrationDecisionBasisSchema.shape.contexts,
    evidenceAuthorizations: ArbitrationDecisionBasisSchema.shape.evidence.element
      .omit({ evidence: true })
      .array()
      .max(64),
    issuedAt: z.iso.datetime(),
  })
  .refine(
    (v) =>
      v.issuerSiteId === v.decision.intent.binding.arbitratorSiteId &&
      [v.decision.intent.binding.sourceSiteId, v.decision.intent.binding.targetSiteId].includes(
        v.receivingSiteId,
      ) &&
      v.issuerSiteId !== v.receivingSiteId &&
      v.decisionId === v.decision.intent.decisionId &&
      v.caseId === v.decision.intent.binding.caseId &&
      Date.parse(v.issuedAt) >= Date.parse(v.decision.issuedAt),
  );
export type ArbitrationDecisionDelivery = z.infer<typeof ArbitrationDecisionDeliverySchema>;
/** Acknowledges durable receipt only. No current execution permit, debit or case closure. */
export const ArbitrationDecisionReceiptSchema = z
  .strictObject({
    ...identity,
    kind: z.literal("arbitration-decision-receipt"),
    recordedAt: z.iso.datetime(),
  })
  .refine((v) => v.issuerSiteId !== v.receivingSiteId);
export type ArbitrationDecisionReceipt = z.infer<typeof ArbitrationDecisionReceiptSchema>;

export function arbitrationDecisionDeliveryPayload(
  record: {
    payload: ArbitrationDecision;
    basis: ArbitrationDecisionBasis;
    approvalJws: string;
    digest: string;
  },
  deliveryId: string,
  receivingSiteId: string,
  issuedAt: string,
) {
  return ArbitrationDecisionDeliverySchema.parse({
    protocolVersion: 1,
    kind: "arbitration-decision-delivery",
    deliveryId,
    issuerSiteId: record.payload.intent.binding.arbitratorSiteId,
    receivingSiteId,
    decisionId: record.payload.intent.decisionId,
    caseId: record.payload.intent.binding.caseId,
    decisionDigest: record.digest,
    decision: record.payload,
    decisionJws: record.approvalJws,
    contexts: record.basis.contexts,
    evidenceAuthorizations: record.basis.evidence.map(({ scope, readId, authorizations }) => ({
      scope,
      readId,
      authorizations,
    })),
    issuedAt,
  });
}
