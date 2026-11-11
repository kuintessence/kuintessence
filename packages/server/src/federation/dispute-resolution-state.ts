import { randomUUID } from "node:crypto";
import {
  federationCommercialAdjustments as adjustments,
  auditLog,
  federationDisputes as cases,
  type PgTransaction,
  federationDisputeResolutions as resolutions,
  federationCommercialSettlements as settlements,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { CommercialAdapterProposalInputSchema } from "@kuintessence/shared/federation/commercial";
import type { CommercialDisputeResolution } from "@kuintessence/shared/federation/dispute-resolution";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lockFederationDisputeTask } from "./dispute-freeze";

async function enqueueResolution(
  tx: PgTransaction,
  row: typeof resolutions.$inferSelect,
  operation: "authorize-dispute-resolution" | "resolve-dispute" | "record-dispute-resolution",
) {
  if (!row.counterpartyJws) throw new FederationError("DATA_WAITING");
  const source = row.localSiteId === row.payload.sourceSiteId;
  await tx
    .insert(submissions)
    .values({
      id: randomUUID(),
      localSiteId: row.localSiteId,
      agreementRevisionId: row.agreementRevisionId,
      input: CommercialAdapterProposalInputSchema.parse({
        operation,
        domainId: row.payload.domainId,
        recordId: row.resolutionId,
        digest: row.digest,
        envelope: {
          sourceSiteId: row.payload.sourceSiteId,
          targetSiteId: row.payload.targetSiteId,
          sourceJws: source ? row.approvalJws : row.counterpartyJws,
          targetJws: source ? row.counterpartyJws : row.approvalJws,
        },
      }),
    })
    .onConflictDoNothing();
}

/** Caller holds the task lock. Closing this case never releases another case's freeze. */
export async function completeDisputeResolution(
  tx: PgTransaction,
  siteId: string,
  caseId: string,
  ledgerConfirmed = false,
) {
  const key = and(eq(resolutions.localSiteId, siteId), eq(resolutions.caseId, caseId));
  const [row] = await tx.select().from(resolutions).where(key).for("update");
  if (!row || row.appliedAt || !row.counterpartyJws) return;
  const financial = row.payload.financial;
  if (row.payload.mode === "ledger_coordinated" && financial)
    await enqueueResolution(tx, row, "authorize-dispute-resolution");
  if (financial) {
    const table = financial.kind === "commercial-settlement" ? settlements : adjustments;
    const id =
      financial.kind === "commercial-settlement" ? financial.settlementId : financial.adjustmentId;
    const identity =
      financial.kind === "commercial-settlement"
        ? settlements.settlementId
        : adjustments.adjustmentId;
    const [posting] = await tx
      .select()
      .from(table)
      .where(and(eq(table.localSiteId, siteId), eq(identity, id)));
    if (!posting?.appliedAt) {
      if (ledgerConfirmed) throw new FederationError("DATA_WAITING");
      return;
    }
    if (
      posting.localOrgId !== row.localOrgId ||
      posting.agreementRevisionId !== row.agreementRevisionId ||
      posting.arbitrationDecisionId ||
      !posting.counterpartyJws ||
      federationCanonicalJson(posting.payload) !== federationCanonicalJson(financial)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  if (row.payload.mode === "ledger_coordinated") {
    await enqueueResolution(tx, row, "resolve-dispute");
    if (!ledgerConfirmed) return;
    const [confirmed] = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, siteId),
          eq(submissions.state, "committed"),
          sql`${submissions.input}->>'operation' = 'resolve-dispute'`,
          sql`${submissions.input}->>'recordId' = ${row.resolutionId}`,
          sql`${submissions.input}->>'digest' = ${row.digest}`,
        ),
      );
    if (!confirmed) throw new FederationError("DATA_WAITING");
  }
  const [closed] = await tx
    .update(cases)
    .set({ state: "RESOLVED" })
    .where(
      and(
        eq(cases.localSiteId, siteId),
        eq(cases.caseId, caseId),
        eq(cases.localOrgId, row.localOrgId),
        eq(cases.digest, row.payload.caseDigest),
        sql`${cases.state} IN ('DISPUTED','EVIDENCE_WAITING')`,
      ),
    )
    .returning();
  if (!closed) throw new FederationError("OPERATION_CONFLICT");
  await tx.update(resolutions).set({ appliedAt: sql`clock_timestamp()` }).where(key);
  if (row.payload.mode === "bilateral_attested" && row.payload.sourceSiteId === siteId)
    await enqueueResolution(tx, row, "record-dispute-resolution");
  await tx.insert(auditLog).values({
    actor: `dispute-resolution:${siteId}`,
    orgId: row.localOrgId,
    action: "federation.dispute_resolution.apply",
    target: row.resolutionId,
    diff: { after: { caseId, digest: row.digest } },
  });
}

export async function completeFinancialDisputeResolution(
  tx: PgTransaction,
  siteId: string,
  financial: NonNullable<CommercialDisputeResolution["financial"]>,
) {
  const rows = await tx
    .select()
    .from(resolutions)
    .where(
      and(
        eq(resolutions.localSiteId, siteId),
        eq(resolutions.agreementRevisionId, financial.agreementRevisionId),
        isNull(resolutions.appliedAt),
      ),
    );
  for (const row of rows)
    if (federationCanonicalJson(row.payload.financial) === federationCanonicalJson(financial))
      await completeDisputeResolution(tx, siteId, row.caseId);
}

/** The worker calls this only after persisting the original VALID result in its transaction. */
export async function applyCoordinatedDisputeResolution(
  tx: PgTransaction,
  siteId: string,
  resolutionId: string,
  digest: string,
) {
  const [row] = await tx
    .select()
    .from(resolutions)
    .where(and(eq(resolutions.localSiteId, siteId), eq(resolutions.resolutionId, resolutionId)));
  if (!row?.counterpartyJws || row.digest !== digest || row.payload.mode !== "ledger_coordinated")
    throw new FederationError("OPERATION_CONFLICT");
  await lockFederationDisputeTask(tx, siteId, row.payload);
  await completeDisputeResolution(tx, siteId, row.caseId, true);
}

export async function coordinatedDisputeResolutionForFinancial(
  tx: PgTransaction,
  siteId: string,
  financial: NonNullable<CommercialDisputeResolution["financial"]>,
) {
  const rows = await tx
    .select()
    .from(resolutions)
    .where(
      and(
        eq(resolutions.localSiteId, siteId),
        eq(resolutions.agreementRevisionId, financial.agreementRevisionId),
        sql`${resolutions.payload}->>'mode' = 'ledger_coordinated'`,
        sql`${resolutions.payload}->'financial' = ${JSON.stringify(financial)}::jsonb`,
      ),
    )
    .limit(2);
  if (rows.length > 1) throw new FederationError("OPERATION_CONFLICT");
  const row = rows[0];
  if (row && !row.counterpartyJws) throw new FederationError("DATA_WAITING");
  return row;
}
