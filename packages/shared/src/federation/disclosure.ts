import { z } from "zod";
import {
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialPaymentSchema,
  CommercialSettlementSchema,
  CommercialUsageSchema,
} from "./commercial";
import { FederationError } from "./errors";
import { FederationDigestSchema } from "./references";

// Each array is one explicit disclosure group, never an implicit part of a total amount.
const fields = {
  agreement: z.strictObject({
    consideration: CommercialAgreementSchema.shape.consideration,
    unit: CommercialAgreementSchema.shape.agreement.shape.unit,
    prices: CommercialAgreementSchema.shape.prices,
    termsText: CommercialAgreementSchema.shape.termsText,
  }),
  usage: z.strictObject({
    periodStart: CommercialUsageSchema.shape.periodStart,
    periodEnd: CommercialUsageSchema.shape.periodEnd,
    measurements: CommercialUsageSchema.shape.measurements,
  }),
  bill: z.strictObject({
    grossAmount: CommercialBillSchema.shape.calculation.shape.grossAmount,
    capReduction: CommercialBillSchema.shape.calculation.shape.capReduction,
    discountAmount: CommercialBillSchema.shape.calculation.shape.discountAmount,
    dueAmount: CommercialBillSchema.shape.calculation.shape.dueAmount,
    lines: CommercialBillSchema.shape.calculation.shape.lines,
  }),
  settlement: z.strictObject({
    unit: CommercialSettlementSchema.shape.unit,
    reservedAmount: CommercialSettlementSchema.shape.reservedAmount,
    chargedAmount: CommercialSettlementSchema.shape.chargedAmount,
    releasedAmount: CommercialSettlementSchema.shape.releasedAmount,
  }),
  adjustment: z.strictObject({
    unit: CommercialAdjustmentSchema.shape.unit,
    previousChargedAmount: CommercialAdjustmentSchema.shape.previousChargedAmount,
    chargedAmount: CommercialAdjustmentSchema.shape.chargedAmount,
    reason: CommercialAdjustmentSchema.shape.reason,
    supportingEvidenceDigest: CommercialAdjustmentSchema.shape.supportingEvidenceDigest,
  }),
  payment: z.strictObject({
    unit: CommercialPaymentSchema.shape.unit,
    amount: CommercialPaymentSchema.shape.amount,
    occurredAt: CommercialPaymentSchema.shape.occurredAt,
    evidenceDigest: CommercialPaymentSchema.shape.evidenceDigest,
    reason: CommercialPaymentSchema.shape.reason,
  }),
};
const scope = {
  protocolVersion: z.literal(1),
  kind: z.literal("commercial-disclosure-grant"),
  grantId: z.uuid(),
  caseId: z.uuid(),
  policyId: z.uuid(),
  policyDigest: FederationDigestSchema,
  domainId: z.uuid(),
  agreementRevisionId: z.uuid(),
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  recordId: z.uuid(),
  recordDigest: FederationDigestSchema,
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  salt: z.string().regex(/^[a-f0-9]{64}$/),
};
export const CommercialDisclosureGrantSchema = z
  .discriminatedUnion("recordType", [
    z.strictObject({
      ...scope,
      recordType: z.literal("agreement"),
      fields: fields.agreement.keyof().array().min(1).max(4),
    }),
    z.strictObject({
      ...scope,
      recordType: z.literal("usage"),
      fields: fields.usage.keyof().array().min(1).max(3),
    }),
    z.strictObject({
      ...scope,
      recordType: z.literal("bill"),
      fields: fields.bill.keyof().array().min(1).max(5),
    }),
    z.strictObject({
      ...scope,
      recordType: z.literal("settlement"),
      fields: fields.settlement.keyof().array().min(1).max(4),
    }),
    z.strictObject({
      ...scope,
      recordType: z.literal("adjustment"),
      fields: fields.adjustment.keyof().array().min(1).max(5),
    }),
    z.strictObject({
      ...scope,
      recordType: z.literal("payment"),
      fields: fields.payment.keyof().array().min(1).max(5),
    }),
  ])
  .refine(
    (v) =>
      new Set([v.sourceSiteId, v.targetSiteId, v.recipientSiteId]).size === 3 &&
      new Set(v.fields).size === v.fields.length &&
      Date.parse(v.validFrom) < Date.parse(v.validUntil),
    "Invalid disclosure scope",
  );
export type CommercialDisclosureGrant = z.infer<typeof CommercialDisclosureGrantSchema>;

