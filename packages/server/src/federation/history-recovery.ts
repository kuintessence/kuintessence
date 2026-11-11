import { randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  federationCommercialAgreements as agreements,
  federationArbitrationResolutions as arbitration,
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialBills as bills,
  federationCommercialDiscounts as discounts,
  federationDisputeFreezes as freezes,
  federationSigningKeys as keys,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
  federationReceivedUsage as receivedUsage,
  federationCommercialHistoryRecoveries as recoveries,
  federationCommercialRefunds as refunds,
  federationUsageReports as reports,
  federationDisputeResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  federationUsageTasks as usageTasks,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  type CommercialHistoryRecovery,
  CommercialHistoryRecoverySchema,
  CommercialHistoryRecoveryViewSchema,
} from "@kuintessence/shared/federation/history-recovery";
import {
  commercialHistoryDigest,
  originalCommercialHistoryInput,
  verifyArchivedCommercialDocument,
  verifyCommercialHistoryEnvelope,
  verifyOriginalCommercialHistory,
} from "@kuintessence/shared/federation/history-recovery-proof";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  parseFederationPublicKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Original = typeof submissions.$inferSelect;
type Recovery = typeof recoveries.$inferSelect;

export async function archivedCommercialKey(
  tx: PgDb | PgTransaction,
  siteId: string,
  keyId: string,
) {
  const [key] = await tx
    .select()
    .from(keys)
    .where(and(eq(keys.siteId, siteId), eq(keys.keyId, keyId)));
  if (!key) throw new FederationError("UNTRUSTED_IDENTITY");
  return parseFederationPublicKey(key.publicKeyPem);
}

async function localHistoryFact(
  tx: PgTransaction,
  siteId: string,
  input: CommercialAdapterProposalInput,
) {
  const id = input.recordId,
    digest = input.digest;
  let found: SQL;
  switch (input.operation) {
    case "register-agreement":
      found = sql`EXISTS(SELECT 1 FROM ${agreements} WHERE ${agreements.localSiteId}=${siteId} AND ${agreements.revisionId}=${id} AND ${agreements.digest}=${digest} AND ${agreements.counterpartyJws} IS NOT NULL)`;
      break;
    case "record-usage":
      found = sql`EXISTS(SELECT 1 FROM ${reports} JOIN ${usageTasks} ON ${usageTasks.reservationId}=${reports.reservationId} WHERE ${usageTasks.localSiteId}=${siteId} AND ${reports.id}=${id} AND ${reports.digest}=${digest}) OR EXISTS(SELECT 1 FROM ${receivedUsage} WHERE ${receivedUsage.localSiteId}=${siteId} AND ${receivedUsage.reportId}=${id} AND ${receivedUsage.digest}=${digest})`;
      break;
    case "record-discount":
      found = sql`EXISTS(SELECT 1 FROM ${discounts} WHERE ${discounts.localSiteId}=${siteId} AND ${discounts.discountId}=${id} AND ${discounts.digest}=${digest})`;
      break;
    case "confirm-bill":
      found = sql`EXISTS(SELECT 1 FROM ${bills} WHERE ${bills.localSiteId}=${siteId} AND ${bills.billId}=${id} AND ${bills.digest}=${digest} AND ${bills.counterpartyJws} IS NOT NULL)`;
      break;
    case "settle-bill":
      found = sql`EXISTS(SELECT 1 FROM ${settlements} WHERE ${settlements.localSiteId}=${siteId} AND ${settlements.settlementId}=${id} AND ${settlements.digest}=${digest} AND ${settlements.appliedAt} IS NOT NULL)`;
      break;
    case "adjust-settlement":
      found = sql`EXISTS(SELECT 1 FROM ${adjustments} WHERE ${adjustments.localSiteId}=${siteId} AND ${adjustments.adjustmentId}=${id} AND ${adjustments.digest}=${digest} AND ${adjustments.appliedAt} IS NOT NULL)`;
      break;
    case "record-refund":
      found = sql`EXISTS(SELECT 1 FROM ${refunds} WHERE ${refunds.localSiteId}=${siteId} AND ${refunds.refundId}=${id} AND ${refunds.digest}=${digest} AND ${refunds.appliedAt} IS NOT NULL)`;
      break;
    case "record-payment":
      found = sql`EXISTS(SELECT 1 FROM ${payments} WHERE ${payments.localSiteId}=${siteId} AND ${payments.receiptId}=${id} AND ${payments.digest}=${digest} AND ${payments.confirmedAt} IS NOT NULL)`;
      break;
    case "record-dispute-freeze":
      found = sql`EXISTS(SELECT 1 FROM ${freezes} WHERE ${freezes.localSiteId}=${siteId} AND ${freezes.caseId}=${id} AND ${freezes.digest}=${digest} AND ${freezes.confirmedAt} IS NOT NULL)`;
      break;
    case "record-dispute-resolution":
      found = sql`EXISTS(SELECT 1 FROM ${resolutions} WHERE ${resolutions.localSiteId}=${siteId} AND ${resolutions.resolutionId}=${id} AND ${resolutions.digest}=${digest} AND ${resolutions.appliedAt} IS NOT NULL)`;
      break;
    case "record-arbitration-resolution":
      found = sql`EXISTS(SELECT 1 FROM ${arbitration} WHERE ${arbitration.localSiteId}=${siteId} AND ${arbitration.decisionId}=${id} AND ${arbitration.payload}->>'decisionDigest'=${digest} AND ${arbitration.appliedAt} IS NOT NULL)`;
      break;
    default:
      throw new FederationError("POLICY_DENIED");
  }
  const [fact] = await tx.execute<{ valid: boolean }>(sql`SELECT ${found} AS valid`);
  if (!fact?.valid) throw new FederationError("DATA_WAITING");
}

