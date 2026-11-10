import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialBills as bills,
  federationBudgets as budgets,
  federationCommercialAgreements as contracts,
  federationAgreements as installed,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationReservations as reservations,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  assertArbitratedSettlement,
  assertCommercialSettlement,
} from "@kuintessence/shared/federation/billing";
import {
  CommercialAdapterProposalInputSchema,
  CommercialBillSchema,
  type CommercialSettlement,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyArbitratedFinancialOriginal } from "./arbitrated-financial-original";
import { assertClosingPolicyActive, FederationClosingPolicyService } from "./closing-policy";
import { assertFederationTaskNotDisputed } from "./dispute-freeze";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Caller holds the settlement row. Coordinated callers must first persist a VALID ledger result. */
export async function applyFederationSettlement(
  tx: PgTransaction,
  row: typeof settlements.$inferSelect,
  bill: typeof bills.$inferSelect,
) {
  if (row.appliedAt) return;
  if ((!row.counterpartyJws && !row.arbitrationDecisionId) || !bill.counterpartyJws)
    throw new FederationError("POLICY_DENIED");
  const value = CommercialSettlementSchema.parse(row.payload),
    request = bill.payload.request;
  if (row.arbitrationDecisionId)
    assertArbitratedSettlement(
      value,
      bill.payload,
      bill.digest,
      await verifyArbitratedFinancialOriginal(tx, row.localSiteId, row),
    );
  else assertCommercialSettlement(value, bill.payload, bill.digest);
  if (value.targetSiteId === row.localSiteId) {
    // Match admission's agreement -> reservation -> budget lock order.
    const [agreement] = await tx
      .select()
      .from(installed)
      .where(eq(installed.revisionId, row.agreementRevisionId))
      .for("update");
    if (
      !agreement ||
      agreement.localOrgId !== row.localOrgId ||
      agreement.sourceSiteId !== value.sourceSiteId ||
      agreement.targetSiteId !== row.localSiteId
    )
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    const [reservation] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.agreementRevisionId, row.agreementRevisionId),
          eq(reservations.senderSiteId, value.sourceSiteId),
          eq(reservations.operationId, request.operationId),
        ),
      )
      .for("update");
    if (
      !reservation ||
      reservation.state !== "reserved" ||
      !reservation.receiptJws ||
      reservation.amount !== value.reservedAmount ||
      reservation.taskId !== request.taskId ||
      reservation.attempt !== request.attempt ||
      reservation.settledAmount !== null ||
      (value.reservationId !== null && value.reservationId !== reservation.id)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (request.mode !== "ledger_coordinated") {
      const [budget] = await tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.domainId, request.budgetDomainId), eq(budgets.epoch, request.epoch)))
        .for("update");
      if (
        !budget ||
        budget.unit !== value.unit ||
        BigInt(budget.reserved) < BigInt(value.reservedAmount)
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(budgets)
        .set({
          reserved: (BigInt(budget.reserved) - BigInt(value.reservedAmount)).toString(),
          available: (BigInt(budget.available) + BigInt(value.releasedAmount)).toString(),
          spent: (BigInt(budget.spent) + BigInt(value.chargedAmount)).toString(),
        })
        .where(and(eq(budgets.domainId, request.budgetDomainId), eq(budgets.epoch, request.epoch)));
    }
    await tx
      .update(reservations)
      .set({ settledAmount: value.chargedAmount })
      .where(eq(reservations.id, reservation.id));
  } else {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${row.localSiteId}:${request.budgetDomainId}:${request.epoch}`}, 0))`,
    );
    const [operation] = await tx
      .select()
      .from(outbound)
      .where(
        and(
          eq(outbound.localSiteId, row.localSiteId),
          eq(outbound.operationId, request.operationId),
        ),
      )
      .for("update");
    if (
      !operation ||
      operation.localOrgId !== row.localOrgId ||
      operation.state !== "accepted" ||
      operation.amount !== value.reservedAmount ||
      operation.settledAmount !== null ||
      federationCanonicalJson(operation.request) !== federationCanonicalJson(request) ||
      (value.reservationId !== null && operation.receipt?.reservationId !== value.reservationId)
    )
      throw new FederationError("OPERATION_CONFLICT");
    await tx
      .update(outbound)
      .set({ settledAmount: value.chargedAmount })
      .where(
        and(
          eq(outbound.localSiteId, row.localSiteId),
          eq(outbound.operationId, request.operationId),
        ),
      );
  }
  await tx
    .update(settlements)
    .set({ appliedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(settlements.localSiteId, row.localSiteId),
        eq(settlements.settlementId, row.settlementId),
      ),
    );
  await tx.insert(auditLog).values({
    actor: `settlement:${row.localSiteId}`,
    orgId: row.localOrgId,
    action: "federation.settlement.apply",
    target: row.settlementId,
    diff: { after: { digest: row.digest } },
  });
}