const Evidence = z.discriminatedUnion("recordType", [
  z.strictObject({ recordType: z.literal("agreement"), values: fields.agreement.partial() }),
  z.strictObject({ recordType: z.literal("usage"), values: fields.usage.partial() }),
  z.strictObject({ recordType: z.literal("bill"), values: fields.bill.partial() }),
  z.strictObject({ recordType: z.literal("settlement"), values: fields.settlement.partial() }),
  z.strictObject({ recordType: z.literal("adjustment"), values: fields.adjustment.partial() }),
  z.strictObject({ recordType: z.literal("payment"), values: fields.payment.partial() }),
]);
/** Parsing is not authorization: receiving callers must verify signatures and current grant policy. */
export const CommercialDisclosureSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("commercial-disclosure"),
    grant: CommercialDisclosureGrantSchema,
    evidence: Evidence,
  })
  .refine(
    (v) =>
      v.grant.recordType === v.evidence.recordType &&
      Object.keys(v.evidence.values).length === v.grant.fields.length &&
      v.grant.fields.every((key) => Object.hasOwn(v.evidence.values, key)) &&
      Object.values(v.evidence.values).every((value) => value !== undefined),
    "Disclosure must contain exactly the granted fields",
  );
export type CommercialDisclosure = z.infer<typeof CommercialDisclosureSchema>;

function original(recordType: CommercialDisclosureGrant["recordType"], raw: unknown) {
  switch (recordType) {
    case "agreement": {
      const v = CommercialAgreementSchema.parse(raw);
      return {
        ...v.agreement,
        domainId: v.domainId,
        recordId: v.agreement.agreementRevisionId,
        issuedAt: v.createdAt,
        values: {
          consideration: v.consideration,
          unit: v.agreement.unit,
          prices: v.prices,
          termsText: v.termsText,
        },
      };
    }
    case "usage": {
      const v = CommercialUsageSchema.parse(raw);
      return {
        ...v,
        recordId: v.reportId,
        issuedAt: v.reportedAt,
        values: {
          periodStart: v.periodStart,
          periodEnd: v.periodEnd,
          measurements: v.measurements,
        },
      };
    }
    case "bill": {
      const v = CommercialBillSchema.parse(raw);
      return {
        ...v,
        agreementRevisionId: v.request.agreementRevisionId,
        sourceSiteId: v.request.senderSiteId,
        targetSiteId: v.request.recipientSiteId,
        recordId: v.billId,
        values: v.calculation,
      };
    }
    case "settlement": {
      const v = CommercialSettlementSchema.parse(raw);
      return {
        ...v,
        recordId: v.settlementId,
        values: {
          unit: v.unit,
          reservedAmount: v.reservedAmount,
          chargedAmount: v.chargedAmount,
          releasedAmount: v.releasedAmount,
        },
      };
    }
    case "adjustment": {
      const v = CommercialAdjustmentSchema.parse(raw);
      return {
        ...v,
        recordId: v.adjustmentId,
        values: {
          unit: v.unit,
          previousChargedAmount: v.previousChargedAmount,
          chargedAmount: v.chargedAmount,
          reason: v.reason,
          supportingEvidenceDigest: v.supportingEvidenceDigest,
        },
      };
    }
    case "payment": {
      const v = CommercialPaymentSchema.parse(raw);
      return {
        ...v,
        recordId: v.receiptId,
        values: {
          unit: v.unit,
          amount: v.amount,
          occurredAt: v.occurredAt,
          evidenceDigest: v.evidenceDigest,
          reason: v.reason,
        },
      };
    }
  }
}

/** Caller verifies grant approval/policy and original JWS first; digest is of verified wire bytes. */
export function projectCommercialEvidence(
  rawGrant: CommercialDisclosureGrant,
  verifiedOriginal: { payload: unknown; digest: string },
  recipientSiteId: string,
  now: Date,
): CommercialDisclosure {
  try {
    const grant = CommercialDisclosureGrantSchema.parse(rawGrant);
    const value = original(grant.recordType, verifiedOriginal.payload);
    if (
      !Number.isFinite(now.getTime()) ||
      grant.recipientSiteId !== recipientSiteId ||
      grant.recordDigest !== verifiedOriginal.digest ||
      grant.domainId !== value.domainId ||
      grant.agreementRevisionId !== value.agreementRevisionId ||
      grant.sourceSiteId !== value.sourceSiteId ||
      grant.targetSiteId !== value.targetSiteId ||
      grant.recordId !== value.recordId ||
      now.getTime() < Date.parse(grant.validFrom) ||
      now.getTime() >= Date.parse(grant.validUntil) ||
      now.getTime() < Date.parse(value.issuedAt)
    )
      throw new FederationError("POLICY_DENIED");
    const allowed = new Set<string>(grant.fields);
    return CommercialDisclosureSchema.parse({
      protocolVersion: 1,
      kind: "commercial-disclosure",
      grant,
      evidence: {
        recordType: grant.recordType,
        values: Object.fromEntries(
          Object.entries(value.values).filter(([key]) => allowed.has(key)),
        ),
      },
    });
  } catch {
    // Schema errors can contain private inputs; do not expose them across an evidence boundary.
    throw new FederationError("POLICY_DENIED");
  }
}
