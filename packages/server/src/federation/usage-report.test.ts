import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  FederationAccountingObservation,
  FederationTerminalEvidence,
} from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  commercialAutomaticMeters,
} from "@kuintessence/shared/federation/commercial";
import { federationMaterialDigest } from "./assets";
import { testAgreement } from "./test-fixtures";
import { aggregateCommercialUsage } from "./usage-report";

function fixture() {
  const agreement = testAgreement(randomUUID(), randomUUID());
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    agreement,
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: commercialAutomaticMeters.map((meter) => ({
      ...meter,
      amount: "1",
      perQuantity: "1000",
    })),
    termsText: "Fixture contract",
  });
  const scope = {
    reservationId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    attempt: 1,
    requestDigest: `sha256:${"b".repeat(64)}`,
    executionSnapshotDigest: `sha256:${"c".repeat(64)}`,
  };
  const accounting = {
    version: 1,
    source: "slurm-sacct",
    schedulerJobId: "42",
    observedAt: "2026-01-01T00:00:10.000Z",
    elapsedMilliseconds: "5000",
    cpuTimeMilliseconds: "9007199254740993",
    allocatedCpus: "2",
  } as const;
  const evidence: FederationTerminalEvidence = {
    version: 1,
    jobId: randomUUID(),
    ...scope,
    agreementRevisionId: agreement.agreementRevisionId,
    sourceSiteId: agreement.sourceSiteId,
    targetSiteId: agreement.targetSiteId,
    invocationPathHash: "d".repeat(64),
    status: "completed",
    previousStatus: "running",
    source: "agent-status",
    agentEventId: "event",
    dispatchEpoch: 1,
    requested: { cpus: "100", gpus: "0", memoryMb: "1024" },
    scheduler: {
      agentId: "agent",
      type: "slurm",
      jobId: "42",
      queueId: null,
      node: null,
      exitCode: 0,
    },
    accounting,
    observation: {
      basis: "server-status-observation",
      runningObservedAt: null,
      terminalObservedAt: "2026-01-01T00:00:10.000Z",
      quality: "start-unobserved",
      schedulerAccounting: "reported",
    },
  };
  const row = (value = evidence) => {
    const stored: FederationTerminalEvidence = JSON.parse(JSON.stringify(value));
    return { evidence: stored, digest: federationMaterialDigest(stored) };
  };
  return { terms, scope, evidence, accounting, row };
}

test("exact scheduler quantities remain distinct from resource requests and stable across Job order", () => {
  const f = fixture(),
    second = {
      ...f.evidence,
      jobId: randomUUID(),
      accounting: { ...f.accounting, cpuTimeMilliseconds: "7" },
    };
  const result = aggregateCommercialUsage(f.terms, f.scope, [f.row(), f.row(second)]);
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error("Not ready");
  expect(result.measurements.map((item) => item.quantity)).toEqual([
    "9007199254741000",
    "20000",
    "10000",
  ]);
  expect(aggregateCommercialUsage(f.terms, f.scope, [f.row(second), f.row()])).toEqual(result);
  expect(new Set(result.measurements.map((item) => item.evidenceDigest)).size).toBe(1);
});

test("unknown legacy metric, missing fields and no Jobs remain gaps instead of partial or zero reports", () => {
  const f = fixture();
  const partial = {
    ...f.evidence,
    accounting: { ...f.accounting, cpuTimeMilliseconds: undefined },
  };
  expect(aggregateCommercialUsage(f.terms, f.scope, [f.row(partial)])).toMatchObject({
    state: "missing_data",
    gaps: [{ metric: "cpu.time", reason: "MISSING_ACCOUNTING", missingJobs: 1 }],
  });
  expect(
    aggregateCommercialUsage(
      {
        ...f.terms,
        prices: [{ metric: "cpu", quantityUnit: "core-second", amount: "1", perQuantity: "1" }],
      },
      f.scope,
      [f.row()],
    ),
  ).toMatchObject({ state: "missing_data", gaps: [{ reason: "UNSUPPORTED_METER" }] });
  expect(aggregateCommercialUsage(f.terms, f.scope, [])).toMatchObject({ state: "missing_data" });
});

test("reported zero stays zero, while duplicate, tampered or foreign evidence is refused", () => {
  const f = fixture();
  const zero = {
    ...f.evidence,
    accounting: {
      ...f.accounting,
      elapsedMilliseconds: "0",
      cpuTimeMilliseconds: "0",
      allocatedCpus: "0",
    },
  };
  const result = aggregateCommercialUsage(f.terms, f.scope, [f.row(zero)]);
  expect(
    result.state === "ready" && result.measurements.every((item) => item.quantity === "0"),
  ).toBe(true);
  for (const rows of [
    [f.row(), f.row()],
    [{ ...f.row(), digest: `sha256:${"0".repeat(64)}` }],
    [f.row({ ...f.evidence, attempt: 2 })],
    [f.row({ ...f.evidence, executionSnapshotDigest: `sha256:${"0".repeat(64)}` })],
  ])
    expect(aggregateCommercialUsage(f.terms, f.scope, rows)).toEqual({
      state: "needs_review",
      reason: "EVIDENCE_CONFLICT",
    });
});

test("aggregate overflow is explicit and missing diagnostics stay bounded per metric", () => {
  const f = fixture();
  const huge = {
    ...f.evidence,
    accounting: {
      ...f.accounting,
      elapsedMilliseconds: "9".repeat(38),
      allocatedCpus: "2",
    },
  };
  expect(aggregateCommercialUsage(f.terms, f.scope, [f.row(huge)])).toEqual({
    state: "needs_review",
    reason: "QUANTITY_OVERFLOW",
  });
  const rows = Array.from({ length: 100 }, () =>
    f.row({
      ...f.evidence,
      jobId: randomUUID(),
      accounting: undefined,
      observation: { ...f.evidence.observation, schedulerAccounting: "unavailable" },
    }),
  );
  const result = aggregateCommercialUsage(f.terms, f.scope, rows);
  expect(result.state).toBe("missing_data");
  if (result.state !== "missing_data") throw new Error("Expected missing data");
  expect(result.gaps).toHaveLength(3);
  expect(result.gaps.every((gap) => gap.missingJobs === 100)).toBe(true);
});

test("supplemental accounting commits both immutable sources and rejects crossed evidence", () => {
  const f = fixture();
  const original = f.row({
    ...f.evidence,
    accounting: undefined,
    observation: { ...f.evidence.observation, schedulerAccounting: "unavailable" },
  });
  const sample: FederationAccountingObservation = {
    version: 1,
    requestId: randomUUID(),
    jobId: original.evidence.jobId,
    dispatchEpoch: original.evidence.dispatchEpoch,
    originalEvidenceDigest: original.digest,
    terminalStatus: "completed",
    accounting: f.accounting,
  };
  const row = {
    ...original,
    accountingObservation: { observation: sample, digest: federationMaterialDigest(sample) },
  };
  const result = aggregateCommercialUsage(f.terms, f.scope, [row]);
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error("Missing supplemental aggregation");
  expect(result.evidenceSet.records[0]).toEqual({
    jobId: original.evidence.jobId,
    digest: original.digest,
    accountingDigest: row.accountingObservation.digest,
  });
  expect(original.evidence.accounting).toBeUndefined();
  expect(result.measurements[0]?.quantity).toBe("9007199254740993");
  sample.dispatchEpoch++;
  row.accountingObservation.digest = federationMaterialDigest(sample);
  expect(aggregateCommercialUsage(f.terms, f.scope, [row])).toEqual({
    state: "needs_review",
    reason: "EVIDENCE_CONFLICT",
  });
});
