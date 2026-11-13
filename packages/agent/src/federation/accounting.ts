import {
  FederationAccountingObservationSchema,
  type FederationAccountingRequest,
  FederationAccountingRequestSchema,
  type FederationAccountingResponse,
} from "@kuintessence/shared/federation";
import type { SchedulerAdapter } from "../adapters/base";
import { jsonToPreparedRemoteJob } from "../queue/active-remote-jobs";
import { FederationDispatchReceiptSchema } from "../queue/federation-dispatch";
import type { InboundAcks } from "../queue/inbound-acks";

/** Uses retained dispatch identity, even after execution authority was revoked. Never runs a job. */
export async function collectFederationAccounting(
  receipts: InboundAcks | undefined,
  adapter: Pick<SchedulerAdapter, "type" | "findByKuintessenceJobId" | "status">,
  raw: FederationAccountingRequest,
): Promise<FederationAccountingResponse> {
  const request = FederationAccountingRequestSchema.parse(raw);
  const unavailable = { request, state: "unavailable" as const };
  const fresh = () => {
    const issued = Date.parse(request.issuedAt),
      end = Date.parse(request.expiresAt);
    return (
      issued <= Date.now() + 60000 && end > Date.now() && end > issued && end - issued <= 120000
    );
  };
  if (!fresh() || !receipts || !["slurm", "pbs-pro"].includes(adapter.type)) return unavailable;
  const row = await receipts.get(`${request.jobId}:${request.dispatchEpoch}`);
  if (
    !row ||
    row.payload.federationExecution !== true ||
    row.payload.federationSubmissionStarted !== true
  )
    return { request, state: "identity_mismatch" };
  const receipt = FederationDispatchReceiptSchema.parse(row.payload.federationReceipt);
  const { spec } = jsonToPreparedRemoteJob(row.payload.federationSubmission);
  if (
    receipt.epoch !== request.dispatchEpoch ||
    spec.jobId !== request.jobId ||
    spec.federationDispatchEpoch !== request.dispatchEpoch
  )
    return { request, state: "identity_mismatch" };
  const identity = spec.sandbox?.identity;
  const lookup = {
    jobId: spec.jobId,
    federationDispatchEpoch: spec.federationDispatchEpoch,
    schedulerName: spec.schedulerName,
    submittedAfterUnixMs: row.receivedAt.getTime(),
    ...(identity?.backend === "Unix" && identity.schedulerAccount
      ? { schedulerAccount: identity.schedulerAccount }
      : {}),
  };
  const before = await adapter.findByKuintessenceJobId?.(lookup);
  if (before?.status !== "found") return unavailable;
  if (before.schedulerJobId !== request.schedulerJobId)
    return { request, state: "identity_mismatch" };
  const result = await adapter.status(request.schedulerJobId);
  if (result.status !== "completed" && result.status !== "failed")
    return { request, state: "not_terminal" };
  if (!result.accounting) return unavailable;
  // Check again so recycling the scheduler ID during collection cannot attach another job's usage.
  const after = await adapter.findByKuintessenceJobId?.(lookup);
  if (!fresh() || after?.status !== "found" || after.schedulerJobId !== request.schedulerJobId)
    return unavailable;
  if (
    result.accounting.schedulerJobId !== request.schedulerJobId ||
    result.accounting.source !== (adapter.type === "slurm" ? "slurm-sacct" : "pbs-qstat")
  )
    return { request, state: "identity_mismatch" };
  return {
    request,
    state: "observed",
    observation: FederationAccountingObservationSchema.parse({
      version: 1,
      requestId: request.requestId,
      jobId: request.jobId,
      dispatchEpoch: request.dispatchEpoch,
      originalEvidenceDigest: request.originalEvidenceDigest,
      terminalStatus: result.status,
      accounting: result.accounting,
    }),
  };
}
