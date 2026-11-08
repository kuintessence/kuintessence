import { randomBytes, randomUUID } from "node:crypto";
import {
  federationAgreements as agreements,
  auditLog,
  federationBudgets as budgets,
  federationCancellations as cancellations,
  federationCommercialAgreements as contracts,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationCommercialRefunds as refunds,
  federationReservations as reservations,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import {
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { assertCommercialRefund } from "@kuintessence/shared/federation/billing";
import {
  CommercialAdapterProposalInputSchema,
  type CommercialRefund,
  CommercialRefundSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { z } from "zod";
import { readFederationCancellationState } from "./cancellation-state";
import { renewTaskCompletion } from "./completion-capacity";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { FederationTrustRegistry } from "./trust-registry";

/** Refunds free the original local reservation once; they never create payment or usage evidence. */
export class FederationRefundService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  private key(refundId: string) {
    return and(eq(refunds.localSiteId, this.signing.siteId), eq(refunds.refundId, refundId));
  }
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const now = new Date(),
      keyId = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, revisionId),
          eq(contracts.localOrgId, actor.orgId),
        ),
      )
      .for("share");
    if (!row?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    if (row.terms.agreement.mode === "ledger_coordinated")
      throw new FederationError("POLICY_DENIED");
    return row;
  }
  private async originals(tx: PgTransaction, actor: FederationActor, value: CommercialRefund) {
    const request = value.request,
      site = this.signing.siteId;
    const contract = await this.contract(tx, actor, request.agreementRevisionId);
    const signedReceipt = await this.verify(
      tx,
      FederationCancellationReceiptSchema,
      value.cancellationReceiptJws,
      request.recipientSiteId,
    );
    const receipt = signedReceipt.payload;
    assertCommercialRefund(value, contract.terms, contract.digest, receipt);
    if (Date.parse(value.issuedAt) > Date.now() + 60000)
      throw new FederationError("INVALID_MESSAGE");
    const provider = site === request.recipientSiteId;
    if (!provider && site !== request.senderSiteId) throw new FederationError("POLICY_DENIED");
    let reservation: typeof reservations.$inferSelect | undefined;
    let operation: typeof outbound.$inferSelect | undefined;
    if (provider) {
      // This is the same fence used by admission and final workflow preparation.
      const [installed] = await tx
        .select()
        .from(agreements)
        .where(eq(agreements.revisionId, request.agreementRevisionId))
        .for("update");
      if (
        !installed ||
        installed.localOrgId !== actor.orgId ||
        installed.sourceSiteId !== request.senderSiteId ||
        installed.targetSiteId !== site
      )
        throw new FederationError("POLICY_DENIED");
      const [cancel] = await tx
        .select()
        .from(cancellations)
        .where(
          and(
            eq(cancellations.localSiteId, site),
            eq(cancellations.senderSiteId, request.senderSiteId),
            eq(cancellations.operationId, request.operationId),
          ),
        );
      if (
        !cancel?.confirmedAt ||
        cancel.requestDigest !== value.requestDigest ||
        cancel.cancellationDigest !== receipt.cancellationDigest ||
        cancel.agreementRevisionId !== request.agreementRevisionId ||
        cancel.recordedAt.toISOString() !== receipt.recordedAt
      )
        throw new FederationError("DATA_WAITING");
      const withdrawal = await this.verify(
        tx,
        FederationCancellationSchema,
        cancel.requestJws,
        request.senderSiteId,
      );
      if (
        withdrawal.digest !== receipt.cancellationDigest ||
        federationCanonicalJson(withdrawal.payload) !== federationCanonicalJson(cancel.request)
      )
        throw new FederationError("OPERATION_CONFLICT");
      [reservation] = await tx
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.senderSiteId, request.senderSiteId),
            eq(reservations.operationId, request.operationId),
          ),
        )
        .for("update");
      const stopped = await readFederationCancellationState(tx, request);
      if (
        !stopped.stopped ||
        stopped.runs.length !== 0 ||
        stopped.reservationId !== receipt.reservationId
      )
        throw new FederationError("DATA_WAITING");
      if (
        reservation &&
        (reservation.agreementRevisionId !== request.agreementRevisionId ||
          reservation.taskId !== request.taskId ||
          reservation.attempt !== request.attempt ||
          reservation.amount !== value.releasedAmount ||
          reservation.requestDigest !== value.requestDigest)
      )
        throw new FederationError("OPERATION_CONFLICT");
    } else {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${site}:${request.budgetDomainId}:${request.epoch}`}, 0))`,
      );
      [operation] = await tx
        .select()
        .from(outbound)
        .where(and(eq(outbound.localSiteId, site), eq(outbound.operationId, request.operationId)))
        .for("update");
      if (
        !operation ||
        operation.localOrgId !== actor.orgId ||
        operation.agreementRevisionId !== request.agreementRevisionId ||
        operation.cancelState !== "stopped" ||
        !operation.cancelJws ||
        operation.cancelDigest !== receipt.cancellationDigest ||
        operation.requestDigest !== value.requestDigest ||
        operation.amount !== value.releasedAmount ||
        operation.adjustmentHeldAmount !== "0" ||
        federationCanonicalJson(operation.request) !== federationCanonicalJson(request)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const withdrawal = await this.verify(
        tx,
        FederationCancellationSchema,
        operation.cancelJws,
        site,
      );
      if (
        withdrawal.digest !== receipt.cancellationDigest ||
        federationCanonicalJson(withdrawal.payload) !==
          federationCanonicalJson(operation.cancelRequest)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (
        operation.statusReport?.workflow ||
        (operation.receipt && operation.receipt.reservationId !== receipt.reservationId)
      )
        throw new FederationError("DATA_WAITING");
    }
    const originalJws = reservation?.requestJws ?? operation?.requestJws;
    if (originalJws) {
      const original = await this.verify(
        tx,
        FederationDelegationSchema,
        originalJws,
        request.senderSiteId,
      );
      if (
        original.digest !== value.requestDigest ||
        federationCanonicalJson(original.payload) !== federationCanonicalJson(request)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    // A persisted cancellation may precede admission: no provider budget was held in that case.
    const [prior] = await tx.select().from(refunds).where(this.key(value.refundId));
    const settled = reservation?.settledAmount ?? operation?.settledAmount;
    if (
      settled != null &&
      !(
        settled === "0" &&
        prior?.appliedAt &&
        federationCanonicalJson(prior.payload) === federationCanonicalJson(value)
      )
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [conflict] = await tx.execute<{ found: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM federation_commercial_bills WHERE local_site_id = ${site} AND agreement_revision_id = ${request.agreementRevisionId}::uuid AND task_id = ${request.taskId}::uuid AND attempt = ${request.attempt}
      UNION ALL SELECT 1 FROM federation_usage_reports u JOIN federation_reservations r ON r.id = u.reservation_id
        WHERE r.sender_site_id = ${request.senderSiteId} AND r.operation_id = ${request.operationId}
      UNION ALL SELECT 1 FROM federation_received_usage WHERE local_site_id = ${site} AND operation_id = ${request.operationId}
    ) AS found`);
    if (conflict?.found) throw new FederationError("OPERATION_CONFLICT");
    return { contract, reservation, operation };
  }

  async draft(
    actor: FederationActor,
    revisionId: string,
    operationId: string,
    refundId: string,
    reason: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const contract = await this.contract(tx, actor, revisionId);
      const [operation] = await tx
        .select()
        .from(outbound)
        .where(
          and(
            eq(outbound.localSiteId, this.signing.siteId),
            eq(outbound.operationId, operationId),
            eq(outbound.localOrgId, actor.orgId),
            eq(outbound.agreementRevisionId, revisionId),
          ),
        );
      if (!operation?.cancelReceiptJws) throw new FederationError("DATA_WAITING");
      const value = CommercialRefundSchema.parse({
        protocolVersion: 1,
        kind: "commercial-refund",
        refundId,
        domainId: contract.terms.domainId,
        agreementDigest: contract.digest,
        request: operation.request,
        requestDigest: operation.requestDigest,
        cancellationReceiptJws: operation.cancelReceiptJws,
        releasedAmount: operation.amount,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
        reason,
      });
      await this.originals(tx, actor, value);
      return value;
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialRefund) {
    const value = CommercialRefundSchema.parse(raw);
    if (value.request.agreementRevisionId !== revisionId)
      throw new FederationError("OPERATION_CONFLICT");
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "settlement.approve");
      await this.originals(tx, actor, value);
      const [prior] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.localSiteId, this.signing.siteId),
            eq(refunds.operationId, value.request.operationId),
          ),
        );
      if (prior) {
        if (
          prior.refundId !== value.refundId ||
          prior.localOrgId !== actor.orgId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        const signed = await this.verify(
          tx,
          CommercialRefundSchema,
          prior.approvalJws,
          this.signing.siteId,
        );
        if (
          signed.digest !== prior.digest ||
          federationCanonicalJson(signed.payload) !== federationCanonicalJson(prior.payload)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      await renewTaskCompletion(tx, this.signing.siteId, value.request, this.storageGuard);
      const signed = await this.verify(
        tx,
        CommercialRefundSchema,
        await signFederationMessage(CommercialRefundSchema, value, this.signing),
        this.signing.siteId,
      );
      const [row] = await tx
        .insert(refunds)
        .values({
          localSiteId: this.signing.siteId,
          refundId: value.refundId,
          agreementRevisionId: revisionId,
          localOrgId: actor.orgId,
          operationId: value.request.operationId,
          payload: value,
          digest: signed.digest,
          approvalJws: signed.jws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Refund approval was not saved");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.refund.approve",
        target: row.refundId,
        diff: { after: { digest: row.digest } },
      });
      return row;
    });
  }
  async attachExchanged(
    revisionId: string,
    refundId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    const [row] = await this.db
      .select()
      .from(refunds)
      .where(and(this.key(refundId), eq(refunds.agreementRevisionId, revisionId)));
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return this.attachCounterparty(
      { userId: row.approvedBy, orgId: row.localOrgId },
      revisionId,
      refundId,
      jws,
      authorize,
    );
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    refundId: string,
    jws: string,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (!authorize) await requireFederationCapability(tx, actor, "settlement.approve");
      const [snapshot] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            this.key(refundId),
            eq(refunds.localOrgId, actor.orgId),
            eq(refunds.agreementRevisionId, revisionId),
          ),
        );
      if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
      const { reservation, operation } = await this.originals(tx, actor, snapshot.payload);
      const [row] = await tx.select().from(refunds).where(this.key(refundId)).for("update");
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const value = row.payload,
        request = value.request,
        provider = this.signing.siteId === request.recipientSiteId;
      for (const [site, signature] of [
        [this.signing.siteId, row.approvalJws],
        [provider ? request.senderSiteId : request.recipientSiteId, jws],
      ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
        if (!site || !signature) throw new FederationError("OPERATION_CONFLICT");
        const signed = await this.verify(tx, CommercialRefundSchema, signature, site);
        if (
          signed.digest !== row.digest ||
          federationCanonicalJson(signed.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
      if (row.counterpartyJws && row.counterpartyJws !== jws)
        throw new FederationError("OPERATION_CONFLICT");
      await authorize?.(tx);
      if (row.appliedAt) return row;
      if (reservation) {
        const [budget] = await tx
          .select()
          .from(budgets)
          .where(
            and(eq(budgets.domainId, request.budgetDomainId), eq(budgets.epoch, request.epoch)),
          )
          .for("update");
        if (
          !budget ||
          budget.unit !== request.unit ||
          BigInt(budget.reserved) < BigInt(value.releasedAmount)
        )
          throw new FederationError("OPERATION_CONFLICT");
        await tx
          .update(budgets)
          .set({
            reserved: (BigInt(budget.reserved) - BigInt(value.releasedAmount)).toString(),
            available: (BigInt(budget.available) + BigInt(value.releasedAmount)).toString(),
          })
          .where(
            and(eq(budgets.domainId, request.budgetDomainId), eq(budgets.epoch, request.epoch)),
          );
        await tx
          .update(reservations)
          .set({ settledAmount: "0" })
          .where(eq(reservations.id, reservation.id));
      }
      if (operation)
        await tx
          .update(outbound)
          .set({
            settledAmount: "0",
            // An unexecuted refund has no future workflow status; fence in-flight poll responses.
            statusClaim: null,
            statusNextAttemptAt: null,
            statusLastError: null,
          })
          .where(
            and(
              eq(outbound.localSiteId, this.signing.siteId),
              eq(outbound.operationId, request.operationId),
            ),
          );
      const [saved] = await tx
        .update(refunds)
        .set({ counterpartyJws: jws, appliedAt: sql`clock_timestamp()` })
        .where(this.key(refundId))
        .returning();
      if (!saved) throw new Error("Refund application was not saved");
      if (provider && request.mode === "bilateral_attested")
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation: "record-refund",
            domainId: value.domainId,
            recordId: refundId,
            digest: row.digest,
            envelope: {
              sourceSiteId: request.senderSiteId,
              targetSiteId: request.recipientSiteId,
              sourceJws: jws,
              targetJws: row.approvalJws,
            },
          }),
        });
      await tx.insert(auditLog).values({
        actor: authorize ? `refund-exchange:${this.signing.siteId}` : actor.userId,
        orgId: actor.orgId,
        action: "federation.refund.apply",
        target: refundId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select({
          ...getTableColumns(refunds),
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(refunds)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, refunds.localSiteId),
            sql`${submissions.input}->>'operation' = 'record-refund'`,
            sql`${submissions.input}->>'recordId' = ${refunds.refundId}::text`,
          ),
        )
        .where(
          and(
            eq(refunds.localSiteId, this.signing.siteId),
            eq(refunds.localOrgId, actor.orgId),
            eq(refunds.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(refunds.createdAt), desc(refunds.refundId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
