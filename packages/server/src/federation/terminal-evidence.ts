import {
  agents,
  federationReservations,
  federationTerminalEvidence,
  federationWorkflowBindings,
  jobs,
  type PgTransaction,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import { type SchedulerAccounting, SchedulerAccountingSchema } from "@kuintessence/shared";
import {
  FederationError,
  type FederationTerminalEvidence,
  FederationTerminalEvidenceSchema,
} from "@kuintessence/shared/federation";
import { eq, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";

/** Called inside the terminal write transaction, with the Job row already locked. */
export async function persistFederationTerminalEvidence(
  tx: PgTransaction,
  jobId: string,
  before: { status: string; startedAt: Date | null },
  source: FederationTerminalEvidence["source"],
  agentEventId?: string,
  rawAccounting?: SchedulerAccounting,
) {
  const [execution] = await tx
    .select({
      runId: workflowExecutionJobs.runId,
      pathHash: workflowExecutionJobs.pathHash,
      runInput: workflowRuns.input,
      binding: federationWorkflowBindings,
      reservation: federationReservations,
    })
    .from(workflowExecutionJobs)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowExecutionJobs.runId))
    .leftJoin(
      federationWorkflowBindings,
      eq(federationWorkflowBindings.workflowRunId, workflowRuns.id),
    )
    .leftJoin(
      federationReservations,
      eq(federationReservations.id, federationWorkflowBindings.reservationId),
    )
    .where(eq(workflowExecutionJobs.jobId, jobId));
  if (!execution) return;
  const { binding, reservation } = execution;
  if (!binding) {
    if (execution.runInput?.federationReservationId)
      throw new FederationError("OPERATION_CONFLICT");
    return;
  }
  const { request, identity } = binding.snapshot;
  if (
    !reservation ||
    execution.runInput?.federationReservationId !== reservation.id ||
    federationMaterialDigest(binding.snapshot) !== binding.snapshotDigest ||
    binding.snapshot.requestDigest !== reservation.requestDigest ||
    request.agreementRevisionId !== reservation.agreementRevisionId ||
    request.taskId !== reservation.taskId ||
    request.attempt !== reservation.attempt ||
    request.senderSiteId !== reservation.senderSiteId
  )
    throw new FederationError("OPERATION_CONFLICT");

  const [row] = await tx
    .select({
      job: jobs,
      memoryMb: sql<string>`${jobs.memoryMb}::text`,
      schedulerType: agents.schedulerType,
    })
    .from(jobs)
    .leftJoin(agents, eq(agents.agentId, jobs.agentId))
    .where(eq(jobs.id, jobId));
  if (
    !row?.job.completedAt ||
    row.job.orgId !== identity.orgId ||
    row.job.submittedBy !== identity.userId
  )
    throw new FederationError("OPERATION_CONFLICT");
  const { job } = row;
  const accounting =
    rawAccounting === undefined ? undefined : SchedulerAccountingSchema.parse(rawAccounting);
  if (
    accounting &&
    (source !== "agent-status" ||
      accounting.schedulerJobId !== job.schedulerJobId ||
      (accounting.source === "slurm-sacct"
        ? row.schedulerType !== "slurm"
        : row.schedulerType !== "pbs-pro"))
  )
    throw new FederationError("OPERATION_CONFLICT");
  const ended = row.job.completedAt;
  // JobService may synthesize startedAt at termination; preserve the pre-transition observation.
  const started = before.startedAt;
  const evidence = FederationTerminalEvidenceSchema.parse({
    version: 1,
    jobId,
    runId: execution.runId,
    reservationId: reservation.id,
    agreementRevisionId: reservation.agreementRevisionId,
    taskId: reservation.taskId,
    attempt: reservation.attempt,
    sourceSiteId: request.senderSiteId,
    targetSiteId: request.recipientSiteId,
    requestDigest: reservation.requestDigest,
    executionSnapshotDigest: binding.snapshotDigest,
    invocationPathHash: execution.pathHash,
    status: job.status,
    previousStatus: before.status,
    source,
    agentEventId: agentEventId ?? null,
    dispatchEpoch: job.dispatchEpoch,
    requested: {
      cpus: String(job.cpus),
      gpus: job.gpus === null ? null : String(job.gpus),
      memoryMb: row.memoryMb,
    },
    scheduler: {
      agentId: job.agentId,
      type: row.schedulerType,
      jobId: job.schedulerJobId,
      queueId: job.queueId,
      node: job.node,
      exitCode: job.exitCode,
    },
    ...(accounting ? { accounting } : {}),
    observation: {
      basis: "server-status-observation",
      runningObservedAt: started?.toISOString() ?? null,
      terminalObservedAt: ended.toISOString(),
      quality: !started
        ? "start-unobserved"
        : started > ended
          ? "clock-inconsistent"
          : "observed-interval",
      schedulerAccounting: accounting ? "reported" : "unavailable",
    },
  });
  // A conflicting second insert aborts the transition; no overwrite or silent evidence loss.
  await tx.insert(federationTerminalEvidence).values({
    jobId,
    reservationId: reservation.id,
    workflowRunId: execution.runId,
    evidence,
    digest: federationMaterialDigest(evidence),
  });
}
