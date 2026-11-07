import { randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  federationCommercialAttempts as attempts,
  auditLog,
  federationMarketAttempts as closureAttempts,
  federationMarketSubmissions as closures,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
} from "@kuintessence/shared/federation/commercial";
import { MarketQueryResultSchema } from "@kuintessence/shared/federation/market";
import {
  type FederationTerminalProposal,
  FederationTerminalProposalSchema,
} from "@kuintessence/shared/federation/terminal-proposal";
import { and, desc, eq, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { collectExecutionTerminalEvidence } from "./execution-terminal-evidence";
import { reviewExecutionTerminalSource } from "./execution-terminal-review";
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

/** Institutional terminal statements and source review; never a bill or settlement. */
export class FederationExecutionTerminalService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly market?: Pick<MarketClient, "query">,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  private filter(reservationId: string) {
    return and(
      eq(terminals.localSiteId, this.signing.siteId),
      eq(terminals.reservationId, reservationId),
    );
  }

  private async scope(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    lock: boolean,
    role: "provider" | "source" | "either" = "provider",
  ) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const query = tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.localOrgId, actor.orgId),
          eq(approvals.agreementRevisionId, revisionId),
          eq(approvals.recordId, reservationId),
        ),
      );
    const [approval] = await (lock ? query.for("update") : query);
    if (!approval) throw new FederationError("ASSET_UNAVAILABLE");
    if (approval.payload.kind !== "commercial-reservation")
      throw new FederationError("POLICY_DENIED");
    const reserve = CommercialReservationSchema.parse(approval.payload);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    if (
      !approval.counterpartyJws ||
      !contract.counterpartyJws ||
      reserve.request.mode !== "ledger_coordinated" ||
      terms.agreement.mode !== "ledger_coordinated" ||
      (role === "provider" && reserve.request.recipientSiteId !== this.signing.siteId) ||
      (role === "source" && reserve.request.senderSiteId !== this.signing.siteId) ||
      ![reserve.request.senderSiteId, reserve.request.recipientSiteId].includes(
        this.signing.siteId,
      ) ||
      reserve.request.senderSiteId !== terms.agreement.sourceSiteId ||
      terms.agreement.targetSiteId !== reserve.request.recipientSiteId ||
      reserve.request.agreementRevisionId !== revisionId ||
      reserve.reservationId !== reservationId ||
      reserve.domainId !== terms.domainId ||
      reserve.agreementDigest !== contract.digest
    )
      throw new FederationError("POLICY_DENIED");
    return { approval, reserve, terms };
  }

  async get(actor: FederationActor, revisionId: string, reservationId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.scope(tx, actor, revisionId, reservationId, false, "either");
      const [saved] = await tx.select().from(terminals).where(this.filter(reservationId));
      if (!saved) return null;
      const [submission] = await tx
        .select({ id: submissions.id, state: submissions.state, lastError: submissions.lastError })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`${submissions.input}->>'operation' = 'record-execution-terminal'`,
            sql`${submissions.input}->>'recordId' = ${saved.terminalId}`,
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
      const [closure] = await tx
        .select({ id: closures.id, state: closures.state, lastError: closures.lastError })
        .from(closures)
        .where(
          and(
            eq(closures.id, saved.terminalId),
            eq(closures.localSiteId, this.signing.siteId),
            eq(closures.localOrgId, actor.orgId),
            sql`${closures.input}->>'operation' = 'close-demand'`,
          ),
        );
      const [closureTransaction] = closure
        ? await tx
            .select({
              transactionId: closureAttempts.transactionId,
              stage: closureAttempts.stage,
              validationCode: closureAttempts.validationCode,
              blockNumber: closureAttempts.blockNumber,
            })
            .from(closureAttempts)
            .where(eq(closureAttempts.submissionId, closure.id))
            .orderBy(desc(closureAttempts.number))
            .limit(1)
        : [];
      return {
        ...saved,
        submission: submission ? { ...submission, transaction: transaction ?? null } : null,
        closure: closure ? { ...closure, transaction: closureTransaction ?? null } : null,
      };
    });
  }

  private async activation(
    reserve: ReturnType<typeof CommercialReservationSchema.parse>,
    digest: string,
  ) {
    if (!this.market) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const response = MarketQueryResultSchema.safeParse(
      await this.market.query({ operation: "get-demand", demandId: reserve.demandId }),
    );
    if (!response.success || response.data.operation !== "get-demand")
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const state = response.data.demand;
    const activation = state?.activation;
    if (
      !state ||
      !["ACTIVE", "STOPPING"].includes(state.status) ||
      !activation ||
      state.demand.demandId !== reserve.demandId ||
      state.demand.sourceSiteId !== reserve.request.senderSiteId ||
      state.claim?.providerSiteId !== reserve.request.recipientSiteId ||
      state.claim.claimId !== reserve.reservationId ||
      state.claim.commercialDomainId !== reserve.domainId ||
      activation.demandId !== reserve.demandId ||
      activation.expectedVersion !== reserve.claimVersion ||
      activation.gate.domainId !== reserve.domainId ||
      activation.gate.reservationId !== reserve.reservationId ||
      activation.gate.demandId !== reserve.demandId ||
      activation.gate.reservationDigest !== digest ||
      activation.gate.claimVersion !== reserve.claimVersion ||
      activation.gate.version !== 1 ||
      activation.gate.state !== "READY" ||
      activation.gate.expiresAt !== reserve.request.expiresAt
    )
      throw new FederationError("OPERATION_CONFLICT");
    return activation;
  }

  async proposal(actor: FederationActor, revisionId: string, reservationId: string) {
    const row = await this.get(actor, revisionId, reservationId);
    if (!row || row.payload.targetSiteId !== this.signing.siteId)
      throw new FederationError("ASSET_UNAVAILABLE");
    return FederationTerminalProposalSchema.parse({
      payload: row.payload,
      evidence: row.evidence,
      providerJws: row.approvalJws,
    });
  }

  /** No caller-supplied digest, outcome or evidence can bypass local collection. */
  async approve(actor: FederationActor, revisionId: string, reservationId: string) {
    const initial = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const scope = await this.scope(tx, actor, revisionId, reservationId, false);
      const [saved] = await tx.select().from(terminals).where(this.filter(reservationId));
      return { ...scope, saved };
    });
    if (initial.saved) return initial.saved;
    const activation = await this.activation(initial.reserve, initial.approval.digest);
    const reserve = initial.reserve;
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const current = await this.scope(tx, actor, revisionId, reservationId, true);
      if (
        current.approval.digest !== initial.approval.digest ||
        federationMaterialDigest(current.reserve) !== federationMaterialDigest(reserve)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const [prior] = await tx.select().from(terminals).where(this.filter(reservationId));
      if (prior) return prior;
      const now = this.clock();
      await this.verifyReservation(tx, current.approval, reserve, now);
      const evidence = await collectExecutionTerminalEvidence(
        tx,
        reserve,
        actor.orgId,
        activation.activationId,
        Boolean(current.terms.agreement.resultPolicy),
        this.trust,
        now,
      );
      const payload = CommercialTerminalSchema.parse({
        protocolVersion: 1,
        kind: "commercial-terminal",
        terminalId: randomUUID(),
        domainId: reserve.domainId,
        reservationId,
        reservationDigest: current.approval.digest,
        activationId: activation.activationId,
        sourceSiteId: reserve.request.senderSiteId,
        targetSiteId: this.signing.siteId,
        expectedGateVersion: 1,
        outcome: evidence.workflow.status,
        executionEvidenceDigest: federationMaterialDigest(evidence),
        resultManifestDigest: evidence.result?.receipt.manifestDigest ?? null,
        observedAt: evidence.observedAt,
        issuedAt: now.toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      if (!key.allowedKinds.includes("commercial-terminal"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const approvalJws = await signFederationMessage(
        CommercialTerminalSchema,
        payload,
        this.signing,
      );
      const { digest } = await verifyFederationMessage(
        CommercialTerminalSchema,
        approvalJws,
        key,
        now,
      );
      const [saved] = await tx
        .insert(terminals)
        .values({
          localSiteId: this.signing.siteId,
          reservationId,
          terminalId: payload.terminalId,
          payload,
          digest,
          evidence,
          approvalJws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.execution.terminal",
        target: payload.terminalId,
        diff: {
          after: {
            reservationId,
            digest,
            executionEvidenceDigest: payload.executionEvidenceDigest,
          },
        },
      });
      return saved;
    });
  }

  private async verifyReservation(
    tx: PgTransaction,
    approval: typeof approvals.$inferSelect,
    reserve: ReturnType<typeof CommercialReservationSchema.parse>,
    now: Date,
  ) {
    for (const { siteId, jws } of [
      { siteId: this.signing.siteId, jws: approval.approvalJws },
      {
        siteId:
          this.signing.siteId === reserve.request.senderSiteId
            ? reserve.request.recipientSiteId
            : reserve.request.senderSiteId,
        jws: approval.counterpartyJws,
      },
    ].sort((a, b) => a.siteId.localeCompare(b.siteId))) {
      if (!jws) throw new FederationError("OPERATION_CONFLICT");
      const keyId = federationMessageKeyId(jws);
      await this.trust.assertKey(tx, siteId, keyId, now);
      const key = await this.trust.resolveKey(siteId, keyId, now, tx);
      const verified = await verifyFederationMessage(CommercialReservationSchema, jws, key, now);
      if (
        verified.digest !== approval.digest ||
        federationMaterialDigest(verified.payload) !== federationMaterialDigest(reserve)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
  }

  async countersign(
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    raw: FederationTerminalProposal,
  ) {
    const proposal = FederationTerminalProposalSchema.parse(raw);
    const initial = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const scope = await this.scope(tx, actor, revisionId, reservationId, false, "source");
      const [saved] = await tx.select().from(terminals).where(this.filter(reservationId));
      if (
        saved &&
        (federationMaterialDigest(saved.payload) !== federationMaterialDigest(proposal.payload) ||
          federationMaterialDigest(saved.evidence) !==
            federationMaterialDigest(proposal.evidence) ||
          saved.counterpartyJws !== proposal.providerJws)
      )
        throw new FederationError("OPERATION_CONFLICT");
      return { ...scope, saved };
    });
    if (initial.saved) return initial.saved;
    const activation = await this.activation(initial.reserve, initial.approval.digest);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const current = await this.scope(tx, actor, revisionId, reservationId, true, "source");
      const { payload, evidence } = proposal;
      if (
        current.approval.digest !== initial.approval.digest ||
        federationMaterialDigest(current.reserve) !== federationMaterialDigest(initial.reserve) ||
        payload.reservationId !== reservationId ||
        payload.reservationDigest !== current.approval.digest ||
        payload.domainId !== current.reserve.domainId ||
        payload.sourceSiteId !== this.signing.siteId ||
        payload.targetSiteId !== current.reserve.request.recipientSiteId ||
        payload.activationId !== activation.activationId ||
        payload.expectedGateVersion !== 1
      )
        throw new FederationError("OPERATION_CONFLICT");
      const [prior] = await tx.select().from(terminals).where(this.filter(reservationId));
      if (prior) {
        if (
          federationMaterialDigest(prior.payload) !== federationMaterialDigest(payload) ||
          federationMaterialDigest(prior.evidence) !== federationMaterialDigest(evidence) ||
          prior.counterpartyJws !== proposal.providerJws
        )
          throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      const now = this.clock();
      const providerKeyId = federationMessageKeyId(proposal.providerJws);
      for (const [siteId, keyId] of [
        [payload.targetSiteId, providerKeyId],
        [this.signing.siteId, this.signing.keyId],
      ].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))) {
        if (!siteId || !keyId) throw new FederationError("UNTRUSTED_IDENTITY");
        await this.trust.assertKey(tx, siteId, keyId, now);
      }
      const providerKey = await this.trust.resolveKey(payload.targetSiteId, providerKeyId, now, tx);
      const provider = await verifyFederationMessage(
        CommercialTerminalSchema,
        proposal.providerJws,
        providerKey,
        now,
      );
      if (federationMaterialDigest(provider.payload) !== federationMaterialDigest(payload))
        throw new FederationError("OPERATION_CONFLICT");
      await this.verifyReservation(tx, current.approval, current.reserve, now);
      const sourceReview = await reviewExecutionTerminalSource(
        tx,
        this.trust,
        actor.orgId,
        current.reserve,
        proposal,
        Boolean(current.terms.agreement.resultPolicy),
        now,
      );
      const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      if (!key.allowedKinds.includes("commercial-terminal"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const approvalJws = await signFederationMessage(
        CommercialTerminalSchema,
        payload,
        this.signing,
      );
      const { digest } = await verifyFederationMessage(
        CommercialTerminalSchema,
        approvalJws,
        key,
        now,
      );
      if (digest !== provider.digest) throw new FederationError("OPERATION_CONFLICT");
      const [saved] = await tx
        .insert(terminals)
        .values({
          localSiteId: this.signing.siteId,
          reservationId,
          terminalId: payload.terminalId,
          payload,
          evidence,
          digest,
          approvalJws,
          counterpartyJws: proposal.providerJws,
          sourceReview,
          approvedBy: actor.userId,
        })
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.execution.terminal_countersign",
        target: payload.terminalId,
        diff: {
          after: {
            reservationId,
            digest,
            sourceReviewDigest: federationMaterialDigest(sourceReview),
          },
        },
      });
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: revisionId,
        input: CommercialAdapterProposalInputSchema.parse({
          operation: "record-execution-terminal",
          domainId: payload.domainId,
          recordId: payload.terminalId,
          digest,
          envelope: {
            sourceSiteId: payload.sourceSiteId,
            targetSiteId: payload.targetSiteId,
            sourceJws: approvalJws,
            targetJws: proposal.providerJws,
          },
        }),
      });
      return saved;
    });
  }
}
