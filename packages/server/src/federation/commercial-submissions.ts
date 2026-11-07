import { randomUUID } from "node:crypto";
import {
  federationCommercialAgreements as agreements,
  federationCommercialExecutionApprovals as approvals,
  federationCommercialAttempts as attempts,
  auditLog,
  federationMarketSubmissions as marketSubmissions,
  type PgDb,
  type PgTransaction,
  federationUsageReports as reports,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
  CommercialExecutionApprovalSchema,
  CommercialReceiptQueryResultSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
  FabricCommercialAdvanceResultSchema,
} from "@kuintessence/shared/federation/commercial";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { CommercialClient } from "./commercial-client";
import { enqueueExecutionClosure } from "./execution-closure";
import { FabricClientFailure } from "./fabric-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Submission = typeof submissions.$inferSelect;
type Lease = { id: string; token: string };
class LeaseLost extends Error {}
const MvccReconciling = "MVCC_RECONCILING";
const recordTypes = {
  "register-agreement": "agreement",
  "record-usage": "usage",
  "reserve-execution": "reservation",
  "release-execution": "release",
  "record-execution-terminal": "terminal",
} as const;

export class FederationCommercialSubmissionService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly client?: CommercialClient,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async claim(): Promise<Lease | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            sql`(${submissions.state} = 'pending' OR (
              ${submissions.state} = 'committed'
              AND ${submissions.input}->>'operation' = 'record-execution-terminal'
              AND ${submissions.input}->'envelope'->>'sourceSiteId' = ${this.siteId}
              AND NOT EXISTS (SELECT 1 FROM ${marketSubmissions} closure
                WHERE closure.id::text = ${submissions.input}->>'recordId'
                  AND closure.local_site_id = ${submissions.localSiteId}
                  AND closure.input->>'operation' = 'close-demand')
            ))`,
            sql`(${submissions.input}->>'operation' = 'register-agreement' OR EXISTS (
              SELECT 1 FROM ${submissions} dependency
              WHERE dependency.local_site_id = ${submissions.localSiteId}
                AND dependency.agreement_revision_id = ${submissions.agreementRevisionId}
                AND dependency.input->>'operation' = 'register-agreement'
                AND dependency.state = 'committed'
            ))`,
            sql`(${submissions.input}->>'operation' NOT IN ('reserve-execution','release-execution') OR EXISTS (
              SELECT 1 FROM ${approvals} approval
              WHERE approval.local_site_id = ${submissions.localSiteId}
                AND approval.agreement_revision_id = ${submissions.agreementRevisionId}
                AND approval.record_id::text = ${submissions.input}->>'recordId'
                AND approval.digest = ${submissions.input}->>'digest'
                AND approval.counterparty_jws IS NOT NULL
                AND (${submissions.input}->>'operation' = 'reserve-execution' OR EXISTS (
                  SELECT 1 FROM ${submissions} reservation
                  WHERE reservation.local_site_id = ${submissions.localSiteId}
                    AND reservation.agreement_revision_id = ${submissions.agreementRevisionId}
                    AND reservation.input->>'operation' = 'reserve-execution'
                    AND reservation.input->>'recordId' = approval.payload->>'reservationId'
                    AND reservation.state = 'committed'
                ))
            ))`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${reports} usage_report
              WHERE usage_report.id = (${submissions.input}->>'recordId')::uuid
                AND ${submissions.input}->>'operation' = 'record-usage'
                AND usage_report.report->>'correctionOf' IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM ${submissions} predecessor
                  WHERE predecessor.local_site_id = ${submissions.localSiteId}
                    AND predecessor.agreement_revision_id = ${submissions.agreementRevisionId}
                    AND predecessor.input->>'operation' = 'record-usage'
                    AND predecessor.input->>'recordId' = usage_report.report->>'correctionOf'
                    AND predecessor.state = 'committed'
                )
            )`,
            sql`(${submissions.input}->>'operation' <> 'record-execution-terminal' OR EXISTS (
              SELECT 1 FROM ${terminals} terminal
              JOIN ${approvals} original ON original.local_site_id = terminal.local_site_id AND original.record_id = terminal.reservation_id
              WHERE terminal.local_site_id = ${submissions.localSiteId}
                AND terminal.terminal_id::text = ${submissions.input}->>'recordId'
                AND terminal.digest = ${submissions.input}->>'digest'
                AND terminal.counterparty_jws IS NOT NULL
                AND original.agreement_revision_id = ${submissions.agreementRevisionId}
                AND EXISTS (SELECT 1 FROM ${submissions} reservation
                  WHERE reservation.local_site_id = terminal.local_site_id
                    AND reservation.agreement_revision_id = original.agreement_revision_id
                    AND reservation.input->>'operation' = 'reserve-execution'
                    AND reservation.input->>'recordId' = terminal.reservation_id::text
                    AND reservation.state = 'committed')
            ))`,
            sql`${submissions.nextAttemptAt} <= clock_timestamp()`,
            sql`(${submissions.leaseToken} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(submissions.nextAttemptAt), asc(submissions.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(submissions)
        .set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
        .where(eq(submissions.id, row.id));
      return { id: row.id, token };
    });
  }

  private fenced<T>(
    lease: Lease,
    operation: (tx: PgTransaction, submission: Submission) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, lease.id),
            eq(submissions.localSiteId, this.siteId),
            sql`${submissions.state} IN ('pending','committed')`,
            eq(submissions.leaseToken, lease.token),
            sql`${submissions.leaseUntil} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!row) throw new LeaseLost();
      const result = await operation(tx, row);
      const [valid] = await tx
        .select({ valid: sql<boolean>`${submissions.leaseUntil} > clock_timestamp()` })
        .from(submissions)
        .where(eq(submissions.id, row.id));
      if (!valid?.valid) throw new LeaseLost();
      return result;
    });
  }

  private latest(tx: PgTransaction, id: string) {
    return tx
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, id))
      .orderBy(desc(attempts.number))
      .limit(1);
  }

  /** One checkpoint per call: a transaction can never be submitted before its bytes are committed. */
  async advanceNext(): Promise<boolean> {
    if (!this.client) return false;
    const lease = await this.claim();
    if (!lease) return false;
    const claimed = lease;
    let reconciling = false;
    try {
      const snapshot = await this.fenced(claimed, async (tx, submission) => ({
        submission,
        attempt: (await this.latest(tx, submission.id))[0],
      }));
      const { submission, attempt } = snapshot;
      reconciling = submission.lastError === MvccReconciling;
      if (submission.state === "committed" || attempt?.stage === "committed") {
        if (
          submission.input.operation !== "record-execution-terminal" ||
          attempt?.stage !== "committed"
        )
          throw new FederationError("OPERATION_CONFLICT");
        await this.fenced(claimed, async (tx) => {
          await tx
            .update(submissions)
            .set({ state: "committed", lastError: null })
            .where(eq(submissions.id, submission.id));
          await enqueueExecutionClosure(tx, this.siteId, submission.input.recordId);
        });
      } else if (!attempt || attempt.stage === "invalid" || attempt.stage === "abandoned") {
        await this.beforeDisclosure(submission.input);
        let receipt: z.infer<typeof CommercialReceiptQueryResultSchema>["receipt"] = null;
        if (reconciling) {
          if (
            !this.client.receipt ||
            attempt?.stage !== "invalid" ||
            attempt.validationCode !== 11 ||
            attempt.number !== 1 ||
            attempt.blockNumber === null
          )
            throw new FabricClientFailure("MVCC_RECONCILIATION_UNAVAILABLE", true);
          ({ receipt } = CommercialReceiptQueryResultSchema.parse(
            await this.client.receipt({
              operation: "get-commercial-receipt",
              domainId: submission.input.domainId,
              recordType: recordTypes[submission.input.operation],
              recordId: submission.input.recordId,
            }),
          ));
          if (!receipt) throw new FabricClientFailure("MVCC_ORIGINAL_NOT_FOUND", true);
          if (
            receipt.recordId !== submission.input.recordId ||
            receipt.digest !== submission.input.digest
          )
            throw new FederationError("OPERATION_CONFLICT");
          await this.beforeDisclosure(submission.input);
        }
        const result = FabricProposalCheckpointSchema.parse(
          await this.client.prepare(submission.input),
        );
        await this.fenced(claimed, async (tx, current) => {
          if (receipt) {
            const [latest] = await this.latest(tx, submission.id);
            if (
              !attempt ||
              latest?.id !== attempt.id ||
              latest.stage !== "invalid" ||
              current.lastError !== MvccReconciling ||
              federationCanonicalJson(current.input) !== federationCanonicalJson(submission.input)
            )
              throw new FederationError("OPERATION_CONFLICT");
            await this.beforeDisclosure(current.input, tx);
            const [contract] = await tx
              .select({ orgId: agreements.localOrgId })
              .from(agreements)
              .where(
                and(
                  eq(agreements.localSiteId, this.siteId),
                  eq(agreements.revisionId, current.agreementRevisionId),
                ),
              );
            if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
            await tx.insert(auditLog).values({
              actor: `commercial-worker:${this.siteId}`,
              orgId: contract.orgId,
              action: "federation.commercial.mvcc_reconcile",
              target: current.id,
              diff: {
                after: {
                  previousTransactionId: attempt.transactionId,
                  previousBlockNumber: attempt.blockNumber,
                  validationCode: 11,
                  receipt,
                  transactionId: result.transactionId,
                },
              },
            });
          }
          await tx.insert(attempts).values({
            id: randomUUID(),
            submissionId: submission.id,
            number: (attempt?.number ?? 0) + 1,
            transactionId: result.transactionId,
            recovery: result.recovery,
          });
          await this.schedule(tx, submission.id);
        });
      } else {
        if (attempt.stage === "proposal") await this.beforeDisclosure(submission.input);
        const result = FabricCommercialAdvanceResultSchema.parse(
          await this.client.advance(attempt.recovery),
        );
        if (
          result.transactionId !== attempt.transactionId ||
          (attempt.stage === "proposal" && result.state !== "prepared") ||
          (attempt.stage === "transaction" && result.state === "prepared") ||
          (result.state === "pending" && result.recovery !== attempt.recovery)
        )
          throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
        await this.fenced(claimed, async (tx) => {
          if (result.state === "prepared") {
            await tx
              .update(attempts)
              .set({
                stage: "transaction",
                recovery: result.recovery,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, submission.id);
          } else if (result.state === "pending") {
            await this.schedule(tx, submission.id, "LEDGER_PENDING");
          } else {
            // Only a definite first MVCC failure may inspect the original immutable PDC record.
            const reconcile =
              result.state === "invalid" &&
              result.validationCode === 11 &&
              attempt.number === 1 &&
              !!this.client?.receipt;
            await tx
              .update(attempts)
              .set({
                stage: result.state,
                validationCode: result.state === "committed" ? 0 : result.validationCode,
                blockNumber: result.blockNumber,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await tx
              .update(submissions)
              .set({
                state:
                  result.state === "committed"
                    ? "committed"
                    : reconcile
                      ? "pending"
                      : "needs_review",
                lastError:
                  result.state === "committed"
                    ? null
                    : reconcile
                      ? MvccReconciling
                      : "LEDGER_INVALID",
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(submissions.id, submission.id));
            if (
              result.state === "committed" &&
              submission.input.operation === "record-execution-terminal"
            )
              await enqueueExecutionClosure(tx, this.siteId, submission.input.recordId);
          }
        });
      }
    } catch (error) {
      if (!(error instanceof LeaseLost)) {
        const failure =
          error instanceof FabricClientFailure
            ? error
            : error instanceof FederationError
              ? new FabricClientFailure(error.code, true)
              : error instanceof z.ZodError
                ? new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true)
                : new FabricClientFailure("COMMERCIAL_RETRY");
        try {
          await this.fenced(claimed, async (tx) => {
            await this.schedule(
              tx,
              claimed.id,
              reconciling && !failure.needsReview ? MvccReconciling : failure.code,
            );
            if (failure.needsReview)
              await tx
                .update(submissions)
                .set({ state: "needs_review" })
                .where(eq(submissions.id, claimed.id));
          });
        } catch (saveError) {
          if (!(saveError instanceof LeaseLost)) throw saveError;
        }
      }
    } finally {
      await this.db
        .update(submissions)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(submissions.id, claimed.id), eq(submissions.leaseToken, claimed.token)));
    }
    return true;
  }

  private async schedule(tx: PgTransaction, id: string, error: string | null = null) {
    await tx
      .update(submissions)
      .set({
        lastError: error,
        nextAttemptAt: error
          ? sql`clock_timestamp() + interval '30 seconds'`
          : sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(submissions.id, id));
  }

  private async beforeDisclosure(raw: CommercialAdapterProposalInput, tx?: PgTransaction) {
    const input = CommercialAdapterProposalInputSchema.parse(raw);
    if (input.operation === "record-execution-terminal") {
      const [local] = await (tx ?? this.db)
        .select()
        .from(terminals)
        .where(
          and(
            eq(terminals.localSiteId, this.siteId),
            eq(terminals.terminalId, input.recordId),
            eq(terminals.digest, input.digest),
          ),
        );
      if (
        !local?.counterpartyJws ||
        local.payload.domainId !== input.domainId ||
        local.payload.sourceSiteId !== input.envelope.sourceSiteId ||
        local.payload.targetSiteId !== input.envelope.targetSiteId ||
        (this.siteId === local.payload.sourceSiteId
          ? local.approvalJws !== input.envelope.sourceJws ||
            local.counterpartyJws !== input.envelope.targetJws ||
            !local.sourceReview
          : local.approvalJws !== input.envelope.targetJws ||
            local.counterpartyJws !== input.envelope.sourceJws)
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation !== "record-usage") {
      const kinds = {
        "register-agreement": "commercial-agreement",
        "reserve-execution": "commercial-reservation",
        "release-execution": "commercial-release",
        "record-execution-terminal": "commercial-terminal",
      } as const;
      for (const [siteId, jws] of [
        [input.envelope.sourceSiteId, input.envelope.sourceJws],
        [input.envelope.targetSiteId, input.envelope.targetJws],
      ].sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""))) {
        if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
        const keyId = federationMessageKeyId(jws);
        if (tx) await this.trust.assertKey(tx, siteId, keyId, new Date());
        const key = await this.trust.resolveKey(siteId, keyId, new Date(), tx);
        const verified = await verifyFederationMessage(
          z.union([
            CommercialAgreementSchema,
            CommercialExecutionApprovalSchema,
            CommercialTerminalSchema,
          ]),
          jws,
          key,
          new Date(),
        );
        if (verified.payload.kind !== kinds[input.operation] || verified.digest !== input.digest)
          throw new FederationError("OPERATION_CONFLICT");
      }
    } else {
      const jws = input.envelope.providerJws;
      const keyId = federationMessageKeyId(jws);
      if (tx) await this.trust.assertKey(tx, this.siteId, keyId, new Date());
      const key = await this.trust.resolveKey(this.siteId, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(CommercialUsageSchema, jws, key, new Date());
      if (verified.digest !== input.digest) throw new FederationError("OPERATION_CONFLICT");
    }
  }
  async status(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.authorize(tx, actor, revisionId);
      const rows = await tx
        .select({
          id: submissions.id,
          state: submissions.state,
          lastError: submissions.lastError,
          createdAt: submissions.createdAt,
          updatedAt: submissions.updatedAt,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`${submissions.input}->>'operation' = 'register-agreement'`,
          ),
        )
        .orderBy(desc(submissions.createdAt), desc(submissions.id))
        .limit(limit)
        .offset(offset);
      const data = [];
      for (const row of rows) {
        const [attempt] = await this.latest(tx, row.id);
        data.push({
          ...row,
          transaction: attempt
            ? {
                transactionId: attempt.transactionId,
                stage: attempt.stage,
                validationCode: attempt.validationCode,
                blockNumber: attempt.blockNumber,
              }
            : null,
        });
      }
      return { enabled: Boolean(this.client), submissions: data };
    });
  }
  async retry(actor: FederationActor, revisionId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.authorize(tx, actor, revisionId);
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, id),
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`(${submissions.leaseToken} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .for("update");
      if (!row || row.state !== "needs_review") throw new FederationError("OPERATION_CONFLICT");
      const [attempt] = await this.latest(tx, id);
      if (attempt?.stage === "proposal")
        await tx
          .update(attempts)
          .set({ stage: "abandoned", updatedAt: sql`clock_timestamp()` })
          .where(eq(attempts.id, attempt.id));
      // Unknown submitted outcomes must resume the original transaction, never abandon it.
      await tx
        .update(submissions)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(submissions.id, id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.commercial.retry",
        target: id,
        diff: { after: { previousError: row.lastError } },
      });
    });
  }
  private async authorize(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select({ id: agreements.revisionId })
      .from(agreements)
      .where(
        and(
          eq(agreements.localSiteId, this.siteId),
          eq(agreements.localOrgId, actor.orgId),
          eq(agreements.revisionId, revisionId),
        ),
      );
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
  }
}
