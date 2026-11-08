import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialBills as bills,
  federationWorkflowBindings as bindings,
  federationCommercialAgreements as contracts,
  federationCommercialDiscounts as discounts,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationReceivedUsage as received,
  federationUsageReports as reports,
  federationReservations as reservations,
  federationCommercialSubmissions as submissions,
  federationUsageSyncs as syncs,
  federationUsageTasks as tasks,
  federationExecutionTerminals as terminals,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  assertCommercialBill,
  assertCommercialDiscount,
  calculateCommercialBill,
} from "@kuintessence/shared/federation/billing";
import {
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
  type CommercialBill,
  CommercialBillSchema,
  type CommercialDiscount,
  CommercialDiscountSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { assertClosingPolicyActive, FederationClosingPolicyService } from "./closing-policy";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Explicit human or bounded institutional approval; terminal reports and chain availability grant no authority. */
export class FederationBillingService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private scope(revisionId: string, actor: FederationActor) {
    return and(
      eq(contracts.localSiteId, this.signing.siteId),
      eq(contracts.revisionId, revisionId),
      eq(contracts.localOrgId, actor.orgId),
    );
  }
  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(this.scope(revisionId, actor))
      .for("share");
    if (!contract?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return { contract, terms: CommercialAgreementSchema.parse(contract.terms) };
  }
  private async originals(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    reportId: string,
    requireLatest = true,
  ) {
    const { contract, terms } = await this.contract(tx, actor, revisionId);
    const provider = terms.agreement.targetSiteId === this.signing.siteId;
    const original = await (async () => {
      if (provider) {
        const [saved] = await tx
          .select({
            report: reports,
            task: tasks,
            reservation: reservations,
            binding: bindings,
            run: workflowRuns,
          })
          .from(reports)
          .innerJoin(tasks, eq(tasks.reservationId, reports.reservationId))
          .innerJoin(reservations, eq(reservations.id, tasks.reservationId))
          .innerJoin(bindings, eq(bindings.reservationId, tasks.reservationId))
          .innerJoin(workflowRuns, eq(workflowRuns.id, bindings.workflowRunId))
          .where(
            and(
              eq(reports.id, reportId),
              eq(tasks.localSiteId, this.signing.siteId),
              eq(tasks.localOrgId, actor.orgId),
              eq(tasks.agreementRevisionId, revisionId),
            ),
          )
          .for("update", { of: tasks });
        if (
          !saved ||
          saved.task.state !== "reported" ||
          !["completed", "failed", "cancelled"].includes(saved.run.status)
        )
          throw new FederationError("DATA_WAITING");
        const [latest] = await tx
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.reservationId, saved.task.reservationId))
          .orderBy(desc(reports.number))
          .limit(1);
        if (requireLatest && latest?.id !== reportId)
          throw new FederationError("OPERATION_CONFLICT");
        if (
          saved.binding.snapshot.requestDigest !== saved.reservation.requestDigest ||
          saved.reservation.agreementRevisionId !== revisionId
        )
          throw new FederationError("OPERATION_CONFLICT");
        return {
          record: saved.report,
          request: saved.binding.snapshot.request,
          reservationId: saved.reservation.id,
        };
      }
      const [saved] = await tx
        .select({ report: received, operation: outbound })
        .from(received)
        .innerJoin(
          outbound,
          and(
            eq(outbound.localSiteId, received.localSiteId),
            eq(outbound.operationId, received.operationId),
          ),
        )
        .where(
          and(
            eq(received.localSiteId, this.signing.siteId),
            eq(received.reportId, reportId),
            eq(outbound.localOrgId, actor.orgId),
            eq(outbound.agreementRevisionId, revisionId),
          ),
        );
      if (
        !saved ||
        saved.operation.state !== "accepted" ||
        !saved.operation.receipt ||
        !saved.operation.statusReport ||
        !["completed", "failed", "cancelled"].includes(
          saved.operation.statusReport.workflow?.status ?? "",
        )
      )
        throw new FederationError("DATA_WAITING");
      // The same row serializes incoming technical corrections and this review of the latest report.
      const [sync] = await tx
        .select()
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.operationId, saved.operation.operationId),
          ),
        )
        .for("update");
      if (
        !sync ||
        sync.number < saved.report.number ||
        (requireLatest && (sync.lastReportId !== reportId || sync.number !== saved.report.number))
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        record: saved.report,
        request: saved.operation.request,
        reservationId: saved.operation.receipt.reservationId,
      };
    })();
    const request = FederationDelegationSchema.parse(original.request),
      report = CommercialUsageSchema.parse(original.record.report);
    if (request.agreementRevisionId !== revisionId || report.agreementDigest !== contract.digest)
      throw new FederationError("OPERATION_CONFLICT");
    calculateCommercialBill(terms, request, report);
    if (request.mode === "ledger_coordinated") {
      const [terminal] = await tx
        .select()
        .from(terminals)
        .where(
          and(
            eq(terminals.localSiteId, this.signing.siteId),
            eq(terminals.reservationId, original.reservationId),
          ),
        )
        .for("share");
      if (
        !terminal?.counterpartyJws ||
        Date.parse(report.periodEnd) > Date.parse(terminal.payload.observedAt)
      )
        throw new FederationError("DATA_WAITING");
    }
    return {
      contract,
      terms,
      request,
      report,
      reportDigest: original.record.digest,
      reportJws: original.record.reportJws,
      provider,
      reservationId: request.mode === "ledger_coordinated" ? original.reservationId : null,
    };
  }
  private async concession(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    discountId?: string,
  ) {
    if (!discountId) return undefined;
    const [row] = await tx
      .select()
      .from(discounts)
      .where(
        and(
          eq(discounts.localSiteId, this.signing.siteId),
          eq(discounts.localOrgId, actor.orgId),
          eq(discounts.agreementRevisionId, revisionId),
          eq(discounts.discountId, discountId),
        ),
      );
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return { terms: CommercialDiscountSchema.parse(row.payload), digest: row.digest };
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
  private async sign<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    payload: T,
  ) {
    await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
    const jws = await signFederationMessage(schema, payload, this.signing);
    return this.verify(tx, schema, jws, this.signing.siteId);
  }
  private audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    id: string,
    digest: string,
  ) {
    return tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.billing.${action}`,
      target: id,
      diff: { after: { digest } },
    });
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    reportId: string,
    billId: string,
    discountId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return this.draftInTransaction(tx, actor, revisionId, reportId, billId, discountId);
    });
  }
  private async draftInTransaction(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    reportId: string,
    billId: string,
    discountId?: string,
  ) {
    const f = await this.originals(tx, actor, revisionId, reportId),
      discount = await this.concession(tx, actor, revisionId, discountId);
    const bill = CommercialBillSchema.parse({
      protocolVersion: 1,
      kind: "commercial-bill",
      billId,
      domainId: f.terms.domainId,
      agreementDigest: f.contract.digest,
      priceVersionId: f.terms.priceVersionId,
      reportId,
      reportDigest: f.reportDigest,
      request: f.request,
      reservationId: f.reservationId,
      discount: discount
        ? { discountId: discount.terms.discountId, digest: discount.digest }
        : null,
      calculation: calculateCommercialBill(f.terms, f.request, f.report, discount?.terms.amount),
      issuedAt: new Date().toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
    assertCommercialBill(bill, f.terms, f.contract.digest, f.report, f.reportDigest, discount);
    return bill;
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialBill) {
    const value = CommercialBillSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "billing.approve");
      return this.approveInTransaction(tx, actor, revisionId, value);
    });
  }
  /** Only local orchestration can use institution-owned authority; HTTP approval cannot supply a policy. */
  async automate(
    policyId: string,
    raw: CommercialBill,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    const value = CommercialBillSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const policy = await new FederationClosingPolicyService(
        this.db,
        this.signing.siteId,
      ).authority(tx, policyId, "bill");
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
    reservationId: string,
    finish: (tx: PgTransaction, row: typeof bills.$inferSelect) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      const policy = await new FederationClosingPolicyService(
        this.db,
        this.signing.siteId,
      ).authority(tx, policyId, "bill");
      const actor = { orgId: policy.localOrgId, userId: policy.grantedBy },
        revisionId = policy.agreementRevisionId;
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.localSiteId, this.signing.siteId),
            eq(tasks.localOrgId, actor.orgId),
            eq(tasks.agreementRevisionId, revisionId),
            eq(tasks.reservationId, reservationId),
          ),
        )
        .for("update");
      if (!task || task.state !== "reported") throw new FederationError("DATA_WAITING");
      const [binding] = await tx
        .select()
        .from(bindings)
        .where(eq(bindings.reservationId, reservationId));
      if (!binding || binding.snapshot.request.recipientSiteId !== this.signing.siteId)
        throw new FederationError("POLICY_DENIED");
      const request = binding.snapshot.request;
      const [prior] = await tx
        .select()
        .from(bills)
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            eq(bills.localOrgId, actor.orgId),
            eq(bills.agreementRevisionId, revisionId),
            eq(bills.taskId, request.taskId),
            eq(bills.attempt, request.attempt),
          ),
        );
      let payload = prior?.payload;
      if (!payload) {
        const [discount] = await tx
          .select({ id: discounts.discountId })
          .from(discounts)
          .where(
            and(
              eq(discounts.localSiteId, this.signing.siteId),
              eq(discounts.localOrgId, actor.orgId),
              eq(discounts.agreementRevisionId, revisionId),
              sql`${discounts.payload}->>'taskId' = ${request.taskId}`,
              sql`(${discounts.payload}->>'attempt')::int = ${request.attempt}`,
            ),
          )
          .limit(1);
        if (discount) throw new FederationError("OPERATION_CONFLICT");
        const [report] = await tx
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.reservationId, reservationId))
          .orderBy(desc(reports.number))
          .limit(1);
        if (!report) throw new FederationError("DATA_WAITING");
        payload = await this.draftInTransaction(tx, actor, revisionId, report.id, randomUUID());
      }
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
    bill: CommercialBill,
    policy?: Awaited<ReturnType<FederationClosingPolicyService["authority"]>>,
  ) {
    await this.contract(tx, actor, revisionId);
    const [prior] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, bill.billId)));
    if (prior) {
      if (
        prior.localOrgId !== actor.orgId ||
        prior.agreementRevisionId !== revisionId ||
        federationCanonicalJson(prior.payload) !== federationCanonicalJson(bill)
      )
        throw new FederationError("OPERATION_CONFLICT");
      return prior;
    }
    const f = await this.originals(tx, actor, revisionId, bill.reportId);
    const discount = await this.concession(tx, actor, revisionId, bill.discount?.discountId);
    if (
      bill.reservationId !== f.reservationId ||
      federationCanonicalJson(bill.request) !== federationCanonicalJson(f.request) ||
      Date.parse(bill.issuedAt) > Date.now() + 60000
    )
      throw new FederationError("POLICY_DENIED");
    assertCommercialBill(bill, f.terms, f.contract.digest, f.report, f.reportDigest, discount);
    if (policy) {
      const report = await this.verify(
        tx,
        CommercialUsageSchema,
        f.reportJws,
        f.request.recipientSiteId,
      );
      if (report.digest !== f.reportDigest) throw new FederationError("OPERATION_CONFLICT");
    }
    const signed = await this.sign(tx, CommercialBillSchema, bill);
    const [row] = await tx
      .insert(bills)
      .values({
        localSiteId: this.signing.siteId,
        billId: bill.billId,
        agreementRevisionId: revisionId,
        localOrgId: actor.orgId,
        taskId: bill.request.taskId,
        attempt: bill.request.attempt,
        payload: bill,
        digest: signed.digest,
        approvalJws: signed.jws,
        approvedBy: actor.userId,
        authorizationPolicyId: policy?.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [same] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, bill.billId)));
      if (
        !same ||
        same.localOrgId !== actor.orgId ||
        same.agreementRevisionId !== revisionId ||
        same.digest !== signed.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
      return same;
    }
    if (policy) {
      await new FederationClosingPolicyService(this.db, this.signing.siteId).consume(
        tx,
        policy,
        bill.calculation.dueAmount,
        bill.request,
      );
      assertClosingPolicyActive(policy);
    }
    await this.audit(
      tx,
      policy ? { ...actor, userId: `closing-policy:${policy.id}` } : actor,
      "approve",
      bill.billId,
      signed.digest,
    );
    return row;
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    billId: string,
    jws: string,
  ) {
    return this.attach(actor, revisionId, billId, jws);
  }
  /** Existing business consent only; the exchange lease is fenced in the attachment transaction. */
  async attachExchanged(
    revisionId: string,
    billId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    const [local] = await this.db
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.localSiteId, this.signing.siteId),
          eq(bills.billId, billId),
          eq(bills.agreementRevisionId, revisionId),
        ),
      );
    if (!local) throw new FederationError("ASSET_UNAVAILABLE");
    return this.attach(
      { userId: local.approvedBy, orgId: local.localOrgId },
      revisionId,
      billId,
      jws,
      authorize,
    );
  }
  private async attach(
    actor: FederationActor,
    revisionId: string,
    billId: string,
    jws: string,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (!authorize) await requireFederationCapability(tx, actor, "billing.approve");
      await this.contract(tx, actor, revisionId);
      // Lock the usage head before the bill, consistently with approve and corrections.
      const [snapshot] = await tx
        .select()
        .from(bills)
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            eq(bills.billId, billId),
            eq(bills.localOrgId, actor.orgId),
            eq(bills.agreementRevisionId, revisionId),
          ),
        );
      if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
      if (snapshot.counterpartyJws) {
        if (snapshot.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        await authorize?.(tx);
        return snapshot;
      }
      // A signed bill remains binding until explicitly resolved; later metering does not revoke an approval.
      const f = await this.originals(tx, actor, revisionId, snapshot.payload.reportId, false);
      const [row] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, billId)))
        .for("update");
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const otherSiteId = f.provider
        ? f.terms.agreement.sourceSiteId
        : f.terms.agreement.targetSiteId;
      // Current business authority is checked for both original signatures before confirmation.
      for (const [signature, siteId] of [
        [row.approvalJws, this.signing.siteId],
        [jws, otherSiteId],
      ].sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? ""))) {
        if (!signature || !siteId) throw new FederationError("INVALID_MESSAGE");
        const verified = await this.verify(tx, CommercialBillSchema, signature, siteId);
        if (verified.digest !== row.digest) throw new FederationError("OPERATION_CONFLICT");
      }
      if (row.counterpartyJws) {
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        await authorize?.(tx);
        return row;
      }
      const discount = await this.concession(
        tx,
        actor,
        revisionId,
        row.payload.discount?.discountId,
      );
      assertCommercialBill(
        row.payload,
        f.terms,
        f.contract.digest,
        f.report,
        f.reportDigest,
        discount,
      );
      await authorize?.(tx);
      const [updated] = await tx
        .update(bills)
        .set({ counterpartyJws: jws })
        .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, billId)))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      // Provider owns usage/discount outboxes; source confirmation never waits for these ledger writes.
      if (f.provider && f.request.mode !== "bilateral_direct")
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation: "confirm-bill",
            domainId: row.payload.domainId,
            recordId: billId,
            digest: row.digest,
            envelope: {
              sourceSiteId: f.request.senderSiteId,
              targetSiteId: f.request.recipientSiteId,
              sourceJws: jws,
              targetJws: row.approvalJws,
            },
          }),
        });
      await this.audit(
        tx,
        authorize ? { ...actor, userId: `billing-exchange:${this.signing.siteId}` } : actor,
        "counterparty",
        billId,
        row.digest,
      );
      return updated;
    });
  }
  async approveDiscount(actor: FederationActor, revisionId: string, raw: CommercialDiscount) {
    const terms = CommercialDiscountSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "billing.approve");
      if (terms.targetSiteId !== this.signing.siteId) throw new FederationError("POLICY_DENIED");
      const signed = await this.sign(tx, CommercialDiscountSchema, terms);
      return this.storeDiscount(tx, actor, revisionId, signed);
    });
  }
  async importDiscount(actor: FederationActor, revisionId: string, jws: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "billing.approve");
      const { terms } = await this.contract(tx, actor, revisionId);
      const signed = await this.verify(
        tx,
        CommercialDiscountSchema,
        jws,
        terms.agreement.targetSiteId,
      );
      return this.storeDiscount(tx, actor, revisionId, signed);
    });
  }
  private async storeDiscount(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    signed: { payload: CommercialDiscount; digest: string; jws: string },
  ) {
    const value = signed.payload;
    await this.contract(tx, actor, revisionId);
    const [prior] = await tx
      .select()
      .from(discounts)
      .where(
        and(
          eq(discounts.localSiteId, this.signing.siteId),
          eq(discounts.discountId, value.discountId),
        ),
      );
    if (prior) {
      if (
        prior.localOrgId !== actor.orgId ||
        prior.agreementRevisionId !== revisionId ||
        prior.digest !== signed.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
      return prior;
    }
    const f = await this.originals(tx, actor, revisionId, value.reportId);
    assertCommercialDiscount(value, f.terms, f.contract.digest, f.report, f.reportDigest);
    if (Date.parse(value.issuedAt) > Date.now() + 60000) throw new FederationError("POLICY_DENIED");
    calculateCommercialBill(f.terms, f.request, f.report, value.amount);
    const [bill] = await tx
      .select({ id: bills.billId })
      .from(bills)
      .where(and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, value.billId)));
    if (bill) throw new FederationError("OPERATION_CONFLICT");
    const [row] = await tx
      .insert(discounts)
      .values({
        localSiteId: this.signing.siteId,
        discountId: value.discountId,
        agreementRevisionId: revisionId,
        localOrgId: actor.orgId,
        payload: value,
        digest: signed.digest,
        providerJws: signed.jws,
        recordedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [same] = await tx
        .select()
        .from(discounts)
        .where(
          and(
            eq(discounts.localSiteId, this.signing.siteId),
            eq(discounts.discountId, value.discountId),
          ),
        );
      if (
        !same ||
        same.localOrgId !== actor.orgId ||
        same.agreementRevisionId !== revisionId ||
        same.digest !== signed.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
      return same;
    }
    if (f.provider && f.request.mode !== "bilateral_direct")
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: revisionId,
        input: CommercialAdapterProposalInputSchema.parse({
          operation: "record-discount",
          domainId: value.domainId,
          recordId: value.discountId,
          digest: signed.digest,
          envelope: { providerJws: signed.jws },
        }),
      });
    await this.audit(tx, actor, "discount", value.discountId, signed.digest);
    return row;
  }
  async listDiscounts(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select({
          discount: discounts,
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(discounts)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, discounts.localSiteId),
            sql`${submissions.input}->>'operation' = 'record-discount'`,
            sql`${submissions.input}->>'recordId' = ${discounts.discountId}::text`,
          ),
        )
        .where(
          and(
            eq(discounts.localSiteId, this.signing.siteId),
            eq(discounts.localOrgId, actor.orgId),
            eq(discounts.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(discounts.createdAt), desc(discounts.discountId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
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
          bill: bills,
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(bills)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, bills.localSiteId),
            sql`${submissions.input}->>'operation' = 'confirm-bill'`,
            sql`${submissions.input}->>'recordId' = ${bills.billId}::text`,
          ),
        )
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            eq(bills.localOrgId, actor.orgId),
            eq(bills.agreementRevisionId, revisionId),
            recordId ? eq(bills.billId, recordId) : undefined,
          ),
        )
        .orderBy(desc(bills.createdAt), desc(bills.billId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
