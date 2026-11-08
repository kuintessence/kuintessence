import type { PgDb, PgTransaction } from "@kuintessence/db";
import { type FederationAgreement, FederationError } from "@kuintessence/shared/federation";
import { sql } from "drizzle-orm";

/** Provider-local obligations; settled tasks remain outstanding until their evidence commits. */
export async function readAttestationBacklog(
  db: PgDb | PgTransaction,
  terms: FederationAgreement,
  now: Date,
) {
  const rows = await db.execute<{
    tasks: string;
    amount: string;
    oldest: string | null;
  }>(sql`
    WITH reservations AS (
      SELECT * FROM federation_reservations WHERE agreement_revision_id = ${terms.agreementRevisionId}
    ), pending AS (
      SELECT c.created_at, c.input->>'operation' AS operation,
        u.reservation_id AS usage_reservation_id,
        coalesce(b.payload->'request'->>'operationId', sb.payload->'request'->>'operationId',
          ab.payload->'request'->>'operationId')::uuid AS operation_id,
        (d.payload->>'taskId')::uuid AS discount_task_id,
        (d.payload->>'attempt')::integer AS discount_attempt
      FROM federation_commercial_submissions c
      LEFT JOIN federation_usage_reports u
        ON c.input->>'operation' = 'record-usage' AND u.id = (c.input->>'recordId')::uuid
      LEFT JOIN federation_commercial_bills b
        ON c.input->>'operation' = 'confirm-bill' AND b.bill_id = (c.input->>'recordId')::uuid
        AND b.local_site_id = c.local_site_id
      LEFT JOIN federation_commercial_settlements s
        ON c.input->>'operation' = 'settle-bill' AND s.settlement_id = (c.input->>'recordId')::uuid
        AND s.local_site_id = c.local_site_id
      LEFT JOIN federation_commercial_bills sb
        ON sb.bill_id = s.bill_id AND sb.local_site_id = s.local_site_id
      LEFT JOIN federation_commercial_adjustments a
        ON c.input->>'operation' = 'adjust-settlement' AND a.adjustment_id = (c.input->>'recordId')::uuid
        AND a.local_site_id = c.local_site_id
      LEFT JOIN federation_commercial_settlements sa
        ON sa.settlement_id = a.settlement_id AND sa.local_site_id = a.local_site_id
      LEFT JOIN federation_commercial_bills ab
        ON ab.bill_id = sa.bill_id AND ab.local_site_id = sa.local_site_id
      LEFT JOIN federation_commercial_discounts d
        ON c.input->>'operation' = 'record-discount' AND d.discount_id = (c.input->>'recordId')::uuid
        AND d.local_site_id = c.local_site_id
      WHERE c.agreement_revision_id = ${terms.agreementRevisionId}
        AND c.local_site_id = ${terms.targetSiteId} AND c.state <> 'committed'
    ), obligations AS (
      SELECT id, created_at FROM reservations WHERE settled_amount IS NULL
      UNION ALL
      SELECT r.id, o.created_at FROM reservations r
        JOIN federation_evidence e ON e.reservation_id = r.id
        JOIN federation_attestation_outbox o ON o.evidence_id = e.id AND o.state <> 'anchored'
      UNION ALL
      SELECT r.id, p.created_at FROM reservations r JOIN pending p ON p.operation = 'register-agreement'
      UNION ALL
      SELECT r.id, p.created_at FROM reservations r JOIN pending p ON p.usage_reservation_id = r.id
      UNION ALL
      SELECT r.id, p.created_at FROM reservations r JOIN pending p ON p.operation_id = r.operation_id
      UNION ALL
      SELECT r.id, p.created_at FROM reservations r JOIN pending p
        ON p.discount_task_id = r.task_id AND p.discount_attempt = r.attempt
    ), outstanding AS (
      SELECT id, min(created_at) AS oldest FROM obligations GROUP BY id
    )
    SELECT count(*)::text AS tasks, coalesce(sum(r.amount), 0)::text AS amount,
      min(o.oldest)::text AS oldest
    FROM outstanding o JOIN reservations r ON r.id = o.id
  `);
  const row = rows[0];
  if (!row) throw new Error("Attestation backlog aggregate is missing");
  const oldestPendingAt = row.oldest ? new Date(row.oldest).toISOString() : null;
  return {
    outstandingTasks: Number(row.tasks),
    outstandingAmount: row.amount,
    oldestPendingAt,
    oldestAgeSec: oldestPendingAt
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestPendingAt)) / 1000))
      : null,
    observedAt: now.toISOString(),
  };
}

export async function assertAttestationCapacity(
  tx: PgTransaction,
  terms: FederationAgreement,
  amount: string,
  now: Date,
) {
  const limits = terms.attestationLimits;
  if (terms.mode !== "bilateral_attested" || !limits) return;
  const backlog = await readAttestationBacklog(tx, terms, now);
  if (
    backlog.outstandingTasks >= limits.maxOutstandingTasks ||
    BigInt(backlog.outstandingAmount) + BigInt(amount) > BigInt(limits.maxOutstandingAmount) ||
    (backlog.oldestAgeSec !== null && backlog.oldestAgeSec >= limits.maxOutstandingAgeSec)
  )
    throw new FederationError("ATTESTATION_BACKLOG");
}