export class FederationCommercialHistoryService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async context(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    submissionId: string,
  ) {
    await requireFederationCapability(tx, actor, "attestation.recover");
    const [agreement] = await tx
      .select()
      .from(agreements)
      .where(
        and(
          eq(agreements.localSiteId, this.signing.siteId),
          eq(agreements.localOrgId, actor.orgId),
          eq(agreements.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!agreement) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const [snapshot] = await tx
      .select()
      .from(recoveries)
      .where(
        and(
          eq(recoveries.localSiteId, this.signing.siteId),
          eq(recoveries.submissionId, submissionId),
        ),
      );
    const [queue] = snapshot
      ? await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.localSiteId, this.signing.siteId),
              sql`${submissions.input}->>'operation'='record-historical-commercial'`,
              sql`${submissions.input}->>'recordId'=${snapshot.recoveryId}`,
            ),
          )
          .for("update")
      : [];
    const [original] = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.id, submissionId),
          eq(submissions.localSiteId, this.signing.siteId),
          eq(submissions.agreementRevisionId, revisionId),
        ),
      )
      .for("update");
    if (!original) throw new FederationError("ASSET_UNAVAILABLE");
    const [recovery] = await tx
      .select()
      .from(recoveries)
      .where(
        and(
          eq(recoveries.localSiteId, this.signing.siteId),
          eq(recoveries.submissionId, original.id),
        ),
      )
      .for("update");
    if (recovery && !queue) {
      const [appeared] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            sql`${submissions.input}->>'operation'='record-historical-commercial'`,
            sql`${submissions.input}->>'recordId'=${recovery.recoveryId}`,
          ),
        );
      if (appeared) throw new FederationError("DATA_WAITING");
    }
    return { agreement, original, recovery, queue };
  }
  private async eligible(tx: PgTransaction, original: Original, mode: string) {
    if (
      mode !== "bilateral_attested" ||
      !CommercialHistoryRecoverySchema.shape.originalOperation.safeParse(original.input.operation)
        .success ||
      original.state === "committed" ||
      (original.state === "closed" && original.lastError !== "HISTORY_ARCHIVE_ONLY")
    )
      throw new FederationError("POLICY_DENIED");
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, original.id))
      .orderBy(desc(attempts.number))
      .limit(1)
      .for("update");
    const [lease] = await tx
      .select({
        valid: sql<boolean>`${submissions.leaseToken} IS NOT NULL AND ${submissions.leaseUntil}>clock_timestamp()`,
      })
      .from(submissions)
      .where(eq(submissions.id, original.id));
    // Even an endorsed proposal may be in flight. Only a definite non-commit can switch protocols.
    if (lease?.valid || (attempt && !["invalid", "abandoned"].includes(attempt.stage)))
      throw new FederationError("DATA_WAITING");
    await localHistoryFact(tx, this.signing.siteId, original.input);
  }
  private async needsReauthorization(tx: PgTransaction, recovery: Recovery) {
    if (federationMessageKeyId(recovery.approvalJws) !== this.signing.keyId) return true;
    const peer =
      this.signing.siteId === recovery.payload.sourceSiteId
        ? recovery.payload.targetSiteId
        : recovery.payload.sourceSiteId;
    for (const [siteId, jws] of [
      [this.signing.siteId, recovery.approvalJws],
      [peer, recovery.counterpartyJws],
    ] as const) {
      if (!jws) continue;
      try {
        const now = new Date();
        await verifyFederationMessage(
          CommercialHistoryRecoverySchema,
          jws,
          await this.trust.resolveKey(siteId, federationMessageKeyId(jws), now, tx),
          now,
        );
      } catch (error) {
        if (error instanceof FederationError && error.code === "UNTRUSTED_IDENTITY") return true;
        throw error;
      }
    }
    return false;
  }
  private async view(tx: PgTransaction, original: Original, recovery: Recovery) {
    const [ledger] = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, this.signing.siteId),
          sql`${submissions.input}->>'operation'='record-historical-commercial'`,
          sql`${submissions.input}->>'recordId'=${recovery.recoveryId}`,
        ),
      );
    const [attempt] = ledger
      ? await tx
          .select()
          .from(attempts)
          .where(eq(attempts.submissionId, ledger.id))
          .orderBy(desc(attempts.number))
          .limit(1)
      : [];
    const [busy] = ledger
      ? await tx
          .select({
            valid: sql<boolean>`${submissions.leaseToken} IS NOT NULL AND ${submissions.leaseUntil}>clock_timestamp()`,
          })
          .from(submissions)
          .where(eq(submissions.id, ledger.id))
      : [];
    const canReauthorize =
      !busy?.valid &&
      ledger?.state !== "committed" &&
      (!attempt || ["invalid", "abandoned"].includes(attempt.stage)) &&
      (await this.needsReauthorization(tx, recovery));
    return CommercialHistoryRecoveryViewSchema.parse({
      payload: recovery.payload,
      digest: recovery.digest,
      approvalJws: recovery.approvalJws,
      originalInput: federationCanonicalJson(original.input),
      counterpartyApproved: !!recovery.counterpartyJws,
      approvalHistoryCount: recovery.approvalHistory.length,
      canReauthorize,
      original: {
        id: original.id,
        operation: original.input.operation,
        recordId: original.input.recordId,
        digest: original.input.digest,
        state: original.state,
        archiveOnly: original.lastError === "HISTORY_ARCHIVE_ONLY",
      },
      ledger: ledger
        ? {
            id: ledger.id,
            state: ledger.state,
            lastError: ledger.lastError,
            transactionId: attempt?.transactionId ?? null,
            blockNumber: attempt?.blockNumber ?? null,
          }
        : null,
    });
  }
  async get(actor: FederationActor, revisionId: string, submissionId: string) {
    return this.db.transaction(async (tx) => {
      const context = await this.context(tx, actor, revisionId, submissionId);
      return context.recovery ? this.view(tx, context.original, context.recovery) : null;
    });
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    submissionId: string,
    input: { recoveryId: string; reason: string },
  ) {
    return this.db.transaction(async (tx) => {
      const { agreement, original, recovery } = await this.context(
        tx,
        actor,
        revisionId,
        submissionId,
      );
      if (recovery) {
        if (recovery.recoveryId !== input.recoveryId)
          throw new FederationError("OPERATION_CONFLICT");
        return recovery.payload;
      }
      await this.eligible(tx, original, agreement.terms.agreement.mode);
      return CommercialHistoryRecoverySchema.parse({
        protocolVersion: 1,
        kind: "commercial-history-recovery",
        recoveryId: input.recoveryId,
        domainId: original.input.domainId,
        agreementRevisionId: revisionId,
        sourceSiteId: agreement.terms.agreement.sourceSiteId,
        targetSiteId: agreement.terms.agreement.targetSiteId,
        mode: "bilateral_attested",
        assertion: "acknowledge-original-record",
        originalOperation: original.input.operation,
        originalRecordId: original.input.recordId,
        originalDigest: original.input.digest,
        originalInputDigest: commercialHistoryDigest(original.input),
        reason: input.reason,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
    });
  }
  async approve(
    actor: FederationActor,
    revisionId: string,
    submissionId: string,
    raw: CommercialHistoryRecovery,
  ) {
    const payload = CommercialHistoryRecoverySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const { agreement, original, recovery } = await this.context(
        tx,
        actor,
        revisionId,
        submissionId,
      );
      if (recovery) {
        if (federationCanonicalJson(recovery.payload) !== federationCanonicalJson(payload))
          throw new FederationError("OPERATION_CONFLICT");
        return this.view(tx, original, recovery);
      }
      await this.eligible(tx, original, agreement.terms.agreement.mode);
      if (
        payload.agreementRevisionId !== revisionId ||
        payload.domainId !== agreement.terms.domainId ||
        payload.sourceSiteId !== agreement.terms.agreement.sourceSiteId ||
        payload.targetSiteId !== agreement.terms.agreement.targetSiteId ||
        Date.parse(payload.issuedAt) > Date.now() + 60000
      )
        throw new FederationError("POLICY_DENIED");
      const old = originalCommercialHistoryInput(payload, federationCanonicalJson(original.input));
      await verifyOriginalCommercialHistory(payload, old, (schema, jws, siteId) =>
        verifyArchivedCommercialDocument(schema, jws, siteId, (site, kid) =>
          archivedCommercialKey(tx, site, kid),
        ),
      );
      const now = new Date();
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const approvalJws = await signFederationMessage(
        CommercialHistoryRecoverySchema,
        payload,
        this.signing,
      );
      const approved = await verifyFederationMessage(
        CommercialHistoryRecoverySchema,
        approvalJws,
        await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx),
        now,
      );
      const [row] = await tx
        .insert(recoveries)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          recoveryId: payload.recoveryId,
          submissionId: original.id,
          payload,
          digest: approved.digest,
          approvalJws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      const archiveOnly = original.lastError === "HISTORY_ARCHIVE_ONLY";
      await tx
        .update(submissions)
        .set({
          state: archiveOnly ? "closed" : "needs_review",
          lastError: archiveOnly ? "HISTORY_ARCHIVE_ONLY" : "HISTORY_RECOVERY_APPROVED",
          leaseToken: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(submissions.id, original.id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.history.approve",
        target: payload.recoveryId,
        diff: {
          after: {
            submissionId,
            digest: approved.digest,
            originalDigest: payload.originalDigest,
          },
        },
      });
      return this.view(tx, { ...original, state: archiveOnly ? "closed" : "needs_review" }, row);
    });
  }
  async counterparty(
    actor: FederationActor,
    revisionId: string,
    submissionId: string,
    jws: string,
  ) {
    return this.db.transaction(async (tx) => {
      const { agreement, original, recovery, queue } = await this.context(
        tx,
        actor,
        revisionId,
        submissionId,
      );
      if (!recovery) throw new FederationError("DATA_WAITING");
      if (recovery.counterpartyJws) {
        if (recovery.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return this.view(tx, original, recovery);
      }
      await this.eligible(tx, original, agreement.terms.agreement.mode);
      const p = recovery.payload;
      const envelope = {
        sourceSiteId: p.sourceSiteId,
        targetSiteId: p.targetSiteId,
        sourceJws: this.signing.siteId === p.sourceSiteId ? recovery.approvalJws : jws,
        targetJws: this.signing.siteId === p.targetSiteId ? recovery.approvalJws : jws,
        originalInput: federationCanonicalJson(original.input),
      };
      const proof = await verifyCommercialHistoryEnvelope(
        envelope,
        p.domainId,
        p.recoveryId,
        async (schema, signed, siteId) => {
          const now = new Date(),
            kid = federationMessageKeyId(signed);
          await this.trust.assertKey(tx, siteId, kid, now);
          return verifyFederationMessage(
            schema,
            signed,
            await this.trust.resolveKey(siteId, kid, now, tx),
            now,
          );
        },
        (schema, signed, siteId) =>
          verifyArchivedCommercialDocument(schema, signed, siteId, (site, kid) =>
            archivedCommercialKey(tx, site, kid),
          ),
        new Date(),
      );
      if (proof.digest !== recovery.digest) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(recoveries)
        .set({ counterpartyJws: jws })
        .where(
          and(
            eq(recoveries.localSiteId, this.signing.siteId),
            eq(recoveries.recoveryId, recovery.recoveryId),
          ),
        );
      const nextInput = CommercialAdapterProposalInputSchema.parse({
        operation: "record-historical-commercial",
        domainId: p.domainId,
        recordId: p.recoveryId,
        digest: recovery.digest,
        envelope,
      });
      if (queue) {
        const [latest] = await tx
          .select()
          .from(attempts)
          .where(eq(attempts.submissionId, queue.id))
          .orderBy(desc(attempts.number))
          .limit(1)
          .for("update");
        const [busy] = await tx
          .select({
            valid: sql<boolean>`${submissions.leaseToken} IS NOT NULL AND ${submissions.leaseUntil}>clock_timestamp()`,
          })
          .from(submissions)
          .where(eq(submissions.id, queue.id));
        if (
          busy?.valid ||
          queue.state === "committed" ||
          (latest && !["invalid", "abandoned"].includes(latest.stage))
        )
          throw new FederationError("DATA_WAITING");
        await tx
          .update(submissions)
          .set({
            input: nextInput,
            state: "pending",
            lastError: null,
            nextAttemptAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(submissions.id, queue.id));
      } else
        await tx.insert(submissions).values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input: nextInput,
        });
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.history.counterparty",
        target: p.recoveryId,
        diff: { after: { submissionId, digest: recovery.digest } },
      });
      return this.view(tx, original, { ...recovery, counterpartyJws: jws });
    });
  }
  async reauthorize(actor: FederationActor, revisionId: string, submissionId: string) {
    return this.db.transaction(async (tx) => {
      const { agreement, original, recovery, queue } = await this.context(
        tx,
        actor,
        revisionId,
        submissionId,
      );
      if (!recovery) throw new FederationError("DATA_WAITING");
      const view = await this.view(tx, original, recovery);
      if (!view.canReauthorize) throw new FederationError("DATA_WAITING");
      await this.eligible(tx, original, agreement.terms.agreement.mode);
      const now = new Date();
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const approvalJws = await signFederationMessage(
        CommercialHistoryRecoverySchema,
        recovery.payload,
        this.signing,
      );
      await verifyFederationMessage(
        CommercialHistoryRecoverySchema,
        approvalJws,
        await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx),
        now,
      );
      if (approvalJws === recovery.approvalJws && !recovery.counterpartyJws) return view;
      const next = {
        ...recovery,
        approvalJws,
        counterpartyJws: null,
        approvedBy: actor.userId,
        approvalHistory: [
          ...recovery.approvalHistory,
          {
            approvalJws: recovery.approvalJws,
            counterpartyJws: recovery.counterpartyJws,
            recordedAt: now.toISOString(),
            approvedBy: recovery.approvedBy,
            transactionId: view.ledger?.transactionId ?? null,
          },
        ],
      };
      await tx
        .update(recoveries)
        .set({
          approvalJws,
          counterpartyJws: null,
          approvedBy: actor.userId,
          approvalHistory: next.approvalHistory,
        })
        .where(
          and(
            eq(recoveries.localSiteId, this.signing.siteId),
            eq(recoveries.recoveryId, recovery.recoveryId),
          ),
        );
      if (queue)
        await tx
          .update(submissions)
          .set({
            state: "needs_review",
            lastError: "HISTORY_REAPPROVAL_REQUIRED",
            leaseToken: null,
            leaseUntil: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(submissions.id, queue.id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.history.reauthorize",
        target: recovery.recoveryId,
        diff: {
          after: {
            submissionId,
            digest: recovery.digest,
            priorApprovals: next.approvalHistory.length,
          },
        },
      });
      return this.view(tx, original, next);
    });
  }
  async importCounterparty(
    actor: FederationActor,
    revisionId: string,
    input: { payload: CommercialHistoryRecovery; jws: string; originalInput: string },
  ) {
    const payload = CommercialHistoryRecoverySchema.parse(input.payload);
    const submissionId = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "attestation.recover");
      const [agreement] = await tx
        .select()
        .from(agreements)
        .where(
          and(
            eq(agreements.localSiteId, this.signing.siteId),
            eq(agreements.localOrgId, actor.orgId),
            eq(agreements.revisionId, revisionId),
          ),
        )
        .for("share");
      if (!agreement || agreement.terms.agreement.mode !== "bilateral_attested")
        throw new FederationError("AGREEMENT_UNAVAILABLE");
      const a = agreement.terms.agreement;
      if (
        payload.agreementRevisionId !== revisionId ||
        payload.sourceSiteId !== a.sourceSiteId ||
        payload.targetSiteId !== a.targetSiteId ||
        payload.domainId !== agreement.terms.domainId
      )
        throw new FederationError("OPERATION_CONFLICT");
      const peerSite = this.signing.siteId === a.sourceSiteId ? a.targetSiteId : a.sourceSiteId;
      const kid = federationMessageKeyId(input.jws),
        now = new Date();
      await this.trust.assertKey(tx, peerSite, kid, now);
      const peer = await verifyFederationMessage(
        CommercialHistoryRecoverySchema,
        input.jws,
        await this.trust.resolveKey(peerSite, kid, now, tx),
        now,
      );
      if (federationCanonicalJson(peer.payload) !== federationCanonicalJson(payload))
        throw new FederationError("OPERATION_CONFLICT");
      const originalInput = originalCommercialHistoryInput(payload, input.originalInput);
      await verifyOriginalCommercialHistory(payload, originalInput, (schema, jws, siteId) =>
        verifyArchivedCommercialDocument(schema, jws, siteId, (site, keyId) =>
          archivedCommercialKey(tx, site, keyId),
        ),
      );
      await localHistoryFact(tx, this.signing.siteId, originalInput);
      const [existing] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            sql`${submissions.input}->>'operation'=${payload.originalOperation}`,
            sql`${submissions.input}->>'recordId'=${payload.originalRecordId}`,
          ),
        )
        .for("update");
      if (existing) {
        if (
          existing.agreementRevisionId !== revisionId ||
          federationCanonicalJson(existing.input) !== input.originalInput
        )
          throw new FederationError("OPERATION_CONFLICT");
        return existing.id;
      }
      const id = randomUUID();
      await tx.insert(submissions).values({
        id,
        localSiteId: this.signing.siteId,
        agreementRevisionId: revisionId,
        input: originalInput,
        state: "closed",
        lastError: "HISTORY_ARCHIVE_ONLY",
      });
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.history.import",
        target: id,
        diff: {
          after: {
            recoveryId: payload.recoveryId,
            originalDigest: payload.originalDigest,
            archiveOnly: true,
          },
        },
      });
      return id;
    });
    // An incomplete approval leaves only a closed archive, never an executable business intent.
    await this.approve(actor, revisionId, submissionId, payload);
    return this.counterparty(actor, revisionId, submissionId, input.jws);
  }
}

