import { randomUUID } from "node:crypto";
import {
  federationCaseAttempts as attempts,
  auditLog,
  federationCaseArbitrationDecisions as decisions,
  type PgDb,
  type PgTransaction,
  federationCasePublications as publications,
  federationCaseSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  CaseProposalSchema,
  CaseReceiptResultSchema,
  caseOperationRecordType,
} from "@kuintessence/shared/federation/case-ledger";
import { FabricCommercialAdvanceResultSchema } from "@kuintessence/shared/federation/commercial";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { FederationCaseArbitrationDecisionService } from "./case-arbitration-decisions";
import type { CaseClient } from "./case-client";
import type { FederationCasePublicationService } from "./case-publications";
import { FabricClientFailure } from "./fabric-client";
import { type FederationActor, requireFederationCapability } from "./permissions";

type Submission = typeof submissions.$inferSelect;
type Lease = { id: string; token: string };
class LeaseLost extends Error {}

/** Publication and withdrawal recover independently; neither gates bilateral computation. */
export class FederationCaseSubmissionService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly cases: FederationCasePublicationService,
    private readonly client?: CaseClient,
    private readonly arbitration?: FederationCaseArbitrationDecisionService,
  ) {}

  async discover() {
    if (!this.client) return;
    for (const operation of ["revoke-case-publication", "record-case-evidence"] as const) {
      await this.db.transaction(async (tx) => {
        const rows = await tx
          .select({
            localSiteId: publications.localSiteId,
            publicationId: publications.publicationId,
          })
          .from(publications)
          .leftJoin(
            submissions,
            and(
              eq(submissions.localSiteId, publications.localSiteId),
              eq(submissions.publicationId, publications.publicationId),
              eq(submissions.operation, operation),
            ),
          )
          .where(
            and(
              eq(publications.localSiteId, this.siteId),
              isNull(submissions.id),
              operation === "revoke-case-publication"
                ? sql`${publications.revocationJws} IS NOT NULL`
                : sql`${publications.counterpartyJws} IS NOT NULL AND ${publications.revokedAt} IS NULL`,
            ),
          )
          .orderBy(asc(publications.createdAt), asc(publications.publicationId))
          .limit(8)
          .for("update", { of: publications, skipLocked: true });
        if (rows.length)
          await tx
            .insert(submissions)
            .values(rows.map((row) => ({ ...row, operation })))
            .onConflictDoNothing();
      });
    }
    if (this.arbitration)
      await this.db.transaction(async (tx) => {
        const rows = await tx
          .select({
            localSiteId: decisions.localSiteId,
            arbitrationDecisionId: decisions.decisionId,
          })
          .from(decisions)
          .leftJoin(
            submissions,
            and(
              eq(submissions.localSiteId, decisions.localSiteId),
              eq(submissions.arbitrationDecisionId, decisions.decisionId),
            ),
          )
          .where(and(eq(decisions.localSiteId, this.siteId), isNull(submissions.id)))
          .orderBy(asc(decisions.approvedAt), asc(decisions.decisionId))
          .limit(8)
          .for("update", { of: decisions, skipLocked: true });
        if (rows.length)
          await tx
            .insert(submissions)
            .values(
              rows.map((row) => ({ ...row, operation: "record-arbitration-decision" as const })),
            )
            .onConflictDoNothing();
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
  private async claim(): Promise<Lease | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.state, "pending"),
            sql`${submissions.nextAttemptAt} <= clock_timestamp()`,
            sql`(${submissions.leaseUntil} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${submissions.operation} = 'revoke-case-publication' THEN 0 ELSE 1 END`,
          asc(submissions.createdAt),
          asc(submissions.id),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      const token = randomUUID();
      await tx
        .update(submissions)
        .set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
        .where(eq(submissions.id, row.id));
      return { id: row.id, token };
    });
  }
  private fenced<T>(lease: Lease, operation: (tx: PgTransaction, row: Submission) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, lease.id),
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.state, "pending"),
            eq(submissions.leaseToken, lease.token),
            sql`${submissions.leaseUntil} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!row) throw new LeaseLost();
      const result = await operation(tx, row);
      const [current] = await tx
        .select({ valid: sql<boolean>`${submissions.leaseUntil} > clock_timestamp()` })
        .from(submissions)
        .where(eq(submissions.id, row.id));
      if (!current?.valid) throw new LeaseLost();
      return result;
    });
  }
  private async original(tx: PgTransaction, row: Submission) {
    const input =
      row.operation === "record-arbitration-decision"
        ? this.arbitration &&
          row.arbitrationDecisionId &&
          (await this.arbitration.ledgerProposal(tx, row.arbitrationDecisionId))
        : row.publicationId &&
          (await this.cases.ledgerProposal(tx, row.publicationId, row.operation));
    if (!input) throw new FederationError("POLICY_DENIED");
    if (row.input && federationCanonicalJson(input) !== federationCanonicalJson(row.input))
      throw new FederationError("OPERATION_CONFLICT");
    return input;
  }
  private schedule(tx: PgTransaction, id: string, lastError: string | null = null) {
    return tx
      .update(submissions)
      .set({
        lastError,
        nextAttemptAt: lastError
          ? sql`clock_timestamp() + interval '30 seconds'`
          : sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(submissions.id, id));
  }
  async advanceNext(): Promise<boolean> {
    if (!this.client) return false;
    const lease = await this.claim();
    if (!lease) return false;
    try {
      const snapshot = await this.fenced(lease, async (tx, row) => {
        const attempt = (await this.latest(tx, row.id))[0];
        // An authorized dispatch can already have reached the orderer; always resolve that exact transaction.
        if (
          (attempt?.dispatchAuthorizedAt && attempt.stage === "transaction") ||
          attempt?.stage === "committed"
        ) {
          if (!row.input) throw new FederationError("OPERATION_CONFLICT");
          return { row, input: CaseProposalSchema.parse(row.input), attempt };
        }
        const input = await this.original(tx, row);
        if (!row.input)
          await tx.update(submissions).set({ input }).where(eq(submissions.id, row.id));
        if (attempt?.stage === "transaction") {
          await tx
            .update(attempts)
            .set({ dispatchAuthorizedAt: sql`clock_timestamp()` })
            .where(eq(attempts.id, attempt.id));
        }
        return { row, input, attempt };
      });
      const { row, input, attempt } = snapshot;
      if (attempt?.stage === "committed") {
        const result = CaseReceiptResultSchema.parse(
          await this.client.receipt({
            domainId: input.domainId,
            recordId: input.recordId,
            recordType: caseOperationRecordType[input.operation],
          }),
        );
        if (!result.receipt) {
          await this.fenced(lease, (tx) => this.schedule(tx, row.id, "LEDGER_RECEIPT_PENDING"));
        } else {
          const receipt = result.receipt;
          if (receipt.recordId !== input.recordId || receipt.digest !== input.digest)
            throw new FabricClientFailure("INVALID_LEDGER_RESPONSE", true);
          await this.fenced(lease, async (tx) => {
            await tx
              .update(submissions)
              .set({
                state: "committed",
                receipt,
                lastError: null,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(submissions.id, row.id));
            const table =
              row.operation === "record-arbitration-decision" ? decisions : publications;
            const ownerId = row.arbitrationDecisionId ?? row.publicationId;
            if (!ownerId) throw new FederationError("OPERATION_CONFLICT");
            const [owner] = await tx
              .select({ orgId: table.localOrgId })
              .from(table)
              .where(
                and(
                  eq(table.localSiteId, this.siteId),
                  eq(
                    row.operation === "record-arbitration-decision"
                      ? decisions.decisionId
                      : publications.publicationId,
                    ownerId,
                  ),
                ),
              );
            if (!owner) throw new FederationError("OPERATION_CONFLICT");
            await tx.insert(auditLog).values({
              actor: `case-ledger:${this.siteId}`,
              orgId: owner.orgId,
              action: "federation.case_ledger.confirm",
              target: ownerId,
              diff: {
                after: {
                  submissionId: row.id,
                  operation: row.operation,
                  transactionId: attempt.transactionId,
                  digest: receipt.digest,
                },
              },
            });
          });
        }
      } else if (!attempt || attempt.stage === "invalid" || attempt.stage === "abandoned") {
        const result = FabricProposalCheckpointSchema.parse(await this.client.prepare(input));
        await this.fenced(lease, async (tx, current) => {
          await this.original(tx, current);
          await tx.insert(attempts).values({
            submissionId: row.id,
            number: (attempt?.number ?? 0) + 1,
            transactionId: result.transactionId,
            recovery: result.recovery,
          });
          await this.schedule(tx, row.id);
        });
      } else {
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
        await this.fenced(lease, async (tx) => {
          if (result.state === "prepared") {
            await tx
              .update(attempts)
              .set({
                stage: "transaction",
                recovery: result.recovery,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, row.id);
          } else if (result.state === "pending") await this.schedule(tx, row.id, "LEDGER_PENDING");
          else {
            await tx
              .update(attempts)
              .set({
                stage: result.state,
                validationCode: result.state === "committed" ? 0 : result.validationCode,
                blockNumber: result.blockNumber,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, row.id, result.state === "invalid" ? "LEDGER_INVALID" : null);
            if (result.state === "invalid")
              await tx
                .update(submissions)
                .set({ state: "needs_review" })
                .where(eq(submissions.id, row.id));
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
                : new FabricClientFailure("CASE_LEDGER_RETRY");
        try {
          await this.fenced(lease, async (tx, row) => {
            const attempt = (await this.latest(tx, row.id))[0];
            const closed =
              failure.code === "AUTHORIZATION_EXPIRED" &&
              row.operation === "record-case-evidence" &&
              !attempt?.dispatchAuthorizedAt;
            if (closed && attempt && ["proposal", "transaction"].includes(attempt.stage))
              await tx
                .update(attempts)
                .set({ stage: "abandoned", updatedAt: sql`clock_timestamp()` })
                .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, row.id, failure.code);
            if (closed || failure.needsReview)
              await tx
                .update(submissions)
                .set({ state: closed ? "closed" : "needs_review" })
                .where(eq(submissions.id, row.id));
          });
        } catch (saveError) {
          if (!(saveError instanceof LeaseLost)) throw saveError;
        }
      }
    } finally {
      await this.db
        .update(submissions)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(submissions.id, lease.id), eq(submissions.leaseToken, lease.token)));
    }
    return true;
  }
  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const rows = await tx
        .select({
          id: submissions.id,
          publicationId: submissions.publicationId,
          operation: submissions.operation,
          state: submissions.state,
          lastError: submissions.lastError,
          receipt: submissions.receipt,
          nextAttemptAt: submissions.nextAttemptAt,
          updatedAt: submissions.updatedAt,
        })
        .from(submissions)
        .innerJoin(
          publications,
          and(
            eq(publications.localSiteId, submissions.localSiteId),
            eq(publications.publicationId, submissions.publicationId),
          ),
        )
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(publications.localOrgId, actor.orgId),
            eq(publications.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(submissions.createdAt), desc(submissions.id))
        .limit(limit + 1)
        .offset(offset);
      return { enabled: !!this.client, data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
  async arbitrationStatus(actor: FederationActor, caseId: string) {
    if (!this.arbitration) throw new FederationError("ASSET_UNAVAILABLE");
    const arbitration = this.arbitration;
    return this.db.transaction(async (tx) => {
      const decision = await arbitration.visible(tx, actor, caseId);
      const [row] = await tx
        .select({
          id: submissions.id,
          state: submissions.state,
          lastError: submissions.lastError,
          receipt: submissions.receipt,
          nextAttemptAt: submissions.nextAttemptAt,
          updatedAt: submissions.updatedAt,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.arbitrationDecisionId, decision.decisionId),
          ),
        );
      return { enabled: !!this.client, data: row ?? null };
    });
  }
  async retryArbitration(actor: FederationActor, caseId: string) {
    if (!this.arbitration || !this.client) throw new FederationError("ASSET_UNAVAILABLE");
    const arbitration = this.arbitration;
    await this.db.transaction(async (tx) => {
      const decision = await arbitration.visible(tx, actor, caseId, true);
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.arbitrationDecisionId, decision.decisionId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      await this.retryRow(tx, row);
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.case_ledger.retry",
        target: decision.decisionId,
        diff: { after: { submissionId: row.id } },
      });
    });
  }
  private async retryRow(tx: PgTransaction, row: Submission) {
    const id = row.id;
    const [available] = await tx
      .select({
        valid: sql<boolean>`(${submissions.leaseUntil} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
      })
      .from(submissions)
      .where(eq(submissions.id, id));
    if (!available?.valid || ["closed", "committed"].includes(row.state))
      throw new FederationError("OPERATION_CONFLICT");
    const attempt = (await this.latest(tx, id))[0];
    if (!attempt?.dispatchAuthorizedAt || ["invalid", "abandoned"].includes(attempt.stage))
      await this.original(tx, row);
    await tx
      .update(submissions)
      .set({
        state: "pending",
        lastError: null,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: sql`clock_timestamp()`,
      })
      .where(eq(submissions.id, id));
  }
  async retry(actor: FederationActor, revisionId: string, publicationId: string, id: string) {
    if (!this.client) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const [row] = await tx
        .select({ submission: submissions })
        .from(submissions)
        .innerJoin(
          publications,
          and(
            eq(publications.localSiteId, submissions.localSiteId),
            eq(publications.publicationId, submissions.publicationId),
          ),
        )
        .where(
          and(
            eq(submissions.id, id),
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.publicationId, publicationId),
            eq(publications.localOrgId, actor.orgId),
            eq(publications.agreementRevisionId, revisionId),
          ),
        )
        .for("update", { of: submissions });
      if (!row) throw new FederationError("POLICY_DENIED");
      await this.retryRow(tx, row.submission);
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.case_ledger.retry",
        target: publicationId,
        diff: { after: { submissionId: id } },
      });
    });
  }
}
