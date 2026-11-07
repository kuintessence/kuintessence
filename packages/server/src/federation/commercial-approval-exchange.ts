import { randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationSites as sites,
  federationCommercialApprovalSyncs as syncs,
} from "@kuintessence/db";
import { assertFederationStatusQueryFresh, FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialExecutionApprovalSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialApprovalQuerySchema,
  CommercialApprovalWaitingSchema,
} from "@kuintessence/shared/federation/commercial-approval-exchange";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialExecutionService } from "./commercial-execution";
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
type Identity = Pick<Sync, "agreementRevisionId" | "recordKind" | "recordId">;
const businessSchema = z.union([CommercialAgreementSchema, CommercialExecutionApprovalSchema]);
const responseSchema = z.union([businessSchema, CommercialApprovalWaitingSchema]);
class ApprovalLeaseLost extends Error {}

/** Exchanges only existing signatures for the identical record; never creates business approval. */
export class FederationCommercialApprovalExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(identity: Pick<Sync, "recordKind" | "recordId">) {
    return and(
      eq(syncs.localSiteId, this.signing.siteId),
      eq(syncs.recordKind, identity.recordKind),
      eq(syncs.recordId, identity.recordId),
    );
  }

  private async record(tx: PgTransaction, identity: Identity) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, identity.agreementRevisionId),
        ),
      )
      .for("share");
    if (!contract) return null;
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const other =
      terms.agreement.sourceSiteId === this.signing.siteId
        ? terms.agreement.targetSiteId
        : terms.agreement.sourceSiteId;
    if (![terms.agreement.sourceSiteId, terms.agreement.targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    if (identity.recordKind !== "release" && Date.parse(terms.agreement.validUntil) <= Date.now())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (identity.recordKind === "agreement") {
      if (identity.recordId !== identity.agreementRevisionId)
        throw new FederationError("INVALID_MESSAGE");
      return {
        contract,
        other,
        payload: terms,
        digest: contract.digest,
        approvalJws: contract.approvalJws,
        counterpartyJws: contract.counterpartyJws,
      };
    }
    const [record] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.recordId, identity.recordId),
          eq(approvals.agreementRevisionId, identity.agreementRevisionId),
          eq(approvals.localOrgId, contract.localOrgId),
        ),
      )
      .for("share");
    if (!record) return null;
    const payload = CommercialExecutionApprovalSchema.parse(record.payload);
    if (
      payload.kind !== `commercial-${identity.recordKind}` ||
      payload.domainId !== terms.domainId ||
      !contract.counterpartyJws ||
      terms.agreement.mode !== "ledger_coordinated"
    )
      throw new FederationError("OPERATION_CONFLICT");
    const source =
      payload.kind === "commercial-reservation"
        ? payload.request.senderSiteId
        : payload.sourceSiteId;
    const target =
      payload.kind === "commercial-reservation"
        ? payload.request.recipientSiteId
        : payload.targetSiteId;
    if (source !== terms.agreement.sourceSiteId || target !== terms.agreement.targetSiteId)
      throw new FederationError("OPERATION_CONFLICT");
    if (
      payload.kind === "commercial-reservation" &&
      (payload.reservationId !== identity.recordId ||
        payload.request.agreementRevisionId !== identity.agreementRevisionId ||
        payload.agreementDigest !== contract.digest)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (payload.kind === "commercial-release" && payload.releaseId !== identity.recordId)
      throw new FederationError("OPERATION_CONFLICT");
    return {
      contract,
      other,
      payload,
      digest: record.digest,
      approvalJws: record.approvalJws,
      counterpartyJws: record.counterpartyJws,
    };
  }

  async receive(jws: string, fingerprint: string) {
    const sender = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      new Date(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      CommercialApprovalQuerySchema,
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
      await verifyFederationMessage(CommercialApprovalQuerySchema, jws, peer, new Date());
      assertFederationStatusQueryFresh(query, new Date());
      const record = await this.record(tx, query);
      if (!record) {
        const own = await this.trust.resolveKey(
          this.signing.siteId,
          this.signing.keyId,
          new Date(),
          tx,
        );
        const { kind: _kind, issuedAt: _issued, expiresAt: _expires, ...identity } = query;
        const response = CommercialApprovalWaitingSchema.parse({
          ...identity,
          kind: "commercial-approval-waiting",
          senderSiteId: this.signing.siteId,
          recipientSiteId: sender.siteId,
          queryDigest: digest,
          observedAt: new Date().toISOString(),
        });
        const signed = await signFederationMessage(
          CommercialApprovalWaitingSchema,
          response,
          this.signing,
        );
        await verifyFederationMessage(CommercialApprovalWaitingSchema, signed, own, new Date());
        assertFederationStatusQueryFresh(query, new Date());
        return signed;
      }
      if (record.other !== sender.siteId) throw new FederationError("POLICY_DENIED");
      if (record.digest !== query.recordDigest || record.payload.domainId !== query.domainId)
        throw new FederationError("OPERATION_CONFLICT");
      const keyId = federationMessageKeyId(record.approvalJws);
      await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
      const own = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(
        businessSchema,
        record.approvalJws,
        own,
        new Date(),
      );
      if (
        verified.digest !== record.digest ||
        federationMaterialDigest(verified.payload) !== federationMaterialDigest(record.payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      assertFederationStatusQueryFresh(query, new Date());
      return record.approvalJws;
    });
  }

  async discover() {
    if (!this.send) return;
    const agreements = await this.db
      .select({
        localSiteId: contracts.localSiteId,
        agreementRevisionId: contracts.revisionId,
        recordId: contracts.revisionId,
      })
      .from(contracts)
      .leftJoin(
        syncs,
        and(
          eq(syncs.localSiteId, contracts.localSiteId),
          eq(syncs.recordKind, "agreement"),
          eq(syncs.recordId, contracts.revisionId),
        ),
      )
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          isNull(contracts.counterpartyJws),
          isNull(syncs.recordId),
        ),
      )
      .orderBy(asc(contracts.revisionId))
      .limit(8);
    if (agreements.length)
      await this.db
        .insert(syncs)
        .values(agreements.map((v) => ({ ...v, recordKind: "agreement" as const })))
        .onConflictDoNothing();
    const executions = await this.db
      .select({
        localSiteId: approvals.localSiteId,
        agreementRevisionId: approvals.agreementRevisionId,
        recordId: approvals.recordId,
        payload: approvals.payload,
      })
      .from(approvals)
      .leftJoin(
        syncs,
        and(
          eq(syncs.localSiteId, approvals.localSiteId),
          eq(syncs.recordId, approvals.recordId),
          sql`'commercial-' || ${syncs.recordKind} = ${approvals.payload}->>'kind'`,
        ),
      )
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          isNull(approvals.counterpartyJws),
          isNull(syncs.recordId),
        ),
      )
      .orderBy(asc(approvals.recordId))
      .limit(8);
    if (executions.length)
      await this.db
        .insert(syncs)
        .values(
          executions.map(({ payload, ...v }) => ({
            ...v,
            recordKind:
              payload.kind === "commercial-reservation"
                ? ("reservation" as const)
                : ("release" as const),
          })),
        )
        .onConflictDoNothing();
  }

  private async lock(tx: PgTransaction, claim: Sync) {
    if (!claim.leaseToken) throw new ApprovalLeaseLost();
    const [row] = await tx
      .select()
      .from(syncs)
      .where(
        and(
          this.key(claim),
          eq(syncs.leaseToken, claim.leaseToken),
          sql`${syncs.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new ApprovalLeaseLost();
    return row;
  }

  private async source(tx: PgTransaction, claim: Sync, endpoint?: string) {
    const record = await this.record(tx, claim);
    if (!record) throw new FederationError("ASSET_UNAVAILABLE");
    const keyId = federationMessageKeyId(record.approvalJws);
    for (const site of [this.signing.siteId, record.other].sort()) {
      if (site === this.signing.siteId) {
        await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
        await this.trust.assertKey(tx, site, keyId, new Date());
      } else {
        const [peer] = await tx.select().from(sites).where(eq(sites.id, site)).for("share");
        if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
          throw new FederationError("UNTRUSTED_IDENTITY");
      }
    }
    const own = await this.trust.resolveKey(
      this.signing.siteId,
      this.signing.keyId,
      new Date(),
      tx,
    );
    if (!own.allowedKinds.includes("commercial-approval-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const business = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
    const verified = await verifyFederationMessage(
      businessSchema,
      record.approvalJws,
      business,
      new Date(),
    );
    if (
      verified.digest !== record.digest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(record.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [peer] = await tx.select().from(sites).where(eq(sites.id, record.other));
    if (!peer) throw new FederationError("UNTRUSTED_IDENTITY");
    return { ...record, endpoint: peer.endpoint };
  }

  private async advance(claim: Sync) {
    if (!this.send) return;
    const scope = await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      return this.source(tx, claim);
    });
    const query = CommercialApprovalQuerySchema.parse({
      protocolVersion: 1,
      kind: "commercial-approval-query",
      queryId: randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: scope.other,
      agreementRevisionId: claim.agreementRevisionId,
      domainId: scope.payload.domainId,
      recordKind: claim.recordKind,
      recordId: claim.recordId,
      recordDigest: scope.digest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date());
    const request = await signFederationMessage(CommercialApprovalQuerySchema, query, this.signing);
    const { digest } = await verifyFederationMessage(
      CommercialApprovalQuerySchema,
      request,
      own,
      new Date(),
    );
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.source(tx, claim, scope.endpoint);
    });
    const response =
      scope.counterpartyJws ??
      (await this.send(scope.endpoint, request, "/federation/v1/commercial-approvals"));
    const peerId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(scope.other, peerId, new Date());
    const verified = await verifyFederationMessage(responseSchema, response, peer, new Date());
    const authorize = async (tx: PgTransaction, complete: boolean) => {
      await this.lock(tx, claim);
      const current = await this.source(tx, claim, scope.endpoint);
      if (current.digest !== scope.digest || current.approvalJws !== scope.approvalJws)
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, scope.other, peerId, new Date());
      const currentPeer = await this.trust.resolveKey(scope.other, peerId, new Date(), tx);
      await verifyFederationMessage(responseSchema, response, currentPeer, new Date());
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
        .where(this.key(claim));
    };
    if (verified.payload.kind === "commercial-approval-waiting") {
      const waiting = verified.payload;
      if (
        waiting.senderSiteId !== scope.other ||
        waiting.recipientSiteId !== this.signing.siteId ||
        waiting.queryDigest !== digest ||
        waiting.queryId !== query.queryId ||
        waiting.recordId !== query.recordId ||
        waiting.recordKind !== query.recordKind ||
        waiting.agreementRevisionId !== query.agreementRevisionId ||
        waiting.domainId !== query.domainId ||
        waiting.recordDigest !== query.recordDigest ||
        Date.parse(waiting.observedAt) < Date.parse(query.issuedAt) - 60000 ||
        Date.parse(waiting.observedAt) > Date.now() + 60000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.db.transaction((tx) => authorize(tx, false));
      return;
    }
    if (
      verified.digest !== scope.digest ||
      federationMaterialDigest(verified.payload) !== federationMaterialDigest(scope.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (claim.recordKind === "agreement")
      await new FederationCommercialAgreementService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        response,
        (tx) => authorize(tx, true),
      );
    else
      await new FederationCommercialExecutionService(this.db, this.signing).attachExchanged(
        claim.agreementRevisionId,
        claim.recordId,
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
        .orderBy(asc(syncs.nextAttemptAt), asc(syncs.recordKind), asc(syncs.recordId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(syncs)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof ApprovalLeaseLost || !claim.leaseToken) return true;
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
            this.key(claim),
            eq(syncs.leaseToken, claim.leaseToken),
            sql`${syncs.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }

  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const [contract] = await tx
        .select()
        .from(contracts)
        .where(
          and(
            eq(contracts.localSiteId, this.signing.siteId),
            eq(contracts.revisionId, revisionId),
            eq(contracts.localOrgId, actor.orgId),
          ),
        );
      if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const rows = await tx
        .select({
          recordKind: syncs.recordKind,
          recordId: syncs.recordId,
          state: syncs.state,
          lastError: syncs.lastError,
          nextAttemptAt: syncs.nextAttemptAt,
          verifiedAt: syncs.verifiedAt,
        })
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(asc(syncs.recordKind), asc(syncs.recordId))
        .limit(limit)
        .offset(offset);
      return { enabled: !!this.send, records: rows };
    });
  }
  async retry(actor: FederationActor, identity: Identity) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [existing] = await tx
        .select()
        .from(syncs)
        .where(and(this.key(identity), eq(syncs.agreementRevisionId, identity.agreementRevisionId)))
        .for("update");
      if (!existing) throw new FederationError("ASSET_UNAVAILABLE");
      const record = await this.record(tx, identity);
      if (!record || record.contract.localOrgId !== actor.orgId)
        throw new FederationError("POLICY_DENIED");
      const [row] = await tx
        .update(syncs)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(
          and(
            this.key(identity),
            eq(syncs.agreementRevisionId, identity.agreementRevisionId),
            sql`${syncs.state} <> 'complete'`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.exchange_retry",
        target: identity.recordId,
        diff: { after: { recordKind: identity.recordKind } },
      });
    });
  }
}
