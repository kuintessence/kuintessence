import {
  federationAgreements as agreements,
  federationDisputes as cases,
  federationDisclosures as disclosures,
  federationDisputeFreezes as freezes,
  federationSigningKeys as keys,
  federationOutbound as outbound,
  type PgTransaction,
  federationReservations as reservations,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  ArbitrationContextQuerySchema,
  ArbitrationContextSchema,
  ArbitrationFinancialViewSchema,
  ArbitrationReviewSchema,
  assertArbitrationContext,
} from "@kuintessence/shared/federation/arbitration-context";
import {
  ArbitrationDecisionSchema,
  arbitrationDecisionIntent,
} from "@kuintessence/shared/federation/arbitration-decision";
import type { ArbitrationDecisionDelivery } from "@kuintessence/shared/federation/arbitration-decision-delivery";
import {
  assertArbitrationRequest,
  CommercialArbitrationPolicySchema,
} from "@kuintessence/shared/federation/arbitration-policy";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import {
  assertCommercialDisclosureReadAuthorization,
  CommercialDisclosureReadAuthorizationSchema,
  CommercialDisclosureReadQuerySchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { CommercialDisputeFreezeSchema } from "@kuintessence/shared/federation/disputes";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { federationMaterialDigest } from "./assets";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "./signatures";

/** Only called inside currently authenticated delivery. Never use historical keys for new authority. */
export async function verifyArbitrationHistory<T extends { kind: string }>(
  tx: PgTransaction,
  schema: z.ZodType<T>,
  jws: string,
  siteId: string,
  at: Date,
) {
  const [key] = await tx
    .select()
    .from(keys)
    .where(and(eq(keys.siteId, siteId), eq(keys.keyId, federationMessageKeyId(jws))))
    .for("share");
  if (!key) throw new FederationError("UNTRUSTED_IDENTITY");
  return verifyFederationMessage(
    schema,
    jws,
    {
      siteId,
      keyId: key.keyId,
      publicKey: await parseFederationPublicKey(key.publicKeyPem),
      allowedKinds: key.allowedKinds,
      validFrom: key.validFrom,
      validUntil: key.validUntil,
      revoked: !!key.revokedAt && key.revokedAt <= at,
    },
    at,
  );
}

/** Verifies the signed historical decision; current money/closure authorization is intentionally separate. */
export async function verifyReceivedArbitrationDecision(
  tx: PgTransaction,
  value: ArbitrationDecisionDelivery,
  localSiteId: string,
) {
  const decision = value.decision,
    intent = decision.intent,
    b = intent.binding,
    at = new Date(decision.issuedAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60000)
    throw new FederationError("AUTHORIZATION_EXPIRED");
  const signed = await verifyArbitrationHistory(
    tx,
    ArbitrationDecisionSchema,
    value.decisionJws,
    b.arbitratorSiteId,
    at,
  );
  if (
    signed.digest !== value.decisionDigest ||
    federationCanonicalJson(signed.payload) !== federationCanonicalJson(decision)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const [record] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.localSiteId, localSiteId), eq(cases.caseId, b.caseId)))
    .for("share");
  if (!record) throw new FederationError("DATA_WAITING");
  if (
    record.digest !== b.caseDigest ||
    record.agreementRevisionId !== b.agreementRevisionId ||
    record.taskId !== b.taskId ||
    record.attempt !== b.attempt ||
    (["domainId", "agreementDigest", "sourceSiteId", "targetSiteId"] as const).some(
      (k) => record.payload[k] !== b[k],
    ) ||
    federationCanonicalJson(record.payload.subject) !== federationCanonicalJson(intent.subject)
  )
    throw new FederationError("POLICY_DENIED");
  const scope = {
    caseId: b.caseId,
    domainId: b.domainId,
    agreementRevisionId: b.agreementRevisionId,
    agreementDigest: b.agreementDigest,
    sourceSiteId: b.sourceSiteId,
    targetSiteId: b.targetSiteId,
    evidenceRecipientSiteId: b.arbitratorSiteId,
  };
  const contexts = [];
  for (const [index, pair] of value.contexts.entries()) {
    const party = index === 0 ? b.sourceSiteId : b.targetSiteId;
    const query = await verifyArbitrationHistory(
      tx,
      ArbitrationContextQuerySchema,
      pair.queryJws,
      b.arbitratorSiteId,
      at,
    );
    const response = await verifyArbitrationHistory(
      tx,
      ArbitrationContextSchema,
      pair.responseJws,
      party,
      at,
    );
    assertArbitrationContext(query.payload, query.digest, response.payload, at);
    const { observedAt: _observedAt, ...binding } = response.payload.binding;
    if (
      query.payload.recipientSiteId !== party ||
      federationCanonicalJson(query.payload.scope) !== federationCanonicalJson(scope) ||
      federationCanonicalJson(binding) !== federationCanonicalJson(b) ||
      federationCanonicalJson(response.payload.subject) !==
        federationCanonicalJson(intent.subject) ||
      Date.parse(decision.basisExpiresAt) > Date.parse(response.payload.expiresAt)
    )
      throw new FederationError("POLICY_DENIED");
    contexts.push(response.payload);
  }
  const [source, target] = contexts;
  if (
    !source?.financial ||
    !target?.financial ||
    source.sourceJws !== target.sourceJws ||
    source.targetJws !== target.targetJws ||
    source.readId !== target.readId ||
    federationCanonicalJson(source.financial) !== federationCanonicalJson(target.financial)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const { sourceJws: _sourceFreeze, targetJws: _targetFreeze, ...financial } = source.financial;
  if (federationCanonicalJson(financial) !== federationCanonicalJson(intent.financial))
    throw new FederationError("OPERATION_CONFLICT");
  const policy = await verifyArbitrationHistory(
    tx,
    CommercialArbitrationPolicySchema,
    source.sourceJws,
    b.sourceSiteId,
    at,
  );
  const otherPolicy = await verifyArbitrationHistory(
    tx,
    CommercialArbitrationPolicySchema,
    source.targetJws,
    b.targetSiteId,
    at,
  );
  if (
    policy.digest !== b.policyDigest ||
    otherPolicy.digest !== b.policyDigest ||
    policy.payload.arbitratorSiteId !== b.arbitratorSiteId ||
    policy.payload.domainId !== b.domainId ||
    policy.payload.agreementDigest !== b.agreementDigest ||
    !policy.payload.subjectTypes.includes(intent.subject.recordType) ||
    Date.parse(decision.basisExpiresAt) > Date.parse(policy.payload.validUntil)
  )
    throw new FederationError("POLICY_DENIED");
  // Resolve the original accepted operation in the owning institution, never a bill's embedded copy.
  const original =
    localSiteId === b.sourceSiteId
      ? (
          await tx
            .select({
              requestJws: outbound.requestJws,
              requestDigest: outbound.requestDigest,
              receiptJws: outbound.receiptJws,
            })
            .from(outbound)
            .where(
              and(
                eq(outbound.localSiteId, localSiteId),
                eq(outbound.localOrgId, record.localOrgId),
                eq(outbound.operationId, b.operationId),
                eq(outbound.state, "accepted"),
              ),
            )
            .for("share")
        )[0]
      : (
          await tx
            .select({
              requestJws: reservations.requestJws,
              requestDigest: reservations.requestDigest,
              receiptJws: reservations.receiptJws,
            })
            .from(reservations)
            .innerJoin(agreements, eq(agreements.revisionId, reservations.agreementRevisionId))
            .where(
              and(
                eq(agreements.targetSiteId, localSiteId),
                eq(agreements.localOrgId, record.localOrgId),
                eq(reservations.operationId, b.operationId),
                eq(reservations.id, b.reservationId),
              ),
            )
            .for("share", { of: [reservations, agreements] })
        )[0];
  if (!original?.receiptJws || original.requestDigest !== b.requestDigest)
    throw new FederationError("POLICY_DENIED");
  const request = await verifyArbitrationHistory(
    tx,
    FederationDelegationSchema,
    original.requestJws,
    b.sourceSiteId,
    at,
  );
  const accepted = await verifyArbitrationHistory(
    tx,
    FederationAcceptanceSchema,
    original.receiptJws,
    b.targetSiteId,
    at,
  );
  const r = request.payload,
    receipt = accepted.payload;
  assertArbitrationRequest(policy.payload, policy.digest, r, at);
  if (
    request.digest !== b.requestDigest ||
    accepted.digest !== b.acceptanceDigest ||
    r.arbitration?.sourceJws !== source.sourceJws ||
    r.arbitration.targetJws !== source.targetJws ||
    r.senderSiteId !== b.sourceSiteId ||
    r.recipientSiteId !== b.targetSiteId ||
    receipt.reservationId !== b.reservationId ||
    receipt.requestDigest !== request.digest ||
    receipt.senderSiteId !== b.targetSiteId ||
    receipt.recipientSiteId !== b.sourceSiteId ||
    Date.parse(receipt.acceptedAt) > at.getTime() + 60000 ||
    (["agreementRevisionId", "operationId", "taskId", "attempt", "mode", "unit"] as const).some(
      (k) => r[k] !== b[k] || receipt[k] !== b[k],
    )
  )
    throw new FederationError("POLICY_DENIED");
  const [freeze] = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.localSiteId, localSiteId), eq(freezes.caseId, b.caseId)))
    .for("share");
  if (
    !freeze?.confirmedAt ||
    !freeze.payload ||
    !freeze.financialView ||
    !freeze.approvalJws ||
    !freeze.counterpartyJws
  )
    throw new FederationError("DATA_WAITING");
  const sourceFreeze = localSiteId === b.sourceSiteId ? freeze.approvalJws : freeze.counterpartyJws;
  const targetFreeze = localSiteId === b.targetSiteId ? freeze.approvalJws : freeze.counterpartyJws;
  if (
    freeze.digest !== financial.freezeDigest ||
    sourceFreeze !== source.financial.sourceJws ||
    targetFreeze !== source.financial.targetJws ||
    freeze.financialView.headDigest !== financial.headDigest ||
    federationCanonicalJson(freeze.financialView.records) !==
      federationCanonicalJson(financial.records) ||
    federationCanonicalJson(freeze.ledgerReceipt) !==
      federationCanonicalJson(financial.ledgerReceipt)
  )
    throw new FederationError("OPERATION_CONFLICT");
  for (const [party, jws] of [
    [b.sourceSiteId, sourceFreeze],
    [b.targetSiteId, targetFreeze],
  ] as const) {
    const proof = await verifyArbitrationHistory(tx, CommercialDisputeFreezeSchema, jws, party, at);
    if (
      proof.digest !== financial.freezeDigest ||
      proof.payload.headDigest !== financial.headDigest ||
      Date.parse(proof.payload.issuedAt) > at.getTime() + 60000 ||
      (
        [
          "caseId",
          "caseDigest",
          "agreementRevisionId",
          "taskId",
          "attempt",
          "mode",
          "sourceSiteId",
          "targetSiteId",
        ] as const
      ).some((k) => proof.payload[k] !== b[k])
    )
      throw new FederationError("POLICY_DENIED");
  }
  if (
    federationMaterialDigest({
      caseId: b.caseId,
      caseDigest: b.caseDigest,
      agreementRevisionId: b.agreementRevisionId,
      taskId: b.taskId,
      attempt: b.attempt,
      mode: b.mode,
      records: financial.records,
    }) !== financial.headDigest
  )
    throw new FederationError("OPERATION_CONFLICT");
  const groups = new Map<string, { type: string; fields: Map<string, string> }>();
  if (
    value.evidenceAuthorizations.length !== intent.evidence.length ||
    new Set(value.evidenceAuthorizations.map((e) => e.scope.grantId)).size !==
      intent.evidence.length
  )
    throw new FederationError("POLICY_DENIED");
  if (
    intent.evidence.length > 64 ||
    new Set(intent.evidence.map((e) => e.grantId)).size !== intent.evidence.length
  )
    throw new FederationError("INVALID_MESSAGE");
  for (const evidence of intent.evidence) {
    const [local] = await tx
      .select()
      .from(disclosures)
      .where(
        and(
          eq(disclosures.localSiteId, localSiteId),
          eq(disclosures.caseId, b.caseId),
          eq(disclosures.localOrgId, record.localOrgId),
          eq(disclosures.grantId, evidence.grantId),
        ),
      )
      .for("share");
    if (!local?.counterpartyJws || local.digest !== evidence.disclosureDigest)
      throw new FederationError("POLICY_DENIED");
    const auth = value.evidenceAuthorizations.find((a) => a.scope.grantId === evidence.grantId);
    if (
      !auth ||
      federationCanonicalJson(auth.scope) !==
        federationCanonicalJson({
          ...scope,
          grantId: evidence.grantId,
          disclosureDigest: evidence.disclosureDigest,
          policyId: local.payload.grant.policyId,
          policyDigest: local.payload.grant.policyDigest,
        })
    )
      throw new FederationError("POLICY_DENIED");
    for (const [index, entry] of auth.authorizations.entries()) {
      const party = index === 0 ? b.sourceSiteId : b.targetSiteId;
      const query = await verifyArbitrationHistory(
        tx,
        CommercialDisclosureReadQuerySchema,
        entry.queryJws,
        b.arbitratorSiteId,
        at,
      );
      const response = await verifyArbitrationHistory(
        tx,
        CommercialDisclosureReadAuthorizationSchema,
        entry.authorizationJws,
        party,
        at,
      );
      assertCommercialDisclosureReadAuthorization(
        query.payload,
        query.digest,
        response.payload,
        at,
      );
      if (
        query.payload.recipientSiteId !== party ||
        query.payload.readId !== auth.readId ||
        federationCanonicalJson(query.payload.scope) !== federationCanonicalJson(auth.scope) ||
        Date.parse(response.payload.expiresAt) < Date.parse(decision.basisExpiresAt)
      )
        throw new FederationError("POLICY_DENIED");
    }
    const own = await verifyArbitrationHistory(
      tx,
      CommercialDisclosureSchema,
      local.approvalJws,
      localSiteId,
      at,
    );
    const peer = await verifyArbitrationHistory(
      tx,
      CommercialDisclosureSchema,
      local.counterpartyJws,
      localSiteId === b.sourceSiteId ? b.targetSiteId : b.sourceSiteId,
      at,
    );
    const g = own.payload.grant;
    const allowed = policy.payload.disclosures.find((d) => d.recordType === g.recordType);
    if (
      own.digest !== local.digest ||
      peer.digest !== local.digest ||
      g.caseId !== b.caseId ||
      g.domainId !== b.domainId ||
      g.agreementRevisionId !== b.agreementRevisionId ||
      g.sourceSiteId !== b.sourceSiteId ||
      g.targetSiteId !== b.targetSiteId ||
      g.recipientSiteId !== b.arbitratorSiteId ||
      g.recordType !== evidence.recordType ||
      g.recordId !== evidence.recordId ||
      g.recordDigest !== evidence.recordDigest ||
      federationCanonicalJson([...g.fields].sort()) !== federationCanonicalJson(evidence.fields) ||
      !allowed ||
      !g.fields.every((f) => (allowed.fields as readonly string[]).includes(f)) ||
      Date.parse(g.validFrom) > at.getTime() ||
      Date.parse(g.validUntil) < Date.parse(decision.basisExpiresAt) ||
      (local.revokedAt && local.revokedAt <= at) ||
      !financial.evidenceReferences.some(
        (e) =>
          e.recordType === g.recordType &&
          e.recordId === g.recordId &&
          e.recordDigest === g.recordDigest,
      )
    )
      throw new FederationError("POLICY_DENIED");
    const id = `${g.recordType}:${g.recordId}:${g.recordDigest}`,
      group = groups.get(id) ?? { type: g.recordType, fields: new Map<string, string>() };
    for (const [field, value] of Object.entries(own.payload.evidence.values)) {
      const encoded = federationCanonicalJson(value);
      if (group.fields.has(field) && group.fields.get(field) !== encoded)
        throw new FederationError("OPERATION_CONFLICT");
      group.fields.set(field, encoded);
    }
    groups.set(id, group);
  }
  for (const required of policy.payload.requiredEvidence)
    if (
      ![...groups.values()].some(
        (g) => g.type === required.recordType && required.fields.every((f) => g.fields.has(f)),
      )
    )
      throw new FederationError("DATA_WAITING");
  const review = ArbitrationReviewSchema.parse({
    context: {
      readId: source.readId,
      binding: source.binding,
      policy: policy.payload,
      subject: intent.subject,
      financial: ArbitrationFinancialViewSchema.parse(financial),
      observations: [
        { siteId: b.sourceSiteId, observedAt: source.binding.observedAt },
        { siteId: b.targetSiteId, observedAt: target.binding.observedAt },
      ],
      expiresAt: decision.basisExpiresAt,
    },
    evidence: intent.evidence,
    expiresAt: decision.basisExpiresAt,
  });
  if (
    federationCanonicalJson(
      arbitrationDecisionIntent(
        review,
        {
          decisionId: intent.decisionId,
          grantIds: intent.evidence.map((e) => e.grantId),
          outcome: intent.outcome,
          reason: intent.reason,
        },
        intent.salt,
      ),
    ) !== federationCanonicalJson(intent)
  )
    throw new FederationError("OPERATION_CONFLICT");
  return record;
}
