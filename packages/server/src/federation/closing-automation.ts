import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialBills as bills,
  federationWorkflowBindings as bindings,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationClosingPolicies as policies,
  federationCommercialSettlements as settlements,
  federationSites as sites,
  federationClosingTasks as tasks,
  federationUsageTasks as usage,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  CommercialBillSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationBillingService } from "./billing";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationSettlementService } from "./settlement";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

const business = z.union([CommercialBillSchema, CommercialSettlementSchema]);
type Task = typeof tasks.$inferSelect;
type Kind = Task["kind"];
function identity(payload: z.infer<typeof business>) {
  return payload.kind === "commercial-bill"
    ? {
        kind: "bill" as const,
        recordId: payload.billId,
        revisionId: payload.request.agreementRevisionId,
        source: payload.request.senderSiteId,
        target: payload.request.recipientSiteId,
      }
    : {
        kind: "settlement" as const,
        recordId: payload.settlementId,
        revisionId: payload.agreementRevisionId,
        source: payload.sourceSiteId,
        target: payload.targetSiteId,
      };
}
class ClosingLeaseLost extends Error {}

/** Provider proposes an existing business signature; the recipient independently authorizes the same original. */
export class FederationClosingAutomation {
  private readonly trust: FederationTrustRegistry;
  private readonly billing: FederationBillingService;
  private readonly settlement: FederationSettlementService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.billing = new FederationBillingService(db, signing);
    this.settlement = new FederationSettlementService(db, signing);
  }
  private key(row: Pick<Task, "kind" | "referenceId">) {
    return and(
      eq(tasks.localSiteId, this.signing.siteId),
      eq(tasks.kind, row.kind),
      eq(tasks.referenceId, row.referenceId),
    );
  }
  private async lock(tx: PgTransaction, claim: Task) {
    if (!claim.leaseToken) throw new ClosingLeaseLost();
    const [row] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          this.key(claim),
          eq(tasks.leaseToken, claim.leaseToken),
          sql`${tasks.leaseUntil}>clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new ClosingLeaseLost();
    return row;
  }
  private async record(
    tx: PgTransaction,
    kind: Kind,
    recordId: string,
    orgId: string,
    revisionId: string,
  ) {
    if (kind === "bill") {
      const [row] = await tx
        .select()
        .from(bills)
        .where(
          and(
            eq(bills.localSiteId, this.signing.siteId),
            eq(bills.localOrgId, orgId),
            eq(bills.agreementRevisionId, revisionId),
            eq(bills.billId, recordId),
          ),
        );
      return row;
    }
    const [row] = await tx
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.localSiteId, this.signing.siteId),
          eq(settlements.localOrgId, orgId),
          eq(settlements.agreementRevisionId, revisionId),
          eq(settlements.settlementId, recordId),
        ),
      );
    return row;
  }
  private async contract(tx: PgTransaction, revisionId: string, orgId?: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, revisionId),
          orgId ? eq(contracts.localOrgId, orgId) : undefined,
        ),
      )
      .for("share");
    if (!row?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  async receive(jws: string, fingerprint: string) {
    const sender = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      new Date(),
    );
    const signed = await verifyFederationMessage(business, jws, sender, new Date());
    const id = identity(signed.payload);
    if (id.target !== sender.siteId || id.source !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    const context = await this.db.transaction(async (tx) => {
      const contract = await this.contract(tx, id.revisionId);
      if (
        contract.terms.domainId !== signed.payload.domainId ||
        contract.terms.agreement.sourceSiteId !== id.source ||
        contract.terms.agreement.targetSiteId !== id.target
      )
        throw new FederationError("OPERATION_CONFLICT");
      const prior = await this.record(tx, id.kind, id.recordId, contract.localOrgId, id.revisionId);
      const now = new Date();
      const [policy] = await tx
        .select({ id: policies.id })
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.signing.siteId),
            eq(policies.localOrgId, contract.localOrgId),
            eq(policies.agreementRevisionId, id.revisionId),
            eq(policies.kind, id.kind),
            isNull(policies.revokedAt),
            lte(policies.validFrom, now),
            gt(policies.validUntil, now),
          ),
        );
      return { contract, prior, policy };
    });
    const authorize = async (tx: PgTransaction) => {
      await this.trust.assertPeer(tx, fingerprint, sender.siteId, sender.keyId, new Date());
      const current = await this.trust.resolveKey(sender.siteId, sender.keyId, new Date(), tx);
      const original = await verifyFederationMessage(business, jws, current, new Date());
      if (original.digest !== signed.digest) throw new FederationError("OPERATION_CONFLICT");
      const local = await this.record(
        tx,
        id.kind,
        id.recordId,
        context.contract.localOrgId,
        id.revisionId,
      );
      if (local) {
        const ownId = federationMessageKeyId(local.approvalJws);
        await this.trust.assertKey(tx, this.signing.siteId, ownId, new Date());
        const own = await verifyFederationMessage(
          business,
          local.approvalJws,
          await this.trust.resolveKey(this.signing.siteId, ownId, new Date(), tx),
          new Date(),
        );
        if (own.digest !== signed.digest || local.digest !== signed.digest)
          throw new FederationError("OPERATION_CONFLICT");
      }
      const contract = await this.contract(tx, id.revisionId, context.contract.localOrgId);
      if (contract.digest !== context.contract.digest)
        throw new FederationError("OPERATION_CONFLICT");
    };
    let saved = context.prior;
    if (saved) {
      if (
        saved.digest !== signed.digest ||
        federationCanonicalJson(saved.payload) !== federationCanonicalJson(signed.payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
    } else {
      if (!context.policy) throw new FederationError("POLICY_DENIED");
      saved =
        signed.payload.kind === "commercial-bill"
          ? await this.billing.automate(context.policy.id, signed.payload, authorize)
          : await this.settlement.automate(context.policy.id, signed.payload, authorize);
    }
    // If the response is lost after this transaction, the same offer returns the same local signature.
    if (id.kind === "bill")
      await this.billing.attachExchanged(id.revisionId, id.recordId, jws, authorize);
    else await this.settlement.attachExchanged(id.revisionId, id.recordId, jws, authorize);
    return saved.approvalJws;
  }
  async discover() {
    if (!this.send) return;
    for (const kind of ["bill", "settlement"] as const) {
      const now = new Date();
      const candidates =
        kind === "bill"
          ? await this.db
              .select({
                localOrgId: usage.localOrgId,
                agreementRevisionId: usage.agreementRevisionId,
                referenceId: usage.reservationId,
                policyId: policies.id,
              })
              .from(usage)
              .innerJoin(
                policies,
                and(
                  eq(policies.localSiteId, usage.localSiteId),
                  eq(policies.localOrgId, usage.localOrgId),
                  eq(policies.agreementRevisionId, usage.agreementRevisionId),
                  eq(policies.kind, kind),
                ),
              )
              .innerJoin(bindings, eq(bindings.reservationId, usage.reservationId))
              .leftJoin(
                tasks,
                and(
                  eq(tasks.localSiteId, usage.localSiteId),
                  eq(tasks.kind, kind),
                  eq(tasks.referenceId, usage.reservationId),
                ),
              )
              .where(
                and(
                  eq(usage.localSiteId, this.signing.siteId),
                  eq(usage.state, "reported"),
                  sql`${bindings.snapshot}->'request'->>'recipientSiteId' = ${this.signing.siteId}`,
                  isNull(policies.revokedAt),
                  lte(policies.validFrom, now),
                  gt(policies.validUntil, now),
                  isNull(tasks.referenceId),
                ),
              )
              .orderBy(asc(usage.reservationId))
              .limit(8)
          : await this.db
              .select({
                localOrgId: bills.localOrgId,
                agreementRevisionId: bills.agreementRevisionId,
                referenceId: bills.billId,
                policyId: policies.id,
              })
              .from(bills)
              .innerJoin(
                policies,
                and(
                  eq(policies.localSiteId, bills.localSiteId),
                  eq(policies.localOrgId, bills.localOrgId),
                  eq(policies.agreementRevisionId, bills.agreementRevisionId),
                  eq(policies.kind, kind),
                ),
              )
              .leftJoin(
                tasks,
                and(
                  eq(tasks.localSiteId, bills.localSiteId),
                  eq(tasks.kind, kind),
                  eq(tasks.referenceId, bills.billId),
                ),
              )
              .where(
                and(
                  eq(bills.localSiteId, this.signing.siteId),
                  isNotNull(bills.counterpartyJws),
                  sql`${bills.payload}->'request'->>'recipientSiteId' = ${this.signing.siteId}`,
                  isNull(policies.revokedAt),
                  lte(policies.validFrom, now),
                  gt(policies.validUntil, now),
                  isNull(tasks.referenceId),
                ),
              )
              .orderBy(asc(bills.billId))
              .limit(8);
      if (candidates.length)
        await this.db
          .insert(tasks)
          .values(candidates.map((v) => ({ ...v, kind, localSiteId: this.signing.siteId })))
          .onConflictDoNothing();
    }
  }
  private async source(tx: PgTransaction, claim: Task, endpoint?: string) {
    const task = await this.lock(tx, claim);
    if (!task.recordId) throw new FederationError("DATA_WAITING");
    const row = await this.record(
      tx,
      task.kind,
      task.recordId,
      task.localOrgId,
      task.agreementRevisionId,
    );
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    const id = identity(row.payload),
      keyId = federationMessageKeyId(row.approvalJws);
    if (id.target !== this.signing.siteId || id.kind !== task.kind || id.recordId !== task.recordId)
      throw new FederationError("OPERATION_CONFLICT");
    await this.contract(tx, task.agreementRevisionId, task.localOrgId);
    const [peer] = await tx.select().from(sites).where(eq(sites.id, id.source)).for("share");
    if (peer?.state !== "active" || (endpoint && peer.endpoint !== endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
    const signed = await verifyFederationMessage(
      business,
      row.approvalJws,
      await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx),
      new Date(),
    );
    if (
      signed.digest !== row.digest ||
      federationCanonicalJson(signed.payload) !== federationCanonicalJson(row.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return { row, endpoint: peer.endpoint, other: id.source };
  }
  private async advance(claim: Task) {
    if (!this.send) return;
    if (!claim.recordId) {
      const finish = async (
        tx: PgTransaction,
        row: { localOrgId: string; agreementRevisionId: string; payload: z.infer<typeof business> },
      ) => {
        const task = await this.lock(tx, claim),
          id = identity(row.payload);
        if (
          task.localOrgId !== row.localOrgId ||
          task.agreementRevisionId !== row.agreementRevisionId ||
          id.kind !== task.kind
        )
          throw new FederationError("OPERATION_CONFLICT");
        await tx.update(tasks).set({ recordId: id.recordId }).where(this.key(claim));
      };
      if (claim.kind === "bill")
        await this.billing.automateDraft(claim.policyId, claim.referenceId, finish);
      else await this.settlement.automateDraft(claim.policyId, claim.referenceId, finish);
    }
    const before = await this.db.transaction((tx) => this.source(tx, claim));
    const response =
      before.row.counterpartyJws ??
      (await this.send(
        before.endpoint,
        before.row.approvalJws,
        "/federation/v1/commercial-closing",
      ));
    const keyId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(before.other, keyId, new Date());
    const verified = await verifyFederationMessage(business, response, peer, new Date());
    if (
      verified.digest !== before.row.digest ||
      federationCanonicalJson(verified.payload) !== federationCanonicalJson(before.row.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const authorize = async (tx: PgTransaction) => {
      const current = await this.source(tx, claim, before.endpoint);
      if (
        current.row.digest !== before.row.digest ||
        current.row.approvalJws !== before.row.approvalJws
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, before.other, keyId, new Date());
      await verifyFederationMessage(
        business,
        response,
        await this.trust.resolveKey(before.other, keyId, new Date(), tx),
        new Date(),
      );
      await tx
        .update(tasks)
        .set({
          state: "complete",
          lastError: null,
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(claim));
      await tx.insert(auditLog).values({
        actor: `closing:${this.signing.siteId}`,
        orgId: claim.localOrgId,
        action: "federation.closing.complete",
        target: identity(before.row.payload).recordId,
      });
    };
    const id = identity(before.row.payload);
    if (claim.kind === "bill")
      await this.billing.attachExchanged(
        claim.agreementRevisionId,
        id.recordId,
        response,
        authorize,
      );
    else
      await this.settlement.attachExchanged(
        claim.agreementRevisionId,
        id.recordId,
        response,
        authorize,
      );
  }
  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.localSiteId, this.signing.siteId),
            eq(tasks.state, "pending"),
            sql`${tasks.nextAttemptAt}<=clock_timestamp()`,
            sql`(${tasks.leaseUntil} IS NULL OR ${tasks.leaseUntil}<=clock_timestamp())`,
          ),
        )
        .orderBy(asc(tasks.nextAttemptAt), asc(tasks.kind), asc(tasks.referenceId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(tasks)
        .set({ leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp()+interval '60 seconds'` })
        .where(this.key(row))
        .returning();
      return saved;
    });
    if (!claim?.leaseToken) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof ClosingLeaseLost) return true;
      const pg =
        error instanceof Error &&
        error.cause &&
        typeof error.cause === "object" &&
        "code" in error.cause
          ? String(error.cause.code)
          : null;
      const temporaryPg = !!pg && ["55P03", "40001", "40P01"].includes(pg);
      const retryable =
        temporaryPg ||
        (error instanceof FederationDeliveryError && error.code === "DELIVERY_UNAVAILABLE") ||
        (error instanceof FederationError && error.code === "DATA_WAITING");
      const code = temporaryPg
        ? "DATABASE_BUSY"
        : error instanceof FederationError || error instanceof FederationDeliveryError
          ? error.code
          : "INTERNAL_ERROR";
      await this.db
        .update(tasks)
        .set({
          state: retryable ? "pending" : "needs_review",
          lastError: code,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp()+interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim),
            eq(tasks.leaseToken, claim.leaseToken),
            sql`${tasks.leaseUntil}>clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async list(actor: FederationActor, revisionId: string, limit = 20, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, revisionId, actor.orgId);
      const records = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.localSiteId, this.signing.siteId),
            eq(tasks.localOrgId, actor.orgId),
            eq(tasks.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(asc(tasks.kind), asc(tasks.referenceId))
        .limit(limit)
        .offset(offset);
      return { enabled: !!this.send, records };
    });
  }
  async retry(actor: FederationActor, revisionId: string, kind: Kind, referenceId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(
        tx,
        actor,
        kind === "bill" ? "billing.approve" : "settlement.approve",
      );
      await this.contract(tx, revisionId, actor.orgId);
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            this.key({ kind, referenceId }),
            eq(tasks.localOrgId, actor.orgId),
            eq(tasks.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!task || task.state === "complete") throw new FederationError("OPERATION_CONFLICT");
      let policyId = task.policyId;
      if (!task.recordId) {
        const now = new Date();
        const [policy] = await tx
          .select()
          .from(policies)
          .where(
            and(
              eq(policies.localSiteId, this.signing.siteId),
              eq(policies.localOrgId, actor.orgId),
              eq(policies.agreementRevisionId, revisionId),
              eq(policies.kind, kind),
              isNull(policies.revokedAt),
              lte(policies.validFrom, now),
              gt(policies.validUntil, now),
            ),
          );
        if (!policy) throw new FederationError("POLICY_DENIED");
        policyId = policy.id;
      }
      await tx
        .update(tasks)
        .set({
          policyId,
          state: "pending",
          lastError: null,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(task));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.closing.retry",
        target: referenceId,
        diff: { after: { kind, policyId } },
      });
    });
  }
}
