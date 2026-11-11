import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialBills as bills,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { assertCommercialPayment } from "@kuintessence/shared/federation/billing";
import {
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  type CommercialPayment,
  CommercialPaymentDraftInputSchema,
  CommercialPaymentSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** External payment acknowledgements never change balances, invoices or execution gates. */
export class FederationPaymentService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(receiptId: string) {
    return and(eq(payments.localSiteId, this.signing.siteId), eq(payments.receiptId, receiptId));
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
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  private async pair<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    row: { digest: string; approvalJws: string; counterpartyJws: string | null },
    other: string,
  ) {
    if (!row.counterpartyJws) throw new FederationError("DATA_WAITING");
    for (const [siteId, jws] of [
      [this.signing.siteId, row.approvalJws],
      [other, row.counterpartyJws],
    ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
      if ((await this.verify(tx, schema, jws, siteId)).digest !== row.digest)
        throw new FederationError("OPERATION_CONFLICT");
    }
  }
  private async originals(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    billId: string,
  ) {
    const contract = await this.contract(tx, actor, revisionId);
    const { sourceSiteId, targetSiteId } = contract.terms.agreement;
    if (![sourceSiteId, targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    const other = sourceSiteId === this.signing.siteId ? targetSiteId : sourceSiteId;
    await this.pair(tx, CommercialAgreementSchema, contract, other);
    const [bill] = await tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.localSiteId, this.signing.siteId),
          eq(bills.billId, billId),
          eq(bills.localOrgId, actor.orgId),
          eq(bills.agreementRevisionId, revisionId),
        ),
      )
      .for("share");
    if (!bill?.counterpartyJws) throw new FederationError("DATA_WAITING");
    await this.pair(tx, CommercialBillSchema, bill, other);
    return {
      agreement: contract.terms,
      agreementDigest: contract.digest,
      bill: { terms: bill.payload, digest: bill.digest },
      other,
    };
  }
  private async current(tx: PgTransaction, paymentId: string) {
    // Serializes initial receipts as well as corrections, before a row exists.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`payment:${this.signing.siteId}:${paymentId}`}, 0))`,
    );
    const [head] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.localSiteId, this.signing.siteId),
          eq(payments.paymentId, paymentId),
          eq(payments.current, true),
        ),
      );
    return head;
  }
  private async previous(tx: PgTransaction, value: CommercialPayment, other: string) {
    const head = await this.current(tx, value.paymentId);
    if (head) await this.pair(tx, CommercialPaymentSchema, head, other);
    return head ? { terms: head.payload, digest: head.digest } : undefined;
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CommercialPaymentDraftInputSchema>,
  ) {
    const input = CommercialPaymentDraftInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const original = await this.originals(tx, actor, revisionId, input.billId);
      const head = await this.current(tx, input.paymentId);
      const value = CommercialPaymentSchema.parse({
        ...input,
        protocolVersion: 1,
        kind: "commercial-payment",
        domainId: original.agreement.domainId,
        agreementRevisionId: revisionId,
        agreementDigest: original.agreementDigest,
        billDigest: original.bill.digest,
        sourceSiteId: original.agreement.agreement.sourceSiteId,
        targetSiteId: original.agreement.agreement.targetSiteId,
        unit: original.agreement.agreement.unit,
        previous: head ? { receiptId: head.receiptId, digest: head.digest } : null,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      assertCommercialPayment(value, {
        ...original,
        previous: head ? { terms: head.payload, digest: head.digest } : undefined,
      });
      return value;
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialPayment) {
    const value = CommercialPaymentSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "payment.approve");
      const original = await this.originals(tx, actor, revisionId, value.billId);
      await this.current(tx, value.paymentId);
      const [prior] = await tx.select().from(payments).where(this.key(value.receiptId));
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (
          (await this.verify(tx, CommercialPaymentSchema, prior.approvalJws, this.signing.siteId))
            .digest !== prior.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      assertCommercialPayment(value, {
        ...original,
        previous: await this.previous(tx, value, original.other),
      });
      if (Date.parse(value.issuedAt) > Date.now() + 60000)
        throw new FederationError("POLICY_DENIED");
      const signed = await this.verify(
        tx,
        CommercialPaymentSchema,
        await signFederationMessage(CommercialPaymentSchema, value, this.signing),
        this.signing.siteId,
      );
      const [row] = await tx
        .insert(payments)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          receiptId: value.receiptId,
          paymentId: value.paymentId,
          billId: value.billId,
          agreementRevisionId: revisionId,
          payload: value,
          digest: signed.digest,
          approvalJws: signed.jws,
          approvedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.payment.approve",
        target: row.receiptId,
        diff: { after: { digest: row.digest } },
      });
      return row;
    });
  }
  async attachExchanged(
    revisionId: string,
    receiptId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(this.key(receiptId), eq(payments.agreementRevisionId, revisionId)));
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return this.attachCounterparty(
      { userId: row.approvedBy, orgId: row.localOrgId },
      revisionId,
      receiptId,
      jws,
      authorize,
    );
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    receiptId: string,
    jws: string,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (!authorize) await requireFederationCapability(tx, actor, "payment.approve");
      const [row] = await tx
        .select()
        .from(payments)
        .where(
          and(
            this.key(receiptId),
            eq(payments.localOrgId, actor.orgId),
            eq(payments.agreementRevisionId, revisionId),
          ),
        );
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      const original = await this.originals(tx, actor, revisionId, row.billId);
      await this.current(tx, row.paymentId);
      // Reread after the payment lock; another approval may have completed while we waited.
      const [locked] = await tx.select().from(payments).where(this.key(receiptId)).for("update");
      if (!locked) throw new FederationError("OPERATION_CONFLICT");
      await this.pair(
        tx,
        CommercialPaymentSchema,
        { ...locked, counterpartyJws: jws },
        original.other,
      );
      await authorize?.(tx);
      if (locked.counterpartyJws) {
        if (locked.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return locked;
      }
      assertCommercialPayment(locked.payload, {
        ...original,
        previous: await this.previous(tx, locked.payload, original.other),
      });
      await tx
        .update(payments)
        .set({ current: false })
        .where(
          and(
            eq(payments.localSiteId, this.signing.siteId),
            eq(payments.paymentId, row.paymentId),
            eq(payments.current, true),
          ),
        );
      const [confirmed] = await tx
        .update(payments)
        .set({ counterpartyJws: jws, current: true, confirmedAt: sql`clock_timestamp()` })
        .where(this.key(receiptId))
        .returning();
      if (!confirmed) throw new FederationError("OPERATION_CONFLICT");
      const provider = row.payload.targetSiteId === this.signing.siteId;
      // Only the provider publishes; external payment facts never wait for ledger availability.
      if (provider && original.agreement.agreement.mode !== "bilateral_direct")
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation: "record-payment",
            domainId: row.payload.domainId,
            recordId: receiptId,
            digest: row.digest,
            envelope: {
              sourceSiteId: row.payload.sourceSiteId,
              targetSiteId: row.payload.targetSiteId,
              sourceJws: jws,
              targetJws: row.approvalJws,
            },
          }),
        });
      await tx.insert(auditLog).values({
        actor: authorize ? `payment-exchange:${this.signing.siteId}` : actor.userId,
        orgId: actor.orgId,
        action: "federation.payment.counterparty",
        target: receiptId,
        diff: { after: { digest: row.digest } },
      });
      return confirmed;
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit: number,
    offset: number,
    billId?: string,
    paymentId?: string,
    recordId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select({
          payment: payments,
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(payments)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, payments.localSiteId),
            sql`${submissions.lastError} IS DISTINCT FROM 'HISTORY_ARCHIVE_ONLY'`,
            sql`${submissions.input}->>'operation' = 'record-payment'`,
            sql`${submissions.input}->>'recordId' = ${payments.receiptId}::text`,
          ),
        )
        .where(
          and(
            eq(payments.localSiteId, this.signing.siteId),
            eq(payments.localOrgId, actor.orgId),
            eq(payments.agreementRevisionId, revisionId),
            billId ? eq(payments.billId, billId) : undefined,
            paymentId ? eq(payments.paymentId, paymentId) : undefined,
            recordId ? eq(payments.receiptId, recordId) : undefined,
          ),
        )
        .orderBy(desc(payments.createdAt), desc(payments.receiptId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
