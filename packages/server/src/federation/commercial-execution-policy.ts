import { federationCommercialAgreements, type PgTransaction } from "@kuintessence/db";
import {
  type FederationAgreement,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { and, eq } from "drizzle-orm";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type { FederationTrustRegistry } from "./trust-registry";

/** Local execution consent must refer to the same organization's exact commercial terms. */
export async function requireCoordinatedCommercialAgreement(
  tx: PgTransaction,
  trust: FederationTrustRegistry,
  localSiteId: string,
  localOrgId: string,
  terms: FederationAgreement,
  clock: () => Date,
) {
  if (terms.mode !== "ledger_coordinated") return;
  if (![terms.sourceSiteId, terms.targetSiteId].includes(localSiteId))
    throw new FederationError("POLICY_DENIED");
  const scope = and(
    eq(federationCommercialAgreements.localSiteId, localSiteId),
    eq(federationCommercialAgreements.localOrgId, localOrgId),
    eq(federationCommercialAgreements.revisionId, terms.agreementRevisionId),
  );
  const [contract] = await tx.select().from(federationCommercialAgreements).where(scope);
  if (!contract?.counterpartyJws) throw new FederationError("LEDGER_REQUIRED");
  const commercial = CommercialAgreementSchema.parse(contract.terms);
  if (federationCanonicalJson(commercial.agreement) !== federationCanonicalJson(terms))
    throw new FederationError("OPERATION_CONFLICT");
  const otherSiteId = localSiteId === terms.sourceSiteId ? terms.targetSiteId : terms.sourceSiteId;
  const signatures = [
    { siteId: localSiteId, jws: contract.approvalJws },
    { siteId: otherSiteId, jws: contract.counterpartyJws },
  ].sort((a, b) => a.siteId.localeCompare(b.siteId));
  // Match commercial approval's trust-before-contract lock order.
  for (const { siteId, jws } of signatures)
    await trust.assertKey(tx, siteId, federationMessageKeyId(jws), clock());
  const [current] = await tx
    .select()
    .from(federationCommercialAgreements)
    .where(scope)
    .for("share");
  if (
    !current ||
    current.digest !== contract.digest ||
    current.approvalJws !== contract.approvalJws ||
    current.counterpartyJws !== contract.counterpartyJws ||
    federationCanonicalJson(current.terms) !== federationCanonicalJson(commercial)
  )
    throw new FederationError("OPERATION_CONFLICT");
  let validUntil = Number.POSITIVE_INFINITY;
  for (const { siteId, jws } of signatures) {
    const keyId = federationMessageKeyId(jws);
    const key = await trust.resolveKey(siteId, keyId, clock(), tx);
    validUntil = Math.min(validUntil, key.validUntil.getTime());
    const verified = await verifyFederationMessage(CommercialAgreementSchema, jws, key, clock());
    if (
      verified.digest !== contract.digest ||
      federationCanonicalJson(verified.payload) !== federationCanonicalJson(commercial)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  return { contract: current, validUntil };
}
