import type { federationCompletionClaims, PgTransaction } from "@kuintessence/db";
import { FederationDelegationSchema } from "@kuintessence/shared/federation";
import { sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { readFederationCancellationState } from "./cancellation-state";
import { preexecutionBlocker } from "./completion-preexecution";
import { unreservedCompletionBlocker } from "./completion-unreserved";

type Claim = typeof federationCompletionClaims.$inferSelect;

/** Called with the claim locked: new post-completion obligations cannot commit during this read. */
export async function completionBlocker(tx: PgTransaction, claim: Claim): Promise<string | null> {
  const unreserved = await unreservedCompletionBlocker(tx, claim);
  if (unreserved !== undefined) return unreserved;
  const site = claim.localSiteId;
  if (claim.kind === "market") {
    const [row] = await tx.execute<{ closed: boolean }>(sql`
      SELECT m.digest = ${claim.digest} AND m.state = 'committed' AND EXISTS (
        SELECT 1 FROM federation_market_submissions c WHERE c.local_site_id = m.local_site_id
          AND c.demand_id = m.demand_id AND c.state = 'committed'
          AND (c.input->>'operation' = 'close-demand' OR
            (m.input->>'operation' = 'publish-demand' AND c.input->>'operation' = 'cancel-open-demand'))
      ) AND NOT EXISTS (SELECT 1 FROM federation_market_submissions p
        WHERE p.local_site_id = m.local_site_id AND p.demand_id = m.demand_id
          AND (p.state <> 'committed' OR p.lease_token IS NOT NULL)) AS closed
      FROM federation_market_submissions m WHERE m.local_site_id = ${site} AND m.id::text = ${claim.intentId}
    `);
    return row?.closed ? null : preexecutionBlocker(tx, claim);
  }
  const [revision, taskId, attempt] = claim.intentId.split(":");
  const [bill] = await tx.execute<{ request: unknown; billId: string; settlementId: string }>(sql`
    SELECT b.payload->'request' AS request, b.bill_id AS "billId", s.settlement_id AS "settlementId"
    FROM federation_commercial_bills b JOIN federation_commercial_settlements s
      ON s.local_site_id = b.local_site_id AND s.bill_id = b.bill_id
    WHERE b.local_site_id = ${site} AND b.agreement_revision_id = ${revision}::uuid
      AND b.task_id = ${taskId}::uuid AND b.attempt = ${attempt}::integer
      AND b.counterparty_jws IS NOT NULL AND s.counterparty_jws IS NOT NULL AND s.applied_at IS NOT NULL
  `);
  // Unknown or unsigned early intents retain their allocation.
  if (!bill) return preexecutionBlocker(tx, claim);
  const parsed = FederationDelegationSchema.safeParse(bill.request);
  if (!parsed.success) return "identity";
  const request = parsed.data;
  if (federationMaterialDigest(request) !== claim.digest) return "identity";
  const provider = site === request.recipientSiteId;
  if (!provider && site !== request.senderSiteId) return "identity";
  if (provider) {
    const stopped = await readFederationCancellationState(tx, request);
    if (!stopped.stopped || stopped.runs.length !== 1) return "execution-or-input-cleanup";
  }
  const [pending] = await tx.execute<{ blocker: string | null }>(sql`
    WITH reservations AS (
      SELECT r.* FROM federation_reservations r JOIN federation_agreements a
        ON a.revision_id = r.agreement_revision_id
      WHERE a.target_site_id = ${site} AND r.sender_site_id = ${request.senderSiteId}
        AND r.operation_id = ${request.operationId}
    ), proposals AS (
      SELECT * FROM federation_reservation_proposals WHERE local_site_id = ${site}
        AND agreement_revision_id = ${revision}::uuid AND payload->'request'->>'operationId' = ${request.operationId}
    ), market_requests AS (
      SELECT * FROM federation_market_requests WHERE local_site_id = ${site}
        AND agreement_revision_id = ${revision}::uuid AND payload->'proposal'->'request'->>'operationId' = ${request.operationId}
    ), approvals AS (
      SELECT * FROM federation_commercial_execution_approvals WHERE local_site_id = ${site}
        AND agreement_revision_id = ${revision}::uuid AND payload->>'kind' = 'commercial-reservation'
        AND payload->'request'->>'operationId' = ${request.operationId}
    ), execution_records AS (
      SELECT record_id FROM approvals
      UNION ALL SELECT e.record_id FROM federation_commercial_execution_approvals e
        WHERE e.local_site_id = ${site} AND e.agreement_revision_id = ${revision}::uuid
          AND e.payload->>'reservationId' IN (SELECT record_id::text FROM approvals)
    ), terminals AS (
      SELECT * FROM federation_execution_terminals WHERE local_site_id = ${site}
        AND reservation_id IN (SELECT record_id FROM approvals)
    ), adjustments AS (
      SELECT * FROM federation_commercial_adjustments WHERE local_site_id = ${site}
        AND settlement_id = ${bill.settlementId}::uuid
    ), discounts AS (
      SELECT * FROM federation_commercial_discounts WHERE local_site_id = ${site}
        AND agreement_revision_id = ${revision}::uuid AND payload->>'taskId' = ${taskId}
        AND payload->>'attempt' = ${attempt}
    ), records AS (
      SELECT ${revision}::uuid AS id UNION ALL SELECT ${bill.billId}::uuid
      UNION ALL SELECT ${bill.settlementId}::uuid
      UNION ALL SELECT id FROM federation_usage_reports WHERE reservation_id IN (SELECT id FROM reservations)
      UNION ALL SELECT adjustment_id FROM adjustments UNION ALL SELECT discount_id FROM discounts
      UNION ALL SELECT record_id FROM execution_records UNION ALL SELECT terminal_id FROM terminals
    ), demand_ids AS (
      SELECT payload->>'demandId' AS id FROM approvals
      UNION SELECT demand_id::text FROM market_requests
      UNION SELECT payload->>'demandId' FROM proposals
    ), input_imports AS (
      SELECT * FROM federation_input_imports WHERE local_site_id = ${site}
        AND reservation_id IN (SELECT id FROM reservations)
    ), result_imports AS (
      SELECT * FROM federation_result_imports WHERE local_site_id = ${site} AND operation_id = ${request.operationId}
    )
    SELECT CASE
      WHEN ${provider} AND NOT EXISTS (SELECT 1 FROM reservations WHERE state = 'reserved' AND settled_amount IS NOT NULL)
        THEN 'reservation'
      WHEN NOT ${provider} AND NOT EXISTS (SELECT 1 FROM federation_outbound WHERE local_site_id = ${site}
        AND operation_id = ${request.operationId} AND state = 'accepted' AND settled_amount IS NOT NULL
        AND adjustment_held_amount = 0 AND (cancel_state IS NULL OR cancel_state = 'stopped')
        AND status_claim IS NULL AND status_next_attempt_at IS NULL AND status_last_error IS NULL
        AND lease_owner IS NULL AND cancel_lease_owner IS NULL) THEN 'outbound'
      WHEN EXISTS (SELECT 1 FROM workflow_execution_delegations d JOIN workflow_runs w ON w.id = d.run_id
        WHERE d.local_site_id = ${site} AND d.operation_id = ${request.operationId}
          AND w.status NOT IN ('completed','failed','cancelled')) THEN 'source-workflow'
      WHEN EXISTS (SELECT 1 FROM adjustments WHERE applied_at IS NULL OR counterparty_jws IS NULL) THEN 'adjustment'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_submissions c WHERE c.local_site_id = ${site}
        AND c.agreement_revision_id = ${revision}::uuid AND c.input->>'recordId' IN (SELECT id::text FROM records)
        AND (c.state <> 'committed' OR c.lease_token IS NOT NULL)) THEN 'commercial-ledger'
      WHEN EXISTS (SELECT 1 FROM federation_evidence e JOIN federation_attestation_outbox o ON o.evidence_id = e.id
        WHERE e.reservation_id IN (SELECT id FROM reservations) AND o.state <> 'anchored') THEN 'attestation'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_approval_syncs s WHERE s.local_site_id = ${site}
        AND s.agreement_revision_id = ${revision}::uuid AND s.record_id IN (SELECT id FROM records)
        AND (s.state <> 'complete' OR s.lease_token IS NOT NULL)) THEN 'signature-exchange'
      WHEN EXISTS (SELECT 1 FROM federation_closing_tasks t WHERE t.local_site_id = ${site}
        AND (t.reference_id IN (SELECT id FROM reservations) OR t.reference_id = ${bill.billId}::uuid)
        AND (t.state <> 'complete' OR t.lease_token IS NOT NULL)) THEN 'closing'
      WHEN EXISTS (SELECT 1 FROM federation_usage_tasks WHERE local_site_id = ${site}
        AND reservation_id IN (SELECT id FROM reservations) AND state <> 'reported') THEN 'usage'
      WHEN EXISTS (SELECT 1 FROM federation_usage_syncs WHERE local_site_id = ${site}
        AND operation_id = ${request.operationId} AND (state = 'needs_review' OR lease_token IS NOT NULL)) THEN 'usage-sync'
      WHEN EXISTS (SELECT 1 FROM proposals WHERE (direction = 'outbound' AND state <> 'delivered')
        OR (direction = 'inbound' AND state <> 'approved') OR lease_token IS NOT NULL
        OR execution_state NOT IN ('idle','complete') OR execution_lease_token IS NOT NULL) THEN 'proposal'
      WHEN EXISTS (SELECT 1 FROM market_requests WHERE state <> 'complete' OR lease_token IS NOT NULL) THEN 'market-request'
      WHEN EXISTS (SELECT 1 FROM approvals WHERE counterparty_jws IS NULL) THEN 'approval'
      WHEN EXISTS (SELECT 1 FROM approvals WHERE stop_next_attempt_at IS NOT NULL) THEN 'execution-stop'
      WHEN EXISTS (SELECT 1 FROM terminals WHERE counterparty_jws IS NULL) THEN 'terminal'
      WHEN EXISTS (SELECT 1 FROM federation_terminal_syncs WHERE local_site_id = ${site}
        AND reservation_id IN (SELECT record_id FROM approvals) AND (state <> 'complete' OR lease_token IS NOT NULL)) THEN 'terminal-sync'
      WHEN ${request.mode} = 'ledger_coordinated' AND NOT EXISTS (SELECT 1 FROM terminals) THEN 'terminal'
      WHEN EXISTS (SELECT 1 FROM federation_market_submissions WHERE local_site_id = ${site}
        AND demand_id::text IN (SELECT id FROM demand_ids) AND (state <> 'committed' OR lease_token IS NOT NULL)) THEN 'market'
      WHEN ${request.mode} = 'ledger_coordinated' AND NOT ${provider} AND NOT EXISTS (
        SELECT 1 FROM federation_market_submissions WHERE local_site_id = ${site}
        AND demand_id::text IN (SELECT id FROM demand_ids) AND state = 'committed' AND input->>'operation' = 'close-demand') THEN 'market-closure'
      WHEN EXISTS (SELECT 1 FROM input_imports WHERE state <> 'cancelled' OR reserved_bytes <> 0) THEN 'input-cleanup'
      WHEN EXISTS (SELECT 1 FROM federation_input_attempts a JOIN federation_input_transfers t ON t.id = a.transfer_id
        WHERE t.import_id IN (SELECT id FROM input_imports) AND a.state <> 'cleaned') THEN 'input-cleanup'
      WHEN EXISTS (SELECT 1 FROM result_imports WHERE reserved_bytes <> 0 OR state NOT IN ('available','cancelled')
        OR (state = 'available' AND receipt_ack_jws IS NULL)) THEN 'result-receipt'
      WHEN EXISTS (SELECT 1 FROM federation_result_attempts a JOIN federation_result_transfers t ON t.id = a.transfer_id
        WHERE t.import_id IN (SELECT id FROM result_imports) AND a.state NOT IN ('available','cleaned')) THEN 'result-cleanup'
      ELSE NULL END AS blocker
  `);
  if (!pending) throw new Error("Completion readiness result missing");
  return pending.blocker;
}
