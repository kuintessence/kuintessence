import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationEvidenceCases as cases,
  federationDisclosureDownloads as downloads,
  federationSites,
  type PgDb,
  type PgTransaction,
  federationReceivedDisclosures as received,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import {
  CommercialDisclosureDownloadQuerySchema,
  type CommercialDisclosureEvidence,
  CommercialDisclosureEvidenceSchema,
  CommercialDisclosurePartSchema,
  type CommercialDisclosureReadPair,
  CommercialDisclosureReadPairSchema,
  type CommercialDisclosureReadScope,
  CommercialDisclosureReadScopeSchema,
  type CommercialEvidenceCaseInput,
  CommercialEvidenceCaseInputSchema,
  verifyCommercialDisclosure,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  FederationDisclosureReadClient,
  FederationDisclosureReadResponder,
  verifyDisclosureReadPair,
} from "./disclosure-read";
import type { FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Return one immutable original at a time, retaining the existing bounded JOSE transport. */
export class FederationDisclosureDownloadResponder {
  private readonly trust: FederationTrustRegistry;
  private readonly reads: FederationDisclosureReadResponder;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.reads = new FederationDisclosureReadResponder(db, signing);
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const request = await verifyFederationMessage(
      CommercialDisclosureDownloadQuerySchema,
      jws,
      peer,
      new Date(),
    );
    const q = request.payload;
    if (q.senderSiteId !== peer.siteId || q.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`disclosure-download:${this.signing.siteId}:${q.queryId}`}, 0))`,
      );
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      const current = await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx);
      await verifyFederationMessage(
        CommercialDisclosureDownloadQuerySchema,
        jws,
        current,
        new Date(),
      );
      await verifyDisclosureReadPair(tx, this.trust, q.scope, q.readId, q.authorizations);
      const value = await this.reads.scope(tx, q);
      const record = q.part.startsWith("policy-") ? value.policy : value.record;
      const owner = q.part.endsWith("-source") ? q.scope.sourceSiteId : q.scope.targetSiteId;
      const original = owner === this.signing.siteId ? record.approvalJws : record.counterpartyJws;
      if (!original) throw new FederationError("POLICY_DENIED");
      const [prior] = await tx
        .select()
        .from(downloads)
        .where(
          and(eq(downloads.localSiteId, this.signing.siteId), eq(downloads.queryId, q.queryId)),
        );
      if (
        prior &&
        (prior.requestDigest !== request.digest ||
          prior.grantId !== q.scope.grantId ||
          prior.readId !== q.readId ||
          prior.part !== q.part)
      )
        throw new FederationError("OPERATION_CONFLICT");
      assertFederationStatusQueryFresh(q, new Date());
      if (!prior) {
        await tx.insert(downloads).values({
          localSiteId: this.signing.siteId,
          queryId: q.queryId,
          grantId: q.scope.grantId,
          readId: q.readId,
          part: q.part,
          requestDigest: request.digest,
        });
        await tx.insert(auditLog).values({
          actor: `disclosure-download:${this.signing.siteId}`,
          orgId: value.orgId,
          action: "federation.disclosure.download",
          target: q.queryId,
          diff: {
            after: {
              grantId: q.scope.grantId,
              readId: q.readId,
              part: q.part,
              recipientSiteId: peer.siteId,
              requestDigest: request.digest,
            },
          },
        });
      }
      // Expiry can change during audit I/O; keep publication inside the authorization transaction.
      await verifyDisclosureReadPair(tx, this.trust, q.scope, q.readId, q.authorizations);
      await this.reads.scope(tx, q);
      assertFederationStatusQueryFresh(q, new Date());
      return original;
    });
  }
}

/** Receiver organization scope is independent of A/B commercial ownership. Never reads cached values offline. */
export class FederationEvidenceService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(caseId: string) {
    return and(eq(cases.localSiteId, this.signing.siteId), eq(cases.caseId, caseId));
  }
  private async visible(tx: PgTransaction, actor: FederationActor, caseId: string, open = true) {
    await requireFederationCapability(tx, actor, "disclosure.receive");
    const [row] = await tx
      .select()
      .from(cases)
      .where(and(this.key(caseId), eq(cases.localOrgId, actor.orgId)))
      .for("share");
    if (!row || (open && row.closedAt)) throw new FederationError("POLICY_DENIED");
    return row;
  }
  private context(scope: CommercialDisclosureReadScope) {
    const {
      caseId,
      domainId,
      agreementRevisionId,
      agreementDigest,
      sourceSiteId,
      targetSiteId,
      evidenceRecipientSiteId,
    } = scope;
    return {
      caseId,
      domainId,
      agreementRevisionId,
      agreementDigest,
      sourceSiteId,
      targetSiteId,
      evidenceRecipientSiteId,
    };
  }
  async register(actor: FederationActor, raw: CommercialEvidenceCaseInput) {
    const context = CommercialEvidenceCaseInputSchema.parse(raw);
    if (context.evidenceRecipientSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.receive");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`evidence-case:${this.signing.siteId}:${context.caseId}`}, 0))`,
      );
      const [prior] = await tx.select().from(cases).where(this.key(context.caseId));
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          federationCanonicalJson(prior.context) !== federationCanonicalJson(context)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (prior.closedAt) throw new FederationError("POLICY_DENIED");
        return prior;
      }
      for (const siteId of [context.sourceSiteId, context.targetSiteId, this.signing.siteId]) {
        const [site] = await tx
          .select()
          .from(federationSites)
          .where(eq(federationSites.id, siteId))
          .for("share");
        if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      }
      const [row] = await tx
        .insert(cases)
        .values({
          localSiteId: this.signing.siteId,
          caseId: context.caseId,
          localOrgId: actor.orgId,
          context,
          createdBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.evidence.register",
        target: context.caseId,
      });
      return row;
    });
  }
  async close(actor: FederationActor, caseId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.receive");
      const [row] = await tx
        .select()
        .from(cases)
        .where(and(this.key(caseId), eq(cases.localOrgId, actor.orgId)))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.closedAt) return row;
      const [saved] = await tx
        .update(cases)
        .set({ closedAt: new Date() })
        .where(this.key(caseId))
        .returning();
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.evidence.close",
        target: caseId,
      });
      return saved;
    });
  }
  async list(actor: FederationActor, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "disclosure.receive");
      const rows = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.localSiteId, this.signing.siteId), eq(cases.localOrgId, actor.orgId)))
        .orderBy(desc(cases.createdAt), desc(cases.caseId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
  async materials(actor: FederationActor, caseId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId, false);
      const rows = await tx
        .select({ scope: received.scope, receivedAt: received.receivedAt })
        .from(received)
        .where(and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, caseId)))
        .orderBy(desc(received.receivedAt), desc(received.grantId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
  private async verify(
    tx: PgTransaction,
    scope: CommercialDisclosureReadScope,
    evidence: CommercialDisclosureEvidence,
    readId: string,
    pair: CommercialDisclosureReadPair,
  ) {
    await verifyDisclosureReadPair(tx, this.trust, scope, readId, pair);
    const keys = [];
    const names = new Set<string>();
    for (const env of [evidence.policy, evidence.disclosure]) {
      if (env.sourceSiteId !== scope.sourceSiteId || env.targetSiteId !== scope.targetSiteId)
        throw new FederationError("POLICY_DENIED");
      for (const [site, jws] of [
        [scope.sourceSiteId, env.sourceJws],
        [scope.targetSiteId, env.targetJws],
      ] as const) {
        const keyId = federationMessageKeyId(jws),
          name = `${site}:${keyId}`;
        if (!names.has(name)) {
          await this.trust.assertKey(tx, site, keyId, new Date());
          keys.push(await this.trust.resolveKey(site, keyId, new Date(), tx));
          names.add(name);
        }
      }
    }
    const key = keys.find(
      (k) =>
        k.siteId === scope.sourceSiteId &&
        k.keyId === federationMessageKeyId(evidence.disclosure.sourceJws),
    );
    if (!key) throw new FederationError("UNTRUSTED_IDENTITY");
    const source = await verifyFederationMessage(
      CommercialDisclosureSchema,
      evidence.disclosure.sourceJws,
      key,
      new Date(),
    );
    if (source.digest !== scope.disclosureDigest) throw new FederationError("OPERATION_CONFLICT");
    const g = source.payload.grant;
    const result = await verifyCommercialDisclosure(
      evidence.policy,
      evidence.disclosure,
      keys,
      {
        ...g,
        ...scope,
        recipientSiteId: scope.evidenceRecipientSiteId,
        policyRevoked: false,
        grantRevoked: false,
      },
      new Date(),
    );
    await verifyDisclosureReadPair(tx, this.trust, scope, readId, pair);
    return result.disclosure.payload;
  }
  async import(actor: FederationActor, caseId: string, rawScope: CommercialDisclosureReadScope) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    const scope = CommercialDisclosureReadScopeSchema.parse(rawScope);
    await this.db.transaction(async (tx) => {
      const row = await this.visible(tx, actor, caseId);
      if (
        caseId !== scope.caseId ||
        federationCanonicalJson(row.context) !== federationCanonicalJson(this.context(scope))
      )
        throw new FederationError("POLICY_DENIED");
    });
    const current = await new FederationDisclosureReadClient(
      this.db,
      this.signing,
      this.send,
    ).request(scope);
    const pair = CommercialDisclosureReadPairSchema.parse(
      current.authorizations.map(({ queryJws, authorizationJws }) => ({
        queryJws,
        authorizationJws,
      })),
    );
    const prepared = await this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId);
      const until = await verifyDisclosureReadPair(tx, this.trust, scope, current.readId, pair);
      const [site] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, scope.sourceSiteId))
        .for("share");
      if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const key = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const requests = [];
      for (const part of CommercialDisclosurePartSchema.options) {
        const now = new Date();
        const query = CommercialDisclosureDownloadQuerySchema.parse({
          protocolVersion: 1,
          kind: "commercial-disclosure-download-query",
          queryId: randomUUID(),
          readId: current.readId,
          senderSiteId: this.signing.siteId,
          recipientSiteId: scope.sourceSiteId,
          scope,
          authorizations: pair,
          part,
          issuedAt: now.toISOString(),
          expiresAt: new Date(Math.min(until, key.validUntil.getTime())).toISOString(),
        });
        const jws = await signFederationMessage(
          CommercialDisclosureDownloadQuerySchema,
          query,
          this.signing,
        );
        await verifyFederationMessage(
          CommercialDisclosureDownloadQuerySchema,
          jws,
          key,
          new Date(),
        );
        requests.push({ query, jws });
      }
      return { endpoint: site.endpoint, requests };
    });
    const parts = [];
    for (const request of prepared.requests)
      parts.push(
        await this.send(prepared.endpoint, request.jws, "/federation/v1/disclosure-downloads"),
      );
    const evidence = CommercialDisclosureEvidenceSchema.parse({
      policy: {
        sourceSiteId: scope.sourceSiteId,
        targetSiteId: scope.targetSiteId,
        sourceJws: parts[0],
        targetJws: parts[1],
      },
      disclosure: {
        sourceSiteId: scope.sourceSiteId,
        targetSiteId: scope.targetSiteId,
        sourceJws: parts[2],
        targetJws: parts[3],
      },
    });
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId);
      const [site] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, scope.sourceSiteId))
        .for("share");
      if (site?.state !== "active" || site.endpoint !== prepared.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const key = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      for (const request of prepared.requests) {
        await verifyFederationMessage(
          CommercialDisclosureDownloadQuerySchema,
          request.jws,
          key,
          new Date(),
        );
        assertFederationStatusQueryFresh(request.query, new Date());
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`received-disclosure:${this.signing.siteId}:${scope.grantId}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(received)
        .where(
          and(eq(received.localSiteId, this.signing.siteId), eq(received.grantId, scope.grantId)),
        );
      const payload = await this.verify(tx, scope, evidence, current.readId, pair);
      if (prior) {
        if (
          prior.caseId !== caseId ||
          federationCanonicalJson(prior.scope) !== federationCanonicalJson(scope) ||
          federationCanonicalJson(prior.evidence) !== federationCanonicalJson(evidence)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return payload;
      }
      await tx.insert(received).values({
        localSiteId: this.signing.siteId,
        grantId: scope.grantId,
        caseId,
        scope,
        evidence,
        receivedBy: actor.userId,
      });
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.evidence.receive",
        target: scope.grantId,
        diff: { after: { caseId, digest: scope.disclosureDigest, readId: current.readId } },
      });
      await this.verify(tx, scope, evidence, current.readId, pair);
      return payload;
    });
  }
  async read(actor: FederationActor, caseId: string, grantId: string) {
    const proof = await this.prepareRead(actor, caseId, grantId);
    return this.db.transaction(
      async (tx) => (await this.verifyRead(tx, actor, caseId, proof)).payload,
    );
  }
  async prepareRead(actor: FederationActor, caseId: string, grantId: string) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    const record = await this.db.transaction(async (tx) => {
      await this.visible(tx, actor, caseId);
      const [row] = await tx
        .select()
        .from(received)
        .where(
          and(
            eq(received.localSiteId, this.signing.siteId),
            eq(received.caseId, caseId),
            eq(received.grantId, grantId),
          ),
        );
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      return row;
    });
    const current = await new FederationDisclosureReadClient(
      this.db,
      this.signing,
      this.send,
    ).request(record.scope);
    const pair = CommercialDisclosureReadPairSchema.parse(
      current.authorizations.map(({ queryJws, authorizationJws }) => ({
        queryJws,
        authorizationJws,
      })),
    );
    return { record, current, pair };
  }
  async verifyRead(
    tx: PgTransaction,
    actor: FederationActor,
    caseId: string,
    proof: Awaited<ReturnType<FederationEvidenceService["prepareRead"]>>,
  ) {
    await this.visible(tx, actor, caseId);
    const { record, current, pair } = proof;
    if (record.caseId !== caseId || record.localSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const payload = await this.verify(tx, record.scope, record.evidence, current.readId, pair);
    let until = Math.min(
      Date.parse(payload.grant.validUntil),
      await verifyDisclosureReadPair(tx, this.trust, record.scope, current.readId, pair),
    );
    for (const envelope of [record.evidence.policy, record.evidence.disclosure]) {
      for (const [siteId, jws] of [
        [envelope.sourceSiteId, envelope.sourceJws],
        [envelope.targetSiteId, envelope.targetJws],
      ] as const) {
        const key = await this.trust.resolveKey(
          siteId,
          federationMessageKeyId(jws),
          new Date(),
          tx,
        );
        until = Math.min(until, key.validUntil.getTime());
      }
    }
    if (until <= Date.now()) throw new FederationError("AUTHORIZATION_EXPIRED");
    return {
      payload,
      digest: record.scope.disclosureDigest,
      expiresAt: new Date(until).toISOString(),
    };
  }
}
