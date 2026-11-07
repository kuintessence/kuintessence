import { randomUUID } from "node:crypto";
import {
  federationAgreementApprovals as approvals,
  auditLog,
  type PgDb,
  type PgTransaction,
  federationSites as sites,
  federationAgreementSyncs as syncs,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationAgreementSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import {
  AgreementApprovalQuerySchema,
  AgreementApprovalWaitingSchema,
} from "@kuintessence/shared/federation/agreement-exchange";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationAgreementService } from "./agreements";
import { federationMaterialDigest } from "./assets";
import { requireExecutionIdentity } from "./execution-identity";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Sync = typeof syncs.$inferSelect;
const responseSchema = z.union([FederationAgreementSchema, AgreementApprovalWaitingSchema]);
class AgreementLeaseLost extends Error {}

/** Transports existing institutional consent; neither creates approval nor chooses execution identities. */
export class FederationAgreementExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(revisionId: string) {
    return and(eq(syncs.localSiteId, this.signing.siteId), eq(syncs.revisionId, revisionId));
  }
  private async record(tx: PgTransaction, revisionId: string) {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.localSiteId, this.signing.siteId), eq(approvals.revisionId, revisionId)),
      )
      .for("share");
    if (!approval) return null;
    const terms = FederationAgreementSchema.parse(approval.terms);
    if (approval.state !== "active") throw new FederationError("AGREEMENT_UNAVAILABLE");
    if (
      terms.agreementRevisionId !== revisionId ||
      ![terms.sourceSiteId, terms.targetSiteId].includes(this.signing.siteId)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (Date.parse(terms.validUntil) <= Date.now())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (terms.targetSiteId === this.signing.siteId) {
      if (!approval.executionUserId) throw new FederationError("POLICY_DENIED");
      await requireExecutionIdentity(tx, {
        orgId: approval.localOrgId,
        userId: approval.executionUserId,
      });
    }
    const keyId = federationMessageKeyId(approval.approvalJws);
    await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
    const key = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
    const verified = await verifyFederationMessage(
      FederationAgreementSchema,
      approval.approvalJws,
      key,
      new Date(),
    );
    if (
      verified.digest !== approval.termsDigest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(terms)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return {
      ...approval,
      other: terms.sourceSiteId === this.signing.siteId ? terms.targetSiteId : terms.sourceSiteId,
    };
  }
  async receive(jws: string, fingerprint: string) {
    const sender = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      new Date(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      AgreementApprovalQuerySchema,
      jws,
      sender,
      new Date(),
    );
    if (query.senderSiteId !== sender.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      for (const site of [sender.siteId, this.signing.siteId].sort()) {
        if (site === sender.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, sender.keyId, new Date());
        else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      }
      const peer = await this.trust.resolveKey(sender.siteId, sender.keyId, new Date(), tx);
      await verifyFederationMessage(AgreementApprovalQuerySchema, jws, peer, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      const record = await this.record(tx, query.agreementRevisionId);
      if (record) {
        if (record.other !== sender.siteId) throw new FederationError("POLICY_DENIED");
        if (record.termsDigest !== query.agreementDigest)
          throw new FederationError("OPERATION_CONFLICT");
        assertFederationStatusQueryFresh(query, new Date());
        return record.approvalJws;
      }
      const { kind: _kind, issuedAt: _issued, expiresAt: _expires, ...identity } = query;
      const waiting = AgreementApprovalWaitingSchema.parse({
        ...identity,
        kind: "agreement-approval-waiting",
        senderSiteId: this.signing.siteId,
        recipientSiteId: sender.siteId,
        queryDigest: digest,
        observedAt: new Date().toISOString(),
      });
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const response = await signFederationMessage(
        AgreementApprovalWaitingSchema,
        waiting,
        this.signing,
      );
      await verifyFederationMessage(AgreementApprovalWaitingSchema, response, own, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      return response;
    });
  }
  async discover() {
    if (!this.send) return;
    const rows = await this.db
      .select({ localSiteId: approvals.localSiteId, revisionId: approvals.revisionId })
      .from(approvals)
      .leftJoin(
        syncs,
        and(
          eq(syncs.localSiteId, approvals.localSiteId),
          eq(syncs.revisionId, approvals.revisionId),
        ),
      )
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.state, "active"),
          isNull(approvals.counterpartyApprovalJws),
          isNull(syncs.revisionId),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.revisionId))
      .limit(8);
    if (rows.length) await this.db.insert(syncs).values(rows).onConflictDoNothing();
  }
  private async lock(tx: PgTransaction, claim: Sync) {
    if (!claim.leaseToken) throw new AgreementLeaseLost();
    const [row] = await tx
      .select()
      .from(syncs)
      .where(
        and(
          this.key(claim.revisionId),
          eq(syncs.state, "pending"),
          eq(syncs.leaseToken, claim.leaseToken),
          sql`${syncs.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new AgreementLeaseLost();
  }
  private async source(tx: PgTransaction, claim: Sync, endpoint?: string) {
    const record = await this.record(tx, claim.revisionId);
    if (!record) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const [peer] = await tx.select().from(sites).where(eq(sites.id, record.other)).for("share");
    if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
    const own = await this.trust.resolveKey(
      this.signing.siteId,
      this.signing.keyId,
      new Date(),
      tx,
    );
    if (!own.allowedKinds.includes("agreement-approval-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return { ...record, endpoint: peer.endpoint };
  }
  private async advance(claim: Sync) {
    if (!this.send) return;
    const scope = await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      return this.source(tx, claim);
    });
    const query = AgreementApprovalQuerySchema.parse({
      protocolVersion: 1,
      kind: "agreement-approval-query",
      queryId: randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: scope.other,
      agreementRevisionId: claim.revisionId,
      agreementDigest: scope.termsDigest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date());
    const request = await signFederationMessage(AgreementApprovalQuerySchema, query, this.signing);
    const { digest } = await verifyFederationMessage(
      AgreementApprovalQuerySchema,
      request,
      own,
      new Date(),
    );
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.source(tx, claim, scope.endpoint);
    });
    const response =
      scope.counterpartyApprovalJws ??
      (await this.send(scope.endpoint, request, "/federation/v1/agreement-approvals"));
    const peerId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(scope.other, peerId, new Date());
    const verified = await verifyFederationMessage(responseSchema, response, peer, new Date());
    const authorize = async (tx: PgTransaction, complete: boolean) => {
      await this.lock(tx, claim);
      const current = await this.source(tx, claim, scope.endpoint);
      if (
        current.termsDigest !== scope.termsDigest ||
        current.approvalJws !== scope.approvalJws ||
        current.localOrgId !== scope.localOrgId ||
        current.executionUserId !== scope.executionUserId
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, scope.other, peerId, new Date());
      const key = await this.trust.resolveKey(scope.other, peerId, new Date(), tx);
      await verifyFederationMessage(responseSchema, response, key, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      await tx
        .update(syncs)
        .set({
          state: complete ? "complete" : "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          verifiedAt: complete ? new Date() : null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(claim.revisionId));
    };
    if (verified.payload.kind === "agreement-approval-waiting") {
      const waiting = verified.payload;
      if (
        waiting.senderSiteId !== scope.other ||
        waiting.recipientSiteId !== this.signing.siteId ||
        waiting.queryId !== query.queryId ||
        waiting.queryDigest !== digest ||
        waiting.agreementRevisionId !== query.agreementRevisionId ||
        waiting.agreementDigest !== query.agreementDigest ||
        Date.parse(waiting.observedAt) < Date.parse(query.issuedAt) - 60000 ||
        Date.parse(waiting.observedAt) > Date.now() + 60000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.db.transaction((tx) => authorize(tx, false));
      return;
    }
    if (
      verified.digest !== scope.termsDigest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(scope.terms)
    )
      throw new FederationError("OPERATION_CONFLICT");
    await new FederationAgreementService(this.db, this.signing).attachExchanged(
      claim.revisionId,
      response,
      (tx) => authorize(tx, true),
    );
  }
  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.state, "pending"),
            sql`${syncs.nextAttemptAt} <= clock_timestamp()`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(syncs.nextAttemptAt), asc(syncs.revisionId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(syncs)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.revisionId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof AgreementLeaseLost || !claim.leaseToken) return true;
      const review =
        error instanceof FederationError ||
        error instanceof z.ZodError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(syncs)
        .set({
          state: review ? "needs_review" : "pending",
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "EXCHANGE_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.revisionId),
            eq(syncs.leaseToken, claim.leaseToken),
            sql`${syncs.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async status(actor: FederationActor, revisionId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const [record] = await tx
        .select({ id: approvals.revisionId })
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.signing.siteId),
            eq(approvals.revisionId, revisionId),
            eq(approvals.localOrgId, actor.orgId),
          ),
        );
      if (!record) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const [sync] = await tx
        .select({
          state: syncs.state,
          lastError: syncs.lastError,
          nextAttemptAt: syncs.nextAttemptAt,
          verifiedAt: syncs.verifiedAt,
        })
        .from(syncs)
        .where(this.key(revisionId));
      return { enabled: !!this.send, sync: sync ?? null };
    });
  }
  async retry(actor: FederationActor, revisionId: string) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [row] = await tx.select().from(syncs).where(this.key(revisionId)).for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      const record = await this.record(tx, revisionId);
      if (!record || record.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      if (row.state === "complete" || (row.leaseUntil && row.leaseUntil > new Date()))
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(syncs)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(revisionId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.agreement.exchange_retry",
        target: revisionId,
      });
    });
  }
}
