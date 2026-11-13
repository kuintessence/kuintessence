import { randomUUID } from "node:crypto";
import {
  federationAgreementApprovals as agreements,
  federationCommercialExecutionApprovals as approvals,
  federationMarketAttempts as attempts,
  auditLog,
  federationCommercialSubmissions as commercialSubmissions,
  federationExecutionTerminals,
  federationOutbound,
  federationAgreements as installed,
  type PgDb,
  type PgTransaction,
  federationMarketSubmissions as submissions,
} from "@kuintessence/db";
import {
  assertDelegationTerms,
  type FederationAgreement,
  FederationAgreementSchema,
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import {
  type CommercialReservation,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  MARKET_EXECUTION_AUTHORIZATION_MS,
  MarketAdapterProposalInputSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { assertFederationNotCancelled } from "./cancellation-fence";
import { requireCoordinatedCommercialAgreement } from "./commercial-execution-policy";
import { requireExecutionIdentity } from "./execution-identity";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationReservationPolicyService } from "./reservation-policy";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";
import { assertUnreservedDemandOpen } from "./unreserved-closure";
import { assertWorkflowRequestActive } from "./workflow-delegations";

type Phase = "admission" | "execution";
type Submission = typeof submissions.$inferSelect;

/** Institutional chain confirmation is necessary but never replaces current local dispatch policy. */
export class FederationExecutionConfirmationService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly market?: Pick<MarketClient, "query">,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  private async verify(
    tx: PgTransaction,
    payload: FederationAgreement | CommercialReservation,
    ownJws: string,
    otherJws: string,
    digest: string,
  ) {
    const source =
      payload.kind === "agreement" ? payload.sourceSiteId : payload.request.senderSiteId;
    const target =
      payload.kind === "agreement" ? payload.targetSiteId : payload.request.recipientSiteId;
    const pairs = [
      { siteId: this.siteId, jws: ownJws },
      { siteId: this.siteId === source ? target : source, jws: otherJws },
    ].sort((a, b) => a.siteId.localeCompare(b.siteId));
    let validUntil = Number.POSITIVE_INFINITY;
    for (const { siteId, jws } of pairs) {
      const keyId = federationMessageKeyId(jws);
      await this.trust.assertKey(tx, siteId, keyId, this.clock());
      const key = await this.trust.resolveKey(siteId, keyId, this.clock(), tx);
      const result = await verifyFederationMessage<{ kind: string }>(
        payload.kind === "agreement" ? FederationAgreementSchema : CommercialReservationSchema,
        jws,
        key,
        this.clock(),
      );
      if (
        result.digest !== digest ||
        federationCanonicalJson(result.payload) !== federationCanonicalJson(payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      validUntil = Math.min(validUntil, key.validUntil.getTime());
    }
    return validUntil;
  }

  private async scope(
    tx: PgTransaction,
    orgId: string,
    request: FederationDelegation,
    phase: Phase,
  ) {
    if (
      request.mode !== "ledger_coordinated" ||
      ![request.senderSiteId, request.recipientSiteId].includes(this.siteId)
    )
      throw new FederationError("POLICY_DENIED");
    await assertWorkflowRequestActive(tx, this.siteId, orgId, request);
    const [consent] = await tx
      .select()
      .from(agreements)
      .where(
        and(
          eq(agreements.localSiteId, this.siteId),
          eq(agreements.localOrgId, orgId),
          eq(agreements.revisionId, request.agreementRevisionId),
        ),
      );
    if (!consent || consent.state !== "active" || !consent.counterpartyApprovalJws)
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    const terms = FederationAgreementSchema.parse(consent.terms);
    assertDelegationTerms(terms, request, this.clock(), phase);
    const approvalDeadline = await this.verify(
      tx,
      terms,
      consent.approvalJws,
      consent.counterpartyApprovalJws,
      consent.termsDigest,
    );
    const commercial = await requireCoordinatedCommercialAgreement(
      tx,
      this.trust,
      this.siteId,
      orgId,
      terms,
      this.clock,
    );
    if (!commercial) throw new FederationError("LEDGER_REQUIRED");
    const [currentConsent] = await tx
      .select()
      .from(agreements)
      .where(
        and(
          eq(agreements.localSiteId, this.siteId),
          eq(agreements.localOrgId, orgId),
          eq(agreements.revisionId, request.agreementRevisionId),
        ),
      )
      .for("share");
    if (
      !currentConsent ||
      currentConsent.state !== "active" ||
      currentConsent.termsDigest !== consent.termsDigest ||
      currentConsent.approvalJws !== consent.approvalJws ||
      currentConsent.counterpartyApprovalJws !== consent.counterpartyApprovalJws ||
      currentConsent.executionUserId !== consent.executionUserId
    )
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    if (request.recipientSiteId === this.siteId) {
      const [local] = await tx
        .select()
        .from(installed)
        .where(
          and(
            eq(installed.revisionId, terms.agreementRevisionId),
            eq(installed.localOrgId, orgId),
            eq(installed.targetSiteId, this.siteId),
          ),
        )
        .for("share");
      if (
        !local ||
        local.state !== "active" ||
        local.executionUserId !== consent.executionUserId ||
        local.termsDigest !== consent.termsDigest
      )
        throw new FederationError("AGREEMENT_UNAVAILABLE");
      await requireExecutionIdentity(tx, { orgId, userId: local.executionUserId });
    }
    await assertFederationNotCancelled(tx, request);
    const [outbound] = await tx
      .select({ cancelState: federationOutbound.cancelState })
      .from(federationOutbound)
      .where(
        and(
          eq(federationOutbound.localSiteId, this.siteId),
          eq(federationOutbound.operationId, request.operationId),
        ),
      )
      .for("share");
    if (outbound?.cancelState) throw new FederationError("CANCELLATION_REQUESTED");
    const records = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.siteId),
          eq(approvals.localOrgId, orgId),
          eq(approvals.agreementRevisionId, request.agreementRevisionId),
          sql`${approvals.payload}->>'kind' = 'commercial-reservation'`,
          sql`${approvals.payload}->'request'->>'operationId' = ${request.operationId}`,
          sql`${approvals.counterpartyJws} IS NOT NULL`,
        ),
      )
      .limit(2)
      .for("share");
    const record = records[0];
    if (!record?.counterpartyJws || records.length !== 1)
      throw new FederationError("OPERATION_CONFLICT");
    if (record.stopId) throw new FederationError("CANCELLATION_REQUESTED");
    const [terminal] = await tx
      .select({ id: federationExecutionTerminals.terminalId })
      .from(federationExecutionTerminals)
      .where(
        and(
          eq(federationExecutionTerminals.localSiteId, this.siteId),
          eq(federationExecutionTerminals.reservationId, record.recordId),
        ),
      );
    if (terminal) throw new FederationError("POLICY_DENIED");
    const reserve = CommercialReservationSchema.parse(record.payload);
    await assertUnreservedDemandOpen(tx, this.siteId, reserve.demandId);
    if (
      federationCanonicalJson(reserve.request) !== federationCanonicalJson(request) ||
      reserve.agreementDigest !== commercial.contract.digest ||
      reserve.domainId !== commercial.contract.terms.domainId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const reservationDeadline = await this.verify(
      tx,
      reserve,
      record.approvalJws,
      record.counterpartyJws,
      record.digest,
    );
    const [committed] = await tx
      .select({ id: commercialSubmissions.id })
      .from(commercialSubmissions)
      .where(
        and(
          eq(commercialSubmissions.localSiteId, this.siteId),
          eq(commercialSubmissions.agreementRevisionId, request.agreementRevisionId),
          eq(commercialSubmissions.state, "committed"),
          sql`${commercialSubmissions.input}->>'operation' = 'reserve-execution'`,
          sql`${commercialSubmissions.input}->>'recordId' = ${reserve.reservationId}`,
          sql`${commercialSubmissions.input}->>'digest' = ${record.digest}`,
        ),
      )
      .for("share");
    if (!committed) throw new FabricClientFailure("LEDGER_PENDING");
    const [release] = await tx
      .select({ id: approvals.recordId })
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.siteId),
          eq(approvals.localOrgId, orgId),
          eq(approvals.agreementRevisionId, request.agreementRevisionId),
          sql`${approvals.payload}->>'kind' = 'commercial-release'`,
          sql`${approvals.payload}->>'reservationId' = ${reserve.reservationId}`,
          sql`${approvals.counterpartyJws} IS NOT NULL`,
        ),
      )
      .limit(1);
    if (release) throw new FederationError("POLICY_DENIED");
    const source = request.senderSiteId === this.siteId;
    const [intent] = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, this.siteId),
          eq(submissions.localOrgId, orgId),
          eq(submissions.id, source ? reserve.demandId : reserve.reservationId),
          eq(submissions.demandId, reserve.demandId),
          eq(submissions.state, "committed"),
        ),
      )
      .for("share");
    if (!intent || intent.input.operation !== (source ? "publish-demand" : "claim-demand"))
      throw new FederationError("ASSET_UNAVAILABLE");
    const [activation] = source
      ? await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.localSiteId, this.siteId),
              eq(submissions.localOrgId, orgId),
              eq(submissions.demandId, reserve.demandId),
              eq(submissions.state, "committed"),
              sql`${submissions.input}->>'operation' = 'activate-demand'`,
              sql`${submissions.input}->'activation'->'gate'->>'reservationId' = ${reserve.reservationId}`,
            ),
          )
          .limit(1)
          .for("share")
      : [];
    if (source && activation?.input.operation !== "activate-demand")
      throw new FabricClientFailure("LEDGER_PENDING");
    assertDelegationTerms(terms, request, this.clock(), phase);
    const validUntil = Math.min(
      federationExecutionDeadline(request),
      Date.parse(terms.validUntil),
      approvalDeadline,
      commercial.validUntil,
      reservationDeadline,
    );
    if (validUntil <= this.clock().getTime()) throw new FederationError("AUTHORIZATION_EXPIRED");
    return {
      consent,
      reserve,
      activationId:
        activation?.input.operation === "activate-demand"
          ? activation.input.activation.activationId
          : undefined,
      gate: MarketExecutionGateSchema.parse({
        domainId: reserve.domainId,
        reservationId: reserve.reservationId,
        demandId: reserve.demandId,
        claimVersion: reserve.claimVersion,
        version: 1,
        state: "READY",
        reservationDigest: record.digest,
        expiresAt: request.expiresAt,
      }),
      validUntil,
    };
  }

  private filter(orgId: string, reservationId: string) {
    return and(
      eq(submissions.localSiteId, this.siteId),
      eq(submissions.localOrgId, orgId),
      sql`${submissions.input}->>'operation' = 'authorize-execution'`,
      sql`${submissions.input}->'authorization'->'gate'->>'reservationId' = ${reservationId}`,
    );
  }
  private parse(row: Submission, gate: ReturnType<typeof MarketExecutionGateSchema.parse>) {
    const input = MarketAdapterProposalInputSchema.parse(row.input);
    if (
      input.operation !== "authorize-execution" ||
      federationMaterialDigest(input) !== row.digest ||
      input.authorization.authorizationId !== row.id ||
      input.authorization.issuerSiteId !== this.siteId ||
      row.demandId !== gate.demandId ||
      federationCanonicalJson(input.authorization.gate) !== federationCanonicalJson(gate)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return input.authorization;
  }
  private summary(row: Submission) {
    const input = MarketAdapterProposalInputSchema.parse(row.input);
    if (input.operation !== "authorize-execution") throw new FederationError("OPERATION_CONFLICT");
    return { id: row.id, state: row.state, expiresAt: input.authorization.expiresAt };
  }

  private async reusable(
    tx: PgTransaction,
    orgId: string,
    gate: ReturnType<typeof MarketExecutionGateSchema.parse>,
    automatic = false,
  ) {
    const [latest] = await tx
      .select()
      .from(submissions)
      .where(this.filter(orgId, gate.reservationId))
      .orderBy(desc(submissions.createdAt), desc(submissions.id))
      .limit(1)
      .for("share");
    if (automatic && latest?.state === "needs_review")
      throw new FabricClientFailure(latest.lastError ?? "LEDGER_INVALID", true);
    if (!latest || latest.state === "needs_review") return undefined;
    const authorization = this.parse(latest, gate);
    if (automatic && latest.state === "pending") return latest;
    return Date.parse(authorization.issuedAt) <= this.clock().getTime() &&
      Date.parse(authorization.expiresAt) > this.clock().getTime() + 60000
      ? latest
      : undefined;
  }

  /** Human renewal trigger. A public gate supplied by the caller is never accepted. */
  async request(actor: FederationActor, revisionId: string, recordId: string) {
    const reserve = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [record] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.siteId),
            eq(approvals.localOrgId, actor.orgId),
            eq(approvals.agreementRevisionId, revisionId),
            eq(approvals.recordId, recordId),
          ),
        );
      if (!record) throw new FederationError("ASSET_UNAVAILABLE");
      if (record.payload.kind !== "commercial-reservation")
        throw new FederationError("POLICY_DENIED");
      return CommercialReservationSchema.parse(record.payload);
    });
    return this.refresh(actor.orgId, reserve.request, "execution", actor);
  }

  async requestPreauthorized(
    policyId: string,
    recordId: string,
    guard?: (tx: PgTransaction) => Promise<void>,
  ) {
    const [record] = await this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.siteId),
          eq(approvals.recordId, recordId),
          eq(approvals.authorizationPolicyId, policyId),
        ),
      );
    if (!record || record.payload.kind !== "commercial-reservation")
      throw new FederationError("POLICY_DENIED");
    const reserve = CommercialReservationSchema.parse(record.payload);
    const policies = new FederationReservationPolicyService(this.db, this.siteId, this.clock);
    return this.refresh(record.localOrgId, reserve.request, "execution", undefined, async (tx) => {
      await guard?.(tx);
      const current = await policies.authorizeOperation(tx, policyId, recordId, "confirm");
      if (
        current.approval.digest !== record.digest ||
        current.approval.localOrgId !== record.localOrgId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return current.policy;
    });
  }

  /** Internal callers must independently check the user's authority for their operation. */
  async refresh(
    orgId: string,
    raw: FederationDelegation,
    phase: Phase = "execution",
    actor?: FederationActor,
    automatic?: (tx: PgTransaction) => Promise<{ id: string; grantedBy: string; validUntil: Date }>,
  ) {
    const request = FederationDelegationSchema.parse(raw);
    if (actor && actor.orgId !== orgId) throw new FederationError("POLICY_DENIED");
    const snapshot = await this.db.transaction(async (tx) => {
      if (actor) await requireFederationCapability(tx, actor, "agreement.approve");
      await automatic?.(tx);
      const current = await this.scope(tx, orgId, request, phase);
      return { ...current, existing: await this.reusable(tx, orgId, current.gate, !!automatic) };
    });
    if (snapshot.existing) return this.summary(snapshot.existing);
    if (!this.market) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const rawResult = await this.market
      .query({
        operation: "get-demand",
        demandId: snapshot.reserve.demandId,
      })
      .catch((error: unknown) => {
        if (error instanceof z.ZodError)
          throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
        throw error;
      });
    const result = MarketQueryResultSchema.safeParse(rawResult);
    if (!result.success || result.data.operation !== "get-demand")
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const state = result.data.demand;
    if (state?.status === "CLAIMED") throw new FabricClientFailure("LEDGER_PENDING");
    if (
      !state ||
      state.status !== "ACTIVE" ||
      !state.activation ||
      state.demand.demandId !== snapshot.reserve.demandId ||
      state.demand.sourceSiteId !== request.senderSiteId ||
      state.claim?.providerSiteId !== request.recipientSiteId ||
      state.claim.claimId !== snapshot.reserve.reservationId ||
      state.claim.commercialDomainId !== snapshot.reserve.domainId ||
      (snapshot.activationId !== undefined &&
        state.activation.activationId !== snapshot.activationId) ||
      federationCanonicalJson(state.activation.gate) !== federationCanonicalJson(snapshot.gate)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const activationId = state.activation.activationId;
    return this.db.transaction(async (tx) => {
      if (actor) await requireFederationCapability(tx, actor, "agreement.approve");
      const policy = await automatic?.(tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${this.siteId}:${snapshot.reserve.reservationId}:execution-confirmation`}, 0))`,
      );
      const current = await this.scope(tx, orgId, request, phase);
      const prior = await this.reusable(tx, orgId, current.gate, !!automatic);
      if (prior) return this.summary(prior);
      const now = this.clock().getTime();
      if (current.validUntil <= now || (policy && policy.validUntil.getTime() <= now))
        throw new FederationError("AUTHORIZATION_EXPIRED");
      const authorization = MarketExecutionAuthorizationSchema.parse({
        authorizationId: randomUUID(),
        issuerSiteId: this.siteId,
        demandId: current.reserve.demandId,
        activationId,
        gate: current.gate,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(
          Math.min(now + MARKET_EXECUTION_AUTHORIZATION_MS, current.validUntil),
        ).toISOString(),
      });
      const input = { operation: "authorize-execution" as const, authorization };
      const digest = federationMaterialDigest(input);
      const [created] = await tx
        .insert(submissions)
        .values({
          id: authorization.authorizationId,
          localSiteId: this.siteId,
          localOrgId: orgId,
          requestedBy: policy?.grantedBy ?? current.consent.approvedBy,
          authorizationPolicyId: policy?.id,
          demandId: current.reserve.demandId,
          input,
          digest,
        })
        .returning();
      if (!created) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: policy
          ? `reservation-policy:${policy.id}`
          : (actor?.userId ?? current.consent.approvedBy),
        orgId,
        action: "federation.execution.confirm",
        target: created.id,
        diff: { after: { reservationId: current.reserve.reservationId, digest } },
      });
      return this.summary(created);
    });
  }

  /** Opportunistic renewal outside the consumer's final operation transaction. */
  async refreshForExecution(
    orgId: string,
    request: FederationDelegation,
    phase: Phase = "execution",
  ) {
    try {
      await this.refresh(orgId, request, phase);
    } catch (error) {
      if (!(error instanceof FabricClientFailure) || error.needsReview) throw error;
      // A renewal outage does not shorten an existing VALID proof; final callers still recheck it.
      await this.db.transaction((tx) => this.authorize(tx, orgId, request, phase));
    }
  }

  /** Called inside the operation's final transaction; no network I/O or cached boolean authorizes work. */
  async authorize(
    tx: PgTransaction,
    orgId: string,
    raw: FederationDelegation,
    phase: Phase = "execution",
  ) {
    const request = FederationDelegationSchema.parse(raw);
    const current = await this.scope(tx, orgId, request, phase);
    const [proof] = await tx
      .select()
      .from(submissions)
      .where(
        and(this.filter(orgId, current.reserve.reservationId), eq(submissions.state, "committed")),
      )
      .orderBy(desc(submissions.createdAt), desc(submissions.id))
      .limit(1)
      .for("share");
    if (!proof) throw new FabricClientFailure("LEDGER_PENDING");
    const authorization = this.parse(proof, current.gate);
    if (current.activationId && current.activationId !== authorization.activationId)
      throw new FederationError("OPERATION_CONFLICT");
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, proof.id))
      .orderBy(desc(attempts.number))
      .limit(1)
      .for("share");
    if (
      !attempt ||
      attempt.stage !== "committed" ||
      attempt.validationCode !== 0 ||
      attempt.blockNumber === null
    )
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const now = this.clock().getTime();
    assertDelegationTerms(current.consent.terms, request, this.clock(), phase);
    if (current.validUntil <= now) throw new FederationError("AUTHORIZATION_EXPIRED");
    const expiresAtUnixMs = Math.min(Date.parse(authorization.expiresAt), current.validUntil);
    if (Date.parse(authorization.issuedAt) > now || expiresAtUnixMs <= now)
      throw new FabricClientFailure("LEDGER_PENDING");
    return {
      reservationId: current.reserve.reservationId,
      authorizationId: proof.id,
      expiresAtUnixMs,
    };
  }
}