export async function assertCommercialHistorySubmission(
  db: PgDb,
  siteId: string,
  input: Extract<CommercialAdapterProposalInput, { operation: "record-historical-commercial" }>,
  scope?: PgTransaction,
) {
  const verify = async (tx: PgTransaction) => {
    const [snapshot] = await tx
      .select()
      .from(recoveries)
      .where(and(eq(recoveries.localSiteId, siteId), eq(recoveries.recoveryId, input.recordId)));
    if (!snapshot) throw new FederationError("POLICY_DENIED");
    const [original] = await tx
      .select()
      .from(submissions)
      .where(eq(submissions.id, snapshot.submissionId))
      .for("share");
    const [recovery] = await tx
      .select()
      .from(recoveries)
      .where(and(eq(recoveries.localSiteId, siteId), eq(recoveries.recoveryId, input.recordId)))
      .for("share");
    if (!recovery?.counterpartyJws) throw new FederationError("POLICY_DENIED");
    const p = recovery.payload;
    if (
      siteId === p.sourceSiteId
        ? input.envelope.sourceJws !== recovery.approvalJws ||
          input.envelope.targetJws !== recovery.counterpartyJws
        : input.envelope.targetJws !== recovery.approvalJws ||
          input.envelope.sourceJws !== recovery.counterpartyJws
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      !original ||
      original.localSiteId !== siteId ||
      federationCanonicalJson(original.input) !== input.envelope.originalInput
    )
      throw new FederationError("OPERATION_CONFLICT");
    const trust = new FederationTrustRegistry(db);
    const proof = await verifyCommercialHistoryEnvelope(
      input.envelope,
      input.domainId,
      input.recordId,
      async (schema, signed, signer) => {
        const kid = federationMessageKeyId(signed),
          now = new Date();
        await trust.assertKey(tx, signer, kid, now);
        return verifyFederationMessage(
          schema,
          signed,
          await trust.resolveKey(signer, kid, now, tx),
          now,
        );
      },
      (schema, signed, signer) =>
        verifyArchivedCommercialDocument(schema, signed, signer, (site, kid) =>
          archivedCommercialKey(tx, site, kid),
        ),
      new Date(),
    );
    if (proof.digest !== input.digest || input.digest !== recovery.digest)
      throw new FederationError("OPERATION_CONFLICT");
  };
  return scope ? verify(scope) : db.transaction(verify);
}
