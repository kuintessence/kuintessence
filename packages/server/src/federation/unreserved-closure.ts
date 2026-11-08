import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationUnreservedClosures as closures,
  type PgDb,
  type PgTransaction,
  federationMarketSubmissions as submissions,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import type { CommercialExecutionApproval } from "@kuintessence/shared/federation/commercial";
import { MarketQueryResultSchema } from "@kuintessence/shared/federation/market";
import { and, asc, eq, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";

function lockKey(siteId: string, demandId: string) {
  return `federation-unreserved-closure:${siteId}:${demandId}`;
}

/** Writers hold a shared fence until commit; observing CLOSED takes only the exclusive fence. */
export async function unreservedDemandClosed(tx: PgTransaction, siteId: string, demandId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey(siteId, demandId)}, 0))`,
  );
  const [closed] = await tx
    .select({ id: closures.demandId })
    .from(closures)
    .where(and(eq(closures.localSiteId, siteId), eq(closures.demandId, demandId)));
  return Boolean(closed);
}

export async function assertUnreservedDemandOpen(
  tx: PgTransaction,
  siteId: string,
  demandId: string,
) {
  if (await unreservedDemandClosed(tx, siteId, demandId))
    throw new FederationError("CANCELLATION_REQUESTED");
}

export async function unreservedExecutionClosed(
  tx: PgTransaction,
  siteId: string,
  payload: CommercialExecutionApproval,
) {
  if (payload.kind === "commercial-reservation")
    return unreservedDemandClosed(tx, siteId, payload.demandId);
  const [original] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.localSiteId, siteId), eq(approvals.recordId, payload.reservationId)));
  if (
    original?.payload.kind !== "commercial-reservation" ||
    original.payload.domainId !== payload.domainId
  )
    throw new FederationError("OPERATION_CONFLICT");
  return unreservedDemandClosed(tx, siteId, original.payload.demandId);
}

/** Observe either party's closure using this site's trusted adapter, never a peer-supplied status. */
export async function observeUnreservedClosure(
  db: PgDb,
  siteId: string,
  client: Pick<MarketClient, "query">,
) {
  const origin = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.localSiteId, siteId),
          eq(submissions.state, "committed"),
          sql`${submissions.input}->>'operation' IN ('publish-demand','claim-demand')`,
          sql`${submissions.closureCheckAt} <= clock_timestamp()`,
          sql`NOT EXISTS (SELECT 1 FROM ${closures} WHERE ${closures.localSiteId} = ${submissions.localSiteId}
        AND ${closures.demandId} = ${submissions.demandId})`,
        ),
      )
      .orderBy(asc(submissions.closureCheckAt), asc(submissions.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    await tx
      .update(submissions)
      .set({ closureCheckAt: sql`clock_timestamp() + interval '60 seconds'` })
      .where(eq(submissions.id, row.id));
    return row;
  });
  if (!origin) return false;
  const parsed = MarketQueryResultSchema.safeParse(
    await client.query({ operation: "get-demand", demandId: origin.demandId }),
  );
  if (!parsed.success || parsed.data.operation !== "get-demand")
    throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
  const state = parsed.data.demand;
  if (state && state.demand.demandId !== origin.demandId)
    throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
  if (!state?.unreservedClosure) return true;
  const input = origin.input;
  if (
    federationMaterialDigest(input) !== origin.digest ||
    federationMaterialDigest(state.demand) !== state.digest ||
    (input.operation === "publish-demand"
      ? input.demand.sourceSiteId !== siteId ||
        federationMaterialDigest(input.demand) !== federationMaterialDigest(state.demand)
      : input.operation !== "claim-demand" ||
        input.claim.providerSiteId !== siteId ||
        federationMaterialDigest(input.claim) !== federationMaterialDigest(state.claim))
  )
    throw new FederationError("OPERATION_CONFLICT");
  const digest = federationMaterialDigest(state);
  await db.transaction(async (tx) => {
    // Take the FK lock before the fence; no business rows are locked after the exclusive fence.
    const [current] = await tx
      .select()
      .from(submissions)
      .where(eq(submissions.id, origin.id))
      .for("share");
    if (
      current?.localSiteId !== siteId ||
      current.localOrgId !== origin.localOrgId ||
      current.state !== "committed" ||
      current.digest !== origin.digest ||
      federationMaterialDigest(current.input) !== origin.digest
    )
      throw new FederationError("OPERATION_CONFLICT");
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(siteId, origin.demandId)}, 0))`,
    );
    const [prior] = await tx
      .select()
      .from(closures)
      .where(and(eq(closures.localSiteId, siteId), eq(closures.demandId, origin.demandId)));
    if (prior) {
      if (prior.digest !== digest || federationMaterialDigest(prior.payload) !== digest)
        throw new FederationError("OPERATION_CONFLICT");
      return;
    }
    await tx.insert(closures).values({
      localSiteId: siteId,
      demandId: origin.demandId,
      originId: origin.id,
      payload: state,
      digest,
    });
    await tx.insert(auditLog).values({
      actor: `market-worker:${siteId}`,
      orgId: origin.localOrgId,
      action: "federation.market.observe_unreserved_closure",
      target: origin.demandId,
      diff: {
        after: { closureId: state.unreservedClosure?.closureId, originId: origin.id, digest },
      },
    });
  });
  return true;
}

