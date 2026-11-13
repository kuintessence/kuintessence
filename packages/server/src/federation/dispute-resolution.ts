import { randomBytes } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  federationArbitrationResolutions as arbitrationExecutions,
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialBills as bills,
  federationDisputes as cases,
  type PgDb,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationDisputeResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  federationCommercialApprovalSyncs as syncs,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { assertCommercialSettlement } from "@kuintessence/shared/federation/billing";
import {
  type CommercialDisputeResolution,
  CommercialDisputeResolutionContextSchema,
  CommercialDisputeResolutionSchema,
  CommercialDisputeResolutionViewSchema,
} from "@kuintessence/shared/federation/dispute-resolution";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { validateFederationAdjustment } from "./adjustment";
import {
  applyArbitrationWithdrawal,
  receivedArbitrationResolution,
} from "./arbitration-withdrawal";
import { federationMaterialDigest } from "./assets";
import { lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { completeDisputeResolution } from "./dispute-resolution-state";
import { FederationDisputeService } from "./disputes";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Resolution = typeof resolutions.$inferSelect;
export class FederationDisputeResolutionService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(caseId: string) {
    return and(eq(resolutions.localSiteId, this.signing.siteId), eq(resolutions.caseId, caseId));
  }
  private async view(tx: PgTransaction, row: Resolution) {
    const financial = row.payload.financial;
    let financialApproved = false;
    let financialAppliedAt: string | null = null;
    if (financial) {
      const table = financial.kind === "commercial-settlement" ? settlements : adjustments;
      const identity =
        financial.kind === "commercial-settlement"
          ? settlements.settlementId
          : adjustments.adjustmentId;
      const id =
        financial.kind === "commercial-settlement"
          ? financial.settlementId
          : financial.adjustmentId;
      const [posting] = await tx
        .select()
        .from(table)
        .where(and(eq(table.localSiteId, row.localSiteId), eq(identity, id)));
      if (posting) {
        if (
          posting.localOrgId !== row.localOrgId ||
          posting.agreementRevisionId !== row.agreementRevisionId ||
          posting.arbitrationDecisionId ||
          federationCanonicalJson(posting.payload) !== federationCanonicalJson(financial)
        )
          throw new FederationError("OPERATION_CONFLICT");
        financialApproved = true;
        financialAppliedAt = posting.appliedAt?.toISOString() ?? null;
      }
    }
    const [exchange] = await tx
      .select({ state: syncs.state, lastError: syncs.lastError })
      .from(syncs)
      .where(
        and(
          eq(syncs.localSiteId, row.localSiteId),
          eq(syncs.recordKind, "dispute-resolution"),
          eq(syncs.recordId, row.resolutionId),
        ),
      );
    const ledger = async (operation: string) => {
      const [submission] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, row.localSiteId),
            sql`${submissions.lastError} IS DISTINCT FROM 'HISTORY_ARCHIVE_ONLY'`,
            eq(submissions.agreementRevisionId, row.agreementRevisionId),
            sql`${submissions.input}->>'operation' = ${operation}`,
            sql`${submissions.input}->>'recordId' = ${row.resolutionId}`,
          ),
        );
      if (!submission) return null;
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(eq(attempts.submissionId, submission.id))
        .orderBy(desc(attempts.number))
        .limit(1);
      return {
        id: submission.id,
        state: submission.state,
        lastError: submission.lastError,
        transactionId: attempt?.transactionId ?? null,
        blockNumber: attempt?.blockNumber ?? null,
      };
    };
    return CommercialDisputeResolutionViewSchema.parse({
      payload: row.payload,
      digest: row.digest,
      counterpartyApproved: !!row.counterpartyJws,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      financialApproved,
      financialAppliedAt,
      exchange: exchange ?? null,
      ledger: await ledger(
        row.payload.mode === "ledger_coordinated" ? "resolve-dispute" : "record-dispute-resolution",
      ),
      authorizationLedger: await ledger("authorize-dispute-resolution"),
    });
  }
  private async visible(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    approve = false,
  ) {
    await requireFederationCapability(tx, actor, "dispute.read");
    if (approve) await requireFederationCapability(tx, actor, "dispute.resolve");
    const [record] = await tx
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
    if (!record) throw new FederationError("POLICY_DENIED");
    return record;
  }
  private async boundary(tx: PgTransaction, caseId: string, applyWithdrawal = true) {
    const current = await new FederationDisputeService(this.db, this.signing).financialSnapshot(
      tx,
      caseId,
    );
    const [original] = await tx
      .select()
      .from(received)
      .where(and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, caseId)));
    if (
      !current.view.localReady ||
      !current.view.headDigest ||
      !["DISPUTED", "EVIDENCE_WAITING"].includes(current.record.state)
    )
      throw new FederationError("DATA_WAITING");
    if (
      original?.executionWithdrawal &&
      original.executionWithdrawalJws &&
      current.view.mode !== "ledger_coordinated"
    ) {
      if (applyWithdrawal)
        await applyArbitrationWithdrawal(
          tx,
          this.signing.siteId,
          receivedArbitrationResolution(original.payload),
          original.executionWithdrawal,
          original.executionWithdrawalJws,
        );
      return {
        current,
        protocolVersion: 1 as const,
        decisionId: original.decisionId,
        withdrawalDigest: federationMaterialDigest(original.executionWithdrawal),
        freezeDigest: undefined,
        withdrawnAt: original.executionWithdrawal.withdrawnAt,
      };
    }
    const [execution] = await tx
      .select({ id: arbitrationExecutions.decisionId })
      .from(arbitrationExecutions)
      .where(
        and(
          eq(arbitrationExecutions.localSiteId, this.signing.siteId),
          eq(arbitrationExecutions.caseId, caseId),
        ),
      )
      .limit(1);
    // An execution intent may already have left this database; it cannot be superseded.
    if (execution) throw new FederationError("DATA_WAITING");
    let freezeDigest: string | null = null;
    if (current.view.mode === "ledger_coordinated") {
      const freeze = await new FederationDisputeFreezeExchange(
        this.db,
        this.signing,
      ).arbitrationSnapshot(tx, caseId);
      if (!freeze) throw new FederationError("DATA_WAITING");
      freezeDigest = freeze.financial.freezeDigest;
    }
    return {
      current,
      protocolVersion: 2 as const,
      decisionId: null,
      withdrawalDigest: null,
      freezeDigest,
      withdrawnAt: null,
    };
  }
  async context(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      const [prior] = await tx.select().from(resolutions).where(this.key(caseId));
      if (prior)
        return CommercialDisputeResolutionContextSchema.parse({
          canDraft: false,
          blockedReason: "RESOLUTION_EXISTS",
          protocolVersion: prior.payload.protocolVersion,
          mode: prior.payload.mode,
        });
      try {
        const boundary = await this.boundary(tx, caseId, false);
        return CommercialDisputeResolutionContextSchema.parse({
          canDraft: true,
          blockedReason: null,
          protocolVersion: boundary.protocolVersion,
          mode: boundary.current.view.mode,
        });
      } catch (error) {
        if (!(error instanceof FederationError)) throw error;
        return CommercialDisputeResolutionContextSchema.parse({
          canDraft: false,
          blockedReason: error.code,
          protocolVersion: null,
          mode: null,
        });
      }
    });
  }
  private async checkFinancial(
    tx: PgTransaction,
    value: CommercialDisputeResolution,
    orgId: string,
  ) {
    if (!value.financial) return;
    const financial = value.financial;
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, financial.billId)));
    if (
      !bill ||
      bill.localOrgId !== orgId ||
      bill.agreementRevisionId !== value.agreementRevisionId ||
      bill.digest !== financial.billDigest ||
      bill.payload.request.taskId !== value.taskId ||
      bill.payload.request.attempt !== value.attempt ||
      bill.payload.request.mode !== value.mode
    )
      throw new FederationError("POLICY_DENIED");
    if (financial.kind === "commercial-settlement")
      assertCommercialSettlement(financial, bill.payload, bill.digest);
    else
      await validateFederationAdjustment(
        tx,
        this.signing.siteId,
        orgId,
        value.agreementRevisionId,
        financial,
      );
    const [other] = await tx
      .select({ id: cases.caseId })
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.agreementRevisionId, value.agreementRevisionId),
          eq(cases.taskId, value.taskId),
          eq(cases.attempt, value.attempt),
          ne(cases.caseId, value.caseId),
          ne(cases.state, "RESOLVED"),
        ),
      )
      .limit(1);
    if (other) throw new FederationError("DATA_WAITING");
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    input: Pick<CommercialDisputeResolution, "resolutionId" | "reason" | "financial">,
  ) {
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId, true);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      const boundary = await this.boundary(tx, caseId);
      const { current, protocolVersion, decisionId, withdrawalDigest, freezeDigest } = boundary;
      const c = current.record.payload;
      const value = CommercialDisputeResolutionSchema.parse({
        ...input,
        protocolVersion,
        kind: "commercial-dispute-resolution",
        caseId,
        caseDigest: current.record.digest,
        domainId: c.domainId,
        agreementRevisionId: revisionId,
        sourceSiteId: c.sourceSiteId,
        targetSiteId: c.targetSiteId,
        taskId: c.taskId,
        attempt: c.attempt,
        mode: current.view.mode,
        decisionId,
        withdrawalDigest,
        ...(protocolVersion === 2 ? { freezeDigest } : {}),
        headDigest: current.view.headDigest,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      await this.checkFinancial(tx, value, actor.orgId);
      return value;
    });
  }
  private async verify(tx: PgTransaction, jws: string, siteId: string) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      CommercialDisputeResolutionSchema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  async approve(
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    raw: CommercialDisputeResolution,
  ) {
    const value = CommercialDisputeResolutionSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const record = await this.visible(tx, actor, revisionId, caseId, true);
      await lockFederationDisputeTask(tx, this.signing.siteId, record);
      if (value.caseId !== caseId || value.agreementRevisionId !== revisionId)
        throw new FederationError("POLICY_DENIED");
      const [prior] = await tx.select().from(resolutions).where(this.key(caseId));
      if (prior) {
        if (federationCanonicalJson(prior.payload) !== federationCanonicalJson(value))
          throw new FederationError("OPERATION_CONFLICT");
        return this.view(tx, prior);
      }
      const boundary = await this.boundary(tx, caseId);
      const { current, protocolVersion, decisionId, withdrawalDigest, freezeDigest } = boundary;
      const c = current.record.payload;
      if (
        value.caseDigest !== current.record.digest ||
        value.domainId !== c.domainId ||
        value.sourceSiteId !== c.sourceSiteId ||
        value.targetSiteId !== c.targetSiteId ||
        value.taskId !== c.taskId ||
        value.attempt !== c.attempt ||
        value.mode !== current.view.mode ||
        value.headDigest !== current.view.headDigest ||
        value.protocolVersion !== protocolVersion ||
        value.decisionId !== decisionId ||
        value.withdrawalDigest !== withdrawalDigest ||
        value.freezeDigest !== freezeDigest ||
        Date.parse(value.issuedAt) > Date.now() + 60000 ||
        Date.parse(value.issuedAt) <
          Date.parse(boundary.withdrawnAt ?? current.record.payload.issuedAt)
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.checkFinancial(tx, value, actor.orgId);
      const signed = await this.verify(
        tx,
        await signFederationMessage(CommercialDisputeResolutionSchema, value, this.signing),
        this.signing.siteId,
      );
      const [saved] = await tx
        .insert(resolutions)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          caseId,
          resolutionId: value.resolutionId,
          payload: value,
          digest: signed.digest,
          approvalJws: signed.jws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.dispute_resolution.approve",
        target: value.resolutionId,
        diff: { after: { caseId, digest: signed.digest } },
      });
      return this.view(tx, saved);
    });
  }
  async exchangeRecord(tx: PgTransaction, orgId: string, revisionId: string, resolutionId: string) {
    const [row] = await tx
      .select()
      .from(resolutions)
      .where(
        and(
          eq(resolutions.localSiteId, this.signing.siteId),
          eq(resolutions.localOrgId, orgId),
          eq(resolutions.agreementRevisionId, revisionId),
          eq(resolutions.resolutionId, resolutionId),
        ),
      );
    if (!row) return null;
    return {
      row,
      other:
        row.payload.sourceSiteId === this.signing.siteId
          ? row.payload.targetSiteId
          : row.payload.sourceSiteId,
    };
  }
  async attachExchanged(
    revisionId: string,
    resolutionId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      const [scope] = await tx
        .select()
        .from(resolutions)
        .where(
          and(
            eq(resolutions.localSiteId, this.signing.siteId),
            eq(resolutions.agreementRevisionId, revisionId),
            eq(resolutions.resolutionId, resolutionId),
          ),
        );
      if (!scope) throw new FederationError("POLICY_DENIED");
      await lockFederationDisputeTask(tx, this.signing.siteId, scope.payload);
      const [row] = await tx.select().from(resolutions).where(this.key(scope.caseId)).for("update");
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const other =
        row.payload.sourceSiteId === this.signing.siteId
          ? row.payload.targetSiteId
          : row.payload.sourceSiteId;
      const signed = await this.verify(tx, jws, other);
      if (
        signed.digest !== row.digest ||
        federationCanonicalJson(signed.payload) !== federationCanonicalJson(row.payload) ||
        (row.counterpartyJws && row.counterpartyJws !== jws)
      )
        throw new FederationError("OPERATION_CONFLICT");
      await authorize(tx);
      if (row.counterpartyJws) return this.view(tx, row);
      await tx.update(resolutions).set({ counterpartyJws: jws }).where(this.key(row.caseId));
      await completeDisputeResolution(tx, this.signing.siteId, row.caseId);
      const [saved] = await tx.select().from(resolutions).where(this.key(row.caseId));
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      return this.view(tx, saved);
    });
  }
  async read(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.visible(tx, actor, revisionId, caseId);
      const [row] = await tx.select().from(resolutions).where(this.key(caseId));
      return row ? this.view(tx, row) : null;
    });
  }
}
