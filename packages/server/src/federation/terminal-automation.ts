import {
  federationCommercialExecutionApprovals as approvals,
  federationWorkflowBindings as bindings,
  type PgDb,
  federationTerminalPolicies as policies,
  workflowRuns as runs,
  federationTerminalSyncs as syncs,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { FederationExecutionTerminalService } from "./execution-terminal";
import { FabricClientFailure } from "./fabric-client";

export class FederationTerminalAutomation {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly service: FederationExecutionTerminalService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async advanceNext() {
    const now = this.clock();
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ approval: approvals, policyId: policies.id })
        .from(approvals)
        .innerJoin(
          policies,
          and(
            eq(policies.localSiteId, approvals.localSiteId),
            eq(policies.localOrgId, approvals.localOrgId),
            eq(policies.agreementRevisionId, approvals.agreementRevisionId),
            isNull(policies.revokedAt),
            lte(policies.validFrom, now),
            gt(policies.validUntil, now),
          ),
        )
        .leftJoin(
          terminals,
          and(
            eq(terminals.localSiteId, approvals.localSiteId),
            eq(terminals.reservationId, approvals.recordId),
          ),
        )
        .where(
          and(
            eq(approvals.localSiteId, this.siteId),
            isNotNull(approvals.counterpartyJws),
            sql`${approvals.payload}->>'kind' = 'commercial-reservation'`,
            sql`${approvals.payload}->'request'->>'mode' = 'ledger_coordinated'`,
            eq(approvals.terminalAutoState, "pending"),
            lte(approvals.terminalAutoNextAt, now),
            isNull(terminals.reservationId),
            sql`(( ${approvals.payload}->'request'->>'recipientSiteId' = ${this.siteId}
            AND EXISTS (SELECT 1 FROM ${bindings} JOIN ${runs} ON ${runs.id} = ${bindings.workflowRunId}
              WHERE ${bindings.reservationId} = ${approvals.recordId}
                AND ${runs.status} IN ('completed','failed','cancelled') AND ${runs.completedAt} IS NOT NULL))
            OR (${approvals.payload}->'request'->>'senderSiteId' = ${this.siteId}
              AND EXISTS (SELECT 1 FROM ${syncs} WHERE ${syncs.localSiteId} = ${this.siteId}
                AND ${syncs.reservationId} = ${approvals.recordId} AND ${syncs.state} = 'ready')))`,
          ),
        )
        .orderBy(asc(approvals.terminalAutoNextAt), asc(approvals.recordId))
        .limit(1)
        .for("update", { of: approvals, skipLocked: true });
      if (!row) return null;
      const nextAt = new Date(now.getTime() + 60_000);
      await tx
        .update(approvals)
        .set({ terminalAutoNextAt: nextAt })
        .where(
          and(
            eq(approvals.localSiteId, this.siteId),
            eq(approvals.recordId, row.approval.recordId),
          ),
        );
      return { ...row, nextAt };
    });
    if (!claimed) return false;
    let state = "pending",
      error: string | null = null;
    try {
      // Duplicate attempts are safe: the service serializes the original reservation and signs once.
      await this.service.automate(claimed.policyId, claimed.approval.recordId);
    } catch (cause) {
      error =
        cause instanceof FederationError || cause instanceof FabricClientFailure
          ? cause.code
          : "INTERNAL_ERROR";
      const pgError =
        cause instanceof Error &&
        cause.cause &&
        typeof cause.cause === "object" &&
        "code" in cause.cause
          ? cause.cause.code
          : null;
      const retryable =
        ["55P03", "40001", "40P01"].includes(String(pgError)) ||
        (cause instanceof FederationError && cause.code === "DATA_WAITING") ||
        (cause instanceof FabricClientFailure && !cause.needsReview);
      if (retryable && pgError) error = "DATABASE_BUSY";
      if (!retryable) state = "needs_review";
    }
    await this.db
      .update(approvals)
      .set({ terminalAutoState: state, terminalAutoError: error })
      .where(
        and(
          eq(approvals.localSiteId, this.siteId),
          eq(approvals.recordId, claimed.approval.recordId),
          eq(approvals.terminalAutoNextAt, claimed.nextAt),
          sql`NOT EXISTS (SELECT 1 FROM ${terminals} WHERE ${terminals.localSiteId} = ${this.siteId} AND ${terminals.reservationId} = ${claimed.approval.recordId})`,
        ),
      );
    return true;
  }
}