/** Preserve signed bytes and completed exchanges. Leased work drains through its original fence. */
export async function retireUnreservedIntents(db: PgDb, siteId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`WITH candidates AS (
      SELECT p.local_site_id, p.reservation_id FROM federation_reservation_proposals p
      JOIN federation_unreserved_closures c ON c.local_site_id = p.local_site_id AND c.demand_id::text = p.payload->>'demandId'
      WHERE p.local_site_id = ${siteId} AND (p.state <> 'closed' OR p.execution_state <> 'closed')
        AND (p.lease_until IS NULL OR p.lease_until <= clock_timestamp())
        AND (p.execution_lease_until IS NULL OR p.execution_lease_until <= clock_timestamp())
      ORDER BY p.reservation_id LIMIT 8 FOR UPDATE OF p SKIP LOCKED
    ) UPDATE federation_reservation_proposals p SET state = 'closed', execution_state = 'closed',
      lease_token = NULL, lease_until = NULL, execution_lease_token = NULL, execution_lease_until = NULL,
      last_error = 'MARKET_CLOSED', execution_error = 'MARKET_CLOSED'
      FROM candidates c WHERE p.local_site_id = c.local_site_id AND p.reservation_id = c.reservation_id`);
    await tx.execute(sql`WITH candidates AS (
      SELECT r.local_site_id, r.reservation_id FROM federation_market_requests r
      JOIN federation_unreserved_closures c ON c.local_site_id = r.local_site_id AND c.demand_id = r.demand_id
      WHERE r.local_site_id = ${siteId} AND r.state NOT IN ('closed','complete')
        AND (r.lease_until IS NULL OR r.lease_until <= clock_timestamp())
      ORDER BY r.reservation_id LIMIT 8 FOR UPDATE OF r SKIP LOCKED
    ) UPDATE federation_market_requests r SET state = 'closed', lease_token = NULL, lease_until = NULL, last_error = 'MARKET_CLOSED'
      FROM candidates c WHERE r.local_site_id = c.local_site_id AND r.reservation_id = c.reservation_id`);
    await tx.execute(sql`WITH candidates AS (
      SELECT s.local_site_id, s.record_id, s.record_kind FROM federation_commercial_approval_syncs s
      JOIN federation_commercial_execution_approvals a ON a.local_site_id = s.local_site_id AND a.record_id = s.record_id
      LEFT JOIN federation_commercial_execution_approvals original ON original.local_site_id = a.local_site_id
        AND original.record_id::text = a.payload->>'reservationId' AND a.payload->>'kind' = 'commercial-release'
      JOIN federation_unreserved_closures c ON c.local_site_id = a.local_site_id
        AND c.demand_id::text = coalesce(a.payload->>'demandId', original.payload->>'demandId')
      WHERE s.local_site_id = ${siteId} AND s.record_kind IN ('reservation','release') AND s.state NOT IN ('closed','complete')
        AND (s.lease_until IS NULL OR s.lease_until <= clock_timestamp())
      ORDER BY s.record_id LIMIT 8 FOR UPDATE OF s SKIP LOCKED
    ) UPDATE federation_commercial_approval_syncs s SET state = 'closed', lease_token = NULL, lease_until = NULL, last_error = 'MARKET_CLOSED'
      FROM candidates c WHERE s.local_site_id = c.local_site_id AND s.record_id = c.record_id AND s.record_kind = c.record_kind`);
  });
}
