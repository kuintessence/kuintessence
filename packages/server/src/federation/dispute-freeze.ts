import {
  federationDisputeResolutions,
  federationDisputes,
  type PgTransaction,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import type { CommercialDisputeResolution } from "@kuintessence/shared/federation/dispute-resolution";
import { and, eq, ne, sql } from "drizzle-orm";

/** Acquire after reading immutable originals; opening a case never locks financial rows. */
export async function lockFederationDisputeTask(
  tx: PgTransaction,
  localSiteId: string,
  task: { agreementRevisionId: string; taskId: string; attempt: number },
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`dispute:${localSiteId}:${task.agreementRevisionId}:${task.taskId}:${task.attempt}`}, 0))`,
  );
}

/** Existing signatures must still reconcile; call only before making a new financial commitment. */
export async function assertFederationTaskNotDisputed(
  tx: PgTransaction,
  localSiteId: string,
  task: { agreementRevisionId: string; taskId: string; attempt: number },
  financial?: NonNullable<CommercialDisputeResolution["financial"]>,
) {
  await lockFederationDisputeTask(tx, localSiteId, task);
  const pending = await tx
    .select({ id: federationDisputes.caseId })
    .from(federationDisputes)
    .where(
      and(
        eq(federationDisputes.localSiteId, localSiteId),
        eq(federationDisputes.agreementRevisionId, task.agreementRevisionId),
        eq(federationDisputes.taskId, task.taskId),
        eq(federationDisputes.attempt, task.attempt),
        ne(federationDisputes.state, "RESOLVED"),
      ),
    );
  for (const record of pending) {
    if (!financial) throw new FederationError("DATA_WAITING");
    const [resolution] = await tx
      .select()
      .from(federationDisputeResolutions)
      .where(
        and(
          eq(federationDisputeResolutions.localSiteId, localSiteId),
          eq(federationDisputeResolutions.caseId, record.id),
        ),
      );
    if (
      !resolution?.counterpartyJws ||
      resolution.appliedAt ||
      federationCanonicalJson(resolution.payload.financial) !== federationCanonicalJson(financial)
    )
      throw new FederationError("DATA_WAITING");
  }
}
