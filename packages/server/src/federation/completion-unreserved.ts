import { createHash } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  federationCommercialSubmissions as commercial,
  type federationCompletionClaims,
  federationMarketSubmissions as market,
  type PgTransaction,
  federationReservationProposals as proposals,
  federationMarketRequests as requests,
} from "@kuintessence/db";
import {
  CommercialAdapterProposalInputSchema,
  CommercialExecutionApprovalSchema,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  MarketAdapterProposalInputSchema,
  MarketDemandStateSchema,
} from "@kuintessence/shared/federation/market";
import { MarketRequestSchema } from "@kuintessence/shared/federation/market-request";
import { and, eq, inArray, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";

type Claim = typeof federationCompletionClaims.$inferSelect;
const wireDigest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** Undefined leaves other completion paths unchanged. CLOSED alone does not prove local work has drained. */
export async function unreservedCompletionBlocker(
  tx: PgTransaction,
  claim: Claim,
): Promise<string | null | undefined> {
  const site = claim.localSiteId;
  const [revision, taskId, attempt] = claim.intentId.split(":");
  const [intent] =
    claim.kind === "market"
      ? await tx
          .select()
          .from(market)
          .where(and(eq(market.localSiteId, site), sql`${market.id}::text = ${claim.intentId}`))
      : [];
  const taskFilter =
    claim.kind === "task"
      ? sql`payload->'request'->>'agreementRevisionId' = ${revision} AND payload->'request'->>'taskId' = ${taskId} AND payload->'request'->>'attempt' = ${attempt}`
      : sql`payload->>'demandId' = ${intent?.demandId ?? ""}`;
  const candidates = await tx.execute<{ payload: unknown; orgId: string }>(sql`
    SELECT DISTINCT payload, org_id AS "orgId" FROM (
      SELECT payload, local_org_id AS org_id FROM federation_commercial_execution_approvals
        WHERE local_site_id = ${site} AND payload->>'kind' = 'commercial-reservation'
      UNION ALL SELECT payload, local_org_id FROM federation_reservation_proposals WHERE local_site_id = ${site}
      UNION ALL SELECT payload->'proposal', local_org_id FROM federation_market_requests WHERE local_site_id = ${site}
    ) intents WHERE ${taskFilter} LIMIT 2
  `);
  const parsedReserve = candidates[0]
    ? CommercialReservationSchema.safeParse(candidates[0].payload)
    : null;
  const reserve = parsedReserve?.success ? parsedReserve.data : null;
  const demandId = intent?.demandId ?? reserve?.demandId;
  if (!demandId) return undefined;
  const [evidence] = await tx.execute<{ payload: unknown; digest: string; originId: string }>(sql`
    SELECT payload, digest, origin_id AS "originId" FROM federation_unreserved_closures
      WHERE local_site_id = ${site} AND demand_id = ${demandId}::uuid
  `);
  if (!evidence) return undefined;
  const parsed = MarketDemandStateSchema.safeParse(evidence.payload);
  if (
    !parsed.success ||
    !parsed.data.unreservedClosure ||
    !parsed.data.claim ||
    federationMaterialDigest(parsed.data) !== evidence.digest ||
    parsed.data.demand.demandId !== demandId ||
    federationMaterialDigest(parsed.data.demand) !== parsed.data.digest
  )
    return "closure-evidence";
  const state = parsed.data;
  const [origin] = await tx
    .select()
    .from(market)
    .where(and(eq(market.localSiteId, site), eq(market.id, evidence.originId)));
  if (
    !origin ||
    origin.demandId !== demandId ||
    origin.state !== "committed" ||
    origin.leaseToken ||
    federationMaterialDigest(origin.input) !== origin.digest ||
    (origin.input.operation === "publish-demand"
      ? site !== state.demand.sourceSiteId ||
        federationMaterialDigest(origin.input.demand) !== federationMaterialDigest(state.demand)
      : origin.input.operation !== "claim-demand" ||
        site !== state.claim?.providerSiteId ||
        federationMaterialDigest(origin.input.claim) !== federationMaterialDigest(state.claim))
  )
    return "closure-evidence";
  if (
    claim.kind === "market" &&
    (!intent || intent.id !== origin.id || intent.digest !== claim.digest)
  )
    return "identity";
  if (candidates.length > 1 || (candidates.length && !reserve)) return "identity";
  if (
    claim.kind === "task" &&
    (!reserve || federationMaterialDigest(reserve.request) !== claim.digest)
  )
    return "identity";
  if (
    reserve &&
    (candidates[0]?.orgId !== origin.localOrgId ||
      reserve.request.mode !== "ledger_coordinated" ||
      reserve.request.senderSiteId !== state.demand.sourceSiteId ||
      reserve.request.recipientSiteId !== state.claim?.providerSiteId ||
      reserve.reservationId !== state.claim?.claimId ||
      reserve.domainId !== state.claim?.commercialDomainId ||
      reserve.claimVersion !== state.unreservedClosure?.expectedVersion ||
      federationMaterialDigest(reserve.request.resources) !==
        federationMaterialDigest(state.demand.resources))
  )
    return "identity";

  const publicRows = await tx
    .select()
    .from(market)
    .where(and(eq(market.localSiteId, site), eq(market.demandId, demandId)));
  for (const row of publicRows) {
    const input = MarketAdapterProposalInputSchema.safeParse(row.input);
    if (
      !input.success ||
      row.localOrgId !== origin.localOrgId ||
      federationMaterialDigest(input.data) !== row.digest
    )
      return "identity";
    if (row.leaseToken || !["committed", "closed"].includes(row.state)) return "market";
    if (row.state === "closed") {
      if (row.lastError !== "MARKET_CLOSED") return "market";
    } else {
      const expected =
        input.data.operation === "publish-demand"
          ? { operation: "publish-demand", demand: state.demand }
          : input.data.operation === "claim-demand"
            ? { operation: "claim-demand", claim: state.claim }
            : input.data.operation === "close-unreserved-demand"
              ? { operation: "close-unreserved-demand", closure: state.unreservedClosure }
              : null;
      if (!expected || federationMaterialDigest(expected) !== row.digest) return "closure-evidence";
      if (input.data.operation === "close-unreserved-demand") {
        const [valid] = await tx.execute<{
          valid: boolean;
        }>(sql`SELECT stage = 'committed' AND validation_code = 0 AND block_number IS NOT NULL AS valid
          FROM federation_market_attempts WHERE submission_id = ${row.id}::uuid ORDER BY number DESC LIMIT 1`);
        if (!valid?.valid) return "market";
      }
    }
    const [pending] = await tx.execute<{ pending: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM federation_market_attempts WHERE submission_id = ${row.id}::uuid
        AND (stage IN ('proposal','transaction') OR (${row.state} = 'closed' AND stage = 'committed'))
    ) AS pending`);
    if (pending?.pending) return "market";
  }
  if (!reserve) return null;
  const request = reserve.request;
  const proposed = await tx
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.localSiteId, site), sql`${proposals.payload}->>'demandId' = ${demandId}`),
    );
  for (const row of proposed) {
    const parsed = CommercialReservationSchema.safeParse(row.payload);
    if (
      !parsed.success ||
      row.localOrgId !== origin.localOrgId ||
      row.reservationId !== reserve.reservationId ||
      row.agreementRevisionId !== request.agreementRevisionId ||
      wireDigest(parsed.data) !== row.digest ||
      federationMaterialDigest(parsed.data) !== federationMaterialDigest(reserve)
    )
      return "identity";
  }
  const requested = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.localSiteId, site), eq(requests.demandId, demandId)));
  for (const row of requested) {
    const parsed = MarketRequestSchema.safeParse(row.payload);
    if (
      !parsed.success ||
      row.localOrgId !== origin.localOrgId ||
      row.reservationId !== reserve.reservationId ||
      row.agreementRevisionId !== request.agreementRevisionId ||
      wireDigest(parsed.data) !== row.digest ||
      federationMaterialDigest(parsed.data.proposal) !== federationMaterialDigest(reserve)
    )
      return "identity";
  }
  const records = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.localSiteId, site),
        sql`(${approvals.recordId} = ${reserve.reservationId}::uuid OR ${approvals.payload}->>'reservationId' = ${reserve.reservationId})`,
      ),
    );
  for (const row of records) {
    const parsed = CommercialExecutionApprovalSchema.safeParse(row.payload);
    if (
      !parsed.success ||
      row.localOrgId !== origin.localOrgId ||
      row.agreementRevisionId !== request.agreementRevisionId ||
      wireDigest(parsed.data) !== row.digest
    )
      return "identity";
    const payload = parsed.data;
    if (
      payload.kind === "commercial-reservation"
        ? federationMaterialDigest(payload) !== federationMaterialDigest(reserve)
        : payload.reservationId !== reserve.reservationId ||
          payload.reservationDigest !== wireDigest(reserve) ||
          payload.domainId !== reserve.domainId ||
          payload.sourceSiteId !== request.senderSiteId ||
          payload.targetSiteId !== request.recipientSiteId
    )
      return "identity";
  }
  const recordIds = records.map((row) => row.recordId);
  const privateRows = recordIds.length
    ? await tx
        .select()
        .from(commercial)
        .where(
          and(
            eq(commercial.localSiteId, site),
            inArray(sql<string>`${commercial.input}->>'recordId'`, recordIds),
          ),
        )
    : [];
  for (const row of privateRows) {
    const input = CommercialAdapterProposalInputSchema.safeParse(row.input);
    if (!input.success) return "commercial-ledger";
    const value = input.data;
    if (value.operation !== "reserve-execution" && value.operation !== "release-execution")
      return "commercial-ledger";
    const approval = records.find((record) => record.recordId === value.recordId);
    const source = site === request.senderSiteId;
    if (
      !approval?.counterpartyJws ||
      row.agreementRevisionId !== request.agreementRevisionId ||
      value.operation !==
        (approval.payload.kind === "commercial-reservation"
          ? "reserve-execution"
          : "release-execution") ||
      value.digest !== approval.digest ||
      value.domainId !== reserve.domainId ||
      value.envelope.sourceSiteId !== request.senderSiteId ||
      value.envelope.targetSiteId !== request.recipientSiteId ||
      value.envelope.sourceJws !== (source ? approval.approvalJws : approval.counterpartyJws) ||
      value.envelope.targetJws !== (source ? approval.counterpartyJws : approval.approvalJws)
    )
      return "identity";
    if (row.state !== "closed" || row.leaseToken || row.lastError !== "MARKET_CLOSED")
      return "commercial-ledger";
    const [pending] = await tx.execute<{ pending: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM federation_commercial_attempts WHERE submission_id = ${row.id}::uuid AND stage NOT IN ('invalid','abandoned')
    ) AS pending`);
    if (pending?.pending) return "commercial-ledger";
  }
  const [pending] = await tx.execute<{ blocker: string | null }>(sql`
    WITH records AS (
      SELECT record_id FROM federation_commercial_execution_approvals WHERE local_site_id = ${site}
        AND (record_id = ${reserve.reservationId}::uuid OR payload->>'reservationId' = ${reserve.reservationId})
    ) SELECT CASE
      WHEN EXISTS (SELECT 1 FROM federation_outbound WHERE local_site_id = ${site} AND operation_id = ${request.operationId})
        OR EXISTS (SELECT 1 FROM federation_reservations r JOIN federation_agreements a ON a.revision_id = r.agreement_revision_id
          WHERE a.target_site_id = ${site} AND r.sender_site_id = ${request.senderSiteId} AND r.operation_id = ${request.operationId}) THEN 'execution-started'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_bills WHERE local_site_id = ${site}
        AND agreement_revision_id = ${request.agreementRevisionId}::uuid AND task_id = ${request.taskId}::uuid AND attempt = ${request.attempt}) THEN 'bill'
      WHEN EXISTS (SELECT 1 FROM workflow_execution_delegations d JOIN workflow_runs w ON w.id = d.run_id
        WHERE d.local_site_id = ${site} AND d.operation_id = ${request.operationId} AND w.status NOT IN ('completed','failed','cancelled')) THEN 'source-workflow'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_submissions WHERE local_site_id = ${site} AND input->>'recordId' = ${request.agreementRevisionId}
        AND (state <> 'committed' OR lease_token IS NOT NULL)) THEN 'commercial-ledger'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_approval_syncs WHERE local_site_id = ${site}
        AND record_id IN (SELECT record_id FROM records UNION SELECT ${request.agreementRevisionId}::uuid)
        AND (state NOT IN ('complete','closed') OR lease_token IS NOT NULL)) THEN 'signature-exchange'
      WHEN EXISTS (SELECT 1 FROM federation_reservation_proposals WHERE local_site_id = ${site}
        AND payload->>'demandId' = ${demandId} AND (state <> 'closed' OR execution_state <> 'closed'
          OR lease_token IS NOT NULL OR execution_lease_token IS NOT NULL)) THEN 'proposal'
      WHEN EXISTS (SELECT 1 FROM federation_market_requests WHERE local_site_id = ${site} AND demand_id = ${demandId}::uuid
        AND (state NOT IN ('complete','closed') OR lease_token IS NOT NULL)) THEN 'market-request'
      WHEN EXISTS (SELECT 1 FROM federation_commercial_execution_approvals WHERE local_site_id = ${site}
        AND record_id = ${reserve.reservationId}::uuid AND stop_next_attempt_at IS NOT NULL) THEN 'execution-stop'
      WHEN EXISTS (SELECT 1 FROM federation_execution_terminals WHERE local_site_id = ${site} AND reservation_id = ${reserve.reservationId}::uuid)
        OR EXISTS (SELECT 1 FROM federation_terminal_syncs WHERE local_site_id = ${site} AND reservation_id = ${reserve.reservationId}::uuid) THEN 'terminal'
      ELSE NULL END AS blocker
  `);
  if (!pending) throw new Error("Missing unreserved completion result");
  return pending.blocker;
}
