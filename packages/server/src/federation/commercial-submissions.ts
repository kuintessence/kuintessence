import { randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  federationCommercialAgreements as agreements,
  federationCommercialExecutionApprovals as approvals,
  federationCommercialAttempts as attempts,
  auditLog,
  federationCommercialBills as bills,
  federationCommercialDiscounts as discounts,
  federationDisputes as disputes,
  federationDisputeFreezes as freezes,
  federationMarketSubmissions as marketSubmissions,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
  federationCommercialRefunds as refunds,
  federationUsageReports as reports,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialExecutionApprovalSchema,
  CommercialPaymentSchema,
  CommercialReceiptQueryResultSchema,
  CommercialRefundSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
  FabricCommercialAdvanceResultSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  assertDisputeAttestation,
  CommercialDisputeFreezeSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { applyFederationAdjustment } from "./adjustment";
import type { CommercialClient } from "./commercial-client";
import { enqueueExecutionClosure } from "./execution-closure";
import { FabricClientFailure } from "./fabric-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { applyFederationSettlement } from "./settlement";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

import { unreservedExecutionClosed } from "./unreserved-closure";

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
  "record-discount": "discount",
  "confirm-bill": "bill",
  "settle-bill": "settlement",
  "adjust-settlement": "adjustment",
  "record-refund": "refund",
  "record-payment": "payment",
  "record-dispute-freeze": "dispute-freeze",
  "freeze-disputed-task": "native-dispute-freeze",
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
              AND ${submissions.input}->>'operation' IN ('record-execution-terminal','release-execution')
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
            // A signed offer may already be accepted by the peer; preserve bill-before-correction order.
            sql`NOT EXISTS (
              SELECT 1 FROM ${reports} correction JOIN ${bills} bill
                ON bill.local_site_id = ${submissions.localSiteId}
                AND bill.payload->>'reportId' = correction.report->>'correctionOf'
              WHERE correction.id::text = ${submissions.input}->>'recordId'
                AND ${submissions.input}->>'operation' = 'record-usage'
                AND NOT EXISTS (SELECT 1 FROM ${submissions} confirmed
                  WHERE confirmed.local_site_id = bill.local_site_id
                    AND confirmed.input->>'operation' = 'confirm-bill'
                    AND confirmed.input->>'recordId' = bill.bill_id::text AND confirmed.state = 'committed')
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
            sql`(${submissions.input}->>'operation' <> 'record-discount' OR EXISTS (
              SELECT 1 FROM ${discounts} discount
              JOIN ${submissions} usage ON usage.local_site_id = discount.local_site_id
                AND usage.input->>'operation' = 'record-usage'
                AND usage.input->>'recordId' = discount.payload->>'reportId' AND usage.state = 'committed'
              WHERE discount.local_site_id = ${submissions.localSiteId}
                AND discount.discount_id::text = ${submissions.input}->>'recordId'
            ))`,
            sql`(${submissions.input}->>'operation' <> 'confirm-bill' OR EXISTS (
              SELECT 1 FROM ${bills} bill
              JOIN ${submissions} usage ON usage.local_site_id = bill.local_site_id
                AND usage.input->>'operation' = 'record-usage'
                AND usage.input->>'recordId' = bill.payload->>'reportId' AND usage.state = 'committed'
              WHERE bill.local_site_id = ${submissions.localSiteId}
                AND bill.bill_id::text = ${submissions.input}->>'recordId' AND bill.counterparty_jws IS NOT NULL
                AND (bill.payload->>'discount' IS NULL OR EXISTS (
                  SELECT 1 FROM ${submissions} discount WHERE discount.local_site_id = bill.local_site_id
                    AND discount.input->>'operation' = 'record-discount'
                    AND discount.input->>'recordId' = bill.payload->'discount'->>'discountId' AND discount.state = 'committed'))
                AND (bill.payload->>'reservationId' IS NULL OR EXISTS (
                  SELECT 1 FROM ${terminals} terminal
                  WHERE terminal.local_site_id = bill.local_site_id
                    AND terminal.reservation_id::text = bill.payload->>'reservationId'
                    AND terminal.counterparty_jws IS NOT NULL))
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
          !["record-execution-terminal", "release-execution"].includes(
            submission.input.operation,
          ) ||
          attempt?.stage !== "committed"
        )
          throw new FederationError("OPERATION_CONFLICT");
        await this.fenced(claimed, async (tx) => {
          await tx
            .update(submissions)
            .set({ state: "committed", lastError: null })
            .where(eq(submissions.id, submission.id));
          await enqueueExecutionClosure(
            tx,
            this.siteId,
            submission.input.recordId,
            submission.input.operation === "release-execution" ? "release" : "terminal",
          );
        });
      } else if (!attempt || attempt.stage === "invalid" || attempt.stage === "abandoned") {
        await this.beforeDisclosure(submission.input);
        if (await this.requireBillTerminal(submission.input))
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
          if (["reserve-execution", "release-execution"].includes(current.input.operation))
            await this.beforeDisclosure(current.input, tx);
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
              submission.input.operation === "adjust-settlement"
            ) {
              const [row] = await tx
                .select()
                .from(adjustments)
                .where(
                  and(
                    eq(adjustments.localSiteId, this.siteId),
                    eq(adjustments.adjustmentId, submission.input.recordId),
                  ),
                );
              if (!row || row.digest !== submission.input.digest)
                throw new FederationError("OPERATION_CONFLICT");
              await applyFederationAdjustment(tx, row);
            }
            if (result.state === "committed" && submission.input.operation === "settle-bill") {
              const [settlement] = await tx
                .select()
                .from(settlements)
                .where(
                  and(
                    eq(settlements.localSiteId, this.siteId),
                    eq(settlements.settlementId, submission.input.recordId),
                  ),
                )
                .for("update");
              if (!settlement || settlement.digest !== submission.input.digest)
                throw new FederationError("OPERATION_CONFLICT");
              const [bill] = await tx
                .select()
                .from(bills)
                .where(
                  and(eq(bills.localSiteId, this.siteId), eq(bills.billId, settlement.billId)),
                );
              if (!bill) throw new FederationError("ASSET_UNAVAILABLE");
              await applyFederationSettlement(tx, settlement, bill);
            }
            if (
              result.state === "committed" &&
              (submission.input.operation === "record-execution-terminal" ||
                (submission.input.operation === "release-execution" &&
                  submission.input.envelope.sourceSiteId === this.siteId))
            )
              await enqueueExecutionClosure(
                tx,
                this.siteId,
                submission.input.recordId,
                submission.input.operation === "release-execution" ? "release" : "terminal",
              );
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

  /** The source commits terminal evidence; the provider must query that original private receipt. */
  private async requireBillTerminal(input: CommercialAdapterProposalInput) {
    if (input.operation === "adjust-settlement") {
      const [row] = await this.db
        .select()
        .from(adjustments)
        .where(
          and(
            eq(adjustments.localSiteId, this.siteId),
            eq(adjustments.adjustmentId, input.recordId),
          ),
        );
      if (!row?.counterpartyJws) throw new FederationError("POLICY_DENIED");
      if (!this.client?.receipt)
        throw new FabricClientFailure("ADJUSTMENT_RECEIPT_UNAVAILABLE", true);
      const references = [
        {
          recordType: "settlement" as const,
          recordId: row.settlementId,
          digest: row.payload.settlementDigest,
        },
      ];
      for (const ref of [
        ...references,
        ...(row.payload.previous
          ? [
              {
                recordType: "adjustment" as const,
                recordId: row.payload.previous.adjustmentId,
                digest: row.payload.previous.digest,
              },
            ]
          : []),
      ]) {
        const { receipt } = CommercialReceiptQueryResultSchema.parse(
          await this.client.receipt({
            operation: "get-commercial-receipt",
            domainId: input.domainId,
            recordType: ref.recordType,
            recordId: ref.recordId,
          }),
        );
        if (!receipt) throw new FabricClientFailure("LEDGER_PENDING", false);
        if (receipt.recordId !== ref.recordId || receipt.digest !== ref.digest)
          throw new FederationError("OPERATION_CONFLICT");
      }
      return true;
    }
    if (input.operation === "record-payment") {
      const [row] = await this.db
        .select()
        .from(payments)
        .where(and(eq(payments.localSiteId, this.siteId), eq(payments.receiptId, input.recordId)));
      if (!row?.counterpartyJws || !row.confirmedAt) throw new FederationError("POLICY_DENIED");
      if (!this.client?.receipt) throw new FabricClientFailure("PAYMENT_RECEIPT_UNAVAILABLE", true);
      const references = [
        { recordType: "bill" as const, recordId: row.billId, digest: row.payload.billDigest },
        ...(row.payload.previous
          ? [
              {
                recordType: "payment" as const,
                recordId: row.payload.previous.receiptId,
                digest: row.payload.previous.digest,
              },
            ]
          : []),
      ];
      for (const ref of references) {
        const { receipt } = CommercialReceiptQueryResultSchema.parse(
          await this.client.receipt({
            operation: "get-commercial-receipt",
            domainId: input.domainId,
            recordType: ref.recordType,
            recordId: ref.recordId,
          }),
        );
        if (!receipt) throw new FabricClientFailure("LEDGER_PENDING", false);
        if (receipt.recordId !== ref.recordId || receipt.digest !== ref.digest)
          throw new FederationError("OPERATION_CONFLICT");
      }
      return true;
    }
    if (input.operation === "settle-bill") {
      const [row] = await this.db
        .select()
        .from(settlements)
        .where(
          and(
            eq(settlements.localSiteId, this.siteId),
            eq(settlements.settlementId, input.recordId),
          ),
        );
      if (!row?.counterpartyJws) throw new FederationError("POLICY_DENIED");
      if (!this.client?.receipt) throw new FabricClientFailure("BILL_RECEIPT_UNAVAILABLE", true);
      const { receipt } = CommercialReceiptQueryResultSchema.parse(
        await this.client.receipt({
          operation: "get-commercial-receipt",
          domainId: input.domainId,
          recordType: "bill",
          recordId: row.billId,
        }),
      );
      if (!receipt) throw new FabricClientFailure("LEDGER_PENDING", false);
      if (receipt.recordId !== row.billId || receipt.digest !== row.payload.billDigest)
        throw new FederationError("OPERATION_CONFLICT");
      return true;
    }
    if (input.operation !== "confirm-bill") return;
    const [bill] = await this.db
      .select()
      .from(bills)
      .where(and(eq(bills.localSiteId, this.siteId), eq(bills.billId, input.recordId)));
    if (!bill) throw new FederationError("ASSET_UNAVAILABLE");
    if (!bill.payload.reservationId) return;
    const [terminal] = await this.db
      .select()
      .from(terminals)
      .where(
        and(
          eq(terminals.localSiteId, this.siteId),
          eq(terminals.reservationId, bill.payload.reservationId),
        ),
      );
    if (!terminal?.counterpartyJws || terminal.payload.domainId !== input.domainId)
      throw new FederationError("OPERATION_CONFLICT");
    if (!this.client?.receipt) throw new FabricClientFailure("TERMINAL_RECEIPT_UNAVAILABLE", true);
    const { receipt } = CommercialReceiptQueryResultSchema.parse(
      await this.client.receipt({
        operation: "get-commercial-receipt",
        domainId: input.domainId,
        recordType: "terminal",
        recordId: terminal.terminalId,
      }),
    );
    if (!receipt) throw new FabricClientFailure("LEDGER_PENDING", false);
    if (receipt.recordId !== terminal.terminalId || receipt.digest !== terminal.digest)
      throw new FederationError("OPERATION_CONFLICT");
    return true;
  }

  private async beforeDisclosure(raw: CommercialAdapterProposalInput, tx?: PgTransaction) {
    const input = CommercialAdapterProposalInputSchema.parse(raw);
    if (input.operation === "adjust-settlement") {
      const [row] = await (tx ?? this.db)
        .select()
        .from(adjustments)
        .where(
          and(
            eq(adjustments.localSiteId, this.siteId),
            eq(adjustments.adjustmentId, input.recordId),
          ),
        );
      if (
        !row?.counterpartyJws ||
        row.digest !== input.digest ||
        row.payload.domainId !== input.domainId ||
        row.payload.sourceSiteId !== input.envelope.sourceSiteId ||
        row.payload.targetSiteId !== input.envelope.targetSiteId ||
        (this.siteId === row.payload.sourceSiteId
          ? row.approvalJws !== input.envelope.sourceJws ||
            row.counterpartyJws !== input.envelope.targetJws
          : row.approvalJws !== input.envelope.targetJws ||
            row.counterpartyJws !== input.envelope.sourceJws)
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation === "record-dispute-freeze" || input.operation === "freeze-disputed-task") {
      const native = input.operation === "freeze-disputed-task";
      const [row] = await (tx ?? this.db)
        .select({ proof: freezes, record: disputes, contract: agreements })
        .from(freezes)
        .innerJoin(
          disputes,
          and(eq(disputes.localSiteId, freezes.localSiteId), eq(disputes.caseId, freezes.caseId)),
        )
        .innerJoin(
          agreements,
          and(
            eq(agreements.localSiteId, disputes.localSiteId),
            eq(agreements.revisionId, disputes.agreementRevisionId),
          ),
        )
        .where(and(eq(freezes.localSiteId, this.siteId), eq(freezes.caseId, input.recordId)));
      if (
        !row ||
        !(native ? ["ledger_pending", "confirmed"] : ["confirmed"]).includes(row.proof.state) ||
        !row.proof.counterpartyJws ||
        !row.proof.payload ||
        row.proof.digest !== input.digest ||
        row.record.payload.openingSiteId !== this.siteId ||
        row.record.localOrgId !== row.contract.localOrgId ||
        !row.contract.counterpartyJws ||
        row.contract.terms.agreement.mode !==
          (native ? "ledger_coordinated" : "bilateral_attested") ||
        row.record.payload.agreementDigest !== row.contract.digest ||
        row.record.openingJws !== input.envelope.openingJws ||
        input.envelope.openingSiteId !== this.siteId ||
        row.record.payload.sourceSiteId !== input.envelope.sourceSiteId ||
        row.record.payload.targetSiteId !== input.envelope.targetSiteId ||
        (this.siteId === input.envelope.sourceSiteId
          ? row.proof.approvalJws !== input.envelope.sourceJws ||
            row.proof.counterpartyJws !== input.envelope.targetJws
          : row.proof.approvalJws !== input.envelope.targetJws ||
            row.proof.counterpartyJws !== input.envelope.sourceJws)
      )
        throw new FederationError("POLICY_DENIED");
      const kid = federationMessageKeyId(input.envelope.openingJws);
      if (tx) await this.trust.assertKey(tx, this.siteId, kid, new Date());
      const opening = await verifyFederationMessage(
        CommercialDisputeSchema,
        input.envelope.openingJws,
        await this.trust.resolveKey(this.siteId, kid, new Date(), tx),
        new Date(),
      );
      assertDisputeAttestation(
        row.proof.payload,
        opening,
        input.domainId,
        input.recordId,
        new Date(),
        native ? "ledger_coordinated" : "bilateral_attested",
      );
    }
    if (input.operation === "record-payment") {
      const [row] = await (tx ?? this.db)
        .select()
        .from(payments)
        .where(and(eq(payments.localSiteId, this.siteId), eq(payments.receiptId, input.recordId)));
      if (
        !row?.counterpartyJws ||
        !row.confirmedAt ||
        row.digest !== input.digest ||
        row.payload.domainId !== input.domainId ||
        row.payload.targetSiteId !== this.siteId ||
        row.payload.sourceSiteId !== input.envelope.sourceSiteId ||
        input.envelope.targetSiteId !== this.siteId ||
        row.approvalJws !== input.envelope.targetJws ||
        row.counterpartyJws !== input.envelope.sourceJws
      )
        throw new FederationError("POLICY_DENIED");
      const [contract] = await (tx ?? this.db)
        .select()
        .from(agreements)
        .where(
          and(
            eq(agreements.localSiteId, this.siteId),
            eq(agreements.revisionId, row.agreementRevisionId),
            eq(agreements.localOrgId, row.localOrgId),
          ),
        );
      if (
        !contract?.counterpartyJws ||
        contract.terms.agreement.mode === "bilateral_direct" ||
        contract.digest !== row.payload.agreementDigest
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation === "record-refund") {
      const [row] = await (tx ?? this.db)
        .select()
        .from(refunds)
        .where(and(eq(refunds.localSiteId, this.siteId), eq(refunds.refundId, input.recordId)));
      if (
        !row?.counterpartyJws ||
        !row.appliedAt ||
        row.payload.request.mode !== "bilateral_attested" ||
        row.payload.request.recipientSiteId !== this.siteId ||
        row.digest !== input.digest ||
        row.payload.domainId !== input.domainId ||
        row.payload.request.senderSiteId !== input.envelope.sourceSiteId ||
        row.payload.request.recipientSiteId !== input.envelope.targetSiteId ||
        (this.siteId === row.payload.request.senderSiteId
          ? row.approvalJws !== input.envelope.sourceJws ||
            row.counterpartyJws !== input.envelope.targetJws
          : row.approvalJws !== input.envelope.targetJws ||
            row.counterpartyJws !== input.envelope.sourceJws)
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation === "settle-bill") {
      const [row] = await (tx ?? this.db)
        .select()
        .from(settlements)
        .where(
          and(
            eq(settlements.localSiteId, this.siteId),
            eq(settlements.settlementId, input.recordId),
          ),
        );
      if (
        !row?.counterpartyJws ||
        row.digest !== input.digest ||
        row.payload.domainId !== input.domainId ||
        row.payload.sourceSiteId !== input.envelope.sourceSiteId ||
        row.payload.targetSiteId !== input.envelope.targetSiteId ||
        (this.siteId === row.payload.sourceSiteId
          ? row.approvalJws !== input.envelope.sourceJws ||
            row.counterpartyJws !== input.envelope.targetJws
          : row.approvalJws !== input.envelope.targetJws ||
            row.counterpartyJws !== input.envelope.sourceJws)
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation === "confirm-bill") {
      const [bill] = await (tx ?? this.db)
        .select()
        .from(bills)
        .where(and(eq(bills.localSiteId, this.siteId), eq(bills.billId, input.recordId)));
      if (
        !bill?.counterpartyJws ||
        bill.digest !== input.digest ||
        bill.payload.domainId !== input.domainId ||
        bill.payload.request.recipientSiteId !== this.siteId ||
        bill.approvalJws !== input.envelope.targetJws ||
        bill.counterpartyJws !== input.envelope.sourceJws ||
        bill.payload.request.senderSiteId !== input.envelope.sourceSiteId ||
        input.envelope.targetSiteId !== this.siteId
      )
        throw new FederationError("POLICY_DENIED");
    }
    if (input.operation === "record-discount") {
      const [discount] = await (tx ?? this.db)
        .select()
        .from(discounts)
        .where(
          and(eq(discounts.localSiteId, this.siteId), eq(discounts.discountId, input.recordId)),
        );
      if (
        !discount ||
        discount.digest !== input.digest ||
        discount.payload.domainId !== input.domainId ||
        discount.payload.targetSiteId !== this.siteId ||
        discount.providerJws !== input.envelope.providerJws
      )
        throw new FederationError("POLICY_DENIED");
    }
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
    if (input.operation !== "record-usage" && input.operation !== "record-discount") {
      const kinds = {
        "register-agreement": "commercial-agreement",
        "reserve-execution": "commercial-reservation",
        "release-execution": "commercial-release",
        "record-execution-terminal": "commercial-terminal",
        "confirm-bill": "commercial-bill",
        "settle-bill": "commercial-settlement",
        "adjust-settlement": "commercial-adjustment",
        "record-refund": "commercial-refund",
        "record-payment": "commercial-payment",
        "record-dispute-freeze": "commercial-dispute-freeze",
        "freeze-disputed-task": "commercial-dispute-freeze",
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
            CommercialBillSchema,
            CommercialSettlementSchema,
            CommercialRefundSchema,
            CommercialPaymentSchema,
            CommercialDisputeFreezeSchema,
            CommercialAdjustmentSchema,
          ]),
          jws,
          key,
          new Date(),
        );
        if (verified.payload.kind !== kinds[input.operation] || verified.digest !== input.digest)
          throw new FederationError("OPERATION_CONFLICT");
        if (["commercial-reservation", "commercial-release"].includes(verified.payload.kind)) {
          const payload = CommercialExecutionApprovalSchema.parse(verified.payload);
          const closed = tx
            ? await unreservedExecutionClosed(tx, this.siteId, payload)
            : await this.db.transaction((scope) =>
                unreservedExecutionClosed(scope, this.siteId, payload),
              );
          if (closed) throw new FederationError("CANCELLATION_REQUESTED");
        }
      }
    } else {
      const jws = input.envelope.providerJws;
      const keyId = federationMessageKeyId(jws);
      if (tx) await this.trust.assertKey(tx, this.siteId, keyId, new Date());
      const key = await this.trust.resolveKey(this.siteId, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(
        z.union([CommercialUsageSchema, CommercialDiscountSchema]),
        jws,
        key,
        new Date(),
      );
      if (
        verified.digest !== input.digest ||
        verified.payload.kind !==
          (input.operation === "record-usage" ? "commercial-usage" : "commercial-discount")
      )
        throw new FederationError("OPERATION_CONFLICT");
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
      await requireFederationCapability(tx, actor, "agreement.read");
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
      await requireFederationCapability(
        tx,
        actor,
        row.input.operation === "record-dispute-freeze" ||
          row.input.operation === "freeze-disputed-task"
          ? "dispute.open"
          : row.input.operation === "record-payment"
            ? "payment.approve"
            : row.input.operation === "adjust-settlement"
              ? "adjustment.approve"
              : row.input.operation === "settle-bill" || row.input.operation === "record-refund"
                ? "settlement.approve"
                : ["confirm-bill", "record-discount"].includes(row.input.operation)
                  ? "billing.approve"
                  : "agreement.approve",
      );
      const [attempt] = await this.latest(tx, id);
      if (
        ["reserve-execution", "release-execution"].includes(row.input.operation) &&
        attempt?.stage !== "transaction"
      )
        await this.beforeDisclosure(row.input, tx);
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
