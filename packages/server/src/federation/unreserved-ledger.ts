import { auditLog, type PgTransaction } from "@kuintessence/db";
import { sql } from "drizzle-orm";

/** A proposal has not been broadcast. A transaction checkpoint must resolve under its original ID. */
export async function retireUnreservedLedger(tx: PgTransaction, siteId: string) {
  for (const kind of ["market", "commercial"] as const) {
    const submissions = sql.identifier(`federation_${kind}_submissions`);
    const attempts = sql.identifier(`federation_${kind}_attempts`);
    const rows = await tx.execute<{ id: string; orgId: string; state: string }>(sql`
      SELECT s.id, s.state, ${kind === "market" ? sql`s.local_org_id` : sql`a.local_org_id`} AS "orgId"
      FROM ${submissions} s
      ${
        kind === "market"
          ? sql``
          : sql`
        JOIN federation_commercial_execution_approvals a ON a.local_site_id = s.local_site_id
          AND a.record_id::text = s.input->>'recordId' AND a.agreement_revision_id = s.agreement_revision_id
        LEFT JOIN federation_commercial_execution_approvals original ON original.local_site_id = a.local_site_id
          AND original.record_id::text = a.payload->>'reservationId' AND a.payload->>'kind' = 'commercial-release'
      `
      }
      JOIN federation_unreserved_closures c ON c.local_site_id = s.local_site_id
        AND ${
          kind === "market"
            ? sql`c.demand_id = s.demand_id`
            : sql`
          c.demand_id::text = coalesce(a.payload->>'demandId', original.payload->>'demandId')
          AND s.input->>'operation' IN ('reserve-execution','release-execution')
        `
        }
      WHERE s.local_site_id = ${siteId} AND (s.state IN ('pending','needs_review') OR (s.state = 'committed' AND s.lease_token IS NOT NULL))
        AND (s.lease_until IS NULL OR s.lease_until <= clock_timestamp())
        AND (s.state = 'committed' OR NOT EXISTS (SELECT 1 FROM ${attempts} t WHERE t.submission_id = s.id AND t.stage IN ('transaction','committed')))
      ORDER BY s.id LIMIT 8 FOR UPDATE OF s SKIP LOCKED
    `);
    for (const row of rows) {
      if (row.state === "committed") {
        // A crash after VALID persistence can leave a lease that no pending worker will ever claim again.
        await tx.execute(
          sql`UPDATE ${submissions} SET lease_token = NULL, lease_until = NULL WHERE id = ${row.id}::uuid`,
        );
        continue;
      }
      await tx.execute(sql`UPDATE ${attempts} SET stage = 'abandoned', updated_at = clock_timestamp()
        WHERE submission_id = ${row.id}::uuid AND stage = 'proposal'`);
      await tx.execute(sql`UPDATE ${submissions} SET state = 'closed', last_error = 'MARKET_CLOSED',
        lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE id = ${row.id}::uuid`);
      await tx.insert(auditLog).values({
        actor: `market-worker:${siteId}`,
        orgId: row.orgId,
        action: `federation.${kind}.retire_unreserved`,
        target: row.id,
        diff: { after: { state: "closed", reason: "MARKET_CLOSED" } },
      });
    }
  }
}
