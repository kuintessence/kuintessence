import { federationOutbound, federationResultImports, type PgTransaction } from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationCancellationReceiptSchema,
  FederationDelegationSchema,
  FederationError,
  FederationResultReceiptSchema,
  FederationResultReportSchema,
  FederationStatusReportSchema,
  FederationTerminalSourceReviewSchema,
} from "@kuintessence/shared/federation";
import type { CommercialReservation } from "@kuintessence/shared/federation/commercial";
import type { FederationTerminalProposal } from "@kuintessence/shared/federation/terminal-proposal";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import type { FederationTrustRegistry } from "./trust-registry";

/** The provider commits these observations, not an independent proof of scientific correctness. */
function inspectEvidence(
  proposal: FederationTerminalProposal,
  reserve: CommercialReservation,
  requestDigest: string,
  now: Date,
) {
  const { payload, evidence } = proposal;
  const request = reserve.request;
  if (
    federationMaterialDigest(evidence) !== payload.executionEvidenceDigest ||
    evidence.reservationId !== reserve.reservationId ||
    evidence.activationId !== payload.activationId ||
    evidence.requestDigest !== requestDigest ||
    evidence.workflow.status !== payload.outcome ||
    evidence.observedAt !== payload.observedAt ||
    new Date(payload.issuedAt) > now ||
    new Date(evidence.workflow.completedAt) > new Date(evidence.observedAt) ||
    new Date(evidence.workflow.completedAt) < new Date(request.issuedAt) ||
    (evidence.result?.receipt.manifestDigest ?? null) !== payload.resultManifestDigest ||
    (evidence.result !== null && payload.outcome !== "completed") ||
    new Set(evidence.jobs.map((row) => row.evidence.jobId)).size !== evidence.jobs.length ||
    new Set(evidence.jobs.map((row) => row.evidence.invocationPathHash)).size !==
      evidence.jobs.length
  )
    throw new FederationError("OPERATION_CONFLICT");
  for (const row of evidence.jobs) {
    const job = row.evidence;
    if (
      row.digest !== federationMaterialDigest(job) ||
      job.reservationId !== reserve.reservationId ||
      job.requestDigest !== requestDigest ||
      job.agreementRevisionId !== request.agreementRevisionId ||
      job.runId !== evidence.workflow.runId ||
      job.executionSnapshotDigest !== evidence.executionSnapshotDigest ||
      job.taskId !== request.taskId ||
      job.attempt !== request.attempt ||
      job.sourceSiteId !== request.senderSiteId ||
      job.targetSiteId !== request.recipientSiteId ||
      new Date(job.observation.terminalObservedAt) > new Date(evidence.observedAt) ||
      new Date(job.observation.terminalObservedAt) < new Date(request.issuedAt) ||
      job.observation.quality === "clock-inconsistent"
    )
      throw new FederationError("OPERATION_CONFLICT");
    for (const stop of [...row.cancellations, ...row.revocations])
      if (new Date(stop.acknowledgedAt) > new Date(evidence.observedAt))
        throw new FederationError("OPERATION_CONFLICT");
    const stopped = [...row.cancellations, ...row.revocations].some(
      (stop) => stop.agentId === job.scheduler.agentId && stop.revokedEpoch > job.dispatchEpoch,
    );
    if (
      !(job.source === "agent-status" && job.agentEventId !== null) &&
      !(
        job.previousStatus === "pending" &&
        job.dispatchEpoch === 0 &&
        job.scheduler.agentId === null
      ) &&
      !stopped
    )
      throw new FederationError("OPERATION_CONFLICT");
    for (const installation of row.installations) {
      if (installation.stopAcknowledgementId !== null) {
        if (
          !row.cancellations.some(
            (stop) =>
              stop.id === installation.stopAcknowledgementId &&
              stop.agentId === installation.agentId &&
              stop.requiresInstallationStop &&
              stop.revokedEpoch > job.dispatchEpoch,
          )
        )
          throw new FederationError("OPERATION_CONFLICT");
      } else if (
        !["succeeded", "failed", "rejected"].includes(installation.status) ||
        !installation.finishedAt ||
        new Date(installation.finishedAt) > new Date(evidence.observedAt)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
  }
  if (evidence.input && evidence.input.manifestDigest !== request.inputFilesDigest)
    throw new FederationError("OPERATION_CONFLICT");
  if (
    evidence.cancellation &&
    (new Date(evidence.cancellation.confirmedAt) > new Date(evidence.observedAt) ||
      (evidence.input && evidence.input.state !== "cancelled"))
  )
    throw new FederationError("OPERATION_CONFLICT");
}

/** Caller holds its commercial approval UPDATE lock; all local evidence is read under shared locks. */
export async function reviewExecutionTerminalSource(
  tx: PgTransaction,
  trust: FederationTrustRegistry,
  orgId: string,
  reserve: CommercialReservation,
  proposal: FederationTerminalProposal,
  resultRequired: boolean,
  now: Date,
) {
  const request = reserve.request;
  const verify = async <T extends { kind: string }>(
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) => {
    const keyId = federationMessageKeyId(jws);
    await trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      schema,
      jws,
      await trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  };
  const [outbound] = await tx
    .select()
    .from(federationOutbound)
    .where(
      and(
        eq(federationOutbound.localSiteId, request.senderSiteId),
        eq(federationOutbound.localOrgId, orgId),
        eq(federationOutbound.operationId, request.operationId),
        eq(federationOutbound.agreementRevisionId, request.agreementRevisionId),
      ),
    )
    .for("share", { noWait: true });
  if (
    !outbound ||
    outbound.state !== "accepted" ||
    !outbound.receipt ||
    !outbound.receiptJws ||
    !outbound.statusReport ||
    !outbound.statusReportJws ||
    !outbound.statusVerifiedAt
  )
    throw new FederationError("DATA_WAITING");
  const delegation = await verify(
    FederationDelegationSchema,
    outbound.requestJws,
    request.senderSiteId,
  );
  if (
    delegation.digest !== outbound.requestDigest ||
    federationMaterialDigest(delegation.payload) !== federationMaterialDigest(request) ||
    federationMaterialDigest(outbound.request) !== federationMaterialDigest(request) ||
    outbound.taskId !== request.taskId ||
    outbound.attempt !== request.attempt
  )
    throw new FederationError("OPERATION_CONFLICT");
  const matches = (
    message: {
      senderSiteId: string;
      recipientSiteId: string;
      operationId: string;
      agreementRevisionId: string;
      taskId: string;
      attempt: number;
      reservationId: string | null;
      requestDigest: string;
    },
    source: boolean,
  ) =>
    message.senderSiteId === (source ? request.senderSiteId : request.recipientSiteId) &&
    message.recipientSiteId === (source ? request.recipientSiteId : request.senderSiteId) &&
    message.operationId === request.operationId &&
    message.agreementRevisionId === request.agreementRevisionId &&
    message.taskId === request.taskId &&
    message.attempt === request.attempt &&
    message.reservationId === reserve.reservationId &&
    message.requestDigest === outbound.requestDigest;
  const acceptance = await verify(
    FederationAcceptanceSchema,
    outbound.receiptJws,
    request.recipientSiteId,
  );
  if (
    !matches(acceptance.payload, false) ||
    acceptance.payload.mode !== request.mode ||
    acceptance.payload.budgetDomainId !== request.budgetDomainId ||
    acceptance.payload.epoch !== request.epoch ||
    acceptance.payload.unit !== request.unit ||
    acceptance.payload.reservedAmount !== request.maxAmount ||
    federationMaterialDigest(acceptance.payload) !== federationMaterialDigest(outbound.receipt)
  )
    throw new FederationError("OPERATION_CONFLICT");
  inspectEvidence(proposal, reserve, outbound.requestDigest, now);
  const status = await verify(
    FederationStatusReportSchema,
    outbound.statusReportJws,
    request.recipientSiteId,
  );
  if (
    !matches(status.payload, false) ||
    federationMaterialDigest(status.payload) !== federationMaterialDigest(outbound.statusReport) ||
    status.payload.workflow?.status !== proposal.payload.outcome ||
    new Date(status.payload.observedAt) > now ||
    new Date(status.payload.observedAt) < new Date(proposal.evidence.workflow.completedAt)
  )
    throw new FederationError("OPERATION_CONFLICT");
  let result = null;
  if (proposal.payload.outcome === "completed" && resultRequired) {
    const promised = proposal.evidence.result;
    if (!promised || !proposal.payload.resultManifestDigest)
      throw new FederationError("DATA_WAITING");
    const peerReceipt = await verify(
      FederationResultReceiptSchema,
      promised.receiptJws,
      request.senderSiteId,
    );
    if (
      !matches(peerReceipt.payload, true) ||
      federationMaterialDigest(peerReceipt.payload) !== federationMaterialDigest(promised.receipt)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [imported] = await tx
      .select()
      .from(federationResultImports)
      .where(
        and(
          eq(federationResultImports.localSiteId, request.senderSiteId),
          eq(federationResultImports.localOrgId, orgId),
          eq(federationResultImports.operationId, request.operationId),
          eq(federationResultImports.state, "available"),
          eq(federationResultImports.manifestDigest, proposal.payload.resultManifestDigest),
          sql`${federationResultImports.receipt}->>'receiptId' = ${promised.receipt.receiptId}`,
        ),
      )
      .orderBy(asc(federationResultImports.id))
      .limit(1)
      .for("share", { noWait: true });
    if (!imported?.receipt || !imported.receiptJws) throw new FederationError("DATA_WAITING");
    const receipt = await verify(
      FederationResultReceiptSchema,
      imported.receiptJws,
      request.senderSiteId,
    );
    const report = await verify(
      FederationResultReportSchema,
      imported.reportJws,
      request.recipientSiteId,
    );
    if (
      receipt.digest !== peerReceipt.digest ||
      federationMaterialDigest(receipt.payload) !== federationMaterialDigest(imported.receipt) ||
      !matches(report.payload, false) ||
      federationMaterialDigest(report.payload) !== federationMaterialDigest(imported.report) ||
      report.payload.manifestDigest !== imported.manifestDigest ||
      federationMaterialDigest(report.payload.manifest) !== imported.manifestDigest ||
      federationMaterialDigest(report.payload.manifest.template) !==
        federationMaterialDigest(request.template) ||
      report.payload.manifest.inputManifestDigest !== request.inputManifestDigest ||
      report.payload.manifest.environmentLockDigest !== request.environmentLockDigest ||
      report.payload.manifest.completedAt !== proposal.evidence.workflow.completedAt ||
      receipt.payload.fileCount !==
        report.payload.manifest.outputs.reduce((sum, output) => sum + output.files.length, 0) ||
      receipt.payload.sizeBytes !==
        report.payload.manifest.outputs.reduce((sum, output) => sum + output.sizeBytes, 0)
    )
      throw new FederationError("OPERATION_CONFLICT");
    result = {
      importId: imported.id,
      receiptDigest: receipt.digest,
      reportJws: imported.reportJws,
    };
  } else if (proposal.evidence.result !== null || proposal.payload.resultManifestDigest !== null)
    throw new FederationError("OPERATION_CONFLICT");
  let cancellation = null;
  if (outbound.cancelState) {
    if (
      outbound.cancelState !== "stopped" ||
      !outbound.cancelReceipt ||
      !outbound.cancelReceiptJws ||
      !proposal.evidence.cancellation
    )
      throw new FederationError("DATA_WAITING");
    const receipt = await verify(
      FederationCancellationReceiptSchema,
      outbound.cancelReceiptJws,
      request.recipientSiteId,
    );
    if (
      !matches(receipt.payload, false) ||
      receipt.payload.state !== "stopped" ||
      federationMaterialDigest(receipt.payload) !==
        federationMaterialDigest(outbound.cancelReceipt) ||
      receipt.payload.cancellationDigest !== outbound.cancelDigest ||
      proposal.evidence.cancellation.digest !== outbound.cancelDigest ||
      receipt.payload.workflow?.status !== proposal.payload.outcome ||
      new Date(receipt.payload.observedAt) > now
    )
      throw new FederationError("OPERATION_CONFLICT");
    cancellation = { receiptDigest: receipt.digest, receiptJws: outbound.cancelReceiptJws };
  } else if (proposal.evidence.cancellation !== null)
    throw new FederationError("OPERATION_CONFLICT");
  return FederationTerminalSourceReviewSchema.parse({
    requestDigest: outbound.requestDigest,
    requestJws: outbound.requestJws,
    acceptanceDigest: acceptance.digest,
    acceptanceJws: outbound.receiptJws,
    statusDigest: status.digest,
    statusReportJws: outbound.statusReportJws,
    result,
    cancellation,
    reviewedAt: now.toISOString(),
  });
}
