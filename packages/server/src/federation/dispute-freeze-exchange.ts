import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationDisputes as cases,
  federationDisputeDeliveries as deliveries,
  federationDisputeFreezes as freezes,
  type PgDb,
  type PgTransaction,
  federationSites as sites,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  CommercialAdapterProposalInputSchema,
  CommercialReceiptQueryResultSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeFinancialViewSchema,
  type CommercialDisputeFreeze,
  CommercialDisputeFreezeSchema,
} from "@kuintessence/shared/federation/disputes";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import type { CommercialClient } from "./commercial-client";
import { FederationDisputeService } from "./disputes";
import { FabricClientFailure } from "./fabric-client";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Freeze = typeof freezes.$inferSelect;
type Snapshot = Awaited<ReturnType<FederationDisputeService["financialSnapshot"]>>;
class FreezeLeaseLost extends Error {}

/** Institutional reconciliation only. It cannot approve an award, transfer funds or disclose evidence. */
export class FederationDisputeFreezeExchange {
  private readonly trust: FederationTrustRegistry;
  private readonly disputes: FederationDisputeService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
    private readonly client?: Pick<CommercialClient, "receipt">,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disputes = new FederationDisputeService(db, signing);
  }
  private key(caseId: string) {
    return and(eq(freezes.localSiteId, this.signing.siteId), eq(freezes.caseId, caseId));
  }
  private async verify(tx: PgTransaction, jws: string, siteId: string) {
    const kid = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, siteId, kid, new Date());
    return verifyFederationMessage(
      CommercialDisputeFreezeSchema,
      jws,
      await this.trust.resolveKey(siteId, kid, new Date(), tx),
      new Date(),
    );
  }
  private checkIdentity(value: CommercialDisputeFreeze, record: Snapshot["record"]) {
    if (
      value.caseId !== record.caseId ||
      value.caseDigest !== record.digest ||
      value.agreementRevisionId !== record.agreementRevisionId ||
      value.taskId !== record.taskId ||
      value.attempt !== record.attempt ||
      value.sourceSiteId !== record.payload.sourceSiteId ||
      value.targetSiteId !== record.payload.targetSiteId ||
      Date.parse(value.issuedAt) < Date.parse(record.payload.issuedAt) ||
      Date.parse(value.issuedAt) > Date.now() + 60000
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private check(value: CommercialDisputeFreeze, current: Snapshot) {
    const { record, view } = current;
    this.checkIdentity(value, record);
    if (!view.localReady || !view.headDigest) throw new FederationError("DATA_WAITING");
    if (
      !["FREEZE_PENDING", "DISPUTED"].includes(record.state) ||
      value.mode !== view.mode ||
      value.headDigest !== view.headDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private async saved(tx: PgTransaction, row: Freeze, other: string) {
    if (!row.approvalJws || !row.payload || !row.digest || !row.financialView)
      throw new FederationError("OPERATION_CONFLICT");
    const signed = await this.verify(tx, row.approvalJws, this.signing.siteId);
    const {
      observedAt: _observed,
      localReady,
      headDigest,
      requiresLedgerFreeze: _ledger,
      ...snapshot
    } = CommercialDisputeFinancialViewSchema.parse(row.financialView);
    if (
      !localReady ||
      headDigest !== signed.payload.headDigest ||
      federationMaterialDigest(snapshot) !== headDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      signed.digest !== row.digest ||
      federationCanonicalJson(signed.payload) !== federationCanonicalJson(row.payload)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      row.counterpartyJws &&
      (await this.verify(tx, row.counterpartyJws, other)).digest !== row.digest
    )
      throw new FederationError("OPERATION_CONFLICT");
    return { ...row, payload: signed.payload, approvalJws: row.approvalJws, digest: row.digest };
  }
  /** Revalidate an existing freeze against today's originals. No new freeze or ledger operation. */
  async arbitrationSnapshot(tx: PgTransaction, caseId: string) {
    const current = await this.disputes.financialSnapshot(tx, caseId);
    const [row] = await tx.select().from(freezes).where(this.key(caseId)).for("share");
    if (
      !row ||
      row.state !== "confirmed" ||
      !["DISPUTED", "EVIDENCE_WAITING"].includes(current.record.state)
    )
      return null;
    const original = await this.saved(tx, row, current.record.other);
    this.checkIdentity(original.payload, current.record);
    if (
      !original.counterpartyJws ||
      !current.view.localReady ||
      current.view.headDigest !== original.payload.headDigest ||
      current.view.mode !== original.payload.mode
    )
      throw new FederationError("DATA_WAITING");
    if (
      current.view.requiresLedgerFreeze &&
      (!original.ledgerReceipt ||
        original.ledgerReceipt.recordId !== caseId ||
        original.ledgerReceipt.digest !== original.digest)
    )
      throw new FederationError("DATA_WAITING");
    const source = current.record.payload.sourceSiteId === this.signing.siteId;
    return {
      current,
      financial: {
        headDigest: original.payload.headDigest,
        freezeDigest: original.digest,
        records: current.view.records,
        ledgerReceipt: current.view.requiresLedgerFreeze ? original.ledgerReceipt : null,
        sourceJws: source ? original.approvalJws : original.counterpartyJws,
        targetJws: source ? original.counterpartyJws : original.approvalJws,
      },
    };
  }
  private async confirm(tx: PgTransaction, current: Snapshot, digest: string) {
    // New commitments were already blocked by the case; old signatures must have finished first.
    await tx
      .update(cases)
      .set({ state: "DISPUTED" })
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, current.record.caseId),
          eq(cases.state, "FREEZE_PENDING"),
        ),
      );
    await tx.insert(auditLog).values({
      actor: `dispute-freeze:${this.signing.siteId}`,
      orgId: current.record.localOrgId,
      action: "federation.dispute.freeze_confirm",
      target: current.record.caseId,
      diff: { after: { digest, headDigest: current.view.headDigest } },
    });
  }
  private async finishProof(tx: PgTransaction, current: Snapshot, digest: string) {
    if (!current.view.requiresLedgerFreeze) await this.confirm(tx, current, digest);
    else
      await tx.insert(auditLog).values({
        actor: `dispute-freeze:${this.signing.siteId}`,
        orgId: current.record.localOrgId,
        action: "federation.dispute.freeze_sign",
        target: current.record.caseId,
        diff: { after: { digest, headDigest: current.view.headDigest } },
      });
    // The opening institution publishes once, in the same transaction as its durable dual proof.
    if (
      current.view.mode !== "bilateral_direct" &&
      current.record.payload.openingSiteId === this.signing.siteId
    ) {
      const [row] = await tx.select().from(freezes).where(this.key(current.record.caseId));
      if (
        !row?.approvalJws ||
        !row.counterpartyJws ||
        !["confirmed", "ledger_pending"].includes(row.state)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const source = this.signing.siteId === current.record.payload.sourceSiteId;
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: current.record.agreementRevisionId,
        input: CommercialAdapterProposalInputSchema.parse({
          operation: current.view.requiresLedgerFreeze
            ? "freeze-disputed-task"
            : "record-dispute-freeze",
          domainId: current.record.payload.domainId,
          recordId: current.record.caseId,
          digest,
          envelope: {
            sourceSiteId: current.record.payload.sourceSiteId,
            targetSiteId: current.record.payload.targetSiteId,
            sourceJws: source ? row.approvalJws : row.counterpartyJws,
            targetJws: source ? row.counterpartyJws : row.approvalJws,
            openingSiteId: this.signing.siteId,
            openingJws: current.record.openingJws,
          },
        }),
      });
    }
  }
  private async readiness(tx: PgTransaction, current: Snapshot) {
    if (!current.view.requiresLedgerFreeze) return null;
    const refs = await this.disputes.nativeReferences(tx, current);
    return {
      refs,
      digest: federationMaterialDigest({ headDigest: current.view.headDigest, refs }),
    };
  }
  private async nativeReady(caseId: string, openingPeer?: string) {
    const snapshot = await this.db.transaction(
      async (tx) => {
        const current = await this.disputes.financialSnapshot(tx, caseId);
        if (
          openingPeer &&
          (current.record.other !== openingPeer ||
            current.record.payload.openingSiteId !== openingPeer ||
            current.record.openedBy !== null)
        )
          throw new FederationError("UNTRUSTED_IDENTITY");
        return {
          domainId: current.record.payload.domainId,
          ready: await this.readiness(tx, current),
        };
      },
      { isolationLevel: "repeatable read" },
    );
    if (!snapshot.ready) return null;
    if (!this.client?.receipt) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    for (const ref of snapshot.ready.refs) {
      const { receipt } = CommercialReceiptQueryResultSchema.parse(
        await this.client.receipt({
          operation: "get-commercial-receipt",
          domainId: snapshot.domainId,
          recordType: ref.recordType,
          recordId: ref.recordId,
        }),
      );
      if (!receipt) throw new FederationError("DATA_WAITING");
      if (receipt.recordId !== ref.recordId || receipt.digest !== ref.digest)
        throw new FederationError("OPERATION_CONFLICT");
    }
    return snapshot.ready.digest;
  }
  private async checkReadiness(tx: PgTransaction, current: Snapshot, ready: string | null) {
    if (
      current.view.requiresLedgerFreeze &&
      (!ready || (await this.readiness(tx, current))?.digest !== ready)
    )
      throw new FederationError("DATA_WAITING");
  }
  /** The private listener authenticates the original opening institution, never a human identity header. */
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const first = await verifyFederationMessage(
      CommercialDisputeFreezeSchema,
      jws,
      peer,
      new Date(),
    );
    const [existing] = await this.db.select().from(freezes).where(this.key(first.payload.caseId));
    const ready =
      first.payload.mode === "ledger_coordinated" && !existing
        ? await this.nativeReady(first.payload.caseId, peer.siteId)
        : null;
    return this.db.transaction(
      async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`dispute-freeze:${this.signing.siteId}:${first.payload.caseId}`}, 0))`,
        );
        await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
        const verified = await this.verify(tx, jws, peer.siteId),
          value = verified.payload;
        const record = await this.disputes.verifiedCase(tx, value.caseId);
        if (
          record.payload.openingSiteId !== peer.siteId ||
          record.other !== peer.siteId ||
          record.openedBy !== null ||
          value.caseDigest !== record.digest ||
          value.sourceSiteId !== record.payload.sourceSiteId ||
          value.targetSiteId !== record.payload.targetSiteId
        )
          throw new FederationError("UNTRUSTED_IDENTITY");
        const [prior] = await tx.select().from(freezes).where(this.key(value.caseId)).for("update");
        if (prior) {
          const original = await this.saved(tx, prior, peer.siteId);
          if (
            !["confirmed", "ledger_pending", "needs_review"].includes(original.state) ||
            original.digest !== verified.digest ||
            original.counterpartyJws !== jws
          )
            throw new FederationError("OPERATION_CONFLICT");
          // Historical replay returns the original proof, without resetting a later case state.
          return original.approvalJws;
        }
        const current = await this.disputes.financialSnapshot(tx, value.caseId);
        this.check(value, current);
        await this.checkReadiness(tx, current, ready);
        const approvalJws = await signFederationMessage(
          CommercialDisputeFreezeSchema,
          value,
          this.signing,
        );
        const own = await this.verify(tx, approvalJws, this.signing.siteId);
        if (own.digest !== verified.digest) throw new FederationError("OPERATION_CONFLICT");
        await tx.insert(freezes).values({
          localSiteId: this.signing.siteId,
          caseId: value.caseId,
          state: current.view.requiresLedgerFreeze ? "ledger_pending" : "confirmed",
          payload: value,
          financialView: current.view,
          digest: own.digest,
          approvalJws,
          counterpartyJws: jws,
          confirmedAt: current.view.requiresLedgerFreeze ? null : new Date(),
        });
        await this.finishProof(tx, current, own.digest);
        return approvalJws;
      },
      { isolationLevel: "repeatable read" },
    );
  }
  async discover() {
    if (!this.send) return;
    const rows = await this.db
      .select({ localSiteId: cases.localSiteId, caseId: cases.caseId })
      .from(cases)
      .innerJoin(
        deliveries,
        and(
          eq(deliveries.localSiteId, cases.localSiteId),
          eq(deliveries.caseId, cases.caseId),
          eq(deliveries.state, "received"),
        ),
      )
      .leftJoin(
        freezes,
        and(eq(freezes.localSiteId, cases.localSiteId), eq(freezes.caseId, cases.caseId)),
      )
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.state, "FREEZE_PENDING"),
          isNull(freezes.caseId),
          sql`${cases.payload}->>'openingSiteId' = ${this.signing.siteId}`,
        ),
      )
      .orderBy(asc(cases.createdAt), asc(cases.caseId))
      .limit(8);
    if (rows.length) await this.db.insert(freezes).values(rows).onConflictDoNothing();
  }
  private async lock(tx: PgTransaction, claim: Freeze) {
    if (!claim.leaseToken) throw new FreezeLeaseLost();
    const [row] = await tx
      .select()
      .from(freezes)
      .where(
        and(
          this.key(claim.caseId),
          eq(freezes.state, claim.state),
          eq(freezes.leaseToken, claim.leaseToken),
          sql`${freezes.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new FreezeLeaseLost();
    return row;
  }
  private async source(tx: PgTransaction, caseId: string, endpoint?: string) {
    const current = await this.disputes.financialSnapshot(tx, caseId);
    if (!current.record.openedBy || current.record.payload.openingSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const [delivery] = await tx
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.localSiteId, this.signing.siteId), eq(deliveries.caseId, caseId)));
    if (delivery?.state !== "received") throw new FederationError("DATA_WAITING");
    const [peer] = await tx
      .select()
      .from(sites)
      .where(eq(sites.id, current.record.other))
      .for("share");
    if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return { ...current, endpoint: peer.endpoint };
  }
  private async advance(claim: Freeze) {
    if (!this.send) return;
    const ready = await this.nativeReady(claim.caseId);
    const scope = await this.db.transaction(
      async (tx) => {
        const row = await this.lock(tx, claim),
          current = await this.source(tx, claim.caseId);
        await this.checkReadiness(tx, current, ready);
        if (!current.view.localReady || !current.view.headDigest)
          throw new FederationError("DATA_WAITING");
        if (row.approvalJws) {
          const original = await this.saved(tx, row, current.record.other);
          this.check(original.payload, current);
          return { ...current, original };
        }
        const value = CommercialDisputeFreezeSchema.parse({
          protocolVersion: 1,
          kind: "commercial-dispute-freeze",
          caseId: claim.caseId,
          caseDigest: current.record.digest,
          agreementRevisionId: current.record.agreementRevisionId,
          sourceSiteId: current.record.payload.sourceSiteId,
          targetSiteId: current.record.payload.targetSiteId,
          taskId: current.record.taskId,
          attempt: current.record.attempt,
          mode: current.view.mode,
          headDigest: current.view.headDigest,
          issuedAt: new Date().toISOString(),
          salt: randomBytes(32).toString("hex"),
        });
        this.check(value, current);
        const approvalJws = await signFederationMessage(
          CommercialDisputeFreezeSchema,
          value,
          this.signing,
        );
        const signed = await this.verify(tx, approvalJws, this.signing.siteId);
        const [prepared] = await tx
          .update(freezes)
          .set({ payload: value, financialView: current.view, digest: signed.digest, approvalJws })
          .where(this.key(claim.caseId))
          .returning();
        if (!prepared) throw new FreezeLeaseLost();
        await tx.insert(auditLog).values({
          actor: `dispute-freeze:${this.signing.siteId}`,
          orgId: current.record.localOrgId,
          action: "federation.dispute.freeze_propose",
          target: claim.caseId,
          diff: { after: { digest: signed.digest, headDigest: value.headDigest } },
        });
        return {
          ...current,
          original: { ...prepared, approvalJws, digest: signed.digest, payload: value },
        };
      },
      { isolationLevel: "repeatable read" },
    );
    const response = await this.send(
      scope.endpoint,
      scope.original.approvalJws,
      "/federation/v1/dispute-freezes",
    );
    await this.db.transaction(
      async (tx) => {
        const row = await this.lock(tx, claim),
          current = await this.source(tx, claim.caseId, scope.endpoint);
        const original = await this.saved(tx, row, current.record.other);
        if (
          original.approvalJws !== scope.original.approvalJws ||
          current.record.localOrgId !== scope.record.localOrgId
        )
          throw new FederationError("OPERATION_CONFLICT");
        this.check(original.payload, current);
        await this.checkReadiness(tx, current, ready);
        const peer = await this.verify(tx, response, current.record.other);
        if (peer.digest !== original.digest) throw new FederationError("OPERATION_CONFLICT");
        await tx
          .update(freezes)
          .set({
            state: current.view.requiresLedgerFreeze ? "ledger_pending" : "confirmed",
            counterpartyJws: response,
            confirmedAt: current.view.requiresLedgerFreeze ? null : new Date(),
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          })
          .where(this.key(claim.caseId));
        await this.finishProof(tx, current, original.digest);
      },
      { isolationLevel: "repeatable read" },
    );
  }
  private async reconcile(claim: Freeze) {
    if (!this.client?.receipt) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const before = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim);
      const record = await this.disputes.verifiedCase(tx, claim.caseId);
      const original = await this.saved(tx, row, record.other);
      this.checkIdentity(original.payload, record);
      if (!original.counterpartyJws || original.payload.mode !== "ledger_coordinated")
        throw new FederationError("OPERATION_CONFLICT");
      return { record, original };
    });
    const { receipt } = CommercialReceiptQueryResultSchema.parse(
      await this.client.receipt({
        operation: "get-commercial-receipt",
        domainId: before.record.payload.domainId,
        recordType: "native-dispute-freeze",
        recordId: claim.caseId,
      }),
    );
    if (!receipt) throw new FederationError("DATA_WAITING");
    if (receipt.recordId !== claim.caseId || receipt.digest !== before.original.digest)
      throw new FederationError("OPERATION_CONFLICT");
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim);
      const record = await this.disputes.verifiedCase(tx, claim.caseId);
      const original = await this.saved(tx, row, record.other);
      this.checkIdentity(original.payload, record);
      if (
        original.digest !== receipt.digest ||
        original.counterpartyJws !== before.original.counterpartyJws ||
        original.approvalJws !== before.original.approvalJws ||
        record.digest !== before.record.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(freezes)
        .set({
          state: "confirmed",
          ledgerReceipt: receipt,
          confirmedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
        })
        .where(this.key(claim.caseId));
      await this.confirm(
        tx,
        { record, view: CommercialDisputeFinancialViewSchema.parse(original.financialView) },
        original.digest,
      );
    });
  }
  async advanceNext() {
    if (!this.send && !this.client?.receipt) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(freezes)
        .where(
          and(
            eq(freezes.localSiteId, this.signing.siteId),
            or(
              this.send ? eq(freezes.state, "pending") : undefined,
              this.client?.receipt ? eq(freezes.state, "ledger_pending") : undefined,
            ),
            sql`${freezes.nextAttemptAt} <= clock_timestamp()`,
            sql`(${freezes.leaseUntil} IS NULL OR ${freezes.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(freezes.nextAttemptAt), asc(freezes.caseId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(freezes)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.caseId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      if (claim.state === "ledger_pending") await this.reconcile(claim);
      else await this.advance(claim);
    } catch (error) {
      if (error instanceof FreezeLeaseLost || !claim.leaseToken) return true;
      const review =
        (error instanceof FederationError && error.code !== "DATA_WAITING") ||
        (error instanceof FabricClientFailure && error.needsReview) ||
        error instanceof z.ZodError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(freezes)
        .set({
          state: review ? "needs_review" : claim.state,
          lastError:
            error instanceof FederationError ||
            error instanceof FederationDeliveryError ||
            error instanceof FabricClientFailure
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "FREEZE_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.caseId),
            eq(freezes.leaseToken, claim.leaseToken),
            eq(freezes.state, claim.state),
            sql`${freezes.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  private async authorize(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    capability: "dispute.read" | "dispute.open",
  ) {
    await requireFederationCapability(tx, actor, capability);
    const [record] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, caseId),
          eq(cases.localOrgId, actor.orgId),
          eq(cases.agreementRevisionId, revisionId),
        ),
      );
    if (!record) throw new FederationError("POLICY_DENIED");
    return record;
  }
  async status(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, revisionId, caseId, "dispute.read");
      const [row] = await tx.select().from(freezes).where(this.key(caseId));
      const [attestation] = await tx
        .select({
          id: submissions.id,
          state: submissions.state,
          lastError: submissions.lastError,
          updatedAt: submissions.updatedAt,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`${submissions.input}->>'operation' IN ('record-dispute-freeze','freeze-disputed-task')`,
            sql`${submissions.input}->>'recordId' = ${caseId}`,
          ),
        );
      return {
        attestation: attestation ?? null,
        enabled: !!this.send || !!this.client?.receipt,
        sync: row
          ? {
              state: row.state,
              lastError: row.lastError,
              nextAttemptAt: row.nextAttemptAt,
              confirmedAt: row.confirmedAt,
              headDigest: row.payload?.headDigest ?? null,
            }
          : null,
      };
    });
  }
  async retry(actor: FederationActor, revisionId: string, caseId: string) {
    if (!this.send && !this.client?.receipt) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      const record = await this.authorize(tx, actor, revisionId, caseId, "dispute.open");
      const [row] = await tx.select().from(freezes).where(this.key(caseId)).for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      const native = row.payload?.mode === "ledger_coordinated" && !!row.counterpartyJws;
      if (!native && (!record.openedBy || record.payload.openingSiteId !== this.signing.siteId))
        throw new FederationError("POLICY_DENIED");
      if (native ? !this.client?.receipt : !this.send)
        throw new FederationError("ASSET_UNAVAILABLE");
      if (row.state === "confirmed" || (row.leaseUntil && row.leaseUntil > new Date()))
        throw new FederationError("OPERATION_CONFLICT");
      await this.disputes.verifiedCase(tx, caseId);
      await tx
        .update(freezes)
        .set({
          state: native ? "ledger_pending" : "pending",
          lastError: null,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(caseId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.dispute.freeze_retry",
        target: caseId,
      });
    });
  }
}
