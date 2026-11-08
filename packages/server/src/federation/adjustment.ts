import { randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
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
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { assertCommercialAdjustment } from "@kuintessence/shared/federation/billing";
import {
  CommercialAdapterProposalInputSchema,
  type CommercialAdjustment,
  type CommercialAdjustmentDraftInput,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialSettlementSchema,
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

type Adjustment = typeof adjustments.$inferSelect;
const key = (siteId: string, adjustmentId: string) =>
  and(eq(adjustments.localSiteId, siteId), eq(adjustments.adjustmentId, adjustmentId));

async function originals(
  tx: PgTransaction,
  siteId: string,
  orgId: string,
  revisionId: string,
  settlementId: string,
) {
  const [contract] = await tx
    .select()
    .from(contracts)
    .where(
      and(
        eq(contracts.localSiteId, siteId),
        eq(contracts.localOrgId, orgId),
        eq(contracts.revisionId, revisionId),
      ),
    )
    .for("share");
  if (!contract?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
  const [snapshot] = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.localSiteId, siteId),
        eq(settlements.localOrgId, orgId),
        eq(settlements.agreementRevisionId, revisionId),
        eq(settlements.settlementId, settlementId),
      ),
    );
  if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
  const [bill] = await tx
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.localSiteId, siteId),
        eq(bills.billId, snapshot.billId),
        eq(bills.localOrgId, orgId),
        eq(bills.agreementRevisionId, revisionId),
      ),
    )
    .for("share");
  const [settlement] = await tx
    .select()
    .from(settlements)
    .where(and(eq(settlements.localSiteId, siteId), eq(settlements.settlementId, settlementId)))
    .for("update");
  if (!bill?.counterpartyJws || !settlement?.counterpartyJws || !settlement.appliedAt)
    throw new FederationError("DATA_WAITING");
  if (
    bill.payload.agreementDigest !== contract.digest ||
    settlement.payload.billDigest !== bill.digest ||
    settlement.payload.billId !== bill.billId
  )
    throw new FederationError("OPERATION_CONFLICT");
  return { contract, bill, settlement };
}
type Originals = Awaited<ReturnType<typeof originals>>;
async function head(tx: PgTransaction, siteId: string, settlementId: string) {
  return (
    await tx
      .select()
      .from(adjustments)
      .where(and(eq(adjustments.localSiteId, siteId), eq(adjustments.settlementId, settlementId)))
      .orderBy(desc(adjustments.number))
      .limit(1)
  )[0];
}
function check(value: CommercialAdjustment, original: Originals, previous?: Adjustment) {
  assertCommercialAdjustment(value, {
    agreement: original.contract.terms,
    bill: { terms: original.bill.payload, digest: original.bill.digest },
    settlement: { terms: original.settlement.payload, digest: original.settlement.digest },
    previous: previous ? { terms: previous.payload, digest: previous.digest } : undefined,
  });
  if (previous && (!previous.counterpartyJws || !previous.appliedAt))
    throw new FederationError("DATA_WAITING");
}

