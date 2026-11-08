import { federationAgreementApprovals, type PgTransaction } from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type { FederationTrustRegistry } from "./trust-registry";

/** Data sharing uses this institution's signed consent, never the compute receiver's budget. */
export async function requireMediaAgreement(
  tx: PgTransaction,
  trust: FederationTrustRegistry,
  scope: { siteId: string; orgId: string; recipientSiteId: string; agreementRevisionId: string },
  now: Date,
) {
  const [approval] = await tx
    .select()
    .from(federationAgreementApprovals)
    .where(
      and(
        eq(federationAgreementApprovals.localSiteId, scope.siteId),
        eq(federationAgreementApprovals.localOrgId, scope.orgId),
        eq(federationAgreementApprovals.revisionId, scope.agreementRevisionId),
      ),
    )
    .for("share");
  if (!approval || approval.state !== "active" || !approval.counterpartyApprovalJws)
    throw new FederationError("POLICY_DENIED");
  const terms = FederationAgreementSchema.parse(approval.terms);
  if (
    terms.agreementRevisionId !== scope.agreementRevisionId ||
    scope.siteId === scope.recipientSiteId ||
    ![terms.sourceSiteId, terms.targetSiteId].includes(scope.siteId) ||
    ![terms.sourceSiteId, terms.targetSiteId].includes(scope.recipientSiteId) ||
    Date.parse(terms.validFrom) > now.getTime() ||
    Date.parse(terms.validUntil) <= now.getTime()
  )
    throw new FederationError("POLICY_DENIED");
  for (const [siteId, jws] of [
    [scope.siteId, approval.approvalJws],
    [scope.recipientSiteId, approval.counterpartyApprovalJws],
  ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
    if (!siteId || !jws) throw new FederationError("POLICY_DENIED");
    const keyId = federationMessageKeyId(jws);
    await trust.assertKey(tx, siteId, keyId, now);
    const key = await trust.resolveKey(siteId, keyId, now, tx);
    const verified = await verifyFederationMessage(FederationAgreementSchema, jws, key, now);
    if (
      verified.digest !== approval.termsDigest ||
      federationCanonicalJson(verified.payload) !== federationCanonicalJson(terms)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  return terms;
}
