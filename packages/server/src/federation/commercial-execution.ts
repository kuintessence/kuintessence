import { createHash, randomUUID } from "node:crypto";
import {
  federationCommercialAgreements as agreements,
  federationCommercialExecutionApprovals as approvals,
  federationCommercialAttempts as attempts,
  auditLog,
  federationMarketSubmissions as marketSubmissions,
  type PgDb,
  type PgTransaction,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { assertDelegationTerms, FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  type CommercialExecutionApproval,
  CommercialExecutionApprovalSchema,
  CommercialExecutionProposalInputSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  MarketActivationSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

function identity(payload: CommercialExecutionApproval) {
  return payload.kind === "commercial-reservation"
    ? {
        recordId: payload.reservationId,
        operation: "reserve-execution" as const,
        sourceSiteId: payload.request.senderSiteId,
        targetSiteId: payload.request.recipientSiteId,
      }
    : {
        recordId: payload.releaseId,
        operation: "release-execution" as const,
        sourceSiteId: payload.sourceSiteId,
        targetSiteId: payload.targetSiteId,
      };
}

/** Business approval only. Neither a signature nor a committed reservation authorizes local execution. */
export class FederationCommercialExecutionService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly market?: Pick<MarketClient, "query">,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private scope(actor: FederationActor, revisionId: string) {
    return and(
      eq(approvals.localSiteId, this.signingKey.siteId),
      eq(approvals.localOrgId, actor.orgId),
      eq(approvals.agreementRevisionId, revisionId),
    );
  }
  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select()
      .from(agreements)
      .where(
        and(
          eq(agreements.localSiteId, this.signingKey.siteId),
          eq(agreements.localOrgId, actor.orgId),
          eq(agreements.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  private async local(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    recordId: string,
  ) {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(and(this.scope(actor, revisionId), eq(approvals.recordId, recordId)))
      .for("update");
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return row;
  }
  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      return tx
        .select()
        .from(approvals)
        .where(this.scope(actor, revisionId))
        .orderBy(desc(approvals.createdAt), desc(approvals.recordId))
        .limit(limit)
        .offset(offset);
    });
  }
  async get(actor: FederationActor, revisionId: string, recordId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const approval = await this.local(tx, actor, revisionId, recordId);
      const operation = identity(
        CommercialExecutionApprovalSchema.parse(approval.payload),
      ).operation;
      const [submission] = await tx
        .select({
          id: submissions.id,
          state: submissions.state,
          lastError: submissions.lastError,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signingKey.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`${submissions.input}->>'operation' = ${operation}`,
            sql`${submissions.input}->>'recordId' = ${recordId}`,
          ),
        );
      const [transaction] = submission
        ? await tx
            .select({
              transactionId: attempts.transactionId,
              stage: attempts.stage,
              validationCode: attempts.validationCode,
              blockNumber: attempts.blockNumber,
            })
            .from(attempts)
            .where(eq(attempts.submissionId, submission.id))
            .orderBy(desc(attempts.number))
            .limit(1)
        : [];
      const [stopSubmission] = approval.stopId
        ? await tx
            .select({
              id: marketSubmissions.id,
              state: marketSubmissions.state,
              lastError: marketSubmissions.lastError,
            })
            .from(marketSubmissions)
            .where(
              and(
                eq(marketSubmissions.id, approval.stopId),
                eq(marketSubmissions.localSiteId, this.signingKey.siteId),
                eq(marketSubmissions.localOrgId, actor.orgId),
              ),
            )
        : [];
      return {
        ...approval,
        submission: submission ? { ...submission, transaction: transaction ?? null } : null,
        stopSubmission: stopSubmission ?? null,
      };
    });
  }
  private async validate(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    payload: CommercialExecutionApproval,
  ) {
    const contract = await this.contract(tx, actor, revisionId);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const parties = identity(payload);
    if (
      !contract.counterpartyJws ||
      terms.agreement.mode !== "ledger_coordinated" ||
      terms.domainId !== payload.domainId ||
      terms.agreement.sourceSiteId !== parties.sourceSiteId ||
      terms.agreement.targetSiteId !== parties.targetSiteId ||
      ![parties.sourceSiteId, parties.targetSiteId].includes(this.signingKey.siteId)
    )
      throw new FederationError("POLICY_DENIED");
    if (payload.kind === "commercial-reservation") {
      const source = parties.sourceSiteId === this.signingKey.siteId;
      const [intent] = await tx
        .select({ input: marketSubmissions.input })
        .from(marketSubmissions)
        .where(
          and(
            eq(marketSubmissions.localSiteId, this.signingKey.siteId),
            eq(marketSubmissions.localOrgId, actor.orgId),
            eq(marketSubmissions.id, source ? payload.demandId : payload.reservationId),
            eq(marketSubmissions.demandId, payload.demandId),
            eq(marketSubmissions.state, "committed"),
          ),
        )
        .for("share");
      if (!intent || intent.input.operation !== (source ? "publish-demand" : "claim-demand"))
        throw new FederationError("ASSET_UNAVAILABLE");
      if (terms.consideration === "charity" && payload.request.maxAmount !== "0")
        throw new FederationError("POLICY_DENIED");
      if (payload.agreementDigest !== contract.digest)
        throw new FederationError("OPERATION_CONFLICT");
      assertDelegationTerms(terms.agreement, payload.request, this.clock());
      return payload;
    }
    if (Date.parse(payload.issuedAt) > this.clock().getTime() + 60000)
      throw new FederationError("INVALID_MESSAGE");
    const original = await this.local(tx, actor, revisionId, payload.reservationId);
    const reserve = CommercialExecutionApprovalSchema.parse(original.payload);
    if (
      !original.counterpartyJws ||
      reserve.kind !== "commercial-reservation" ||
      original.digest !== payload.reservationDigest ||
      payload.expectedGateVersion !== 1
    )
      throw new FederationError("OPERATION_CONFLICT");
    return reserve;
  }
  private async currentClaim(
    reserve: Extract<CommercialExecutionApproval, { kind: "commercial-reservation" }>,
  ) {
    if (!this.market) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const raw = await this.market
      .query({
        operation: "get-demand",
        demandId: reserve.demandId,
      })
      .catch((error: unknown) => {
        if (error instanceof z.ZodError)
          throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
        throw error;
      });
    const parsed = MarketQueryResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operation !== "get-demand")
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const result = parsed.data;
    if (!result.demand) throw new FederationError("ASSET_UNAVAILABLE");
    const state = result.demand;
    if (
      state.status !== "CLAIMED" ||
      state.version !== reserve.claimVersion ||
      state.demand.demandId !== reserve.demandId ||
      state.demand.sourceSiteId !== reserve.request.senderSiteId ||
      state.claim?.claimId !== reserve.reservationId ||
      state.claim.providerSiteId !== reserve.request.recipientSiteId ||
      state.claim.commercialDomainId !== reserve.domainId ||
      Object.entries(reserve.request.resources).some(
        ([key, value]) =>
          state.demand.resources[key as keyof typeof state.demand.resources] !== value,
      )
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (Date.parse(state.claim.expiresAt) < Date.parse(reserve.request.expiresAt))
      throw new FederationError("AUTHORIZATION_EXPIRED");
    // This is a preflight only; chaincode checks current state atomically when the signed request commits.
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialExecutionApproval) {
    const payload = CommercialExecutionApprovalSchema.parse(raw);
    const expectedDigest = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
    const snapshot = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [existing] = await tx
        .select()
        .from(approvals)
        .where(
          and(this.scope(actor, revisionId), eq(approvals.recordId, identity(payload).recordId)),
        );
      if (existing) {
        if (existing.digest !== expectedDigest) throw new FederationError("OPERATION_CONFLICT");
        return { existing, reserve: null };
      }
      return { existing: null, reserve: await this.validate(tx, actor, revisionId, payload) };
    });
    if (snapshot.existing) return snapshot.existing;
    if (!snapshot.reserve) throw new FederationError("INVALID_MESSAGE");
    await this.currentClaim(snapshot.reserve);
    const key = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!key.allowedKinds.includes(payload.kind)) throw new FederationError("UNTRUSTED_IDENTITY");
    const approvalJws = await signFederationMessage(
      CommercialExecutionApprovalSchema,
      payload,
      this.signingKey,
    );
    const { digest } = await verifyFederationMessage(
      CommercialExecutionApprovalSchema,
      approvalJws,
      key,
      this.clock(),
    );
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      await this.validate(tx, actor, revisionId, payload);
      const { recordId } = identity(payload);
      const [created] = await tx
        .insert(approvals)
        .values({
          localSiteId: this.signingKey.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          recordId,
          payload,
          digest,
          approvalJws,
          approvedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const existing = await this.local(tx, actor, revisionId, recordId);
        if (existing.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      await this.audit(tx, actor, "approve", recordId, digest);
      return created;
    });
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    recordId: string,
    counterpartyJws: string,
  ) {
    const local = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      return this.local(tx, actor, revisionId, recordId);
    });
    const payload = CommercialExecutionApprovalSchema.parse(local.payload);
    const parties = identity(payload);
    const ownIsSource = parties.sourceSiteId === this.signingKey.siteId;
    const other = ownIsSource ? parties.targetSiteId : parties.sourceSiteId;
    const keys = await Promise.all([
      this.trust.resolveKey(
        this.signingKey.siteId,
        federationMessageKeyId(local.approvalJws),
        this.clock(),
      ),
      this.trust.resolveKey(other, federationMessageKeyId(counterpartyJws), this.clock()),
    ]);
    for (const [index, jws] of [local.approvalJws, counterpartyJws].entries()) {
      const key = keys[index];
      if (!key) throw new FederationError("UNTRUSTED_IDENTITY");
      const result = await verifyFederationMessage(
        CommercialExecutionApprovalSchema,
        jws,
        key,
        this.clock(),
      );
      if (result.digest !== local.digest) throw new FederationError("OPERATION_CONFLICT");
    }
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      for (const key of keys.sort((a, b) => a.siteId.localeCompare(b.siteId)))
        await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      const current = await this.local(tx, actor, revisionId, recordId);
      if (current.counterpartyJws) {
        if (current.counterpartyJws !== counterpartyJws)
          throw new FederationError("OPERATION_CONFLICT");
        return current;
      }
      await this.validate(tx, actor, revisionId, payload);
      const [updated] = await tx
        .update(approvals)
        .set({ counterpartyJws })
        .where(and(this.scope(actor, revisionId), eq(approvals.recordId, recordId)))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signingKey.siteId,
        agreementRevisionId: revisionId,
        input: CommercialExecutionProposalInputSchema.parse({
          operation: parties.operation,
          domainId: payload.domainId,
          recordId,
          digest: local.digest,
          envelope: {
            sourceSiteId: parties.sourceSiteId,
            targetSiteId: parties.targetSiteId,
            sourceJws: ownIsSource ? local.approvalJws : counterpartyJws,
            targetJws: ownIsSource ? counterpartyJws : local.approvalJws,
          },
        }),
      });
      await this.audit(tx, actor, "counterparty", recordId, local.digest);
      return updated;
    });
  }
  async activate(
    actor: FederationActor,
    revisionId: string,
    recordId: string,
    activationId: string,
  ) {
    z.uuid().parse(activationId);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await requireFederationCapability(tx, actor, "market.publish");
      const approval = await this.local(tx, actor, revisionId, recordId);
      const payload = CommercialExecutionApprovalSchema.parse(approval.payload);
      if (approval.stopId) throw new FederationError("CANCELLATION_REQUESTED");
      if (
        payload.kind !== "commercial-reservation" ||
        !approval.counterpartyJws ||
        payload.request.senderSiteId !== this.signingKey.siteId
      )
        throw new FederationError("POLICY_DENIED");
      const input = {
        operation: "activate-demand" as const,
        activation: MarketActivationSchema.parse({
          activationId,
          demandId: payload.demandId,
          expectedVersion: payload.claimVersion,
          gate: {
            domainId: payload.domainId,
            reservationId: payload.reservationId,
            demandId: payload.demandId,
            claimVersion: payload.claimVersion,
            version: 1,
            state: "READY",
            reservationDigest: approval.digest,
            expiresAt: payload.request.expiresAt,
          },
        }),
      };
      const digest = federationMaterialDigest(input);
      const [prior] = await tx
        .select()
        .from(marketSubmissions)
        .where(eq(marketSubmissions.id, activationId));
      if (prior) {
        if (prior.localSiteId !== this.signingKey.siteId || prior.localOrgId !== actor.orgId)
          throw new FederationError("POLICY_DENIED");
        if (prior.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return { id: prior.id, demandId: prior.demandId, state: prior.state };
      }
      await this.validate(tx, actor, revisionId, payload);
      const [reservation] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signingKey.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            eq(submissions.state, "committed"),
            sql`${submissions.input}->>'operation' = 'reserve-execution'`,
            sql`${submissions.input}->>'recordId' = ${recordId}`,
            sql`${submissions.input}->>'digest' = ${approval.digest}`,
          ),
        )
        .for("share");
      if (!reservation) throw new FederationError("LEDGER_REQUIRED");
      const [release] = await tx
        .select({ recordId: approvals.recordId })
        .from(approvals)
        .where(
          and(
            this.scope(actor, revisionId),
            sql`${approvals.payload}->>'kind' = 'commercial-release'`,
            sql`${approvals.payload}->>'reservationId' = ${recordId}`,
            sql`${approvals.counterpartyJws} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (release) throw new FederationError("OPERATION_CONFLICT");
      const pairs = [
        { siteId: payload.request.senderSiteId, jws: approval.approvalJws },
        { siteId: payload.request.recipientSiteId, jws: approval.counterpartyJws },
      ].sort((a, b) => a.siteId.localeCompare(b.siteId));
      for (const { siteId, jws } of pairs) {
        const keyId = federationMessageKeyId(jws);
        await this.trust.assertKey(tx, siteId, keyId, this.clock());
        const key = await this.trust.resolveKey(siteId, keyId, this.clock(), tx);
        const verified = await verifyFederationMessage(
          CommercialExecutionApprovalSchema,
          jws,
          key,
          this.clock(),
        );
        if (verified.digest !== approval.digest) throw new FederationError("OPERATION_CONFLICT");
      }
      const [created] = await tx
        .insert(marketSubmissions)
        .values({
          id: activationId,
          localSiteId: this.signingKey.siteId,
          localOrgId: actor.orgId,
          requestedBy: actor.userId,
          demandId: payload.demandId,
          input,
          digest,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "activate", recordId, digest);
      return { id: created.id, demandId: created.demandId, state: created.state };
    });
  }
  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    recordId: string,
    digest: string,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.commercial.execution.${action}`,
      target: recordId,
      diff: { after: { digest } },
    });
  }
}
