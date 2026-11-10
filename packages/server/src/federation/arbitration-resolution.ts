import { randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  auditLog,
  federationDisputes as cases,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationReservations as reservations,
  federationArbitrationResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { ArbitrationExecutionCommitmentSchema } from "@kuintessence/shared/federation/arbitration-execution";
import {
  assertArbitrationResolution,
  verifyArbitrationExecution,
} from "@kuintessence/shared/federation/arbitration-resolution";
import {
  ArbitrationResolutionEnvelopeSchema,
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  type CommercialArbitrationResolution,
} from "@kuintessence/shared/federation/commercial";
import { and, eq, ne, sql } from "drizzle-orm";
import { applyFederationAdjustment, holdFederationAdjustment } from "./adjustment";
import { arbitrationFinancialTerms } from "./arbitrated-financial-original";
import { verifyReceivedArbitrationDecision } from "./arbitration-decision-history";
import { verifyBilateralArbitrationExecution } from "./arbitration-execution-proof";
import {
  createArbitrationWithdrawal,
  receivedArbitrationResolution,
} from "./arbitration-withdrawal";
import { lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { FederationDisputeService } from "./disputes";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { applyFederationSettlement } from "./settlement";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type ResolutionView = {
  payload: CommercialArbitrationResolution;
  appliedAt: string | null;
  createdAt: string;
  withdrawalRequestedAt: string | null;
  withdrawnAt: string | null;
};

/** Current authorization is fixed once; financial application requires a committed ledger result or bilateral receipt. */
export class FederationArbitrationResolutionService {
  private readonly trust: FederationTrustRegistry;
  private readonly disputes: FederationDisputeService;
  private readonly freezes: FederationDisputeFreezeExchange;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disputes = new FederationDisputeService(db, signing);
    this.freezes = new FederationDisputeFreezeExchange(db, signing);
  }
  private key(caseId: string) {
    return and(eq(resolutions.localSiteId, this.signing.siteId), eq(resolutions.caseId, caseId));
  }
  private async visible(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    execute = false,
  ) {
    await requireFederationCapability(tx, actor, "dispute.read");
    if (execute) await requireFederationCapability(tx, actor, "arbitration.execute");
    const [row] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.localOrgId, actor.orgId),
          eq(cases.agreementRevisionId, revisionId),
          eq(cases.caseId, caseId),
        ),
      );
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  private view(
    tx: PgTransaction,
    caseId: string,
    row: typeof resolutions.$inferSelect,
  ): Promise<ResolutionView>;
  private view(
    tx: PgTransaction,
    caseId: string,
    row?: typeof resolutions.$inferSelect,
  ): Promise<ResolutionView | null>;
  private async view(tx: PgTransaction, caseId: string, row?: typeof resolutions.$inferSelect) {
    const [original] = await tx
      .select()
      .from(received)
      .where(and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, caseId)));
    const payload = row?.payload ?? original?.executionWithdrawal?.resolution;
    const createdAt = row?.createdAt ?? original?.receivedAt;
    if (!payload || !createdAt || (!row && !original?.executionWithdrawal)) return null;
    return {
      payload,
      appliedAt: row?.appliedAt?.toISOString() ?? null,
      createdAt: createdAt.toISOString(),
      withdrawalRequestedAt: row?.withdrawalRequestedAt?.toISOString() ?? null,
      withdrawnAt: original?.executionWithdrawal?.withdrawnAt ?? null,
    };
  }
  private async current(tx: PgTransaction, caseId: string) {
    const [original] = await tx
      .select()
      .from(received)
      .where(and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, caseId)))
      .for("share");
    if (!original) throw new FederationError("DATA_WAITING");
    const value = original.payload,
      decision = value.decision,
      b = decision.intent.binding;
    await verifyReceivedArbitrationDecision(tx, value, this.signing.siteId);
    const context = await this.disputes.arbitrationSnapshot(tx, caseId);
    const { observedAt: _at, ...binding } = context.binding;
    const freeze = await this.freezes.arbitrationSnapshot(tx, caseId);
    if (!freeze) throw new FederationError("DATA_WAITING");
    if (
      federationCanonicalJson(binding) !== federationCanonicalJson(b) ||
      freeze.financial.headDigest !== decision.intent.financial.headDigest ||
      freeze.financial.freezeDigest !== decision.intent.financial.freezeDigest ||
      federationCanonicalJson(freeze.financial.records) !==
        federationCanonicalJson(decision.intent.financial.records)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const originalRequest =
      this.signing.siteId === b.sourceSiteId
        ? (
            await tx
              .select({ requestJws: outbound.requestJws, receiptJws: outbound.receiptJws })
              .from(outbound)
              .where(
                and(
                  eq(outbound.localSiteId, this.signing.siteId),
                  eq(outbound.operationId, b.operationId),
                ),
              )
          )[0]
        : (
            await tx
              .select({ requestJws: reservations.requestJws, receiptJws: reservations.receiptJws })
              .from(reservations)
              .where(eq(reservations.id, b.reservationId))
          )[0];
    if (!originalRequest?.receiptJws) throw new FederationError("DATA_WAITING");
    const envelope = ArbitrationResolutionEnvelopeSchema.parse({
      sourceSiteId: b.sourceSiteId,
      targetSiteId: b.targetSiteId,
      decisionJws: value.decisionJws,
      requestJws: originalRequest.requestJws,
      acceptanceJws: originalRequest.receiptJws,
    });
    const proof = await verifyArbitrationExecution(
      envelope,
      async (schema, jws, siteId) => {
        const keyId = federationMessageKeyId(jws),
          now = new Date();
        await this.trust.assertKey(tx, siteId, keyId, now);
        return verifyFederationMessage(
          schema,
          jws,
          await this.trust.resolveKey(siteId, keyId, now, tx),
          now,
        );
      },
      new Date(),
    );
    const payload = receivedArbitrationResolution(value);
    assertArbitrationResolution(payload, proof);
    if (payload.outcome.action !== "resolve-without-financial-change") {
      const [other] = await tx
        .select({ id: cases.caseId })
        .from(cases)
        .where(
          and(
            eq(cases.localSiteId, this.signing.siteId),
            eq(cases.agreementRevisionId, b.agreementRevisionId),
            eq(cases.taskId, b.taskId),
            eq(cases.attempt, b.attempt),
            ne(cases.caseId, caseId),
            ne(cases.state, "RESOLVED"),
          ),
        )
        .limit(1);
      if (other) throw new FederationError("DATA_WAITING");
      await arbitrationFinancialTerms(tx, this.signing.siteId, original.localOrgId, decision);
    }
    return { original, payload, envelope };
  }
  async execute(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId, true);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      const [prior] = await tx.select().from(resolutions).where(this.key(caseId));
      const previous = await this.view(tx, caseId, prior);
      if (previous) return previous;
      const { original, payload, envelope } = await this.current(tx, caseId);
      const bilateralMoney =
        payload.mode !== "ledger_coordinated" &&
        payload.outcome.action !== "resolve-without-financial-change";
      let commitment = null;
      let commitmentJws: string | null = null;
      let heldAmount = "0";
      if (bilateralMoney) {
        const terms = await arbitrationFinancialTerms(
          tx,
          this.signing.siteId,
          actor.orgId,
          original.payload.decision,
        );
        if (terms.payload.kind === "commercial-adjustment")
          heldAmount = await holdFederationAdjustment(tx, {
            localSiteId: this.signing.siteId,
            localOrgId: actor.orgId,
            agreementRevisionId: revisionId,
            payload: terms.payload,
          });
        const current = await this.current(tx, caseId);
        if (federationCanonicalJson(current.payload) !== federationCanonicalJson(payload))
          throw new FederationError("OPERATION_CONFLICT");
        commitment = ArbitrationExecutionCommitmentSchema.parse({
          protocolVersion: 1,
          kind: "arbitration-execution-commitment",
          resolution: payload,
          committingSiteId: this.signing.siteId,
          committedAt: new Date().toISOString(),
        });
        await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
        commitmentJws = await signFederationMessage(
          ArbitrationExecutionCommitmentSchema,
          commitment,
          this.signing,
        );
        await verifyFederationMessage(
          ArbitrationExecutionCommitmentSchema,
          commitmentJws,
          await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date(), tx),
          new Date(),
        );
      }
      const [row] = await tx
        .insert(resolutions)
        .values({
          localSiteId: this.signing.siteId,
          decisionId: original.decisionId,
          caseId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          payload,
          envelope,
          initiatedBy: actor.userId,
          commitment,
          commitmentJws,
          heldAmount,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      if (payload.mode !== "bilateral_direct" && !bilateralMoney)
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation:
              payload.mode === "ledger_coordinated"
                ? "resolve-arbitrated-case"
                : "record-arbitration-resolution",
            domainId: payload.domainId,
            recordId: payload.decisionId,
            digest: payload.decisionDigest,
            envelope,
          }),
        });
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_resolution.authorize",
        target: row.decisionId,
        diff: { after: { caseId, decisionDigest: payload.decisionDigest, mode: payload.mode } },
      });
      if (payload.mode !== "ledger_coordinated" && !bilateralMoney)
        await this.apply(tx, payload.decisionId, payload.decisionDigest);
      const [saved] = await tx.select().from(resolutions).where(this.key(caseId));
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return this.view(tx, caseId, saved);
    });
  }
  async withdraw(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId, true);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      const [row] = await tx.select().from(resolutions).where(this.key(caseId)).for("update");
      if (!row?.commitment || row.payload.mode === "ledger_coordinated")
        throw new FederationError("POLICY_DENIED");
      const view = await this.view(tx, caseId, row);
      if (row.appliedAt || view?.withdrawnAt) return view;
      if (!row.withdrawalRequestedAt) {
        await tx
          .update(resolutions)
          .set({
            withdrawalRequestedAt: sql`clock_timestamp()`,
            nextAttemptAt: sql`clock_timestamp()`,
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          })
          .where(this.key(caseId));
        await tx.insert(auditLog).values({
          actor: actor.userId,
          orgId: actor.orgId,
          action: "federation.arbitration_execution.withdraw_request",
          target: row.decisionId,
          diff: {
            after: {
              caseId,
              decisionDigest: row.payload.decisionDigest,
              localSiteId: this.signing.siteId,
            },
          },
        });
      }
      if (this.signing.siteId === row.payload.targetSiteId)
        await createArbitrationWithdrawal(
          tx,
          this.signing,
          row.payload,
          this.signing.siteId,
          this.trust,
        );
      const [saved] = await tx.select().from(resolutions).where(this.key(caseId));
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return this.view(tx, caseId, saved);
    });
  }
  async beforeDisclosure(input: CommercialAdapterProposalInput, tx?: PgTransaction): Promise<void> {
    if (!tx) return this.db.transaction((tx) => this.beforeDisclosure(input, tx));
    if (
      input.operation !== "resolve-arbitrated-case" &&
      input.operation !== "record-arbitration-resolution"
    )
      throw new FederationError("POLICY_DENIED");
    const [row] = await tx
      .select()
      .from(resolutions)
      .where(
        and(
          eq(resolutions.localSiteId, this.signing.siteId),
          eq(resolutions.decisionId, input.recordId),
        ),
      );
    if (
      !row ||
      row.payload.decisionDigest !== input.digest ||
      row.payload.domainId !== input.domainId ||
      (input.operation === "resolve-arbitrated-case"
        ? row.payload.mode !== "ledger_coordinated"
        : row.payload.mode !== "bilateral_attested" || !row.appliedAt) ||
      federationCanonicalJson(row.envelope) !== federationCanonicalJson(input.envelope)
    )
      throw new FederationError("POLICY_DENIED");
    if (input.operation === "resolve-arbitrated-case") {
      await lockFederationDisputeTask(tx, this.signing.siteId, row.payload);
      const current = await this.current(tx, row.caseId);
      if (federationCanonicalJson(current.payload) !== federationCanonicalJson(row.payload))
        throw new FederationError("OPERATION_CONFLICT");
    }
  }
  /** Coordinated caller must have persisted the VALID transaction in this same transaction. */
  async apply(tx: PgTransaction, decisionId: string, digest: string) {
    const identity = and(
      eq(resolutions.localSiteId, this.signing.siteId),
      eq(resolutions.decisionId, decisionId),
    );
    const [scope] = await tx.select().from(resolutions).where(identity);
    if (!scope) throw new FederationError("OPERATION_CONFLICT");
    // Match execute's task-before-row lock order when the worker races a human retry.
    await lockFederationDisputeTask(tx, this.signing.siteId, scope.payload);
    const [row] = await tx.select().from(resolutions).where(identity).for("update");
    if (!row || row.payload.decisionDigest !== digest)
      throw new FederationError("OPERATION_CONFLICT");
    if (row.appliedAt) return;
    const [withdrawn] = await tx
      .select({ proof: received.executionWithdrawal })
      .from(received)
      .where(
        and(eq(received.localSiteId, this.signing.siteId), eq(received.decisionId, decisionId)),
      );
    if (withdrawn?.proof) throw new FederationError("OPERATION_CONFLICT");
    if (row.payload.mode === "ledger_coordinated") {
      const [committed] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            eq(submissions.state, "committed"),
            sql`${submissions.input}->>'operation' = 'resolve-arbitrated-case'`,
            sql`${submissions.input}->>'recordId' = ${decisionId}`,
            sql`${submissions.input}->>'digest' = ${digest}`,
          ),
        );
      if (!committed) throw new FederationError("LEDGER_REQUIRED");
    }
    if (
      row.payload.mode !== "ledger_coordinated" &&
      row.payload.outcome.action !== "resolve-without-financial-change"
    )
      await verifyBilateralArbitrationExecution(tx, row);
    if (row.payload.outcome.action !== "resolve-without-financial-change") {
      const [original] = await tx
        .select()
        .from(received)
        .where(
          and(eq(received.localSiteId, this.signing.siteId), eq(received.decisionId, decisionId)),
        );
      if (
        !original ||
        original.payload.decisionDigest !== digest ||
        original.payload.decisionJws !== row.envelope.decisionJws
      )
        throw new FederationError("OPERATION_CONFLICT");
      await verifyReceivedArbitrationDecision(tx, original.payload, this.signing.siteId);
      const posting = await arbitrationFinancialTerms(
        tx,
        this.signing.siteId,
        row.localOrgId,
        original.payload.decision,
      );
      const common = {
        localSiteId: this.signing.siteId,
        localOrgId: row.localOrgId,
        agreementRevisionId: row.agreementRevisionId,
        digest,
        arbitrationDecisionId: decisionId,
        approvedBy: row.initiatedBy,
      };
      if (posting.payload.kind === "commercial-settlement") {
        const [financial] = await tx
          .insert(settlements)
          .values({
            ...common,
            settlementId: decisionId,
            billId: posting.payload.billId,
            payload: posting.payload,
          })
          .returning();
        if (!financial) throw new FederationError("OPERATION_CONFLICT");
        await applyFederationSettlement(tx, financial, posting.bill);
      } else {
        const [financial] = await tx
          .insert(adjustments)
          .values({
            ...common,
            adjustmentId: decisionId,
            settlementId: posting.payload.settlementId,
            number: posting.number,
            heldAmount: row.heldAmount,
            payload: posting.payload,
          })
          .returning();
        if (!financial) throw new FederationError("OPERATION_CONFLICT");
        await applyFederationAdjustment(tx, financial);
      }
    }
    if (row.commitment && row.payload.mode === "bilateral_attested")
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: row.agreementRevisionId,
        input: CommercialAdapterProposalInputSchema.parse({
          operation: "record-arbitration-resolution",
          domainId: row.payload.domainId,
          recordId: decisionId,
          digest,
          envelope: row.envelope,
        }),
      });
    const [record] = await tx
      .update(cases)
      .set({ state: "RESOLVED" })
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, row.caseId),
          eq(cases.localOrgId, row.localOrgId),
          eq(cases.digest, row.payload.caseDigest),
          sql`${cases.state} IN ('DISPUTED','EVIDENCE_WAITING')`,
        ),
      )
      .returning();
    if (!record) throw new FederationError("OPERATION_CONFLICT");
    await tx
      .update(resolutions)
      .set({ appliedAt: sql`clock_timestamp()` })
      .where(this.key(row.caseId));
    await tx.insert(auditLog).values({
      actor: `arbitration-resolution:${this.signing.siteId}`,
      orgId: row.localOrgId,
      action: "federation.arbitration_resolution.apply",
      target: decisionId,
      diff: { after: { caseId: row.caseId, decisionDigest: digest } },
    });
  }
  async read(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, revisionId, caseId);
      const [row] = await tx.select().from(resolutions).where(this.key(caseId));
      return this.view(tx, caseId, row);
    });
  }
}
