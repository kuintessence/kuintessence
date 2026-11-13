import { randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  federationMarketAttempts as attempts,
  auditLog,
  type PgDb,
  type PgTransaction,
  federationReservationPolicies as policies,
  federationReservationProposals as proposals,
  federationMarketSubmissions as submissions,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationCommercialExecutionService } from "./commercial-execution";
import { FederationExecutionConfirmationService } from "./execution-confirmation";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationReservationPolicyService } from "./reservation-policy";
import type { FederationSigningKey } from "./signatures";

type Proposal = typeof proposals.$inferSelect;
class ExecutionAutomationLeaseLost extends Error {}

/** Initial execution authority only. Existing operation-specific consumers still renew and enforce VALID proofs. */
export class FederationExecutionAutomation {
  private readonly policies: FederationReservationPolicyService;
  private readonly execution: FederationCommercialExecutionService;
  private readonly confirmations: FederationExecutionConfirmationService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    market?: Pick<MarketClient, "query">,
  ) {
    this.policies = new FederationReservationPolicyService(db, signing.siteId);
    this.execution = new FederationCommercialExecutionService(db, signing, market);
    this.confirmations = new FederationExecutionConfirmationService(db, signing.siteId, market);
  }
  private key(reservationId: string) {
    return and(
      eq(proposals.localSiteId, this.signing.siteId),
      eq(proposals.reservationId, reservationId),
    );
  }
  async discover() {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ proposal: proposals })
        .from(proposals)
        .innerJoin(
          policies,
          and(
            eq(policies.id, proposals.policyId),
            eq(policies.localSiteId, proposals.localSiteId),
            eq(policies.localOrgId, proposals.localOrgId),
            eq(policies.agreementRevisionId, proposals.agreementRevisionId),
            isNull(policies.revokedAt),
            lte(policies.validFrom, new Date()),
            gt(policies.validUntil, new Date()),
            sql`(${policies.allowActivation} OR ${policies.allowExecutionConfirmation})`,
          ),
        )
        .innerJoin(
          approvals,
          and(
            eq(approvals.localSiteId, proposals.localSiteId),
            eq(approvals.recordId, proposals.reservationId),
            eq(approvals.authorizationPolicyId, proposals.policyId),
            isNotNull(approvals.counterpartyJws),
          ),
        )
        .where(
          and(
            eq(proposals.localSiteId, this.signing.siteId),
            eq(proposals.executionState, "idle"),
            sql`${proposals.state} IN ('delivered','approved')`,
            sql`NOT EXISTS (SELECT 1 FROM ${terminals} WHERE ${terminals.localSiteId} = ${proposals.localSiteId} AND ${terminals.reservationId} = ${proposals.reservationId})`,
            sql`NOT EXISTS (SELECT 1 FROM ${approvals} released WHERE released.local_site_id = ${proposals.localSiteId}
              AND released.agreement_revision_id = ${proposals.agreementRevisionId}
              AND released.payload->>'kind' = 'commercial-release'
              AND released.payload->>'reservationId' = ${proposals.reservationId}::text AND released.counterparty_jws IS NOT NULL)`,
          ),
        )
        .orderBy(asc(proposals.createdAt), asc(proposals.reservationId))
        .limit(8)
        .for("update", { of: proposals, skipLocked: true });
      for (const { proposal } of rows) {
        let executionError: string | null = null;
        try {
          await this.scope(tx, proposal);
        } catch (error) {
          if (!(error instanceof FederationError)) throw error;
          if (error.code !== "LEDGER_REQUIRED") executionError = error.code;
        }
        await tx
          .update(proposals)
          .set({
            executionState: executionError ? "needs_review" : "pending",
            executionError,
            executionNextAt: new Date(),
          })
          .where(this.key(proposal.reservationId));
      }
    });
  }
  private async lock(tx: PgTransaction, claim: Proposal) {
    if (!claim.executionLeaseToken) throw new ExecutionAutomationLeaseLost();
    const [row] = await tx
      .select()
      .from(proposals)
      .where(
        and(
          this.key(claim.reservationId),
          eq(proposals.executionState, "pending"),
          eq(proposals.executionLeaseToken, claim.executionLeaseToken),
          sql`${proposals.executionLeaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new ExecutionAutomationLeaseLost();
    if (
      row.policyId !== claim.policyId ||
      row.digest !== claim.digest ||
      row.localOrgId !== claim.localOrgId ||
      !["delivered", "approved"].includes(row.state)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return row;
  }
  private async scope(tx: PgTransaction, row: Proposal) {
    const [policy] = await tx
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.id, row.policyId),
          eq(policies.localSiteId, this.signing.siteId),
          eq(policies.localOrgId, row.localOrgId),
        ),
      );
    if (!policy) throw new FederationError("POLICY_DENIED");
    const operation =
      row.direction === "outbound" && policy.allowActivation ? "activate" : "confirm";
    const current = await this.policies.authorizeOperation(
      tx,
      policy.id,
      row.reservationId,
      operation,
    );
    if (
      current.approval.digest !== row.digest ||
      current.approval.agreementRevisionId !== row.agreementRevisionId
    )
      throw new FederationError("OPERATION_CONFLICT");
    return current.policy;
  }
  private async submitted(
    tx: PgTransaction,
    row: Proposal,
    id: string,
    operation: "activate-demand" | "authorize-execution",
  ) {
    const [record] = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.id, id),
          eq(submissions.localSiteId, this.signing.siteId),
          eq(submissions.localOrgId, row.localOrgId),
          eq(submissions.demandId, row.payload.demandId),
        ),
      );
    if (!record || record.input.operation !== operation)
      throw new FederationError("OPERATION_CONFLICT");
    const gate =
      record.input.operation === "activate-demand"
        ? record.input.activation.gate
        : record.input.operation === "authorize-execution"
          ? record.input.authorization.gate
          : null;
    if (gate?.reservationId !== row.reservationId || gate.reservationDigest !== row.digest)
      throw new FederationError("OPERATION_CONFLICT");
    if (record.state === "needs_review")
      throw new FabricClientFailure(record.lastError ?? "LEDGER_INVALID", true);
    if (record.state !== "committed") return false;
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, id))
      .orderBy(desc(attempts.number))
      .limit(1);
    if (
      attempt?.stage !== "committed" ||
      attempt.validationCode !== 0 ||
      attempt.blockNumber === null
    )
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    return true;
  }
  private async save(claim: Proposal, patch: { activationId?: string; confirmationId?: string }) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      await tx.update(proposals).set(patch).where(this.key(claim.reservationId));
    });
  }
  private async finish(claim: Proposal, confirmation: boolean) {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim);
      await this.scope(tx, row);
      let proofId: string | undefined;
      if (confirmation)
        proofId = (await this.confirmations.authorize(tx, row.localOrgId, row.payload.request))
          .authorizationId;
      else if (
        !row.activationId ||
        !(await this.submitted(tx, row, row.activationId, "activate-demand"))
      )
        throw new FabricClientFailure("LEDGER_PENDING");
      await tx
        .update(proposals)
        .set({
          executionState: "complete",
          executionError: null,
          executionLeaseToken: null,
          executionLeaseUntil: null,
          ...(proofId ? { confirmationId: proofId } : {}),
        })
        .where(this.key(row.reservationId));
      await tx.insert(auditLog).values({
        actor: `reservation-policy:${row.policyId}`,
        orgId: row.localOrgId,
        action: "federation.execution_automation.complete",
        target: row.reservationId,
        diff: {
          after: {
            policyId: row.policyId,
            activationId: row.activationId,
            confirmationId: proofId ?? null,
          },
        },
      });
    });
  }
  private async advance(claim: Proposal) {
    const policy = await this.db.transaction(async (tx) =>
      this.scope(tx, await this.lock(tx, claim)),
    );
    const guard = async (tx: PgTransaction) => {
      await this.lock(tx, claim);
    };
    if (claim.direction === "outbound" && policy.allowActivation) {
      const activation = await this.execution.activatePreauthorized(
        claim.policyId,
        claim.reservationId,
        guard,
      );
      if (claim.activationId && claim.activationId !== activation.id)
        throw new FederationError("OPERATION_CONFLICT");
      await this.save(claim, { activationId: activation.id });
      if (
        !(await this.db.transaction((tx) =>
          this.submitted(tx, claim, activation.id, "activate-demand"),
        ))
      )
        throw new FabricClientFailure("LEDGER_PENDING");
    }
    if (policy.allowExecutionConfirmation) {
      if (claim.confirmationId) {
        const committed = await this.db.transaction((tx) =>
          this.submitted(tx, claim, claim.confirmationId ?? "", "authorize-execution"),
        );
        if (!committed) throw new FabricClientFailure("LEDGER_PENDING");
        try {
          await this.finish(claim, true);
          return;
        } catch (error) {
          if (!(error instanceof FabricClientFailure) || error.code !== "LEDGER_PENDING")
            throw error;
        }
      }
      const confirmation = await this.confirmations.requestPreauthorized(
        claim.policyId,
        claim.reservationId,
        guard,
      );
      await this.save(claim, { confirmationId: confirmation.id });
      if (confirmation.state !== "committed") throw new FabricClientFailure("LEDGER_PENDING");
      await this.finish(claim, true);
    } else await this.finish(claim, false);
  }
  async advanceNext() {
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.localSiteId, this.signing.siteId),
            eq(proposals.executionState, "pending"),
            sql`${proposals.executionNextAt} <= clock_timestamp()`,
            sql`(${proposals.executionLeaseUntil} IS NULL OR ${proposals.executionLeaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(proposals.executionNextAt), asc(proposals.reservationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(proposals)
        .set({
          executionLeaseToken: randomUUID(),
          executionLeaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.reservationId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof ExecutionAutomationLeaseLost || !claim.executionLeaseToken) return true;
      const waiting =
        (error instanceof FederationError && error.code === "LEDGER_REQUIRED") ||
        (error instanceof FabricClientFailure &&
          error.code === "LEDGER_PENDING" &&
          !error.needsReview);
      const review =
        !waiting &&
        (error instanceof FederationError ||
          error instanceof z.ZodError ||
          (error instanceof FabricClientFailure && error.needsReview));
      await this.db
        .update(proposals)
        .set({
          executionState: review ? "needs_review" : "pending",
          executionError: waiting
            ? null
            : error instanceof FederationError || error instanceof FabricClientFailure
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "EXECUTION_AUTOMATION_RETRY",
          executionLeaseToken: null,
          executionLeaseUntil: null,
          executionNextAt: waiting
            ? sql`clock_timestamp() + interval '10 seconds'`
            : sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.reservationId),
            eq(proposals.executionLeaseToken, claim.executionLeaseToken),
            sql`${proposals.executionLeaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [row] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            this.key(reservationId),
            eq(proposals.localOrgId, actor.orgId),
            eq(proposals.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      if (
        row.executionState === "complete" ||
        !["delivered", "approved"].includes(row.state) ||
        (row.executionLeaseUntil && row.executionLeaseUntil > new Date())
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.scope(tx, row);
      await tx
        .update(proposals)
        .set({
          executionState: "pending",
          executionError: null,
          executionLeaseToken: null,
          executionLeaseUntil: null,
          executionNextAt: new Date(),
        })
        .where(this.key(reservationId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.execution_automation.retry",
        target: reservationId,
        diff: { after: { policyId: row.policyId } },
      });
    });
  }
}
