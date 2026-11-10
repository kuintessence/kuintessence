import type { z } from "zod";
import { ArbitrationDecisionSchema, assertArbitrationOutcome } from "./arbitration-decision";
import { assertArbitrationRequest, CommercialArbitrationPolicySchema } from "./arbitration-policy";
import type { ArbitrationResolutionEnvelope, CommercialArbitrationResolution } from "./commercial";
import {
  FederationAcceptanceSchema,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "./index";

/** Current execution authority; historical receipt or PDC publication cannot substitute for this proof. */
export async function verifyArbitrationExecution(
  envelope: ArbitrationResolutionEnvelope,
  verify: <T extends { kind: string }>(
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) => Promise<{ payload: T; digest: string }>,
  now: Date,
) {
  const request = await verify(
    FederationDelegationSchema,
    envelope.requestJws,
    envelope.sourceSiteId,
  );
  const r = request.payload;
  if (
    !r.arbitration ||
    r.senderSiteId !== envelope.sourceSiteId ||
    r.recipientSiteId !== envelope.targetSiteId ||
    r.senderSiteId === r.recipientSiteId
  )
    throw new FederationError("POLICY_DENIED");
  const source = await verify(
    CommercialArbitrationPolicySchema,
    r.arbitration.sourceJws,
    r.senderSiteId,
  );
  const target = await verify(
    CommercialArbitrationPolicySchema,
    r.arbitration.targetJws,
    r.recipientSiteId,
  );
  if (source.digest !== target.digest) throw new FederationError("OPERATION_CONFLICT");
  assertArbitrationRequest(source.payload, source.digest, r, now);
  const decision = await verify(
    ArbitrationDecisionSchema,
    envelope.decisionJws,
    source.payload.arbitratorSiteId,
  );
  const accepted = await verify(
    FederationAcceptanceSchema,
    envelope.acceptanceJws,
    r.recipientSiteId,
  );
  const d = decision.payload,
    b = d.intent.binding,
    policy = source.payload,
    receipt = accepted.payload;
  if (
    !policy.actions.includes(d.intent.outcome.action) ||
    !policy.subjectTypes.includes(d.intent.subject.recordType) ||
    b.policyId !== policy.policyId ||
    b.policyDigest !== source.digest ||
    b.domainId !== policy.domainId ||
    b.agreementDigest !== policy.agreementDigest ||
    b.arbitratorSiteId !== policy.arbitratorSiteId ||
    b.sourceSiteId !== r.senderSiteId ||
    b.targetSiteId !== r.recipientSiteId ||
    b.requestDigest !== request.digest ||
    b.acceptanceDigest !== accepted.digest ||
    b.reservationId !== receipt.reservationId ||
    receipt.senderSiteId !== r.recipientSiteId ||
    receipt.recipientSiteId !== r.senderSiteId ||
    receipt.requestDigest !== request.digest ||
    receipt.reservedAmount !== r.maxAmount ||
    Date.parse(d.issuedAt) > now.getTime() ||
    Date.parse(d.issuedAt) < Date.parse(receipt.acceptedAt) ||
    Date.parse(receipt.acceptedAt) >= Date.parse(r.expiresAt) ||
    Date.parse(receipt.acceptedAt) < Date.parse(r.issuedAt) - 60000 ||
    (["agreementRevisionId", "taskId", "attempt", "operationId", "mode", "unit"] as const).some(
      (key) => b[key] !== r[key] || receipt[key] !== r[key],
    ) ||
    receipt.budgetDomainId !== r.budgetDomainId ||
    receipt.epoch !== r.epoch
  )
    throw new FederationError("POLICY_DENIED");
  assertArbitrationRequest(policy, source.digest, r, new Date(receipt.acceptedAt));
  assertArbitrationRequest(policy, source.digest, r, new Date(d.issuedAt));
  for (const evidence of d.intent.evidence) {
    const allowed = policy.disclosures.find(
      (selection) => selection.recordType === evidence.recordType,
    );
    if (!allowed || !evidence.fields.every((field) => new Set<string>(allowed.fields).has(field)))
      throw new FederationError("POLICY_DENIED");
  }
  for (const required of policy.requiredEvidence) {
    const matching = d.intent.evidence.filter(
      (evidence) => evidence.recordType === required.recordType,
    );
    if (
      !matching.some((original) => {
        const fields = new Set(
          matching
            .filter(
              (e) => e.recordId === original.recordId && e.recordDigest === original.recordDigest,
            )
            .flatMap((e) => e.fields),
        );
        return required.fields.every((field) => fields.has(field));
      })
    )
      throw new FederationError("DATA_WAITING");
  }
  assertArbitrationOutcome(policy, d.intent.financial, d.intent.evidence, d.intent.outcome);
  if (
    d.intent.outcome.action !== "resolve-without-financial-change" &&
    BigInt(d.intent.outcome.chargedAmount) > BigInt(r.maxAmount)
  )
    throw new FederationError("POLICY_DENIED");
  return { decision, request, accepted, policy: source };
}

export function assertArbitrationResolution(
  value: CommercialArbitrationResolution,
  proof: Awaited<ReturnType<typeof verifyArbitrationExecution>>,
) {
  const d = proof.decision.payload,
    b = d.intent.binding;
  if (
    value.decisionId !== d.intent.decisionId ||
    value.decisionDigest !== proof.decision.digest ||
    value.caseId !== b.caseId ||
    value.caseDigest !== b.caseDigest ||
    value.domainId !== b.domainId ||
    value.agreementRevisionId !== b.agreementRevisionId ||
    value.sourceSiteId !== b.sourceSiteId ||
    value.targetSiteId !== b.targetSiteId ||
    value.taskId !== b.taskId ||
    value.attempt !== b.attempt ||
    value.mode !== b.mode ||
    value.headDigest !== d.intent.financial.headDigest ||
    value.freezeDigest !== d.intent.financial.freezeDigest ||
    federationCanonicalJson(value.outcome) !== federationCanonicalJson(d.intent.outcome)
  )
    throw new FederationError("OPERATION_CONFLICT");
}
