import { z } from "zod";
import {
  ArbitrationFinancialTargetSchema,
  ArbitrationFinancialViewSchema,
  ArbitrationReviewInputSchema,
  ArbitrationReviewSchema,
} from "./arbitration-context";
import { CommercialArbitrationTaskBindingSchema } from "./arbitration-policy";
import {
  CommercialDisclosureEvidenceSchema,
  CommercialDisclosureReadPairSchema,
  CommercialDisclosureReadScopeSchema,
} from "./disclosure-authorization";
import { CommercialDisputeSubjectSchema } from "./disputes";
import { FederationAmountSchema, FederationError, federationCanonicalJson } from "./index";
import { FederationDigestSchema } from "./references";

const reference = ArbitrationFinancialTargetSchema.shape.bill;
export const ArbitrationOutcomeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("resolve-without-financial-change") }),
  z.strictObject({
    action: z.literal("settle"),
    bill: reference,
    chargedAmount: FederationAmountSchema,
  }),
  z.strictObject({
    action: z.literal("adjust"),
    bill: reference,
    settlement: reference,
    previousAdjustment: reference.nullable(),
    chargedAmount: FederationAmountSchema,
  }),
]);
export const ArbitrationDecisionInputSchema = ArbitrationReviewInputSchema.safeExtend({
  decisionId: z.uuid(),
  outcome: ArbitrationOutcomeSchema,
  reason: z.string().trim().min(1).max(4000),
});
export const ArbitrationDecisionIntentSchema = z.strictObject({
  decisionId: z.uuid(),
  binding: CommercialArbitrationTaskBindingSchema.omit({ observedAt: true }),
  subject: CommercialDisputeSubjectSchema,
  financial: ArbitrationFinancialViewSchema,
  evidence: ArbitrationReviewSchema.shape.evidence,
  outcome: ArbitrationOutcomeSchema,
  reason: ArbitrationDecisionInputSchema.shape.reason,
  salt: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArbitrationDecisionIntent = z.infer<typeof ArbitrationDecisionIntentSchema>;
export const ArbitrationDecisionSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("arbitration-decision"),
    intent: ArbitrationDecisionIntentSchema,
    issuedAt: z.iso.datetime(),
    basisDigest: FederationDigestSchema,
    basisExpiresAt: z.iso.datetime(),
  })
  .refine((v) => Date.parse(v.issuedAt) < Date.parse(v.basisExpiresAt));
export type ArbitrationDecision = z.infer<typeof ArbitrationDecisionSchema>;
const jws = z.string().min(1).max(524288);
const contextProof = z.strictObject({ queryJws: jws, responseJws: jws });
export const ArbitrationDecisionBasisSchema = z.strictObject({
  review: ArbitrationReviewSchema,
  contexts: z.tuple([contextProof, contextProof]),
  evidence: z
    .array(
      z.strictObject({
        scope: CommercialDisclosureReadScopeSchema,
        evidence: CommercialDisclosureEvidenceSchema,
        readId: z.uuid(),
        authorizations: CommercialDisclosureReadPairSchema,
      }),
    )
    .max(64),
});
export type ArbitrationDecisionBasis = z.infer<typeof ArbitrationDecisionBasisSchema>;

/** Stable human intent excludes transient read IDs and expiry windows. */
export function arbitrationDecisionIntent(
  review: z.infer<typeof ArbitrationReviewSchema>,
  input: z.infer<typeof ArbitrationDecisionInputSchema>,
  salt: string,
) {
  const { context } = review;
  const { observedAt: _observedAt, ...binding } = context.binding;
  if (!context.financial) throw new FederationError("DATA_WAITING");
  const outcome = input.outcome;
  if (!context.policy.actions.includes(outcome.action)) throw new FederationError("POLICY_DENIED");
  if (outcome.action !== "resolve-without-financial-change") {
    if (BigInt(outcome.chargedAmount) > BigInt(context.policy.maxChargedAmount))
      throw new FederationError("POLICY_DENIED");
    const target = context.financial.targets.find(
      (t) => federationCanonicalJson(t.bill) === federationCanonicalJson(outcome.bill),
    );
    if (
      !target ||
      (outcome.action === "settle"
        ? target.settlement !== null
        : target.settlement === null ||
          federationCanonicalJson(target.settlement) !==
            federationCanonicalJson(outcome.settlement) ||
          federationCanonicalJson(target.previousAdjustment) !==
            federationCanonicalJson(outcome.previousAdjustment))
    )
      throw new FederationError("OPERATION_CONFLICT");
    // Required financial evidence must describe the chosen financial target, not another bill.
    for (const required of context.policy.requiredEvidence) {
      const ref =
        required.recordType === "bill"
          ? target.bill
          : required.recordType === "settlement"
            ? target.settlement
            : required.recordType === "adjustment"
              ? target.previousAdjustment
              : undefined;
      if (ref === undefined) continue;
      const fields = new Set(
        review.evidence
          .filter(
            (e) =>
              e.recordType === required.recordType &&
              e.recordId === ref?.recordId &&
              e.recordDigest === ref.recordDigest,
          )
          .flatMap((e) => e.fields),
      );
      if (!ref || !required.fields.every((f) => fields.has(f)))
        throw new FederationError("DATA_WAITING");
    }
  }
  return ArbitrationDecisionIntentSchema.parse({
    decisionId: input.decisionId,
    binding,
    subject: context.subject,
    financial: context.financial,
    evidence: review.evidence
      .map((e) => ({ ...e, fields: [...e.fields].sort() }))
      .sort((a, b) => a.grantId.localeCompare(b.grantId)),
    outcome,
    reason: input.reason,
    salt,
  });
}
