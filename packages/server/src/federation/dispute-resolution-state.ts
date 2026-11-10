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

/** Caller holds the task lock. Closing this case never releases another case's freeze. */
export async function completeDisputeResolution(tx: PgTransaction, siteId: string, caseId: string) {
  const key = and(eq(resolutions.localSiteId, siteId), eq(resolutions.caseId, caseId));
  const [row] = await tx.select().from(resolutions).where(key).for("update");
  if (!row || row.appliedAt || !row.counterpartyJws) return;
  const financial = row.payload.financial;
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
    if (!posting?.appliedAt) return;
    if (
      posting.localOrgId !== row.localOrgId ||
      posting.agreementRevisionId !== row.agreementRevisionId ||
      posting.arbitrationDecisionId ||
      !posting.counterpartyJws ||
      federationCanonicalJson(posting.payload) !== federationCanonicalJson(financial)
    )
      throw new FederationError("OPERATION_CONFLICT");
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
    await tx.insert(submissions).values({
      id: randomUUID(),
      localSiteId: siteId,
      agreementRevisionId: row.agreementRevisionId,
      input: CommercialAdapterProposalInputSchema.parse({
        operation: "record-dispute-resolution",
        domainId: row.payload.domainId,
        recordId: row.resolutionId,
        digest: row.digest,
        envelope: {
          sourceSiteId: row.payload.sourceSiteId,
          targetSiteId: row.payload.targetSiteId,
          sourceJws: row.approvalJws,
          targetJws: row.counterpartyJws,
        },
      }),
    });
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
