import {
  auditLog,
  federationDatasetUseGrants as grants,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  assertDatasetUseGrant,
  assertFederationStatusQueryFresh,
  FederationDatasetUseGrantSchema,
  FederationDatasetUseQuerySchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { and, eq, sql } from "drizzle-orm";
import type { FederationDatasetUsePolicies } from "./dataset-use-policies";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Independent of media import/disclosure; never waits for Fabric. */
export class FederationDatasetUseResponder {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly policies: FederationDatasetUsePolicies,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async respond(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      this.clock(),
    );
    const verified = await verifyFederationMessage(
      FederationDatasetUseQuerySchema,
      jws,
      peer,
      this.clock(),
    );
    const query = verified.payload;
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    assertFederationStatusQueryFresh(query, this.clock());
    await this.policies.preflight(query);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`dataset-use:${this.signing.siteId}:${query.queryId}`}, 0))`,
      );
      assertFederationStatusQueryFresh(query, this.clock());
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, this.clock());
      const peerKey = await this.trust.resolveKey(peer.siteId, peer.keyId, this.clock(), tx);
      if (!peerKey.allowedKinds.includes("dataset-use-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const scope = await this.policies.assertQuery(tx, query);
      const [existing] = await tx
        .select()
        .from(grants)
        .where(and(eq(grants.localSiteId, this.signing.siteId), eq(grants.queryId, query.queryId)));
      if (existing) {
        if (existing.queryDigest !== verified.digest || existing.policyId !== query.policyId)
          throw new FederationError("OPERATION_CONFLICT");
        const key = await this.signingKey(tx, federationMessageKeyId(existing.responseJws));
        const result = await verifyFederationMessage(
          FederationDatasetUseGrantSchema,
          existing.responseJws,
          key,
          this.clock(),
        );
        assertDatasetUseGrant(query, verified.digest, result.payload, this.clock());
        if (
          existing.expiresAt > scope.expiresAt ||
          existing.expiresAt > key.validUntil ||
          existing.expiresAt > peerKey.validUntil
        )
          throw new FederationError("AUTHORIZATION_EXPIRED");
        return existing.responseJws;
      }
      const key = await this.signingKey(tx, this.signing.keyId),
        now = this.clock();
      const expiresAt = new Date(
        Math.min(
          now.getTime() + 60_000,
          Date.parse(query.expiresAt),
          scope.expiresAt.getTime(),
          key.validUntil.getTime(),
          peerKey.validUntil.getTime(),
        ),
      );
      if (expiresAt <= now) throw new FederationError("AUTHORIZATION_EXPIRED");
      const grant = FederationDatasetUseGrantSchema.parse({
        ...query,
        kind: "dataset-use-grant",
        senderSiteId: this.signing.siteId,
        recipientSiteId: peer.siteId,
        queryDigest: verified.digest,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      const responseJws = await signFederationMessage(
        FederationDatasetUseGrantSchema,
        grant,
        this.signing,
      );
      assertDatasetUseGrant(query, verified.digest, grant, this.clock());
      await tx.insert(grants).values({
        localSiteId: this.signing.siteId,
        queryId: query.queryId,
        policyId: query.policyId,
        queryDigest: verified.digest,
        responseJws,
        issuedAt: now,
        expiresAt,
      });
      await tx.insert(auditLog).values({
        actor: scope.policy.approvedBy,
        orgId: scope.policy.localOrgId,
        action: "federation.dataset_use.issue",
        target: query.queryId,
        diff: {
          after: {
            policyId: query.policyId,
            recipientSiteId: peer.siteId,
            replicaId: query.replicaId,
            queryDigest: verified.digest,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
      return responseJws;
    });
  }
  private async signingKey(tx: PgTransaction, keyId: string) {
    await this.trust.assertKey(tx, this.signing.siteId, keyId, this.clock());
    const key = await this.trust.resolveKey(this.signing.siteId, keyId, this.clock(), tx);
    if (!key.allowedKinds.includes("dataset-use-grant"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return key;
  }
}
