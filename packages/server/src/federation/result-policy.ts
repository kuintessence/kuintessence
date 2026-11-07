import { FederationAgreementSchema, FederationError } from "@kuintessence/shared/federation";
import { federationMaterialDigest } from "./assets";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type { FederationTransaction, FederationTrustRegistry } from "./trust-registry";

/** Result release has its own signed deadline; expired execution does not extend it. */
export async function requireFederationResultPolicy(
  tx: FederationTransaction,
  trust: FederationTrustRegistry,
  agreement: {
    state: string;
    terms: unknown;
    termsDigest: string;
    sourceApprovalJws: string;
    targetApprovalJws: string;
  },
  now: Date,
) {
  const terms = FederationAgreementSchema.parse(agreement.terms);
  if (agreement.state !== "active" || !terms.resultPolicy)
    throw new FederationError("POLICY_DENIED");
  if (Date.parse(terms.resultPolicy.availableUntil) <= now.getTime())
    throw new FederationError("AUTHORIZATION_EXPIRED");
  for (const [siteId, jws] of [
    [terms.sourceSiteId, agreement.sourceApprovalJws],
    [terms.targetSiteId, agreement.targetApprovalJws],
  ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
    if (!siteId || !jws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const keyId = federationMessageKeyId(jws);
    await trust.assertKey(tx, siteId, keyId, now);
    const key = await trust.resolveKey(siteId, keyId, now, tx);
    const verified = await verifyFederationMessage(FederationAgreementSchema, jws, key, now);
    if (
      verified.digest !== agreement.termsDigest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(terms)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  return { terms, policy: terms.resultPolicy };
}
