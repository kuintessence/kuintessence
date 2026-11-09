import {
  federationAgreements,
  federationOutbound,
  federationReservations,
  federationWorkflowBindings,
  type PgDb,
  workflowExecutionDelegations,
  workflowRuns,
} from "@kuintessence/db";
import {
  MediaTaskOptionsQuerySchema,
  MediaTaskOptionsSchema,
} from "@kuintessence/shared/federation";
import { and, desc, eq, isNull, type SQLWrapper, sql } from "drizzle-orm";
import { type FederationActor, requireFederationCapability } from "./permissions";

/** Discovery uses original task bindings; export approval still rechecks all live authorities. */
export async function mediaTaskOptions(
  db: PgDb,
  localSiteId: string,
  actor: FederationActor,
  raw: unknown,
) {
  const query = MediaTaskOptionsQuerySchema.parse(raw);
  return db.transaction(async (tx) => {
    await requireFederationCapability(tx, actor, "asset.read");
    const run = workflowRuns;
    if (query.kind === "task-input") {
      const binding = workflowExecutionDelegations,
        outbound = federationOutbound;
      const rows = await tx
        .select({
          operationId: binding.operationId,
          agreementRevisionId: outbound.agreementRevisionId,
          recipientSiteId: sql<string>`${binding.request}->>'recipientSiteId'`,
          workflowRunId: run.id,
          workflowName: run.name,
          nodeId: binding.nodeId,
          invocationPath: binding.path,
          createdAt: binding.createdAt,
        })
        .from(binding)
        .innerJoin(run, eq(run.id, binding.runId))
        .innerJoin(
          outbound,
          and(
            eq(outbound.localSiteId, binding.localSiteId),
            eq(outbound.operationId, binding.operationId),
          ),
        )
        .where(
          and(
            eq(binding.localSiteId, localSiteId),
            eq(outbound.localOrgId, actor.orgId),
            eq(outbound.submittedBy, actor.userId),
            eq(run.submittedBy, actor.userId),
            eq(outbound.state, "accepted"),
            isNull(outbound.cancelState),
            eq(run.status, "running"),
            sql`${run.input}->>'orgId' = ${actor.orgId}`,
            sql`${run.input}->>'executionModel' = 'durable-v2'`,
            sql`${run.input}->>'federationReservationId' is null`,
            sql`${binding.request} = ${outbound.request}`,
            sql`${binding.request}->>'inputDelivery' = 'media'`,
            query.workflowRunId ? eq(run.id, query.workflowRunId) : undefined,
          ),
        )
        .orderBy(desc(binding.createdAt), desc(binding.operationId))
        .limit(query.limit + 1)
        .offset(query.offset);
      return MediaTaskOptionsSchema.parse({
        localSiteId,
        localOrgId: actor.orgId,
        kind: query.kind,
        workflowRunId: query.workflowRunId ?? null,
        data: rows
          .slice(0, query.limit)
          .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        hasMore: rows.length > query.limit,
      });
    }
    const binding = federationWorkflowBindings,
      reservation = federationReservations,
      agreement = federationAgreements;
    const rows = await tx
      .select({
        operationId: reservation.operationId,
        agreementRevisionId: reservation.agreementRevisionId,
        recipientSiteId: reservation.senderSiteId,
        workflowRunId: run.id,
        workflowName: run.name,
        createdAt: binding.createdAt,
      })
      .from(binding)
      .innerJoin(reservation, eq(reservation.id, binding.reservationId))
      .innerJoin(agreement, eq(agreement.revisionId, reservation.agreementRevisionId))
      .innerJoin(run, eq(run.id, binding.workflowRunId))
      .where(
        and(
          eq(agreement.targetSiteId, localSiteId),
          eq(agreement.localOrgId, actor.orgId),
          eq(run.submittedBy, agreement.executionUserId),
          eq(run.status, "completed"),
          eq(reservation.state, "reserved"),
          sql`${run.input}->>'federationReservationId' = ${reservation.id}::text`,
          sql`${binding.snapshot}->'identity'->>'orgId' = ${actor.orgId}`,
          sql`${binding.snapshot}->'identity'->>'userId' = ${agreement.executionUserId}::text`,
          sql`${binding.snapshot}->'request'->>'recipientSiteId' = ${localSiteId}`,
          sql`${binding.snapshot}->'request'->>'senderSiteId' = ${reservation.senderSiteId}::text`,
          sql`${binding.snapshot}->'request'->>'operationId' = ${reservation.operationId}::text`,
          sql`${binding.snapshot}->'request'->>'agreementRevisionId' = ${agreement.revisionId}::text`,
          sql`${binding.snapshot}->'request'->>'resultDelivery' = 'media'`,
          query.workflowRunId ? eq(run.id, query.workflowRunId) : undefined,
        ),
      )
      .orderBy(desc(binding.createdAt), desc(reservation.id))
      .limit(query.limit + 1)
      .offset(query.offset);
    return MediaTaskOptionsSchema.parse({
      localSiteId,
      localOrgId: actor.orgId,
      kind: query.kind,
      workflowRunId: query.workflowRunId ?? null,
      data: rows.slice(0, query.limit).map((row) => ({
        ...row,
        nodeId: null,
        invocationPath: null,
        createdAt: row.createdAt.toISOString(),
      })),
      hasMore: rows.length > query.limit,
    });
  });
}