/** Locks follow settlement accounting and admission: installed agreement -> reservation -> budget. */
async function accountingTarget(
  tx: PgTransaction,
  row: Pick<Adjustment, "localSiteId" | "localOrgId" | "agreementRevisionId" | "payload">,
  original: Originals,
) {
  const value = row.payload,
    request = original.bill.payload.request;
  if (row.localSiteId === value.targetSiteId) {
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
      reservation.settledAmount !== value.previousChargedAmount ||
      reservation.amount !== original.settlement.payload.reservedAmount ||
      reservation.taskId !== request.taskId ||
      reservation.attempt !== request.attempt ||
      (original.settlement.payload.reservationId !== null &&
        original.settlement.payload.reservationId !== reservation.id)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return { provider: true as const, reservation };
  }
  if (row.localSiteId !== value.sourceSiteId) throw new FederationError("POLICY_DENIED");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${row.localSiteId}:${request.budgetDomainId}:${request.epoch}`}, 0))`,
  );
  const [operation] = await tx
    .select()
    .from(outbound)
    .where(
      and(eq(outbound.localSiteId, row.localSiteId), eq(outbound.operationId, request.operationId)),
    )
    .for("update");
  if (
    !operation ||
    operation.localOrgId !== row.localOrgId ||
    operation.state !== "accepted" ||
    operation.settledAmount !== value.previousChargedAmount ||
    federationCanonicalJson(operation.request) !== federationCanonicalJson(request) ||
    (original.settlement.payload.reservationId !== null &&
      operation.receipt?.reservationId !== original.settlement.payload.reservationId)
  )
    throw new FederationError("OPERATION_CONFLICT");
  return { provider: false as const, operation };
}
async function budget(tx: PgTransaction, original: Originals) {
  const request = original.bill.payload.request;
  const [row] = await tx
    .select()
    .from(budgets)
    .where(and(eq(budgets.domainId, request.budgetDomainId), eq(budgets.epoch, request.epoch)))
    .for("update");
  if (!row || row.unit !== request.unit) throw new FederationError("OPERATION_CONFLICT");
  return row;
}

