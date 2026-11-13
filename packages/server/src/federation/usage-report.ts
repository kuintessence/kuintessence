import { schedulerAccountingSource } from "@kuintessence/shared";
import {
  type FederationAccountingObservation,
  FederationAccountingObservationSchema,
  FederationAmountSchema,
  type FederationTerminalEvidence,
  FederationTerminalEvidenceSchema,
} from "@kuintessence/shared/federation";
import {
  type CommercialAgreement,
  CommercialAgreementSchema,
  type CommercialUsage,
  type CommercialUsageEvidenceSet,
  type CommercialUsageGap,
  commercialAutomaticMeters,
} from "@kuintessence/shared/federation/commercial";
import { federationMaterialDigest } from "./assets";

export type UsageEvidence = {
  evidence: FederationTerminalEvidence;
  digest: string;
  accountingObservation?: { observation: FederationAccountingObservation; digest: string };
};
export type UsageAggregation =
  | { state: "missing_data"; gaps: CommercialUsageGap[] }
  | { state: "needs_review"; reason: "EVIDENCE_CONFLICT" | "QUANTITY_OVERFLOW" | "EVIDENCE_LIMIT" }
  | {
      state: "ready";
      measurements: CommercialUsage["measurements"];
      evidenceSet: CommercialUsageEvidenceSet;
    };

/** Sums each leaf Job once. Never derives CPU consumption from requests or Server timestamps. */
export function aggregateCommercialUsage(
  rawTerms: CommercialAgreement,
  scope: {
    reservationId: string;
    runId: string;
    taskId: string;
    attempt: number;
    requestDigest: string;
    executionSnapshotDigest: string;
  },
  rows: UsageEvidence[],
): UsageAggregation {
  const terms = CommercialAgreementSchema.parse(rawTerms);
  // The evidence commitment must stay within the existing one-MiB canonical-message limit.
  if (rows.length > 4096) return { state: "needs_review", reason: "EVIDENCE_LIMIT" };
  const jobs = new Set<string>();
  const parsed: UsageEvidence[] = [];
  for (const row of rows) {
    const result = FederationTerminalEvidenceSchema.safeParse(row.evidence);
    if (!result.success) return { state: "needs_review", reason: "EVIDENCE_CONFLICT" };
    const evidence = result.data;
    if (
      jobs.has(evidence.jobId) ||
      evidence.reservationId !== scope.reservationId ||
      evidence.runId !== scope.runId ||
      evidence.taskId !== scope.taskId ||
      evidence.attempt !== scope.attempt ||
      evidence.requestDigest !== scope.requestDigest ||
      evidence.executionSnapshotDigest !== scope.executionSnapshotDigest ||
      evidence.agreementRevisionId !== terms.agreement.agreementRevisionId ||
      evidence.sourceSiteId !== terms.agreement.sourceSiteId ||
      evidence.targetSiteId !== terms.agreement.targetSiteId ||
      federationMaterialDigest(evidence) !== row.digest ||
      (evidence.accounting &&
        (evidence.source !== "agent-status" ||
          evidence.observation.schedulerAccounting !== "reported" ||
          evidence.accounting.schedulerJobId !== evidence.scheduler.jobId ||
          evidence.accounting.source !==
            schedulerAccountingSource(evidence.scheduler.type ?? undefined))) ||
      (!evidence.accounting && evidence.observation.schedulerAccounting === "reported")
    )
      return { state: "needs_review", reason: "EVIDENCE_CONFLICT" };
    if (row.accountingObservation) {
      const checked = FederationAccountingObservationSchema.safeParse(
        row.accountingObservation.observation,
      );
      if (!checked.success) return { state: "needs_review", reason: "EVIDENCE_CONFLICT" };
      const sample = checked.data;
      if (
        sample.jobId !== evidence.jobId ||
        sample.dispatchEpoch !== evidence.dispatchEpoch ||
        sample.originalEvidenceDigest !== row.digest ||
        federationMaterialDigest(sample) !== row.accountingObservation.digest ||
        sample.accounting.schedulerJobId !== evidence.scheduler.jobId ||
        sample.accounting.source !== schedulerAccountingSource(evidence.scheduler.type ?? undefined)
      )
        return { state: "needs_review", reason: "EVIDENCE_CONFLICT" };
    }
    jobs.add(evidence.jobId);
    parsed.push({
      evidence,
      digest: row.digest,
      ...(row.accountingObservation ? { accountingObservation: row.accountingObservation } : {}),
    });
  }
  const gaps: CommercialUsageGap[] = [];
  const quantities: { metric: string; quantityUnit: string; quantity: string }[] = [];
  for (const price of terms.prices) {
    if (
      !commercialAutomaticMeters.some(
        (meter) => meter.metric === price.metric && meter.quantityUnit === price.quantityUnit,
      )
    ) {
      gaps.push({ metric: price.metric, reason: "UNSUPPORTED_METER" });
      continue;
    }
    if (!parsed.length) gaps.push({ metric: price.metric, reason: "NO_JOB_EVIDENCE" });
    let total = 0n;
    let missingJobs = 0;
    let firstMissingJob: string | undefined;
    for (const { evidence, accountingObservation } of parsed) {
      const accounting = accountingObservation?.observation.accounting ?? evidence.accounting;
      let quantity: bigint | undefined;
      if (price.metric === "cpu.time" && accounting?.cpuTimeMilliseconds !== undefined)
        quantity = BigInt(accounting.cpuTimeMilliseconds);
      else if (price.metric === "job.elapsed" && accounting?.elapsedMilliseconds !== undefined)
        quantity = BigInt(accounting.elapsedMilliseconds);
      else if (
        price.metric === "cpu.allocated" &&
        accounting?.elapsedMilliseconds !== undefined &&
        accounting.allocatedCpus !== undefined
      )
        quantity = BigInt(accounting.elapsedMilliseconds) * BigInt(accounting.allocatedCpus);
      if (quantity === undefined) {
        missingJobs++;
        firstMissingJob ??= evidence.jobId;
      } else total += quantity;
    }
    if (missingJobs)
      gaps.push({
        metric: price.metric,
        jobId: firstMissingJob,
        missingJobs,
        reason: "MISSING_ACCOUNTING",
      });
    if (!FederationAmountSchema.safeParse(total.toString()).success)
      return { state: "needs_review", reason: "QUANTITY_OVERFLOW" };
    quantities.push({
      metric: price.metric,
      quantityUnit: price.quantityUnit,
      quantity: total.toString(),
    });
  }
  if (gaps.length) return { state: "missing_data", gaps };
  const evidenceSet = {
    version: 1 as const,
    reservationId: scope.reservationId,
    agreementRevisionId: terms.agreement.agreementRevisionId,
    priceVersionId: terms.priceVersionId,
    records: parsed
      .map(({ evidence, digest, accountingObservation }) => ({
        jobId: evidence.jobId,
        digest,
        ...(accountingObservation ? { accountingDigest: accountingObservation.digest } : {}),
      }))
      .sort((a, b) => a.jobId.localeCompare(b.jobId)),
  };
  const evidenceDigest = federationMaterialDigest(evidenceSet);
  return {
    state: "ready",
    evidenceSet,
    measurements: quantities.map((quantity) => ({ ...quantity, evidenceDigest })),
  };
}