/** A workflow filter narrows history without requiring the task to remain runnable. */
export function mediaWorkflowFilter(
  actor: FederationActor,
  localSiteId: string,
  workflowRunId: string,
  manifest: SQLWrapper,
) {
  const run = workflowRuns,
    delegation = workflowExecutionDelegations;
  const binding = federationWorkflowBindings,
    reservation = federationReservations,
    agreement = federationAgreements;
  const matches = (request: SQLWrapper) => sql`
    ${request}->>'operationId' = ${manifest}->'subject'->>'operationId'
    and ${request}->>'agreementRevisionId' = ${manifest}->>'agreementRevisionId'
    and ${request}->>'senderSiteId' = case when ${manifest}->'subject'->>'kind' = 'task-input' then ${manifest}->>'senderSiteId' else ${manifest}->>'recipientSiteId' end
    and ${request}->>'recipientSiteId' = case when ${manifest}->'subject'->>'kind' = 'task-input' then ${manifest}->>'recipientSiteId' else ${manifest}->>'senderSiteId' end`;
  return sql`(${manifest}->'subject'->>'kind' in ('task-input', 'task-result') and (
    exists (select 1 from ${delegation} inner join ${run} on ${run.id} = ${delegation.runId}
      where ${run.id} = ${workflowRunId} and ${delegation.localSiteId} = ${localSiteId}
      and ${run.submittedBy} = ${actor.userId} and ${run.input}->>'orgId' = ${actor.orgId}
      and ${run.input}->>'executionModel' = 'durable-v2'
      and ${run.input}->>'federationReservationId' is null and ${matches(delegation.request)})
    or exists (select 1 from ${binding}
      inner join ${reservation} on ${reservation.id} = ${binding.reservationId}
      inner join ${agreement} on ${agreement.revisionId} = ${reservation.agreementRevisionId}
      inner join ${run} on ${run.id} = ${binding.workflowRunId}
      where ${run.id} = ${workflowRunId} and ${agreement.targetSiteId} = ${localSiteId}
      and ${agreement.localOrgId} = ${actor.orgId} and ${run.submittedBy} = ${agreement.executionUserId}
      and ${run.input}->>'federationReservationId' = ${reservation.id}::text
      and ${binding.snapshot}->'identity'->>'orgId' = ${actor.orgId}
      and ${binding.snapshot}->'identity'->>'userId' = ${agreement.executionUserId}::text
      and ${matches(sql`${binding.snapshot}->'request'`)}
      and ${reservation.operationId}::text = ${manifest}->'subject'->>'operationId'
      and ${reservation.agreementRevisionId}::text = ${manifest}->>'agreementRevisionId')
  ))`;
}
