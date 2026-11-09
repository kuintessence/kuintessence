import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationDisclosureReadAuthorizations as authorizations,
  federationCommercialAgreements as contracts,
  federationDisclosures as disclosures,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  assertCommercialDisclosureReadAuthorization,
  CommercialDisclosureReadAuthorizationSchema,
  type CommercialDisclosureReadPair,
  type CommercialDisclosureReadQuery,
  CommercialDisclosureReadQuerySchema,
  type CommercialDisclosureReadScope,
  CommercialDisclosureReadScopeSchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { and, eq, sql } from "drizzle-orm";
import { FederationDisclosureService } from "./disclosure";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import type { FederationSend } from "./outbound-client";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Current local authorization only. No fields, original commercial signatures or money cross this API. */
export class FederationDisclosureReadResponder {
  private readonly trust: FederationTrustRegistry;
  private readonly disclosures: FederationDisclosureService;
  private readonly policies: FederationDisclosurePolicyService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disclosures = new FederationDisclosureService(db, signing);
    this.policies = new FederationDisclosurePolicyService(db, signing);
  }
  async scope(
    tx: PgTransaction,
    query: Pick<CommercialDisclosureReadQuery, "scope" | "senderSiteId">,
  ) {
    const scope = query.scope;
    const [local] = await tx
      .select()
      .from(disclosures)
      .where(
        and(
          eq(disclosures.localSiteId, this.signing.siteId),
          eq(disclosures.grantId, scope.grantId),
          eq(disclosures.agreementRevisionId, scope.agreementRevisionId),
        ),
      );
    if (!local || local.recipientSiteId !== query.senderSiteId)
      throw new FederationError("POLICY_DENIED");
    const record = await this.disclosures.exchangeRecord(
      tx,
      local.localOrgId,
      scope.agreementRevisionId,
      scope.grantId,
    );
    if (!record?.row.counterpartyJws) throw new FederationError("POLICY_DENIED");
    const policy = await this.policies.verified(
      tx,
      { orgId: local.localOrgId },
      scope.agreementRevisionId,
      scope.policyId,
    );
    const g = record.row.payload.grant;
    const expected = CommercialDisclosureReadScopeSchema.parse({
      grantId: g.grantId,
      disclosureDigest: record.row.digest,
      caseId: g.caseId,
      policyId: g.policyId,
      policyDigest: g.policyDigest,
      domainId: g.domainId,
      agreementRevisionId: g.agreementRevisionId,
      agreementDigest: policy.row.payload.agreementDigest,
      sourceSiteId: g.sourceSiteId,
      targetSiteId: g.targetSiteId,
      evidenceRecipientSiteId: g.recipientSiteId,
    });
    if (federationCanonicalJson(expected) !== federationCanonicalJson(scope))
      throw new FederationError("POLICY_DENIED");
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, scope.agreementRevisionId),
          eq(contracts.localOrgId, local.localOrgId),
        ),
      );
    if (!contract?.counterpartyJws) throw new FederationError("POLICY_DENIED");
    let until = Math.min(Date.parse(g.validUntil), Date.parse(policy.row.payload.validUntil));
    // A response cannot outlive the signatures that authorized this projection.
    for (const [siteId, jws] of [
      [this.signing.siteId, record.row.approvalJws],
      [record.other, record.row.counterpartyJws],
      [this.signing.siteId, policy.row.approvalJws],
      [record.other, policy.row.counterpartyJws],
      [this.signing.siteId, contract.approvalJws],
      [record.other, contract.counterpartyJws],
    ] as const) {
      if (!jws) throw new FederationError("POLICY_DENIED");
      const key = await this.trust.resolveKey(siteId, federationMessageKeyId(jws), new Date(), tx);
      until = Math.min(until, key.validUntil.getTime());
    }
    return { orgId: local.localOrgId, until, record: record.row, policy: policy.row };
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const verified = await verifyFederationMessage(
      CommercialDisclosureReadQuerySchema,
      jws,
      peer,
      new Date(),
    );
    const query = verified.payload;
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    assertFederationStatusQueryFresh(query, new Date());
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`disclosure-read:${this.signing.siteId}:${query.queryId}`}, 0))`,
      );
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx);
      await verifyFederationMessage(
        CommercialDisclosureReadQuerySchema,
        jws,
        currentPeer,
        new Date(),
      );
      const scope = await this.scope(tx, query);
      const [prior] = await tx
        .select()
        .from(authorizations)
        .where(
          and(
            eq(authorizations.localSiteId, this.signing.siteId),
            eq(authorizations.queryId, query.queryId),
          ),
        );
      if (
        prior &&
        (prior.queryDigest !== verified.digest ||
          federationCanonicalJson(prior.query) !== federationCanonicalJson(query))
      )
        throw new FederationError("OPERATION_CONFLICT");
      const keyId = prior ? federationMessageKeyId(prior.responseJws) : this.signing.keyId;
      await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
      const key = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
      const now = new Date();
      const until = Math.min(
        Date.parse(query.expiresAt),
        scope.until,
        key.validUntil.getTime(),
        currentPeer.validUntil.getTime(),
      );
      if (until <= now.getTime()) throw new FederationError("AUTHORIZATION_EXPIRED");
      if (prior) {
        const response = await verifyFederationMessage(
          CommercialDisclosureReadAuthorizationSchema,
          prior.responseJws,
          key,
          now,
        );
        assertCommercialDisclosureReadAuthorization(query, verified.digest, response.payload, now);
        if (
          Date.parse(response.payload.expiresAt) > until ||
          prior.expiresAt.getTime() !== Date.parse(response.payload.expiresAt)
        )
          throw new FederationError("AUTHORIZATION_EXPIRED");
        return prior.responseJws;
      }
      const response = CommercialDisclosureReadAuthorizationSchema.parse({
        ...query,
        kind: "commercial-disclosure-read-authorization",
        senderSiteId: this.signing.siteId,
        recipientSiteId: peer.siteId,
        queryDigest: verified.digest,
        issuedAt: now.toISOString(),
        expiresAt: new Date(Math.min(until, now.getTime() + 30000)).toISOString(),
      });
      const signed = await signFederationMessage(
        CommercialDisclosureReadAuthorizationSchema,
        response,
        this.signing,
      );
      await verifyFederationMessage(
        CommercialDisclosureReadAuthorizationSchema,
        signed,
        key,
        new Date(),
      );
      await this.scope(tx, query);
      assertCommercialDisclosureReadAuthorization(query, verified.digest, response, new Date());
      await tx.insert(authorizations).values({
        localSiteId: this.signing.siteId,
        queryId: query.queryId,
        grantId: query.scope.grantId,
        query,
        queryDigest: verified.digest,
        responseJws: signed,
        expiresAt: new Date(response.expiresAt),
      });
      await tx.insert(auditLog).values({
        actor: `disclosure-read:${this.signing.siteId}`,
        orgId: scope.orgId,
        action: "federation.disclosure.read_authorization",
        target: query.queryId,
        diff: {
          after: {
            grantId: query.scope.grantId,
            readId: query.readId,
            recipientSiteId: peer.siteId,
            queryDigest: verified.digest,
            expiresAt: response.expiresAt,
          },
        },
      });
      return signed;
    });
  }
}

/** The caller supplies the trusted local case selection. Both responses are required; no offline fallback. */
export class FederationDisclosureReadClient {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async endpoint(tx: PgTransaction, siteId: string) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("share");
    if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    return site.endpoint;
  }
  async request(rawScope: CommercialDisclosureReadScope) {
    const scope = CommercialDisclosureReadScopeSchema.parse(rawScope);
    if (scope.evidenceRecipientSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const prepared = await this.db.transaction(async (tx) => {
      const now = new Date();
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      const readId = randomUUID();
      const requests = [];
      for (const siteId of [scope.sourceSiteId, scope.targetSiteId]) {
        const endpoint = await this.endpoint(tx, siteId);
        const query = CommercialDisclosureReadQuerySchema.parse({
          protocolVersion: 1,
          kind: "commercial-disclosure-read-query",
          readId,
          queryId: randomUUID(),
          senderSiteId: this.signing.siteId,
          recipientSiteId: siteId,
          scope,
          issuedAt: now.toISOString(),
          expiresAt: new Date(
            Math.min(now.getTime() + 30000, key.validUntil.getTime()),
          ).toISOString(),
        });
        const jws = await signFederationMessage(
          CommercialDisclosureReadQuerySchema,
          query,
          this.signing,
        );
        const verified = await verifyFederationMessage(
          CommercialDisclosureReadQuerySchema,
          jws,
          key,
          new Date(),
        );
        requests.push({ query, queryDigest: verified.digest, jws, endpoint });
      }
      return { readId, requests };
    });
    const received = await Promise.allSettled(
      prepared.requests.map(async (request) => ({
        ...request,
        responseJws: await this.send(
          request.endpoint,
          request.jws,
          "/federation/v1/disclosure-authorizations",
        ),
      })),
    );
    const responses = received.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return this.db.transaction(async (tx) => {
      const results = [];
      for (const response of responses) {
        const now = new Date(),
          query = response.query;
        if ((await this.endpoint(tx, query.recipientSiteId)) !== response.endpoint)
          throw new FederationError("UNTRUSTED_IDENTITY");
        await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
        const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
        await verifyFederationMessage(CommercialDisclosureReadQuerySchema, response.jws, own, now);
        const keyId = federationMessageKeyId(response.responseJws);
        await this.trust.assertKey(tx, query.recipientSiteId, keyId, now);
        const key = await this.trust.resolveKey(query.recipientSiteId, keyId, now, tx);
        const verified = await verifyFederationMessage(
          CommercialDisclosureReadAuthorizationSchema,
          response.responseJws,
          key,
          now,
        );
        assertCommercialDisclosureReadAuthorization(
          query,
          response.queryDigest,
          verified.payload,
          now,
        );
        if (
          Date.parse(verified.payload.expiresAt) >
          Math.min(own.validUntil.getTime(), key.validUntil.getTime())
        )
          throw new FederationError("AUTHORIZATION_EXPIRED");
        results.push({
          queryJws: response.jws,
          authorizationJws: response.responseJws,
          authorization: verified.payload,
        });
      }
      // Recheck the pair after both verifications, including expiration during the second verification.
      for (const result of results)
        assertFederationStatusQueryFresh(result.authorization, new Date());
      return { readId: prepared.readId, scope, authorizations: results };
    });
  }
}

/** Current trust and both original query bindings, reused at download and recipient publication. */
export async function verifyDisclosureReadPair(
  tx: PgTransaction,
  trust: FederationTrustRegistry,
  scope: CommercialDisclosureReadScope,
  readId: string,
  pair: CommercialDisclosureReadPair,
) {
  let until = Number.POSITIVE_INFINITY;
  for (const [index, siteId] of [scope.sourceSiteId, scope.targetSiteId].entries()) {
    const entry = pair[index];
    if (!entry) throw new FederationError("POLICY_DENIED");
    const now = new Date();
    const queryKeyId = federationMessageKeyId(entry.queryJws),
      keyId = federationMessageKeyId(entry.authorizationJws);
    await trust.assertKey(tx, scope.evidenceRecipientSiteId, queryKeyId, now);
    await trust.assertKey(tx, siteId, keyId, now);
    const queryKey = await trust.resolveKey(scope.evidenceRecipientSiteId, queryKeyId, now, tx);
    const key = await trust.resolveKey(siteId, keyId, now, tx);
    const query = await verifyFederationMessage(
      CommercialDisclosureReadQuerySchema,
      entry.queryJws,
      queryKey,
      now,
    );
    const authorization = await verifyFederationMessage(
      CommercialDisclosureReadAuthorizationSchema,
      entry.authorizationJws,
      key,
      now,
    );
    if (
      query.payload.recipientSiteId !== siteId ||
      query.payload.readId !== readId ||
      federationCanonicalJson(query.payload.scope) !== federationCanonicalJson(scope)
    )
      throw new FederationError("POLICY_DENIED");
    assertCommercialDisclosureReadAuthorization(
      query.payload,
      query.digest,
      authorization.payload,
      now,
    );
    if (
      Date.parse(authorization.payload.expiresAt) >
      Math.min(queryKey.validUntil.getTime(), key.validUntil.getTime())
    )
      throw new FederationError("AUTHORIZATION_EXPIRED");
    until = Math.min(until, Date.parse(authorization.payload.expiresAt));
  }
  if (until <= Date.now()) throw new FederationError("AUTHORIZATION_EXPIRED");
  return until;
}
