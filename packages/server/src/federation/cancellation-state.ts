import {
  dataDeliveryRevocations,
  federationInputImports,
  federationReservations,
  federationWorkflowBindings,
  jobCancellations,
  jobs,
  type PgDb,
  type PgTransaction,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

export async function readFederationCancellationState(
  db: PgDb | PgTransaction,
  request: { senderSiteId: string; operationId: string },
) {
  const [reservation] = await db
    .select({ id: federationReservations.id })
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.senderSiteId, request.senderSiteId),
        eq(federationReservations.operationId, request.operationId),
      ),
    );
  const runs = reservation
    ? await db
        .select({ run: workflowRuns })
        .from(workflowRuns)
        .leftJoin(
          federationWorkflowBindings,
          eq(federationWorkflowBindings.workflowRunId, workflowRuns.id),
        )
        .where(
          or(
            eq(federationWorkflowBindings.reservationId, reservation.id),
            sql`${workflowRuns.input}->>'federationReservationId' = ${reservation.id}`,
          ),
        )
    : [];
  const run = runs.length === 1 ? runs[0]?.run : undefined;
  let stopped = runs.length === 0;
  if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
    const invocations = await db
      .select({ jobId: workflowExecutionJobs.jobId })
      .from(workflowExecutionJobs)
      .where(eq(workflowExecutionJobs.runId, run.id));
    const ids = [...new Set([...Object.values(run.stepJobs), ...invocations.map((v) => v.jobId)])];
    const states = ids.length
      ? await db.select({ status: jobs.status }).from(jobs).where(inArray(jobs.id, ids))
      : [];
    const pending = ids.length
      ? await db
          .select({ id: jobCancellations.id })
          .from(jobCancellations)
          .where(and(inArray(jobCancellations.jobId, ids), isNull(jobCancellations.acknowledgedAt)))
          .limit(1)
      : [];
    const revocations = ids.length
      ? await db
          .select({ id: dataDeliveryRevocations.id })
          .from(dataDeliveryRevocations)
          .where(
            and(
              inArray(dataDeliveryRevocations.jobId, ids),
              isNull(dataDeliveryRevocations.acknowledgedAt),
            ),
          )
          .limit(1)
      : [];
    stopped =
      states.length === ids.length &&
      states.every((v) => ["completed", "failed", "cancelled"].includes(v.status)) &&
      pending.length === 0 &&
      revocations.length === 0;
  }
  if (stopped && reservation) {
    const [input] = await db
      .select({ state: federationInputImports.state })
      .from(federationInputImports)
      .where(eq(federationInputImports.reservationId, reservation.id));
    if (input && input.state !== "cancelled") stopped = false;
  }
  return {
    reservationId: reservation?.id ?? null,
    runs: runs.map((v) => v.run.id),
    stopped,
    workflow: run ? { status: run.status, updatedAt: run.updatedAt.toISOString() } : null,
  };
}