export class FederationSettlementService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(settlementId: string) {
    return and(
      eq(settlements.localSiteId, this.signing.siteId),
      eq(settlements.settlementId, settlementId),
    );
  }
  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [contract] = await tx
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
    if (!contract?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return contract;
  }
  private async original(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    billId: string,
  ) {
    const contract = await this.contract(tx, actor, revisionId);
    const [bill] = await tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.localSiteId, this.signing.siteId),
          eq(bills.billId, billId),
          eq(bills.agreementRevisionId, revisionId),
          eq(bills.localOrgId, actor.orgId),
        ),
      )
      .for("share");
    if (!bill?.counterpartyJws) throw new FederationError("DATA_WAITING");
    const value = CommercialBillSchema.parse(bill.payload);
    if (
      value.agreementDigest !== contract.digest ||
      value.domainId !== contract.terms.domainId ||
      value.request.agreementRevisionId !== revisionId ||
      value.request.senderSiteId !== contract.terms.agreement.sourceSiteId ||
      value.request.recipientSiteId !== contract.terms.agreement.targetSiteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const other =
      value.request.senderSiteId === this.signing.siteId
        ? value.request.recipientSiteId
        : value.request.senderSiteId;
    for (const [siteId, jws] of [
      [this.signing.siteId, bill.approvalJws],
      [other, bill.counterpartyJws],
    ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
      const keyId = federationMessageKeyId(jws),
        now = new Date();
      await this.trust.assertKey(tx, siteId, keyId, now);
      const signed = await verifyFederationMessage(
        CommercialBillSchema,
        jws,
        await this.trust.resolveKey(siteId, keyId, now, tx),
        now,
      );
      if (signed.digest !== bill.digest) throw new FederationError("OPERATION_CONFLICT");
    }
    return bill;
  }
  private async terminal(tx: PgTransaction, bill: typeof bills.$inferSelect) {
    if (!bill.payload.reservationId) return null;
    const [terminal] = await tx
      .select()
      .from(terminals)
      .where(
        and(
          eq(terminals.localSiteId, this.signing.siteId),
          eq(terminals.reservationId, bill.payload.reservationId),
        ),
      )
      .for("share");
    if (
      !terminal?.counterpartyJws ||
      terminal.payload.domainId !== bill.payload.domainId ||
      terminal.payload.sourceSiteId !== bill.payload.request.senderSiteId ||
      terminal.payload.targetSiteId !== bill.payload.request.recipientSiteId
    )
      throw new FederationError("DATA_WAITING");
    return { terminalId: terminal.terminalId, digest: terminal.digest };
  }
  private async verify(tx: PgTransaction, jws: string, siteId: string) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      CommercialSettlementSchema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  async draft(actor: FederationActor, revisionId: string, billId: string, settlementId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return this.draftInTransaction(tx, actor, revisionId, billId, settlementId);
    });
  }
  private async draftInTransaction(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    billId: string,
    settlementId: string,
  ) {
    const bill = await this.original(tx, actor, revisionId, billId),
      value = bill.payload;
    return CommercialSettlementSchema.parse({
      protocolVersion: 1,
      kind: "commercial-settlement",
      settlementId,
      billId,
      domainId: value.domainId,
      agreementRevisionId: revisionId,
      billDigest: bill.digest,
      sourceSiteId: value.request.senderSiteId,
      targetSiteId: value.request.recipientSiteId,
      reservationId: value.reservationId,
      terminal: await this.terminal(tx, bill),
      unit: value.request.unit,
      reservedAmount: value.request.maxAmount,
      chargedAmount: value.calculation.dueAmount,
      releasedAmount: (
        BigInt(value.request.maxAmount) - BigInt(value.calculation.dueAmount)
      ).toString(),
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialSettlement) {
    const value = CommercialSettlementSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "settlement.approve");
      return this.approveInTransaction(tx, actor, revisionId, value);
    });
  }
  /** Only local orchestration can use institution-owned authority; HTTP approval cannot supply a policy. */
  async automate(
    policyId: string,
    raw: CommercialSettlement,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    const value = CommercialSettlementSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const policy = await new FederationClosingPolicyService(
        this.db,
        this.signing.siteId,
      ).authority(tx, policyId, "settlement");
      await authorize?.(tx);
      const saved = await this.approveInTransaction(
        tx,
        { orgId: policy.localOrgId, userId: policy.grantedBy },
        policy.agreementRevisionId,
        value,
        policy,
      );
      await authorize?.(tx);
      assertClosingPolicyActive(policy);
      return saved;
    });
  }
  async automateDraft(
    policyId: string,
    billId: string,
    finish: (tx: PgTransaction, row: typeof settlements.$inferSelect) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      const policy = await new FederationClosingPolicyService(
        this.db,
        this.signing.siteId,
      ).authority(tx, policyId, "settlement");
      const actor = { orgId: policy.localOrgId, userId: policy.grantedBy },
        revisionId = policy.agreementRevisionId;
      const bill = await this.original(tx, actor, revisionId, billId);
      if (bill.payload.request.recipientSiteId !== this.signing.siteId)
        throw new FederationError("POLICY_DENIED");
      const [prior] = await tx
        .select()
        .from(settlements)
        .where(
          and(eq(settlements.localSiteId, this.signing.siteId), eq(settlements.billId, billId)),
        );
      const payload =
        prior?.payload ??
        (await this.draftInTransaction(tx, actor, revisionId, billId, randomUUID()));
      const saved = await this.approveInTransaction(tx, actor, revisionId, payload, policy);
      await finish(tx, saved);
      assertClosingPolicyActive(policy);
      return saved;
    });
  }
  private async approveInTransaction(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    value: CommercialSettlement,
    policy?: Awaited<ReturnType<FederationClosingPolicyService["authority"]>>,
  ) {
    const bill = await this.original(tx, actor, revisionId, value.billId);
    assertCommercialSettlement(value, bill.payload, bill.digest);
    if (
      Date.parse(value.issuedAt) > Date.now() + 60000 ||
      federationCanonicalJson(value.terminal) !==
        federationCanonicalJson(await this.terminal(tx, bill))
    )
      throw new FederationError("POLICY_DENIED");
    const [prior] = await tx.select().from(settlements).where(this.key(value.settlementId));
    if (prior) {
      if (
        prior.localOrgId !== actor.orgId ||
        prior.agreementRevisionId !== revisionId ||
        federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (!prior.approvalJws) throw new FederationError("OPERATION_CONFLICT");
      await this.verify(tx, prior.approvalJws, this.signing.siteId);
      if (!prior.approvalJws) throw new FederationError("OPERATION_CONFLICT");
      return { ...prior, approvalJws: prior.approvalJws };
    }
    await assertFederationTaskNotDisputed(tx, this.signing.siteId, bill.payload.request);
    const signed = await this.verify(
      tx,
      await signFederationMessage(CommercialSettlementSchema, value, this.signing),
      this.signing.siteId,
    );
    const [row] = await tx
      .insert(settlements)
      .values({
        localSiteId: this.signing.siteId,
        settlementId: value.settlementId,
        billId: value.billId,
        agreementRevisionId: revisionId,
        localOrgId: actor.orgId,
        payload: value,
        digest: signed.digest,
        approvalJws: signed.jws,
        approvedBy: actor.userId,
        authorizationPolicyId: policy?.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [same] = await tx.select().from(settlements).where(this.key(value.settlementId));
      if (
        !same ||
        same.localOrgId !== actor.orgId ||
        same.agreementRevisionId !== revisionId ||
        same.digest !== signed.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (!same.approvalJws) throw new FederationError("OPERATION_CONFLICT");
      return { ...same, approvalJws: same.approvalJws };
    }
    if (policy) {
      await new FederationClosingPolicyService(this.db, this.signing.siteId).consume(
        tx,
        policy,
        value.chargedAmount,
        bill.payload.request,
      );
      assertClosingPolicyActive(policy);
    }
    await tx.insert(auditLog).values({
      actor: policy ? `closing-policy:${policy.id}` : actor.userId,
      orgId: actor.orgId,
      action: "federation.settlement.approve",
      target: row.settlementId,
      diff: { after: { digest: row.digest } },
    });
    if (!row.approvalJws) throw new FederationError("OPERATION_CONFLICT");
    return { ...row, approvalJws: row.approvalJws };
  }
  async attachExchanged(
    revisionId: string,
    settlementId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    const [row] = await this.db
      .select()
      .from(settlements)
      .where(and(this.key(settlementId), eq(settlements.agreementRevisionId, revisionId)));
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return this.attachCounterparty(
      { userId: row.approvedBy, orgId: row.localOrgId },
      revisionId,
      settlementId,
      jws,
      authorize,
    );
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    settlementId: string,
    jws: string,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (!authorize) await requireFederationCapability(tx, actor, "settlement.approve");
      await this.contract(tx, actor, revisionId);
      const [snapshot] = await tx
        .select()
        .from(settlements)
        .where(
          and(
            this.key(settlementId),
            eq(settlements.localOrgId, actor.orgId),
            eq(settlements.agreementRevisionId, revisionId),
          ),
        );
      if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
      const bill = await this.original(tx, actor, revisionId, snapshot.billId);
      const [row] = await tx.select().from(settlements).where(this.key(settlementId)).for("update");
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const provider = row.payload.targetSiteId === this.signing.siteId,
        other = provider ? row.payload.sourceSiteId : row.payload.targetSiteId;
      for (const [siteId, signature] of [
        [this.signing.siteId, row.approvalJws],
        [other, jws],
      ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
        if (!siteId || !signature) throw new FederationError("INVALID_MESSAGE");
        if ((await this.verify(tx, signature, siteId)).digest !== row.digest)
          throw new FederationError("OPERATION_CONFLICT");
      }
      assertCommercialSettlement(row.payload, bill.payload, bill.digest);
      if (
        federationCanonicalJson(row.payload.terminal) !==
        federationCanonicalJson(await this.terminal(tx, bill))
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (row.counterpartyJws && row.counterpartyJws !== jws)
        throw new FederationError("OPERATION_CONFLICT");
      await authorize?.(tx);
      if (row.counterpartyJws) return row;
      const [updated] = await tx
        .update(settlements)
        .set({ counterpartyJws: jws })
        .where(this.key(settlementId))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      const mode = bill.payload.request.mode;
      if (mode !== "ledger_coordinated") await applyFederationSettlement(tx, updated, bill);
      // Both coordinated sites observe their own VALID result before freeing local concurrency slots.
      if (mode === "ledger_coordinated" || (provider && mode === "bilateral_attested"))
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation: "settle-bill",
            domainId: row.payload.domainId,
            recordId: settlementId,
            digest: row.digest,
            envelope: {
              sourceSiteId: row.payload.sourceSiteId,
              targetSiteId: row.payload.targetSiteId,
              sourceJws: provider ? jws : row.approvalJws,
              targetJws: provider ? row.approvalJws : jws,
            },
          }),
        });
      await tx.insert(auditLog).values({
        actor: authorize ? `settlement-exchange:${this.signing.siteId}` : actor.userId,
        orgId: actor.orgId,
        action: "federation.settlement.counterparty",
        target: settlementId,
        diff: { after: { digest: row.digest } },
      });
      const [result] = await tx.select().from(settlements).where(this.key(settlementId));
      return result;
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit: number,
    offset: number,
    recordId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select({
          settlement: settlements,
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(settlements)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, settlements.localSiteId),
            sql`${submissions.input}->>'operation' = CASE WHEN ${settlements.arbitrationDecisionId} IS NULL THEN 'settle-bill' ELSE 'resolve-arbitrated-case' END`,
            sql`${submissions.input}->>'recordId' = ${settlements.settlementId}::text`,
          ),
        )
        .where(
          and(
            eq(settlements.localSiteId, this.signing.siteId),
            eq(settlements.localOrgId, actor.orgId),
            eq(settlements.agreementRevisionId, revisionId),
            recordId ? eq(settlements.settlementId, recordId) : undefined,
          ),
        )
        .orderBy(desc(settlements.createdAt), desc(settlements.settlementId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