/** Called only for verified dual signatures; coordinated callers must persist their VALID result first. */
export async function applyFederationAdjustment(tx: PgTransaction, snapshot: Adjustment) {
  const original = await originals(
    tx,
    snapshot.localSiteId,
    snapshot.localOrgId,
    snapshot.agreementRevisionId,
    snapshot.settlementId,
  );
  const [row] = await tx
    .select()
    .from(adjustments)
    .where(key(snapshot.localSiteId, snapshot.adjustmentId))
    .for("update");
  if (!row || row.digest !== snapshot.digest || !row.counterpartyJws)
    throw new FederationError("OPERATION_CONFLICT");
  if (row.appliedAt) return;
  const latest = await head(tx, row.localSiteId, row.settlementId);
  if (latest?.adjustmentId !== row.adjustmentId) throw new FederationError("OPERATION_CONFLICT");
  const previous = row.payload.previous
    ? (
        await tx
          .select()
          .from(adjustments)
          .where(key(row.localSiteId, row.payload.previous.adjustmentId))
      )[0]
    : undefined;
  check(row.payload, original, previous);
  const delta = BigInt(row.payload.chargedAmount) - BigInt(row.payload.previousChargedAmount);
  const coordinated = original.bill.payload.request.mode === "ledger_coordinated";
  const held = BigInt(row.heldAmount);
  if (held !== (coordinated || delta < 0n ? 0n : delta))
    throw new FederationError("OPERATION_CONFLICT");
  const target = await accountingTarget(tx, row, original);
  if (target.provider) {
    if (!coordinated) {
      const current = await budget(tx, original);
      if (
        BigInt(current.reserved) < held ||
        BigInt(current.spent) < BigInt(row.payload.previousChargedAmount)
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(budgets)
        .set({
          available: (BigInt(current.available) + held - delta).toString(),
          reserved: (BigInt(current.reserved) - held).toString(),
          spent: (BigInt(current.spent) + delta).toString(),
        })
        .where(and(eq(budgets.domainId, current.domainId), eq(budgets.epoch, current.epoch)));
    }
    await tx
      .update(reservations)
      .set({ settledAmount: row.payload.chargedAmount })
      .where(eq(reservations.id, target.reservation.id));
  } else {
    if (target.operation.adjustmentHeldAmount !== row.heldAmount)
      throw new FederationError("OPERATION_CONFLICT");
    await tx
      .update(outbound)
      .set({ settledAmount: row.payload.chargedAmount, adjustmentHeldAmount: "0" })
      .where(
        and(
          eq(outbound.localSiteId, row.localSiteId),
          eq(outbound.operationId, target.operation.operationId),
        ),
      );
  }
  await tx
    .update(adjustments)
    .set({ appliedAt: sql`clock_timestamp()` })
    .where(key(row.localSiteId, row.adjustmentId));
  await tx.insert(auditLog).values({
    actor: `adjustment:${row.localSiteId}`,
    orgId: row.localOrgId,
    action: "federation.adjustment.apply",
    target: row.adjustmentId,
    diff: { after: { digest: row.digest } },
  });
}

export class FederationAdjustmentService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async verify(
    tx: PgTransaction,
    schema: z.ZodType<{ kind: string }>,
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
  private async verifyOriginals(tx: PgTransaction, original: Originals, previous?: Adjustment) {
    const other =
      original.contract.terms.agreement.sourceSiteId === this.signing.siteId
        ? original.contract.terms.agreement.targetSiteId
        : original.contract.terms.agreement.sourceSiteId;
    for (const [schema, record] of [
      [CommercialAgreementSchema, original.contract],
      [CommercialBillSchema, original.bill],
      [CommercialSettlementSchema, original.settlement],
    ] as const) {
      for (const [siteId, jws] of [
        [this.signing.siteId, record.approvalJws],
        [other, record.counterpartyJws],
      ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
        if (
          !siteId ||
          !jws ||
          (await this.verify(tx, schema, jws, siteId)).digest !== record.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
    }
    if (previous) {
      if (!previous.appliedAt || !previous.counterpartyJws)
        throw new FederationError("DATA_WAITING");
      for (const [siteId, jws] of [
        [this.signing.siteId, previous.approvalJws],
        [other, previous.counterpartyJws],
      ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
        if (
          !siteId ||
          !jws ||
          (await this.verify(tx, CommercialAdjustmentSchema, jws, siteId)).digest !==
            previous.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
    }
  }
  async draft(actor: FederationActor, revisionId: string, input: CommercialAdjustmentDraftInput) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const original = await originals(
          tx,
          this.signing.siteId,
          actor.orgId,
          revisionId,
          input.settlementId,
        ),
        previous = await head(tx, this.signing.siteId, input.settlementId);
      await this.verifyOriginals(tx, original, previous);
      const settlement = original.settlement;
      const value = CommercialAdjustmentSchema.parse({
        protocolVersion: 1,
        kind: "commercial-adjustment",
        ...input,
        domainId: settlement.payload.domainId,
        agreementRevisionId: revisionId,
        billId: settlement.billId,
        billDigest: settlement.payload.billDigest,
        settlementDigest: settlement.digest,
        sourceSiteId: settlement.payload.sourceSiteId,
        targetSiteId: settlement.payload.targetSiteId,
        unit: settlement.payload.unit,
        previous: previous
          ? { adjustmentId: previous.adjustmentId, digest: previous.digest }
          : null,
        previousChargedAmount: previous?.payload.chargedAmount ?? settlement.payload.chargedAmount,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      check(value, original, previous);
      return value;
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialAdjustment) {
    const value = CommercialAdjustmentSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "adjustment.approve");
      const original = await originals(
        tx,
        this.signing.siteId,
        actor.orgId,
        revisionId,
        value.settlementId,
      );
      const [prior] = await tx
        .select()
        .from(adjustments)
        .where(key(this.signing.siteId, value.adjustmentId));
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        await this.verifyOriginals(tx, original);
        if (
          (
            await this.verify(
              tx,
              CommercialAdjustmentSchema,
              prior.approvalJws,
              this.signing.siteId,
            )
          ).digest !== prior.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      const previous = await head(tx, this.signing.siteId, value.settlementId);
      await this.verifyOriginals(tx, original, previous);
      check(value, original, previous);
      if (Date.parse(value.issuedAt) > Date.now() + 60000)
        throw new FederationError("POLICY_DENIED");
      const delta = BigInt(value.chargedAmount) - BigInt(value.previousChargedAmount);
      const hold =
        original.bill.payload.request.mode === "ledger_coordinated" || delta < 0n ? 0n : delta;
      const identity = {
        localSiteId: this.signing.siteId,
        localOrgId: actor.orgId,
        agreementRevisionId: revisionId,
        payload: value,
      };
      const target = await accountingTarget(tx, identity, original);
      if (target.provider && hold > 0n) {
        const current = await budget(tx, original);
        if (BigInt(current.available) < hold) throw new FederationError("BUDGET_EXHAUSTED");
        await tx
          .update(budgets)
          .set({
            available: (BigInt(current.available) - hold).toString(),
            reserved: (BigInt(current.reserved) + hold).toString(),
          })
          .where(and(eq(budgets.domainId, current.domainId), eq(budgets.epoch, current.epoch)));
      } else if (!target.provider) {
        if (target.operation.adjustmentHeldAmount !== "0")
          throw new FederationError("OPERATION_CONFLICT");
        if (hold > 0n) {
          const request = original.bill.payload.request;
          const [used] = await tx
            .select({
              amount: sql<string>`coalesce(sum(coalesce(${outbound.settledAmount}, ${outbound.amount}) + ${outbound.adjustmentHeldAmount}), 0)::text`,
              conflict: sql<boolean>`coalesce(bool_or(${outbound.agreementRevisionId} <> ${revisionId}), false)`,
            })
            .from(outbound)
            .where(
              and(
                eq(outbound.localSiteId, this.signing.siteId),
                eq(outbound.budgetDomainId, request.budgetDomainId),
                eq(outbound.epoch, request.epoch),
              ),
            );
          if (!used || used.conflict) throw new FederationError("OPERATION_CONFLICT");
          if (BigInt(used.amount) + hold > BigInt(original.contract.terms.agreement.budgetLimit))
            throw new FederationError("BUDGET_EXHAUSTED");
          await tx
            .update(outbound)
            .set({ adjustmentHeldAmount: hold.toString() })
            .where(
              and(
                eq(outbound.localSiteId, this.signing.siteId),
                eq(outbound.operationId, request.operationId),
              ),
            );
        }
      }
      const signed = await this.verify(
        tx,
        CommercialAdjustmentSchema,
        await signFederationMessage(CommercialAdjustmentSchema, value, this.signing),
        this.signing.siteId,
      );
      const [row] = await tx
        .insert(adjustments)
        .values({
          ...identity,
          adjustmentId: value.adjustmentId,
          settlementId: value.settlementId,
          number: (previous?.number ?? 0) + 1,
          digest: signed.digest,
          approvalJws: signed.jws,
          heldAmount: hold.toString(),
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.adjustment.approve",
        target: row.adjustmentId,
        diff: { after: { digest: row.digest } },
      });
      return row;
    });
  }
  async attachExchanged(
    revisionId: string,
    adjustmentId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    const [row] = await this.db
      .select()
      .from(adjustments)
      .where(
        and(
          key(this.signing.siteId, adjustmentId),
          eq(adjustments.agreementRevisionId, revisionId),
        ),
      );
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    return this.attachCounterparty(
      { userId: row.approvedBy, orgId: row.localOrgId },
      revisionId,
      adjustmentId,
      jws,
      authorize,
    );
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    adjustmentId: string,
    jws: string,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (!authorize) await requireFederationCapability(tx, actor, "adjustment.approve");
      const [snapshot] = await tx
        .select()
        .from(adjustments)
        .where(
          and(
            key(this.signing.siteId, adjustmentId),
            eq(adjustments.localOrgId, actor.orgId),
            eq(adjustments.agreementRevisionId, revisionId),
          ),
        );
      if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
      const original = await originals(
        tx,
        this.signing.siteId,
        actor.orgId,
        revisionId,
        snapshot.settlementId,
      );
      const [row] = await tx
        .select()
        .from(adjustments)
        .where(key(this.signing.siteId, adjustmentId))
        .for("update");
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const provider = row.payload.targetSiteId === this.signing.siteId;
      const other = provider ? row.payload.sourceSiteId : row.payload.targetSiteId;
      for (const [siteId, signature] of [
        [this.signing.siteId, row.approvalJws],
        [other, jws],
      ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
        if (
          !siteId ||
          !signature ||
          (await this.verify(tx, CommercialAdjustmentSchema, signature, siteId)).digest !==
            row.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
      await authorize?.(tx);
      if (row.counterpartyJws) {
        await this.verifyOriginals(tx, original);
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return row;
      }
      const previous = row.payload.previous
        ? (
            await tx
              .select()
              .from(adjustments)
              .where(key(this.signing.siteId, row.payload.previous.adjustmentId))
          )[0]
        : undefined;
      await this.verifyOriginals(tx, original, previous);
      check(row.payload, original, previous);
      const latest = await head(tx, this.signing.siteId, row.settlementId);
      if (latest?.adjustmentId !== row.adjustmentId)
        throw new FederationError("OPERATION_CONFLICT");
      const [updated] = await tx
        .update(adjustments)
        .set({ counterpartyJws: jws })
        .where(key(this.signing.siteId, adjustmentId))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      const mode = original.bill.payload.request.mode;
      if (mode !== "ledger_coordinated") await applyFederationAdjustment(tx, updated);
      if (mode === "ledger_coordinated" || (provider && mode === "bilateral_attested"))
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: CommercialAdapterProposalInputSchema.parse({
            operation: "adjust-settlement",
            domainId: row.payload.domainId,
            recordId: adjustmentId,
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
        actor: authorize ? `adjustment-exchange:${this.signing.siteId}` : actor.userId,
        orgId: actor.orgId,
        action: "federation.adjustment.counterparty",
        target: adjustmentId,
        diff: { after: { digest: row.digest } },
      });
      return (await tx.select().from(adjustments).where(key(this.signing.siteId, adjustmentId)))[0];
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit: number,
    offset: number,
    recordId?: string,
    settlementId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
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
      if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
      let summary = null;
      if (settlementId) {
        const [original] = await tx
          .select()
          .from(settlements)
          .where(
            and(
              eq(settlements.localSiteId, this.signing.siteId),
              eq(settlements.localOrgId, actor.orgId),
              eq(settlements.agreementRevisionId, revisionId),
              eq(settlements.settlementId, settlementId),
            ),
          )
          .for("share");
        if (!original) throw new FederationError("ASSET_UNAVAILABLE");
        const latest = await head(tx, this.signing.siteId, settlementId);
        summary = {
          settlementId,
          originalChargedAmount: original.payload.chargedAmount,
          currentChargedAmount: !original.appliedAt
            ? null
            : latest
              ? latest.appliedAt
                ? latest.payload.chargedAmount
                : latest.payload.previousChargedAmount
              : original.payload.chargedAmount,
          pendingAdjustmentId: latest && !latest.appliedAt ? latest.adjustmentId : null,
        };
      }
      const rows = await tx
        .select({
          adjustment: adjustments,
          ledger: {
            id: submissions.id,
            state: submissions.state,
            lastError: submissions.lastError,
          },
        })
        .from(adjustments)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, adjustments.localSiteId),
            sql`${submissions.input}->>'operation' = 'adjust-settlement'`,
            sql`${submissions.input}->>'recordId' = ${adjustments.adjustmentId}::text`,
          ),
        )
        .where(
          and(
            eq(adjustments.localSiteId, this.signing.siteId),
            eq(adjustments.localOrgId, actor.orgId),
            eq(adjustments.agreementRevisionId, revisionId),
            recordId ? eq(adjustments.adjustmentId, recordId) : undefined,
            settlementId ? eq(adjustments.settlementId, settlementId) : undefined,
          ),
        )
        .orderBy(
          ...(settlementId ? [desc(adjustments.number)] : []),
          desc(adjustments.createdAt),
          desc(adjustments.adjustmentId),
        )
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit, summary };
    });
  }
}
