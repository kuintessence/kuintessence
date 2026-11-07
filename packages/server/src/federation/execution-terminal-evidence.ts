import {
  dataDeliveryRevocations,
  federationCancellations,
  federationInputImports,
  federationReservations,
  federationResultReceipts,
  federationTerminalEvidence,
  federationWorkflowBindings,
  jobCancellations,
  jobs,
  type PgTransaction,
  softwareOperations,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationDelegationSchema,
  FederationError,
  FederationExecutionTerminalEvidenceSchema,
  FederationResultReceiptSchema,
  FederationTerminalEvidenceSchema,
} from "@kuintessence/shared/federation";
import type { CommercialReservation } from "@kuintessence/shared/federation/commercial";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { loadFederationWorkflowBinding } from "./execution-binding";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type { FederationTrustRegistry } from "./trust-registry";

/** Caller holds the commercial reservation UPDATE lock, fencing all final dispatch checks. */
export async function collectExecutionTerminalEvidence(
  tx: PgTransaction,
  reserve: CommercialReservation,
  orgId: string,
  activationId: string,
  resultRequired: boolean,
  trust: FederationTrustRegistry,
  now: Date,
) {
  const request = reserve.request;
  const [reservation] = await tx
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, reserve.reservationId))
    .for("share", { noWait: true });
  if (
    !reservation ||
    reservation.operationId !== request.operationId ||
    reservation.senderSiteId !== request.senderSiteId ||
    reservation.agreementRevisionId !== request.agreementRevisionId ||
    reservation.taskId !== request.taskId ||
    reservation.attempt !== request.attempt
  )
    throw new FederationError("OPERATION_CONFLICT");
  const requestKeyId = federationMessageKeyId(reservation.requestJws);
  await trust.assertKey(tx, request.senderSiteId, requestKeyId, now);
  const requestKey = await trust.resolveKey(request.senderSiteId, requestKeyId, now, tx);
  const verifiedRequest = await verifyFederationMessage(
    FederationDelegationSchema,
    reservation.requestJws,
    requestKey,
    now,
  );
  if (
    verifiedRequest.digest !== reservation.requestDigest ||
    federationMaterialDigest(verifiedRequest.payload) !== federationMaterialDigest(request)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const runs = await tx
    .select({ run: workflowRuns })
    .from(workflowRuns)
    .leftJoin(
      federationWorkflowBindings,
      eq(federationWorkflowBindings.workflowRunId, workflowRuns.id),
    )
    .where(
      or(
        eq(federationWorkflowBindings.reservationId, reserve.reservationId),
        sql`${workflowRuns.input}->>'federationReservationId' = ${reserve.reservationId}`,
      ),
    )
    .limit(2)
    // Dispatch holds the run before the approval; never wait in the reverse order.
    .for("share", { of: workflowRuns, noWait: true });
  const run = runs[0]?.run;
  if (runs.length !== 1 || !run) throw new FederationError("OPERATION_CONFLICT");
  if (!["completed", "failed", "cancelled"].includes(run.status) || !run.completedAt)
    throw new FederationError("DATA_WAITING");
  if (run.completedAt > now || run.completedAt < new Date(request.issuedAt))
    throw new FederationError("OPERATION_CONFLICT");
  const binding = await loadFederationWorkflowBinding(tx, run.id);
  if (
    !binding ||
    binding.reservationId !== reserve.reservationId ||
    binding.snapshot.identity.orgId !== orgId ||
    binding.snapshot.requestDigest !== reservation.requestDigest ||
    federationMaterialDigest(binding.snapshot.request) !== federationMaterialDigest(request)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const [input] = await tx
    .select()
    .from(federationInputImports)
    .where(eq(federationInputImports.reservationId, reserve.reservationId))
    .for("share", { noWait: true });
  const [cancellation] = await tx
    .select()
    .from(federationCancellations)
    .where(
      and(
        eq(federationCancellations.localSiteId, request.recipientSiteId),
        eq(federationCancellations.senderSiteId, request.senderSiteId),
        eq(federationCancellations.operationId, request.operationId),
      ),
    )
    .for("share", { noWait: true });
  if (
    cancellation &&
    (cancellation.requestDigest !== reservation.requestDigest ||
      cancellation.agreementRevisionId !== request.agreementRevisionId)
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (
    cancellation &&
    (!cancellation.confirmedAt ||
      cancellation.confirmedAt > now ||
      (input && input.state !== "cancelled"))
  )
    throw new FederationError("DATA_WAITING");
  if (
    input &&
    (input.manifestDigest !== request.inputFilesDigest ||
      input.localOrgId !== orgId ||
      input.ownerId !== binding.snapshot.identity.userId ||
      input.localSiteId !== request.recipientSiteId)
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (input && !["available", "cancelled"].includes(input.state))
    throw new FederationError("DATA_WAITING");
  const invocations = await tx
    .select()
    .from(workflowExecutionJobs)
    .where(eq(workflowExecutionJobs.runId, run.id))
    .orderBy(asc(workflowExecutionJobs.jobId))
    .limit(4097);
  if (
    invocations.length > 4096 ||
    Object.values(run.stepJobs).some((id) => !invocations.some((row) => row.jobId === id))
  )
    throw new FederationError("OPERATION_CONFLICT");
  const ids = invocations.map((row) => row.jobId);
  const rows = ids.length
    ? await tx
        .select()
        .from(jobs)
        .where(inArray(jobs.id, ids))
        .orderBy(asc(jobs.id))
        .for("share", { noWait: true })
    : [];
  if (rows.length !== ids.length) throw new FederationError("OPERATION_CONFLICT");
  const observations = ids.length
    ? await tx
        .select()
        .from(federationTerminalEvidence)
        .where(inArray(federationTerminalEvidence.jobId, ids))
    : [];
  const cancellations = ids.length
    ? await tx
        .select()
        .from(jobCancellations)
        .where(inArray(jobCancellations.jobId, ids))
        .orderBy(asc(jobCancellations.id))
        .for("share", { noWait: true })
    : [];
  const revocations = ids.length
    ? await tx
        .select()
        .from(dataDeliveryRevocations)
        .where(inArray(dataDeliveryRevocations.jobId, ids))
        .orderBy(asc(dataDeliveryRevocations.id))
        .for("share", { noWait: true })
    : [];
  const installations = ids.length
    ? await tx
        .select()
        .from(softwareOperations)
        .where(inArray(softwareOperations.federationJobId, ids))
        .orderBy(asc(softwareOperations.id))
        .for("share", { noWait: true })
    : [];
  const evidenceJobs = rows.map((job) => {
    if (!["completed", "failed", "cancelled"].includes(job.status))
      throw new FederationError("DATA_WAITING");
    const saved = observations.find((row) => row.jobId === job.id);
    if (!saved) throw new FederationError("OPERATION_CONFLICT");
    const evidence = FederationTerminalEvidenceSchema.parse(saved.evidence);
    if (
      saved.digest !== federationMaterialDigest(evidence) ||
      saved.reservationId !== reserve.reservationId ||
      saved.workflowRunId !== run.id ||
      evidence.jobId !== job.id ||
      evidence.runId !== run.id ||
      evidence.reservationId !== reserve.reservationId ||
      evidence.agreementRevisionId !== request.agreementRevisionId ||
      evidence.requestDigest !== reservation.requestDigest ||
      evidence.executionSnapshotDigest !== binding.snapshotDigest ||
      evidence.sourceSiteId !== request.senderSiteId ||
      evidence.targetSiteId !== request.recipientSiteId ||
      evidence.taskId !== request.taskId ||
      evidence.attempt !== request.attempt ||
      evidence.status !== job.status ||
      evidence.dispatchEpoch !== job.dispatchEpoch ||
      evidence.scheduler.agentId !== job.agentId ||
      evidence.scheduler.jobId !== job.schedulerJobId ||
      evidence.invocationPathHash !== invocations.find((row) => row.jobId === job.id)?.pathHash ||
      evidence.observation.terminalObservedAt !== job.completedAt?.toISOString() ||
      new Date(evidence.observation.terminalObservedAt) > now ||
      new Date(evidence.observation.terminalObservedAt) < new Date(request.issuedAt) ||
      evidence.observation.quality === "clock-inconsistent" ||
      job.orgId !== orgId ||
      job.submittedBy !== binding.snapshot.identity.userId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const stops = cancellations.filter((row) => row.jobId === job.id);
    const revoked = revocations.filter((row) => row.jobId === job.id);
    // Legacy createdAt uses database-local timestamp; acknowledgement is written by Server in UTC.
    for (const row of [...stops, ...revoked])
      if (!row.acknowledgedAt || row.acknowledgedAt > now)
        throw new FederationError("DATA_WAITING");
    const agentObserved = evidence.source === "agent-status" && evidence.agentEventId !== null;
    const neverDispatched =
      evidence.previousStatus === "pending" && job.dispatchEpoch === 0 && job.agentId === null;
    const stopped =
      job.agentId !== null &&
      [...stops, ...revoked].some(
        (row) =>
          row.agentId === job.agentId &&
          row.revokedEpoch >= job.revokedEpoch &&
          row.revokedEpoch > evidence.dispatchEpoch,
      );
    if (!agentObserved && !neverDispatched && !stopped) throw new FederationError("DATA_WAITING");
    const installEvidence = installations
      .filter((row) => row.federationJobId === job.id)
      .map((row) => {
        const stop = stops.find(
          (stop) =>
            stop.agentId === row.agentId &&
            stop.requiresInstallationStop &&
            stop.revokedEpoch >= job.revokedEpoch &&
            stop.revokedEpoch > evidence.dispatchEpoch,
        );
        if (
          !stop &&
          (!["succeeded", "failed", "rejected"].includes(row.status) ||
            !row.finishedAt ||
            row.finishedAt > now)
        )
          throw new FederationError("DATA_WAITING");
        return {
          id: row.id,
          agentId: row.agentId,
          status: row.status,
          finishedAt: row.finishedAt?.toISOString() ?? null,
          stopAcknowledgementId: stop?.id ?? null,
        };
      });
    return {
      evidence,
      digest: saved.digest,
      cancellations: stops.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        revokedEpoch: row.revokedEpoch,
        requiresInstallationStop: row.requiresInstallationStop,
        acknowledgedAt: row.acknowledgedAt?.toISOString(),
      })),
      revocations: revoked.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        revokedEpoch: row.revokedEpoch,
        destroyRestrictedWorkRoot: row.destroyRestrictedWorkRoot,
        acknowledgedAt: row.acknowledgedAt?.toISOString(),
      })),
      installations: installEvidence,
    };
  });
  let result = null;
  if (run.status === "completed" && resultRequired) {
    const receipts = await tx
      .select()
      .from(federationResultReceipts)
      .where(
        and(
          eq(federationResultReceipts.localSiteId, request.recipientSiteId),
          eq(federationResultReceipts.reservationId, reserve.reservationId),
          eq(federationResultReceipts.senderSiteId, request.senderSiteId),
        ),
      )
      .orderBy(asc(federationResultReceipts.receiptId))
      .limit(257);
    if (!receipts.length) throw new FederationError("DATA_WAITING");
    if (
      receipts.length > 256 ||
      new Set(receipts.map((row) => row.receipt.manifestDigest)).size !== 1
    )
      throw new FederationError("OPERATION_CONFLICT");
    const saved = receipts[0];
    if (!saved) throw new FederationError("DATA_WAITING");
    const keyId = federationMessageKeyId(saved.receiptJws);
    await trust.assertKey(tx, request.senderSiteId, keyId, now);
    const key = await trust.resolveKey(request.senderSiteId, keyId, now, tx);
    const verified = await verifyFederationMessage(
      FederationResultReceiptSchema,
      saved.receiptJws,
      key,
      now,
    );
    const receipt = verified.payload;
    if (
      verified.digest !== saved.digest ||
      federationMaterialDigest(receipt) !== federationMaterialDigest(saved.receipt) ||
      receipt.senderSiteId !== request.senderSiteId ||
      receipt.recipientSiteId !== request.recipientSiteId ||
      receipt.reservationId !== reserve.reservationId ||
      receipt.operationId !== request.operationId ||
      receipt.agreementRevisionId !== request.agreementRevisionId ||
      receipt.taskId !== request.taskId ||
      receipt.attempt !== request.attempt ||
      receipt.requestDigest !== reservation.requestDigest ||
      new Date(receipt.receivedAt) > now ||
      new Date(receipt.receivedAt).getTime() < run.completedAt.getTime() - 60000
    )
      throw new FederationError("OPERATION_CONFLICT");
    result = { receipt, receiptJws: saved.receiptJws };
  }
  return FederationExecutionTerminalEvidenceSchema.parse({
    version: 1,
    reservationId: reserve.reservationId,
    activationId,
    requestDigest: reservation.requestDigest,
    executionSnapshotDigest: binding.snapshotDigest,
    workflow: { runId: run.id, status: run.status, completedAt: run.completedAt.toISOString() },
    jobs: evidenceJobs,
    input: input
      ? { importId: input.id, manifestDigest: input.manifestDigest, state: input.state }
      : null,
    cancellation: cancellation
      ? {
          digest: cancellation.cancellationDigest,
          confirmedAt: cancellation.confirmedAt?.toISOString(),
        }
      : null,
    result,
    observedAt: now.toISOString(),
  });
}
