import { randomBytes } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  auditLog,
  federationCommercialBills as bills,
  federationDisputes as cases,
  federationCommercialAgreements as contracts,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
  federationReceivedUsage as received,
  federationUsageReports as reports,
  federationReservations as reservations,
  federationCommercialSettlements as settlements,
  federationUsageTasks as tasks,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialPaymentSchema,
  CommercialSettlementSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  type CommercialDispute,
  CommercialDisputeDraftSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { lockFederationDisputeTask } from "./dispute-freeze";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

const FinancialOriginal = z.discriminatedUnion("kind", [
  CommercialBillSchema,
  CommercialSettlementSchema,
  CommercialAdjustmentSchema,
  CommercialPaymentSchema,
]);
type Subject = CommercialDispute["subject"];

export class FederationDisputeService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const kid = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, kid, now);
    return verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, kid, now, tx),
      now,
    );
  }
  private async stored<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    row: { payload: unknown; digest: string; approvalJws: string; counterpartyJws: string | null },
    other: string,
  ) {
    const own = await this.verify(tx, schema, row.approvalJws, this.signing.siteId);
    if (
      own.digest !== row.digest ||
      federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      row.counterpartyJws &&
      (await this.verify(tx, schema, row.counterpartyJws, other)).digest !== row.digest
    )
      throw new FederationError("OPERATION_CONFLICT");
    return own.payload;
  }
  private async bill(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    billId: string,
    other: string,
  ) {
    const [row] = await tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.localSiteId, this.signing.siteId),
          eq(bills.localOrgId, actor.orgId),
          eq(bills.agreementRevisionId, revisionId),
          eq(bills.billId, billId),
        ),
      );
    if (!row) throw new FederationError("POLICY_DENIED");
    const value = await this.stored(tx, CommercialBillSchema, row, other);
    if (value.billId !== billId) throw new FederationError("OPERATION_CONFLICT");
    return { value, digest: row.digest };
  }
  private async subject(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    subject: Subject,
    other: string,
    targetSiteId: string,
  ) {
    if (subject.recordType === "usage") {
      const row =
        targetSiteId === this.signing.siteId
          ? (
              await tx
                .select({
                  report: reports.report,
                  digest: reports.digest,
                  jws: reports.reportJws,
                  taskId: reservations.taskId,
                  attempt: reservations.attempt,
                })
                .from(reports)
                .innerJoin(tasks, eq(tasks.reservationId, reports.reservationId))
                .innerJoin(reservations, eq(reservations.id, tasks.reservationId))
                .where(
                  and(
                    eq(reports.id, subject.recordId),
                    eq(tasks.localSiteId, this.signing.siteId),
                    eq(tasks.localOrgId, actor.orgId),
                    eq(tasks.agreementRevisionId, revisionId),
                  ),
                )
            )[0]
          : (
              await tx
                .select({
                  report: received.report,
                  digest: received.digest,
                  jws: received.reportJws,
                  taskId: outbound.taskId,
                  attempt: outbound.attempt,
                })
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
                    eq(received.reportId, subject.recordId),
                    eq(received.localSiteId, this.signing.siteId),
                    eq(outbound.localOrgId, actor.orgId),
                    eq(outbound.agreementRevisionId, revisionId),
                  ),
                )
            )[0];
      if (!row) throw new FederationError("POLICY_DENIED");
      const signed = await this.verify(tx, CommercialUsageSchema, row.jws, targetSiteId),
        v = signed.payload;
      if (
        signed.digest !== row.digest ||
        row.digest !== subject.recordDigest ||
        v.reportId !== subject.recordId ||
        v.taskId !== row.taskId ||
        v.attempt !== row.attempt ||
        federationCanonicalJson(v) !== federationCanonicalJson(row.report)
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        domainId: v.domainId,
        agreementRevisionId: v.agreementRevisionId,
        agreementDigest: v.agreementDigest,
        sourceSiteId: v.sourceSiteId,
        targetSiteId: v.targetSiteId,
        taskId: v.taskId,
        attempt: v.attempt,
        issuedAt: v.reportedAt,
      };
    }
    const row = await (async () => {
      switch (subject.recordType) {
        case "bill":
          return (
            await tx
              .select()
              .from(bills)
              .where(
                and(eq(bills.localSiteId, this.signing.siteId), eq(bills.billId, subject.recordId)),
              )
          )[0];
        case "settlement":
          return (
            await tx
              .select()
              .from(settlements)
              .where(
                and(
                  eq(settlements.localSiteId, this.signing.siteId),
                  eq(settlements.settlementId, subject.recordId),
                ),
              )
          )[0];
        case "adjustment":
          return (
            await tx
              .select()
              .from(adjustments)
              .where(
                and(
                  eq(adjustments.localSiteId, this.signing.siteId),
                  eq(adjustments.adjustmentId, subject.recordId),
                ),
              )
          )[0];
        case "payment":
          return (
            await tx
              .select()
              .from(payments)
              .where(
                and(
                  eq(payments.localSiteId, this.signing.siteId),
                  eq(payments.receiptId, subject.recordId),
                ),
              )
          )[0];
      }
    })();
    if (!row || row.localOrgId !== actor.orgId || row.agreementRevisionId !== revisionId)
      throw new FederationError("POLICY_DENIED");
    if (row.digest !== subject.recordDigest) throw new FederationError("OPERATION_CONFLICT");
    const v = await this.stored(tx, FinancialOriginal, row, other);
    if (v.kind !== `commercial-${subject.recordType}`)
      throw new FederationError("OPERATION_CONFLICT");
    const originalId =
      v.kind === "commercial-bill"
        ? v.billId
        : v.kind === "commercial-settlement"
          ? v.settlementId
          : v.kind === "commercial-adjustment"
            ? v.adjustmentId
            : v.receiptId;
    if (originalId !== subject.recordId) throw new FederationError("OPERATION_CONFLICT");
    const bill =
      v.kind === "commercial-bill"
        ? { value: v, digest: row.digest }
        : await this.bill(tx, actor, revisionId, v.billId, other);
    if (
      v.kind !== "commercial-bill" &&
      (v.billDigest !== bill.digest ||
        v.agreementRevisionId !== revisionId ||
        v.domainId !== bill.value.domainId ||
        v.sourceSiteId !== bill.value.request.senderSiteId ||
        v.targetSiteId !== bill.value.request.recipientSiteId)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const b = bill.value;
    return {
      domainId: b.domainId,
      agreementRevisionId: b.request.agreementRevisionId,
      agreementDigest: b.agreementDigest,
      sourceSiteId: b.request.senderSiteId,
      targetSiteId: b.request.recipientSiteId,
      taskId: b.request.taskId,
      attempt: b.request.attempt,
      issuedAt: v.issuedAt,
    };
  }
  private async originals(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    subject: Subject,
  ) {
    // Originals are immutable. No financial row lock is held while waiting for the task freeze lock.
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      );
    if (!contract?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const { sourceSiteId, targetSiteId } = contract.terms.agreement;
    if (![sourceSiteId, targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    const other = sourceSiteId === this.signing.siteId ? targetSiteId : sourceSiteId;
    const terms = await this.stored(
      tx,
      CommercialAgreementSchema,
      { ...contract, payload: contract.terms },
      other,
    );
    const original = await this.subject(tx, actor, revisionId, subject, other, targetSiteId);
    if (
      original.domainId !== terms.domainId ||
      original.agreementRevisionId !== revisionId ||
      original.agreementDigest !== contract.digest ||
      original.sourceSiteId !== sourceSiteId ||
      original.targetSiteId !== targetSiteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    return {
      ...original,
      issuedAt: new Date(
        Math.max(Date.parse(original.issuedAt), Date.parse(terms.createdAt)),
      ).toISOString(),
    };
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CommercialDisputeDraftSchema>,
  ) {
    const input = CommercialDisputeDraftSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dispute.open");
      const original = await this.originals(tx, actor, revisionId, input.subject);
      if (Date.parse(original.issuedAt) > Date.now())
        throw new FederationError("OPERATION_CONFLICT");
      return CommercialDisputeSchema.parse({
        ...input,
        ...original,
        protocolVersion: 1,
        kind: "commercial-dispute",
        openingSiteId: this.signing.siteId,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
    });
  }
  async open(actor: FederationActor, revisionId: string, raw: CommercialDispute) {
    const value = CommercialDisputeSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dispute.open");
      const original = await this.originals(tx, actor, revisionId, value.subject);
      const { issuedAt, ...scope } = original;
      if (
        value.openingSiteId !== this.signing.siteId ||
        Date.parse(value.issuedAt) > Date.now() ||
        Date.parse(value.issuedAt) < Date.parse(issuedAt) ||
        value.domainId !== scope.domainId ||
        value.agreementRevisionId !== scope.agreementRevisionId ||
        value.agreementDigest !== scope.agreementDigest ||
        value.sourceSiteId !== scope.sourceSiteId ||
        value.targetSiteId !== scope.targetSiteId ||
        value.taskId !== scope.taskId ||
        value.attempt !== scope.attempt
      )
        throw new FederationError("POLICY_DENIED");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`dispute-case:${this.signing.siteId}:${value.caseId}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.localSiteId, this.signing.siteId), eq(cases.caseId, value.caseId)));
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        const signed = await this.verify(
          tx,
          CommercialDisputeSchema,
          prior.openingJws,
          this.signing.siteId,
        );
        if (signed.digest !== prior.digest) throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      await lockFederationDisputeTask(tx, this.signing.siteId, value);
      const jws = await signFederationMessage(CommercialDisputeSchema, value, this.signing);
      const signed = await this.verify(tx, CommercialDisputeSchema, jws, this.signing.siteId);
      const [saved] = await tx
        .insert(cases)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          caseId: value.caseId,
          taskId: value.taskId,
          attempt: value.attempt,
          payload: value,
          digest: signed.digest,
          openingJws: jws,
          openedBy: actor.userId,
        })
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.dispute.open",
        target: value.caseId,
        diff: { after: { digest: saved.digest, subject: value.subject, state: saved.state } },
      });
      return saved;
    });
  }
  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0, caseId?: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dispute.read");
      const rows = await tx
        .select()
        .from(cases)
        .where(
          and(
            eq(cases.localSiteId, this.signing.siteId),
            eq(cases.localOrgId, actor.orgId),
            eq(cases.agreementRevisionId, revisionId),
            caseId ? eq(cases.caseId, caseId) : undefined,
          ),
        )
        .orderBy(desc(cases.createdAt), desc(cases.caseId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
