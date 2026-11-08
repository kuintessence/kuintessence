import type { federationCompletionClaims, PgTransaction } from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { MarketAdapterProposalInputSchema } from "@kuintessence/shared/federation/market";
import { sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { committedExecutionRelease, releaseClosure } from "./execution-closure";

type Claim = typeof federationCompletionClaims.$inferSelect;

/** Local VALID release is irreversible; public closure is still a source-owned obligation. */
export async function preexecutionBlocker(tx: PgTransaction, claim: Claim): Promise<string | null> {
  const site = claim.localSiteId;
  const [revision, taskId, attempt] = claim.intentId.split(":");
  const task = claim.kind === "task";
  const candidates = await tx.execute<{ releaseId: string }>(sql`
    SELECT released.record_id AS "releaseId" FROM federation_commercial_execution_approvals original
    JOIN federation_commercial_execution_approvals released ON released.local_site_id = original.local_site_id
      AND released.agreement_revision_id = original.agreement_revision_id
      AND released.payload->>'kind' = 'commercial-release'
      AND released.payload->>'reservationId' = original.record_id::text
    WHERE original.local_site_id = ${site} AND original.payload->>'kind' = 'commercial-reservation'
      AND ${
        task
          ? sql`original.agreement_revision_id = ${revision}::uuid
        AND original.payload->'request'->>'taskId' = ${taskId}
        AND original.payload->'request'->>'attempt' = ${attempt}`
          : sql`original.record_id::text = ${claim.intentId}`
      }
    LIMIT 2
  `);
  if (candidates.length !== 1) return task ? "settlement" : "market";
  const candidate = candidates[0];
  if (!candidate) return "identity";
  let evidence: Awaited<ReturnType<typeof committedExecutionRelease>>;
  try {
    evidence = await committedExecutionRelease(tx, site, candidate.releaseId);
  } catch (error) {
    if (error instanceof FederationError) return "release-evidence";
    throw error;
  }
  const { reserve, original, release } = evidence,
    request = reserve.request;
  if (task) {
    if (federationMaterialDigest(request) !== claim.digest) return "identity";
  } else {
    const [submission] = await tx.execute<{
      input: unknown;
      digest: string;
      state: string;
      leased: boolean;
    }>(sql`
      SELECT input, digest, state, lease_token IS NOT NULL AS leased FROM federation_market_submissions
      WHERE local_site_id = ${site} AND id::text = ${claim.intentId}
    `);
    const parsed = MarketAdapterProposalInputSchema.safeParse(submission?.input);
    if (
      !parsed.success ||
      parsed.data.operation !== "claim-demand" ||
      !submission ||
      submission.digest !== claim.digest ||
      federationMaterialDigest(parsed.data) !== claim.digest ||
      submission.state !== "committed" ||
      submission.leased ||
      parsed.data.claim.claimId !== reserve.reservationId ||
      parsed.data.claim.demandId !== reserve.demandId ||
      parsed.data.claim.providerSiteId !== site ||
      parsed.data.claim.commercialDomainId !== reserve.domainId ||
      parsed.data.claim.expectedVersion + 1 !== reserve.claimVersion
    )
      return "market";
  }
  const source = request.senderSiteId === site;
  if (source) {
    const closure = await releaseClosure(tx, site, release.recordId);
    const [closed] = await tx.execute<{ closed: boolean }>(sql`
      SELECT m.digest = ${federationMaterialDigest(closure.input)} AND m.input = ${JSON.stringify(closure.input)}::jsonb
        AND m.state = 'committed' AND m.lease_token IS NULL AND a.stage = 'committed'
        AND a.validation_code = 0 AND a.block_number IS NOT NULL AS closed
      FROM federation_market_submissions m JOIN LATERAL (
        SELECT * FROM federation_market_attempts WHERE submission_id = m.id ORDER BY number DESC LIMIT 1
      ) a ON true WHERE m.local_site_id = ${site} AND m.id = ${release.recordId}::uuid
    `);
    if (!closed?.closed) return "market-closure";
  }
  const [result] = await tx.execute<{ blocker: string | null }>(sql`
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM federation_outbound WHERE local_site_id = ${site} AND operation_id = ${request.operationId})
        OR EXISTS (SELECT 1 FROM federation_reservations r JOIN federation_agreements a ON a.revision_id = r.agreement_revision_id
          WHERE a.target_site_id = ${site} AND r.sender_site_id = ${request.senderSiteId} AND r.operation_id = ${request.operationId})
        THEN 'execution-started'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_bills WHERE local_site_id = ${site}
        AND agreement_revision_id = ${request.agreementRevisionId}::uuid AND task_id = ${request.taskId}::uuid AND attempt = ${request.attempt}) THEN 'bill'
      WHEN EXISTS (SELECT 1 FROM workflow_execution_delegations d JOIN workflow_runs w ON w.id = d.run_id
        WHERE d.local_site_id = ${site} AND d.operation_id = ${request.operationId} AND w.status NOT IN ('completed','failed','cancelled')) THEN 'source-workflow'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_submissions WHERE local_site_id = ${site}
        AND input->>'recordId' IN (${request.agreementRevisionId}, ${original.recordId}, ${release.recordId})
        AND (state <> 'committed' OR lease_token IS NOT NULL)) THEN 'commercial-ledger'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_approval_syncs WHERE local_site_id = ${site}
        AND record_id IN (${request.agreementRevisionId}::uuid, ${original.recordId}::uuid, ${release.recordId}::uuid)
        AND (state <> 'complete' OR lease_token IS NOT NULL)) THEN 'signature-exchange'
      WHEN EXISTS (SELECT 1 FROM federation_market_submissions WHERE local_site_id = ${site}
        AND demand_id = ${reserve.demandId}::uuid AND (state <> 'committed' OR lease_token IS NOT NULL)) THEN 'market'
      WHEN EXISTS (SELECT 1 FROM federation_reservation_proposals WHERE local_site_id = ${site}
        AND reservation_id = ${reserve.reservationId}::uuid AND (state NOT IN ('approved','delivered')
          OR execution_state = 'pending' OR lease_token IS NOT NULL OR execution_lease_token IS NOT NULL)) THEN 'proposal'
      WHEN EXISTS (SELECT 1 FROM federation_market_requests WHERE local_site_id = ${site}
        AND reservation_id = ${reserve.reservationId}::uuid AND (state <> 'complete' OR lease_token IS NOT NULL)) THEN 'market-request'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_execution_approvals WHERE local_site_id = ${site}
        AND record_id = ${original.recordId}::uuid AND stop_next_attempt_at IS NOT NULL) THEN 'execution-stop'
      WHEN EXISTS (SELECT 1 FROM federation_terminal_syncs WHERE local_site_id = ${site}
        AND reservation_id = ${reserve.reservationId}::uuid AND (state <> 'complete' OR lease_token IS NOT NULL)) THEN 'terminal-sync'
      ELSE NULL END AS blocker
  `);
  if (!result) throw new Error("Missing pre-execution completion result");
  return result.blocker;
}
