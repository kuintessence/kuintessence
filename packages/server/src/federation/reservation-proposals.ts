import { createHash, randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationReservationPolicies as policies,
  federationReservationProposals as proposals,
  federationSites as sites,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  type CommercialReservation,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { ReservationProposalReceiptSchema } from "@kuintessence/shared/federation/reservation-proposal";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationCommercialExecutionService } from "./commercial-execution";
import { requireCoordinatedCommercialAgreement } from "./commercial-execution-policy";
import { allocateTaskCompletion } from "./completion-capacity";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import {
  type FederationActor,
  hasExplicitFederationCapability,
  requireFederationCapability,
} from "./permissions";
import { assertReservationCapacity } from "./reservation-capacity";
import { FederationReservationPolicyService } from "./reservation-policy";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { FederationTrustRegistry } from "./trust-registry";

import { assertUnreservedDemandOpen } from "./unreserved-closure";

type Proposal = typeof proposals.$inferSelect;
class ProposalLeaseLost extends Error {}
const wireDigest = (payload: CommercialReservation) =>
  `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
const progress = (row: Proposal) => ({
  reservationId: row.reservationId,
  agreementRevisionId: row.agreementRevisionId,
  policyId: row.policyId,
  direction: row.direction,
  state: row.state,
  digest: row.digest,
  createdAt: row.createdAt,
  approvedAt: row.approvedAt,
  deliveredAt: row.deliveredAt,
  nextAttemptAt: row.nextAttemptAt,
  executionState: row.executionState,
  executionError: row.executionError,
  executionNextAt: row.executionNextAt,
  activationId: row.activationId,
  confirmationId: row.confirmationId,
  lastError: row.lastError,
});

/** Durable proposals are separate from business approval, signature exchange and execution. */
export class FederationReservationProposalService {
  private readonly trust: FederationTrustRegistry;
  private readonly policies: FederationReservationPolicyService;
  private readonly execution: FederationCommercialExecutionService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
    market?: Pick<MarketClient, "query">,
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.policies = new FederationReservationPolicyService(db, signing.siteId);
    this.execution = new FederationCommercialExecutionService(
      db,
      signing,
      market,
      undefined,
      storageGuard,
    );
  }
  private key(reservationId: string) {
    return and(
      eq(proposals.localSiteId, this.signing.siteId),
      eq(proposals.reservationId, reservationId),
    );
  }
  private async contract(tx: PgTransaction, revisionId: string, orgId?: string) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, revisionId),
          orgId ? eq(contracts.localOrgId, orgId) : undefined,
        ),
      );
    if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return contract;
  }
  private assertSame(row: Proposal, payload: CommercialReservation, digest: string) {
    if (
      row.digest !== digest ||
      wireDigest(CommercialReservationSchema.parse(row.payload)) !== digest ||
      row.agreementRevisionId !== payload.request.agreementRevisionId
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private async room(tx: PgTransaction, policyId: string) {
    // Policy authorization holds its row lock, so simultaneous arrivals cannot exceed this bound.
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(proposals)
      .where(
        and(
          eq(proposals.policyId, policyId),
          isNull(proposals.approvedAt),
          sql`${proposals.state} <> 'closed'`,
        ),
      );
    if ((count?.count ?? 0) >= 128) throw new FederationError("POLICY_DENIED");
  }
  async submit(
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    raw: CommercialReservation,
  ) {
    return this.submitAuthorized(actor, revisionId, policyId, raw);
  }
  async submitPrepared(
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    raw: CommercialReservation,
    guard: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.submitAuthorized(actor, revisionId, policyId, raw, guard);
  }
  private async submitAuthorized(
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    raw: CommercialReservation,
    guard?: (tx: PgTransaction) => Promise<void>,
  ) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    const payload = CommercialReservationSchema.parse(raw),
      digest = wireDigest(payload);
    if (
      payload.request.senderSiteId !== this.signing.siteId ||
      payload.request.agreementRevisionId !== revisionId
    )
      throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      if (guard) await guard(tx);
      else {
        await requireFederationCapability(tx, actor, "delegation.submit");
        if (!(await hasExplicitFederationCapability(tx, actor, "delegation.submit")))
          throw new FederationError("POLICY_DENIED");
      }
      await this.contract(tx, revisionId, actor.orgId);
      const [existing] = await tx.select().from(proposals).where(this.key(payload.reservationId));
      if (existing) {
        this.assertSame(existing, payload, digest);
        if (
          existing.localOrgId !== actor.orgId ||
          existing.policyId !== policyId ||
          existing.direction !== "outbound"
        )
          throw new FederationError("OPERATION_CONFLICT");
        return progress(existing);
      }
      await assertReservationCapacity(
        tx,
        this.signing.siteId,
        actor.orgId,
        payload,
        this.storageGuard,
      );
      await allocateTaskCompletion(tx, this.signing.siteId, payload.request, this.storageGuard);
      await this.policies.authorize(tx, policyId, actor.orgId, payload);
      await this.execution.validatePreauthorizedIntent(tx, actor.orgId, payload);
      await this.room(tx, policyId);
      const [saved] = await tx
        .insert(proposals)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          reservationId: payload.reservationId,
          direction: "outbound",
          policyId,
          payload,
          digest,
          requestedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!saved) {
        const [original] = await tx.select().from(proposals).where(this.key(payload.reservationId));
        if (
          !original ||
          original.policyId !== policyId ||
          original.localOrgId !== actor.orgId ||
          original.direction !== "outbound"
        )
          throw new FederationError("OPERATION_CONFLICT");
        this.assertSame(original, payload, digest);
        return progress(original);
      }
      await tx.insert(auditLog).values({
        actor: guard ? `market-request:${payload.reservationId}` : actor.userId,
        orgId: actor.orgId,
        action: "federation.reservation_proposal.submit",
        target: payload.reservationId,
        diff: { after: { digest, policyId } },
      });
      return progress(saved);
    });
  }
  async receive(jws: string, fingerprint: string) {
    const sender = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      new Date(),
    );
    const verified = await verifyFederationMessage(
      CommercialReservationSchema,
      jws,
      sender,
      new Date(),
    );
    const payload = verified.payload;
    if (
      payload.request.senderSiteId !== sender.siteId ||
      payload.request.recipientSiteId !== this.signing.siteId
    )
      throw new FederationError("UNTRUSTED_IDENTITY");
    if (wireDigest(payload) !== verified.digest) throw new FederationError("OPERATION_CONFLICT");
    return this.db.transaction(async (tx) => {
      await assertUnreservedDemandOpen(tx, this.signing.siteId, payload.demandId);
      for (const site of [sender.siteId, this.signing.siteId].sort()) {
        if (site === sender.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, sender.keyId, new Date());
        else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      }
      const peer = await this.trust.resolveKey(sender.siteId, sender.keyId, new Date(), tx);
      await verifyFederationMessage(CommercialReservationSchema, jws, peer, new Date());
      let [row] = await tx.select().from(proposals).where(this.key(payload.reservationId));
      if (!row) {
        const contract = await this.contract(tx, payload.request.agreementRevisionId);
        const [policy] = await tx
          .select()
          .from(policies)
          .where(
            and(
              eq(policies.localSiteId, this.signing.siteId),
              eq(policies.localOrgId, contract.localOrgId),
              eq(policies.agreementRevisionId, contract.revisionId),
              isNull(policies.revokedAt),
            ),
          );
        if (!policy) throw new FederationError("POLICY_DENIED");
        await assertReservationCapacity(
          tx,
          this.signing.siteId,
          contract.localOrgId,
          payload,
          this.storageGuard,
        );
        await allocateTaskCompletion(tx, this.signing.siteId, payload.request, this.storageGuard);
        await this.trust.assertPeer(tx, fingerprint, sender.siteId, sender.keyId, new Date());
        await verifyFederationMessage(CommercialReservationSchema, jws, peer, new Date());
        await this.policies.authorize(tx, policy.id, contract.localOrgId, payload);
        await this.execution.validatePreauthorizedIntent(tx, contract.localOrgId, payload);
        await this.room(tx, policy.id);
        [row] = await tx
          .insert(proposals)
          .values({
            localSiteId: this.signing.siteId,
            localOrgId: contract.localOrgId,
            agreementRevisionId: contract.revisionId,
            reservationId: payload.reservationId,
            policyId: policy.id,
            direction: "inbound",
            payload,
            digest: verified.digest,
            sourceJws: jws,
            sourceFingerprint: fingerprint,
          })
          .onConflictDoNothing()
          .returning();
        if (row)
          await tx.insert(auditLog).values({
            actor: `reservation-proposal:${sender.siteId}`,
            orgId: contract.localOrgId,
            action: "federation.reservation_proposal.receive",
            target: payload.reservationId,
            diff: { after: { digest: verified.digest, policyId: policy.id } },
          });
        else [row] = await tx.select().from(proposals).where(this.key(payload.reservationId));
      }
      if (!row || row.direction !== "inbound" || row.sourceJws !== jws)
        throw new FederationError("OPERATION_CONFLICT");
      this.assertSame(row, payload, verified.digest);
      const receipt = ReservationProposalReceiptSchema.parse({
        protocolVersion: 1,
        kind: "reservation-proposal-receipt",
        senderSiteId: this.signing.siteId,
        recipientSiteId: sender.siteId,
        agreementRevisionId: row.agreementRevisionId,
        reservationId: row.reservationId,
        proposalDigest: row.digest,
        receivedAt: row.createdAt.toISOString(),
      });
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const signed = await signFederationMessage(
        ReservationProposalReceiptSchema,
        receipt,
        this.signing,
      );
      await verifyFederationMessage(ReservationProposalReceiptSchema, signed, own, new Date());
      return signed;
    });
  }
  private async lock(tx: PgTransaction, claim: Proposal) {
    if (!claim.leaseToken) throw new ProposalLeaseLost();
    const [row] = await tx
      .select()
      .from(proposals)
      .where(
        and(
          this.key(claim.reservationId),
          eq(proposals.leaseToken, claim.leaseToken),
          eq(proposals.state, claim.state),
          sql`${proposals.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new ProposalLeaseLost();
    this.assertSame(row, claim.payload, claim.digest);
    if (
      row.policyId !== claim.policyId ||
      row.sourceJws !== claim.sourceJws ||
      row.sourceFingerprint !== claim.sourceFingerprint ||
      row.direction !== claim.direction ||
      row.localOrgId !== claim.localOrgId
    )
      throw new FederationError("OPERATION_CONFLICT");
    return row;
  }
  private async approve(claim: Proposal) {
    await this.execution.approvePreauthorized(
      claim.policyId,
      claim.payload,
      claim.direction === "inbound" ? (claim.sourceJws ?? undefined) : undefined,
      {
        authorize: async (tx) => {
          await this.lock(tx, claim);
          if (claim.direction === "inbound") {
            if (!claim.sourceJws || !claim.sourceFingerprint)
              throw new FederationError("UNTRUSTED_IDENTITY");
            await this.trust.assertPeer(
              tx,
              claim.sourceFingerprint,
              claim.payload.request.senderSiteId,
              federationMessageKeyId(claim.sourceJws),
              new Date(),
            );
          }
        },
        complete: async (tx, approval) => {
          await this.lock(tx, claim);
          if (approval.digest !== claim.digest || approval.localOrgId !== claim.localOrgId)
            throw new FederationError("OPERATION_CONFLICT");
          await tx
            .update(proposals)
            .set({
              state: claim.direction === "outbound" ? "sending" : "approved",
              sourceJws: claim.direction === "outbound" ? approval.approvalJws : claim.sourceJws,
              approvedAt: approval.createdAt,
              leaseToken: null,
              leaseUntil: null,
              lastError: null,
              nextAttemptAt: new Date(),
            })
            .where(this.key(claim.reservationId));
          await tx.insert(auditLog).values({
            actor: `reservation-policy:${claim.policyId}`,
            orgId: claim.localOrgId,
            action: "federation.reservation_proposal.approve",
            target: claim.reservationId,
            diff: { after: { digest: claim.digest, policyId: claim.policyId } },
          });
        },
      },
    );
  }
  private async source(tx: PgTransaction, claim: Proposal, endpoint?: string) {
    const row = await this.lock(tx, claim);
    if (!row.sourceJws || row.direction !== "outbound")
      throw new FederationError("OPERATION_CONFLICT");
    const source = row.payload.request.senderSiteId,
      target = row.payload.request.recipientSiteId;
    if (source !== this.signing.siteId) throw new FederationError("POLICY_DENIED");
    const keyId = federationMessageKeyId(row.sourceJws);
    await this.trust.assertKey(tx, source, keyId, new Date());
    const [peer] = await tx.select().from(sites).where(eq(sites.id, target)).for("share");
    if (peer?.state !== "active" || (endpoint && peer.endpoint !== endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const key = await this.trust.resolveKey(source, keyId, new Date(), tx);
    const verified = await verifyFederationMessage(
      CommercialReservationSchema,
      row.sourceJws,
      key,
      new Date(),
    );
    if (verified.digest !== row.digest || Date.parse(row.payload.request.expiresAt) <= Date.now())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.recordId, row.reservationId),
          eq(approvals.localOrgId, row.localOrgId),
          eq(approvals.agreementRevisionId, row.agreementRevisionId),
        ),
      )
      .for("share");
    if (approval?.approvalJws !== row.sourceJws || approval.digest !== row.digest)
      throw new FederationError("OPERATION_CONFLICT");
    const contract = await this.contract(tx, row.agreementRevisionId, row.localOrgId);
    await requireCoordinatedCommercialAgreement(
      tx,
      this.trust,
      this.signing.siteId,
      row.localOrgId,
      CommercialAgreementSchema.parse(contract.terms).agreement,
      () => new Date(),
    );
    await this.execution.validatePreauthorizedIntent(tx, row.localOrgId, row.payload);
    return { ...row, sourceJws: row.sourceJws, endpoint: peer.endpoint };
  }
  private async deliver(claim: Proposal) {
    if (!this.send) throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    const scope = await this.db.transaction((tx) => this.source(tx, claim));
    const response = await this.send(
      scope.endpoint,
      scope.sourceJws,
      "/federation/v1/reservation-proposals",
    );
    await this.db.transaction(async (tx) => {
      await this.source(tx, claim, scope.endpoint);
      const peerSite = scope.payload.request.recipientSiteId,
        keyId = federationMessageKeyId(response);
      await this.trust.assertKey(tx, peerSite, keyId, new Date());
      const key = await this.trust.resolveKey(peerSite, keyId, new Date(), tx);
      const { payload: receipt } = await verifyFederationMessage(
        ReservationProposalReceiptSchema,
        response,
        key,
        new Date(),
      );
      if (
        receipt.senderSiteId !== peerSite ||
        receipt.recipientSiteId !== this.signing.siteId ||
        receipt.agreementRevisionId !== scope.agreementRevisionId ||
        receipt.reservationId !== scope.reservationId ||
        receipt.proposalDigest !== scope.digest ||
        Date.parse(receipt.receivedAt) > Date.now() + 60_000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(proposals)
        .set({
          state: "delivered",
          receiptJws: response,
          deliveredAt: new Date(),
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(claim.reservationId));
      await tx.insert(auditLog).values({
        actor: `reservation-proposal:${this.signing.siteId}`,
        orgId: scope.localOrgId,
        action: "federation.reservation_proposal.deliver",
        target: scope.reservationId,
        diff: { after: { digest: scope.digest } },
      });
    });
  }
  async advanceNext() {
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.localSiteId, this.signing.siteId),
            sql`${proposals.state} IN ('pending','sending')`,
            this.send ? undefined : eq(proposals.direction, "inbound"),
            sql`${proposals.nextAttemptAt} <= clock_timestamp()`,
            sql`(${proposals.leaseUntil} IS NULL OR ${proposals.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(proposals.nextAttemptAt), asc(proposals.reservationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(proposals)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.reservationId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      if (claim.state === "pending") await this.approve(claim);
      else await this.deliver(claim);
    } catch (error) {
      if (error instanceof ProposalLeaseLost || !claim.leaseToken) return true;
      const review =
        (error instanceof FederationError && error.code !== "STORAGE_PRESSURE") ||
        error instanceof z.ZodError ||
        (error instanceof FabricClientFailure && error.needsReview) ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(proposals)
        .set({
          state: review ? "needs_review" : claim.state,
          lastError:
            error instanceof FederationError ||
            error instanceof FabricClientFailure ||
            error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "PROPOSAL_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.reservationId),
            eq(proposals.leaseToken, claim.leaseToken),
            sql`${proposals.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, revisionId, actor.orgId);
      const rows = await tx
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.localSiteId, this.signing.siteId),
            eq(proposals.localOrgId, actor.orgId),
            eq(proposals.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(proposals.createdAt), desc(proposals.reservationId))
        .limit(limit)
        .offset(offset);
      return { sendEnabled: !!this.send, records: rows.map(progress) };
    });
  }
  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [row] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            this.key(reservationId),
            eq(proposals.localOrgId, actor.orgId),
            eq(proposals.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      await assertUnreservedDemandOpen(tx, this.signing.siteId, row.payload.demandId);
      if (
        ["approved", "delivered"].includes(row.state) ||
        (row.leaseUntil && row.leaseUntil > new Date())
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (row.direction === "outbound" && !this.send)
        throw new FederationError("ASSET_UNAVAILABLE");
      if (!row.approvedAt)
        await this.policies.authorize(tx, row.policyId, row.localOrgId, row.payload);
      const [saved] = await tx
        .update(proposals)
        .set({
          state: row.approvedAt ? "sending" : "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(),
        })
        .where(this.key(reservationId))
        .returning();
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.reservation_proposal.retry",
        target: reservationId,
        diff: { after: { policyId: row.policyId } },
      });
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return progress(saved);
    });
  }
}
