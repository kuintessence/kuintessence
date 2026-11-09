import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentJobStatusEvents,
  agents,
  auditLog,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  federationAccountingCollections,
  federationAgreementApprovals,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationCertificates,
  federationClosingPolicies,
  federationClosingTasks,
  federationCommercialAdjustments,
  federationCommercialAgreements,
  federationCommercialApprovalSyncs,
  federationCommercialAttempts,
  federationCommercialBills,
  federationCommercialDiscounts,
  federationCommercialExecutionApprovals,
  federationCommercialPayments,
  federationCommercialRefunds,
  federationCommercialSettlements,
  federationCommercialSubmissions,
  federationDisclosureDownloads,
  federationDisclosurePolicies,
  federationDisclosureReadAuthorizations,
  federationDisclosures,
  federationDisputeDeliveries,
  federationDisputeFreezes,
  federationDisputes,
  federationEvidenceCases,
  federationOutbound,
  federationReceivedDisclosures,
  federationReceivedUsage,
  federationReservations,
  federationSigningKeys,
  federationSites,
  federationTerminalEvidence,
  federationUsageReports,
  federationUsageSyncs,
  federationUsageTasks,
  federationWorkflowBindings,
  jobDataBindings,
  jobs,
  orgs,
  userOrgMemberships,
  users,
  workflowExecutionJobs,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import type { SchedulerAccounting } from "@kuintessence/shared";
import type { FederationAccountingRequest } from "@kuintessence/shared/federation";
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
  FederationCancellationReceiptSchema,
} from "@kuintessence/shared/federation";
import {
  CommercialAdjustmentListSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialPaymentSchema,
  CommercialRefundSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  type CommercialUsageCorrectionInput,
  CommercialUsageSchema,
  commercialAutomaticMeters,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisclosureDraftSchema,
  CommercialDisclosureListSchema,
  CommercialDisclosureSchema,
} from "@kuintessence/shared/federation/disclosure";
import {
  CommercialDisclosureDownloadQuerySchema,
  CommercialDisclosureReadPairSchema,
  CommercialDisclosureReadQuerySchema,
  CommercialDisclosureReadScopeSchema,
  CommercialEvidenceCaseInputSchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import {
  CommercialDisputeFinancialViewSchema,
  CommercialDisputeFreezeSchema,
  CommercialDisputeListSchema,
  CommercialDisputeReceiptSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import {
  CommercialUsagePageSchema,
  CommercialUsageQuerySchema,
} from "@kuintessence/shared/federation/usage-exchange";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { z } from "zod";
import { createErrorHandler } from "../middleware/error-handler";
import { federationOrganizationContext } from "../middleware/federation-organization";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { createFederationEvidenceRoutes } from "../routes/federation-evidence";
import { revokeDataDeliveryJobs } from "../services/data-delivery";
import { DataGrantRevocationCoordinator } from "../services/data-delivery-revocations";
import { JobService } from "../services/job-service";
import { FederationAccountingCollection } from "./accounting-collection";
import { FederationAdjustmentService } from "./adjustment";
import { federationMaterialDigest } from "./assets";
import { readAttestationBacklog } from "./attestation-backlog";
import { FederationBillingService } from "./billing";
import { FederationClosingAutomation } from "./closing-automation";
import { ClosingPolicyInputSchema, FederationClosingPolicyService } from "./closing-policy";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { CommercialClient } from "./commercial-client";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FederationDisclosureService } from "./disclosure";
import {
  FederationDisclosureDownloadResponder,
  FederationEvidenceService,
} from "./disclosure-delivery";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import {
  FederationDisclosureReadClient,
  FederationDisclosureReadResponder,
} from "./disclosure-read";
import { FederationDisputeDelivery } from "./dispute-delivery";
import { assertFederationTaskNotDisputed, lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { FederationDisputeService } from "./disputes";
import { FabricClientFailure } from "./fabric-client";
import { createFederationIngress } from "./ingress";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { FederationPaymentService } from "./payment";
import { FederationPermissionService } from "./permissions";
import { FederationSettlementService } from "./settlement";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";
import { FederationUsageService } from "./usage";
import { FederationUsageExchange } from "./usage-exchange";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Terminal evidence tests require an isolated kuintessence_unit_* database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

async function fixture(
  options: {
    federated?: boolean;
    startedAt?: Date | null;
    scheduler?: string;
    terms?: FederationAgreement;
  } = {},
) {
  const orgId = randomUUID(),
    userId = randomUUID(),
    jobId = randomUUID(),
    runId = randomUUID();
  const agentId = `terminal-${randomUUID()}`,
    reservationId = randomUUID();
  const terms = options.terms ?? testAgreement(randomUUID(), randomUUID());
  const request = testDelegation(terms),
    digest = federationMaterialDigest(request);
  await db.insert(orgs).values({ id: orgId, name: "Terminal evidence fixture" });
  await db
    .insert(users)
    .values({ id: userId, orgId, email: `${userId}@test.invalid`, role: "user" });
  await db.insert(agents).values({
    agentId,
    siteName: "Terminal fixture",
    schedulerType: options.scheduler ?? "slurm",
    schedulerVersion: "fixture",
  });
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Evidence fixture",
    submittedBy: userId,
    input: {
      executionModel: "durable-v2",
      yaml: "fixture",
      role: "user",
      orgId,
      ...(options.federated === false ? {} : { federationReservationId: reservationId }),
    },
  });
  await db.insert(workflowExecutionLeases).values({ runId });
  if (options.federated !== false) {
    await db.insert(federationBudgets).values({
      domainId: terms.budgetDomainId,
      epoch: terms.epoch,
      unit: terms.unit,
      limit: "100",
      available: "40",
      reserved: "60",
    });
    await db.insert(federationAgreements).values({
      revisionId: terms.agreementRevisionId,
      sourceSiteId: terms.sourceSiteId,
      targetSiteId: terms.targetSiteId,
      localOrgId: orgId,
      executionUserId: userId,
      budgetDomainId: terms.budgetDomainId,
      epoch: terms.epoch,
      terms,
      termsDigest: federationMaterialDigest(terms),
      sourceApprovalJws: "fixture.source",
      targetApprovalJws: "fixture.target",
    });
    const receipt = FederationAcceptanceSchema.parse({
      protocolVersion: 1,
      kind: "acceptance",
      operationId: request.operationId,
      mode: terms.mode,
      budgetDomainId: terms.budgetDomainId,
      epoch: terms.epoch,
      senderSiteId: terms.targetSiteId,
      recipientSiteId: terms.sourceSiteId,
      agreementRevisionId: terms.agreementRevisionId,
      taskId: request.taskId,
      attempt: 1,
      requestDigest: digest,
      reservationId,
      reservedAmount: "60",
      unit: terms.unit,
      acceptedAt: request.issuedAt,
      status: "RESERVED",
    });
    await db.insert(federationReservations).values({
      id: reservationId,
      agreementRevisionId: terms.agreementRevisionId,
      senderSiteId: terms.sourceSiteId,
      operationId: request.operationId,
      taskId: request.taskId,
      attempt: 1,
      requestDigest: digest,
      requestJws: "fixture.request",
      amount: "60",
      receipt,
      receiptJws: "fixture.receipt",
      state: "reserved",
    });
    const snapshot: typeof federationWorkflowBindings.$inferInsert.snapshot = {
      request,
      requestDigest: digest,
      identity: { orgId, userId },
      workflow: { name: "Fixture", parameters: [], spec: { nodeDrafts: [], nodeRelations: [] } },
      workflowVersions: {},
      inputs: { protocolVersion: 1, kind: "inputs", parameters: {}, datasets: [], bindings: [] },
      environment: {
        protocolVersion: 1,
        kind: "environment-lock",
        target: { platform: "linux", architecture: "x86_64" },
        nativeLockDigest: digest,
        software: [],
      },
      mappings: [],
    };
    await db.insert(federationWorkflowBindings).values({
      reservationId,
      workflowRunId: runId,
      snapshot,
      snapshotDigest: federationMaterialDigest(snapshot),
    });
  }
  const startedAt =
    options.startedAt === undefined ? new Date(Date.now() - 5000) : options.startedAt;
  await db.insert(jobs).values({
    id: jobId,
    name: "Terminal fixture",
    command: "private command probe",
    envVars: { SECRET: "private env probe" },
    cpus: 2,
    gpus: 0,
    memoryMb: 128,
    submittedBy: userId,
    orgId,
    agentId,
    status: startedAt ? "running" : "queued",
    startedAt,
    dispatchEpoch: 1,
  });
  await db.insert(workflowExecutionJobs).values({
    runId,
    jobId,
    pathHash: "a".repeat(64),
    path: '["node","fixture"]',
    nodeId: "fixture",
    intent: {
      nodeId: "fixture",
      name: "Fixture",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    },
  });
  cleanup.push(async () => {
    await db.delete(federationTerminalEvidence).where(eq(federationTerminalEvidence.jobId, jobId));
    await db.delete(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, jobId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db
      .delete(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.workflowRunId, runId));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
    await db.delete(federationReservations).where(eq(federationReservations.id, reservationId));
    await db
      .delete(federationAgreements)
      .where(eq(federationAgreements.revisionId, terms.agreementRevisionId));
    await db.delete(federationBudgets).where(eq(federationBudgets.domainId, terms.budgetDomainId));
    await db.delete(agents).where(eq(agents.agentId, agentId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  });
  const service = new JobService(db);
  const read = async () =>
    (
      await db
        .select()
        .from(federationTerminalEvidence)
        .where(eq(federationTerminalEvidence.jobId, jobId))
    )[0];
  const finish = (eventId = "completion", accounting?: SchedulerAccounting) =>
    service.updateStatus(
      jobId,
      "completed",
      "scheduler-42",
      agentId,
      undefined,
      0,
      { result: "private output probe" },
      eventId,
      { node: "node-1", accounting },
    );
  return { orgId, userId, jobId, runId, agentId, reservationId, terms, service, read, finish };
}

test("concurrent Agent completion persists one exact evidence record and replay cannot rewrite it", async () => {
  const f = await fixture();
  // SQL numeric text must survive the existing number-mode Job column mapping.
  await db.execute(sql`update jobs set memory_mb = 9007199254740993 where id = ${f.jobId}`);
  await Promise.all(Array.from({ length: 8 }, () => f.finish()));
  const saved = await f.read();
  expect(saved?.digest).toBe(federationMaterialDigest(saved?.evidence));
  expect(saved?.evidence).toMatchObject({
    source: "agent-status",
    status: "completed",
    requested: { cpus: "2", memoryMb: "9007199254740993" },
    scheduler: { type: "slurm", jobId: "scheduler-42", exitCode: 0, node: "node-1" },
    observation: {
      basis: "server-status-observation",
      quality: "observed-interval",
      schedulerAccounting: "unavailable",
    },
  });
  expect(JSON.stringify(saved)).not.toContain("private");
  await new JobService(db).updateStatus(f.jobId, "failed", "changed", f.agentId, "late", 1);
  expect(await f.read()).toEqual(saved);
  expect(
    await db.select().from(agentJobStatusEvents).where(eq(agentJobStatusEvents.jobId, f.jobId)),
  ).toHaveLength(1);
  await db.delete(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, f.jobId));
  await expect(db.delete(jobs).where(eq(jobs.id, f.jobId)).execute()).rejects.toThrow();
  expect(await f.read()).toEqual(saved);
});

test("evidence storage failure rolls back Job and Agent event, allowing original event retry", async () => {
  const f = await fixture();
  await db.execute(
    sql`alter table federation_terminal_evidence add constraint test_terminal_failure check (job_id <> ${sql.raw(`'${f.jobId}'::uuid`)})`,
  );
  try {
    await expect(f.finish()).rejects.toThrow();
    expect((await f.service.getById(f.jobId))?.status).toBe("running");
    expect(await f.read()).toBeUndefined();
    expect(
      await db.select().from(agentJobStatusEvents).where(eq(agentJobStatusEvents.jobId, f.jobId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(
      sql`alter table federation_terminal_evidence drop constraint test_terminal_failure`,
    );
  }
  await f.finish();
  expect((await f.read())?.evidence.status).toBe("completed");
});

test("unobserved start and clock regression remain missing/invalid instead of zero consumption", async () => {
  for (const startedAt of [null, new Date(Date.now() + 60000)]) {
    const f = await fixture({ startedAt, scheduler: "pbs" });
    await f.finish();
    expect((await f.read())?.evidence.observation.quality).toBe(
      startedAt ? "clock-inconsistent" : "start-unobserved",
    );
    expect((await f.read())?.evidence.observation.runningObservedAt).toBe(
      startedAt?.toISOString() ?? null,
    );
    expect((await f.read())?.evidence.scheduler.type).toBe("pbs");
  }
});

test("platform failure and cancellation preserve cause without claiming scheduler stop confirmation", async () => {
  for (const cancel of [true, false]) {
    const f = await fixture({ startedAt: null });
    if (cancel) await f.service.cancel(f.jobId);
    else await f.service.updateStatus(f.jobId, "failed", undefined, f.agentId, "placement failed");
    expect((await f.read())?.evidence).toMatchObject({
      source: cancel ? "platform-cancellation" : "status-update",
      status: cancel ? "cancelled" : "failed",
      observation: { quality: "start-unobserved", schedulerAccounting: "unavailable" },
    });
  }
});

test("ordinary durable Jobs do not create federation evidence", async () => {
  const f = await fixture({ federated: false });
  await f.finish();
  expect(await f.read()).toBeUndefined();
});

test("missing binding or changed receiver identity cannot silently discard evidence", async () => {
  const f = await fixture();
  await db.update(jobs).set({ orgId: null }).where(eq(jobs.id, f.jobId));
  await expect(f.finish()).rejects.toThrow("OPERATION_CONFLICT");
  await db.update(jobs).set({ orgId: f.orgId }).where(eq(jobs.id, f.jobId));
  await db
    .delete(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  await expect(f.finish()).rejects.toThrow("OPERATION_CONFLICT");
  expect((await f.service.getById(f.jobId))?.status).toBe("running");
});

for (const kind of ["asset", "grant"] as const)
  test(`${kind} revocation captures terminal evidence even after cooperation is revoked`, async () => {
    const f = await fixture();
    const assetId = randomUUID(),
      versionId = randomUUID(),
      grantId = randomUUID();
    cleanup.push(async () => {
      await db.delete(dataAssets).where(eq(dataAssets.id, assetId));
    });
    await db.insert(dataAssets).values({
      id: assetId,
      ownerKind: "user",
      ownerUserId: f.userId,
      kind: "scientific-dataset",
      name: "Evidence dataset",
      lifecycle: "published",
      visibility: "private",
      accessMode: "request",
      sensitivity: "internal",
      createdBy: f.userId,
    });
    await db.insert(dataAssetVersions).values({
      id: versionId,
      dataAssetId: assetId,
      version: "1",
      status: "ready",
      immutableAt: new Date(),
      manifestDigest: `sha256:${"a".repeat(64)}`,
    });
    await db.insert(dataGrants).values({
      id: grantId,
      dataAssetId: assetId,
      dataAssetVersionId: versionId,
      subjectKind: "user",
      subjectId: f.userId,
      capabilities: ["use"],
    });
    await db.insert(jobDataBindings).values({
      jobId: f.jobId,
      inputDescriptor: "data",
      source: "data-market",
      assetId,
      versionId,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      authorizationSubjectIds: [`user:${f.userId}`],
    });
    await db
      .update(federationAgreements)
      .set({ state: "revoked" })
      .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
    if (kind === "asset")
      await revokeDataDeliveryJobs({
        db,
        assetId,
        reasonCode: "ASSET_REVOKED",
        dispatcher: { pushDataDeliveryRevoke: () => true },
      });
    else
      await new DataGrantRevocationCoordinator(db, { redeliver: async () => 0 }).revoke({
        grantId,
        reason: "fixture",
      });
    expect((await f.read())?.evidence).toMatchObject({
      status: "cancelled",
      source: "data-revocation",
      observation: { quality: "observed-interval" },
    });
  });

test("legacy metering failure does not lose committed federation evidence", async () => {
  const f = await fixture();
  let calls = 0;
  const service = new JobService(db, undefined, {
    recordJobCompletion: async () => {
      calls++;
      throw new Error("fixture metering unavailable");
    },
  });
  await service.updateStatus(f.jobId, "completed", "scheduler-42", f.agentId);
  expect(calls).toBe(1);
  expect((await f.read())?.evidence.status).toBe("completed");
  expect((await service.getById(f.jobId))?.status).toBe("completed");
});

for (const scheduler of ["slurm", "pbs-pro"] as const)
  test(`${scheduler} accounting is saved with the original terminal event and retained on replay`, async () => {
    const f = await fixture({ scheduler });
    const accounting: SchedulerAccounting = {
      version: 1,
      source: scheduler === "slurm" ? "slurm-sacct" : "pbs-qstat",
      schedulerJobId: "scheduler-42",
      observedAt: new Date().toISOString(),
      cpuTimeMilliseconds: "9007199254740993",
    };
    await f.finish("accounting-event", accounting);
    const saved = await f.read();
    expect(saved?.evidence.accounting).toEqual(accounting);
    expect(saved?.evidence.observation.schedulerAccounting).toBe("reported");
    expect(saved?.evidence.accounting?.elapsedMilliseconds).toBeUndefined();
    await f.finish("accounting-event", { ...accounting, cpuTimeMilliseconds: "0" });
    expect(await f.read()).toEqual(saved);
  });

test("Kubernetes terminal event preserves measured Pod runtime and rejects invented CPU metrics", async () => {
  const f = await fixture({ scheduler: "kubernetes" });
  const accounting: SchedulerAccounting = {
    version: 1,
    source: "kubernetes-pod",
    schedulerJobId: "scheduler-42",
    observedAt: new Date().toISOString(),
    elapsedMilliseconds: "2500",
  };
  await expect(
    f.finish("pod-accounting", { ...accounting, cpuTimeMilliseconds: "2500" }),
  ).rejects.toThrow();
  expect(await f.read()).toBeUndefined();
  await f.finish("pod-accounting", accounting);
  expect((await f.read())?.evidence.accounting).toEqual(accounting);
  await f.finish("pod-accounting", { ...accounting, elapsedMilliseconds: "9999" });
  expect((await f.read())?.evidence.accounting).toEqual(accounting);
});

test("mismatched accounting scheduler or job cannot commit a terminal event", async () => {
  const f = await fixture();
  const accounting: SchedulerAccounting = {
    version: 1,
    source: "slurm-sacct",
    schedulerJobId: "scheduler-42",
    observedAt: new Date().toISOString(),
    elapsedMilliseconds: "10",
  };
  for (const invalid of [
    { ...accounting, schedulerJobId: "another-job" },
    { ...accounting, source: "pbs-qstat" as const },
  ]) {
    await expect(f.finish("same-event", invalid)).rejects.toThrow("OPERATION_CONFLICT");
    expect((await f.service.getById(f.jobId))?.status).toBe("running");
    expect(await f.read()).toBeUndefined();
  }
  await f.finish("same-event", accounting);
  expect((await f.read())?.evidence.accounting).toEqual(accounting);
});

async function usageFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
  missing = false,
) {
  const [source, provider] = await Promise.all([testKeys(), testKeys()]);
  const terms = {
    ...testAgreement(source.signing.siteId, provider.signing.siteId, mode),
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const f = await fixture({ terms });
  const actor = { orgId: f.orgId, userId: f.userId };
  const trust = new FederationTrustRegistry(db);
  cleanup.push(async () => {
    const pending = await db
      .select({ id: federationCommercialSubmissions.id })
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, provider.signing.siteId));
    if (pending.length)
      await db.delete(federationCommercialAttempts).where(
        inArray(
          federationCommercialAttempts.submissionId,
          pending.map((row) => row.id),
        ),
      );
    await db
      .delete(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, provider.signing.siteId));
    await db
      .delete(federationUsageReports)
      .where(eq(federationUsageReports.reservationId, f.reservationId));
    await db
      .delete(federationUsageTasks)
      .where(eq(federationUsageTasks.reservationId, f.reservationId));
    await db
      .delete(federationCommercialAgreements)
      .where(eq(federationCommercialAgreements.localSiteId, provider.signing.siteId));
    await db.delete(federationCapabilities).where(eq(federationCapabilities.userId, f.userId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, f.userId));
    await db.delete(auditLog).where(eq(auditLog.actor, f.userId));
    for (const keys of [source, provider]) {
      await db
        .delete(federationSigningKeys)
        .where(eq(federationSigningKeys.siteId, keys.signing.siteId));
      await db.delete(federationSites).where(eq(federationSites.id, keys.signing.siteId));
    }
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
  await new FederationPermissionService(db).set(
    { ...actor, capability: "agreement.approve", enabled: true },
    f.userId,
  );
  for (const keys of [source, provider]) {
    await trust.addSite(
      { id: keys.signing.siteId, name: "Usage fixture", endpoint: "https://fixture.invalid" },
      f.userId,
    );
    await trust.addKey(
      keys.signing.siteId,
      {
        keyId: keys.signing.keyId,
        publicKeyPem: await exportSPKI(keys.verification.publicKey),
        allowedKinds: ["commercial-agreement", "commercial-usage"],
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      f.userId,
    );
  }
  const contract = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: "e".repeat(64),
    createdAt: new Date().toISOString(),
    agreement: terms,
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [{ ...commercialAutomaticMeters[0], amount: "9", perQuantity: "1000" }],
    termsText: "Private usage fixture",
  });
  const approvals = new FederationCommercialAgreementService(db, provider.signing);
  await approvals.approve(actor, contract);
  await approvals.attachCounterparty(
    actor,
    terms.agreementRevisionId,
    await signFederationMessage(CommercialAgreementSchema, contract, source.signing),
  );
  await db
    .update(workflowRuns)
    .set({ createdAt: new Date(Date.now() - 10000) })
    .where(eq(workflowRuns.id, f.runId));
  await f.finish(
    "usage-event",
    missing
      ? undefined
      : {
          version: 1,
          source: "slurm-sacct",
          schedulerJobId: "scheduler-42",
          observedAt: new Date().toISOString(),
          cpuTimeMilliseconds: "9007199254740993",
          elapsedMilliseconds: undefined,
        },
  );
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(workflowRuns.id, f.runId));
  const usage = new FederationUsageService(db, provider.signing);
  const view = () => usage.get(actor, terms.agreementRevisionId, f.reservationId);
  return { ...f, actor, source, provider, contract, trust, approvals, usage, view };
}

test("direct usage is signed exactly once after restart/concurrent scans without ledger work or financial effects", async () => {
  const f = await usageFixture();
  await f.usage.discover();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      new FederationUsageService(db, f.provider.signing).advanceNext(),
    ),
  );
  const view = await f.view();
  expect(view.task.state).toBe("reported");
  expect(view.reports).toHaveLength(1);
  const report = view.reports[0];
  if (!report) throw new Error("Missing usage report");
  const key = await f.trust.resolveKey(
    f.provider.signing.siteId,
    f.provider.signing.keyId,
    new Date(),
  );
  expect(
    (await verifyFederationMessage(CommercialUsageSchema, report.reportJws, key, new Date()))
      .digest,
  ).toBe(report.digest);
  expect(report.report.measurements[0]?.quantity).toBe("9007199254740993");
  expect(report.report.measurements[0]?.evidenceDigest).toBe(
    federationMaterialDigest(report.evidenceSet),
  );
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toHaveLength(0);
  const [budget] = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  expect(budget).toMatchObject({ available: "40", reserved: "60" });
  await f.usage.discover();
  expect(await f.usage.advanceNext()).toBe(false);
  expect((await f.view()).reports).toEqual(view.reports);
});

test("missing accounting never creates a zero or partial signed report", async () => {
  const f = await usageFixture("bilateral_direct", true);
  await f.usage.discover();
  await f.usage.advanceNext();
  expect(await f.view()).toMatchObject({
    task: {
      state: "missing_data",
      gaps: [{ metric: "cpu.time", missingJobs: 1, reason: "MISSING_ACCOUNTING" }],
    },
    reports: [],
  });
  await f.usage.retry(f.actor, f.terms.agreementRevisionId, f.reservationId);
  await f.usage.advanceNext();
  expect((await f.view()).reports).toHaveLength(0);
});

test("report failure rolls back signature and ledger intent; original evidence remains available", async () => {
  const f = await usageFixture("bilateral_attested");
  await f.usage.discover();
  await db.execute(
    sql`alter table federation_usage_reports add constraint test_usage_failure check (reservation_id <> ${sql.raw(`'${f.reservationId}'::uuid`)})`,
  );
  try {
    await expect(f.usage.advanceNext()).rejects.toThrow();
    expect((await f.view()).reports).toHaveLength(0);
    expect((await f.view()).task.state).toBe("pending");
  } finally {
    await db.execute(sql`alter table federation_usage_reports drop constraint test_usage_failure`);
  }
  expect(await f.read()).toBeDefined();
  await f.usage.advanceNext();
  expect((await f.view()).reports).toHaveLength(1);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toHaveLength(2);
});

test("new usage waits for current signing trust but historical cooperation and staff authority are not erased", async () => {
  const f = await usageFixture();
  await f.usage.discover();
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await f.usage.advanceNext();
  expect((await f.view()).task).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  });
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-usage"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await f.usage.retry(f.actor, f.terms.agreementRevisionId, f.reservationId);
  await db.delete(federationCapabilities).where(eq(federationCapabilities.userId, f.userId));
  await db
    .update(federationAgreements)
    .set({ state: "revoked" })
    .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
  await f.usage.advanceNext();
  expect(
    await db
      .select()
      .from(federationUsageReports)
      .where(eq(federationUsageReports.reservationId, f.reservationId)),
  ).toHaveLength(1);
  await expect(f.view()).rejects.toThrow("POLICY_DENIED");
});

test("usage ledger submission waits for commercial contract commit and does not pollute contract status", async () => {
  const f = await usageFixture("bilateral_attested");
  await f.usage.discover();
  await f.usage.advanceNext();
  const seen: string[] = [];
  const ledger = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async (input) => {
      seen.push(input.operation);
      return { transactionId: "a".repeat(64), recovery: "fixture" };
    },
    advance: async () => ({ state: "pending", transactionId: "a".repeat(64), recovery: "fixture" }),
  });
  const rows = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  const contract = rows.find((row) => row.input.operation === "register-agreement"),
    usage = rows.find((row) => row.input.operation === "record-usage");
  if (!contract || !usage) throw new Error("Missing submissions");
  await db
    .update(federationCommercialSubmissions)
    .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
    .where(eq(federationCommercialSubmissions.id, contract.id));
  expect(await ledger.advanceNext()).toBe(false);
  expect(seen).toEqual([]);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, contract.id));
  expect(await ledger.advanceNext()).toBe(true);
  expect(seen).toEqual(["record-usage"]);
  expect(
    (await ledger.status(f.actor, f.terms.agreementRevisionId, 50, 0)).submissions.map(
      (row) => row.id,
    ),
  ).toEqual([contract.id]);
});

test("usage worker runs without a Fabric socket and organization scope rejects foreign readers", async () => {
  const f = await usageFixture();
  const worker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
    f.usage,
  );
  await worker.tick();
  await worker.stop();
  expect((await f.view()).task.state).toBe("reported");
  await expect(
    f.usage.get({ ...f.actor, orgId: randomUUID() }, f.terms.agreementRevisionId, f.reservationId),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.usage.retry(f.actor, f.terms.agreementRevisionId, f.reservationId),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("usage HTTP remains private, read-only capabilities cannot retry, and override fields are rejected", async () => {
  const f = await usageFixture("bilateral_direct", true);
  await f.usage.discover();
  await f.usage.advanceNext();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
      f.usage,
    ),
  );
  const base = `/federation/commercial-agreements/${f.terms.agreementRevisionId}/usage`;
  const response = await app.request(`${base}/${f.reservationId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    data: { task: { state: "missing_data" }, reports: [] },
  });
  expect(
    (
      await app.request(`${base}/${f.reservationId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: "0" }),
      })
    ).status,
  ).toBe(400);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.read", enabled: true },
    f.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.userId,
  );
  expect((await app.request(base)).status).toBe(200);
  expect(
    (
      await app.request(`${base}/${f.reservationId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  automation = true;
  expect((await app.request(base)).status).toBe(403);
});

test("reporting interval outside the agreement is held for review without clamping actual evidence", async () => {
  const f = await usageFixture();
  await db
    .update(workflowRuns)
    .set({ createdAt: new Date("2019-01-01T00:00:00Z") })
    .where(eq(workflowRuns.id, f.runId));
  await f.usage.discover();
  await f.usage.advanceNext();
  expect(await f.view()).toMatchObject({
    task: { state: "needs_review", lastError: "REPORTING_INTERVAL_INVALID" },
    reports: [],
  });
  expect(await f.read()).toBeDefined();
});

async function correctionFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await usageFixture(mode);
  await f.usage.discover();
  await f.usage.advanceNext();
  const original = (await f.view()).reports[0];
  if (!original) throw new Error("Missing original report");
  const input: CommercialUsageCorrectionInput = {
    reportId: randomUUID(),
    correctionOf: original.id,
    reason: "Scheduler administrator verified a delayed CPU sample",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "9007199254741001",
        supportingEvidenceDigest: federationMaterialDigest({ sample: "private accounting export" }),
      },
    ],
  };
  const correct = (raw = input) =>
    f.usage.correct(f.actor, f.terms.agreementRevisionId, f.reservationId, raw);
  return { ...f, original, input, correct };
}

test("technical correction appends a signed assertion and idempotent replay never rewrites history", async () => {
  const f = await correctionFixture();
  const originalEvidence = await f.read();
  const first = await f.correct();
  expect(first.number).toBe(2);
  expect(first.report).toMatchObject({
    correctionOf: f.original.id,
    periodStart: f.original.report.periodStart,
    periodEnd: f.original.report.periodEnd,
    taskId: f.original.report.taskId,
    attempt: f.original.report.attempt,
  });
  expect(first.correctionEvidence).toMatchObject({
    kind: "provider-technical-correction",
    previousDigest: f.original.digest,
    declaration: f.input,
  });
  expect(first.report.measurements[0]?.evidenceDigest).toBe(
    federationMaterialDigest(first.correctionEvidence),
  );
  const key = await f.trust.resolveKey(
    f.provider.signing.siteId,
    f.provider.signing.keyId,
    new Date(),
  );
  expect(
    (await verifyFederationMessage(CommercialUsageSchema, first.reportJws, key, new Date())).digest,
  ).toBe(first.digest);
  expect((await f.correct()).reportJws).toBe(first.reportJws);
  const second = await f.correct({
    ...f.input,
    reportId: randomUUID(),
    correctionOf: first.id,
    reason: "Follow-up technical evidence",
  });
  expect(second.number).toBe(3);
  expect((await f.correct()).reportJws).toBe(first.reportJws);
  const records = (await f.view()).reports;
  expect(records).toHaveLength(3);
  expect(records[2]).toEqual(f.original);
  expect(
    await f.usage.get(f.actor, f.terms.agreementRevisionId, f.reservationId, 1, 0),
  ).toMatchObject({ hasMore: true, reports: [{ id: second.id }] });
  expect(
    await f.usage.get(f.actor, f.terms.agreementRevisionId, f.reservationId, 1, 2),
  ).toMatchObject({ hasMore: false, reports: [{ id: f.original.id }] });
  expect(await f.read()).toEqual(originalEvidence);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toHaveLength(0);
  expect(
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId))
    )[0],
  ).toMatchObject({ available: "40", reserved: "60" });
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "federation.usage.correct"));
  expect(audits.filter((row) => row.actor === f.userId)).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toContain(f.input.reason);
  expect(JSON.stringify(audits)).not.toContain(f.input.measurements[0]?.quantity);
});

test("technical correction serializes competing heads and rejects changed idempotency content", async () => {
  const f = await correctionFixture();
  const candidates = [
    f.input,
    { ...f.input, reportId: randomUUID(), reason: "Different correction" },
  ];
  const results = await Promise.allSettled(candidates.map((input) => f.correct(input)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await f.view()).reports).toHaveLength(2);
  const head = (await f.view()).reports[0];
  if (!head?.correctionEvidence) throw new Error("Missing correction");
  await expect(
    f.correct({ ...head.correctionEvidence.declaration, reason: "Changed bytes" }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.correct({ ...f.input, reportId: randomUUID() })).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("technical correction requires current authority, valid units, complete metrics and signing purpose", async () => {
  const f = await correctionFixture();
  await expect(
    f.correct({
      ...f.input,
      measurements: [
        {
          ...f.input.measurements[0],
          metric: "cpu",
          quantityUnit: "core-second",
          quantity: "1",
          supportingEvidenceDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    }),
  ).rejects.toThrow("INVALID_MESSAGE");
  await expect(f.correct({ ...f.input, measurements: [] })).rejects.toThrow();
  await expect(
    f.usage.correct(
      { ...f.actor, orgId: randomUUID() },
      f.terms.agreementRevisionId,
      f.reservationId,
      f.input,
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.correct()).rejects.toThrow("UNTRUSTED_IDENTITY");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-usage"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.userId,
  );
  await expect(f.correct()).rejects.toThrow("POLICY_DENIED");
  expect(
    await db
      .select()
      .from(federationUsageReports)
      .where(eq(federationUsageReports.reservationId, f.reservationId)),
  ).toHaveLength(1);
});

test("technical correction and audit roll back when its ledger intent cannot be saved", async () => {
  const f = await correctionFixture("bilateral_attested");
  await db.execute(
    sql`alter table federation_commercial_submissions add constraint test_correction_failure check (input->>'recordId' <> ${sql.raw(`'${f.input.reportId}'`)})`,
  );
  try {
    await expect(f.correct()).rejects.toThrow();
    expect((await f.view()).reports).toHaveLength(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.target, f.input.reportId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(
      sql`alter table federation_commercial_submissions drop constraint test_correction_failure`,
    );
  }
  expect((await f.correct()).number).toBe(2);
});

test("technical correction ledger waits for its predecessor and preserves order across multiple corrections", async () => {
  const f = await correctionFixture("bilateral_attested");
  const first = await f.correct();
  const second = await f.correct({ ...f.input, reportId: randomUUID(), correctionOf: first.id });
  const rows = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  const contract = rows.find((row) => row.input.operation === "register-agreement");
  const original = rows.find((row) => row.input.recordId === f.original.id);
  const corrected = rows.find((row) => row.input.recordId === first.id);
  if (!contract || !original || !corrected) throw new Error("Missing submissions");
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, contract.id));
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "needs_review" })
    .where(eq(federationCommercialSubmissions.id, original.id));
  const seen: string[] = [];
  const ledger = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async (input) => {
      seen.push(input.recordId);
      return { transactionId: "a".repeat(64), recovery: "fixture" };
    },
    advance: async () => ({ state: "pending", transactionId: "a".repeat(64), recovery: "fixture" }),
  });
  expect(await ledger.advanceNext()).toBe(false);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, original.id));
  expect(await ledger.advanceNext()).toBe(true);
  expect(seen).toEqual([first.id]);
  await db
    .update(federationCommercialSubmissions)
    .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
    .where(eq(federationCommercialSubmissions.id, corrected.id));
  expect(await ledger.advanceNext()).toBe(false);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, corrected.id));
  expect(await ledger.advanceNext()).toBe(true);
  expect(seen).toEqual([first.id, second.id]);
});

test("technical correction HTTP rejects hidden override fields and read-only or automation callers", async () => {
  const f = await correctionFixture();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.approvals,
      new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
      f.usage,
    ),
  );
  const path = `/federation/commercial-agreements/${f.terms.agreementRevisionId}/usage/${f.reservationId}/corrections`;
  const request = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await request({ ...f.input, periodStart: "2020-01-01T00:00:00.000Z" })).status).toBe(400);
  expect((await request({ ...f.input, reason: " " })).status).toBe(400);
  const response = await request(f.input);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ data: { id: f.input.reportId, number: 2 } });
  automation = true;
  expect((await request(f.input)).status).toBe(403);
  automation = false;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.read", enabled: true },
    f.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.userId,
  );
  expect((await request(f.input)).status).toBe(403);
});

async function exchangeFixture(
  missing = false,
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await usageFixture(mode, missing);
  await f.usage.discover();
  await f.usage.advanceNext();
  const actor = { userId: randomUUID(), orgId: randomUUID() };
  const fingerprint = randomUUID().replaceAll("-", "").repeat(2);
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservationId));
  const [binding] = await db
    .select()
    .from(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  if (!reservation || !binding) throw new Error("Missing execution binding");
  const operationId = reservation.operationId;
  cleanup.push(async () => {
    await db
      .delete(federationReceivedUsage)
      .where(eq(federationReceivedUsage.localSiteId, f.source.signing.siteId));
    await db
      .delete(federationUsageSyncs)
      .where(eq(federationUsageSyncs.localSiteId, f.source.signing.siteId));
    await db
      .delete(federationOutbound)
      .where(eq(federationOutbound.localSiteId, f.source.signing.siteId));
    await db
      .delete(federationCommercialAgreements)
      .where(eq(federationCommercialAgreements.localSiteId, f.source.signing.siteId));
    await db
      .delete(federationAgreementApprovals)
      .where(eq(federationAgreementApprovals.localSiteId, f.source.signing.siteId));
    await db
      .delete(federationCertificates)
      .where(eq(federationCertificates.fingerprint, fingerprint));
    await db.delete(federationCapabilities).where(eq(federationCapabilities.userId, actor.userId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, actor.userId));
    await db.delete(auditLog).where(eq(auditLog.actor, actor.userId));
    await db.delete(users).where(eq(users.id, actor.userId));
    await db.delete(orgs).where(eq(orgs.id, actor.orgId));
  });
  await db.insert(orgs).values({ id: actor.orgId, name: "Source usage reader" });
  await db.insert(users).values({
    id: actor.userId,
    orgId: actor.orgId,
    email: `${actor.userId}@test.invalid`,
    role: "user",
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
  await new FederationPermissionService(db).set(
    { ...actor, capability: "agreement.approve", enabled: true },
    actor.userId,
  );
  await db.insert(federationAgreementApprovals).values({
    localSiteId: f.source.signing.siteId,
    revisionId: f.terms.agreementRevisionId,
    localOrgId: actor.orgId,
    terms: f.terms,
    termsDigest: federationMaterialDigest(f.terms),
    approvalJws: "fixture",
    approvedBy: actor.userId,
  });
  const approvals = new FederationCommercialAgreementService(db, f.source.signing);
  await approvals.approve(actor, f.contract);
  await approvals.attachCounterparty(
    actor,
    f.terms.agreementRevisionId,
    await signFederationMessage(CommercialAgreementSchema, f.contract, f.provider.signing),
  );
  await db.insert(federationOutbound).values({
    localSiteId: f.source.signing.siteId,
    operationId,
    agreementRevisionId: f.terms.agreementRevisionId,
    localOrgId: actor.orgId,
    submittedBy: actor.userId,
    taskId: reservation.taskId,
    attempt: reservation.attempt,
    budgetDomainId: f.terms.budgetDomainId,
    epoch: f.terms.epoch,
    amount: reservation.amount,
    endpoint: "https://fixture.invalid",
    request: binding.snapshot.request,
    requestDigest: reservation.requestDigest,
    requestJws: reservation.requestJws,
    receipt: reservation.receipt,
    receiptJws: reservation.receiptJws,
    state: "accepted",
  });
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.source.signing.siteId,
    certificatePem: "TLS registry fixture; actual TLS verified separately",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          "commercial-agreement",
          "commercial-usage",
          "commercial-usage-query",
          "commercial-usage-page",
        ],
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  const responder = new FederationUsageExchange(db, f.provider.signing);
  const delivered: string[] = [];
  const send: FederationSend = async (endpoint, jws, path) => {
    expect(endpoint).toBe("https://fixture.invalid");
    expect(path).toBe("/federation/v1/usage");
    const response = await responder.receive(jws, fingerprint);
    delivered.push(response);
    return response;
  };
  const exchange = new FederationUsageExchange(db, f.source.signing, send);
  const view = () => exchange.get(actor, f.terms.agreementRevisionId, operationId);
  const due = () =>
    db
      .update(federationUsageSyncs)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(federationUsageSyncs.localSiteId, f.source.signing.siteId));
  return {
    ...f,
    sourceActor: actor,
    sourceApprovals: approvals,
    operationId,
    fingerprint,
    responder,
    send,
    exchange,
    exchangeView: view,
    due,
    delivered,
    reservation,
  };
}

test("usage exchange persists original and correction pages exactly once across concurrent/restarted scans", async () => {
  const f = await exchangeFixture();
  const original = (await f.view()).reports[0];
  if (!original) throw new Error("Missing report");
  const corrected = await f.usage.correct(f.actor, f.terms.agreementRevisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: original.id,
    reason: "Verified later technical sample",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "9007199254741023",
        supportingEvidenceDigest: `sha256:${"b".repeat(64)}`,
      },
    ],
  });
  await f.exchange.discover();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      new FederationUsageExchange(db, f.source.signing, f.send).advanceNext(),
    ),
  );
  await f.due();
  await f.exchange.advanceNext();
  const view = await f.exchangeView();
  expect(view.sync).toMatchObject({ number: 2, lastReportId: corrected.id, lastError: null });
  expect(view.reports.map((row) => row.reportId)).toEqual([corrected.id, original.id]);
  expect(view.reports[0]?.reportJws).toBe(corrected.reportJws);
  expect(view.reports[1]?.reportJws).toBe(original.reportJws);
  const peer = await f.trust.resolveKey(
    f.provider.signing.siteId,
    f.provider.signing.keyId,
    new Date(),
  );
  for (const jws of f.delivered) {
    const { payload } = await verifyFederationMessage(
      CommercialUsagePageSchema,
      jws,
      peer,
      new Date(),
    );
    expect(JSON.stringify(payload)).not.toContain(f.jobId);
    expect(JSON.stringify(payload)).not.toContain(f.userId);
    expect(JSON.stringify(payload)).not.toContain("evidenceSet");
  }
  await f.due();
  await f.exchange.advanceNext();
  expect((await f.exchangeView()).reports).toHaveLength(2);
  expect(
    JSON.stringify(await f.exchange.list(f.sourceActor, f.terms.agreementRevisionId, 50, 0)),
  ).not.toContain("leaseToken");
  expect(JSON.stringify(await f.exchangeView())).not.toContain("leaseToken");
  expect(
    await f.exchange.get(f.sourceActor, f.terms.agreementRevisionId, f.operationId, 1, 1),
  ).toMatchObject({ hasMore: false, reports: [{ reportId: original.id }] });
});

test("usage exchange preserves missing data and recovers unavailable transport without advancing its cursor", async () => {
  const f = await exchangeFixture(true);
  await f.exchange.discover();
  const offline = new FederationUsageExchange(db, f.source.signing, async () => {
    throw new Error("unavailable private transport");
  });
  await offline.advanceNext();
  expect(await f.exchangeView()).toMatchObject({
    sync: { state: "pending", lastError: "EXCHANGE_RETRY", number: 0 },
    reports: [],
  });
  await f.due();
  await f.exchange.advanceNext();
  expect(await f.exchangeView()).toMatchObject({
    sync: { providerState: "missing_data", number: 0, lastError: null },
    reports: [],
  });
});

test("usage exchange rejects replayed challenge and rolls back imported evidence on database failure", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  const replay = new FederationUsageExchange(db, f.source.signing, async (endpoint, jws, path) => {
    const first = await f.send(endpoint, jws, path);
    const peer = await f.trust.resolveKey(
      f.provider.signing.siteId,
      f.provider.signing.keyId,
      new Date(),
    );
    const { payload } = await verifyFederationMessage(
      CommercialUsagePageSchema,
      first,
      peer,
      new Date(),
    );
    return signFederationMessage(
      CommercialUsagePageSchema,
      { ...payload, queryId: randomUUID() },
      f.provider.signing,
    );
  });
  await replay.advanceNext();
  expect(await f.exchangeView()).toMatchObject({
    sync: { state: "needs_review", number: 0, lastError: "INVALID_MESSAGE" },
    reports: [],
  });
  await f.exchange.retry(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  await db.execute(
    sql`alter table federation_received_usage add constraint test_received_failure check (operation_id <> ${sql.raw(`'${f.operationId}'::uuid`)})`,
  );
  try {
    await f.exchange.advanceNext();
    expect(await f.exchangeView()).toMatchObject({
      sync: { number: 0, lastError: "EXCHANGE_RETRY" },
      reports: [],
    });
  } finally {
    await db.execute(
      sql`alter table federation_received_usage drop constraint test_received_failure`,
    );
  }
  await f.due();
  await f.exchange.advanceNext();
  expect((await f.exchangeView()).reports).toHaveLength(1);
});

test("usage exchange stops disclosure for wrong binding or revoked peer but preserves reading after execution revocation", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  const changed = new FederationUsageExchange(db, f.source.signing, async (endpoint, jws) => {
    const own = await f.trust.resolveKey(
      f.source.signing.siteId,
      f.source.signing.keyId,
      new Date(),
    );
    const { payload } = await verifyFederationMessage(
      CommercialUsageQuerySchema,
      jws,
      own,
      new Date(),
    );
    const wrong = await signFederationMessage(
      CommercialUsageQuerySchema,
      { ...payload, taskId: randomUUID() },
      f.source.signing,
    );
    await expect(f.responder.receive(wrong, f.fingerprint)).rejects.toThrow("POLICY_DENIED");
    await db
      .update(federationAgreements)
      .set({ state: "revoked" })
      .where(eq(federationAgreements.revisionId, f.terms.agreementRevisionId));
    return f.send(endpoint, jws, "/federation/v1/usage");
  });
  await changed.advanceNext();
  expect((await f.exchangeView()).reports).toHaveLength(1);
  await f.due();
  const revoked = new FederationUsageExchange(db, f.source.signing, async (endpoint, jws, path) => {
    const response = await f.send(endpoint, jws, path);
    await db
      .update(federationSites)
      .set({ state: "revoked" })
      .where(eq(federationSites.id, f.provider.signing.siteId));
    return response;
  });
  await revoked.advanceNext();
  expect(await f.exchangeView()).toMatchObject({
    sync: { number: 1, state: "needs_review", lastError: "UNTRUSTED_IDENTITY" },
  });
});

test("usage exchange validates historical signatures after natural key expiry under a fresh provider signature", async () => {
  const f = await exchangeFixture();
  const original = (await f.view()).reports[0];
  if (!original) throw new Error("Missing original");
  const rotated = await testKeys(f.provider.signing.siteId);
  rotated.signing.keyId += "-rotated";
  await f.trust.addKey(
    f.provider.signing.siteId,
    {
      keyId: rotated.signing.keyId,
      publicKeyPem: await exportSPKI(rotated.verification.publicKey),
      allowedKinds: ["commercial-usage-page"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z",
    },
    f.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({ validUntil: new Date(new Date(original.report.reportedAt).getTime() + 1) })
    .where(eq(federationSigningKeys.keyId, f.provider.signing.keyId));
  const provider = new FederationUsageExchange(db, rotated.signing);
  const source = new FederationUsageExchange(db, f.source.signing, async (_endpoint, jws) =>
    provider.receive(jws, f.fingerprint),
  );
  await source.discover();
  await source.advanceNext();
  expect((await f.exchangeView()).reports[0]?.reportJws).toBe(original.reportJws);
});

test("usage exchange HTTP enforces private JOSE ingress, organization reads and explicit refresh capability", async () => {
  const f = await exchangeFixture();
  const ingress = createFederationIngress(db, f.provider.signing);
  expect(
    (await ingress.request("/federation/v1/usage", { method: "POST", body: "{}" })).status,
  ).toBe(415);
  expect(
    (
      await ingress.request("/federation/v1/usage", {
        method: "POST",
        headers: { "content-type": "application/jose" },
        body: "invalid",
      })
    ).status,
  ).not.toBe(200);
  await f.exchange.discover();
  await f.exchange.advanceNext();
  const app = new Hono();
  let actor = f.sourceActor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.sourceApprovals,
      new FederationCommercialSubmissionService(db, f.source.signing.siteId),
      undefined,
      f.exchange,
    ),
  );
  const path = `/federation/commercial-agreements/${f.terms.agreementRevisionId}/received-usage/${f.operationId}`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await response.json())).not.toContain("pageJws");
  actor = f.actor;
  expect((await app.request(path)).status).not.toBe(200);
  actor = f.sourceActor;
  await new FederationPermissionService(db).set(
    { ...actor, capability: "agreement.read", enabled: true },
    actor.userId,
  );
  await new FederationPermissionService(db).set(
    { ...actor, capability: "agreement.approve", enabled: false },
    actor.userId,
  );
  expect((await app.request(path)).status).toBe(200);
  expect(
    (
      await app.request(`${path}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});

test("usage exchange rejects signed pages with broken sequence or correction commitments", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  await f.exchange.advanceNext();
  const original = (await f.view()).reports[0];
  if (!original) throw new Error("Missing report");
  await f.usage.correct(f.actor, f.terms.agreementRevisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: original.id,
    reason: "Technical evidence",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "12",
        supportingEvidenceDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
  });
  for (const change of ["sequence", "commitment", "quantity"] as const) {
    await f.exchange.retry(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
    const malicious = new FederationUsageExchange(
      db,
      f.source.signing,
      async (endpoint, query, path) => {
        const result = await f.send(endpoint, query, path);
        const peer = await f.trust.resolveKey(
          f.provider.signing.siteId,
          f.provider.signing.keyId,
          new Date(),
        );
        const { payload } = await verifyFederationMessage(
          CommercialUsagePageSchema,
          result,
          peer,
          new Date(),
        );
        if (!payload.item?.correctionEvidence) throw new Error("Missing correction");
        if (change === "sequence") payload.item.number++;
        else if (change === "commitment")
          payload.item.correctionEvidence.previousDigest = `sha256:${"0".repeat(64)}`;
        else {
          const measurement = payload.item.report.measurements[0];
          if (!measurement) throw new Error("Missing measurement");
          measurement.quantity = "0";
          payload.item.reportJws = await signFederationMessage(
            CommercialUsageSchema,
            payload.item.report,
            f.provider.signing,
          );
        }
        return signFederationMessage(CommercialUsagePageSchema, payload, f.provider.signing);
      },
    );
    await malicious.advanceNext();
    const view = await f.exchangeView();
    expect(view.sync).toMatchObject({
      number: 1,
      state: "needs_review",
      lastError: "INVALID_MESSAGE",
    });
    expect(view.reports).toHaveLength(1);
  }
});

test("usage exchange fences a late response after another worker recovers the expired lease", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = new FederationUsageExchange(db, f.source.signing, async (endpoint, query, path) => {
    const response = await f.send(endpoint, query, path);
    signal();
    await held;
    return response;
  });
  const running = slow.advanceNext();
  try {
    await entered;
    await db
      .update(federationUsageSyncs)
      .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(federationUsageSyncs.localSiteId, f.source.signing.siteId));
    await f.exchange.advanceNext();
    expect((await f.exchangeView()).sync).toMatchObject({ number: 1, lastError: null });
  } finally {
    release();
    await running;
  }
  expect((await f.exchangeView()).reports).toHaveLength(1);
  expect((await f.exchangeView()).sync).toMatchObject({
    number: 1,
    state: "pending",
    lastError: null,
  });
});

test("usage exchange worker needs explicit new signing purposes and runs independently of Fabric or departed staff", async () => {
  const f = await exchangeFixture();
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-usage"] })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  const worker = new FederationCommercialWorker(
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
    undefined,
    f.exchange,
  );
  await worker.tick();
  expect(f.delivered).toHaveLength(0);
  expect((await f.exchangeView()).sync).toMatchObject({
    state: "needs_review",
    number: 0,
    lastError: "UNTRUSTED_IDENTITY",
  });
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-usage", "commercial-usage-query"] })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  await f.exchange.retry(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  await db
    .delete(federationCapabilities)
    .where(eq(federationCapabilities.userId, f.sourceActor.userId));
  await worker.tick();
  await worker.stop();
  expect(
    await db
      .select()
      .from(federationReceivedUsage)
      .where(eq(federationReceivedUsage.localSiteId, f.source.signing.siteId)),
  ).toHaveLength(1);
  await expect(f.exchangeView()).rejects.toThrow("POLICY_DENIED");
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.source.signing.siteId)),
  ).toHaveLength(0);
});

test("usage exchange keeps received history and authorization when transport is disabled", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  await f.exchange.advanceNext();
  const offline = new FederationUsageExchange(db, f.source.signing);
  const app = new Hono();
  let actor = f.sourceActor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      f.sourceApprovals,
      new FederationCommercialSubmissionService(db, f.source.signing.siteId),
      undefined,
      offline,
    ),
  );
  const path = `/federation/commercial-agreements/${f.terms.agreementRevisionId}/received-usage`;
  const list = await app.request(path);
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ data: [{ operationId: f.operationId }] });
  const response = await app.request(`${path}/${f.operationId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    data: { syncEnabled: false, reports: [{ number: 1 }] },
  });
  const before = await offline.get(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  expect(before.reports).toHaveLength(1);
  const refresh = await app.request(`${path}/${f.operationId}/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(refresh.status).toBe(409);
  expect(await refresh.json()).toMatchObject({ error: { code: "ASSET_UNAVAILABLE" } });
  await offline.discover();
  expect(await offline.advanceNext()).toBe(false);
  const saved = await offline.get(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  expect(saved.sync).toEqual(before.sync);
  actor = f.actor;
  expect((await app.request(`${path}/${f.operationId}`)).status).not.toBe(200);
});

async function accountingFixture() {
  const f = await usageFixture("bilateral_direct", true);
  await f.usage.discover();
  await f.usage.advanceNext();
  cleanup.push(async () => {
    await db
      .delete(federationAccountingCollections)
      .where(eq(federationAccountingCollections.jobId, f.jobId));
  });
  const sent: FederationAccountingRequest[] = [];
  const collection = new FederationAccountingCollection(
    db,
    f.provider.signing.siteId,
    (_agent, request) => {
      sent.push(request);
      return true;
    },
  );
  const sample = (request: FederationAccountingRequest, quantity = "2018") => ({
    request,
    state: "observed",
    observation: {
      version: 1,
      requestId: request.requestId,
      jobId: request.jobId,
      dispatchEpoch: request.dispatchEpoch,
      originalEvidenceDigest: request.originalEvidenceDigest,
      terminalStatus: "completed",
      accounting: {
        version: 1,
        source: "slurm-sacct",
        schedulerJobId: request.schedulerJobId,
        observedAt: new Date().toISOString(),
        cpuTimeMilliseconds: quantity,
      },
    },
  });
  const work = async () =>
    (
      await db
        .select()
        .from(federationAccountingCollections)
        .where(eq(federationAccountingCollections.jobId, f.jobId))
    )[0];
  return { ...f, collection, sent, sample, work };
}

test("accounting collection appends evidence and generates one signed report without rewriting terminal facts", async () => {
  const f = await accountingFixture();
  const original = await f.read();
  await f.collection.discover();
  await f.collection.advanceNext();
  const request = f.sent[0];
  if (!request) throw new Error("No accounting request");
  await f.collection.receive(f.agentId, JSON.stringify(f.sample(request)));
  expect((await f.work())?.state).toBe("collected");
  expect(await f.read()).toEqual(original);
  await f.usage.advanceNext();
  const view = await f.view();
  expect(view.task.state).toBe("reported");
  expect(view.reports[0]?.report.measurements[0]?.quantity).toBe("2018");
  expect(view.reports[0]?.evidenceSet.records[0]).toMatchObject({
    digest: original?.digest,
    accountingDigest: (await f.work())?.digest,
  });
  await f.collection.receive(f.agentId, JSON.stringify(f.sample(request, "99")));
  expect((await f.work())?.observation?.accounting.cpuTimeMilliseconds).toBe("2018");
  expect((await f.view()).reports).toHaveLength(1);
});

test("accounting collection fences concurrent claims and late responses across restarts", async () => {
  const f = await accountingFixture();
  await f.collection.discover();
  await Promise.all([f.collection.advanceNext(), f.collection.advanceNext()]);
  expect(f.sent).toHaveLength(1);
  const old = f.sent[0];
  if (!old) throw new Error("No request");
  await db
    .update(federationAccountingCollections)
    .set({ leaseUntil: new Date(0), nextAttemptAt: new Date(0) })
    .where(eq(federationAccountingCollections.jobId, f.jobId));
  const restarted = new FederationAccountingCollection(
    db,
    f.provider.signing.siteId,
    (_agent, request) => {
      f.sent.push(request);
      return true;
    },
  );
  await restarted.advanceNext();
  const next = f.sent[1];
  if (!next) throw new Error("No retry");
  expect(next.requestId).not.toBe(old.requestId);
  await restarted.receive(f.agentId, JSON.stringify(f.sample(old)));
  expect((await f.work())?.observation).toBeNull();
  await restarted.receive(f.agentId, JSON.stringify(f.sample(next)));
  expect((await f.work())?.observation?.requestId).toBe(next.requestId);
});

test("accounting collection rejects foreign Agent and mismatched binding, retaining missing data", async () => {
  const f = await accountingFixture();
  await f.collection.discover();
  await f.collection.advanceNext();
  const request = f.sent[0];
  if (!request) throw new Error("No request");
  await expect(
    f.collection.receive("wrong-agent", JSON.stringify(f.sample(request))),
  ).rejects.toThrow("identity mismatch");
  const broken = f.sample(request);
  broken.observation.originalEvidenceDigest = `sha256:${"f".repeat(64)}`;
  await expect(f.collection.receive(f.agentId, JSON.stringify(broken))).rejects.toThrow(
    "binding mismatch",
  );
  expect((await f.work())?.observation).toBeNull();
  await f.collection.receive(f.agentId, JSON.stringify({ request, state: "unavailable" }));
  expect((await f.work())?.lastError).toBe("ACCOUNTING_UNAVAILABLE");
  expect((await f.view()).reports).toHaveLength(0);
});

test("accounting collection preserves pending work offline and manual review can resume identity failures", async () => {
  const f = await accountingFixture();
  await f.collection.discover();
  const offline = new FederationAccountingCollection(db, f.provider.signing.siteId, () => false);
  await offline.advanceNext();
  expect((await f.work())?.lastError).toBe("AGENT_UNAVAILABLE");
  await db
    .update(federationAccountingCollections)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(federationAccountingCollections.jobId, f.jobId));
  await f.collection.advanceNext();
  const request = f.sent[0];
  if (!request) throw new Error("No request");
  await f.collection.receive(f.agentId, JSON.stringify({ request, state: "identity_mismatch" }));
  expect((await f.work())?.state).toBe("needs_review");
  await f.usage.retry(f.actor, f.terms.agreementRevisionId, f.reservationId);
  expect((await f.work())?.state).toBe("pending");
});

test("accounting collection commits observation and report wakeup atomically and leaves incomplete samples pending", async () => {
  const f = await accountingFixture();
  await f.collection.discover();
  await f.collection.advanceNext();
  const request = f.sent[0];
  if (!request) throw new Error("No request");
  await db.execute(
    sql`ALTER TABLE federation_usage_tasks ADD CONSTRAINT accounting_test_failure CHECK (false) NOT VALID`,
  );
  try {
    await expect(
      f.collection.receive(f.agentId, JSON.stringify(f.sample(request))),
    ).rejects.toThrow();
  } finally {
    await db.execute(
      sql`ALTER TABLE federation_usage_tasks DROP CONSTRAINT accounting_test_failure`,
    );
  }
  expect((await f.work())?.observation).toBeNull();
  expect((await f.work())?.state).toBe("pending");
  const full = f.sample(request);
  await f.collection.receive(
    f.agentId,
    JSON.stringify({
      ...full,
      observation: {
        ...full.observation,
        accounting: {
          ...full.observation.accounting,
          cpuTimeMilliseconds: undefined,
          elapsedMilliseconds: "2000",
        },
      },
    }),
  );
  expect((await f.work())?.lastError).toBe("ACCOUNTING_INCOMPLETE");
  expect((await f.work())?.observation).toBeNull();
});

async function billingFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await exchangeFixture(false, mode);
  cleanup.push(async () => {
    for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId]) {
      const pending = await db
        .select({ id: federationCommercialSubmissions.id })
        .from(federationCommercialSubmissions)
        .where(eq(federationCommercialSubmissions.localSiteId, siteId));
      if (pending.length)
        await db.delete(federationCommercialAttempts).where(
          inArray(
            federationCommercialAttempts.submissionId,
            pending.map((row) => row.id),
          ),
        );
      await db
        .delete(federationCommercialSubmissions)
        .where(eq(federationCommercialSubmissions.localSiteId, siteId));
      await db
        .delete(federationCommercialBills)
        .where(eq(federationCommercialBills.localSiteId, siteId));
      await db
        .delete(federationCommercialDiscounts)
        .where(eq(federationCommercialDiscounts.localSiteId, siteId));
    }
  });
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          "commercial-agreement",
          "commercial-usage",
          "commercial-usage-query",
          "commercial-usage-page",
          "commercial-bill",
          "commercial-settlement",
          "commercial-discount",
        ],
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  for (const actor of [f.actor, f.sourceActor])
    await new FederationPermissionService(db).set(
      { ...actor, capability: "billing.approve", enabled: true },
      actor.userId,
    );
  await f.exchange.discover();
  await f.exchange.advanceNext();
  const report = (await f.exchangeView()).reports[0];
  if (!report) throw new Error("Missing received usage");
  const observedAt = new Date().toISOString();
  await db
    .update(federationOutbound)
    .set({
      statusReport: {
        protocolVersion: 1,
        kind: "status-report",
        queryId: randomUUID(),
        queryDigest: `sha256:${"a".repeat(64)}`,
        senderSiteId: f.provider.signing.siteId,
        recipientSiteId: f.source.signing.siteId,
        operationId: f.operationId,
        agreementRevisionId: f.terms.agreementRevisionId,
        taskId: f.reservation.taskId,
        attempt: 1,
        reservationId: f.reservationId,
        requestDigest: f.reservation.requestDigest,
        observedAt,
        preparation: null,
        workflow: { status: "completed", updatedAt: observedAt },
      },
      statusReportJws: "previously-verified-status-fixture",
      statusVerifiedAt: new Date(),
    })
    .where(
      and(
        eq(federationOutbound.localSiteId, f.source.signing.siteId),
        eq(federationOutbound.operationId, f.operationId),
      ),
    );
  const sourceBilling = new FederationBillingService(db, f.source.signing),
    providerBilling = new FederationBillingService(db, f.provider.signing);
  const revisionId = f.terms.agreementRevisionId;
  const draft = await providerBilling.draft(
    f.actor,
    revisionId,
    report.report.reportId,
    randomUUID(),
  );
  const approveBoth = async (bill = draft) => {
    const provider = await providerBilling.approve(f.actor, revisionId, bill);
    const source = await sourceBilling.approve(f.sourceActor, revisionId, bill);
    await providerBilling.attachCounterparty(f.actor, revisionId, bill.billId, source.approvalJws);
    await sourceBilling.attachCounterparty(
      f.sourceActor,
      revisionId,
      bill.billId,
      provider.approvalJws,
    );
    return { provider, source };
  };
  return { ...f, report, revisionId, sourceBilling, providerBilling, draft, approveBoth };
}

test("billing direct confirms both institutions independently without chain work or changes to reserved money", async () => {
  const f = await billingFixture();
  const before = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  const signatures = await f.approveBoth();
  expect(f.draft.calculation.dueAmount).toBe("60");
  expect(
    (await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBe(signatures.provider.approvalJws);
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBe(signatures.source.approvalJws);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.budgetDomainId)),
  ).toEqual(before);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        inArray(federationCommercialSubmissions.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      ),
  ).toHaveLength(0);
});

test("billing discount is provider signed, imported by source and changes only the separately approved amount", async () => {
  const f = await billingFixture();
  const terms = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: f.draft.billId,
    domainId: f.contract.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    reportId: f.draft.reportId,
    reportDigest: f.draft.reportDigest,
    taskId: f.draft.request.taskId,
    attempt: 1,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    unit: f.draft.request.unit,
    amount: "7",
    reason: "Agreed service concession",
    issuedAt: new Date().toISOString(),
    salt: "b".repeat(64),
  });
  await expect(f.sourceBilling.approveDiscount(f.sourceActor, f.revisionId, terms)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const saved = await f.providerBilling.approveDiscount(f.actor, f.revisionId, terms);
  await f.sourceBilling.importDiscount(f.sourceActor, f.revisionId, saved.providerJws);
  const draft = await f.providerBilling.draft(
    f.actor,
    f.revisionId,
    f.draft.reportId,
    f.draft.billId,
    terms.discountId,
  );
  expect(draft.calculation.dueAmount).toBe("53");
  await f.approveBoth(draft);
  expect((await f.view()).reports[0]?.digest).toBe(f.draft.reportDigest);
  await expect(
    f.providerBilling.approveDiscount(f.actor, f.revisionId, {
      ...terms,
      discountId: randomUUID(),
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("billing requires explicit approval capability and original organization, values and delegation", async () => {
  const f = await billingFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  await expect(f.providerBilling.approve(f.sourceActor, f.revisionId, f.draft)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(
    f.providerBilling.approve(f.actor, f.revisionId, {
      ...f.draft,
      request: { ...f.draft.request, operationId: randomUUID() },
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.providerBilling.approve(f.actor, f.revisionId, {
      ...f.draft,
      calculation: { ...f.draft.calculation, dueAmount: "1" },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-usage"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});

test("billing concurrent same approval is idempotent and a second bill cannot bind the same attempt", async () => {
  const f = await billingFixture();
  const rows = await Promise.all(
    Array.from({ length: 4 }, () => f.providerBilling.approve(f.actor, f.revisionId, f.draft)),
  );
  expect(new Set(rows.map((row) => row.approvalJws)).size).toBe(1);
  await expect(
    f.providerBilling.approve(f.actor, f.revisionId, { ...f.draft, billId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actor, f.userId), eq(auditLog.action, "federation.billing.approve"))),
  ).toHaveLength(1);
});

test("billing fresh correction rejects new drafts but preserves already signed approvals without rewriting history", async () => {
  const f = await billingFixture();
  const original = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const counterparty = await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.usage.correct(f.actor, f.revisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: f.draft.reportId,
    reason: "Late accounting observation",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "1",
        supportingEvidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  await expect(
    f.providerBilling.draft(f.actor, f.revisionId, f.draft.reportId, randomUUID()),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await f.providerBilling.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.billId,
    counterparty.approvalJws,
  );
  const row = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill;
  expect(row?.approvalJws).toBe(original.approvalJws);
  expect(row?.counterpartyJws).toBe(counterparty.approvalJws);
});

test("billing attested confirmation survives an unavailable ledger and waits for original usage before disclosure", async () => {
  const f = await billingFixture("bilateral_attested");
  await f.approveBoth();
  const queue = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  const bill = queue.find((row) => row.input.operation === "confirm-bill"),
    usage = queue.find((row) => row.input.operation === "record-usage");
  if (!bill || !usage) throw new Error("Missing billing outbox");
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' = 'register-agreement'`,
      ),
    );
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "needs_review" })
    .where(eq(federationCommercialSubmissions.id, usage.id));
  const seen: string[] = [];
  const worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async (input) => {
      seen.push(input.operation);
      throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    },
    advance: async () => {
      throw new Error("No checkpoint yet");
    },
  });
  expect(await worker.advanceNext()).toBe(false);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, usage.id));
  expect(await worker.advanceNext()).toBe(true);
  expect(seen).toEqual(["confirm-bill"]);
  const view = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(view?.bill.counterpartyJws).not.toBeNull();
  expect(view?.ledger?.state).toBe("pending");
  expect(view?.ledger?.lastError).toBe("LEDGER_UNAVAILABLE");
});

test("billing audit failure rolls back the approval and attested outbox failure rolls back confirmation", async () => {
  const f = await billingFixture("bilateral_attested");
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT billing_audit_fixture CHECK (action <> 'federation.billing.approve' OR target <> '${f.draft.billId}')`,
    ),
  );
  try {
    await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow();
    expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT billing_audit_fixture`);
  }
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const other = await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await db.execute(
    sql.raw(
      `ALTER TABLE federation_commercial_submissions ADD CONSTRAINT billing_outbox_fixture CHECK (input->>'recordId' <> '${f.draft.billId}')`,
    ),
  );
  try {
    await expect(
      f.providerBilling.attachCounterparty(
        f.actor,
        f.revisionId,
        f.draft.billId,
        other.approvalJws,
      ),
    ).rejects.toThrow();
    expect(
      (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
    ).toBeNull();
  } finally {
    await db.execute(
      sql`ALTER TABLE federation_commercial_submissions DROP CONSTRAINT billing_outbox_fixture`,
    );
  }
  await f.providerBilling.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.billId,
    other.approvalJws,
  );
  expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.ledger?.state).toBe(
    "pending",
  );
});

test("billing confirmed records remain readable and replayable after a later technical correction", async () => {
  const f = await billingFixture();
  const signed = await f.approveBoth();
  await f.usage.correct(f.actor, f.revisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: f.draft.reportId,
    reason: "Late sample",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "1",
        supportingEvidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  const replay = await f.providerBilling.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.billId,
    signed.source.approvalJws,
  );
  expect(replay.payload.calculation.dueAmount).toBe("60");
  expect(replay.payload.reportId).toBe(f.draft.reportId);
  expect((await f.view()).reports).toHaveLength(2);
});

test("billing disclosure rechecks the immutable local approval and current signer trust", async () => {
  const f = await billingFixture("bilateral_attested");
  await f.approveBoth();
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' <> 'confirm-bill'`,
      ),
    );
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  let calls = 0;
  const worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async () => {
      calls++;
      throw new Error("Must not disclose");
    },
    advance: async () => {
      calls++;
      throw new Error("Must not disclose");
    },
  });
  expect(await worker.advanceNext()).toBe(true);
  expect(calls).toBe(0);
  const row = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(row?.ledger?.state).toBe("needs_review");
  expect(row?.bill.counterpartyJws).not.toBeNull();
});

test("billing HTTP rejects automation, unknown fields and agreement-only approvers and keeps reads private", async () => {
  const f = await billingFixture();
  const app = new Hono();
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    f.approvals,
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[15] = f.providerBilling;
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const base = `/federation/commercial-agreements/${f.revisionId}/bills`;
  const post = (value: unknown) =>
    app.request(`${base}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const read = await app.request(base);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect((await post({ ...f.draft, paid: true })).status).toBe(400);
  automation = true;
  expect((await post(f.draft)).status).toBe(403);
  automation = false;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  expect((await post(f.draft)).status).toBe(403);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  expect((await post(f.draft)).status).toBe(201);
});

test("billing discount outbox precedes bill evidence, original concessions replay after correction, and retry authority stays separate", async () => {
  const f = await billingFixture("bilateral_attested");
  const concession = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: f.draft.billId,
    domainId: f.contract.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    reportId: f.draft.reportId,
    reportDigest: f.draft.reportDigest,
    taskId: f.draft.request.taskId,
    attempt: 1,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    unit: f.draft.request.unit,
    amount: "7",
    reason: "Agreed concession",
    issuedAt: new Date().toISOString(),
    salt: "c".repeat(64),
  });
  const copies = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.providerBilling.approveDiscount(f.actor, f.revisionId, concession),
    ),
  );
  const saved = copies[0];
  if (!saved) throw new Error("Missing concession");
  expect(new Set(copies.map((row) => row.providerJws)).size).toBe(1);
  await f.sourceBilling.importDiscount(f.sourceActor, f.revisionId, saved.providerJws);
  const draft = await f.providerBilling.draft(
    f.actor,
    f.revisionId,
    f.draft.reportId,
    f.draft.billId,
    concession.discountId,
  );
  await f.approveBoth(draft);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' IN ('register-agreement','record-usage')`,
      ),
    );
  const seen: string[] = [];
  const worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async (input) => {
      seen.push(input.operation);
      throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    },
    advance: async () => {
      throw new Error("No checkpoint");
    },
  });
  expect(await worker.advanceNext()).toBe(true);
  expect(seen).toEqual(["record-discount"]);
  expect(await worker.advanceNext()).toBe(false);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' = 'record-discount'`,
      ),
    );
  expect(await worker.advanceNext()).toBe(true);
  expect(seen).toEqual(["record-discount", "confirm-bill"]);
  const row = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0];
  if (!row?.ledger) throw new Error("Missing bill outbox");
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "needs_review" })
    .where(eq(federationCommercialSubmissions.id, row.ledger.id));
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  await expect(worker.retry(f.actor, f.revisionId, row.ledger.id)).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: false },
    f.userId,
  );
  await worker.retry(f.actor, f.revisionId, row.ledger.id);
  expect(
    (await f.providerBilling.listDiscounts(f.actor, f.revisionId, 10, 0)).data[0]?.discount.digest,
  ).toBe(saved.digest);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "agreement.approve", enabled: true },
    f.userId,
  );
  await f.usage.correct(f.actor, f.revisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: f.draft.reportId,
    reason: "Late sample",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "1",
        supportingEvidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  expect(
    (await f.providerBilling.approveDiscount(f.actor, f.revisionId, concession)).providerJws,
  ).toBe(saved.providerJws);
  expect(await worker.advanceNext()).toBe(true);
  expect(seen.at(-1)).toBe("confirm-bill");
  expect(await worker.advanceNext()).toBe(false);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.id, row.ledger.id));
  expect(await worker.advanceNext()).toBe(true);
  expect(seen.at(-1)).toBe("record-usage");
});

test("billing unsigned counterparty cannot be replaced by an own signature or a differently priced bill", async () => {
  const f = await billingFixture();
  const local = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await expect(
    f.providerBilling.attachCounterparty(f.actor, f.revisionId, f.draft.billId, local.approvalJws),
  ).rejects.toThrow();
  const other = await signFederationMessage(
    CommercialBillSchema,
    { ...f.draft, calculation: { ...f.draft.calculation, dueAmount: "1" } },
    f.source.signing,
  );
  await expect(
    f.providerBilling.attachCounterparty(f.actor, f.revisionId, f.draft.billId, other),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
});

test("billing pending signature blocks later correction evidence until the original offer is resolved", async () => {
  const f = await billingFixture("bilateral_attested");
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  await f.usage.correct(f.actor, f.revisionId, f.reservationId, {
    reportId: randomUUID(),
    correctionOf: f.draft.reportId,
    reason: "Late sample",
    measurements: [
      {
        ...commercialAutomaticMeters[0],
        quantity: "1",
        supportingEvidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  let calls = 0;
  const worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
    prepare: async () => {
      calls++;
      throw new Error("Must preserve order");
    },
    advance: async () => {
      calls++;
      throw new Error("Must preserve order");
    },
  });
  expect(await worker.advanceNext()).toBe(false);
  expect(calls).toBe(0);
  expect((await f.view()).reports).toHaveLength(2);
});

async function billingExchangeFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await billingFixture(mode);
  const providerFingerprint = randomUUID().replaceAll("-", "").repeat(2);
  cleanup.push(async () => {
    for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId]) {
      await db
        .delete(federationCommercialApprovalSyncs)
        .where(eq(federationCommercialApprovalSyncs.localSiteId, siteId));
      await db.delete(auditLog).where(eq(auditLog.actor, `billing-exchange:${siteId}`));
    }
    await db
      .delete(federationCertificates)
      .where(eq(federationCertificates.fingerprint, providerFingerprint));
  });
  await db.insert(federationCertificates).values({
    fingerprint: providerFingerprint,
    siteId: f.provider.signing.siteId,
    certificatePem: "Authenticated peer fixture; TLS tested in the network suite",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2100-01-01"),
  });
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: [
          "commercial-agreement",
          "commercial-usage",
          "commercial-usage-query",
          "commercial-usage-page",
          "commercial-bill",
          "commercial-settlement",
          "commercial-discount",
          "commercial-approval-query",
          "commercial-approval-waiting",
        ],
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  const sourceResponder = new FederationCommercialApprovalExchange(db, f.source.signing);
  const providerResponder = new FederationCommercialApprovalExchange(db, f.provider.signing);
  const transport: { afterResponse?: (jws: string) => Promise<string>; calls: number } = {
    calls: 0,
  };
  const sendSource: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-approvals");
    transport.calls++;
    const response = await providerResponder.receive(jws, f.fingerprint);
    return transport.afterResponse ? transport.afterResponse(response) : response;
  };
  const sendProvider: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-approvals");
    transport.calls++;
    const response = await sourceResponder.receive(jws, providerFingerprint);
    return transport.afterResponse ? transport.afterResponse(response) : response;
  };
  const sourceAuto = new FederationCommercialApprovalExchange(db, f.source.signing, sendSource);
  const providerAuto = new FederationCommercialApprovalExchange(
    db,
    f.provider.signing,
    sendProvider,
  );
  const due = () =>
    db
      .update(federationCommercialApprovalSyncs)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(
        inArray(federationCommercialApprovalSyncs.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      );
  const status = async (provider = true) =>
    (
      await (provider ? providerAuto : sourceAuto).list(
        provider ? f.actor : f.sourceActor,
        f.revisionId,
        10,
        0,
      )
    ).records.find((row) => row.recordKind === "bill");
  return {
    ...f,
    providerFingerprint,
    sourceAuto,
    providerAuto,
    sendSource,
    sendProvider,
    transport,
    due,
    status,
  };
}

test("billing exchange waits for independent approval then attaches exact originals at both institutions", async () => {
  const f = await billingExchangeFixture();
  const provider = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  expect(await f.providerAuto.advanceNext()).toBe(true);
  expect((await f.status())?.state).toBe("pending");
  expect((await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(0);
  const source = await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.sourceAuto.discover();
  await f.due();
  await Promise.all([f.providerAuto.advanceNext(), f.sourceAuto.advanceNext()]);
  expect((await f.status())?.state).toBe("complete");
  expect((await f.status(false))?.state).toBe("complete");
  const p = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill;
  const a = (await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data[0]?.bill;
  expect(p?.approvalJws).toBe(provider.approvalJws);
  expect(p?.counterpartyJws).toBe(source.approvalJws);
  expect(a?.approvalJws).toBe(source.approvalJws);
  expect(a?.counterpartyJws).toBe(provider.approvalJws);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        inArray(federationCommercialSubmissions.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      ),
  ).toHaveLength(0);
});

test("billing exchange response loss and restart keep a single attested confirmation and ledger intent", async () => {
  const f = await billingExchangeFixture("bilateral_attested");
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const source = await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  f.transport.afterResponse = async () => {
    throw new Error("Dropped response");
  };
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("pending");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
  delete f.transport.afterResponse;
  await f.due();
  const restarted = new FederationCommercialApprovalExchange(
    db,
    f.provider.signing,
    f.sendProvider,
  );
  await Promise.all([restarted.advanceNext(), restarted.advanceNext()]);
  expect((await f.status())?.state).toBe("complete");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBe(source.approvalJws);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' = 'confirm-bill'`,
        ),
      ),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, `billing-exchange:${f.provider.signing.siteId}`),
          eq(auditLog.target, f.draft.billId),
        ),
      ),
  ).toHaveLength(1);
});

test("billing exchange existing approval survives departing staff without granting a new approval", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  await db.update(users).set({ suspended: true }).where(eq(users.id, f.userId));
  try {
    await f.providerAuto.advanceNext();
    const [sync] = await db
      .select()
      .from(federationCommercialApprovalSyncs)
      .where(
        and(
          eq(federationCommercialApprovalSyncs.localSiteId, f.provider.signing.siteId),
          eq(federationCommercialApprovalSyncs.recordId, f.draft.billId),
        ),
      );
    expect(sync?.lastError).toBeNull();
    expect(sync?.state).toBe("complete");
    await expect(
      f.providerBilling.approve(f.actor, f.revisionId, { ...f.draft, billId: randomUUID() }),
    ).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, f.userId));
  }
});

test("billing exchange rejects two independently approved but different payloads", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, { ...f.draft, salt: "d".repeat(64) });
  await f.providerAuto.discover();
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("needs_review");
  expect((await f.status())?.lastError).toBe("OPERATION_CONFLICT");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
});

test("billing exchange audit failure rolls back signature, progress and ledger intent together", async () => {
  const f = await billingExchangeFixture("bilateral_attested");
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT bill_exchange_audit_fixture CHECK (action <> 'federation.billing.counterparty' OR target <> '${f.draft.billId}')`,
    ),
  );
  try {
    await f.providerAuto.advanceNext();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT bill_exchange_audit_fixture`);
  }
  expect((await f.status())?.state).toBe("pending");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' = 'confirm-bill'`,
        ),
      ),
  ).toHaveLength(0);
  await f.due();
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
});

test("billing exchange expired execution still permits historical consent under current signing trust", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  await db
    .update(federationSigningKeys)
    .set({ validUntil: new Date("2100-01-01") })
    .where(
      inArray(federationSigningKeys.siteId, [f.source.signing.siteId, f.provider.signing.siteId]),
    );
  try {
    setSystemTime(new Date("2099-02-01"));
    await f.providerAuto.advanceNext();
    expect((await f.status())?.state).toBe("complete");
  } finally {
    setSystemTime();
  }
});

test("billing exchange builds its minute window from one clock observation", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  const current = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => current() + 5);
  try {
    await f.providerAuto.advanceNext();
    expect((await f.status())?.lastError).toBeNull();
    expect((await f.status())?.state).toBe("complete");
  } finally {
    clock.mockRestore();
  }
});

test("billing exchange late response cannot overwrite another lease and retry requires bill authority", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  const key = and(
    eq(federationCommercialApprovalSyncs.localSiteId, f.provider.signing.siteId),
    eq(federationCommercialApprovalSyncs.recordKind, "bill"),
    eq(federationCommercialApprovalSyncs.recordId, f.draft.billId),
  );
  const lease = randomUUID();
  f.transport.afterResponse = async (response) => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseToken: lease, leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
      .where(key);
    return response;
  };
  await f.providerAuto.advanceNext();
  const [waiting] = await db.select().from(federationCommercialApprovalSyncs).where(key);
  expect(waiting?.leaseToken).toBe(lease);
  expect(waiting?.state).toBe("pending");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
  const identity = {
    agreementRevisionId: f.revisionId,
    recordKind: "bill" as const,
    recordId: f.draft.billId,
  };
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  await expect(f.providerAuto.retry(f.actor, identity)).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  await expect(f.providerAuto.retry(f.actor, identity)).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationCommercialApprovalSyncs)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
    .where(key);
  delete f.transport.afterResponse;
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
});

test("billing exchange revocation during transport prevents attachment without discarding existing consent", async () => {
  const f = await billingExchangeFixture();
  const original = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  f.transport.afterResponse = async (response) => {
    await db
      .update(federationSigningKeys)
      .set({ revokedAt: new Date() })
      .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
    return response;
  };
  await f.providerAuto.advanceNext();
  expect((await f.status())?.lastError).toBe("UNTRUSTED_IDENTITY");
  const bill = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill;
  expect(bill?.approvalJws).toBe(original.approvalJws);
  expect(bill?.counterpartyJws).toBeNull();
});

test("billing exchange disabled transport retains readable history and organization scope", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  await f.providerAuto.advanceNext();
  const offline = new FederationCommercialApprovalExchange(db, f.provider.signing);
  await offline.discover();
  expect(await offline.advanceNext()).toBe(false);
  const view = await offline.list(f.actor, f.revisionId, 10, 0);
  expect(view.enabled).toBe(false);
  expect(view.records[0]?.state).toBe("complete");
  await expect(offline.list(f.sourceActor, f.revisionId, 10, 0)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
});

test("billing exchange reconciles manual attachment after discovery without resending or duplicating evidence", async () => {
  const f = await billingExchangeFixture("bilateral_attested");
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const source = await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  await f.providerBilling.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.billId,
    source.approvalJws,
  );
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
  expect(f.transport.calls).toBe(0);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' = 'confirm-bill'`,
        ),
      ),
  ).toHaveLength(1);
});

test("billing exchange HTTP exposes only scoped progress and requires independent bill retry authority", async () => {
  const f = await billingExchangeFixture();
  await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  await f.providerAuto.discover();
  const app = new Hono();
  let actor = f.actor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    f.approvals,
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[10] = f.providerAuto;
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revisionId}/approval-exchange`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain(f.draft.billId);
  for (const field of ["approvalJws", "leaseToken", "dueAmount", "prices", "payload"])
    expect(body).not.toContain(field);
  const retry = (value: unknown = {}) =>
    app.request(`${path}/bill/${f.draft.billId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  expect((await retry({ approve: true })).status).toBe(400);
  const permissions = new FederationPermissionService(db);
  await permissions.set({ ...f.actor, capability: "billing.approve", enabled: false }, f.userId);
  expect((await retry()).status).toBe(403);
  await permissions.set({ ...f.actor, capability: "billing.approve", enabled: true }, f.userId);
  await permissions.set({ ...f.actor, capability: "agreement.approve", enabled: false }, f.userId);
  expect((await retry()).status).toBe(200);
  actor = f.sourceActor;
  expect((await app.request(path)).status).toBe(409);
  expect((await retry()).status).toBe(403);
  expect(f.transport.calls).toBe(0);
});

test("usage exchange builds its minute window from a single clock observation", async () => {
  const f = await exchangeFixture();
  await f.exchange.discover();
  const current = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => current() + 5);
  try {
    await f.exchange.advanceNext();
    const view = await f.exchangeView();
    expect(view.sync?.lastError).toBeNull();
    expect(view.reports).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

async function settlementFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await billingExchangeFixture(mode);
  cleanup.push(async () => {
    for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId]) {
      await db
        .delete(federationCommercialSettlements)
        .where(eq(federationCommercialSettlements.localSiteId, siteId));
      await db
        .delete(auditLog)
        .where(inArray(auditLog.actor, [`settlement:${siteId}`, `settlement-exchange:${siteId}`]));
    }
  });
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: f.draft.billId,
    domainId: f.contract.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    reportId: f.draft.reportId,
    reportDigest: f.draft.reportDigest,
    taskId: f.draft.request.taskId,
    attempt: 1,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    unit: f.draft.request.unit,
    amount: "7",
    reason: "Agreed concession",
    issuedAt: new Date().toISOString(),
    salt: "c".repeat(64),
  });
  const saved = await f.providerBilling.approveDiscount(f.actor, f.revisionId, discount);
  await f.sourceBilling.importDiscount(f.sourceActor, f.revisionId, saved.providerJws);
  const bill = await f.providerBilling.draft(
    f.actor,
    f.revisionId,
    f.draft.reportId,
    f.draft.billId,
    discount.discountId,
  );
  await f.approveBoth(bill);
  for (const actor of [f.actor, f.sourceActor])
    await new FederationPermissionService(db).set(
      { ...actor, capability: "settlement.approve", enabled: true },
      actor.userId,
    );
  const sourceSettlement = new FederationSettlementService(db, f.source.signing),
    providerSettlement = new FederationSettlementService(db, f.provider.signing);
  const draft = await providerSettlement.draft(f.actor, f.revisionId, bill.billId, randomUUID());
  const approve = async () => ({
    source: await sourceSettlement.approve(f.sourceActor, f.revisionId, draft),
    provider: await providerSettlement.approve(f.actor, f.revisionId, draft),
  });
  const budget = async () =>
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId))
    )[0];
  return { ...f, bill, draft, approve, budget, sourceSettlement, providerSettlement };
}

test("settlement direct returns only unused funds, retains spent usage and replays atomically", async () => {
  const f = await settlementFixture();
  expect(f.draft).toMatchObject({ reservedAmount: "60", chargedAmount: "53", releasedAmount: "7" });
  const signed = await f.approve();
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "60", spent: "0" });
  await Promise.all(
    Array.from({ length: 4 }, () =>
      f.providerSettlement.attachCounterparty(
        f.actor,
        f.revisionId,
        f.draft.settlementId,
        signed.source.approvalJws,
      ),
    ),
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      f.sourceSettlement.attachCounterparty(
        f.sourceActor,
        f.revisionId,
        f.draft.settlementId,
        signed.provider.approvalJws,
      ),
    ),
  );
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  const [reservation] = await db
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.id, f.reservationId));
  expect(reservation).toMatchObject({ amount: "60", settledAmount: "53", state: "reserved" });
  const [source] = await db
    .select()
    .from(federationOutbound)
    .where(
      and(
        eq(federationOutbound.localSiteId, f.source.signing.siteId),
        eq(federationOutbound.operationId, f.operationId),
      ),
    );
  expect(source).toMatchObject({ amount: "60", settledAmount: "53", state: "accepted" });
  const rows = await f.providerSettlement.list(f.actor, f.revisionId, 10, 0);
  expect(rows.data[0]?.settlement.appliedAt).toBeInstanceOf(Date);
  expect(rows.data[0]?.ledger).toBeNull();
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.settlement.apply"),
          eq(auditLog.target, f.draft.settlementId),
        ),
      ),
  ).toHaveLength(2);
});

test("settlement requires its own capability and original bill scope and amount", async () => {
  const f = await settlementFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.providerSettlement.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "settlement.approve", enabled: true },
    f.actor.userId,
  );
  await expect(f.providerSettlement.approve(f.sourceActor, f.revisionId, f.draft)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(
    f.providerSettlement.approve(f.actor, f.revisionId, {
      ...f.draft,
      chargedAmount: "52",
      releasedAmount: "8",
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    f.providerSettlement.approve(f.actor, f.revisionId, {
      ...f.draft,
      billDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).rejects.toThrow("POLICY_DENIED");
  await f.approve();
  await expect(
    f.providerSettlement.approve(f.actor, f.revisionId, { ...f.draft, settlementId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(await f.budget()).toMatchObject({ reserved: "60", spent: "0" });
});

test("settlement rollback preserves original approval and budget when local projection fails", async () => {
  const f = await settlementFixture();
  const signed = await f.approve();
  await db.execute(
    sql`alter table federation_budgets add constraint test_settlement_failure check (spent = 0)`,
  );
  try {
    await expect(
      f.providerSettlement.attachCounterparty(
        f.actor,
        f.revisionId,
        f.draft.settlementId,
        signed.source.approvalJws,
      ),
    ).rejects.toThrow();
    expect(
      (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0]?.settlement
        .counterpartyJws,
    ).toBeNull();
    expect(await f.budget()).toMatchObject({ available: "40", reserved: "60", spent: "0" });
  } finally {
    await db.execute(sql`alter table federation_budgets drop constraint test_settlement_failure`);
  }
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    signed.source.approvalJws,
  );
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
});

test("settlement exchange reuses independent approvals and does not wait for attestation ledger", async () => {
  const f = await settlementFixture("bilateral_attested");
  const signed = await f.approve();
  await Promise.all([f.sourceAuto.discover(), f.providerAuto.discover()]);
  expect(await f.providerAuto.advanceNext()).toBe(true);
  expect(await f.sourceAuto.advanceNext()).toBe(true);
  expect(f.transport.calls).toBe(2);
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  const provider = (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0],
    source = (await f.sourceSettlement.list(f.sourceActor, f.revisionId, 10, 0)).data[0];
  expect(provider?.settlement.counterpartyJws).toBe(signed.source.approvalJws);
  expect(source?.settlement.counterpartyJws).toBe(signed.provider.approvalJws);
  expect(provider?.ledger?.state).toBe("pending");
  expect(source?.ledger).toBeNull();
  expect(await f.providerAuto.advanceNext()).toBe(false);
});

test("settlement exchange lease loss cannot attach consent or apply funds", async () => {
  const f = await settlementFixture();
  await f.approve();
  await f.providerAuto.discover();
  f.transport.afterResponse = async (response) => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(
        and(
          eq(federationCommercialApprovalSyncs.localSiteId, f.provider.signing.siteId),
          eq(federationCommercialApprovalSyncs.recordKind, "settlement"),
        ),
      );
    return response;
  };
  await f.providerAuto.advanceNext();
  expect(
    (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0]?.settlement
      .counterpartyJws,
  ).toBeNull();
  expect(await f.budget()).toMatchObject({ reserved: "60", spent: "0" });
  f.transport.afterResponse = undefined;
  await f.due();
  await f.providerAuto.advanceNext();
  expect(await f.budget()).toMatchObject({ reserved: "0", spent: "53" });
});

test("settlement revoked signing purpose cannot attach or replay an approved record", async () => {
  const f = await settlementFixture();
  const signed = await f.approve();
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-bill"] })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  await expect(
    f.providerSettlement.attachCounterparty(
      f.actor,
      f.revisionId,
      f.draft.settlementId,
      signed.source.approvalJws,
    ),
  ).rejects.toThrow();
  await expect(f.sourceSettlement.approve(f.sourceActor, f.revisionId, f.draft)).rejects.toThrow();
  expect(await f.budget()).toMatchObject({ reserved: "60", spent: "0" });
});

test("settlement HTTP is scoped, private and rejects automation and malformed amounts", async () => {
  const f = await settlementFixture();
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[16] = f.providerSettlement;
  let automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revisionId}/settlements`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const invalid = await app.request(`${path}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...f.draft, chargedAmount: "1.5" }),
  });
  expect(invalid.status).toBe(400);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("settlement worker waits for original bill, recovers the same submission and never reapplies local spend", async () => {
  const f = await settlementFixture("bilateral_attested"),
    signed = await f.approve();
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    signed.source.approvalJws,
  );
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' <> 'settle-bill'`,
      ),
    );
  let present = false,
    prepared = false,
    prepares = 0;
  const txid = "d".repeat(64),
    worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
      receipt: async (query) => {
        expect(query.recordType).toBe("bill");
        return {
          receipt: present ? { recordId: f.bill.billId, digest: f.draft.billDigest } : null,
        };
      },
      prepare: async (input) => {
        expect(input.operation).toBe("settle-bill");
        prepares++;
        return { transactionId: txid, recovery: "proposal" };
      },
      advance: async () => {
        if (!prepared) {
          prepared = true;
          return {
            state: "prepared",
            transactionId: txid,
            recovery: Buffer.from("transaction").toString("base64"),
          };
        }
        return { state: "committed", transactionId: txid, blockNumber: "80" };
      },
    });
  await worker.advanceNext();
  expect(prepares).toBe(0);
  const view = async () => (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect((await view())?.ledger).toMatchObject({ state: "pending", lastError: "LEDGER_PENDING" });
  present = true;
  await db
    .update(federationCommercialSubmissions)
    .set({ nextAttemptAt: sql`clock_timestamp()` })
    .where(eq(federationCommercialSubmissions.id, (await view())?.ledger?.id ?? ""));
  await worker.advanceNext();
  await worker.advanceNext();
  await worker.advanceNext();
  expect(prepares).toBe(1);
  expect((await view())?.ledger).toMatchObject({ state: "committed", lastError: null });
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.settlement.apply"),
          eq(auditLog.target, f.draft.settlementId),
        ),
      ),
  ).toHaveLength(1);
});

test("settlement coordinated worker frees local slots only after VALID and creates no local money", async () => {
  const f = await settlementFixture("bilateral_attested");
  // Isolate ledger-result projection using preapproved coordinated records; chain validation is tested separately.
  const bill = CommercialBillSchema.parse({
    ...f.bill,
    request: { ...f.bill.request, mode: "ledger_coordinated" },
    reservationId: f.reservationId,
  });
  const sourceBill = await signFederationMessage(CommercialBillSchema, bill, f.source.signing),
    providerBill = await signFederationMessage(CommercialBillSchema, bill, f.provider.signing);
  const billDigest = (
    await verifyFederationMessage(
      CommercialBillSchema,
      sourceBill,
      { ...f.source.verification, allowedKinds: ["commercial-bill"] },
      new Date(),
    )
  ).digest;
  const value = CommercialSettlementSchema.parse({
    ...f.draft,
    billDigest,
    reservationId: f.reservationId,
    terminal: { terminalId: randomUUID(), digest: `sha256:${"e".repeat(64)}` },
  });
  const sourceJws = await signFederationMessage(
      CommercialSettlementSchema,
      value,
      f.source.signing,
    ),
    targetJws = await signFederationMessage(CommercialSettlementSchema, value, f.provider.signing);
  const digest = (
    await verifyFederationMessage(
      CommercialSettlementSchema,
      sourceJws,
      { ...f.source.verification, allowedKinds: ["commercial-settlement"] },
      new Date(),
    )
  ).digest;
  await db
    .update(federationAgreements)
    .set({ terms: { ...f.terms, mode: "ledger_coordinated" }, budgetDomainId: null, epoch: null })
    .where(eq(federationAgreements.revisionId, f.revisionId));
  await db.delete(federationBudgets).where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  await db
    .update(federationOutbound)
    .set({ request: bill.request })
    .where(
      and(
        eq(federationOutbound.localSiteId, f.source.signing.siteId),
        eq(federationOutbound.operationId, f.operationId),
      ),
    );
  const views = [];
  for (const [keys, actor, provider] of [
    [f.provider, f.actor, true],
    [f.source, f.sourceActor, false],
  ] as const) {
    const siteId = keys.signing.siteId;
    await db
      .update(federationCommercialBills)
      .set({
        payload: bill,
        digest: billDigest,
        approvalJws: provider ? providerBill : sourceBill,
        counterpartyJws: provider ? sourceBill : providerBill,
      })
      .where(
        and(
          eq(federationCommercialBills.localSiteId, siteId),
          eq(federationCommercialBills.billId, bill.billId),
        ),
      );
    await db.insert(federationCommercialSettlements).values({
      localSiteId: siteId,
      settlementId: value.settlementId,
      billId: bill.billId,
      agreementRevisionId: f.revisionId,
      localOrgId: actor.orgId,
      payload: value,
      digest,
      approvalJws: provider ? targetJws : sourceJws,
      counterpartyJws: provider ? sourceJws : targetJws,
      approvedBy: actor.userId,
    });
    await db
      .update(federationCommercialSubmissions)
      .set({ state: "committed" })
      .where(eq(federationCommercialSubmissions.localSiteId, siteId));
    const id = randomUUID();
    await db.insert(federationCommercialSubmissions).values({
      id,
      localSiteId: siteId,
      agreementRevisionId: f.revisionId,
      input: {
        operation: "settle-bill",
        domainId: value.domainId,
        recordId: value.settlementId,
        digest,
        envelope: {
          sourceSiteId: value.sourceSiteId,
          targetSiteId: value.targetSiteId,
          sourceJws,
          targetJws,
        },
      },
    });
    let outcome: "pending" | "invalid" | "committed" = "pending";
    const txid = (provider ? "a" : "b").repeat(64),
      recovery = Buffer.from("settlement-transaction").toString("base64");
    await db.insert(federationCommercialAttempts).values({
      id: randomUUID(),
      submissionId: id,
      number: 1,
      transactionId: txid,
      recovery,
      stage: "transaction",
    });
    const worker = new FederationCommercialSubmissionService(db, siteId, {
      prepare: async () => {
        throw new Error("Must resume original transaction");
      },
      advance: async () =>
        outcome === "pending"
          ? { state: "pending", transactionId: txid, recovery }
          : outcome === "invalid"
            ? { state: "invalid", transactionId: txid, blockNumber: "90", validationCode: 10 }
            : { state: "committed", transactionId: txid, blockNumber: "91" },
    });
    const view = async () =>
      (
        await db
          .select()
          .from(federationCommercialSettlements)
          .where(
            and(
              eq(federationCommercialSettlements.localSiteId, siteId),
              eq(federationCommercialSettlements.settlementId, value.settlementId),
            ),
          )
      )[0];
    await worker.advanceNext();
    expect((await view())?.appliedAt).toBeNull();
    outcome = "invalid";
    await db
      .update(federationCommercialSubmissions)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(federationCommercialSubmissions.id, id));
    await worker.advanceNext();
    expect((await view())?.appliedAt).toBeNull();
    // A separately validated later checkpoint is staged as a fixture, never reinterpret INVALID as VALID.
    await db.insert(federationCommercialAttempts).values({
      id: randomUUID(),
      submissionId: id,
      number: 2,
      transactionId: (provider ? "c" : "d").repeat(64),
      recovery,
      stage: "transaction",
    });
    const finalWorker = new FederationCommercialSubmissionService(db, siteId, {
      prepare: async () => {
        throw new Error("No new proposal");
      },
      advance: async () => ({
        state: "committed",
        transactionId: (provider ? "c" : "d").repeat(64),
        blockNumber: "91",
      }),
    });
    await db
      .update(federationCommercialSubmissions)
      .set({ state: "pending", nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(federationCommercialSubmissions.id, id));
    await finalWorker.advanceNext();
    expect((await view())?.appliedAt).toBeInstanceOf(Date);
    views.push(await view());
  }
  expect(views).toHaveLength(2);
  expect(await f.budget()).toBeUndefined();
  expect(
    (
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, f.reservationId))
    )[0]?.settledAmount,
  ).toBe("53");
  expect(
    (
      await db
        .select()
        .from(federationOutbound)
        .where(eq(federationOutbound.operationId, f.operationId))
    )[0]?.settledAmount,
  ).toBe("53");
});

type ClosingFixture = Pick<
  Awaited<ReturnType<typeof billingFixture>>,
  "actor" | "sourceActor" | "source" | "provider" | "revisionId"
>;
async function grantClosing(
  f: ClosingFixture,
  kind: "bill" | "settlement",
  source = false,
  overrides: Partial<ReturnType<typeof ClosingPolicyInputSchema.parse>> = {},
) {
  const siteId = (source ? f.source : f.provider).signing.siteId;
  const service = new FederationClosingPolicyService(db, siteId);
  const actor = source ? f.sourceActor : f.actor;
  const policy = await service.grant(actor, f.revisionId, {
    kind,
    outcomes: ["completed"],
    maxAmount: "60",
    maxTotalAmount: "100",
    maxRecords: 2,
    validUntil: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  });
  cleanup.push(async () => {
    await db.delete(federationClosingTasks).where(eq(federationClosingTasks.policyId, policy.id));
    await db
      .update(federationCommercialBills)
      .set({ authorizationPolicyId: null })
      .where(eq(federationCommercialBills.authorizationPolicyId, policy.id));
    await db
      .update(federationCommercialSettlements)
      .set({ authorizationPolicyId: null })
      .where(eq(federationCommercialSettlements.authorizationPolicyId, policy.id));
    await db.delete(federationClosingPolicies).where(eq(federationClosingPolicies.id, policy.id));
    await db.delete(auditLog).where(eq(auditLog.actor, `closing-policy:${policy.id}`));
  });
  const read = async () =>
    (await service.list(actor, f.revisionId)).find((v) => v.id === policy.id);
  return { policy, service, actor, read };
}

test("closing policy independently authorizes bills at both sites and preserves original signatures under concurrency", async () => {
  const f = await billingFixture();
  const provider = await grantClosing(f, "bill"),
    source = await grantClosing(f, "bill", true);
  const rows = await Promise.all(
    Array.from({ length: 3 }, () => f.providerBilling.automate(provider.policy.id, f.draft)),
  );
  expect(new Set(rows.map((v) => v.approvalJws)).size).toBe(1);
  expect(rows[0]?.authorizationPolicyId).toBe(provider.policy.id);
  const other = await f.sourceBilling.automate(source.policy.id, f.draft);
  expect(other.authorizationPolicyId).toBe(source.policy.id);
  expect(await provider.read()).toMatchObject({ approvedRecords: 1, approvedAmount: "60" });
  expect(await source.read()).toMatchObject({ approvedRecords: 1, approvedAmount: "60" });
  expect(
    await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, `closing-policy:${provider.policy.id}`)),
  ).toHaveLength(1);
  expect(rows[0]?.counterpartyJws).toBeNull();
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toHaveLength(0);
});

test("closing policy cannot be granted by contract permission or substitute billing authority for settlement", async () => {
  const f = await billingFixture();
  const service = new FederationClosingPolicyService(db, f.provider.signing.siteId);
  const input = ClosingPolicyInputSchema.parse({
    kind: "settlement",
    outcomes: ["completed"],
    maxAmount: "60",
    maxTotalAmount: "100",
    maxRecords: 1,
    validUntil: new Date(Date.now() + 3600000).toISOString(),
  });
  await expect(service.grant(f.actor, f.revisionId, input)).rejects.toThrow("POLICY_DENIED");
  const b = await grantClosing(f, "bill");
  await expect(
    new FederationSettlementService(db, f.provider.signing).automate(
      b.policy.id,
      CommercialSettlementSchema.parse({
        protocolVersion: 1,
        kind: "commercial-settlement",
        settlementId: randomUUID(),
        billId: f.draft.billId,
        domainId: f.draft.domainId,
        agreementRevisionId: f.revisionId,
        billDigest: f.draft.reportDigest,
        sourceSiteId: f.source.signing.siteId,
        targetSiteId: f.provider.signing.siteId,
        reservationId: null,
        terminal: null,
        unit: f.draft.request.unit,
        reservedAmount: "60",
        chargedAmount: "60",
        releasedAmount: "0",
        issuedAt: new Date().toISOString(),
        salt: "a".repeat(64),
      }),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  await expect(service.grant(f.actor, f.revisionId, { ...input, kind: "bill" })).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("closing policy persists institutional authority after employee permission loss, but explicit revocation stops new approval", async () => {
  const f = await billingFixture(),
    p = await grantClosing(f, "bill");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const saved = await f.providerBilling.automate(p.policy.id, f.draft);
  expect(saved.authorizationPolicyId).toBe(p.policy.id);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  await p.service.revoke(f.actor, f.revisionId, p.policy.id);
  await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.approvalJws,
  ).toBe(saved.approvalJws);
});

test("closing policy enforces amount, cumulative and count boundaries without partial approval", async () => {
  const f = await billingFixture();
  for (const limits of [{ maxAmount: "59" }, { approvedAmount: "41" }, { approvedRecords: 2 }]) {
    const p = await grantClosing(f, "bill");
    await db
      .update(federationClosingPolicies)
      .set(limits)
      .where(eq(federationClosingPolicies.id, p.policy.id));
    await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow(
      "BUDGET_EXHAUSTED",
    );
    expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
    expect(await p.read()).toMatchObject({
      approvedAmount: "approvedAmount" in limits ? "41" : "0",
      approvedRecords: "approvedRecords" in limits ? 2 : 0,
    });
    await p.service.revoke(f.actor, f.revisionId, p.policy.id);
  }
});

test("closing policy rejects outcome, expired grant and changed contract digest", async () => {
  const f = await billingFixture();
  const p = await grantClosing(f, "bill", false, { outcomes: ["failed"] });
  await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow("POLICY_DENIED");
  await db
    .update(federationClosingPolicies)
    .set({
      outcomes: ["completed"],
      validFrom: new Date(Date.now() - 2000),
      validUntil: new Date(Date.now() - 1000),
    })
    .where(eq(federationClosingPolicies.id, p.policy.id));
  await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  await db
    .update(federationClosingPolicies)
    .set({
      validUntil: new Date(Date.now() + 3600000),
      agreementDigest: `sha256:${"0".repeat(64)}`,
    })
    .where(eq(federationClosingPolicies.id, p.policy.id));
  await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(await p.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
});

test("closing policy validates current peer signing trust before automated approval", async () => {
  const f = await billingFixture(),
    p = await grantClosing(f, "bill", true);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-agreement", "commercial-bill"] })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.sourceBilling.automate(p.policy.id, f.draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect((await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await p.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
});

test("closing policy audit failure rolls back approval and quota as one transaction", async () => {
  const f = await billingFixture(),
    p = await grantClosing(f, "bill");
  await db.execute(
    sql`alter table audit_log add constraint test_closing_audit check (actor <> ${sql.raw(`'closing-policy:${p.policy.id}'`)})`,
  );
  try {
    await expect(f.providerBilling.automate(p.policy.id, f.draft)).rejects.toThrow();
    expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
    expect(await p.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_closing_audit`);
  }
  await f.providerBilling.automate(p.policy.id, f.draft);
  expect(await p.read()).toMatchObject({ approvedRecords: 1, approvedAmount: "60" });
});

test("closing policy settlement approval is independent and neither consumes money nor releases slots before countersigning", async () => {
  const f = await settlementFixture(),
    provider = await grantClosing(f, "settlement"),
    source = await grantClosing(f, "settlement", true);
  const before = await f.budget();
  const rows = await Promise.all(
    Array.from({ length: 3 }, () => f.providerSettlement.automate(provider.policy.id, f.draft)),
  );
  expect(new Set(rows.map((v) => v.approvalJws)).size).toBe(1);
  const other = await f.sourceSettlement.automate(source.policy.id, f.draft);
  expect(rows[0]?.authorizationPolicyId).toBe(provider.policy.id);
  expect(other.authorizationPolicyId).toBe(source.policy.id);
  expect(await f.budget()).toEqual(before);
  expect(await provider.read()).toMatchObject({ approvedAmount: "53", approvedRecords: 1 });
  expect(await source.read()).toMatchObject({ approvedAmount: "53", approvedRecords: 1 });
  expect(rows[0]?.appliedAt).toBeNull();
});

test("closing policy cannot cross institution or organization scope", async () => {
  const f = await billingFixture(),
    p = await grantClosing(f, "bill");
  await expect(f.sourceBilling.automate(p.policy.id, f.draft)).rejects.toThrow("POLICY_DENIED");
  await expect(p.service.list(f.sourceActor, f.revisionId)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(p.service.revoke(f.sourceActor, f.revisionId, p.policy.id)).rejects.toThrow(
    "ASSET_UNAVAILABLE",
  );
});

test("closing policy schema rejects malformed amounts and requires explicit finite scope", () => {
  const input = {
    kind: "bill",
    outcomes: ["completed"],
    maxAmount: "60",
    maxTotalAmount: "100",
    maxRecords: 1,
    validUntil: new Date(Date.now() + 10000).toISOString(),
  };
  for (const change of [
    { maxAmount: "1.5" },
    { maxTotalAmount: "-1" },
    { maxAmount: "101" },
    { outcomes: [] },
    { outcomes: ["completed", "completed"] },
    { maxRecords: 0 },
    { kind: "all" },
    { allowSettlement: true },
  ])
    expect(ClosingPolicyInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
});

test("closing policy HTTP requires human independent authority, scopes reads and allows explicit revoke", async () => {
  const f = await billingFixture(),
    service = new FederationClosingPolicyService(db, f.provider.signing.siteId);
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[17] = service;
  let actor = f.actor,
    automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revisionId}/closing-policies`;
  const p = await grantClosing(f, "bill");
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "settlement",
      outcomes: ["completed"],
      maxAmount: "60",
      maxTotalAmount: "100",
      maxRecords: 1,
      validUntil: new Date(Date.now() + 10000).toISOString(),
    }),
  };
  expect((await app.request(path, request)).status).toBe(403);
  expect(
    (await app.request(`${path}/${p.policy.id}/revoke`, { ...request, body: "{}" })).status,
  ).toBe(200);
  actor = f.sourceActor;
  expect((await app.request(path)).status).toBe(409);
  actor = f.actor;
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("closing policy expiry after signing rolls back settlement approval and authorization consumption", async () => {
  const f = await settlementFixture(),
    p = await grantClosing(f, "settlement");
  const consume = FederationClosingPolicyService.prototype.consume;
  const hook = spyOn(FederationClosingPolicyService.prototype, "consume").mockImplementation(
    async (...args) => {
      setSystemTime(new Date(p.policy.validUntil.getTime() + 1));
      return consume.apply(p.service, args);
    },
  );
  try {
    await expect(f.providerSettlement.automate(p.policy.id, f.draft)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  } finally {
    hook.mockRestore();
    setSystemTime();
  }
  expect((await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await p.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  expect(await f.budget()).toMatchObject({ reserved: "60", spent: "0" });
});

test("closing policy revocation serializes with approval and a replacement cannot rewrite its authorization", async () => {
  const f = await billingFixture(),
    p = await grantClosing(f, "bill");
  let unlock: () => void = () => {};
  let locked: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const consume = FederationClosingPolicyService.prototype.consume;
  const hook = spyOn(FederationClosingPolicyService.prototype, "consume").mockImplementation(
    async (...args) => {
      locked();
      await resume;
      return consume.apply(p.service, args);
    },
  );
  const signing = f.providerBilling.automate(p.policy.id, f.draft);
  await acquired;
  const revocation = p.service.revoke(f.actor, f.revisionId, p.policy.id);
  unlock();
  let approved: Awaited<typeof signing>;
  try {
    [approved] = await Promise.all([signing, revocation]);
  } finally {
    hook.mockRestore();
  }
  expect((await p.read())?.revokedAt).not.toBeNull();
  const replacement = await grantClosing(f, "bill");
  const replay = await f.providerBilling.automate(replacement.policy.id, f.draft);
  expect(replay.approvalJws).toBe(approved.approvalJws);
  expect(replay.authorizationPolicyId).toBe(p.policy.id);
  expect(await replacement.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  expect(await p.read()).toMatchObject({ approvedRecords: 1, approvedAmount: "60" });
});

async function closingFlowFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
  sourceAuthorized = true,
) {
  const f = await billingExchangeFixture(mode);
  cleanup.push(async () => {
    for (const site of [f.source.signing.siteId, f.provider.signing.siteId]) {
      await db.delete(federationClosingTasks).where(eq(federationClosingTasks.localSiteId, site));
      await db
        .delete(federationCommercialSettlements)
        .where(eq(federationCommercialSettlements.localSiteId, site));
      await db
        .delete(auditLog)
        .where(
          inArray(auditLog.actor, [
            `closing:${site}`,
            `settlement:${site}`,
            `settlement-exchange:${site}`,
          ]),
        );
    }
  });
  for (const actor of [f.actor, f.sourceActor])
    await new FederationPermissionService(db).set(
      { ...actor, capability: "settlement.approve", enabled: true },
      actor.userId,
    );
  const billPolicy = await grantClosing(f, "bill"),
    settlementPolicy = await grantClosing(f, "settlement");
  const sourceBillPolicy = sourceAuthorized ? await grantClosing(f, "bill", true) : undefined;
  const sourceSettlementPolicy = sourceAuthorized
    ? await grantClosing(f, "settlement", true)
    : undefined;
  const ingress = createFederationIngress(db, f.source.signing);
  const network: { bodies: string[]; afterResponse?: (jws: string) => Promise<string> } = {
    bodies: [],
  };
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/commercial-closing");
    if (!path) throw new Error("Closing route is required");
    network.bodies.push(jws);
    const response = await ingress.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/jose",
        "x-kq-federation-cert": f.providerFingerprint,
      },
      body: jws,
    });
    if (response.status !== 200)
      throw new FederationDeliveryError(
        response.status >= 500 ? "DELIVERY_UNAVAILABLE" : "INVALID_RECEIPT_RESPONSE",
      );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.text();
    return network.afterResponse ? network.afterResponse(result) : result;
  };
  const closing = new FederationClosingAutomation(db, f.provider.signing, send);
  const view = () => closing.list(f.actor, f.revisionId);
  const due = () =>
    db
      .update(federationClosingTasks)
      .set({ nextAttemptAt: sql`clock_timestamp()`, leaseToken: null, leaseUntil: null })
      .where(eq(federationClosingTasks.localSiteId, f.provider.signing.siteId));
  return {
    ...f,
    billPolicy,
    settlementPolicy,
    sourceBillPolicy,
    sourceSettlementPolicy,
    ingress,
    network,
    send,
    closing,
    view,
    due,
  };
}

test("closing automation production worker generates and exchanges bills and settlements from independent policies", async () => {
  const f = await closingFlowFixture();
  const args: ConstructorParameters<typeof FederationCommercialWorker> = [
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  args[13] = f.closing;
  const worker = new FederationCommercialWorker(...args);
  await worker.tick();
  await worker.tick();
  expect((await f.view()).records.map((r) => [r.kind, r.state])).toEqual([
    ["bill", "complete"],
    ["settlement", "complete"],
  ]);
  expect(f.network.bodies).toHaveLength(2);
  const rows = await db
    .select()
    .from(federationCommercialSettlements)
    .where(
      inArray(federationCommercialSettlements.localSiteId, [
        f.source.signing.siteId,
        f.provider.signing.siteId,
      ]),
    );
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.digest)).size).toBe(1);
  expect(rows.every((r) => r.counterpartyJws && r.appliedAt && r.authorizationPolicyId)).toBe(true);
  expect(await f.billPolicy.read()).toMatchObject({ approvedAmount: "60", approvedRecords: 1 });
  expect(await f.settlementPolicy.read()).toMatchObject({
    approvedAmount: "60",
    approvedRecords: 1,
  });
  expect(await f.sourceBillPolicy?.read()).toMatchObject({
    approvedAmount: "60",
    approvedRecords: 1,
  });
  expect(await f.sourceSettlementPolicy?.read()).toMatchObject({
    approvedAmount: "60",
    approvedRecords: 1,
  });
  expect(
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId))
    )[0],
  ).toMatchObject({ available: "40", reserved: "0", spent: "60" });
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        inArray(federationCommercialSubmissions.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      ),
  ).toHaveLength(0);
});

test("closing automation attested accounting completes without an Adapter and leaves evidence pending", async () => {
  const f = await closingFlowFixture("bilateral_attested");
  await f.closing.discover();
  await f.closing.advanceNext();
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records.every((r) => r.state === "complete")).toBe(true);
  const rows = await db
    .select()
    .from(federationCommercialSettlements)
    .where(
      inArray(federationCommercialSettlements.localSiteId, [
        f.source.signing.siteId,
        f.provider.signing.siteId,
      ]),
    );
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.appliedAt)).toBe(true);
  const pending = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' IN ('confirm-bill','settle-bill')`,
      ),
    );
  expect(pending).toHaveLength(2);
  expect(pending.every((r) => r.state === "pending")).toBe(true);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, f.source.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' IN ('confirm-bill','settle-bill')`,
        ),
      ),
  ).toHaveLength(0);
});

test("closing automation never infers counterparty authority and retry retains the original proposal", async () => {
  const f = await closingFlowFixture("bilateral_direct", false);
  await f.closing.discover();
  await f.closing.advanceNext();
  const original = (await f.view()).records[0];
  expect(original?.state).toBe("needs_review");
  expect((await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(0);
  await grantClosing(f, "bill", true);
  await f.closing.retry(f.actor, f.revisionId, "bill", f.reservationId);
  await f.closing.advanceNext();
  expect((await f.view()).records[0]).toMatchObject({
    state: "complete",
    recordId: original?.recordId,
  });
  expect(f.network.bodies[0]).toBe(f.network.bodies[1]);
  expect(await f.billPolicy.read()).toMatchObject({ approvedRecords: 1 });
});

test("closing automation waits for missing received usage and recovers without new signatures", async () => {
  const f = await closingFlowFixture();
  const received = await db
    .select()
    .from(federationReceivedUsage)
    .where(eq(federationReceivedUsage.localSiteId, f.source.signing.siteId));
  await db
    .delete(federationReceivedUsage)
    .where(eq(federationReceivedUsage.localSiteId, f.source.signing.siteId));
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]).toMatchObject({
    state: "pending",
    lastError: "DELIVERY_UNAVAILABLE",
  });
  expect(await f.sourceBillPolicy?.read()).toMatchObject({ approvedRecords: 0 });
  await db.insert(federationReceivedUsage).values(received);
  await f.due();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]?.state).toBe("complete");
  expect(f.network.bodies[0]).toBe(f.network.bodies[1]);
});

test("closing automation recovers a lost approved response after remote policy revocation without repeating consent", async () => {
  const f = await closingFlowFixture();
  f.network.afterResponse = async () => {
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  };
  await f.closing.discover();
  await f.closing.advanceNext();
  const remote = (await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data[0]?.bill;
  expect(remote?.counterpartyJws).toBeTruthy();
  if (!f.sourceBillPolicy) throw new Error("Missing policy");
  await f.sourceBillPolicy.service.revoke(
    f.sourceActor,
    f.revisionId,
    f.sourceBillPolicy.policy.id,
  );
  f.network.afterResponse = undefined;
  await f.due();
  await new FederationClosingAutomation(db, f.provider.signing, f.send).advanceNext();
  expect((await f.view()).records[0]?.state).toBe("complete");
  expect(
    (await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data[0]?.bill.approvalJws,
  ).toBe(remote?.approvalJws);
  expect(f.network.bodies[0]).toBe(f.network.bodies[1]);
  expect(await f.sourceBillPolicy.read()).toMatchObject({ approvedRecords: 1 });
});

test("closing automation fences a late response after lease loss and resumes the original intent", async () => {
  const f = await closingFlowFixture();
  f.network.afterResponse = async (jws) => {
    await db
      .update(federationClosingTasks)
      .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
      .where(eq(federationClosingTasks.localSiteId, f.provider.signing.siteId));
    return jws;
  };
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]?.state).toBe("pending");
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
  f.network.afterResponse = undefined;
  await f.due();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]?.state).toBe("complete");
  expect(f.network.bodies[0]).toBe(f.network.bodies[1]);
});

test("closing automation rolls generation and policy consumption back if its lease is superseded", async () => {
  const f = await closingFlowFixture();
  await f.closing.discover();
  const generate = FederationBillingService.prototype.automateDraft;
  const hook = spyOn(FederationBillingService.prototype, "automateDraft").mockImplementation(
    async (policy, reference, finish) =>
      generate.call(f.providerBilling, policy, reference, async (tx, row) => {
        await db
          .update(federationClosingTasks)
          .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) })
          .where(eq(federationClosingTasks.localSiteId, f.provider.signing.siteId));
        await finish(tx, row);
      }),
  );
  try {
    await f.closing.advanceNext();
  } finally {
    hook.mockRestore();
  }
  expect((await f.view()).records[0]?.recordId).toBeNull();
  expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await f.billPolicy.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  expect(f.network.bodies).toHaveLength(0);
  await f.due();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]?.state).toBe("complete");
});

test("closing automation rechecks peer certificate during approval and keeps business authority atomic", async () => {
  const f = await closingFlowFixture();
  const approve = FederationBillingService.prototype.automate;
  const hook = spyOn(FederationBillingService.prototype, "automate").mockImplementation(
    async (policy, payload, authorize) => {
      await db
        .update(federationCertificates)
        .set({ revokedAt: new Date() })
        .where(eq(federationCertificates.fingerprint, f.providerFingerprint));
      return approve.call(f.sourceBilling, policy, payload, authorize);
    },
  );
  try {
    await f.closing.discover();
    await f.closing.advanceNext();
  } finally {
    hook.mockRestore();
  }
  expect((await f.view()).records[0]?.state).toBe("needs_review");
  expect((await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await f.sourceBillPolicy?.read()).toMatchObject({ approvedRecords: 0 });
});

test("closing automation stays off without local policy or transport and cannot send a source-side offer", async () => {
  const f = await closingFlowFixture();
  await f.billPolicy.service.revoke(f.actor, f.revisionId, f.billPolicy.policy.id);
  await f.settlementPolicy.service.revoke(f.actor, f.revisionId, f.settlementPolicy.policy.id);
  await f.closing.discover();
  expect((await f.view()).records).toHaveLength(0);
  const offline = new FederationClosingAutomation(db, f.provider.signing);
  await offline.discover();
  expect(await offline.advanceNext()).toBe(false);
  const wrong = await signFederationMessage(CommercialBillSchema, f.draft, f.source.signing);
  const response = await f.ingress.request("/federation/v1/commercial-closing", {
    method: "POST",
    headers: { "content-type": "application/jose", "x-kq-federation-cert": f.fingerprint },
    body: wrong,
  });
  expect(response.status).toBe(401);
  expect(f.network.bodies).toHaveLength(0);
});

test("closing automation refuses to bypass a prepared concession, then reuses its explicitly approved bill", async () => {
  const f = await closingFlowFixture();
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: f.draft.billId,
    domainId: f.draft.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    reportId: f.draft.reportId,
    reportDigest: f.draft.reportDigest,
    taskId: f.draft.request.taskId,
    attempt: 1,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    unit: f.draft.request.unit,
    amount: "7",
    reason: "Agreed concession",
    issuedAt: new Date().toISOString(),
    salt: "e".repeat(64),
  });
  const original = await f.providerBilling.approveDiscount(f.actor, f.revisionId, discount);
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    recordId: null,
  });
  expect(await f.billPolicy.read()).toMatchObject({ approvedRecords: 0 });
  expect(f.network.bodies).toHaveLength(0);
  await f.sourceBilling.importDiscount(f.sourceActor, f.revisionId, original.providerJws);
  const draft = await f.providerBilling.draft(
    f.actor,
    f.revisionId,
    f.draft.reportId,
    f.draft.billId,
    discount.discountId,
  );
  const approved = await f.providerBilling.approve(f.actor, f.revisionId, draft);
  await f.closing.retry(f.actor, f.revisionId, "bill", f.reservationId);
  await f.closing.advanceNext();
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.approvalJws,
  ).toBe(approved.approvalJws);
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records.every((v) => v.state === "complete")).toBe(true);
  expect(
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId))
    )[0],
  ).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  expect(await f.billPolicy.read()).toMatchObject({ approvedRecords: 0 });
});

test("closing automation rejects changed endpoint after response, retaining the original for authorized retry", async () => {
  const f = await closingFlowFixture();
  const [site] = await db
    .select()
    .from(federationSites)
    .where(eq(federationSites.id, f.source.signing.siteId));
  if (!site) throw new Error("Missing site");
  f.network.afterResponse = async (jws) => {
    await db
      .update(federationSites)
      .set({ endpoint: "https://changed.example.test" })
      .where(eq(federationSites.id, site.id));
    return jws;
  };
  await f.closing.discover();
  await f.closing.advanceNext();
  expect((await f.view()).records[0]).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  });
  expect(
    (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill.counterpartyJws,
  ).toBeNull();
  f.network.afterResponse = undefined;
  await db
    .update(federationSites)
    .set({ endpoint: site.endpoint })
    .where(eq(federationSites.id, site.id));
  await f.closing.retry(f.actor, f.revisionId, "bill", f.reservationId);
  await f.closing.advanceNext();
  expect((await f.view()).records[0]?.state).toBe("complete");
  expect(f.network.bodies[0]).toBe(f.network.bodies[1]);
});

test("closing automation rechecks policy expiry after its final ingress authorization callback", async () => {
  const f = await closingFlowFixture();
  if (!f.sourceBillPolicy) throw new Error("Missing policy");
  const expiry = f.sourceBillPolicy.policy.validUntil;
  const approve = FederationBillingService.prototype.automate;
  const hook = spyOn(FederationBillingService.prototype, "automate").mockImplementation(
    async (policy, payload, authorize) => {
      let calls = 0;
      return approve.call(f.sourceBilling, policy, payload, async (tx) => {
        await authorize?.(tx);
        if (++calls === 2) setSystemTime(new Date(expiry.getTime() + 1));
      });
    },
  );
  try {
    await f.closing.discover();
    await f.closing.advanceNext();
  } finally {
    hook.mockRestore();
    setSystemTime();
  }
  expect((await f.sourceBilling.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await f.sourceBillPolicy.read()).toMatchObject({ approvedRecords: 0 });
});

test("closing automation task HTTP scopes reads and requires the matching independent retry authority", async () => {
  const f = await closingFlowFixture("bilateral_direct", false);
  await f.closing.discover();
  await f.closing.advanceNext();
  const args: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  args[18] = f.closing;
  const app = new Hono();
  let actor = f.actor;
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/closing-tasks`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  expect((await app.request(`${path}/bill/${f.reservationId}/retry`, request)).status).toBe(403);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  expect((await app.request(`${path}/bill/${f.reservationId}/retry`, request)).status).toBe(200);
  actor = f.sourceActor;
  expect((await app.request(path)).status).toBe(409);
});

test("commercial closing record navigation filters the exact bill and settlement within current organization", async () => {
  const f = await settlementFixture();
  await f.approve();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[15] = f.providerBilling;
  deps[16] = f.providerSettlement;
  const app = new Hono();
  let actor = f.actor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  for (const [kind, recordId] of [
    ["bill", f.bill.billId],
    ["settlement", f.draft.settlementId],
  ] as const) {
    const path = `/federation/commercial-agreements/${f.revisionId}/${kind}s`;
    const response = await app.request(`${path}?recordId=${recordId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: { data: [{ [kind]: { [`${kind}Id`]: recordId } }], hasMore: false },
    });
    const missing = await app.request(`${path}?recordId=${randomUUID()}`);
    expect(await missing.json()).toEqual({ data: { data: [], hasMore: false } });
    expect((await app.request(`${path}?recordId=not-an-id`)).status).toBe(400);
    actor = f.sourceActor;
    const foreign = await app.request(`${path}?recordId=${recordId}`);
    expect(foreign.status).not.toBe(200);
    actor = f.actor;
  }
});

test("federation CLI real HTTP and PostgreSQL preserve organization and independent closing authority", async () => {
  const f = await settlementFixture();
  await f.approve();
  const policyService = new FederationClosingPolicyService(db, f.provider.signing.siteId);
  cleanup.push(async () => {
    const policies = await policyService.list(f.actor, f.revisionId);
    for (const policy of policies) {
      await db.delete(federationClosingPolicies).where(eq(federationClosingPolicies.id, policy.id));
      await db.delete(auditLog).where(eq(auditLog.actor, `closing-policy:${policy.id}`));
    }
  });
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[15] = f.providerBilling;
  deps[16] = f.providerSettlement;
  deps[17] = policyService;
  const app = new Hono();
  const token = randomUUID();
  let actor = f.actor;
  let automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({}, 401);
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.use("/api/federation/*", federationOrganizationContext);
  app.route("/api", createFederationCommercialRoutes(...deps));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  cleanup.push(async () => {
    server.stop(true);
  });
  const dir = await mkdtemp(join(tmpdir(), "kq-federation-cli-pg-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json"),
    input = join(dir, "policy.json");
  await writeFile(config, JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, token }), {
    mode: 0o600,
  });
  await writeFile(
    input,
    JSON.stringify({
      kind: "bill",
      outcomes: ["completed"],
      maxAmount: "60",
      maxTotalAmount: "100",
      maxRecords: 2,
      validUntil: new Date(Date.now() + 3600000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "federation",
        "--org",
        f.orgId,
        "--lang",
        "en",
        "--json",
        ...args,
      ],
      {
        env: { ...process.env, KQ_CONFIG_FILE: config },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  actor = f.sourceActor;
  const changed = await run("closing", "policies", "grant", f.revisionId, input);
  expect(changed.code).toBe(1);
  expect(changed.stderr).toContain("ORGANIZATION_CONTEXT_CHANGED");
  expect(await policyService.list(f.actor, f.revisionId)).toHaveLength(0);
  actor = f.actor;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: false },
    f.userId,
  );
  const denied = await run("closing", "policies", "grant", f.revisionId, input);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("HTTP 403 POLICY_DENIED");
  expect(await policyService.list(f.actor, f.revisionId)).toHaveLength(0);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "billing.approve", enabled: true },
    f.userId,
  );
  const granted = await run("closing", "policies", "grant", f.revisionId, input);
  expect(granted.code).toBe(0);
  const policy = JSON.parse(granted.stdout);
  expect(policy).toMatchObject({
    kind: "bill",
    maxAmount: "60",
    approvedRecords: 0,
    localOrgId: f.orgId,
  });
  const listed = await run("closing", "policies", "list", f.revisionId);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout)).toHaveLength(1);
  automation = true;
  const machine = await run("closing", "policies", "revoke", f.revisionId, policy.id);
  expect(machine.code).toBe(1);
  expect(machine.stderr).toContain("HTTP 403");
  automation = false;
  const revoked = await run("closing", "policies", "revoke", f.revisionId, policy.id);
  expect(revoked.code).toBe(0);
  expect(JSON.parse(revoked.stdout).revokedAt).not.toBeNull();
  const settlements = await run(
    "settlements",
    "list",
    f.revisionId,
    "--record",
    f.draft.settlementId,
  );
  expect(settlements.code).toBe(0);
  expect(JSON.parse(settlements.stdout).data[0].settlement).toMatchObject({
    settlementId: f.draft.settlementId,
    payload: { chargedAmount: f.draft.chargedAmount },
  });
}, 30000);

async function adjustmentServiceFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await settlementFixture(mode),
    signed = await f.approve();
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    signed.source.approvalJws,
  );
  await f.sourceSettlement.attachCounterparty(
    f.sourceActor,
    f.revisionId,
    f.draft.settlementId,
    signed.provider.approvalJws,
  );
  cleanup.push(async () => {
    for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId]) {
      await db
        .delete(federationCommercialAdjustments)
        .where(eq(federationCommercialAdjustments.localSiteId, siteId));
      await db
        .delete(auditLog)
        .where(inArray(auditLog.actor, [`adjustment:${siteId}`, `adjustment-exchange:${siteId}`]));
    }
  });
  for (const [keys, actor] of [
    [f.source, f.sourceActor],
    [f.provider, f.actor],
  ] as const) {
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-adjustment"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, keys.signing.siteId));
    await new FederationPermissionService(db).set(
      { ...actor, capability: "adjustment.approve", enabled: true },
      actor.userId,
    );
  }
  const providerAdjustment = new FederationAdjustmentService(db, f.provider.signing),
    sourceAdjustment = new FederationAdjustmentService(db, f.source.signing);
  const make = (amount: string) =>
    providerAdjustment.draft(f.actor, f.revisionId, {
      settlementId: f.draft.settlementId,
      adjustmentId: randomUUID(),
      chargedAmount: amount,
      reason: "Agreed correction",
      supportingEvidenceDigest: null,
    });
  const approve = async (value: ReturnType<typeof CommercialAdjustmentSchema.parse>) => ({
    provider: await providerAdjustment.approve(f.actor, f.revisionId, value),
    source: await sourceAdjustment.approve(f.sourceActor, f.revisionId, value),
  });
  const attach = async (signed: Awaited<ReturnType<typeof approve>>) => {
    await providerAdjustment.attachCounterparty(
      f.actor,
      f.revisionId,
      signed.provider.adjustmentId,
      signed.source.approvalJws,
    );
    await sourceAdjustment.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      signed.source.adjustmentId,
      signed.provider.approvalJws,
    );
  };
  const sourceProjection = async () =>
    (
      await db
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, f.source.signing.siteId),
            eq(federationOutbound.operationId, f.operationId),
          ),
        )
    )[0];
  return {
    ...f,
    providerAdjustment,
    sourceAdjustment,
    make,
    approveAdjustment: approve,
    attachAdjustment: attach,
    sourceProjection,
  };
}

test("adjustment direct credits only after dual approval then holds and applies a debit without rewriting originals", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("40");
  const originalBill = (await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill;
  const originalSettlement = (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0]
    ?.settlement;
  const signed = await f.approveAdjustment(value);
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  expect(signed.provider).toMatchObject({ heldAmount: "0", appliedAt: null, number: 1 });
  await f.attachAdjustment(signed);
  expect(await f.budget()).toMatchObject({ available: "60", reserved: "0", spent: "40" });
  const next = await f.make("55"),
    debit = await f.approveAdjustment(next);
  expect(next.previous).toEqual({
    adjustmentId: value.adjustmentId,
    digest: signed.provider.digest,
  });
  expect(await f.budget()).toMatchObject({ available: "45", reserved: "15", spent: "40" });
  expect(await f.sourceProjection()).toMatchObject({
    settledAmount: "40",
    adjustmentHeldAmount: "15",
  });
  await expect(f.make("1")).rejects.toThrow("DATA_WAITING");
  await f.attachAdjustment(debit);
  expect(await f.budget()).toMatchObject({ available: "45", reserved: "0", spent: "55" });
  expect(await f.sourceProjection()).toMatchObject({
    settledAmount: "55",
    adjustmentHeldAmount: "0",
  });
  await f.attachAdjustment(signed);
  await f.attachAdjustment(debit);
  await f.approveAdjustment(value);
  expect(await f.budget()).toMatchObject({ available: "45", reserved: "0", spent: "55" });
  expect((await f.providerBilling.list(f.actor, f.revisionId, 10, 0)).data[0]?.bill).toEqual(
    originalBill,
  );
  expect(
    (await f.providerSettlement.list(f.actor, f.revisionId, 10, 0)).data[0]?.settlement,
  ).toEqual(originalSettlement);
  expect(
    (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data.every(
      (v) => v.ledger === null,
    ),
  ).toBe(true);
});
test("adjustment concurrent approvals hold the debit once and reject a fork at the same predecessor", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60");
  const rows = await Promise.all(
    Array.from({ length: 4 }, () => f.providerAdjustment.approve(f.actor, f.revisionId, value)),
  );
  expect(new Set(rows.map((r) => r.approvalJws)).size).toBe(1);
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
  await expect(
    f.providerAdjustment.approve(f.actor, f.revisionId, {
      ...value,
      adjustmentId: randomUUID(),
      chargedAmount: "59",
    }),
  ).rejects.toThrow();
  expect((await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(1);
});
test("adjustment debit requires available provider and source budget before granting a signature", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60");
  await db
    .update(federationBudgets)
    .set({ available: "0", reserved: "47" })
    .where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  await expect(f.providerAdjustment.approve(f.actor, f.revisionId, value)).rejects.toThrow(
    "BUDGET_EXHAUSTED",
  );
  expect((await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  // Separate local source quota consumption is represented by another queued delegation.
  const source = await f.sourceProjection();
  if (!source) throw new Error("Missing source");
  const operationId = randomUUID(),
    taskId = randomUUID();
  cleanup.push(async () => {
    await db.delete(federationOutbound).where(eq(federationOutbound.operationId, operationId));
  });
  await db.insert(federationOutbound).values({
    ...source,
    operationId,
    taskId,
    amount: "47",
    settledAmount: null,
    request: { ...source.request, operationId, taskId, maxAmount: "47" },
    state: "queued",
    receipt: null,
    receiptJws: null,
    statusReport: null,
    statusReportJws: null,
    statusVerifiedAt: null,
    statusClaim: null,
    statusLastError: null,
    requestDigest: `sha256:${"f".repeat(64)}`,
  });
  await expect(f.sourceAdjustment.approve(f.sourceActor, f.revisionId, value)).rejects.toThrow(
    "BUDGET_EXHAUSTED",
  );
  expect((await f.sourceProjection())?.adjustmentHeldAmount).toBe("0");
});
test("adjustment independent authority, organization and original identity cannot be bypassed", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("40");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: false },
    f.userId,
  );
  await expect(f.providerAdjustment.approve(f.actor, f.revisionId, value)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: true },
    f.userId,
  );
  await expect(f.providerAdjustment.approve(f.sourceActor, f.revisionId, value)).rejects.toThrow();
  for (const patch of [
    { billDigest: `sha256:${"f".repeat(64)}` },
    { settlementDigest: `sha256:${"f".repeat(64)}` },
    { previousChargedAmount: "52" },
    { chargedAmount: "61" },
    { unit: "other.micro" },
    { sourceSiteId: randomUUID() },
  ])
    await expect(
      f.providerAdjustment.approve(f.actor, f.revisionId, { ...value, ...patch }),
    ).rejects.toThrow();
  expect((await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
});
test("adjustment mismatched counterpart signature retains the original hold and does not apply", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60"),
    saved = await f.providerAdjustment.approve(f.actor, f.revisionId, value);
  const changed = await signFederationMessage(
    CommercialAdjustmentSchema,
    { ...value, chargedAmount: "59" },
    f.source.signing,
  );
  await expect(
    f.providerAdjustment.attachCounterparty(f.actor, f.revisionId, value.adjustmentId, changed),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(
    (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data[0]?.adjustment,
  ).toMatchObject({ approvalJws: saved.approvalJws, counterpartyJws: null, appliedAt: null });
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
});
test("adjustment attested accounting proceeds without a ledger client and persists the original evidence obligation", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    value = await f.make("40"),
    signed = await f.approveAdjustment(value);
  await f.attachAdjustment(signed);
  const view = (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect(view?.ledger).toMatchObject({ state: "pending" });
  expect(view?.adjustment.appliedAt).toBeInstanceOf(Date);
  expect(await f.budget()).toMatchObject({ available: "60", reserved: "0", spent: "40" });
  expect(
    (await f.sourceAdjustment.list(f.sourceActor, f.revisionId, 10, 0)).data[0]?.ledger,
  ).toBeNull();
});

test("adjustment failed approval and application roll back financial holds, signatures and audit", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60");
  await db.execute(
    sql`alter table audit_log add constraint test_adjustment_failure check (action <> 'federation.adjustment.approve')`,
  );
  try {
    await expect(f.providerAdjustment.approve(f.actor, f.revisionId, value)).rejects.toThrow();
    await expect(f.sourceAdjustment.approve(f.sourceActor, f.revisionId, value)).rejects.toThrow();
    expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
    expect((await f.sourceProjection())?.adjustmentHeldAmount).toBe("0");
    expect((await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_adjustment_failure`);
  }
  const signed = await f.approveAdjustment(value);
  await db.execute(
    sql`alter table audit_log add constraint test_adjustment_failure check (action <> 'federation.adjustment.apply')`,
  );
  try {
    await expect(f.attachAdjustment(signed)).rejects.toThrow();
    expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
    expect(
      (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data[0]?.adjustment,
    ).toMatchObject({ counterpartyJws: null, appliedAt: null });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_adjustment_failure`);
  }
  await f.attachAdjustment(signed);
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
});
test("adjustment HTTP enforces separate human capability, original scope and private response caching", async () => {
  const f = await adjustmentServiceFixture();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[19] = f.providerAdjustment;
  const app = new Hono();
  let automation = false,
    actor = f.actor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  const path = `/federation/commercial-agreements/${f.revisionId}/adjustments`;
  const post = (suffix: string, value: unknown) =>
    app.request(`${path}/${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const draft = await post("draft", {
    settlementId: f.draft.settlementId,
    adjustmentId: randomUUID(),
    chargedAmount: "40",
    reason: "Agreed adjustment",
    supportingEvidenceDigest: null,
  });
  expect(draft.status).toBe(200);
  const value = (
    (await draft.json()) as { data: ReturnType<typeof CommercialAdjustmentSchema.parse> }
  ).data;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: false },
    f.userId,
  );
  expect((await post("approve", value)).status).toBe(403);
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: true },
    f.userId,
  );
  automation = true;
  expect((await post("approve", value)).status).toBe(403);
  automation = false;
  expect((await post("approve", value)).status).toBe(201);
  expect((await post("approve", { ...value, chargedAmount: "1.5" })).status).toBe(400);
  const response = await app.request(`${path}?recordId=${value.adjustmentId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    data: { data: [{ adjustment: { adjustmentId: value.adjustmentId } }], hasMore: false },
  });
  actor = f.sourceActor;
  expect((await app.request(path)).status).toBe(409);
});
test("adjustment worker waits for the original settlement receipt and attestation never reapplies a local debit", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    value = await f.make("60"),
    signed = await f.approveAdjustment(value);
  await f.attachAdjustment(signed);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'operation' <> 'adjust-settlement'`,
      ),
    );
  let ready = false,
    prepared = false,
    prepares = 0;
  const txid = "a".repeat(64),
    worker = new FederationCommercialSubmissionService(db, f.provider.signing.siteId, {
      receipt: async (query) => {
        expect(query.recordType).toBe("settlement");
        return {
          receipt: ready ? { recordId: value.settlementId, digest: value.settlementDigest } : null,
        };
      },
      prepare: async (input) => {
        expect(input.operation).toBe("adjust-settlement");
        prepares++;
        return { transactionId: txid, recovery: "proposal" };
      },
      advance: async () => {
        if (!prepared) {
          prepared = true;
          return {
            state: "prepared",
            transactionId: txid,
            recovery: Buffer.from("transaction").toString("base64"),
          };
        }
        return { state: "committed", transactionId: txid, blockNumber: "100" };
      },
    });
  await worker.advanceNext();
  expect(prepares).toBe(0);
  const view = async () => (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data[0];
  expect((await view())?.ledger).toMatchObject({ state: "pending", lastError: "LEDGER_PENDING" });
  ready = true;
  await db
    .update(federationCommercialSubmissions)
    .set({ nextAttemptAt: sql`clock_timestamp()` })
    .where(eq(federationCommercialSubmissions.id, (await view())?.ledger?.id ?? ""));
  await worker.advanceNext();
  await worker.advanceNext();
  await worker.advanceNext();
  expect((await view())?.ledger).toMatchObject({ state: "committed" });
  expect(prepares).toBe(1);
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
  expect(await worker.advanceNext()).toBe(false);
});
test("adjustment coordinated signatures do not change accounting until each local submission is VALID", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested");
  // Seed authenticated coordinated originals to isolate local accounting from Fabric validation.
  const pair = async (schema: z.ZodType<{ kind: string }>, value: { kind: string }) => {
    const sourceJws = await signFederationMessage(schema, value, f.source.signing),
      targetJws = await signFederationMessage(schema, value, f.provider.signing);
    const digest = (
      await verifyFederationMessage(
        schema,
        sourceJws,
        {
          ...f.source.verification,
          allowedKinds: ["commercial-agreement", "commercial-bill", "commercial-settlement"],
        },
        new Date(),
      )
    ).digest;
    return { sourceJws, targetJws, digest };
  };
  const terms = CommercialAgreementSchema.parse({
      ...f.contract,
      agreement: { ...f.contract.agreement, mode: "ledger_coordinated" },
    }),
    agreement = await pair(CommercialAgreementSchema, terms);
  const bill = CommercialBillSchema.parse({
      ...f.bill,
      agreementDigest: agreement.digest,
      request: { ...f.bill.request, mode: "ledger_coordinated" },
      reservationId: f.reservationId,
    }),
    billPair = await pair(CommercialBillSchema, bill);
  const settlement = CommercialSettlementSchema.parse({
      ...f.draft,
      billDigest: billPair.digest,
      reservationId: f.reservationId,
      terminal: { terminalId: randomUUID(), digest: `sha256:${"a".repeat(64)}` },
    }),
    settlementPair = await pair(CommercialSettlementSchema, settlement);
  for (const [keys, provider] of [
    [f.provider, true],
    [f.source, false],
  ] as const) {
    const siteId = keys.signing.siteId;
    const signatures = (signed: Awaited<ReturnType<typeof pair>>) => ({
      digest: signed.digest,
      approvalJws: provider ? signed.targetJws : signed.sourceJws,
      counterpartyJws: provider ? signed.sourceJws : signed.targetJws,
    });
    await db
      .update(federationCommercialAgreements)
      .set({ terms, ...signatures(agreement) })
      .where(
        and(
          eq(federationCommercialAgreements.localSiteId, siteId),
          eq(federationCommercialAgreements.revisionId, f.revisionId),
        ),
      );
    await db
      .update(federationCommercialBills)
      .set({ payload: bill, ...signatures(billPair) })
      .where(
        and(
          eq(federationCommercialBills.localSiteId, siteId),
          eq(federationCommercialBills.billId, bill.billId),
        ),
      );
    await db
      .update(federationCommercialSettlements)
      .set({ payload: settlement, ...signatures(settlementPair) })
      .where(
        and(
          eq(federationCommercialSettlements.localSiteId, siteId),
          eq(federationCommercialSettlements.settlementId, settlement.settlementId),
        ),
      );
  }
  await db
    .update(federationAgreements)
    .set({ terms: terms.agreement, budgetDomainId: null, epoch: null })
    .where(eq(federationAgreements.revisionId, f.revisionId));
  await db.delete(federationBudgets).where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  await db
    .update(federationOutbound)
    .set({ request: bill.request })
    .where(eq(federationOutbound.operationId, f.operationId));
  const value = await f.make("40"),
    signed = await f.approveAdjustment(value);
  await f.attachAdjustment(signed);
  expect(signed.provider.heldAmount).toBe("0");
  expect((await f.sourceProjection())?.settledAmount).toBe("53");
  for (const [keys, actor, service] of [
    [f.provider, f.actor, f.providerAdjustment],
    [f.source, f.sourceActor, f.sourceAdjustment],
  ] as const) {
    const siteId = keys.signing.siteId;
    await db
      .update(federationCommercialSubmissions)
      .set({ state: "committed" })
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' <> 'adjust-settlement'`,
        ),
      );
    let prepared = false,
      confirmed = false;
    const txid = (siteId === f.source.signing.siteId ? "b" : "c").repeat(64),
      recovery = Buffer.from("transaction").toString("base64");
    const worker = new FederationCommercialSubmissionService(db, siteId, {
      receipt: async () => ({
        receipt: { recordId: value.settlementId, digest: value.settlementDigest },
      }),
      prepare: async () => ({ transactionId: txid, recovery: "proposal" }),
      advance: async () => {
        if (!prepared) {
          prepared = true;
          return { state: "prepared", transactionId: txid, recovery };
        }
        return confirmed
          ? { state: "committed", transactionId: txid, blockNumber: "101" }
          : { state: "pending", transactionId: txid, recovery };
      },
    });
    await worker.advanceNext();
    await worker.advanceNext();
    await worker.advanceNext();
    const view = async () => (await service.list(actor, f.revisionId, 10, 0)).data[0];
    expect((await view())?.adjustment.appliedAt).toBeNull();
    confirmed = true;
    await db
      .update(federationCommercialSubmissions)
      .set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(eq(federationCommercialSubmissions.id, (await view())?.ledger?.id ?? ""));
    await worker.advanceNext();
    expect((await view())?.adjustment.appliedAt).toBeInstanceOf(Date);
    expect(await worker.advanceNext()).toBe(false);
  }
  expect(await f.budget()).toBeUndefined();
  expect((await f.sourceProjection())?.settledAmount).toBe("40");
  expect(
    (
      await db
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, f.reservationId))
    )[0]?.settledAmount,
  ).toBe("40");
});

test("adjustment absent signing purpose rolls back a prepared debit hold", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-adjustment'` })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.providerAdjustment.approve(f.actor, f.revisionId, value)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  expect((await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
});
test("adjustment concurrent counterpart attachment applies each institution exactly once", async () => {
  const f = await adjustmentServiceFixture(),
    value = await f.make("60"),
    signed = await f.approveAdjustment(value);
  await Promise.all(Array.from({ length: 4 }, () => f.attachAdjustment(signed)));
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
  expect(await f.sourceProjection()).toMatchObject({
    settledAmount: "60",
    adjustmentHeldAmount: "0",
  });
  const audits = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, value.adjustmentId),
        eq(auditLog.action, "federation.adjustment.apply"),
      ),
    );
  expect(audits).toHaveLength(2);
});

async function adjustmentExchangeFixture(
  amount = "60",
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await adjustmentServiceFixture(mode),
    value = await f.make(amount);
  const syncKey = and(
    eq(federationCommercialApprovalSyncs.localSiteId, f.provider.signing.siteId),
    eq(federationCommercialApprovalSyncs.recordKind, "adjustment"),
    eq(federationCommercialApprovalSyncs.recordId, value.adjustmentId),
  );
  const status = async (provider = true) =>
    (
      await (provider ? f.providerAuto : f.sourceAuto).list(
        provider ? f.actor : f.sourceActor,
        f.revisionId,
        10,
        0,
      )
    ).records.find((row) => row.recordId === value.adjustmentId);
  const view = async () => (await f.providerAdjustment.list(f.actor, f.revisionId, 10, 0)).data[0];
  return { ...f, value, syncKey, status, view };
}

for (const amount of ["40", "60"]) {
  test(`adjustment exchange waits for independent consent before applying charge ${amount}`, async () => {
    const f = await adjustmentExchangeFixture(amount);
    const original = await f.providerAdjustment.approve(f.actor, f.revisionId, f.value);
    await f.providerAuto.discover();
    await f.providerAuto.advanceNext();
    expect((await f.status())?.state).toBe("pending");
    expect((await f.sourceAdjustment.list(f.sourceActor, f.revisionId, 10, 0)).data).toHaveLength(
      0,
    );
    expect(await f.budget()).toMatchObject({
      available: amount === "60" ? "40" : "47",
      reserved: amount === "60" ? "7" : "0",
      spent: "53",
    });
    const source = await f.sourceAdjustment.approve(f.sourceActor, f.revisionId, f.value);
    await f.sourceAuto.discover();
    await f.due();
    await Promise.all([f.providerAuto.advanceNext(), f.sourceAuto.advanceNext()]);
    expect((await f.status())?.state).toBe("complete");
    expect((await f.status(false))?.state).toBe("complete");
    expect((await f.view())?.adjustment).toMatchObject({
      approvalJws: original.approvalJws,
      counterpartyJws: source.approvalJws,
    });
    expect(await f.budget()).toMatchObject({
      available: amount === "60" ? "40" : "60",
      reserved: "0",
      spent: amount,
    });
    expect(await f.sourceProjection()).toMatchObject({
      settledAmount: amount,
      adjustmentHeldAmount: "0",
    });
    expect(await f.providerAuto.advanceNext()).toBe(false);
  });
}

test("adjustment exchange recovers a lost response once without waiting for attestation", async () => {
  const f = await adjustmentExchangeFixture("60", "bilateral_attested");
  await f.approveAdjustment(f.value);
  await f.providerAuto.discover();
  f.transport.afterResponse = async () => {
    throw new Error("Dropped response");
  };
  await f.providerAuto.advanceNext();
  expect(await f.status()).toMatchObject({ state: "pending", lastError: "EXCHANGE_RETRY" });
  expect((await f.view())?.adjustment.counterpartyJws).toBeNull();
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
  delete f.transport.afterResponse;
  await f.due();
  const restarted = new FederationCommercialApprovalExchange(
    db,
    f.provider.signing,
    f.sendProvider,
  );
  await Promise.all([restarted.advanceNext(), restarted.advanceNext()]);
  expect((await f.status())?.state).toBe("complete");
  expect((await f.view())?.ledger).toMatchObject({ state: "pending" });
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'recordId' = ${f.value.adjustmentId}`,
        ),
      ),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.value.adjustmentId),
          eq(auditLog.action, "federation.adjustment.apply"),
        ),
      ),
  ).toHaveLength(1);
});

test("adjustment exchange keeps signed consent after staff loses approval authority but cannot approve again", async () => {
  const f = await adjustmentExchangeFixture();
  await f.approveAdjustment(f.value);
  await f.providerAuto.discover();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: false },
    f.userId,
  );
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
  await expect(
    f.providerAdjustment.approve(f.actor, f.revisionId, { ...f.value, adjustmentId: randomUUID() }),
  ).rejects.toThrow("POLICY_DENIED");
  expect(await f.budget()).toMatchObject({ reserved: "0", spent: "60" });
});

for (const change of ["purpose", "endpoint"] as const) {
  test(`adjustment exchange rejects ${change} changes during transport and preserves its hold`, async () => {
    const f = await adjustmentExchangeFixture();
    await f.approveAdjustment(f.value);
    await f.providerAuto.discover();
    f.transport.afterResponse = async (response) => {
      if (change === "purpose")
        await db
          .update(federationSigningKeys)
          .set({
            allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-adjustment'`,
          })
          .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
      else
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.example.invalid" })
          .where(eq(federationSites.id, f.source.signing.siteId));
      return response;
    };
    await f.providerAuto.advanceNext();
    expect(await f.status()).toMatchObject({
      state: "needs_review",
      lastError: "UNTRUSTED_IDENTITY",
    });
    expect((await f.view())?.adjustment.counterpartyJws).toBeNull();
    expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
  });
}

test("adjustment exchange late response cannot apply or overwrite a replacement lease; retry needs adjustment permission", async () => {
  const f = await adjustmentExchangeFixture();
  await f.approveAdjustment(f.value);
  await f.providerAuto.discover();
  const replacement = randomUUID();
  f.transport.afterResponse = async (response) => {
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseToken: replacement, leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
      .where(f.syncKey);
    return response;
  };
  await f.providerAuto.advanceNext();
  expect(
    (await db.select().from(federationCommercialApprovalSyncs).where(f.syncKey))[0],
  ).toMatchObject({ state: "pending", leaseToken: replacement });
  expect((await f.view())?.adjustment.counterpartyJws).toBeNull();
  expect(await f.budget()).toMatchObject({ reserved: "7", spent: "53" });
  const identity = {
    agreementRevisionId: f.revisionId,
    recordKind: "adjustment" as const,
    recordId: f.value.adjustmentId,
  };
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: false },
    f.userId,
  );
  await expect(f.providerAuto.retry(f.actor, identity)).rejects.toThrow("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: true },
    f.userId,
  );
  await expect(f.providerAuto.retry(f.actor, identity)).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationCommercialApprovalSyncs)
    .set({ leaseUntil: new Date(0) })
    .where(f.syncKey);
  await f.providerAuto.retry(f.actor, identity);
  delete f.transport.afterResponse;
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
  expect(await f.budget()).toMatchObject({ reserved: "0", spent: "60" });
});

test("adjustment exchange finishes a manual attachment race without resending or applying twice", async () => {
  const f = await adjustmentExchangeFixture(),
    signed = await f.approveAdjustment(f.value);
  await f.providerAuto.discover();
  await f.attachAdjustment(signed);
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
  expect(f.transport.calls).toBe(0);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.value.adjustmentId),
          eq(auditLog.action, "federation.adjustment.apply"),
        ),
      ),
  ).toHaveLength(2);
  expect(await f.budget()).toMatchObject({ reserved: "0", spent: "60" });
});

test("adjustment exchange audit failure rolls back signature, application, sync and outbox together", async () => {
  const f = await adjustmentExchangeFixture("60", "bilateral_attested");
  await f.approveAdjustment(f.value);
  await f.providerAuto.discover();
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT adjustment_exchange_audit_fixture CHECK (action <> 'federation.adjustment.counterparty' OR target <> '${f.value.adjustmentId}')`,
    ),
  );
  try {
    await f.providerAuto.advanceNext();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT adjustment_exchange_audit_fixture`);
  }
  expect((await f.status())?.state).toBe("pending");
  expect((await f.view())?.adjustment.counterpartyJws).toBeNull();
  expect((await f.view())?.ledger).toBeNull();
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
  await f.due();
  await f.providerAuto.advanceNext();
  expect((await f.status())?.state).toBe("complete");
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
});

test("adjustment exchange HTTP exposes scoped progress and requires independent adjustment retry authority", async () => {
  const f = await adjustmentExchangeFixture();
  await f.providerAdjustment.approve(f.actor, f.revisionId, f.value);
  await f.providerAuto.discover();
  const app = new Hono();
  let actor = f.actor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    await next();
  });
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    f.approvals,
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[10] = f.providerAuto;
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revisionId}/approval-exchange`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain(f.value.adjustmentId);
  for (const field of ["approvalJws", "leaseToken", "chargedAmount", "prices", "payload"])
    expect(body).not.toContain(field);
  const retry = (value: unknown = {}) =>
    app.request(`${path}/adjustment/${f.value.adjustmentId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  expect((await retry({ approve: true })).status).toBe(400);
  const permissions = new FederationPermissionService(db);
  await permissions.set({ ...f.actor, capability: "adjustment.approve", enabled: false }, f.userId);
  expect((await retry()).status).toBe(403);
  await permissions.set({ ...f.actor, capability: "adjustment.approve", enabled: true }, f.userId);
  await permissions.set({ ...f.actor, capability: "agreement.approve", enabled: false }, f.userId);
  expect((await retry()).status).toBe(200);
  actor = f.sourceActor;
  expect((await app.request(path)).status).toBe(409);
  expect((await retry()).status).toBe(403);
  expect(f.transport.calls).toBe(0);
});

test("adjustment CLI real HTTP and PostgreSQL approve, hold, attach and query the original", async () => {
  const f = await adjustmentServiceFixture();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[19] = f.providerAdjustment;
  const app = new Hono(),
    token = randomUUID();
  let actor = f.actor,
    automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({}, 401);
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.use("/api/federation/*", federationOrganizationContext);
  app.route("/api", createFederationCommercialRoutes(...deps));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  cleanup.push(async () => {
    server.stop(true);
  });
  const dir = await mkdtemp(join(tmpdir(), "kq-adjustment-cli-pg-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json"),
    file = join(dir, "adjustment.json"),
    id = randomUUID();
  await writeFile(config, JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, token }), {
    mode: 0o600,
  });
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "federation",
        "--org",
        f.orgId,
        "--lang",
        "en",
        "--json",
        "adjustments",
        ...args,
      ],
      { env: { ...process.env, KQ_CONFIG_FILE: config }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  expect(
    await run(
      "draft",
      f.revisionId,
      f.draft.settlementId,
      file,
      "--id",
      id,
      "--amount",
      "60",
      "--reason",
      "Approved correction",
    ),
  ).toMatchObject({ code: 0 });
  const value = CommercialAdjustmentSchema.parse(await Bun.file(file).json());
  expect(value).toMatchObject({
    adjustmentId: id,
    previousChargedAmount: "53",
    chargedAmount: "60",
  });
  actor = f.sourceActor;
  expect(await run("approve", f.revisionId, file)).toMatchObject({ code: 1, stdout: "" });
  actor = f.actor;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: false },
    f.userId,
  );
  const denied = await run("approve", f.revisionId, file);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("HTTP 403 POLICY_DENIED");
  expect(await f.budget()).toMatchObject({ reserved: "0", spent: "53" });
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "adjustment.approve", enabled: true },
    f.userId,
  );
  automation = true;
  expect((await run("approve", f.revisionId, file)).code).toBe(1);
  automation = false;
  const approved = await run("approve", f.revisionId, file);
  expect(approved.code).toBe(0);
  expect(JSON.parse(approved.stdout)).toMatchObject({
    adjustmentId: id,
    heldAmount: "7",
    counterpartyJws: null,
    appliedAt: null,
  });
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "7", spent: "53" });
  const source = await f.sourceAdjustment.approve(f.sourceActor, f.revisionId, value),
    jws = join(dir, "peer.jws");
  await writeFile(jws, source.approvalJws, { mode: 0o600 });
  expect((await run("attach", f.revisionId, id, jws)).code).toBe(0);
  const listed = await run("list", f.revisionId, "--record", id);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).data[0].adjustment).toMatchObject({
    adjustmentId: id,
    counterpartyJws: source.approvalJws,
    payload: value,
  });
  expect(JSON.parse(listed.stdout).data[0].adjustment.appliedAt).not.toBeNull();
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
  expect((await run("attach", f.revisionId, id, jws)).code).toBe(0);
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "0", spent: "60" });
}, 30000);

test("adjustment history filters the original settlement and keeps current net charge independent of pagination", async () => {
  const f = await adjustmentServiceFixture(),
    initial = await f.make("40");
  const list = (offset = 0, recordId?: string) =>
    f.providerAdjustment.list(f.actor, f.revisionId, 1, offset, recordId, f.draft.settlementId);
  expect((await list()).summary).toMatchObject({
    originalChargedAmount: "53",
    currentChargedAmount: "53",
    pendingAdjustmentId: null,
  });
  await f.attachAdjustment(await f.approveAdjustment(initial));
  const next = await f.make("60"),
    approved = await f.approveAdjustment(next);
  expect((await list()).data[0]?.adjustment.adjustmentId).toBe(next.adjustmentId);
  expect((await list()).hasMore).toBe(true);
  const older = await list(1);
  expect(older.data[0]?.adjustment.adjustmentId).toBe(initial.adjustmentId);
  expect(older.summary).toMatchObject({
    originalChargedAmount: "53",
    currentChargedAmount: "40",
    pendingAdjustmentId: next.adjustmentId,
  });
  await f.attachAdjustment(approved);
  const historical = await list(0, initial.adjustmentId);
  expect(historical.data[0]?.adjustment.payload.chargedAmount).toBe("40");
  expect(historical.summary).toMatchObject({
    originalChargedAmount: "53",
    currentChargedAmount: "60",
    pendingAdjustmentId: null,
  });
  await expect(
    f.providerAdjustment.list(f.sourceActor, f.revisionId, 10, 0, undefined, f.draft.settlementId),
  ).rejects.toThrow("AGREEMENT_UNAVAILABLE");
  await expect(
    f.providerAdjustment.list(f.actor, f.revisionId, 10, 0, undefined, randomUUID()),
  ).rejects.toThrow("ASSET_UNAVAILABLE");
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    f.approvals,
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[19] = f.providerAdjustment;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  const path = `/federation/commercial-agreements/${f.revisionId}/adjustments`;
  const response = await app.request(
    `${path}?settlementId=${f.draft.settlementId}&limit=1&offset=1`,
  );
  expect(response.status).toBe(200);
  expect(
    z.object({ data: CommercialAdjustmentListSchema }).parse(await response.json()).data.summary
      ?.currentChargedAmount,
  ).toBe("60");
  expect((await app.request(`${path}?settlementId=bad`)).status).toBe(400);
});

test("adjustment history does not present an unapplied settlement as current accounting", async () => {
  const f = await settlementFixture();
  await f.approve();
  const service = new FederationAdjustmentService(db, f.provider.signing);
  const view = await service.list(f.actor, f.revisionId, 20, 0, undefined, f.draft.settlementId);
  expect(view.data).toHaveLength(0);
  expect(view.summary).toMatchObject({
    originalChargedAmount: "53",
    currentChargedAmount: null,
    pendingAdjustmentId: null,
  });
});

test("attestation backlog deduplicates commercial evidence and ages new adjustments independently", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested");
  const read = () => readAttestationBacklog(db, f.terms, new Date());
  expect(await read()).toMatchObject({ outstandingTasks: 1, outstandingAmount: "60" });
  const records = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  expect(records.some((r) => r.input.operation === "record-usage")).toBe(true);
  expect(records.some((r) => r.input.operation === "confirm-bill")).toBe(true);
  expect(records.some((r) => r.input.operation === "settle-bill")).toBe(true);
  // Isolate each obligation; this is a DB aggregation test, not proof of a Fabric commit.
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  expect(await read()).toMatchObject({
    outstandingTasks: 0,
    outstandingAmount: "0",
    oldestAgeSec: null,
  });
  for (const record of records) {
    await db
      .update(federationCommercialSubmissions)
      .set({ state: "needs_review" })
      .where(eq(federationCommercialSubmissions.id, record.id));
    expect(await read()).toMatchObject({ outstandingTasks: 1, outstandingAmount: "60" });
    await db
      .update(federationCommercialSubmissions)
      .set({ state: "committed" })
      .where(eq(federationCommercialSubmissions.id, record.id));
  }
  await db
    .update(federationReservations)
    .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
    .where(eq(federationReservations.id, f.reservationId));
  const value = await f.make("40"),
    signed = await f.approveAdjustment(value);
  await f.attachAdjustment(signed);
  expect(await read()).toMatchObject({ outstandingTasks: 1, outstandingAmount: "60" });
  expect((await read()).oldestAgeSec).toBeLessThan(60);
  expect(await f.budget()).toMatchObject({ available: "60", reserved: "0", spent: "40" });
});

async function completionRenewalFixture(siteId: string, actorId: string) {
  const { FederationCompletionCapacity } = await import("./completion-capacity");
  const { testCompletionStorage } = await import("./test-fixtures");
  const { federationCompletionClaims: claims, federationCompletionPools: pools } = await import(
    "@kuintessence/db"
  );
  const storage = testCompletionStorage();
  const capacity = new FederationCompletionCapacity(db, siteId, storage.guard);
  const policy = {
    reserveId: storage.reserveId,
    capacityBytes: "1000",
    taskBytes: "60",
    marketBytes: "20",
  };
  await capacity.configure(policy, actorId);
  cleanup.push(async () => {
    await db.delete(claims).where(eq(claims.localSiteId, siteId));
    await db.delete(pools).where(eq(pools.localSiteId, siteId));
    await db.delete(auditLog).where(eq(auditLog.actor, `completion:${siteId}`));
  });
  return {
    ...storage,
    capacity,
    policy,
    release: () =>
      db.update(claims).set({ releasedAt: new Date() }).where(eq(claims.localSiteId, siteId)),
    constrain: () =>
      capacity.configure({ ...policy, capacityBytes: "50", taskBytes: "10" }, actorId),
    restore: () => capacity.configure(policy, actorId),
  };
}

test("completion renewal gates a post-settlement adjustment and rolls back monetary holds when capacity is unavailable", async () => {
  const f = await adjustmentServiceFixture();
  const cap = await completionRenewalFixture(f.source.signing.siteId, f.sourceActor.userId);
  await cap.release();
  await cap.constrain();
  const service = new FederationAdjustmentService(db, f.source.signing, cap.guard);
  const value = await f.make("55");
  await expect(service.approve(f.sourceActor, f.revisionId, value)).rejects.toThrow(
    "STORAGE_PRESSURE",
  );
  expect(await cap.capacity.inspect()).toMatchObject({
    allocatedBytes: "0",
    releasedObligations: 1,
  });
  expect(await f.sourceProjection()).toMatchObject({ adjustmentHeldAmount: "0" });
  await cap.restore();
  const approved = await service.approve(f.sourceActor, f.revisionId, value);
  expect(approved.heldAmount).toBe("2");
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  await cap.release();
  cap.pressure();
  expect((await service.approve(f.sourceActor, f.revisionId, value)).approvalJws).toBe(
    approved.approvalJws,
  );
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("completion renewal defers a new usage page without advancing its cursor or sending it to manual review", async () => {
  const f = await exchangeFixture();
  const cap = await completionRenewalFixture(f.source.signing.siteId, f.sourceActor.userId);
  await cap.release();
  await cap.constrain();
  const exchange = new FederationUsageExchange(db, f.source.signing, f.send, cap.guard);
  await exchange.discover();
  await exchange.advanceNext();
  let view = await exchange.get(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  expect(view.sync).toMatchObject({ state: "pending", number: 0, lastError: "STORAGE_PRESSURE" });
  expect(view.reports).toHaveLength(0);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
  await cap.restore();
  await f.due();
  await exchange.advanceNext();
  view = await exchange.get(f.sourceActor, f.terms.agreementRevisionId, f.operationId);
  expect(view.sync).toMatchObject({ state: "pending", number: 1, lastError: null });
  expect(view.reports).toHaveLength(1);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
});

test("completion renewal requires the original provider allocation before a new technical correction", async () => {
  const f = await correctionFixture();
  const { FederationDelegationSchema } = await import("@kuintessence/shared/federation");
  const [binding] = await db
    .select()
    .from(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  if (!binding) throw new Error("Missing accepted request");
  await db
    .update(federationReservations)
    .set({
      requestJws: await signFederationMessage(
        FederationDelegationSchema,
        binding.snapshot.request,
        f.source.signing,
      ),
    })
    .where(eq(federationReservations.id, f.reservationId));
  const cap = await completionRenewalFixture(f.provider.signing.siteId, f.actor.userId);
  await cap.release();
  await cap.constrain();
  const service = new FederationUsageService(db, f.provider.signing, cap.guard);
  await expect(
    service.correct(f.actor, f.terms.agreementRevisionId, f.reservationId, f.input),
  ).rejects.toThrow("STORAGE_PRESSURE");
  expect((await f.view()).reports).toHaveLength(1);
  await cap.restore();
  const corrected = await service.correct(
    f.actor,
    f.terms.agreementRevisionId,
    f.reservationId,
    f.input,
  );
  expect((await f.view()).reports).toHaveLength(2);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  await cap.release();
  cap.pressure();
  expect(
    (await service.correct(f.actor, f.terms.agreementRevisionId, f.reservationId, f.input))
      .reportJws,
  ).toBe(corrected.reportJws);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("completion renewal gates a newly signed bill before persisting its approval", async () => {
  const f = await billingFixture();
  const cap = await completionRenewalFixture(f.source.signing.siteId, f.sourceActor.userId);
  await cap.release();
  await cap.constrain();
  const service = new FederationBillingService(db, f.source.signing, cap.guard);
  await expect(service.approve(f.sourceActor, f.revisionId, f.draft)).rejects.toThrow(
    "STORAGE_PRESSURE",
  );
  expect(await cap.capacity.inspect()).toMatchObject({
    allocatedBytes: "0",
    releasedObligations: 1,
  });
  await cap.restore();
  const approved = await service.approve(f.sourceActor, f.revisionId, f.draft);
  expect(approved.billId).toBe(f.draft.billId);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
});

async function completionReleaseFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await adjustmentServiceFixture(mode);
  const { FederationDelegationSchema } = await import("@kuintessence/shared/federation");
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  const [binding] = await db
    .select()
    .from(federationWorkflowBindings)
    .where(eq(federationWorkflowBindings.reservationId, f.reservationId));
  if (!binding) throw new Error("Missing execution binding");
  await db
    .update(federationReservations)
    .set({
      requestJws: await signFederationMessage(
        FederationDelegationSchema,
        binding.snapshot.request,
        f.source.signing,
      ),
    })
    .where(eq(federationReservations.id, f.reservationId));
  await db
    .update(federationOutbound)
    .set({ statusNextAttemptAt: null })
    .where(eq(federationOutbound.localSiteId, f.source.signing.siteId));
  const sourceCapacity = await completionRenewalFixture(
    f.source.signing.siteId,
    f.sourceActor.userId,
  );
  const providerCapacity = await completionRenewalFixture(
    f.provider.signing.siteId,
    f.actor.userId,
  );
  const due = (siteId: string) =>
    db
      .update(claims)
      .set({ nextCheckAt: sql`clock_timestamp()` })
      .where(eq(claims.localSiteId, siteId));
  const claim = async (siteId: string) =>
    (await db.select().from(claims).where(eq(claims.localSiteId, siteId)))[0];
  return { ...f, sourceCapacity, providerCapacity, due, claim };
}

test("completion release closes settled direct obligations at both sites and later adjustment reacquires the same allocation", async () => {
  const f = await completionReleaseFixture();
  for (const cap of [f.sourceCapacity, f.providerCapacity]) {
    expect(await cap.capacity.advanceNext()).toBe(true);
    expect(await cap.capacity.inspect()).toMatchObject({
      allocatedBytes: "0",
      releasedObligations: 1,
    });
    expect(await cap.capacity.advanceNext()).toBe(false);
  }
  const value = await f.make("40");
  const service = new FederationAdjustmentService(db, f.source.signing, f.sourceCapacity.guard);
  await service.approve(f.sourceActor, f.revisionId, value);
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({
    allocatedBytes: "60",
    releasedObligations: 0,
  });
  await f.sourceCapacity.capacity.advanceNext();
  expect((await f.claim(f.source.signing.siteId))?.releaseBlocker).toBe("adjustment");
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
});

test("completion release keeps storage for active execution and an unapplied settlement without waiting on unrelated claims", async () => {
  const f = await completionReleaseFixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe(
    "execution-or-input-cleanup",
  );
  await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, f.runId));
  await db
    .update(federationCommercialSettlements)
    .set({ appliedAt: null })
    .where(
      and(
        eq(federationCommercialSettlements.localSiteId, f.provider.signing.siteId),
        eq(federationCommercialSettlements.settlementId, f.draft.settlementId),
      ),
    );
  await f.due(f.provider.signing.siteId);
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe("settlement");
  await f.sourceCapacity.capacity.advanceNext();
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
  expect(await f.providerCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
});

test("completion release waits for attested commercial submissions and preserves the original allocation on review", async () => {
  const f = await completionReleaseFixture("bilateral_attested");
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe("commercial-ledger");
  expect(await f.providerCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "needs_review" })
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  await f.due(f.provider.signing.siteId);
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releasedAt).toBeNull();
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  await f.due(f.provider.signing.siteId);
  await f.providerCapacity.capacity.advanceNext();
  expect(await f.providerCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("completion release waits for the final source status write and its lease", async () => {
  const f = await completionReleaseFixture();
  const siteId = f.source.signing.siteId;
  for (const update of [
    { statusNextAttemptAt: new Date(), statusClaim: null, statusLastError: null },
    { statusNextAttemptAt: null, statusClaim: randomUUID(), statusLastError: null },
    { statusNextAttemptAt: null, statusClaim: null, statusLastError: "STATUS_RETRY" },
  ]) {
    await db
      .update(federationOutbound)
      .set(update)
      .where(eq(federationOutbound.localSiteId, siteId));
    await f.due(siteId);
    await f.sourceCapacity.capacity.advanceNext();
    expect((await f.claim(siteId))?.releaseBlocker).toBe("outbound");
  }
  await db
    .update(federationOutbound)
    .set({ statusLastError: null })
    .where(eq(federationOutbound.localSiteId, siteId));
  await f.due(siteId);
  await f.sourceCapacity.capacity.advanceNext();
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("completion release late closing discovery reacquires atomically and does not charge duplicate discovery", async () => {
  const f = await completionReleaseFixture();
  const cap = f.providerCapacity;
  await cap.capacity.advanceNext();
  await grantClosing(f, "bill");
  await grantClosing(f, "settlement");
  const closing = new FederationClosingAutomation(
    db,
    f.provider.signing,
    async () => {
      throw new Error("Discovery must not make network calls");
    },
    cap.guard,
  );
  await cap.constrain();
  await closing.discover();
  expect((await closing.list(f.actor, f.revisionId)).records).toHaveLength(0);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
  await cap.restore();
  await closing.discover();
  const tasks = await closing.list(f.actor, f.revisionId);
  expect(tasks.records).toHaveLength(2);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
  await cap.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe("closing");
  cap.pressure();
  await closing.discover();
  expect((await closing.list(f.actor, f.revisionId)).records).toHaveLength(2);
  expect(await cap.capacity.inspect()).toMatchObject({ allocatedBytes: "60", obligations: 1 });
});

test("completion release skips locked claims and serializes with a later adjustment", async () => {
  const f = await completionReleaseFixture();
  const { federationCompletionClaims: claims } = await import("@kuintessence/db");
  let acquired!: () => void, resume!: () => void;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const held = db.transaction(async (tx) => {
    await tx
      .select()
      .from(claims)
      .where(eq(claims.localSiteId, f.source.signing.siteId))
      .for("update");
    acquired();
    await resumed;
  });
  await locked;
  try {
    expect(await f.sourceCapacity.capacity.advanceNext()).toBe(false);
    expect(await f.providerCapacity.capacity.advanceNext()).toBe(true);
  } finally {
    resume();
    await held;
  }
  const value = await f.make("40");
  const service = new FederationAdjustmentService(db, f.source.signing, f.sourceCapacity.guard);
  await Promise.all([
    f.sourceCapacity.capacity.advanceNext(),
    service.approve(f.sourceActor, f.revisionId, value),
  ]);
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({
    allocatedBytes: "60",
    obligations: 1,
  });
});

test("completion release retains capacity until result acknowledgment and input cleanup finish", async () => {
  const f = await completionReleaseFixture();
  const { federationResultImports: results, federationInputImports: inputs } = await import(
    "@kuintessence/db"
  );
  const resultId = randomUUID(),
    inputId = randomUUID();
  cleanup.push(async () => {
    await db.delete(results).where(eq(results.id, resultId));
    await db.delete(inputs).where(eq(inputs.id, inputId));
  });
  // Only lifecycle columns are under test; transport verification is covered by the import suites.
  await db.execute(sql`INSERT INTO federation_result_imports
    (id, local_site_id, local_org_id, operation_id, requested_by, report, report_jws, manifest_digest, state)
    VALUES (${resultId}, ${f.source.signing.siteId}, ${f.sourceActor.orgId}, ${f.operationId},
      ${f.sourceActor.userId}, '{}'::jsonb, 'verified-fixture', ${`sha256:${"a".repeat(64)}`}, 'available')`);
  await f.sourceCapacity.capacity.advanceNext();
  expect((await f.claim(f.source.signing.siteId))?.releaseBlocker).toBe("result-receipt");
  await db.execute(sql`UPDATE federation_result_imports SET receipt = '{}'::jsonb,
    receipt_jws = 'verified-fixture', receipt_ack = '{}'::jsonb, receipt_ack_jws = 'verified-fixture'
    WHERE id = ${resultId}`);
  await f.due(f.source.signing.siteId);
  await f.sourceCapacity.capacity.advanceNext();
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
  await db.execute(sql`INSERT INTO federation_input_imports
    (id, reservation_id, local_site_id, local_org_id, owner_id, manifest_digest, manifest, state,
      reserved_bytes, expires_at, published_at)
    VALUES (${inputId}, ${f.reservationId}, ${f.provider.signing.siteId}, ${f.actor.orgId}, ${f.actor.userId},
      ${`sha256:${"b".repeat(64)}`}, '{}'::jsonb, 'available', 0, clock_timestamp(), clock_timestamp())`);
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe(
    "execution-or-input-cleanup",
  );
  await db.update(inputs).set({ state: "cancelled" }).where(eq(inputs.id, inputId));
  await f.due(f.provider.signing.siteId);
  await f.providerCapacity.capacity.advanceNext();
  expect(await f.providerCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

test("completion release retains an attestation outbox even after all commercial records commit", async () => {
  const f = await completionReleaseFixture("bilateral_attested");
  const { federationEvidence: evidence, federationAttestationOutbox: outbox } = await import(
    "@kuintessence/db"
  );
  const id = randomUUID();
  cleanup.push(async () => {
    await db.delete(outbox).where(eq(outbox.evidenceId, id));
    await db.delete(evidence).where(eq(evidence.id, id));
  });
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  await db.insert(evidence).values({
    id,
    reservationId: f.reservationId,
    kind: "acceptance",
    jws: "verified-fixture",
    digest: `sha256:${"a".repeat(64)}`,
  });
  await db.insert(outbox).values({ evidenceId: id });
  await f.providerCapacity.capacity.advanceNext();
  expect((await f.claim(f.provider.signing.siteId))?.releaseBlocker).toBe("attestation");
  expect(await f.providerCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
});

test("completion release rolls back the capacity change when its audit cannot be saved", async () => {
  const f = await completionReleaseFixture();
  const constraint = sql.identifier(`test_release_audit_${randomUUID().replaceAll("-", "")}`);
  await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT ${constraint}
    CHECK (action <> 'federation.storage.completion.release') NOT VALID`);
  try {
    await expect(f.sourceCapacity.capacity.advanceNext()).rejects.toThrow();
    expect((await f.claim(f.source.signing.siteId))?.releasedAt).toBeNull();
    expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "60" });
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT ${constraint}`);
  }
  await f.sourceCapacity.capacity.advanceNext();
  expect(await f.sourceCapacity.capacity.inspect()).toMatchObject({ allocatedBytes: "0" });
});

async function paymentFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await billingExchangeFixture(mode);
  await f.approveBoth();
  cleanup.push(async () => {
    for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId]) {
      await db
        .delete(federationCommercialPayments)
        .where(eq(federationCommercialPayments.localSiteId, siteId));
      await db.delete(auditLog).where(eq(auditLog.actor, `payment-exchange:${siteId}`));
    }
  });
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-payment"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  for (const actor of [f.actor, f.sourceActor])
    await new FederationPermissionService(db).set(
      { ...actor, capability: "payment.approve", enabled: true },
      actor.userId,
    );
  const providerPayment = new FederationPaymentService(db, f.provider.signing),
    sourcePayment = new FederationPaymentService(db, f.source.signing);
  const input = {
    receiptId: randomUUID(),
    paymentId: randomUUID(),
    billId: f.draft.billId,
    amount: "7",
    occurredAt: new Date().toISOString(),
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    reason: "External receipt",
  };
  const draft = await providerPayment.draft(f.actor, f.revisionId, input);
  const approve = async (value = draft) => ({
    source: await sourcePayment.approve(f.sourceActor, f.revisionId, value),
    provider: await providerPayment.approve(f.actor, f.revisionId, value),
  });
  const confirm = async (value = draft) => {
    const both = await approve(value);
    await sourcePayment.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      value.receiptId,
      both.provider.approvalJws,
    );
    return providerPayment.attachCounterparty(
      f.actor,
      f.revisionId,
      value.receiptId,
      both.source.approvalJws,
    );
  };
  const budget = async () =>
    (
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, f.terms.budgetDomainId))
    )[0];
  return { ...f, input, draft, approve, confirm, budget, providerPayment, sourcePayment };
}

test("payment direct preserves money and immutable receipts, replaces only the current amount and replays old signatures", async () => {
  const f = await paymentFixture(),
    before = await f.budget();
  const pending = await f.approve();
  expect(pending.provider).toMatchObject({
    current: false,
    confirmedAt: null,
    counterpartyJws: null,
  });
  await f.confirm();
  const correction = await f.providerPayment.draft(f.actor, f.revisionId, {
    ...f.input,
    receiptId: randomUUID(),
    amount: "0",
    reason: "Correct erroneous report",
  });
  expect(correction.previous).toEqual({
    receiptId: f.draft.receiptId,
    digest: pending.provider.digest,
  });
  await f.confirm(correction);
  const replay = await f.providerPayment.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.receiptId,
    pending.source.approvalJws,
  );
  expect(replay.current).toBe(false);
  expect((await f.providerPayment.approve(f.actor, f.revisionId, f.draft)).approvalJws).toBe(
    pending.provider.approvalJws,
  );
  const history = await f.providerPayment.list(
    f.actor,
    f.revisionId,
    10,
    0,
    f.draft.billId,
    f.draft.paymentId,
  );
  expect(history.data).toHaveLength(2);
  expect(
    history.data.filter((r) => r.payment.current).map((r) => r.payment.payload.amount),
  ).toEqual(["0"]);
  expect(
    history.data.find((r) => r.payment.receiptId === f.draft.receiptId)?.payment.payload.amount,
  ).toBe("7");
  expect(history.data.every((r) => r.ledger === null)).toBe(true);
  expect(await f.budget()).toEqual(before);
  expect(
    await new FederationCommercialSubmissionService(db, f.provider.signing.siteId).advanceNext(),
  ).toBe(false);
  await expect(
    f.providerPayment.approve(f.actor, f.revisionId, { ...correction, receiptId: randomUUID() }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("payment requires independent authority, original bill scope, exact signatures and current payment key purpose", async () => {
  const f = await paymentFixture();
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "payment.approve", enabled: false },
    f.actor.userId,
  );
  await expect(f.providerPayment.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "payment.approve", enabled: true },
    f.actor.userId,
  );
  for (const change of [
    { unit: "other" },
    { billDigest: `sha256:${"b".repeat(64)}` },
    { sourceSiteId: randomUUID() },
    { issuedAt: new Date(Date.now() + 120000).toISOString() },
  ])
    await expect(
      f.providerPayment.approve(f.actor, f.revisionId, { ...f.draft, ...change }),
    ).rejects.toThrow("POLICY_DENIED");
  await expect(f.providerPayment.approve(f.sourceActor, f.revisionId, f.draft)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  const both = await f.approve();
  await expect(
    f.providerPayment.attachCounterparty(
      f.actor,
      f.revisionId,
      f.draft.receiptId,
      both.provider.approvalJws,
    ),
  ).rejects.toThrow();
  await expect(
    f.providerPayment.attachCounterparty(
      f.actor,
      f.revisionId,
      f.draft.receiptId,
      await signFederationMessage(
        CommercialPaymentSchema,
        { ...f.draft, amount: "8" },
        f.source.signing,
      ),
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-payment'` })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.providerPayment.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(
    f.providerPayment.attachCounterparty(
      f.actor,
      f.revisionId,
      f.draft.receiptId,
      both.source.approvalJws,
    ),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("payment concurrent competing statements cannot both be signed and duplicate confirmation creates one head", async () => {
  const f = await paymentFixture();
  const results = await Promise.allSettled([
    f.providerPayment.approve(f.actor, f.revisionId, f.draft),
    f.providerPayment.approve(f.actor, f.revisionId, {
      ...f.draft,
      receiptId: randomUUID(),
      amount: "8",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const saved = results.find((r) => r.status === "fulfilled");
  if (saved?.status !== "fulfilled") throw new Error("Missing approved receipt");
  const source = await f.sourcePayment.approve(f.sourceActor, f.revisionId, saved.value.payload);
  await Promise.all(
    [1, 2].map(() =>
      f.providerPayment.attachCounterparty(
        f.actor,
        f.revisionId,
        saved.value.receiptId,
        source.approvalJws,
      ),
    ),
  );
  expect((await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(1);
});

test("payment confirmation rolls back head and attestation enqueue when its audit write fails", async () => {
  const f = await paymentFixture("bilateral_attested"),
    both = await f.approve(),
    before = await f.budget();
  await db.execute(
    sql`alter table audit_log add constraint test_payment_audit_failure check (action <> 'federation.payment.counterparty')`,
  );
  try {
    await expect(
      f.providerPayment.attachCounterparty(
        f.actor,
        f.revisionId,
        f.draft.receiptId,
        both.source.approvalJws,
      ),
    ).rejects.toThrow();
    expect((await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
      payment: { current: false, confirmedAt: null, counterpartyJws: null },
      ledger: null,
    });
  } finally {
    await db.execute(sql`alter table audit_log drop constraint test_payment_audit_failure`);
  }
  expect(await f.budget()).toEqual(before);
  await f.confirm();
  expect((await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
    payment: { current: true },
    ledger: { state: "pending" },
  });
});

test("payment approval exchange joins existing signatures and preserves confirmed facts while attestation is unavailable", async () => {
  const f = await paymentFixture("bilateral_attested"),
    before = await f.budget();
  await f.approve();
  await f.providerAuto.discover();
  await f.sourceAuto.discover();
  for (let i = 0; i < 6; i++) {
    await f.providerAuto.advanceNext();
    await f.sourceAuto.advanceNext();
    await f.due();
  }
  const provider = (await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data[0];
  const source = (await f.sourcePayment.list(f.sourceActor, f.revisionId, 10, 0)).data[0];
  expect(provider).toMatchObject({ payment: { current: true }, ledger: { state: "pending" } });
  expect(source).toMatchObject({ payment: { current: true }, ledger: null });
  expect(await f.budget()).toEqual(before);
});

test("payment HTTP keeps reads private, scopes the bill and rejects automation or noninteger amounts", async () => {
  const f = await paymentFixture();
  const dependencies: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  dependencies[21] = f.providerPayment;
  let automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, f.actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...dependencies));
  const path = `/federation/commercial-agreements/${f.revisionId}/payments`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const post = (suffix: string, value: unknown) =>
    app.request(path + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  expect((await post("/approve", { ...f.draft, amount: "1.5" })).status).toBe(400);
  expect((await post("/draft", { ...f.input, billId: randomUUID() })).status).toBe(409);
  expect((await post("/approve", f.draft)).status).toBe(201);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("payment worker waits for the bill and correction predecessor, resumes one submission and never alters local money", async () => {
  const f = await paymentFixture("bilateral_attested"),
    before = await f.budget();
  const first = await f.confirm();
  const correction = await f.providerPayment.draft(f.actor, f.revisionId, {
    ...f.input,
    receiptId: randomUUID(),
    amount: "9",
  });
  await f.confirm(correction);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId),
        sql`${federationCommercialSubmissions.input}->>'recordId' <> ${correction.receiptId}`,
      ),
    );
  let present = false,
    prepares = 0,
    advances = 0;
  const seen: string[] = [],
    txid = "a".repeat(64);
  const client = {
    receipt: async (query: { recordType: string; recordId: string }) => {
      seen.push(query.recordType);
      return {
        receipt:
          query.recordType === "bill"
            ? { recordId: f.draft.billId, digest: f.draft.billDigest }
            : present
              ? { recordId: first.receiptId, digest: first.digest }
              : null,
      };
    },
    prepare: async () => {
      prepares++;
      return { transactionId: txid, recovery: "proposal" };
    },
    advance: async () => {
      advances++;
      return advances === 1
        ? {
            state: "prepared" as const,
            transactionId: txid,
            recovery: Buffer.from("transaction").toString("base64"),
          }
        : { state: "committed" as const, transactionId: txid, blockNumber: "81" };
    },
  };
  const worker = () =>
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId, client);
  const view = async () =>
    (await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data.find(
      (v) => v.payment.receiptId === correction.receiptId,
    );
  await worker().advanceNext();
  expect(seen).toEqual(["bill", "payment"]);
  expect(prepares).toBe(0);
  expect((await view())?.ledger).toMatchObject({ state: "pending", lastError: "LEDGER_PENDING" });
  present = true;
  await db
    .update(federationCommercialSubmissions)
    .set({ nextAttemptAt: sql`clock_timestamp()` })
    .where(eq(federationCommercialSubmissions.id, (await view())?.ledger?.id ?? ""));
  for (let i = 0; i < 3; i++) await worker().advanceNext();
  expect(prepares).toBe(1);
  expect(advances).toBe(2);
  expect((await view())?.ledger).toMatchObject({ state: "committed", lastError: null });
  expect((await view())?.payment).toMatchObject({ current: true, payload: { amount: "9" } });
  expect(await f.budget()).toEqual(before);
});

test("payment coordinated confirmation is immediate with chain evidence pending and does not settle execution funds", async () => {
  const f = await paymentFixture("bilateral_attested"),
    before = await f.budget();
  // Preapproved originals isolate payment behavior; coordinated execution gates have their own real Fabric suite.
  const contract = CommercialAgreementSchema.parse({
    ...f.contract,
    agreement: {
      ...f.contract.agreement,
      mode: "ledger_coordinated",
    },
  });
  const agreementDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
  const [originalBill] = await db
    .select()
    .from(federationCommercialBills)
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.provider.signing.siteId),
        eq(federationCommercialBills.billId, f.draft.billId),
      ),
    );
  if (!originalBill) throw new Error("Missing approved bill");
  const bill = CommercialBillSchema.parse({
    ...originalBill.payload,
    agreementDigest,
    request: { ...originalBill.payload.request, mode: "ledger_coordinated" },
    reservationId: f.reservationId,
  });
  const billDigest = `sha256:${createHash("sha256").update(JSON.stringify(bill)).digest("hex")}`;
  for (const [local, other] of [
    [f.provider, f.source],
    [f.source, f.provider],
  ]) {
    if (!local || !other) throw new Error("Missing fixture institution");
    await db
      .update(federationCommercialAgreements)
      .set({
        terms: contract,
        digest: agreementDigest,
        approvalJws: await signFederationMessage(
          CommercialAgreementSchema,
          contract,
          local.signing,
        ),
        counterpartyJws: await signFederationMessage(
          CommercialAgreementSchema,
          contract,
          other.signing,
        ),
      })
      .where(
        and(
          eq(federationCommercialAgreements.localSiteId, local.signing.siteId),
          eq(federationCommercialAgreements.revisionId, f.revisionId),
        ),
      );
    await db
      .update(federationCommercialBills)
      .set({
        payload: bill,
        digest: billDigest,
        approvalJws: await signFederationMessage(CommercialBillSchema, bill, local.signing),
        counterpartyJws: await signFederationMessage(CommercialBillSchema, bill, other.signing),
      })
      .where(
        and(
          eq(federationCommercialBills.localSiteId, local.signing.siteId),
          eq(federationCommercialBills.billId, bill.billId),
        ),
      );
  }
  const value = await f.providerPayment.draft(f.actor, f.revisionId, f.input);
  await f.confirm(value);
  expect((await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data[0]).toMatchObject({
    payment: { current: true },
    ledger: { state: "pending" },
  });
  expect(await f.budget()).toEqual(before);
});

test("payment CLI real HTTP and PostgreSQL preserve scope, approvals, signature bytes and corrected history", async () => {
  const f = await paymentFixture(),
    before = await f.budget();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  deps[21] = f.providerPayment;
  const token = randomUUID(),
    app = new Hono();
  let actor = f.actor,
    automation = false;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({}, 401);
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.use("/api/federation/*", federationOrganizationContext);
  app.route("/api", createFederationCommercialRoutes(...deps));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  cleanup.push(async () => {
    server.stop(true);
  });
  const dir = await mkdtemp(join(tmpdir(), "kq-payment-cli-pg-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json"),
    file = join(dir, "payment.json"),
    signature = join(dir, "peer.jws");
  await writeFile(config, JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, token }), {
    mode: 0o600,
  });
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "federation",
        "--org",
        f.orgId,
        "--lang",
        "en",
        "--json",
        ...args,
      ],
      { env: { ...process.env, KQ_CONFIG_FILE: config }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const draft = await run(
    "payments",
    "draft",
    f.revisionId,
    f.input.billId,
    file,
    "--id",
    f.input.receiptId,
    "--payment",
    f.input.paymentId,
    "--amount",
    f.input.amount,
    "--occurred-at",
    f.input.occurredAt,
    "--evidence",
    f.input.evidenceDigest,
    "--reason",
    f.input.reason,
  );
  expect(draft.code).toBe(0);
  expect((await f.providerPayment.list(f.actor, f.revisionId, 10, 0)).data).toHaveLength(0);
  const value = CommercialPaymentSchema.parse(await Bun.file(file).json());
  actor = f.sourceActor;
  expect((await run("payments", "approve", f.revisionId, file)).stderr).toContain(
    "ORGANIZATION_CONTEXT_CHANGED",
  );
  actor = f.actor;
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "payment.approve", enabled: false },
    f.userId,
  );
  expect((await run("payments", "approve", f.revisionId, file)).stderr).toContain("POLICY_DENIED");
  await new FederationPermissionService(db).set(
    { ...f.actor, capability: "payment.approve", enabled: true },
    f.userId,
  );
  automation = true;
  expect((await run("payments", "approve", f.revisionId, file)).code).toBe(1);
  automation = false;
  const approved = await run("payments", "approve", f.revisionId, file);
  expect(approved.code).toBe(0);
  expect(JSON.parse(approved.stdout)).toMatchObject({
    receiptId: value.receiptId,
    current: false,
    confirmedAt: null,
    payload: value,
  });
  const peer = await f.sourcePayment.approve(f.sourceActor, f.revisionId, value);
  await writeFile(signature, peer.approvalJws, { mode: 0o600 });
  const confirmed = await run("payments", "attach", f.revisionId, value.receiptId, signature);
  expect(confirmed.code).toBe(0);
  expect(JSON.parse(confirmed.stdout)).toMatchObject({
    current: true,
    counterpartyJws: peer.approvalJws,
  });
  const listed = await run(
    "payments",
    "list",
    f.revisionId,
    "--record",
    value.receiptId,
    "--bill",
    value.billId,
    "--payment",
    value.paymentId,
  );
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).data).toHaveLength(1);
  const missing = await run("payments", "list", f.revisionId, "--record", randomUUID());
  expect(JSON.parse(missing.stdout).data).toHaveLength(0);
  const correctionFile = join(dir, "correction.json"),
    correctionId = randomUUID();
  expect(
    (
      await run(
        "payments",
        "draft",
        f.revisionId,
        value.billId,
        correctionFile,
        "--id",
        correctionId,
        "--payment",
        value.paymentId,
        "--amount",
        "0",
        "--occurred-at",
        value.occurredAt,
        "--evidence",
        value.evidenceDigest,
        "--reason",
        "Correction",
      )
    ).code,
  ).toBe(0);
  const correction = CommercialPaymentSchema.parse(await Bun.file(correctionFile).json());
  expect(correction.previous).toEqual({ receiptId: value.receiptId, digest: peer.digest });
  await f.sourcePayment.attachCounterparty(
    f.sourceActor,
    f.revisionId,
    value.receiptId,
    JSON.parse(approved.stdout).approvalJws,
  );
  expect((await run("payments", "approve", f.revisionId, correctionFile)).code).toBe(0);
  const peerCorrection = await f.sourcePayment.approve(f.sourceActor, f.revisionId, correction);
  const correctionSignature = join(dir, "correction.jws");
  await writeFile(correctionSignature, peerCorrection.approvalJws, { mode: 0o600 });
  expect(
    (await run("payments", "attach", f.revisionId, correctionId, correctionSignature)).code,
  ).toBe(0);
  expect((await run("payments", "attach", f.revisionId, value.receiptId, signature)).code).toBe(0);
  const history = JSON.parse(
    (await run("payments", "list", f.revisionId, "--payment", value.paymentId)).stdout,
  );
  expect(history.data).toHaveLength(2);
  expect(
    history.data.find((row: { payment: { current: boolean } }) => row.payment.current)?.payment
      .payload.amount,
  ).toBe("0");
  expect(await f.budget()).toEqual(before);
});

async function disputeAccess(
  f: Pick<
    Awaited<ReturnType<typeof billingFixture>>,
    "provider" | "source" | "actor" | "sourceActor" | "report"
  >,
) {
  for (const [keys, actor] of [
    [f.provider, f.actor],
    [f.source, f.sourceActor],
  ] as const) {
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, keys.signing.siteId));
    await new FederationPermissionService(db).set(
      { ...actor, capability: "dispute.open", enabled: true },
      actor.userId,
    );
  }
  cleanup.push(async () => {
    await db
      .delete(federationDisputes)
      .where(
        inArray(federationDisputes.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      );
  });
  cleanup.push(async () => {
    await db
      .delete(auditLog)
      .where(
        inArray(auditLog.actor, [
          `dispute-inbox:${f.source.signing.siteId}`,
          `dispute-inbox:${f.provider.signing.siteId}`,
        ]),
      );
  });
  const providerCases = new FederationDisputeService(db, f.provider.signing),
    sourceCases = new FederationDisputeService(db, f.source.signing);
  const input = {
    caseId: randomUUID(),
    subject: {
      recordType: "usage" as const,
      recordId: f.report.reportId,
      recordDigest: f.report.digest,
    },
    reason: "Review this task's original accounting",
    requestedResolution: "Verify usage before approving charges",
  };
  return { providerCases, sourceCases, input };
}

test("dispute opening freezes only local new approvals and retains original case signatures on replay", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f);
  const draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  const before = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, f.terms.budgetDomainId));
  const pending = await c.providerCases.open(f.actor, f.revisionId, draft);
  expect(pending.state).toBe("FREEZE_PENDING");
  expect(await c.providerCases.open(f.actor, f.revisionId, draft)).toEqual(pending);
  const restarted = new FederationDisputeService(db, f.provider.signing);
  expect((await restarted.list(f.actor, f.revisionId, 10, 0, draft.caseId)).data).toEqual([
    pending,
  ]);
  await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, f.terms.budgetDomainId)),
  ).toEqual(before);
  // Until cross-site delivery is confirmed, the peer remains independent rather than falsely frozen.
  expect((await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft)).billId).toBe(
    f.draft.billId,
  );
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
  for (const task of [
    { agreementRevisionId: f.revisionId, taskId: randomUUID(), attempt: 1 },
    { agreementRevisionId: f.revisionId, taskId: draft.taskId, attempt: 2 },
    { agreementRevisionId: randomUUID(), taskId: draft.taskId, attempt: 1 },
  ])
    await db.transaction((tx) =>
      assertFederationTaskNotDisputed(tx, f.provider.signing.siteId, task),
    );
  const sourceDraft = await c.sourceCases.draft(f.sourceActor, f.revisionId, c.input);
  expect((await c.sourceCases.open(f.sourceActor, f.revisionId, sourceDraft)).state).toBe(
    "FREEZE_PENDING",
  );
  const altered = { ...draft, reason: "Different allegation" };
  await expect(c.providerCases.open(f.actor, f.revisionId, altered)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("dispute case permissions, originals, signing purposes and HTTP scope are independently checked", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f),
    permissions = new FederationPermissionService(db);
  const draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  await permissions.set({ ...f.actor, capability: "dispute.open", enabled: false }, f.userId);
  await expect(c.providerCases.open(f.actor, f.revisionId, draft)).rejects.toThrow("POLICY_DENIED");
  await permissions.set({ ...f.actor, capability: "dispute.open", enabled: true }, f.userId);
  await expect(c.providerCases.open(f.sourceActor, f.revisionId, draft)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  for (const patch of [
    { taskId: randomUUID() },
    { attempt: 2 },
    { agreementDigest: `sha256:${"a".repeat(64)}` },
  ])
    await expect(
      c.providerCases.open(f.actor, f.revisionId, { ...draft, ...patch }),
    ).rejects.toThrow("POLICY_DENIED");
  await expect(
    c.providerCases.draft(f.actor, f.revisionId, {
      ...c.input,
      subject: { ...c.input.subject, recordDigest: `sha256:${"f".repeat(64)}` },
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-dispute'` })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(c.providerCases.open(f.actor, f.revisionId, draft)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  const args: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.provider.signing),
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  args[23] = c.providerCases;
  const app = new Hono<{ Variables: { principal: BoundPrincipal; automation: boolean } }>();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let actor = f.actor,
    automation = false;
  app.use("*", async (ctx, next) => {
    ctx.set("principal", {
      sub: actor.userId,
      userId: actor.userId,
      orgId: actor.orgId,
      orgIds: [actor.orgId],
      role: "platform_admin",
      email: "fixture@example.invalid",
      memberships: [{ orgId: actor.orgId, role: "owner" }],
      capabilities: [],
    });
    ctx.set("automation", automation);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes`;
  const open = await app.request(`${path}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  expect(open.status).toBe(200);
  expect(open.headers.get("cache-control")).toBe("no-store");
  const response = await app.request(`${path}?caseId=${draft.caseId}`);
  expect(
    z.object({ data: CommercialDisputeListSchema }).parse(await response.json()).data.data,
  ).toHaveLength(1);
  actor = f.sourceActor;
  const other = await app.request(path);
  expect(
    z.object({ data: CommercialDisputeListSchema }).parse(await other.json()).data.data,
  ).toHaveLength(0);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("dispute opening and pending settlement reconcile original signatures without authorizing new charges", async () => {
  const f = await settlementFixture(),
    c = await disputeAccess(f);
  const both = await f.approve();
  const input = {
    ...c.input,
    subject: {
      recordType: "settlement" as const,
      recordId: both.provider.settlementId,
      recordDigest: both.provider.digest,
    },
  };
  const draft = await c.providerCases.draft(f.actor, f.revisionId, input);
  await c.providerCases.open(f.actor, f.revisionId, draft);
  expect(await f.providerSettlement.approve(f.actor, f.revisionId, f.draft)).toEqual(both.provider);
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    both.source.approvalJws,
  );
  expect(await f.budget()).toMatchObject({ available: "47", reserved: "0", spent: "53" });
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
});

test("dispute on a bill prevents new settlement while unrelated facts stay readable", async () => {
  const f = await settlementFixture(),
    c = await disputeAccess(f);
  const [bill] = await db
    .select()
    .from(federationCommercialBills)
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.provider.signing.siteId),
        eq(federationCommercialBills.billId, f.bill.billId),
      ),
    );
  if (!bill) throw new Error("Missing original bill");
  const draft = await c.providerCases.draft(f.actor, f.revisionId, {
    ...c.input,
    subject: { recordType: "bill", recordId: bill.billId, recordDigest: bill.digest },
  });
  await c.providerCases.open(f.actor, f.revisionId, draft);
  await expect(f.providerSettlement.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(await f.budget()).toMatchObject({ available: "40", reserved: "60", spent: "0" });
});

test("dispute on adjustment stops new debit holds while old signed adjustments remain recoverable", async () => {
  const f = await adjustmentServiceFixture(),
    c = await disputeAccess(f);
  const first = await f.make("40"),
    signed = await f.approveAdjustment(first);
  await f.attachAdjustment(signed);
  const draft = await c.providerCases.draft(f.actor, f.revisionId, {
    ...c.input,
    subject: {
      recordType: "adjustment",
      recordId: first.adjustmentId,
      recordDigest: signed.provider.digest,
    },
  });
  const debit = await f.make("55"),
    before = await f.budget();
  await c.providerCases.open(f.actor, f.revisionId, draft);
  await expect(f.providerAdjustment.approve(f.actor, f.revisionId, debit)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(await f.budget()).toEqual(before);
  expect((await f.providerAdjustment.approve(f.actor, f.revisionId, first)).adjustmentId).toBe(
    first.adjustmentId,
  );
});

test("dispute on an external payment preserves the ability to append factual corrections without changing funds", async () => {
  const f = await paymentFixture(),
    c = await disputeAccess(f),
    original = await f.confirm(),
    before = await f.budget();
  const draft = await c.providerCases.draft(f.actor, f.revisionId, {
    ...c.input,
    subject: { recordType: "payment", recordId: original.receiptId, recordDigest: original.digest },
  });
  await c.providerCases.open(f.actor, f.revisionId, draft);
  const correction = await f.providerPayment.draft(f.actor, f.revisionId, {
    ...f.input,
    receiptId: randomUUID(),
    amount: "0",
    reason: "Correct the external fact",
  });
  expect((await f.confirm(correction)).confirmedAt).not.toBeNull();
  expect(await f.budget()).toEqual(before);
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
});

test("dispute opening audit failure rolls back both the case and its approval freeze", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f),
    draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  await db.execute(
    sql.raw(
      "ALTER TABLE audit_log ADD CONSTRAINT dispute_audit_failure CHECK (action <> 'federation.dispute.open') NOT VALID",
    ),
  );
  try {
    await expect(c.providerCases.open(f.actor, f.revisionId, draft)).rejects.toThrow();
  } finally {
    await db.execute(sql.raw("ALTER TABLE audit_log DROP CONSTRAINT dispute_audit_failure"));
  }
  expect((await c.providerCases.list(f.actor, f.revisionId)).data).toHaveLength(0);
  expect((await f.providerBilling.approve(f.actor, f.revisionId, f.draft)).billId).toBe(
    f.draft.billId,
  );
});
test("dispute prevents institutional automatic bills and settlements without consuming approval budgets", async () => {
  const f = await closingFlowFixture(),
    c = await disputeAccess(f);
  const draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  await c.providerCases.open(f.actor, f.revisionId, draft);
  const args: ConstructorParameters<typeof FederationCommercialWorker> = [
    new FederationCommercialSubmissionService(db, f.provider.signing.siteId),
  ];
  args[13] = f.closing;
  await new FederationCommercialWorker(...args).tick();
  expect(await f.billPolicy.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
  expect(f.network.bodies).toHaveLength(0);
  expect((await f.view()).records[0]).toMatchObject({
    state: "pending",
    lastError: "DATA_WAITING",
  });
  const other = await settlementFixture(),
    d = await disputeAccess(other),
    policy = await grantClosing(other, "settlement");
  await d.providerCases.open(
    other.actor,
    other.revisionId,
    await d.providerCases.draft(other.actor, other.revisionId, d.input),
  );
  await expect(other.providerSettlement.automate(policy.policy.id, other.draft)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(await policy.read()).toMatchObject({ approvedRecords: 0, approvedAmount: "0" });
});

test("dispute freezes new concessions in attested mode without waiting for or creating ledger work", async () => {
  const f = await billingFixture("bilateral_attested"),
    c = await disputeAccess(f);
  const before = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  const draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  await c.providerCases.open(f.actor, f.revisionId, draft);
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: f.draft.billId,
    domainId: f.contract.domainId,
    agreementRevisionId: f.revisionId,
    agreementDigest: f.draft.agreementDigest,
    reportId: f.draft.reportId,
    reportDigest: f.draft.reportDigest,
    taskId: f.draft.request.taskId,
    attempt: 1,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    unit: f.draft.request.unit,
    amount: "7",
    reason: "New concession",
    issuedAt: new Date().toISOString(),
    salt: "b".repeat(64),
  });
  await expect(f.providerBilling.approveDiscount(f.actor, f.revisionId, discount)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toEqual(before);
});

test("dispute concurrent case ID claims have one immutable winner and one audit", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f),
    draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  const competing = CommercialDisputeSchema.parse({
    ...draft,
    requestedResolution: "A competing demand",
  });
  const settled = await Promise.allSettled([
    c.providerCases.open(f.actor, f.revisionId, draft),
    c.providerCases.open(f.actor, f.revisionId, competing),
  ]);
  expect(settled.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((v) => v.status === "rejected")).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "federation.dispute.open"), eq(auditLog.target, draft.caseId)),
      ),
  ).toHaveLength(1);
});

test("dispute opening and a concurrent financial approval use the same transaction lock", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f),
    draft = await c.providerCases.draft(f.actor, f.revisionId, c.input);
  const arrived = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const barrier = `dispute-audit-test:${randomUUID()}`;
  await db.execute(
    sql.raw(
      `CREATE FUNCTION dispute_audit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.dispute.open' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${barrier}',0)); END IF; RETURN NEW; END $$`,
    ),
  );
  await db.execute(
    sql.raw(
      "CREATE TRIGGER dispute_audit_barrier BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dispute_audit_barrier()",
    ),
  );
  const held = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${barrier},0))`);
    arrived.resolve();
    await release.promise;
  });
  await arrived.promise;
  const opening = c.providerCases.open(f.actor, f.revisionId, draft);
  let approval: ReturnType<typeof f.providerBilling.approve> | undefined;
  try {
    // Observe the real opening transaction waiting inside its audit write, with the task lock held.
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      const rows = await db.execute<{ waiting: boolean }>(
        sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`,
      );
      if (rows[0]?.waiting) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    let finished = false;
    approval = f.providerBilling.approve(f.actor, f.revisionId, f.draft);
    const observed = approval.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await Bun.sleep(30);
    expect(finished).toBe(false);
    release.resolve();
    await held;
    expect((await opening).state).toBe("FREEZE_PENDING");
    await expect(approval).rejects.toThrow("DATA_WAITING");
    await observed;
    // The same lock is available after both transactions finish; no orphaned transaction remains.
    await db.transaction((tx) => lockFederationDisputeTask(tx, f.provider.signing.siteId, draft));
  } finally {
    release.resolve();
    await Promise.allSettled([held, opening, ...(approval ? [approval] : [])]);
    await db.execute(sql.raw("DROP TRIGGER dispute_audit_barrier ON audit_log"));
    await db.execute(sql.raw("DROP FUNCTION dispute_audit_barrier()"));
  }
});

test("dispute rejects a correctly signed usage report that names a task different from its local reservation", async () => {
  const f = await billingFixture(),
    c = await disputeAccess(f);
  const report = CommercialUsageSchema.parse({ ...f.report.report, taskId: randomUUID() });
  const reportJws = await signFederationMessage(CommercialUsageSchema, report, f.provider.signing);
  const signed = await verifyFederationMessage(
    CommercialUsageSchema,
    reportJws,
    { ...f.provider.verification, allowedKinds: ["commercial-usage"] },
    new Date(),
  );
  await db
    .update(federationReceivedUsage)
    .set({ report, reportJws, digest: signed.digest })
    .where(
      and(
        eq(federationReceivedUsage.localSiteId, f.source.signing.siteId),
        eq(federationReceivedUsage.reportId, report.reportId),
      ),
    );
  await db
    .update(federationUsageReports)
    .set({ report, reportJws, digest: signed.digest })
    .where(eq(federationUsageReports.id, report.reportId));
  const input = { ...c.input, subject: { ...c.input.subject, recordDigest: signed.digest } };
  await expect(c.sourceCases.draft(f.sourceActor, f.revisionId, input)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await expect(c.providerCases.draft(f.actor, f.revisionId, input)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

async function disputeInboxFixture() {
  const f = await billingExchangeFixture(),
    c = await disputeAccess(f);
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-receipt"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  const draft = await c.sourceCases.draft(f.sourceActor, f.revisionId, c.input);
  const original = await c.sourceCases.open(f.sourceActor, f.revisionId, draft);
  const incoming = () => c.providerCases.receive(original.openingJws, f.fingerprint);
  const received = async () =>
    (
      await db
        .select()
        .from(federationDisputes)
        .where(
          and(
            eq(federationDisputes.localSiteId, f.provider.signing.siteId),
            eq(federationDisputes.caseId, draft.caseId),
          ),
        )
    )[0];
  return { ...f, ...c, original, caseDraft: draft, incoming, received };
}

test("dispute inbox persists one institutional receipt and freezes only new receiving-side approvals", async () => {
  const f = await disputeInboxFixture();
  const permissions = new FederationPermissionService(db);
  await permissions.set({ ...f.actor, capability: "dispute.read", enabled: true }, f.userId);
  await permissions.set({ ...f.actor, capability: "dispute.open", enabled: false }, f.userId);
  const receipts = await Promise.all([f.incoming(), f.incoming()]);
  expect(new Set(receipts).size).toBe(1);
  const receiptJws = receipts[0];
  if (!receiptJws) throw new Error("Missing receipt");
  const key = await f.trust.resolveKey(
    f.provider.signing.siteId,
    f.provider.signing.keyId,
    new Date(),
  );
  const receipt = await verifyFederationMessage(
    CommercialDisputeReceiptSchema,
    receiptJws,
    key,
    new Date(),
  );
  expect(receipt.payload).toMatchObject({
    caseId: f.caseDraft.caseId,
    caseDigest: f.original.digest,
    openingSiteId: f.source.signing.siteId,
    receivingSiteId: f.provider.signing.siteId,
  });
  const saved = await f.received();
  expect(saved).toMatchObject({
    openedBy: null,
    openingJws: f.original.openingJws,
    acceptanceJws: receiptJws,
    state: "FREEZE_PENDING",
    digest: f.original.digest,
  });
  expect(saved?.receivedAt?.toISOString()).toBe(receipt.payload.recordedAt);
  await expect(f.providerBilling.approve(f.actor, f.revisionId, f.draft)).rejects.toThrow(
    "DATA_WAITING",
  );
  const restarted = new FederationDisputeService(db, f.provider.signing);
  expect(await restarted.receive(f.original.openingJws, f.fingerprint)).toBe(receiptJws);
  expect((await restarted.list(f.actor, f.revisionId)).data).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.dispute.receive"),
          eq(auditLog.target, f.caseDraft.caseId),
        ),
      ),
  ).toHaveLength(1);
});

test("dispute inbox private HTTP rejects content type and certificate substitution and returns no-store JOSE", async () => {
  const f = await disputeInboxFixture(),
    ingress = createFederationIngress(db, f.provider.signing);
  const path = "/federation/v1/disputes";
  expect(
    (await ingress.request(path, { method: "POST", body: f.original.openingJws })).status,
  ).toBe(415);
  const request = (fingerprint: string) =>
    ingress.request(path, {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": fingerprint },
      body: f.original.openingJws,
    });
  expect((await request("unknown")).status).toBe(401);
  expect((await request(f.providerFingerprint)).status).not.toBe(200);
  expect(await f.received()).toBeUndefined();
  const response = await request(f.fingerprint);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/jose");
  expect(await response.text()).toBe((await f.received())?.acceptanceJws ?? "missing");
});

test("dispute inbox rejects forged task, sender, different case body and missing receipt authority", async () => {
  const f = await disputeInboxFixture();
  for (const patch of [{ taskId: randomUUID() }, { openingSiteId: f.provider.signing.siteId }]) {
    const jws = await signFederationMessage(
      CommercialDisputeSchema,
      { ...f.caseDraft, ...patch },
      f.source.signing,
    );
    await expect(f.providerCases.receive(jws, f.fingerprint)).rejects.toThrow();
  }
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-dispute-receipt'`,
    })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(f.incoming()).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(await f.received()).toBeUndefined();
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-receipt"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  const originalReceipt = await f.incoming();
  const changed = await signFederationMessage(
    CommercialDisputeSchema,
    { ...f.caseDraft, reason: "Different signed complaint" },
    f.source.signing,
  );
  await expect(f.providerCases.receive(changed, f.fingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(await f.incoming()).toBe(originalReceipt);
});

test("dispute inbox audit failure does not freeze the recipient or save a receipt", async () => {
  const f = await disputeInboxFixture();
  await db.execute(
    sql.raw(
      "ALTER TABLE audit_log ADD CONSTRAINT dispute_inbox_audit_failure CHECK (action <> 'federation.dispute.receive') NOT VALID",
    ),
  );
  try {
    await expect(f.incoming()).rejects.toThrow();
  } finally {
    await db.execute(sql.raw("ALTER TABLE audit_log DROP CONSTRAINT dispute_inbox_audit_failure"));
  }
  expect(await f.received()).toBeUndefined();
  expect((await f.providerBilling.approve(f.actor, f.revisionId, f.draft)).billId).toBe(
    f.draft.billId,
  );
  expect(await f.incoming()).toBe((await f.received())?.acceptanceJws ?? "missing");
});

test("dispute inbox missing local evidence waits, then resumes the same case after original approval arrives", async () => {
  const f = await billingExchangeFixture(),
    c = await disputeAccess(f);
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-receipt"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  const bill = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const draft = await c.providerCases.draft(f.actor, f.revisionId, {
    ...c.input,
    subject: { recordType: "bill", recordId: bill.billId, recordDigest: bill.digest },
  });
  const original = await c.providerCases.open(f.actor, f.revisionId, draft);
  await expect(c.sourceCases.receive(original.openingJws, f.providerFingerprint)).rejects.toThrow(
    "DATA_WAITING",
  );
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
  await f.sourceBilling.approve(f.sourceActor, f.revisionId, f.draft);
  const receipt = await c.sourceCases.receive(original.openingJws, f.providerFingerprint);
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]).toMatchObject({
    acceptanceJws: receipt,
    state: "FREEZE_PENDING",
    openedBy: null,
  });
});

test("dispute inbox certificate revocation and database origin constraints fail closed", async () => {
  const f = await disputeInboxFixture();
  await db
    .update(federationCertificates)
    .set({ revokedAt: new Date() })
    .where(eq(federationCertificates.fingerprint, f.fingerprint));
  await expect(f.incoming()).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(await f.received()).toBeUndefined();
  await db
    .update(federationCertificates)
    .set({ revokedAt: null })
    .where(eq(federationCertificates.fingerprint, f.fingerprint));
  await f.incoming();
  for (const patch of [{ openedBy: f.userId }, { acceptanceJws: null }, { receivedAt: null }])
    await expect(
      Promise.resolve(
        db
          .update(federationDisputes)
          .set(patch)
          .where(
            and(
              eq(federationDisputes.localSiteId, f.provider.signing.siteId),
              eq(federationDisputes.caseId, f.caseDraft.caseId),
            ),
          ),
      ),
    ).rejects.toThrow();
  expect((await f.received())?.openedBy).toBeNull();
});

test("dispute inbox rechecks a certificate revoked between initial verification and the write transaction", async () => {
  const f = await disputeInboxFixture();
  const resolve = f.trust.resolvePeer.bind(f.trust);
  const peer = spyOn(FederationTrustRegistry.prototype, "resolvePeer").mockImplementation(
    async (...args) => {
      const result = await resolve(...args);
      await db
        .update(federationCertificates)
        .set({ revokedAt: new Date() })
        .where(eq(federationCertificates.fingerprint, f.fingerprint));
      return result;
    },
  );
  try {
    await expect(f.incoming()).rejects.toThrow("UNTRUSTED_IDENTITY");
    expect(await f.received()).toBeUndefined();
  } finally {
    peer.mockRestore();
  }
});

async function disputeDeliveryFixture() {
  const f = await disputeInboxFixture();
  const key = and(
    eq(federationDisputeDeliveries.localSiteId, f.source.signing.siteId),
    eq(federationDisputeDeliveries.caseId, f.caseDraft.caseId),
  );
  cleanup.push(async () => {
    await db
      .delete(federationDisputeDeliveries)
      .where(
        inArray(federationDisputeDeliveries.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      );
    await db
      .delete(auditLog)
      .where(
        inArray(auditLog.actor, [
          `dispute-delivery:${f.source.signing.siteId}`,
          `dispute-delivery:${f.provider.signing.siteId}`,
        ]),
      );
  });
  const ingress = createFederationIngress(db, f.provider.signing);
  const bodies: string[] = [];
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/disputes");
    if (!path) throw new Error("Missing dispute delivery path");
    bodies.push(jws);
    const response = await ingress.request(path, {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": f.fingerprint },
      body: jws,
    });
    if (response.status !== 200)
      throw new FederationDeliveryError(
        response.status >= 500 ? "DELIVERY_UNAVAILABLE" : "INVALID_RECEIPT_RESPONSE",
      );
    return response.text();
  };
  const delivery = new FederationDisputeDelivery(db, f.source.signing, send);
  const read = async () => (await db.select().from(federationDisputeDeliveries).where(key))[0];
  const due = () =>
    db
      .update(federationDisputeDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(key);
  return { ...f, key, bodies, send, delivery, read, due };
}

test("dispute delivery survives lost response and restart without repeating case creation or financial transitions", async () => {
  const f = await disputeDeliveryFixture();
  const lost = new FederationDisputeDelivery(db, f.source.signing, async (...args) => {
    await f.send(...args);
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await lost.discover();
  await lost.advanceNext();
  expect(await f.read()).toMatchObject({
    state: "pending",
    receiptJws: null,
    lastError: "DELIVERY_UNAVAILABLE",
  });
  const received = await f.received();
  expect(received?.state).toBe("FREEZE_PENDING");
  // Institutional authority persists even if the person who opened the case loses permission.
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    f.sourceActor.userId,
  );
  await f.due();
  const args: ConstructorParameters<typeof FederationCommercialWorker> = [
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
  ];
  args[15] = new FederationDisputeDelivery(db, f.source.signing, f.send);
  await new FederationCommercialWorker(...args).tick();
  expect(await f.read()).toMatchObject({
    state: "received",
    receiptJws: received?.acceptanceJws,
    leaseToken: null,
    lastError: null,
  });
  expect(f.bodies).toEqual([f.original.openingJws, f.original.openingJws]);
  expect(await f.received()).toEqual(received);
  expect(
    (
      await db
        .select()
        .from(federationDisputes)
        .where(eq(federationDisputes.caseId, f.caseDraft.caseId))
    ).map((r) => r.state),
  ).toEqual(["FREEZE_PENDING", "FREEZE_PENDING"]);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.caseDraft.caseId),
          eq(auditLog.action, "federation.dispute.delivered"),
        ),
      ),
  ).toHaveLength(1);
  const peerDelivery = new FederationDisputeDelivery(db, f.provider.signing, f.send);
  await peerDelivery.discover();
  expect(await peerDelivery.advanceNext()).toBe(false);
});

test("dispute delivery concurrent workers share one lease and an expired late response cannot overwrite recovery", async () => {
  const f = await disputeDeliveryFixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const slow = new FederationDisputeDelivery(db, f.source.signing, async (...args) => {
    const receipt = await f.send(...args);
    entered.resolve();
    await release.promise;
    return receipt;
  });
  await slow.discover();
  const pending = slow.advanceNext();
  try {
    await entered.promise;
    expect(await f.delivery.advanceNext()).toBe(false);
    await expect(f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await db
      .update(federationDisputeDeliveries)
      .set({ leaseUntil: new Date(0) })
      .where(f.key);
    expect(await f.delivery.advanceNext()).toBe(true);
    const recovered = await f.read();
    expect(recovered?.state).toBe("received");
    release.resolve();
    await pending;
    expect(await f.read()).toEqual(recovered);
    expect(f.bodies).toEqual([f.original.openingJws, f.original.openingJws]);
  } finally {
    release.resolve();
    await pending;
  }
});

test("dispute delivery rejects receipts with wrong identities, digest, case or time and refuses missing receipt authority", async () => {
  const f = await disputeDeliveryFixture();
  const receipt = CommercialDisputeReceiptSchema.parse({
    protocolVersion: 1,
    kind: "commercial-dispute-receipt",
    caseId: f.caseDraft.caseId,
    caseDigest: f.original.digest,
    openingSiteId: f.source.signing.siteId,
    receivingSiteId: f.provider.signing.siteId,
    recordedAt: new Date().toISOString(),
  });
  await f.delivery.discover();
  for (const patch of [
    { caseId: randomUUID() },
    { caseDigest: `sha256:${"f".repeat(64)}` },
    { openingSiteId: randomUUID() },
    { receivingSiteId: randomUUID() },
    { recordedAt: new Date(0).toISOString() },
    { recordedAt: new Date(Date.now() + 120000).toISOString() },
  ]) {
    await f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId);
    const service = new FederationDisputeDelivery(db, f.source.signing, async () =>
      signFederationMessage(
        CommercialDisputeReceiptSchema,
        { ...receipt, ...patch },
        f.provider.signing,
      ),
    );
    await service.advanceNext();
    expect(await f.read()).toMatchObject({
      state: "needs_review",
      receiptJws: null,
      lastError: "OPERATION_CONFLICT",
    });
  }
  await f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId);
  const service = new FederationDisputeDelivery(db, f.source.signing, async () => {
    const jws = await signFederationMessage(
      CommercialDisputeReceiptSchema,
      receipt,
      f.provider.signing,
    );
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-dispute-receipt'`,
      })
      .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
    return jws;
  });
  await service.advanceNext();
  expect(await f.read()).toMatchObject({
    state: "needs_review",
    receiptJws: null,
    lastError: "UNTRUSTED_IDENTITY",
  });
});

test("dispute delivery rechecks endpoint and signing-key revocation after network I/O", async () => {
  for (const change of ["endpoint", "key"] as const) {
    const f = await disputeDeliveryFixture();
    const service = new FederationDisputeDelivery(db, f.source.signing, async (...args) => {
      const jws = await f.send(...args);
      if (change === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.example.invalid" })
          .where(eq(federationSites.id, f.provider.signing.siteId));
      else
        await db
          .update(federationSigningKeys)
          .set({ revokedAt: new Date() })
          .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
      return jws;
    });
    await service.discover();
    await service.advanceNext();
    expect(await f.read()).toMatchObject({
      state: "needs_review",
      receiptJws: null,
      lastError: "UNTRUSTED_IDENTITY",
    });
    expect((await f.received())?.acceptanceJws).toBeTruthy();
  }
});

test("dispute delivery audit failure rolls back the saved receipt and recovers the peer's original receipt", async () => {
  const f = await disputeDeliveryFixture();
  await f.delivery.discover();
  await db.execute(
    sql.raw(
      "ALTER TABLE audit_log ADD CONSTRAINT dispute_delivery_audit_failure CHECK (action <> 'federation.dispute.delivered') NOT VALID",
    ),
  );
  try {
    await f.delivery.advanceNext();
  } finally {
    await db.execute(
      sql.raw("ALTER TABLE audit_log DROP CONSTRAINT dispute_delivery_audit_failure"),
    );
  }
  expect(await f.read()).toMatchObject({
    state: "pending",
    receiptJws: null,
    acknowledgedAt: null,
    lastError: "DELIVERY_RETRY",
  });
  const receipt = (await f.received())?.acceptanceJws;
  await f.due();
  await f.delivery.advanceNext();
  expect(await f.read()).toMatchObject({ state: "received", receiptJws: receipt });
  await expect(f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  for (const patch of [
    { receiptJws: null },
    { acknowledgedAt: null },
    { state: "pending" },
    { leaseToken: randomUUID(), leaseUntil: new Date() },
  ])
    await expect(
      Promise.resolve(db.update(federationDisputeDeliveries).set(patch).where(f.key)),
    ).rejects.toThrow();
});

test("dispute delivery missing remote original returns retryable HTTP and later resumes", async () => {
  const f = await disputeDeliveryFixture();
  const [report] = await db
    .delete(federationUsageReports)
    .where(eq(federationUsageReports.id, f.report.reportId))
    .returning();
  if (!report) throw new Error("Missing usage fixture");
  await f.delivery.discover();
  const ingress = createFederationIngress(db, f.provider.signing);
  const response = await ingress.request("/federation/v1/disputes", {
    method: "POST",
    headers: { "content-type": "application/jose", "x-kq-federation-cert": f.fingerprint },
    body: f.original.openingJws,
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "DATA_WAITING" } });
  await f.delivery.advanceNext();
  expect(await f.read()).toMatchObject({ state: "pending", lastError: "DELIVERY_UNAVAILABLE" });
  await db.insert(federationUsageReports).values(report);
  await f.due();
  await f.delivery.advanceNext();
  expect((await f.read())?.state).toBe("received");
});

test("dispute delivery no transport leaves discovery idle and exposes no signature or internal lease", async () => {
  const f = await disputeDeliveryFixture(),
    disabled = new FederationDisputeDelivery(db, f.source.signing);
  await disabled.discover();
  expect(await disabled.advanceNext()).toBe(false);
  expect(await disabled.status(f.sourceActor, f.revisionId, f.caseDraft.caseId)).toEqual({
    enabled: false,
    sync: null,
  });
  await expect(disabled.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "ASSET_UNAVAILABLE",
  );
  await f.delivery.discover();
  await expect(f.delivery.status(f.actor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.delivery.retry(f.actor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.delivery.status(f.sourceActor, randomUUID(), f.caseDraft.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.read", enabled: true },
    f.sourceActor.userId,
  );
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    f.sourceActor.userId,
  );
  const status = await f.delivery.status(f.sourceActor, f.revisionId, f.caseDraft.caseId);
  expect(Object.keys(status.sync ?? {}).sort()).toEqual([
    "acknowledgedAt",
    "lastError",
    "nextAttemptAt",
    "state",
  ]);
  await expect(f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.read", enabled: false },
    f.sourceActor.userId,
  );
  await expect(f.delivery.status(f.sourceActor, f.revisionId, f.caseDraft.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("dispute delivery human routes retain case scope, strict retry input and read-only permission", async () => {
  const f = await disputeDeliveryFixture();
  await f.delivery.discover();
  const args: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.source.signing),
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
  ];
  args[24] = f.delivery;
  const app = new Hono<{ Variables: { principal: BoundPrincipal; automation: boolean } }>();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let actor = f.sourceActor,
    automation = false;
  app.use("*", async (ctx, next) => {
    ctx.set("principal", {
      sub: actor.userId,
      userId: actor.userId,
      orgId: actor.orgId,
      orgIds: [actor.orgId],
      role: "platform_admin",
      email: "fixture@example.invalid",
      memberships: [{ orgId: actor.orgId, role: "owner" }],
      capabilities: [],
    });
    ctx.set("automation", automation);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes/${f.caseDraft.caseId}/delivery`;
  const retry = (body = "{}") =>
    app.request(`${path}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const view = await app.request(path);
  expect(view.status).toBe(200);
  expect(view.headers.get("cache-control")).toBe("no-store");
  expect((await retry('{"state":"received"}')).status).toBe(400);
  expect((await retry()).status).toBe(200);
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "dispute.read", enabled: true },
    actor.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    actor.userId,
  );
  expect((await retry()).status).toBe(403);
  expect((await app.request(path)).status).toBe(200);
  actor = f.actor;
  expect((await app.request(path)).status).toBe(403);
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("dispute delivery validates the original before sending and rejects a replaced source after sending", async () => {
  const f = await disputeDeliveryFixture();
  const caseKey = and(
    eq(federationDisputes.localSiteId, f.source.signing.siteId),
    eq(federationDisputes.caseId, f.caseDraft.caseId),
  );
  await f.delivery.discover();
  await db
    .update(federationDisputes)
    .set({ payload: { ...f.caseDraft, reason: "Unsigned replacement" } })
    .where(caseKey);
  await f.delivery.advanceNext();
  expect(f.bodies).toHaveLength(0);
  expect(await f.read()).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    receiptJws: null,
  });
  await db.update(federationDisputes).set({ payload: f.caseDraft }).where(caseKey);
  await f.delivery.retry(f.sourceActor, f.revisionId, f.caseDraft.caseId);
  const changed = { ...f.caseDraft, reason: "A separately signed replacement" };
  const changedJws = await signFederationMessage(
    CommercialDisputeSchema,
    changed,
    f.source.signing,
  );
  const changedSigned = await verifyFederationMessage(
    CommercialDisputeSchema,
    changedJws,
    await f.trust.resolveKey(f.source.signing.siteId, f.source.signing.keyId, new Date()),
    new Date(),
  );
  const replacing = new FederationDisputeDelivery(db, f.source.signing, async (...args) => {
    const receipt = await f.send(...args);
    await db
      .update(federationDisputes)
      .set({ payload: changed, openingJws: changedJws, digest: changedSigned.digest })
      .where(caseKey);
    return receipt;
  });
  await replacing.advanceNext();
  expect(await f.read()).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    receiptJws: null,
  });
  expect((await f.received())?.digest).toBe(f.original.digest);
});

async function financialDispute(
  f: Parameters<typeof disputeAccess>[0] &
    Pick<Awaited<ReturnType<typeof billingExchangeFixture>>, "revisionId" | "fingerprint">,
  subject?: z.infer<typeof CommercialDisputeSchema>["subject"],
) {
  const c = await disputeAccess(f);
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-receipt"]'::jsonb`,
    })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  const draft = await c.sourceCases.draft(f.sourceActor, f.revisionId, {
    ...c.input,
    subject: subject ?? c.input.subject,
  });
  const original = await c.sourceCases.open(f.sourceActor, f.revisionId, draft);
  await c.providerCases.receive(original.openingJws, f.fingerprint);
  return {
    ...c,
    original,
    sourceView: () => c.sourceCases.financialView(f.sourceActor, f.revisionId, draft.caseId),
    providerView: () => c.providerCases.financialView(f.actor, f.revisionId, draft.caseId),
  };
}

test("dispute financial view compares empty local commitments without claiming bilateral freeze", async () => {
  const f = await billingExchangeFixture(),
    c = await financialDispute(f);
  const a = await c.sourceView(),
    b = await c.providerView();
  expect(a).toMatchObject({ localReady: true, records: [], requiresLedgerFreeze: false });
  expect(a.headDigest).toBe(b.headDigest);
  expect(a.headDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe(
    "FREEZE_PENDING",
  );
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
  expect(await c.sourceView()).toMatchObject({ headDigest: a.headDigest });
});

test("dispute financial view tracks original in-flight signatures and applications on both sites", async () => {
  const f = await settlementFixture(),
    approvals = await f.approve(),
    c = await financialDispute(f);
  const before = await c.sourceView();
  expect(before).toMatchObject({ localReady: false, headDigest: null });
  expect(before.records).toContainEqual({
    recordType: "settlement",
    recordId: f.draft.settlementId,
    recordDigest: approvals.source.digest,
    state: "counterparty_waiting",
  });
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    approvals.source.approvalJws,
  );
  expect((await c.providerView()).localReady).toBe(true);
  expect((await c.sourceView()).localReady).toBe(false);
  await f.sourceSettlement.attachCounterparty(
    f.sourceActor,
    f.revisionId,
    f.draft.settlementId,
    approvals.provider.approvalJws,
  );
  const a = await c.sourceView(),
    b = await c.providerView();
  expect(a.localReady).toBe(true);
  expect(a.headDigest).toBe(b.headDigest);
  const key = and(
    eq(federationCommercialSettlements.localSiteId, f.source.signing.siteId),
    eq(federationCommercialSettlements.settlementId, f.draft.settlementId),
  );
  const [saved] = await db
    .update(federationCommercialSettlements)
    .set({ appliedAt: null })
    .where(key)
    .returning();
  expect(saved?.counterpartyJws).toBeTruthy();
  expect((await c.sourceView()).records.find((r) => r.recordType === "settlement")?.state).toBe(
    "application_waiting",
  );
  expect((await c.sourceView()).headDigest).toBeNull();
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe(
    "FREEZE_PENDING",
  );
});

test("dispute financial view includes every adjustment and waits for held debit completion", async () => {
  const f = await adjustmentServiceFixture();
  const first = await f.approveAdjustment(await f.make("40"));
  await f.attachAdjustment(first);
  const second = await f.approveAdjustment(await f.make("55"));
  const c = await financialDispute(f),
    budgetBefore = await f.budget();
  const before = await c.providerView();
  expect(before.records.filter((r) => r.recordType === "adjustment")).toHaveLength(2);
  expect(before.localReady).toBe(false);
  expect(before.headDigest).toBeNull();
  expect(await f.budget()).toEqual(budgetBefore);
  expect((await f.sourceProjection())?.adjustmentHeldAmount).toBe("15");
  await f.attachAdjustment(second);
  const ready = await c.providerView();
  expect(ready.localReady).toBe(true);
  expect(ready.headDigest).toBe((await c.sourceView()).headDigest);
  expect((await f.sourceProjection())?.adjustmentHeldAmount).toBe("0");
  expect(ready.records.map((r) => r.recordId)).toContain(first.provider.adjustmentId);
  const key = and(
    eq(federationCommercialAdjustments.localSiteId, f.provider.signing.siteId),
    eq(federationCommercialAdjustments.adjustmentId, second.provider.adjustmentId),
  );
  await db.update(federationCommercialAdjustments).set({ number: 3 }).where(key);
  await expect(c.providerView()).rejects.toThrow("OPERATION_CONFLICT");
});

test("dispute financial view in attested mode does not wait for evidence-only ledger submissions", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    c = await financialDispute(f);
  const pending = await db
    .select()
    .from(federationCommercialSubmissions)
    .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
  expect(pending.some((r) => r.state === "pending")).toBe(true);
  const a = await c.sourceView(),
    b = await c.providerView();
  expect(a.mode).toBe("bilateral_attested");
  expect(a.localReady).toBe(true);
  expect(a.requiresLedgerFreeze).toBe(false);
  expect(a.headDigest).toBe(b.headDigest);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
  ).toEqual(pending);
});

test("dispute financial view revalidates signatures and task scope instead of trusting ready columns", async () => {
  const f = await billingExchangeFixture();
  const approved = await f.providerBilling.approve(f.actor, f.revisionId, f.draft);
  const c = await financialDispute(f);
  const key = and(
    eq(federationCommercialBills.localSiteId, f.provider.signing.siteId),
    eq(federationCommercialBills.billId, approved.billId),
  );
  await db
    .update(federationCommercialBills)
    .set({ payload: { ...approved.payload, domainId: randomUUID() } })
    .where(key);
  await expect(c.providerView()).rejects.toThrow("OPERATION_CONFLICT");
  const replaced = { ...approved.payload, domainId: randomUUID() };
  const jws = await signFederationMessage(CommercialBillSchema, replaced, f.provider.signing);
  const signed = await verifyFederationMessage(
    CommercialBillSchema,
    jws,
    await f.trust.resolveKey(f.provider.signing.siteId, f.provider.signing.keyId, new Date()),
    new Date(),
  );
  await db
    .update(federationCommercialBills)
    .set({ payload: replaced, approvalJws: jws, digest: signed.digest })
    .where(key);
  await expect(c.providerView()).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationCommercialBills)
    .set({ payload: approved.payload, approvalJws: approved.approvalJws, digest: approved.digest })
    .where(key);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-bill'` })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(c.providerView()).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("dispute financial view is scoped to the case with no original prices, amounts, signatures or approval rights", async () => {
  const f = await settlementFixture(),
    c = await financialDispute(f);
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.read", enabled: true },
    f.sourceActor.userId,
  );
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    f.sourceActor.userId,
  );
  await permissions.set(
    { ...f.sourceActor, capability: "agreement.approve", enabled: false },
    f.sourceActor.userId,
  );
  const args: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.source.signing),
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
  ];
  args[23] = c.sourceCases;
  const app = new Hono<{ Variables: { principal: BoundPrincipal; automation: boolean } }>();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let actor = f.sourceActor,
    automation = false;
  app.use("*", async (ctx, next) => {
    ctx.set("principal", {
      sub: actor.userId,
      userId: actor.userId,
      orgId: actor.orgId,
      orgIds: [actor.orgId],
      role: "platform_admin",
      email: "fixture@example.invalid",
      memberships: [{ orgId: actor.orgId, role: "owner" }],
      capabilities: [],
    });
    ctx.set("automation", automation);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes/${c.original.caseId}/financial-view`;
  const response = await app.request(path),
    text = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(CommercialDisputeFinancialViewSchema.parse(JSON.parse(text).data).records).toHaveLength(1);
  for (const field of [
    "approvalJws",
    "payload",
    "prices",
    "chargedAmount",
    "dueAmount",
    "openedBy",
    "leaseToken",
  ])
    expect(text).not.toContain(field);
  await expect(
    c.sourceCases.financialView(f.sourceActor, randomUUID(), c.original.caseId),
  ).rejects.toThrow("POLICY_DENIED");
  actor = f.actor;
  expect((await app.request(path)).status).toBe(403);
  actor = f.sourceActor;
  automation = true;
  expect((await app.request(path)).status).toBe(403);
  automation = false;
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.read", enabled: false },
    f.sourceActor.userId,
  );
  expect((await app.request(path)).status).toBe(403);
});

test("dispute financial view includes pending refunds and validates their signed cancellation binding", async () => {
  const f = await billingExchangeFixture(),
    c = await financialDispute(f);
  cleanup.push(async () => {
    await db
      .delete(federationCommercialRefunds)
      .where(eq(federationCommercialRefunds.localSiteId, f.source.signing.siteId));
  });
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-refund", "cancellation-receipt"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  const request = f.draft.request,
    now = new Date().toISOString();
  const [operation] = await db
    .select()
    .from(federationOutbound)
    .where(
      and(
        eq(federationOutbound.localSiteId, f.source.signing.siteId),
        eq(federationOutbound.operationId, request.operationId),
      ),
    );
  if (!operation) throw new Error("Missing source request original");
  const receipt = FederationCancellationReceiptSchema.parse({
    protocolVersion: 1,
    kind: "cancellation-receipt",
    operationId: request.operationId,
    senderSiteId: request.recipientSiteId,
    recipientSiteId: request.senderSiteId,
    agreementRevisionId: f.revisionId,
    taskId: request.taskId,
    attempt: request.attempt,
    requestDigest: operation.requestDigest,
    cancellationDigest: `sha256:${"a".repeat(64)}`,
    recordedAt: now,
    observedAt: now,
    reservationId: f.reservationId,
    state: "stopped",
    workflow: null,
  });
  const cancellationReceiptJws = await signFederationMessage(
    FederationCancellationReceiptSchema,
    receipt,
    f.provider.signing,
  );
  // Stored-original fixture: this exercises observation, not execution cancellation or refund approval.
  const value = CommercialRefundSchema.parse({
    protocolVersion: 1,
    kind: "commercial-refund",
    refundId: randomUUID(),
    domainId: f.contract.domainId,
    agreementDigest: f.draft.agreementDigest,
    request,
    requestDigest: operation.requestDigest,
    cancellationReceiptJws,
    releasedAmount: request.maxAmount,
    issuedAt: new Date().toISOString(),
    salt: "c".repeat(64),
    reason: "Prior signed release",
  });
  const approvalJws = await signFederationMessage(CommercialRefundSchema, value, f.source.signing);
  const own = await f.trust.resolveKey(f.source.signing.siteId, f.source.signing.keyId, new Date());
  const signed = await verifyFederationMessage(
    CommercialRefundSchema,
    approvalJws,
    own,
    new Date(),
  );
  const key = and(
    eq(federationCommercialRefunds.localSiteId, f.source.signing.siteId),
    eq(federationCommercialRefunds.refundId, value.refundId),
  );
  await db.insert(federationCommercialRefunds).values({
    localSiteId: f.source.signing.siteId,
    localOrgId: f.sourceActor.orgId,
    refundId: value.refundId,
    agreementRevisionId: f.revisionId,
    operationId: request.operationId,
    payload: value,
    digest: signed.digest,
    approvalJws,
    approvedBy: f.sourceActor.userId,
  });
  expect((await c.sourceView()).records).toEqual([
    {
      recordType: "refund",
      recordId: value.refundId,
      recordDigest: signed.digest,
      state: "counterparty_waiting",
    },
  ]);
  const counterpartyJws = await signFederationMessage(
    CommercialRefundSchema,
    value,
    f.provider.signing,
  );
  await db.update(federationCommercialRefunds).set({ counterpartyJws }).where(key);
  expect((await c.sourceView()).records[0]?.state).toBe("application_waiting");
  expect((await c.sourceView()).headDigest).toBeNull();
  const wrongReceipt = await signFederationMessage(
    FederationCancellationReceiptSchema,
    { ...receipt, taskId: randomUUID() },
    f.provider.signing,
  );
  const changed = { ...value, cancellationReceiptJws: wrongReceipt };
  const changedJws = await signFederationMessage(CommercialRefundSchema, changed, f.source.signing);
  const changedSigned = await verifyFederationMessage(
    CommercialRefundSchema,
    changedJws,
    own,
    new Date(),
  );
  await db
    .update(federationCommercialRefunds)
    .set({
      payload: changed,
      digest: changedSigned.digest,
      approvalJws: changedJws,
      counterpartyJws: null,
    })
    .where(key);
  await expect(c.sourceView()).rejects.toThrow("POLICY_DENIED");
});

test("dispute financial view keeps one database snapshot while an original settlement finishes", async () => {
  const f = await settlementFixture(),
    approved = await f.approve(),
    c = await financialDispute(f);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = f.trust.resolveKey.bind(f.trust);
  let pause = true;
  const resolve = spyOn(FederationTrustRegistry.prototype, "resolveKey").mockImplementation(
    async (...args) => {
      const result = await original(...args);
      if (pause && args[3]) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  );
  const observing = c.providerView();
  try {
    await entered.promise;
    await f.providerSettlement.attachCounterparty(
      f.actor,
      f.revisionId,
      f.draft.settlementId,
      approved.source.approvalJws,
    );
    release.resolve();
    const snapshot = await observing;
    expect(snapshot.localReady).toBe(false);
    expect(snapshot.records.find((r) => r.recordType === "settlement")?.state).toBe(
      "counterparty_waiting",
    );
    expect((await c.providerView()).localReady).toBe(true);
    expect((await c.sourceView()).localReady).toBe(false);
  } finally {
    release.resolve();
    await observing;
    resolve.mockRestore();
  }
});

async function freezeFixture(
  f: Parameters<typeof financialDispute>[0],
  subject?: z.infer<typeof CommercialDisputeSchema>["subject"],
  clients?: { source: CommercialClient; target: CommercialClient },
) {
  const c = await financialDispute(f, subject);
  for (const siteId of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-freeze"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, siteId));
  cleanup.push(async () => {
    const ids = [f.source.signing.siteId, f.provider.signing.siteId];
    await db
      .delete(federationDisputeFreezes)
      .where(inArray(federationDisputeFreezes.localSiteId, ids));
    await db
      .delete(federationDisputeDeliveries)
      .where(inArray(federationDisputeDeliveries.localSiteId, ids));
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        ids.flatMap((id) => [`dispute-freeze:${id}`, `dispute-delivery:${id}`]),
      ),
    );
  });
  const delivery = new FederationDisputeDelivery(db, f.source.signing, async (_endpoint, jws) =>
    c.providerCases.receive(jws, f.fingerprint),
  );
  await delivery.discover();
  await delivery.advanceNext();
  const ingress = createFederationIngress(
      db,
      f.provider.signing,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      clients?.target,
    ),
    bodies: string[] = [];
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/dispute-freezes");
    if (!path) throw new Error("Missing freeze path");
    bodies.push(jws);
    const response = await ingress.request(path, {
      method: "POST",
      headers: { "content-type": "application/jose", "x-kq-federation-cert": f.fingerprint },
      body: jws,
    });
    if (response.status !== 200)
      throw new FederationDeliveryError(
        response.status >= 500 ? "DELIVERY_UNAVAILABLE" : "INVALID_RECEIPT_RESPONSE",
      );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/jose");
    return response.text();
  };
  const freeze = new FederationDisputeFreezeExchange(db, f.source.signing, send, clients?.source);
  const receiver = new FederationDisputeFreezeExchange(
    db,
    f.provider.signing,
    undefined,
    clients?.target,
  );
  const key = and(
    eq(federationDisputeFreezes.localSiteId, f.source.signing.siteId),
    eq(federationDisputeFreezes.caseId, c.original.caseId),
  );
  const read = async (siteId = f.source.signing.siteId) =>
    (
      await db
        .select()
        .from(federationDisputeFreezes)
        .where(
          and(
            eq(federationDisputeFreezes.localSiteId, siteId),
            eq(federationDisputeFreezes.caseId, c.original.caseId),
          ),
        )
    )[0];
  const due = () =>
    db
      .update(federationDisputeFreezes)
      .set({ nextAttemptAt: new Date(0) })
      .where(key);
  const advance = async () => {
    await freeze.discover();
    return freeze.advanceNext();
  };
  return { ...c, freeze, receiver, key, read, due, advance, send, bodies, ingress };
}

test("dispute freeze automatically confirms one settled head in direct and attested modes without changing funds", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await adjustmentServiceFixture(mode),
      c = await freezeFixture(f);
    const budget = await f.budget(),
      submissions = await db
        .select()
        .from(federationCommercialSubmissions)
        .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId));
    await new FederationPermissionService(db).set(
      { ...f.sourceActor, capability: "dispute.open", enabled: false },
      f.sourceActor.userId,
    );
    const args: ConstructorParameters<typeof FederationCommercialWorker> = [
      new FederationCommercialSubmissionService(db, f.source.signing.siteId),
    ];
    args[16] = c.freeze;
    await new FederationCommercialWorker(...args).tick();
    const source = await c.read(),
      target = await c.read(f.provider.signing.siteId);
    expect(source?.state).toBe("confirmed");
    expect(target?.state).toBe("confirmed");
    expect(source?.digest).toBe(target?.digest);
    expect(source?.approvalJws).toBe(target?.counterpartyJws);
    expect(source?.counterpartyJws).toBe(target?.approvalJws);
    expect(source?.financialView?.records).toEqual(target?.financialView?.records);
    expect(await f.budget()).toEqual(budget);
    expect(
      await db
        .select()
        .from(federationCommercialSubmissions)
        .where(eq(federationCommercialSubmissions.localSiteId, f.provider.signing.siteId)),
    ).toEqual(submissions);
    expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("DISPUTED");
    await expect(
      f.providerAdjustment.approve(f.actor, f.revisionId, await f.make("40")),
    ).rejects.toThrow("DATA_WAITING");
    expect(await c.receiver.advanceNext()).toBe(false);
  }
});

test("dispute freeze waits for both original applications and reuses its first proposal", async () => {
  const f = await settlementFixture(),
    approved = await f.approve(),
    c = await freezeFixture(f);
  await c.advance();
  expect(await c.read()).toMatchObject({
    state: "pending",
    lastError: "DATA_WAITING",
    approvalJws: null,
  });
  expect(c.bodies).toHaveLength(0);
  await f.sourceSettlement.attachCounterparty(
    f.sourceActor,
    f.revisionId,
    f.draft.settlementId,
    approved.provider.approvalJws,
  );
  await c.due();
  await c.advance();
  const pending = await c.read();
  expect(pending).toMatchObject({ state: "pending", lastError: "DELIVERY_UNAVAILABLE" });
  expect(pending?.approvalJws).toBeTruthy();
  expect(await c.read(f.provider.signing.siteId)).toBeUndefined();
  await f.providerSettlement.attachCounterparty(
    f.actor,
    f.revisionId,
    f.draft.settlementId,
    approved.source.approvalJws,
  );
  await c.due();
  await c.advance();
  expect(await c.read()).toMatchObject({ state: "confirmed", approvalJws: pending?.approvalJws });
  if (!pending?.approvalJws) throw new Error("Missing original freeze proposal");
  expect(c.bodies).toEqual([pending.approvalJws, pending.approvalJws]);
});

test("dispute freeze lost response recovers after service restart and preserves a later recipient case state", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const lost = new FederationDisputeFreezeExchange(db, f.source.signing, async (...args) => {
    await c.send(...args);
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await lost.discover();
  await lost.advanceNext();
  const first = await c.read(),
    received = await c.read(f.provider.signing.siteId);
  expect(first?.state).toBe("pending");
  expect(received?.state).toBe("confirmed");
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe(
    "FREEZE_PENDING",
  );
  await db
    .update(federationDisputes)
    .set({ state: "EVIDENCE_WAITING" })
    .where(
      and(
        eq(federationDisputes.localSiteId, f.provider.signing.siteId),
        eq(federationDisputes.caseId, c.original.caseId),
      ),
    );
  await c.due();
  const restarted = new FederationDisputeFreezeExchange(db, f.source.signing, c.send);
  await restarted.discover();
  await restarted.advanceNext();
  expect(await c.read()).toMatchObject({
    state: "confirmed",
    approvalJws: first?.approvalJws,
    counterpartyJws: received?.approvalJws,
  });
  if (!first?.approvalJws) throw new Error("Missing original freeze proposal");
  expect(c.bodies).toEqual([first.approvalJws, first.approvalJws]);
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe(
    "EVIDENCE_WAITING",
  );
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, c.original.caseId),
          eq(auditLog.action, "federation.dispute.freeze_confirm"),
        ),
      ),
  ).toHaveLength(2);
});

test("dispute freeze rejects another head, purpose or certificate without confirming the receiver", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const offline = new FederationDisputeFreezeExchange(db, f.source.signing, async () => {
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await offline.discover();
  await offline.advanceNext();
  const original = await c.read();
  if (!original?.payload || !original.approvalJws) throw new Error("Missing proposal");
  for (const patch of [
    { headDigest: `sha256:${"a".repeat(64)}` },
    { taskId: randomUUID() },
    { caseDigest: `sha256:${"b".repeat(64)}` },
    { issuedAt: new Date(0).toISOString() },
  ]) {
    const forged = await signFederationMessage(
      CommercialDisputeFreezeSchema,
      { ...original.payload, ...patch },
      f.source.signing,
    );
    await expect(c.receiver.receive(forged, f.fingerprint)).rejects.toThrow();
  }
  await expect(c.receiver.receive(original.approvalJws, "unknown")).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-dispute-freeze'` })
    .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
  await expect(c.receiver.receive(original.approvalJws, f.fingerprint)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  expect(await c.read(f.provider.signing.siteId)).toBeUndefined();
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
  expect(
    (
      await c.ingress.request("/federation/v1/dispute-freezes", {
        method: "POST",
        body: original.approvalJws,
      })
    ).status,
  ).toBe(415);
});

test("dispute freeze audit failures roll back state and recover the original peer proof", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  await c.freeze.discover();
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT freeze_audit_failure CHECK (action <> 'federation.dispute.freeze_confirm' OR actor <> 'dispute-freeze:${f.provider.signing.siteId}') NOT VALID`,
    ),
  );
  try {
    await c.freeze.advanceNext();
  } finally {
    await db.execute(sql.raw("ALTER TABLE audit_log DROP CONSTRAINT freeze_audit_failure"));
  }
  expect(await c.read(f.provider.signing.siteId)).toBeUndefined();
  expect((await c.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
  const original = await c.read();
  await c.due();
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT freeze_audit_failure CHECK (action <> 'federation.dispute.freeze_confirm' OR actor <> 'dispute-freeze:${f.source.signing.siteId}') NOT VALID`,
    ),
  );
  try {
    await c.freeze.advanceNext();
  } finally {
    await db.execute(sql.raw("ALTER TABLE audit_log DROP CONSTRAINT freeze_audit_failure"));
  }
  expect(await c.read()).toMatchObject({
    state: "pending",
    counterpartyJws: null,
    confirmedAt: null,
    approvalJws: original?.approvalJws,
  });
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe(
    "FREEZE_PENDING",
  );
  expect((await c.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  await c.due();
  await c.freeze.advanceNext();
  expect(await c.read()).toMatchObject({ state: "confirmed", approvalJws: original?.approvalJws });
});

test("dispute freeze fences concurrent workers and ignores the expired worker's late response", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const slow = new FederationDisputeFreezeExchange(db, f.source.signing, async (...args) => {
    const response = await c.send(...args);
    entered.resolve();
    await release.promise;
    return response;
  });
  await slow.discover();
  const pending = slow.advanceNext();
  try {
    await entered.promise;
    expect(await c.freeze.advanceNext()).toBe(false);
    await expect(c.freeze.retry(f.sourceActor, f.revisionId, c.original.caseId)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await db
      .update(federationDisputeFreezes)
      .set({ leaseUntil: new Date(0) })
      .where(c.key);
    expect(await c.freeze.advanceNext()).toBe(true);
    const complete = await c.read();
    expect(complete?.state).toBe("confirmed");
    release.resolve();
    await pending;
    expect(await c.read()).toEqual(complete);
  } finally {
    release.resolve();
    await pending;
  }
});

test("dispute freeze rechecks changed endpoint and revoked signing authority after the network response", async () => {
  for (const change of ["endpoint", "key"] as const) {
    const f = await billingExchangeFixture(),
      c = await freezeFixture(f);
    const service = new FederationDisputeFreezeExchange(db, f.source.signing, async (...args) => {
      const response = await c.send(...args);
      if (change === "endpoint")
        await db
          .update(federationSites)
          .set({ endpoint: "https://changed.example.invalid" })
          .where(eq(federationSites.id, f.provider.signing.siteId));
      else
        await db
          .update(federationSigningKeys)
          .set({ revokedAt: new Date() })
          .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
      return response;
    });
    await service.discover();
    await service.advanceNext();
    expect(await c.read()).toMatchObject({
      state: "needs_review",
      lastError: "UNTRUSTED_IDENTITY",
      counterpartyJws: null,
    });
    expect((await c.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  }
});

test("dispute freeze refuses native-ledger downgrade and partial or rewritten proof storage", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const helper = new FederationDisputeService(db, f.source.signing),
    snapshot = helper.financialSnapshot.bind(helper);
  const observe = spyOn(FederationDisputeService.prototype, "financialSnapshot").mockImplementation(
    async (...args) => {
      const current = await snapshot(...args);
      return {
        ...current,
        view: { ...current.view, mode: "ledger_coordinated" as const, requiresLedgerFreeze: true },
      };
    },
  );
  try {
    await c.advance();
  } finally {
    observe.mockRestore();
  }
  expect(await c.read()).toMatchObject({
    state: "pending",
    lastError: "DATA_WAITING",
    approvalJws: null,
  });
  expect(c.bodies).toHaveLength(0);
  await c.freeze.retry(f.sourceActor, f.revisionId, c.original.caseId);
  await c.freeze.advanceNext();
  const complete = await c.read();
  if (!complete?.payload) throw new Error("Missing confirmed proof");
  for (const patch of [
    { approvalJws: null },
    { counterpartyJws: null },
    { confirmedAt: null },
    { financialView: null },
    { leaseToken: randomUUID(), leaseUntil: new Date() },
    { payload: { ...complete.payload, mode: "ledger_coordinated" as const } },
  ])
    await expect(
      Promise.resolve(db.update(federationDisputeFreezes).set(patch).where(c.key)),
    ).rejects.toThrow();
  const altered = await signFederationMessage(
    CommercialDisputeFreezeSchema,
    { ...complete.payload, salt: "f".repeat(64) },
    f.source.signing,
  );
  await expect(c.receiver.receive(altered, f.fingerprint)).rejects.toThrow("OPERATION_CONFLICT");
});

test("dispute freeze status and retry keep human, organization and independent capability boundaries", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const disabled = new FederationDisputeFreezeExchange(db, f.source.signing);
  await disabled.discover();
  expect(await disabled.advanceNext()).toBe(false);
  expect(await disabled.status(f.sourceActor, f.revisionId, c.original.caseId)).toEqual({
    attestation: null,
    enabled: false,
    sync: null,
  });
  await expect(disabled.retry(f.sourceActor, f.revisionId, c.original.caseId)).rejects.toThrow(
    "ASSET_UNAVAILABLE",
  );
  await c.freeze.discover();
  const args: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.source.signing),
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
  ];
  args[25] = c.freeze;
  const app = new Hono<{ Variables: { principal: BoundPrincipal; automation: boolean } }>();
  app.onError(createErrorHandler(pino({ enabled: false })));
  let actor = f.sourceActor,
    automation = false;
  app.use("*", async (ctx, next) => {
    ctx.set("principal", {
      sub: actor.userId,
      userId: actor.userId,
      orgId: actor.orgId,
      orgIds: [actor.orgId],
      role: "platform_admin",
      email: "fixture@example.invalid",
      memberships: [{ orgId: actor.orgId, role: "owner" }],
      capabilities: [],
    });
    ctx.set("automation", automation);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...args));
  const path = `/federation/commercial-agreements/${f.revisionId}/disputes/${c.original.caseId}/freeze`;
  const retry = (body = "{}") =>
    app.request(`${path}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const response = await app.request(path),
    body = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const field of ["approvalJws", "counterpartyJws", "financialView", "leaseToken", "endpoint"])
    expect(body).not.toContain(field);
  expect((await retry('{"state":"confirmed"}')).status).toBe(400);
  expect((await retry()).status).toBe(200);
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "dispute.read", enabled: true },
    f.sourceActor.userId,
  );
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    f.sourceActor.userId,
  );
  expect((await app.request(path)).status).toBe(200);
  expect((await retry()).status).toBe(403);
  actor = f.actor;
  expect((await app.request(path)).status).toBe(403);
  actor = f.sourceActor;
  automation = true;
  expect((await app.request(path)).status).toBe(403);
});

test("dispute freeze rechecks the certificate inside the transaction and rejects a corrupted stored snapshot", async () => {
  const f = await billingExchangeFixture(),
    c = await freezeFixture(f);
  const offline = new FederationDisputeFreezeExchange(db, f.source.signing, async () => {
    throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
  });
  await offline.discover();
  await offline.advanceNext();
  const original = await c.read();
  if (!original?.approvalJws || !original.financialView) throw new Error("Missing prepared freeze");
  const resolve = f.trust.resolvePeer.bind(f.trust);
  const peer = spyOn(FederationTrustRegistry.prototype, "resolvePeer").mockImplementation(
    async (...args) => {
      const result = await resolve(...args);
      await db
        .update(federationCertificates)
        .set({ revokedAt: new Date() })
        .where(eq(federationCertificates.fingerprint, f.fingerprint));
      return result;
    },
  );
  try {
    await expect(c.receiver.receive(original.approvalJws, f.fingerprint)).rejects.toThrow(
      "UNTRUSTED_IDENTITY",
    );
  } finally {
    peer.mockRestore();
  }
  expect(await c.read(f.provider.signing.siteId)).toBeUndefined();
  await db
    .update(federationDisputeFreezes)
    .set({ financialView: { ...original.financialView, taskId: randomUUID() } })
    .where(c.key);
  await c.due();
  await c.freeze.advanceNext();
  expect(await c.read()).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    counterpartyJws: null,
  });
  expect(c.bodies).toHaveLength(0);
});

test("dispute freeze also reconciles a provider-opened case without reversing the contract parties", async () => {
  const f = await billingExchangeFixture();
  const c = await freezeFixture({
    ...f,
    source: f.provider,
    provider: f.source,
    sourceActor: f.actor,
    actor: f.sourceActor,
    fingerprint: f.providerFingerprint,
  });
  await c.advance();
  expect(c.original.payload.openingSiteId).toBe(f.provider.signing.siteId);
  const proof = await c.read();
  expect(proof?.state).toBe("confirmed");
  expect(proof?.payload).toMatchObject({
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
  });
  expect((await c.read(f.source.signing.siteId))?.digest).toBe(proof?.digest);
});

test("dispute attestation persists while the chain is offline and resumes the original checkpoint after reconstruction", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    c = await freezeFixture(f),
    budget = await f.budget();
  await c.advance();
  const status = () => c.freeze.status(f.sourceActor, f.revisionId, c.original.caseId);
  const first = (await status()).attestation;
  if (!first) throw new Error("Missing attestation outbox");
  const key = eq(federationCommercialSubmissions.id, first.id);
  const [pending] = await db.select().from(federationCommercialSubmissions).where(key);
  if (pending?.input.operation !== "record-dispute-freeze") throw new Error("Missing signed input");
  expect(pending.input.envelope.openingJws).toBe(c.original.openingJws);
  expect(pending.input.envelope.openingSiteId).toBe(f.source.signing.siteId);
  const proof = await c.read();
  if (!proof?.digest) throw new Error("Missing confirmed proof");
  expect(pending.input.digest).toBe(proof.digest);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.source.signing.siteId),
        sql`${federationCommercialSubmissions.id} <> ${first.id}`,
      ),
    );
  let online = false,
    prepares = 0,
    advances = 0;
  const transactionId = "e".repeat(64);
  const client: CommercialClient = {
    prepare: async (input) => {
      expect(input).toEqual(pending.input);
      if (!online) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      prepares++;
      return { transactionId, recovery: "proposal" };
    },
    advance: async (recovery) => {
      advances++;
      if (recovery === "proposal")
        return {
          state: "prepared",
          transactionId,
          recovery: Buffer.from("original-transaction").toString("base64"),
        };
      expect(recovery).toBe(Buffer.from("original-transaction").toString("base64"));
      if (!online) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      return { state: "committed", transactionId, blockNumber: "93" };
    },
  };
  const worker = () =>
    new FederationCommercialSubmissionService(db, f.source.signing.siteId, client);
  const due = () =>
    db
      .update(federationCommercialSubmissions)
      .set({ nextAttemptAt: new Date(0) })
      .where(key);
  await worker().advanceNext();
  expect((await status()).attestation).toMatchObject({
    state: "pending",
    lastError: "LEDGER_UNAVAILABLE",
  });
  expect((await c.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe("DISPUTED");
  online = true;
  await due();
  await worker().advanceNext();
  await worker().advanceNext();
  online = false;
  await worker().advanceNext();
  expect((await status()).attestation?.state).toBe("pending");
  online = true;
  await due();
  await worker().advanceNext();
  expect((await status()).attestation).toMatchObject({ state: "committed", lastError: null });
  expect(prepares).toBe(1);
  expect(advances).toBe(3);
  expect(await f.budget()).toEqual(budget);
  expect(
    (await c.receiver.status(f.actor, f.revisionId, c.original.caseId)).attestation,
  ).toBeNull();
  await c.advance();
  expect((await db.select().from(federationCommercialSubmissions).where(key)).length).toBe(1);
});

test("dispute attestation enqueue rolls back with the opening institution's confirmation audit", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    c = await freezeFixture(f);
  await db.execute(
    sql.raw(
      `ALTER TABLE audit_log ADD CONSTRAINT attestation_audit_failure CHECK (action <> 'federation.dispute.freeze_confirm' OR actor <> 'dispute-freeze:${f.source.signing.siteId}') NOT VALID`,
    ),
  );
  try {
    await c.advance();
  } finally {
    await db.execute(sql.raw("ALTER TABLE audit_log DROP CONSTRAINT attestation_audit_failure"));
  }
  expect((await c.read())?.state).toBe("pending");
  expect(
    (await c.freeze.status(f.sourceActor, f.revisionId, c.original.caseId)).attestation,
  ).toBeNull();
  expect((await c.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  await c.due();
  await c.advance();
  expect(
    (await c.freeze.status(f.sourceActor, f.revisionId, c.original.caseId)).attestation?.state,
  ).toBe("pending");
  expect((await c.read())?.state).toBe("confirmed");
});

test("dispute attestation checks the original case and dedicated current authority before adapter disclosure", async () => {
  const f = await adjustmentServiceFixture("bilateral_attested"),
    c = await freezeFixture(f);
  await c.advance();
  const status = () => c.freeze.status(f.sourceActor, f.revisionId, c.original.caseId);
  const entry = (await status()).attestation;
  if (!entry) throw new Error("Missing attestation");
  const key = eq(federationCommercialSubmissions.id, entry.id);
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(
      and(
        eq(federationCommercialSubmissions.localSiteId, f.source.signing.siteId),
        sql`${federationCommercialSubmissions.id} <> ${entry.id}`,
      ),
    );
  const [row] = await db.select().from(federationCommercialSubmissions).where(key);
  if (row?.input.operation !== "record-dispute-freeze") throw new Error("Missing input");
  let prepares = 0;
  const worker = new FederationCommercialSubmissionService(db, f.source.signing.siteId, {
    prepare: async () => {
      prepares++;
      return { transactionId: "f".repeat(64), recovery: "proposal" };
    },
    advance: async () => {
      throw new Error("Unexpected advance");
    },
  });
  await db
    .update(federationCommercialSubmissions)
    .set({ input: { ...row.input, domainId: randomUUID() } })
    .where(key);
  await worker.advanceNext();
  expect((await status()).attestation).toMatchObject({
    state: "needs_review",
    lastError: "POLICY_DENIED",
  });
  await db
    .update(federationCommercialSubmissions)
    .set({ input: row.input, state: "pending", nextAttemptAt: new Date(0) })
    .where(key);
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-dispute'` })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  await worker.advanceNext();
  expect((await status()).attestation?.state).toBe("needs_review");
  expect(prepares).toBe(0);
  expect((await c.read())?.state).toBe("confirmed");
  const permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.sourceActor, capability: "agreement.read", enabled: true },
    f.sourceActor.userId,
  );
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.open", enabled: false },
    f.sourceActor.userId,
  );
  await expect(worker.retry(f.sourceActor, f.revisionId, entry.id)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await permissions.set(
    { ...f.sourceActor, capability: "dispute.open", enabled: true },
    f.sourceActor.userId,
  );
  await worker.retry(f.sourceActor, f.revisionId, entry.id);
  expect((await status()).attestation?.state).toBe("pending");
  const [retried] = await db.select().from(federationCommercialSubmissions).where(key);
  expect(retried?.input).toEqual(row.input);
});

async function nativeFreezeFixture(providerOpening = false) {
  const f = await settlementFixture("bilateral_attested");
  // Authenticated native originals isolate platform coordination; real Fabric is tested separately.
  const pair = async <T extends { kind: string }>(schema: z.ZodType<T>, payload: T) => {
    const a = await signFederationMessage(schema, payload, f.source.signing);
    const b = await signFederationMessage(schema, payload, f.provider.signing);
    const signed = await verifyFederationMessage(
      schema,
      a,
      {
        ...f.source.verification,
        allowedKinds: [
          "commercial-agreement",
          "commercial-bill",
          "commercial-reservation",
          "commercial-release",
        ],
      },
      new Date(),
    );
    return { a, b, digest: signed.digest };
  };
  const terms = CommercialAgreementSchema.parse({
    ...f.contract,
    agreement: { ...f.contract.agreement, mode: "ledger_coordinated" },
  });
  const contract = await pair(CommercialAgreementSchema, terms);
  const bill = CommercialBillSchema.parse({
    ...f.bill,
    agreementDigest: contract.digest,
    request: { ...f.bill.request, mode: "ledger_coordinated" },
    reservationId: f.reservationId,
  });
  const signedBill = await pair(CommercialBillSchema, bill);
  const reservation = CommercialReservationSchema.parse({
    protocolVersion: 1,
    kind: "commercial-reservation",
    domainId: terms.domainId,
    reservationId: f.reservationId,
    demandId: randomUUID(),
    claimVersion: 2,
    agreementDigest: contract.digest,
    salt: "c".repeat(64),
    request: bill.request,
  });
  const signedReservation = await pair(CommercialReservationSchema, reservation);
  const sites = [f.source.signing.siteId, f.provider.signing.siteId];
  cleanup.push(async () => {
    await db
      .delete(federationCommercialExecutionApprovals)
      .where(inArray(federationCommercialExecutionApprovals.localSiteId, sites));
  });
  for (const [keys, actor, source] of [
    [f.source, f.sourceActor, true],
    [f.provider, f.actor, false],
  ] as const) {
    const signatures = (p: { a: string; b: string; digest: string }) => ({
      approvalJws: source ? p.a : p.b,
      counterpartyJws: source ? p.b : p.a,
      digest: p.digest,
    });
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-reservation","commercial-release"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, keys.signing.siteId));
    await db
      .update(federationCommercialAgreements)
      .set({ terms, ...signatures(contract) })
      .where(
        and(
          eq(federationCommercialAgreements.localSiteId, keys.signing.siteId),
          eq(federationCommercialAgreements.revisionId, f.revisionId),
        ),
      );
    await db
      .update(federationCommercialBills)
      .set({ payload: bill, ...signatures(signedBill) })
      .where(
        and(
          eq(federationCommercialBills.localSiteId, keys.signing.siteId),
          eq(federationCommercialBills.billId, bill.billId),
        ),
      );
    await db.insert(federationCommercialExecutionApprovals).values({
      localSiteId: keys.signing.siteId,
      localOrgId: actor.orgId,
      agreementRevisionId: f.revisionId,
      recordId: reservation.reservationId,
      payload: reservation,
      approvedBy: actor.userId,
      ...signatures(signedReservation),
    });
  }
  const receipts = new Map<string, { recordId: string; digest: string }>([
    [`agreement:${f.revisionId}`, { recordId: f.revisionId, digest: contract.digest }],
    [`bill:${bill.billId}`, { recordId: bill.billId, digest: signedBill.digest }],
    [
      `reservation:${reservation.reservationId}`,
      { recordId: reservation.reservationId, digest: signedReservation.digest },
    ],
  ]);
  const hidden = new Set<string>();
  let online = true,
    prepares = 0;
  let proposed: Parameters<CommercialClient["prepare"]>[0] | undefined;
  const transactionId = "d".repeat(64),
    proposal = Buffer.from("native-proposal").toString("base64"),
    transaction = Buffer.from("native-transaction").toString("base64");
  const makeClient = (site: string): CommercialClient => ({
    receipt: async (input) => {
      if (!online) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      const key = `${input.recordType}:${input.recordId}`;
      return { receipt: hidden.has(`${site}:${key}`) ? null : (receipts.get(key) ?? null) };
    },
    prepare: async (input) => {
      if (!online) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      prepares++;
      proposed = input;
      return { transactionId, recovery: proposal };
    },
    advance: async (recovery) => {
      if (!online) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
      if (recovery === proposal) return { state: "prepared", transactionId, recovery: transaction };
      expect(recovery).toBe(transaction);
      if (!proposed || proposed.operation !== "freeze-disputed-task")
        throw new Error("Missing native proposal");
      receipts.set(`native-dispute-freeze:${proposed.recordId}`, {
        recordId: proposed.recordId,
        digest: proposed.digest,
      });
      return { state: "committed", transactionId, blockNumber: "101" };
    },
  });
  const clients = { source: makeClient("source"), target: makeClient("target") };
  const flow = providerOpening
    ? {
        ...f,
        source: f.provider,
        provider: f.source,
        sourceActor: f.actor,
        actor: f.sourceActor,
        fingerprint: f.providerFingerprint,
      }
    : f;
  const c = await freezeFixture(
    flow,
    { recordType: "bill", recordId: bill.billId, recordDigest: signedBill.digest },
    clients,
  );
  // Old fixture outboxes were for the bilateral originals; only exercise the new native submission.
  await db
    .update(federationCommercialSubmissions)
    .set({ state: "committed" })
    .where(inArray(federationCommercialSubmissions.localSiteId, sites));
  const worker = () =>
    new FederationCommercialSubmissionService(db, flow.source.signing.siteId, clients.source);
  const dueBoth = () =>
    db
      .update(federationDisputeFreezes)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(federationDisputeFreezes.caseId, c.original.caseId));
  const dueSubmission = () =>
    db
      .update(federationCommercialSubmissions)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(federationCommercialSubmissions.localSiteId, flow.source.signing.siteId),
          sql`${federationCommercialSubmissions.input}->>'operation' = 'freeze-disputed-task'`,
        ),
      );
  const queued = () =>
    db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        and(
          inArray(federationCommercialSubmissions.localSiteId, sites),
          sql`${federationCommercialSubmissions.input}->>'operation' = 'freeze-disputed-task'`,
        ),
      );
  return {
    ...flow,
    ...c,
    bill,
    reservation,
    signedReservation,
    clients,
    pair,
    receipts,
    hidden,
    worker,
    dueBoth,
    dueSubmission,
    queued,
    prepares: () => prepares,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

test("native dispute freeze saves both signatures but confirms each institution only after its matching private receipt", async () => {
  const f = await nativeFreezeFixture();
  const budget = await f.budget();
  await f.advance();
  for (const site of [f.source.signing.siteId, f.provider.signing.siteId])
    expect(await f.read(site)).toMatchObject({
      state: "ledger_pending",
      confirmedAt: null,
      ledgerReceipt: null,
    });
  expect((await f.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe(
    "FREEZE_PENDING",
  );
  expect(await f.queued()).toHaveLength(1);
  await f.freeze.advanceNext();
  expect(await f.read()).toMatchObject({ state: "ledger_pending", lastError: "DATA_WAITING" });
  for (let i = 0; i < 3; i++) await f.worker().advanceNext();
  expect((await f.queued())[0]?.state).toBe("committed");
  await f.dueBoth();
  await f.receiver.advanceNext();
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  expect((await f.read())?.state).toBe("ledger_pending");
  await new FederationDisputeFreezeExchange(
    db,
    f.source.signing,
    undefined,
    f.clients.source,
  ).advanceNext();
  expect(await f.read()).toMatchObject({
    state: "confirmed",
    ledgerReceipt: { recordId: f.original.caseId, digest: (await f.read())?.digest },
  });
  expect((await f.sourceCases.list(f.sourceActor, f.revisionId)).data[0]?.state).toBe("DISPUTED");
  expect(await f.budget()).toEqual(budget);
  expect(f.prepares()).toBe(1);
});

test("native dispute freeze waits for both institutions' financial and execution receipts before signing", async () => {
  const f = await nativeFreezeFixture();
  for (const [site, key] of [
    ["source", `bill:${f.bill.billId}`],
    ["target", `reservation:${f.reservation.reservationId}`],
  ] as const) {
    f.hidden.add(`${site}:${key}`);
    await f.dueBoth();
    await f.advance();
    expect((await f.read())?.state).toBe("pending");
    expect(await f.read(f.provider.signing.siteId)).toBeUndefined();
    expect(await f.queued()).toHaveLength(0);
    f.hidden.clear();
  }
  const proposal = (await f.read())?.approvalJws;
  await f.dueBoth();
  await f.advance();
  expect(await f.read()).toMatchObject({ state: "ledger_pending", approvalJws: proposal });
});

test("native dispute freeze waits for unilateral releases and verifies original signatures before proceeding", async () => {
  const f = await nativeFreezeFixture();
  const release = CommercialReleaseSchema.parse({
    protocolVersion: 1,
    kind: "commercial-release",
    domainId: f.reservation.domainId,
    releaseId: randomUUID(),
    reservationId: f.reservation.reservationId,
    reservationDigest: f.signedReservation.digest,
    sourceSiteId: f.source.signing.siteId,
    targetSiteId: f.provider.signing.siteId,
    expectedGateVersion: 1,
    issuedAt: new Date().toISOString(),
    salt: "e".repeat(64),
    reason: "Previously signed release",
  });
  const signed = await f.pair(CommercialReleaseSchema, release);
  const key = and(
    eq(federationCommercialExecutionApprovals.localSiteId, f.provider.signing.siteId),
    eq(federationCommercialExecutionApprovals.recordId, release.releaseId),
  );
  await db.insert(federationCommercialExecutionApprovals).values({
    localSiteId: f.provider.signing.siteId,
    localOrgId: f.actor.orgId,
    agreementRevisionId: f.revisionId,
    recordId: release.releaseId,
    payload: release,
    approvalJws: signed.b,
    digest: signed.digest,
    approvedBy: f.actor.userId,
  });
  await f.advance();
  expect((await f.read())?.state).toBe("pending");
  expect(await f.read(f.provider.signing.siteId)).toBeUndefined();
  await db
    .update(federationCommercialExecutionApprovals)
    .set({ counterpartyJws: signed.a })
    .where(key);
  await f.dueBoth();
  await f.advance();
  expect((await f.read())?.state).toBe("pending");
  f.receipts.set(`release:${release.releaseId}`, {
    recordId: release.releaseId,
    digest: signed.digest,
  });
  await f.dueBoth();
  await f.advance();
  expect((await f.read())?.state).toBe("ledger_pending");
});

test("native dispute freeze recovers a lost peer response and submitted checkpoint after service reconstruction", async () => {
  const f = await nativeFreezeFixture();
  const lost = new FederationDisputeFreezeExchange(
    db,
    f.source.signing,
    async (...args) => {
      await f.send(...args);
      throw new FederationDeliveryError("DELIVERY_UNAVAILABLE");
    },
    f.clients.source,
  );
  await lost.discover();
  await lost.advanceNext();
  const original = (await f.read())?.approvalJws;
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("ledger_pending");
  expect(await f.queued()).toHaveLength(0);
  await f.dueBoth();
  await f.advance();
  expect((await f.read())?.approvalJws).toBe(original);
  await f.worker().advanceNext();
  await f.worker().advanceNext();
  const [queued] = await f.queued();
  if (!queued) throw new Error("Missing native outbox");
  const attempts = () =>
    db
      .select()
      .from(federationCommercialAttempts)
      .where(eq(federationCommercialAttempts.submissionId, queued.id));
  const saved = (await attempts())[0];
  f.setOnline(false);
  await f.worker().advanceNext();
  await f.freeze.advanceNext();
  await f.receiver.advanceNext();
  expect((await f.read())?.state).toBe("ledger_pending");
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("ledger_pending");
  f.setOnline(true);
  await f.dueSubmission();
  await f.worker().advanceNext();
  await f.dueBoth();
  await new FederationDisputeFreezeExchange(
    db,
    f.source.signing,
    undefined,
    f.clients.source,
  ).advanceNext();
  await new FederationDisputeFreezeExchange(
    db,
    f.provider.signing,
    undefined,
    f.clients.target,
  ).advanceNext();
  expect((await attempts())[0]).toMatchObject({
    transactionId: saved?.transactionId,
    recovery: saved?.recovery,
    stage: "committed",
  });
  expect(f.prepares()).toBe(1);
  expect((await f.read())?.state).toBe("confirmed");
  expect(await f.queued()).toHaveLength(1);
});

test("native dispute freeze rejects a mismatched receipt and enforces durable native confirmation constraints", async () => {
  const f = await nativeFreezeFixture();
  await f.advance();
  const row = await f.read();
  if (!row?.digest) throw new Error("Missing dual proof");
  for (const patch of [
    { state: "confirmed", confirmedAt: new Date() },
    {
      state: "confirmed",
      confirmedAt: new Date(),
      ledgerReceipt: { recordId: randomUUID(), digest: row.digest },
    },
    {
      state: "confirmed",
      confirmedAt: new Date(),
      ledgerReceipt: { recordId: row.caseId, digest: `sha256:${"0".repeat(64)}` },
    },
    { counterpartyJws: null },
  ])
    await expect(
      Promise.resolve(db.update(federationDisputeFreezes).set(patch).where(f.key)),
    ).rejects.toThrow();
  f.receipts.set(`native-dispute-freeze:${f.original.caseId}`, {
    recordId: randomUUID(),
    digest: row.digest,
  });
  await f.receiver.advanceNext();
  expect(await f.read(f.provider.signing.siteId)).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    ledgerReceipt: null,
  });
  expect((await f.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe("FREEZE_PENDING");
  f.receipts.set(`native-dispute-freeze:${f.original.caseId}`, {
    recordId: f.original.caseId,
    digest: row.digest,
  });
  await f.receiver.retry(f.actor, f.revisionId, f.original.caseId);
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("ledger_pending");
  await f.receiver.advanceNext();
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
});

test("native dispute freeze receipt and confirmation audit commit atomically without regressing later case states", async () => {
  const f = await nativeFreezeFixture();
  await f.advance();
  for (let i = 0; i < 3; i++) await f.worker().advanceNext();
  const constraint = sql.identifier(`native_freeze_audit_${randomUUID().replaceAll("-", "")}`);
  await db.execute(
    sql`ALTER TABLE audit_log ADD CONSTRAINT ${constraint} CHECK (action <> 'federation.dispute.freeze_confirm') NOT VALID`,
  );
  try {
    await f.receiver.advanceNext();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT ${constraint}`);
  }
  expect(await f.read(f.provider.signing.siteId)).toMatchObject({
    state: "ledger_pending",
    confirmedAt: null,
    ledgerReceipt: null,
  });
  await db
    .update(federationDisputes)
    .set({ state: "EVIDENCE_WAITING" })
    .where(
      and(
        eq(federationDisputes.localSiteId, f.provider.signing.siteId),
        eq(federationDisputes.caseId, f.original.caseId),
      ),
    );
  await f.dueBoth();
  await f.receiver.advanceNext();
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  expect((await f.providerCases.list(f.actor, f.revisionId)).data[0]?.state).toBe(
    "EVIDENCE_WAITING",
  );
});

test("native dispute freeze cannot sign without a local receipt client or with a rewritten execution original", async () => {
  const f = await nativeFreezeFixture();
  const offline = new FederationDisputeFreezeExchange(db, f.source.signing, f.send);
  await offline.discover();
  await offline.advanceNext();
  expect(await f.read()).toMatchObject({
    state: "pending",
    lastError: "LEDGER_UNAVAILABLE",
    approvalJws: null,
  });
  const key = and(
    eq(federationCommercialExecutionApprovals.localSiteId, f.source.signing.siteId),
    eq(federationCommercialExecutionApprovals.recordId, f.reservation.reservationId),
  );
  await db
    .update(federationCommercialExecutionApprovals)
    .set({ payload: { ...f.reservation, salt: "f".repeat(64) } })
    .where(key);
  await f.dueBoth();
  await f.advance();
  expect(await f.read()).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    approvalJws: null,
  });
  expect(f.bodies).toHaveLength(0);
  expect(await f.queued()).toHaveLength(0);
});

test("native dispute freeze source audit failure rolls back its dual proof and outbox then reuses the recipient signature", async () => {
  const f = await nativeFreezeFixture();
  const constraint = sql.identifier(`native_freeze_sign_${randomUUID().replaceAll("-", "")}`);
  const actor = sql.raw(`'dispute-freeze:${f.source.signing.siteId}'`);
  await db.execute(
    sql`ALTER TABLE audit_log ADD CONSTRAINT ${constraint} CHECK (action <> 'federation.dispute.freeze_sign' OR actor <> ${actor}) NOT VALID`,
  );
  try {
    await f.advance();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT ${constraint}`);
  }
  const recipient = await f.read(f.provider.signing.siteId),
    original = await f.read();
  expect(recipient?.state).toBe("ledger_pending");
  expect(original).toMatchObject({ state: "pending", counterpartyJws: null });
  expect(await f.queued()).toHaveLength(0);
  await f.dueBoth();
  await f.advance();
  expect(await f.read()).toMatchObject({
    state: "ledger_pending",
    approvalJws: original?.approvalJws,
    counterpartyJws: recipient?.approvalJws,
  });
  expect(await f.queued()).toHaveLength(1);
});

test("native dispute freeze fences an expired receipt poll and preserves a newer confirmation", async () => {
  const f = await nativeFreezeFixture();
  await f.advance();
  for (let i = 0; i < 3; i++) await f.worker().advanceNext();
  const arrived = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const delayed = new FederationDisputeFreezeExchange(db, f.provider.signing, undefined, {
    receipt: async (input) => {
      const answer = await f.clients.target.receipt?.(input);
      if (!answer) throw new Error("Missing receipt client");
      arrived.resolve();
      await proceed.promise;
      return answer;
    },
  });
  const running = delayed.advanceNext();
  try {
    await arrived.promise;
    await db
      .update(federationDisputeFreezes)
      .set({ leaseUntil: new Date(0) })
      .where(
        and(
          eq(federationDisputeFreezes.localSiteId, f.provider.signing.siteId),
          eq(federationDisputeFreezes.caseId, f.original.caseId),
        ),
      );
    await f.receiver.advanceNext();
    expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  } finally {
    proceed.resolve();
    await running;
  }
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, `dispute-freeze:${f.provider.signing.siteId}`),
          eq(auditLog.action, "federation.dispute.freeze_confirm"),
          eq(auditLog.target, f.original.caseId),
        ),
      ),
  ).toHaveLength(1);
});

test("native dispute freeze rechecks original authority after receipt I/O and never confirms on a different digest", async () => {
  const f = await nativeFreezeFixture();
  await f.advance();
  const proof = await f.read();
  if (!proof?.digest) throw new Error("Missing native proof");
  f.receipts.set(`native-dispute-freeze:${f.original.caseId}`, {
    recordId: f.original.caseId,
    digest: `sha256:${"1".repeat(64)}`,
  });
  await f.receiver.advanceNext();
  expect(await f.read(f.provider.signing.siteId)).toMatchObject({
    state: "needs_review",
    lastError: "OPERATION_CONFLICT",
    ledgerReceipt: null,
  });
  f.receipts.set(`native-dispute-freeze:${f.original.caseId}`, {
    recordId: f.original.caseId,
    digest: proof.digest,
  });
  await f.receiver.retry(f.actor, f.revisionId, f.original.caseId);
  const changed = new FederationDisputeFreezeExchange(db, f.provider.signing, undefined, {
    receipt: async (input) => {
      const answer = await f.clients.target.receipt?.(input);
      if (!answer) throw new Error("Missing receipt client");
      await db
        .update(federationSigningKeys)
        .set({ revokedAt: new Date() })
        .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
      return answer;
    },
  });
  await changed.advanceNext();
  expect(await f.read(f.provider.signing.siteId)).toMatchObject({
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
    confirmedAt: null,
    ledgerReceipt: null,
  });
});

test("native dispute freeze supports provider opening while preserving original contract parties", async () => {
  const f = await nativeFreezeFixture(true);
  await f.advance();
  const [queued] = await f.queued();
  if (queued?.input.operation !== "freeze-disputed-task") throw new Error("Missing native outbox");
  expect(queued.localSiteId).toBe(f.reservation.request.recipientSiteId);
  expect(queued.input.envelope.openingSiteId).toBe(f.reservation.request.recipientSiteId);
  expect(queued.input.envelope.sourceSiteId).toBe(f.reservation.request.senderSiteId);
  expect(queued.input.envelope.targetSiteId).toBe(f.reservation.request.recipientSiteId);
  for (let i = 0; i < 3; i++) await f.worker().advanceNext();
  expect((await f.queued())[0]?.state).toBe("committed");
  await f.freeze.advanceNext();
  await f.receiver.advanceNext();
  expect((await f.read())?.state).toBe("confirmed");
  expect((await f.read(f.provider.signing.siteId))?.state).toBe("confirmed");
});

async function disclosureAccess(
  f: Pick<
    Awaited<ReturnType<typeof billingExchangeFixture>>,
    | "source"
    | "provider"
    | "actor"
    | "sourceActor"
    | "report"
    | "revisionId"
    | "trust"
    | "fingerprint"
  >,
  existingCase?: string,
) {
  const recipient = randomUUID();
  await f.trust.addSite(
    {
      id: recipient,
      name: "Authorized evidence recipient",
      endpoint: "https://evidence.test.invalid",
    },
    f.actor.userId,
  );
  let caseId = existingCase;
  if (!caseId) {
    const c = await disputeAccess(f);
    for (const site of [f.source.signing.siteId, f.provider.signing.siteId])
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-dispute-receipt"]'::jsonb`,
        })
        .where(eq(federationSigningKeys.siteId, site));
    const draft = await c.sourceCases.draft(f.sourceActor, f.revisionId, c.input);
    const opened = await c.sourceCases.open(f.sourceActor, f.revisionId, draft);
    await c.providerCases.receive(opened.openingJws, f.fingerprint);
    caseId = draft.caseId;
  }
  cleanup.push(async () => {
    const sites = [f.source.signing.siteId, f.provider.signing.siteId];
    await db.delete(federationDisclosures).where(inArray(federationDisclosures.localSiteId, sites));
    await db
      .delete(federationDisclosurePolicies)
      .where(inArray(federationDisclosurePolicies.localSiteId, sites));
    await db.delete(federationSites).where(eq(federationSites.id, recipient));
  });
  for (const [keys, actor] of [
    [f.source, f.sourceActor],
    [f.provider, f.actor],
  ] as const) {
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-disclosure-policy","commercial-disclosure"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, keys.signing.siteId));
    await new FederationPermissionService(db).set(
      { ...actor, capability: "disclosure.approve", enabled: true },
      actor.userId,
    );
  }
  const sourcePolicy = new FederationDisclosurePolicyService(db, f.source.signing);
  const providerPolicy = new FederationDisclosurePolicyService(db, f.provider.signing);
  const policy = await sourcePolicy.draft(f.sourceActor, f.revisionId, {
    policyId: randomUUID(),
    recipientSiteId: recipient,
    validUntil: new Date(Date.now() + 3600000).toISOString(),
    disclosures: [
      { recordType: "agreement", fields: ["unit"] },
      { recordType: "usage", fields: ["measurements"] },
      { recordType: "bill", fields: ["dueAmount"] },
      { recordType: "settlement", fields: ["chargedAmount"] },
      { recordType: "adjustment", fields: ["reason"] },
      { recordType: "payment", fields: ["amount"] },
    ],
  });
  const a = await sourcePolicy.approve(f.sourceActor, f.revisionId, policy);
  const b = await providerPolicy.approve(f.actor, f.revisionId, policy);
  await sourcePolicy.attachCounterparty(
    f.sourceActor,
    f.revisionId,
    policy.policyId,
    b.approvalJws,
  );
  await providerPolicy.attachCounterparty(f.actor, f.revisionId, policy.policyId, a.approvalJws);
  const service = new FederationDisclosureService(db, f.source.signing);
  const peer = new FederationDisclosureService(db, f.provider.signing);
  const draft = (
    record: Pick<
      z.infer<typeof CommercialDisclosureDraftSchema>,
      "recordType" | "recordId" | "recordDigest" | "fields"
    >,
  ) =>
    service.draft(
      f.sourceActor,
      f.revisionId,
      CommercialDisclosureDraftSchema.parse({
        ...record,
        grantId: randomUUID(),
        caseId,
        policyId: policy.policyId,
        validUntil: policy.validUntil,
      }),
    );
  const approve = async (value: z.infer<typeof CommercialDisclosureSchema>) => ({
    source: await service.approve(f.sourceActor, f.revisionId, value),
    provider: await peer.approve(f.actor, f.revisionId, value),
  });
  const confirm = async (value: z.infer<typeof CommercialDisclosureSchema>) => {
    const both = await approve(value);
    await service.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      value.grant.grantId,
      both.provider.approvalJws,
    );
    await peer.attachCounterparty(
      f.actor,
      f.revisionId,
      value.grant.grantId,
      both.source.approvalJws,
    );
    return both;
  };
  return {
    caseId,
    recipient,
    policy,
    sourcePolicy,
    providerPolicy,
    service,
    peer,
    draft,
    approve,
    confirm,
  };
}

async function disclosureFixture(
  mode: "bilateral_direct" | "bilateral_attested" = "bilateral_direct",
) {
  const f = await paymentFixture(mode),
    receipt = await f.confirm(),
    d = await disclosureAccess(f);
  const value = await d.draft({
    recordType: "payment",
    recordId: receipt.receiptId,
    recordDigest: receipt.digest,
    fields: ["amount"],
  });
  return { ...f, ...d, value, receipt };
}

test("disclosure approvals bind exact projections and independent institutions without changing finances or outboxes", async () => {
  for (const mode of ["bilateral_direct", "bilateral_attested"] as const) {
    const f = await disclosureFixture(mode);
    const budget = await f.budget();
    const before = await db
      .select()
      .from(federationCommercialSubmissions)
      .orderBy(federationCommercialSubmissions.id);
    expect(f.value.evidence).toEqual({ recordType: "payment", values: { amount: "7" } });
    const both = await f.approve(f.value);
    expect(both.source.confirmedAt).toBeNull();
    expect(both.provider.approvalJws).not.toBe(both.source.approvalJws);
    await f.confirm(f.value);
    const rows = await f.service.list(f.sourceActor, f.revisionId, 10, 0, { caseId: f.caseId });
    expect(
      CommercialDisclosureListSchema.parse(JSON.parse(JSON.stringify(rows))).data,
    ).toHaveLength(1);
    expect(rows.data[0]?.counterpartyJws).toBe(both.provider.approvalJws);
    const decoded = JSON.parse(
      Buffer.from(both.source.approvalJws.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(decoded).toEqual(f.value);
    expect(JSON.stringify(decoded)).not.toContain(f.receipt.approvalJws);
    expect(JSON.stringify(decoded)).not.toContain(f.receipt.payload.reason);
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, f.value.grant.grantId));
    expect(audit.filter((r) => r.action === "federation.disclosure.approve")).toHaveLength(2);
    expect(audit.filter((r) => r.action === "federation.disclosure.confirm")).toHaveLength(2);
    expect(JSON.stringify(audit.map((r) => r.diff))).not.toContain('"amount":"7"');
    expect(await f.budget()).toEqual(budget);
    expect(
      await db
        .select()
        .from(federationCommercialSubmissions)
        .orderBy(federationCommercialSubmissions.id),
    ).toEqual(before);
  }
});

test("disclosure resolves agreement usage bill and payment only through verified case originals", async () => {
  const f = await disclosureFixture();
  const [contract] = await db
    .select()
    .from(federationCommercialAgreements)
    .where(
      and(
        eq(federationCommercialAgreements.localSiteId, f.source.signing.siteId),
        eq(federationCommercialAgreements.revisionId, f.revisionId),
      ),
    );
  const [bill] = await db
    .select()
    .from(federationCommercialBills)
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.source.signing.siteId),
        eq(federationCommercialBills.billId, f.receipt.billId),
      ),
    );
  if (!contract || !bill) throw new Error("Missing disclosure fixture originals");
  const records: Parameters<typeof f.draft>[0][] = [
    {
      recordType: "agreement",
      recordId: f.revisionId,
      recordDigest: contract.digest,
      fields: ["unit"],
    },
    {
      recordType: "usage",
      recordId: f.report.reportId,
      recordDigest: f.report.digest,
      fields: ["measurements"],
    },
    { recordType: "bill", recordId: bill.billId, recordDigest: bill.digest, fields: ["dueAmount"] },
  ];
  for (const record of records) {
    const value = await f.draft(record);
    expect(Object.keys(value.evidence.values)).toEqual(record.fields);
    await f.confirm(value);
  }
  expect(
    (await f.service.list(f.sourceActor, f.revisionId, 2, 0, { caseId: f.caseId })).hasMore,
  ).toBe(true);
  expect(
    (await f.service.list(f.sourceActor, f.revisionId, 2, 2, { caseId: f.caseId })).data,
  ).toHaveLength(1);
  expect(
    (await f.service.list(f.sourceActor, f.revisionId, 10, 0, { caseId: randomUUID() })).data,
  ).toHaveLength(0);
});

test("disclosure verifies settlement and adjustment projections against the original bill and task", async () => {
  const f = await adjustmentServiceFixture(),
    adjusted = await f.make("0"),
    approvals = await f.approveAdjustment(adjusted);
  await f.attachAdjustment(approvals);
  const d = await disclosureAccess(f);
  const [settlement] = await db
    .select()
    .from(federationCommercialSettlements)
    .where(
      and(
        eq(federationCommercialSettlements.localSiteId, f.source.signing.siteId),
        eq(federationCommercialSettlements.settlementId, adjusted.settlementId),
      ),
    );
  if (!settlement) throw new Error("Missing original settlement");
  const values = [
    await d.draft({
      recordType: "settlement",
      recordId: settlement.settlementId,
      recordDigest: settlement.digest,
      fields: ["chargedAmount"],
    }),
    await d.draft({
      recordType: "adjustment",
      recordId: adjusted.adjustmentId,
      recordDigest: approvals.source.digest,
      fields: ["reason"],
    }),
  ];
  for (const value of values) await d.confirm(value);
  expect(values[0]?.evidence.values).toEqual({ chargedAmount: settlement.payload.chargedAmount });
  expect(values[1]?.evidence.values).toEqual({ reason: adjusted.reason });
});

test("disclosure refuses altered values field escalation policy substitution and foreign case scope", async () => {
  const f = await disclosureFixture();
  const badValues = CommercialDisclosureSchema.parse({
    ...f.value,
    evidence: { recordType: "payment", values: { amount: "8" } },
  });
  await expect(f.service.approve(f.sourceActor, f.revisionId, badValues)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  for (const grant of [
    { ...f.value.grant, recipientSiteId: randomUUID() },
    { ...f.value.grant, policyDigest: `sha256:${"f".repeat(64)}` },
    { ...f.value.grant, caseId: randomUUID() },
    { ...f.value.grant, validUntil: "2099-01-01T00:00:00Z" },
  ])
    await expect(
      f.service.approve(
        f.sourceActor,
        f.revisionId,
        CommercialDisclosureSchema.parse({ ...f.value, grant }),
      ),
    ).rejects.toThrow("POLICY_DENIED");
  await expect(f.service.approve(f.actor, f.revisionId, f.value)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(
    f.service.approve(
      f.sourceActor,
      f.revisionId,
      CommercialDisclosureSchema.parse({
        ...f.value,
        grant: { ...f.value.grant, fields: ["amount", "unit"] },
        evidence: { recordType: "payment", values: { amount: "7", unit: f.receipt.payload.unit } },
      }),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await db
    .update(federationCommercialPayments)
    .set({ payload: { ...f.receipt.payload, amount: "8" } })
    .where(
      and(
        eq(federationCommercialPayments.localSiteId, f.source.signing.siteId),
        eq(federationCommercialPayments.receiptId, f.receipt.receiptId),
      ),
    );
  await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect((await f.service.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
});

test("disclosure enforces dedicated human and signing authority and rejects mismatched countersignatures", async () => {
  const f = await disclosureFixture(),
    permissions = new FederationPermissionService(db);
  await permissions.set(
    { ...f.sourceActor, capability: "disclosure.approve", enabled: false },
    f.sourceActor.userId,
  );
  await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.service.list(f.sourceActor, f.revisionId)).rejects.toThrow("POLICY_DENIED");
  await permissions.set(
    { ...f.sourceActor, capability: "disclosure.approve", enabled: true },
    f.sourceActor.userId,
  );
  const own = await f.service.approve(f.sourceActor, f.revisionId, f.value);
  await expect(
    f.service.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      f.value.grant.grantId,
      own.approvalJws,
    ),
  ).rejects.toThrow();
  const changed = CommercialDisclosureSchema.parse({
    ...f.value,
    grant: { ...f.value.grant, salt: "f".repeat(64) },
  });
  const peer = await f.peer.approve(f.actor, f.revisionId, changed);
  await expect(
    f.service.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      f.value.grant.grantId,
      peer.approvalJws,
    ),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-disclosure'` })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});

test("disclosure preserves one original under concurrent replay and rejects same-id replacement", async () => {
  const f = await disclosureFixture();
  const rows = await Promise.all([
    f.service.approve(f.sourceActor, f.revisionId, f.value),
    f.service.approve(f.sourceActor, f.revisionId, f.value),
  ]);
  expect(rows[0]?.approvalJws).toBe(rows[1]?.approvalJws);
  const changed = CommercialDisclosureSchema.parse({
    ...f.value,
    grant: { ...f.value.grant, salt: "f".repeat(64) },
  });
  await expect(f.service.approve(f.sourceActor, f.revisionId, changed)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(
    (await f.service.list(f.sourceActor, f.revisionId, 10, 0, { grantId: f.value.grant.grantId }))
      .data,
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.value.grant.grantId),
          eq(auditLog.action, "federation.disclosure.approve"),
        ),
      ),
  ).toHaveLength(1);
});

test("disclosure local revoke survives untrusted keys and cannot be revived by approval or counterparty replay", async () => {
  const f = await disclosureFixture(),
    both = await f.confirm(f.value);
  const revoked = await f.service.revoke(f.sourceActor, f.revisionId, f.value.grant.grantId);
  expect(revoked.revokedAt).not.toBeNull();
  await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  await expect(
    f.service.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      f.value.grant.grantId,
      both.provider.approvalJws,
    ),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await db
    .update(federationSigningKeys)
    .set({ revokedAt: new Date() })
    .where(eq(federationSigningKeys.siteId, f.source.signing.siteId));
  expect(
    (await f.service.revoke(f.sourceActor, f.revisionId, f.value.grant.grantId)).revokedAt,
  ).toEqual(revoked.revokedAt);
  expect((await f.service.list(f.sourceActor, f.revisionId)).data[0]?.approvalJws).toBe(
    both.source.approvalJws,
  );
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.value.grant.grantId),
          eq(auditLog.action, "federation.disclosure.revoke"),
        ),
      ),
  ).toHaveLength(1);
});

test("disclosure policy expiry and revocation stop new approval and attachment but preserve history", async () => {
  const f = await disclosureFixture(),
    both = await f.approve(f.value);
  setSystemTime(new Date(Date.parse(f.policy.validUntil) + 1));
  try {
    await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  } finally {
    setSystemTime();
  }
  await f.sourcePolicy.revoke(f.sourceActor, f.revisionId, f.policy.policyId);
  await expect(
    f.service.attachCounterparty(
      f.sourceActor,
      f.revisionId,
      f.value.grant.grantId,
      both.provider.approvalJws,
    ),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect((await f.service.list(f.sourceActor, f.revisionId)).data[0]?.confirmedAt).toBeNull();
  expect(
    (await f.service.revoke(f.sourceActor, f.revisionId, f.value.grant.grantId)).revokedAt,
  ).not.toBeNull();
});

test("disclosure audit failure rolls back approval confirmation and revocation", async () => {
  const f = await disclosureFixture();
  const stages = {
    approve: sql`alter table audit_log add constraint disclosure_audit_failure check (action <> 'federation.disclosure.approve') NOT VALID`,
    confirm: sql`alter table audit_log add constraint disclosure_audit_failure check (action <> 'federation.disclosure.confirm') NOT VALID`,
    revoke: sql`alter table audit_log add constraint disclosure_audit_failure check (action <> 'federation.disclosure.revoke') NOT VALID`,
  };
  await db.execute(stages.approve);
  try {
    await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint disclosure_audit_failure`);
  }
  expect((await f.service.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
  const both = await f.approve(f.value);
  await db.execute(stages.confirm);
  try {
    await expect(
      f.service.attachCounterparty(
        f.sourceActor,
        f.revisionId,
        f.value.grant.grantId,
        both.provider.approvalJws,
      ),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint disclosure_audit_failure`);
  }
  expect((await f.service.list(f.sourceActor, f.revisionId)).data[0]?.confirmedAt).toBeNull();
  await db.execute(stages.revoke);
  try {
    await expect(
      f.service.revoke(f.sourceActor, f.revisionId, f.value.grant.grantId),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`alter table audit_log drop constraint disclosure_audit_failure`);
  }
  expect((await f.service.list(f.sourceActor, f.revisionId)).data[0]?.revokedAt).toBeNull();
});

test("disclosure policy revocation serializes with a signing transaction", async () => {
  const f = await disclosureFixture();
  let release: () => void = () => {},
    acquired: () => void = () => {};
  const locked = new Promise<void>((r) => {
      acquired = r;
    }),
    resume = new Promise<void>((r) => {
      release = r;
    });
  const original = FederationDisclosurePolicyService.prototype.verified;
  let held = false;
  const hook = spyOn(FederationDisclosurePolicyService.prototype, "verified").mockImplementation(
    async function (this: FederationDisclosurePolicyService, ...args) {
      const value = await original.apply(this, args);
      if (!held) {
        held = true;
        acquired();
        await resume;
      }
      return value;
    },
  );
  const approval = f.service.approve(f.sourceActor, f.revisionId, f.value);
  await locked;
  const revoke = f.sourcePolicy.revoke(f.sourceActor, f.revisionId, f.policy.policyId);
  let waited = false;
  try {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.execute<{ waiting: boolean }>(
        sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as waiting`,
      );
      if (row?.waiting) {
        waited = true;
        break;
      }
      await Bun.sleep(10);
    }
  } finally {
    release();
    hook.mockRestore();
  }
  await Promise.all([approval, revoke]);
  expect(waited).toBe(true);
  await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
});

test("disclosure human HTTP validates strict bodies organization and dedicated authority", async () => {
  const f = await disclosureFixture();
  const deps: Parameters<typeof createFederationCommercialRoutes> = [
    new FederationCommercialAgreementService(db, f.source.signing),
    new FederationCommercialSubmissionService(db, f.source.signing.siteId),
  ];
  deps[26] = f.service;
  let actor = f.sourceActor,
    automation = false;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationCommercialRoutes(...deps));
  const path = `/federation/commercial-agreements/${f.revisionId}/disclosures`;
  const post = (suffix: string, body: unknown) =>
    app.request(path + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post("/approve", { ...f.value, originalJws: f.receipt.approvalJws })).status).toBe(
    400,
  );
  const approved = await post("/approve", f.value);
  expect(approved.status).toBe(200);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  expect((await post(`/${f.value.grant.grantId}/revoke`, { reason: "unexpected" })).status).toBe(
    400,
  );
  const list = await app.request(`${path}?caseId=${f.caseId}&grantId=${f.value.grant.grantId}`);
  const response = z.object({ data: CommercialDisclosureListSchema });
  expect(response.parse(await list.json()).data.data).toHaveLength(1);
  actor = f.actor;
  expect(response.parse(await (await app.request(path)).json()).data.data).toHaveLength(0);
  actor = f.sourceActor;
  automation = true;
  expect((await post("/approve", f.value)).status).toBe(403);
  automation = false;
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "disclosure.approve", enabled: false },
    f.sourceActor.userId,
  );
  expect((await app.request(path)).status).toBe(403);
});

test("disclosure rejects another signed task in the same commercial agreement", async () => {
  const f = await disclosureFixture();
  const [original] = await db
    .select()
    .from(federationCommercialBills)
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.source.signing.siteId),
        eq(federationCommercialBills.billId, f.receipt.billId),
      ),
    );
  if (!original) throw new Error("Missing original bill");
  const bill = CommercialBillSchema.parse({
    ...original.payload,
    billId: randomUUID(),
    request: { ...original.payload.request, taskId: randomUUID() },
  });
  const a = await signFederationMessage(CommercialBillSchema, bill, f.source.signing),
    b = await signFederationMessage(CommercialBillSchema, bill, f.provider.signing);
  const signed = await verifyFederationMessage(
    CommercialBillSchema,
    a,
    await f.trust.resolveKey(f.source.signing.siteId, f.source.signing.keyId, new Date()),
    new Date(),
  );
  await db.insert(federationCommercialBills).values({
    ...original,
    billId: bill.billId,
    taskId: bill.request.taskId,
    payload: bill,
    digest: signed.digest,
    approvalJws: a,
    counterpartyJws: b,
  });
  await expect(
    f.draft({
      recordType: "bill",
      recordId: bill.billId,
      recordDigest: signed.digest,
      fields: ["dueAmount"],
    }),
  ).rejects.toThrow("POLICY_DENIED");
  expect((await f.service.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
});

test("disclosure native consent creates no ledger operation and later case states prevent new evidence approvals", async () => {
  const f = await nativeFreezeFixture(),
    d = await disclosureAccess(f, f.original.caseId);
  const [bill] = await db
    .select()
    .from(federationCommercialBills)
    .where(
      and(
        eq(federationCommercialBills.localSiteId, f.source.signing.siteId),
        eq(federationCommercialBills.billId, f.bill.billId),
      ),
    );
  if (!bill) throw new Error("Missing native bill");
  const value = await d.draft({
    recordType: "bill",
    recordId: bill.billId,
    recordDigest: bill.digest,
    fields: ["dueAmount"],
  });
  const before = await db
    .select()
    .from(federationCommercialSubmissions)
    .orderBy(federationCommercialSubmissions.id);
  await d.confirm(value);
  expect(
    await db
      .select()
      .from(federationCommercialSubmissions)
      .orderBy(federationCommercialSubmissions.id),
  ).toEqual(before);
  await db
    .update(federationDisputes)
    .set({ state: "DECIDED" })
    .where(
      and(
        eq(federationDisputes.localSiteId, f.source.signing.siteId),
        eq(federationDisputes.caseId, d.caseId),
      ),
    );
  await expect(d.service.approve(f.sourceActor, f.revisionId, value)).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect(
    (await d.service.revoke(f.sourceActor, f.revisionId, value.grant.grantId)).revokedAt,
  ).not.toBeNull();
});

test("disclosure rechecks expiry before persistence and database identity cannot be replaced", async () => {
  const f = await disclosureFixture();
  const original = FederationDisclosurePolicyService.prototype.verified;
  let calls = 0;
  const hook = spyOn(FederationDisclosurePolicyService.prototype, "verified").mockImplementation(
    async function (this: FederationDisclosurePolicyService, ...args) {
      if (++calls === 2) setSystemTime(new Date(Date.parse(f.policy.validUntil) + 1));
      return original.apply(this, args);
    },
  );
  try {
    await expect(f.service.approve(f.sourceActor, f.revisionId, f.value)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED",
    );
  } finally {
    hook.mockRestore();
    setSystemTime();
  }
  expect((await f.service.list(f.sourceActor, f.revisionId)).data).toHaveLength(0);
  const saved = await f.service.approve(f.sourceActor, f.revisionId, f.value);
  await expect(
    db
      .update(federationDisclosures)
      .set({ caseId: randomUUID() })
      .where(eq(federationDisclosures.grantId, saved.grantId))
      .execute(),
  ).rejects.toThrow();
  await expect(
    db
      .update(federationDisclosures)
      .set({ confirmedAt: new Date() })
      .where(eq(federationDisclosures.grantId, saved.grantId))
      .execute(),
  ).rejects.toThrow();
  expect((await f.service.list(f.sourceActor, f.revisionId)).data[0]?.payload).toEqual(f.value);
});

async function disclosureExchangeFixture(kind: "disclosure-policy" | "disclosure") {
  const f = await disclosureFixture("bilateral_attested");
  const policy = { ...f.policy, policyId: randomUUID() };
  const recordId = kind === "disclosure-policy" ? policy.policyId : f.value.grant.grantId;
  const approveSource = () =>
    kind === "disclosure-policy"
      ? f.sourcePolicy.approve(f.sourceActor, f.revisionId, policy)
      : f.service.approve(f.sourceActor, f.revisionId, f.value);
  const approveProvider = (different = false) =>
    kind === "disclosure-policy"
      ? f.providerPolicy.approve(
          f.actor,
          f.revisionId,
          different ? { ...policy, salt: "e".repeat(64) } : policy,
        )
      : f.peer.approve(
          f.actor,
          f.revisionId,
          different ? { ...f.value, grant: { ...f.value.grant, salt: "e".repeat(64) } } : f.value,
        );
  const revoke = (provider = false) =>
    kind === "disclosure-policy"
      ? (provider ? f.providerPolicy : f.sourcePolicy).revoke(
          provider ? f.actor : f.sourceActor,
          f.revisionId,
          recordId,
        )
      : (provider ? f.peer : f.service).revoke(
          provider ? f.actor : f.sourceActor,
          f.revisionId,
          recordId,
        );
  const table = kind === "disclosure-policy" ? federationDisclosurePolicies : federationDisclosures;
  const id =
    kind === "disclosure-policy"
      ? federationDisclosurePolicies.policyId
      : federationDisclosures.grantId;
  const view = async (provider = false) =>
    (
      await db
        .select()
        .from(table)
        .where(
          and(
            eq(id, recordId),
            eq(table.localSiteId, provider ? f.provider.signing.siteId : f.source.signing.siteId),
          ),
        )
    )[0];
  const syncKey = and(
    eq(federationCommercialApprovalSyncs.localSiteId, f.source.signing.siteId),
    eq(federationCommercialApprovalSyncs.recordKind, kind),
    eq(federationCommercialApprovalSyncs.recordId, recordId),
  );
  const status = async () =>
    (await db.select().from(federationCommercialApprovalSyncs).where(syncKey))[0];
  const outboxes = () =>
    db
      .select()
      .from(federationCommercialSubmissions)
      .where(
        inArray(federationCommercialSubmissions.localSiteId, [
          f.source.signing.siteId,
          f.provider.signing.siteId,
        ]),
      );
  cleanup.push(async () => {
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        [f.source.signing.siteId, f.provider.signing.siteId].map(
          (site) => `disclosure-exchange:${site}`,
        ),
      ),
    );
  });
  return {
    ...f,
    policy,
    kind,
    recordId,
    approveSource,
    approveProvider,
    revoke,
    view,
    syncKey,
    status,
    outboxes,
    identity: { agreementRevisionId: f.revisionId, recordKind: kind, recordId },
  };
}

for (const kind of ["disclosure-policy", "disclosure"] as const) {
  test(`disclosure exchange ${kind} waits for independent consent and joins original signatures without money or ledger changes`, async () => {
    const f = await disclosureExchangeFixture(kind),
      before = await f.budget(),
      outboxes = await f.outboxes();
    const a = await f.approveSource();
    await f.sourceAuto.discover();
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "pending", lastError: null });
    expect(await f.view(true)).toBeUndefined();
    const b = await f.approveProvider();
    await f.providerAuto.discover();
    await f.due();
    await f.sourceAuto.advanceNext();
    await f.providerAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
    expect(await f.view()).toMatchObject({
      approvalJws: a.approvalJws,
      counterpartyJws: b.approvalJws,
    });
    expect(await f.view(true)).toMatchObject({
      approvalJws: b.approvalJws,
      counterpartyJws: a.approvalJws,
    });
    expect(await f.budget()).toEqual(before);
    expect(await f.outboxes()).toEqual(outboxes);
  });

  test(`disclosure exchange ${kind} rejects differing approved originals`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    await f.approveProvider(true);
    await f.sourceAuto.discover();
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({
      state: "needs_review",
      lastError: "OPERATION_CONFLICT",
    });
    expect((await f.view())?.counterpartyJws).toBeNull();
  });

  test(`disclosure exchange ${kind} survives lost responses and staff permission removal with institutional audit`, async () => {
    const f = await disclosureExchangeFixture(kind),
      a = await f.approveSource(),
      b = await f.approveProvider();
    await f.sourceAuto.discover();
    f.transport.afterResponse = async () => {
      throw new Error("Lost response");
    };
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "pending", lastError: "EXCHANGE_RETRY" });
    expect((await f.view())?.counterpartyJws).toBeNull();
    await new FederationPermissionService(db).set(
      { ...f.sourceActor, capability: "disclosure.approve", enabled: false },
      f.sourceActor.userId,
    );
    await expect(f.approveSource()).rejects.toThrow("POLICY_DENIED");
    delete f.transport.afterResponse;
    await f.due();
    const restarted = new FederationCommercialApprovalExchange(db, f.source.signing, f.sendSource);
    await restarted.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
    expect(await f.view()).toMatchObject({
      approvalJws: a.approvalJws,
      counterpartyJws: b.approvalJws,
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, f.recordId),
          eq(auditLog.actor, `disclosure-exchange:${f.source.signing.siteId}`),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  test(`disclosure exchange ${kind} rejects a revoked peer before returning its original signature`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    await f.approveProvider();
    await f.sourceAuto.discover();
    await f.revoke(true);
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({
      state: "needs_review",
      lastError: "AUTHORIZATION_EXPIRED",
    });
    expect((await f.view())?.counterpartyJws).toBeNull();
  });

  for (const change of ["local-revocation", "purpose", "recipient"] as const) {
    test(`disclosure exchange ${kind} rechecks ${change} after transport`, async () => {
      const f = await disclosureExchangeFixture(kind);
      await f.approveSource();
      await f.approveProvider();
      await f.sourceAuto.discover();
      f.transport.afterResponse = async (response) => {
        if (change === "local-revocation") await f.revoke();
        else if (change === "purpose")
          await db
            .update(federationSigningKeys)
            .set({
              allowedKinds: sql`${federationSigningKeys.allowedKinds} - ${`commercial-${kind}`}`,
            })
            .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
        else
          await db
            .update(federationSites)
            .set({ state: "suspended" })
            .where(eq(federationSites.id, f.recipient));
        return response;
      };
      await f.sourceAuto.advanceNext();
      expect(await f.status()).toMatchObject({
        state: "needs_review",
        lastError: change === "local-revocation" ? "AUTHORIZATION_EXPIRED" : "UNTRUSTED_IDENTITY",
      });
      expect((await f.view())?.counterpartyJws).toBeNull();
    });
  }

  test(`disclosure exchange ${kind} fences late writes and requires independent retry authority`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    await f.approveProvider();
    await f.sourceAuto.discover();
    const token = randomUUID();
    f.transport.afterResponse = async (response) => {
      await db
        .update(federationCommercialApprovalSyncs)
        .set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
        .where(f.syncKey);
      return response;
    };
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "pending", leaseToken: token });
    expect((await f.view())?.counterpartyJws).toBeNull();
    await new FederationPermissionService(db).set(
      { ...f.sourceActor, capability: "disclosure.approve", enabled: false },
      f.sourceActor.userId,
    );
    await expect(f.sourceAuto.retry(f.sourceActor, f.identity)).rejects.toThrow("POLICY_DENIED");
    await new FederationPermissionService(db).set(
      { ...f.sourceActor, capability: "disclosure.approve", enabled: true },
      f.sourceActor.userId,
    );
    await expect(f.sourceAuto.retry(f.sourceActor, f.identity)).rejects.toThrow(
      "OPERATION_CONFLICT",
    );
    await db
      .update(federationCommercialApprovalSyncs)
      .set({ leaseUntil: new Date(0) })
      .where(f.syncKey);
    await f.sourceAuto.retry(f.sourceActor, f.identity);
    delete f.transport.afterResponse;
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
  });

  test(`disclosure exchange ${kind} rolls back signature and queue completion when audit fails`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    await f.approveProvider();
    await f.sourceAuto.discover();
    await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT disclosure_exchange_audit_fixture
      CHECK (actor NOT LIKE 'disclosure-exchange:%') NOT VALID`);
    try {
      await f.sourceAuto.advanceNext();
    } finally {
      await db.execute(
        sql`ALTER TABLE audit_log DROP CONSTRAINT disclosure_exchange_audit_fixture`,
      );
    }
    expect(await f.status()).toMatchObject({ state: "pending", lastError: "EXCHANGE_RETRY" });
    expect((await f.view())?.counterpartyJws).toBeNull();
    await f.due();
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
  });
}

test("disclosure exchange policy can collect future consent without authorizing early material disclosure", async () => {
  const f = await disclosureExchangeFixture("disclosure-policy");
  f.policy.validFrom = new Date(Date.now() + 60000).toISOString();
  await f.approveSource();
  await f.approveProvider();
  await f.sourceAuto.discover();
  await f.sourceAuto.advanceNext();
  expect(await f.status()).toMatchObject({ state: "complete" });
  await expect(
    db.transaction((tx) => f.sourcePolicy.verified(tx, f.sourceActor, f.revisionId, f.recordId)),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("disclosure exchange grant rechecks its policy after transport", async () => {
  const f = await disclosureExchangeFixture("disclosure");
  await f.approveSource();
  await f.approveProvider();
  await f.sourceAuto.discover();
  f.transport.afterResponse = async (response) => {
    await f.sourcePolicy.revoke(f.sourceActor, f.revisionId, f.value.grant.policyId);
    return response;
  };
  await f.sourceAuto.advanceNext();
  expect(await f.status()).toMatchObject({
    state: "needs_review",
    lastError: "AUTHORIZATION_EXPIRED",
  });
  expect((await f.view())?.counterpartyJws).toBeNull();
});

for (const kind of ["disclosure-policy", "disclosure"] as const) {
  test(`disclosure exchange ${kind} production ingress returns only peer-bound existing signatures`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    const b = await f.approveProvider();
    const ingress = createFederationIngress(db, f.provider.signing);
    const send: FederationSend = async (_endpoint, jws, path) => {
      expect(path).toBe("/federation/v1/commercial-approvals");
      const request = (fingerprint?: string) =>
        ingress.request("/federation/v1/commercial-approvals", {
          method: "POST",
          body: jws,
          headers: {
            "content-type": "application/jose",
            ...(fingerprint ? { "x-kq-federation-cert": fingerprint } : {}),
          },
        });
      expect((await request()).status).toBe(401);
      expect((await request(f.providerFingerprint)).status).toBe(401);
      const response = await request(f.fingerprint);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/jose");
      expect(await response.clone().text()).toBe(b.approvalJws);
      return response.text();
    };
    const worker = new FederationCommercialApprovalExchange(db, f.source.signing, send);
    await worker.discover();
    await worker.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
  });

  test(`disclosure exchange ${kind} reconciles a manual attachment without duplicate audit or transport`, async () => {
    const f = await disclosureExchangeFixture(kind);
    await f.approveSource();
    const b = await f.approveProvider();
    await f.sourceAuto.discover();
    const service = kind === "disclosure-policy" ? f.sourcePolicy : f.service;
    await service.attachCounterparty(f.sourceActor, f.revisionId, f.recordId, b.approvalJws);
    await f.sourceAuto.advanceNext();
    expect(await f.status()).toMatchObject({ state: "complete" });
    expect(f.transport.calls).toBe(0);
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target, f.recordId),
            eq(
              auditLog.action,
              kind === "disclosure-policy"
                ? "federation.disclosure_policy.confirm"
                : "federation.disclosure.confirm",
            ),
            eq(auditLog.orgId, f.sourceActor.orgId),
          ),
        ),
    ).toHaveLength(1);
  });
}

async function disclosureReadFixture() {
  const f = await disclosureFixture(),
    keys = await testKeys(f.recipient);
  const fingerprint = randomUUID().replaceAll("-", "").repeat(2);
  cleanup.push(async () => {
    const sites = [f.source.signing.siteId, f.provider.signing.siteId];
    await db
      .delete(federationDisclosureReadAuthorizations)
      .where(inArray(federationDisclosureReadAuthorizations.localSiteId, sites));
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        sites.map((site) => `disclosure-read:${site}`),
      ),
    );
    await db
      .delete(federationCertificates)
      .where(eq(federationCertificates.fingerprint, fingerprint));
    await db.delete(federationSigningKeys).where(eq(federationSigningKeys.siteId, f.recipient));
  });
  await f.confirm(f.value);
  await f.trust.addKey(
    f.recipient,
    {
      keyId: keys.signing.keyId,
      publicKeyPem: await exportSPKI(keys.verification.publicKey),
      allowedKinds: ["commercial-disclosure-read-query"],
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
    },
    f.actor.userId,
  );
  await db.insert(federationCertificates).values({
    fingerprint,
    siteId: f.recipient,
    certificatePem: "Authenticated recipient fixture; separate TLS suite tests certificates",
    validFrom: new Date("2020-01-01"),
    validUntil: new Date("2099-01-01"),
  });
  for (const site of [f.source.signing.siteId, f.provider.signing.siteId])
    await db
      .update(federationSigningKeys)
      .set({
        allowedKinds: sql`${federationSigningKeys.allowedKinds} || '["commercial-disclosure-read-authorization"]'::jsonb`,
      })
      .where(eq(federationSigningKeys.siteId, site));
  const [record] = (await f.service.list(f.sourceActor, f.revisionId)).data;
  if (!record) throw new Error("Missing approved material");
  const g = record.payload.grant;
  const scope = CommercialDisclosureReadScopeSchema.parse({
    grantId: g.grantId,
    disclosureDigest: record.digest,
    caseId: g.caseId,
    policyId: g.policyId,
    policyDigest: g.policyDigest,
    domainId: g.domainId,
    agreementRevisionId: g.agreementRevisionId,
    agreementDigest: f.policy.agreementDigest,
    sourceSiteId: g.sourceSiteId,
    targetSiteId: g.targetSiteId,
    evidenceRecipientSiteId: g.recipientSiteId,
  });
  const a = new FederationDisclosureReadResponder(db, f.source.signing),
    b = new FederationDisclosureReadResponder(db, f.provider.signing);
  const transport: { afterResponse?: (jws: string, site: string) => Promise<string> } = {};
  const send: FederationSend = async (_endpoint, jws, path) => {
    expect(path).toBe("/federation/v1/disclosure-authorizations");
    const query = await verifyFederationMessage(
      CommercialDisclosureReadQuerySchema,
      jws,
      { ...keys.verification, allowedKinds: ["commercial-disclosure-read-query"] },
      new Date(),
    );
    const responder = query.payload.recipientSiteId === f.source.signing.siteId ? a : b;
    const response = await responder.receive(jws, fingerprint);
    return transport.afterResponse
      ? transport.afterResponse(response, query.payload.recipientSiteId)
      : response;
  };
  const client = new FederationDisclosureReadClient(db, keys.signing, send);
  const query = async (patch = {}) => {
    const now = new Date();
    return signFederationMessage(
      CommercialDisclosureReadQuerySchema,
      CommercialDisclosureReadQuerySchema.parse({
        protocolVersion: 1,
        kind: "commercial-disclosure-read-query",
        readId: randomUUID(),
        queryId: randomUUID(),
        senderSiteId: f.recipient,
        recipientSiteId: f.source.signing.siteId,
        scope,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30000).toISOString(),
        ...patch,
      }),
      keys.signing,
    );
  };
  const rows = () =>
    db
      .select()
      .from(federationDisclosureReadAuthorizations)
      .where(eq(federationDisclosureReadAuthorizations.grantId, scope.grantId));
  return { ...f, keys, fingerprint, scope, a, b, client, query, rows, send, transport };
}

test("disclosure read obtains both current independent authorizations without private values or new ledger work", async () => {
  const f = await disclosureReadFixture(),
    budget = await f.budget();
  const pair = await f.client.request(f.scope);
  expect(pair.authorizations).toHaveLength(2);
  expect(pair.authorizations.map((v) => v.authorization.senderSiteId)).toEqual([
    f.source.signing.siteId,
    f.provider.signing.siteId,
  ]);
  for (const item of pair.authorizations) {
    expect(item.authorization.readId).toBe(pair.readId);
    expect(item.authorization.scope).toEqual(f.scope);
    expect(Object.keys(item.authorization)).not.toContain("values");
    expect(Object.keys(item.authorization)).not.toContain("approvalJws");
    expect(
      Date.parse(item.authorization.expiresAt) - Date.parse(item.authorization.issuedAt),
    ).toBeLessThanOrEqual(30000);
  }
  expect(await f.rows()).toHaveLength(2);
  expect(await f.budget()).toEqual(budget);
});

test("disclosure read replay and service restart preserve original signature and audit but recheck revocation", async () => {
  const f = await disclosureReadFixture(),
    query = await f.query();
  const [a, b] = await Promise.all([
    f.a.receive(query, f.fingerprint),
    f.a.receive(query, f.fingerprint),
  ]);
  expect(a).toBe(b);
  const restarted = new FederationDisclosureReadResponder(db, f.source.signing);
  expect(await restarted.receive(query, f.fingerprint)).toBe(a);
  expect(await f.rows()).toHaveLength(1);
  const row = (await f.rows())[0];
  expect(
    await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, row?.queryId ?? "")),
  ).toHaveLength(1);
  await f.service.revoke(f.sourceActor, f.revisionId, f.scope.grantId);
  await expect(restarted.receive(query, f.fingerprint)).rejects.toThrow("AUTHORIZATION_EXPIRED");
  expect((await f.rows())[0]?.responseJws).toBe(a);
});

for (const changed of ["policy", "grant", "purpose", "recipient", "case"] as const) {
  test(`disclosure read refuses ${changed} invalidation even with historical dual approval`, async () => {
    const f = await disclosureReadFixture();
    if (changed === "policy")
      await f.providerPolicy.revoke(f.actor, f.revisionId, f.scope.policyId);
    else if (changed === "grant") await f.peer.revoke(f.actor, f.revisionId, f.scope.grantId);
    else if (changed === "purpose")
      await db
        .update(federationSigningKeys)
        .set({
          allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-disclosure-read-authorization'`,
        })
        .where(eq(federationSigningKeys.siteId, f.provider.signing.siteId));
    else if (changed === "recipient")
      await db
        .update(federationSites)
        .set({ state: "suspended" })
        .where(eq(federationSites.id, f.recipient));
    else
      await db
        .update(federationDisputes)
        .set({ state: "RESOLVED" })
        .where(
          and(
            eq(federationDisputes.localSiteId, f.provider.signing.siteId),
            eq(federationDisputes.caseId, f.scope.caseId),
          ),
        );
    await expect(f.client.request(f.scope)).rejects.toThrow();
  });
}

test("disclosure read binds full scope and request identity rather than accepting a known grant ID", async () => {
  const f = await disclosureReadFixture();
  for (const field of ["caseId", "policyId", "agreementRevisionId", "domainId"] as const)
    await expect(
      f.a.receive(await f.query({ scope: { ...f.scope, [field]: randomUUID() } }), f.fingerprint),
    ).rejects.toThrow();
  for (const field of ["disclosureDigest", "policyDigest", "agreementDigest"] as const)
    await expect(
      f.a.receive(
        await f.query({ scope: { ...f.scope, [field]: `sha256:${"d".repeat(64)}` } }),
        f.fingerprint,
      ),
    ).rejects.toThrow();
  const queryId = randomUUID();
  await f.a.receive(await f.query({ queryId }), f.fingerprint);
  await expect(f.a.receive(await f.query({ queryId }), f.fingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  expect(await f.rows()).toHaveLength(1);
});

test("disclosure read client refuses unavailable parties and responses bound to another read", async () => {
  const f = await disclosureReadFixture();
  const prior = await f.client.request(f.scope);
  const offline = new FederationDisclosureReadClient(db, f.keys.signing, async () => {
    throw new Error("Peer offline");
  });
  await expect(offline.request(f.scope)).rejects.toThrow("Peer offline");
  f.transport.afterResponse = async (_response, site) =>
    prior.authorizations.find((v) => v.authorization.senderSiteId === site)?.authorizationJws ?? "";
  await expect(f.client.request(f.scope)).rejects.toThrow("INVALID_MESSAGE");
});

for (const changed of ["endpoint", "purpose", "expiry"] as const) {
  test(`disclosure read client rechecks ${changed} after both network replies`, async () => {
    const f = await disclosureReadFixture();
    f.transport.afterResponse = async (response, site) => {
      if (site === f.provider.signing.siteId) {
        if (changed === "endpoint")
          await db
            .update(federationSites)
            .set({ endpoint: "https://changed.test.invalid" })
            .where(eq(federationSites.id, site));
        else if (changed === "purpose")
          await db
            .update(federationSigningKeys)
            .set({
              allowedKinds: sql`${federationSigningKeys.allowedKinds} - 'commercial-disclosure-read-authorization'`,
            })
            .where(eq(federationSigningKeys.siteId, site));
        else setSystemTime(new Date(Date.now() + 31000));
      }
      return response;
    };
    try {
      await expect(f.client.request(f.scope)).rejects.toThrow();
    } finally {
      setSystemTime();
    }
  });
}

test("disclosure read authorization expiry is bounded by recipient key lifetime", async () => {
  const f = await disclosureReadFixture();
  const until = new Date(Date.now() + 15000);
  await db
    .update(federationSigningKeys)
    .set({ validUntil: until })
    .where(eq(federationSigningKeys.siteId, f.recipient));
  const pair = await f.client.request(f.scope);
  for (const item of pair.authorizations)
    expect(Date.parse(item.authorization.expiresAt)).toBeLessThanOrEqual(until.getTime());
});

test("disclosure read audit failure leaves no issued authorization and retries the same request", async () => {
  const f = await disclosureReadFixture(),
    query = await f.query();
  await db.execute(
    sql`ALTER TABLE audit_log ADD CONSTRAINT disclosure_read_audit_fixture CHECK (action <> 'federation.disclosure.read_authorization') NOT VALID`,
  );
  try {
    await expect(f.a.receive(query, f.fingerprint)).rejects.toThrow();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT disclosure_read_audit_fixture`);
  }
  expect(await f.rows()).toHaveLength(0);
  await f.a.receive(query, f.fingerprint);
  expect(await f.rows()).toHaveLength(1);
});

test("disclosure read production ingress requires certificate identity and dedicated recipient signing purpose", async () => {
  const f = await disclosureReadFixture(),
    query = await f.query();
  const ingress = createFederationIngress(db, f.source.signing);
  const post = (fingerprint?: string) =>
    ingress.request("/federation/v1/disclosure-authorizations", {
      method: "POST",
      body: query,
      headers: {
        "content-type": "application/jose",
        ...(fingerprint ? { "x-kq-federation-cert": fingerprint } : {}),
      },
    });
  expect((await post()).status).toBe(401);
  expect((await post(f.providerFingerprint)).status).toBe(401);
  const response = await post(f.fingerprint);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await db
    .update(federationSigningKeys)
    .set({ allowedKinds: ["commercial-disclosure"] })
    .where(eq(federationSigningKeys.siteId, f.recipient));
  expect((await post(f.fingerprint)).status).toBe(401);
});

async function disclosureDeliveryFixture() {
  const f = await disclosureReadFixture(),
    receiverActor = { userId: randomUUID(), orgId: randomUUID() };
  cleanup.push(async () => {
    await db
      .delete(federationReceivedDisclosures)
      .where(eq(federationReceivedDisclosures.localSiteId, f.recipient));
    await db
      .delete(federationEvidenceCases)
      .where(eq(federationEvidenceCases.localSiteId, f.recipient));
    await db
      .delete(federationDisclosureDownloads)
      .where(eq(federationDisclosureDownloads.grantId, f.scope.grantId));
    await db
      .delete(auditLog)
      .where(
        inArray(auditLog.actor, [
          receiverActor.userId,
          `disclosure-download:${f.source.signing.siteId}`,
        ]),
      );
    await db
      .delete(federationCapabilities)
      .where(eq(federationCapabilities.orgId, receiverActor.orgId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, receiverActor.orgId));
    await db.delete(users).where(eq(users.id, receiverActor.userId));
    await db.delete(orgs).where(eq(orgs.id, receiverActor.orgId));
  });
  await db.insert(orgs).values({ id: receiverActor.orgId, name: "Recipient institution" });
  await db.insert(users).values({
    id: receiverActor.userId,
    orgId: receiverActor.orgId,
    email: `${receiverActor.userId}@test.invalid`,
    role: "platform_admin",
  });
  await db.insert(userOrgMemberships).values({ ...receiverActor, role: "owner" });
  await new FederationPermissionService(db).set(
    { ...receiverActor, capability: "disclosure.receive", enabled: true },
    receiverActor.userId,
  );
  await db
    .update(federationSigningKeys)
    .set({
      allowedKinds: ["commercial-disclosure-read-query", "commercial-disclosure-download-query"],
    })
    .where(eq(federationSigningKeys.siteId, f.recipient));
  const responder = new FederationDisclosureDownloadResponder(db, f.source.signing);
  const io: {
    calls: number;
    before?: () => Promise<void>;
    after?: (jws: string) => Promise<string>;
  } = { calls: 0 };
  const send: FederationSend = async (endpoint, jws, path) => {
    if (path === "/federation/v1/disclosure-authorizations") return f.send(endpoint, jws, path);
    expect(path).toBe("/federation/v1/disclosure-downloads");
    io.calls++;
    await io.before?.();
    const response = await responder.receive(jws, f.fingerprint);
    return io.after ? io.after(response) : response;
  };
  const receiver = new FederationEvidenceService(db, f.keys.signing, send);
  const {
    caseId,
    domainId,
    agreementRevisionId,
    agreementDigest,
    sourceSiteId,
    targetSiteId,
    evidenceRecipientSiteId,
  } = f.scope;
  const context = CommercialEvidenceCaseInputSchema.parse({
    caseId,
    domainId,
    agreementRevisionId,
    agreementDigest,
    sourceSiteId,
    targetSiteId,
    evidenceRecipientSiteId,
  });
  await receiver.register(receiverActor, context);
  const imported = () =>
    db
      .select()
      .from(federationReceivedDisclosures)
      .where(eq(federationReceivedDisclosures.localSiteId, f.recipient));
  const downloadQuery = async () => {
    const pair = await f.client.request(f.scope),
      now = new Date();
    const q = CommercialDisclosureDownloadQuerySchema.parse({
      protocolVersion: 1,
      kind: "commercial-disclosure-download-query",
      readId: pair.readId,
      queryId: randomUUID(),
      senderSiteId: f.recipient,
      recipientSiteId: f.source.signing.siteId,
      scope: f.scope,
      authorizations: CommercialDisclosureReadPairSchema.parse(
        pair.authorizations.map(({ queryJws, authorizationJws }) => ({
          queryJws,
          authorizationJws,
        })),
      ),
      part: "disclosure-source",
      issuedAt: now.toISOString(),
      expiresAt: new Date(
        Math.min(...pair.authorizations.map((v) => Date.parse(v.authorization.expiresAt))),
      ).toISOString(),
    });
    return {
      q,
      jws: await signFederationMessage(CommercialDisclosureDownloadQuerySchema, q, f.keys.signing),
    };
  };
  return { ...f, receiverActor, receiver, responder, io, send, context, imported, downloadQuery };
}

test("disclosure delivery imports only complete dual-signed projections and preserves exact originals on replay", async () => {
  const f = await disclosureDeliveryFixture(),
    before = await f.budget();
  const payload = await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope);
  expect(payload).toEqual(f.value);
  expect(payload.evidence).toEqual({ recordType: "payment", values: { amount: "7" } });
  expect(f.io.calls).toBe(4);
  const [stored] = await f.imported();
  expect(stored?.evidence.disclosure.sourceJws).toBe(
    (await f.service.list(f.sourceActor, f.revisionId)).data[0]?.approvalJws,
  );
  expect(stored?.evidence.disclosure.targetJws).toBe(
    (await f.peer.list(f.actor, f.revisionId)).data[0]?.approvalJws,
  );
  expect(await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).toEqual(payload);
  expect(await f.imported()).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "federation.evidence.receive"),
          eq(auditLog.target, f.scope.grantId),
        ),
      ),
  ).toHaveLength(1);
  const restarted = new FederationEvidenceService(db, f.keys.signing, f.send);
  expect(await restarted.read(f.receiverActor, f.scope.caseId, f.scope.grantId)).toEqual(payload);
  expect(await f.budget()).toEqual(before);
});

for (const failure of ["partial", "wrong-part", "tamper"] as const) {
  test(`disclosure delivery rejects ${failure} transfer without a readable stored record`, async () => {
    const f = await disclosureDeliveryFixture();
    let first = "";
    f.io.after = async (response) => {
      first ||= response;
      if (failure === "partial" && f.io.calls === 4) throw new Error("Lost final part");
      if (failure === "wrong-part" && f.io.calls === 4) return first;
      if (failure === "tamper" && f.io.calls === 4) return `${response.slice(0, -10)}altered1234`;
      return response;
    };
    await expect(f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).rejects.toThrow();
    expect(await f.imported()).toHaveLength(0);
  });
}

test("disclosure delivery checks local revocation again after collecting both read authorizations", async () => {
  const f = await disclosureDeliveryFixture();
  f.io.before = async () => {
    await f.service.revoke(f.sourceActor, f.revisionId, f.scope.grantId);
  };
  await expect(f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).rejects.toThrow(
    "AUTHORIZATION_EXPIRED",
  );
  expect(await f.imported()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(federationDisclosureDownloads)
      .where(eq(federationDisclosureDownloads.grantId, f.scope.grantId)),
  ).toHaveLength(0);
});

for (const changed of [
  "permission",
  "closed-case",
  "download-purpose",
  "endpoint",
  "expiry",
] as const) {
  test(`disclosure delivery rechecks recipient ${changed} before publication`, async () => {
    const f = await disclosureDeliveryFixture();
    f.io.after = async (response) => {
      if (f.io.calls === 4) {
        if (changed === "permission")
          await new FederationPermissionService(db).set(
            { ...f.receiverActor, capability: "disclosure.receive", enabled: false },
            f.receiverActor.userId,
          );
        else if (changed === "closed-case") await f.receiver.close(f.receiverActor, f.scope.caseId);
        else if (changed === "download-purpose")
          await db
            .update(federationSigningKeys)
            .set({ allowedKinds: ["commercial-disclosure-read-query"] })
            .where(eq(federationSigningKeys.siteId, f.recipient));
        else if (changed === "endpoint")
          await db
            .update(federationSites)
            .set({ endpoint: "https://changed.test.invalid" })
            .where(eq(federationSites.id, f.source.signing.siteId));
        else setSystemTime(new Date(Date.now() + 31000));
      }
      return response;
    };
    try {
      await expect(f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).rejects.toThrow();
    } finally {
      setSystemTime();
    }
    expect(await f.imported()).toHaveLength(0);
  });
}

test("disclosure delivery stored evidence cannot bypass remote revocation or offline authorization", async () => {
  const f = await disclosureDeliveryFixture();
  await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope);
  const offline = new FederationEvidenceService(db, f.keys.signing, async () => {
    throw new Error("Peer offline");
  });
  await expect(offline.read(f.receiverActor, f.scope.caseId, f.scope.grantId)).rejects.toThrow(
    "Peer offline",
  );
  await f.providerPolicy.revoke(f.actor, f.revisionId, f.scope.policyId);
  await expect(f.receiver.read(f.receiverActor, f.scope.caseId, f.scope.grantId)).rejects.toThrow();
  const list = await f.receiver.materials(f.receiverActor, f.scope.caseId);
  expect(list.data).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain("amount");
  expect(JSON.stringify(list)).not.toContain("Jws");
  expect(await f.imported()).toHaveLength(1);
});

test("disclosure delivery recipient case ownership and independent permission cannot be replaced", async () => {
  const f = await disclosureDeliveryFixture();
  await new FederationPermissionService(db).set(
    { ...f.sourceActor, capability: "disclosure.receive", enabled: true },
    f.sourceActor.userId,
  );
  await expect(f.receiver.register(f.sourceActor, f.context)).rejects.toThrow("OPERATION_CONFLICT");
  await expect(f.receiver.import(f.sourceActor, f.scope.caseId, f.scope)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.receiver.materials(f.sourceActor, f.scope.caseId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  expect((await f.receiver.list(f.sourceActor)).data).toHaveLength(0);
  await new FederationPermissionService(db).set(
    { ...f.receiverActor, capability: "disclosure.receive", enabled: false },
    f.receiverActor.userId,
  );
  await expect(f.receiver.list(f.receiverActor)).rejects.toThrow("POLICY_DENIED");
  await expect(f.receiver.register(f.receiverActor, f.context)).rejects.toThrow("POLICY_DENIED");
});

test("disclosure delivery local case closure retains metadata and never reopens or changes the original dispute", async () => {
  const f = await disclosureDeliveryFixture();
  await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope);
  const before = await db
    .select()
    .from(federationDisputes)
    .where(eq(federationDisputes.caseId, f.scope.caseId));
  await f.receiver.close(f.receiverActor, f.scope.caseId);
  await f.receiver.close(f.receiverActor, f.scope.caseId);
  await expect(f.receiver.read(f.receiverActor, f.scope.caseId, f.scope.grantId)).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(f.receiver.register(f.receiverActor, f.context)).rejects.toThrow("POLICY_DENIED");
  expect((await f.receiver.materials(f.receiverActor, f.scope.caseId)).data).toHaveLength(1);
  expect(
    await db.select().from(federationDisputes).where(eq(federationDisputes.caseId, f.scope.caseId)),
  ).toEqual(before);
});

test("disclosure delivery source audit and replay are atomic and revoked old requests cannot download", async () => {
  const f = await disclosureDeliveryFixture(),
    { q, jws } = await f.downloadQuery();
  await db.execute(
    sql`ALTER TABLE audit_log ADD CONSTRAINT disclosure_download_audit_fixture CHECK (action <> 'federation.disclosure.download') NOT VALID`,
  );
  try {
    await expect(f.responder.receive(jws, f.fingerprint)).rejects.toThrow();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT disclosure_download_audit_fixture`);
  }
  expect(
    await db
      .select()
      .from(federationDisclosureDownloads)
      .where(eq(federationDisclosureDownloads.grantId, f.scope.grantId)),
  ).toHaveLength(0);
  const a = await f.responder.receive(jws, f.fingerprint);
  expect(
    await new FederationDisclosureDownloadResponder(db, f.source.signing).receive(
      jws,
      f.fingerprint,
    ),
  ).toBe(a);
  const replacement = await signFederationMessage(
    CommercialDisclosureDownloadQuerySchema,
    { ...q, part: "disclosure-target" },
    f.keys.signing,
  );
  await expect(f.responder.receive(replacement, f.fingerprint)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.service.revoke(f.sourceActor, f.revisionId, f.scope.grantId);
  await expect(f.responder.receive(jws, f.fingerprint)).rejects.toThrow("AUTHORIZATION_EXPIRED");
});

test("disclosure delivery recipient audit failure rolls back storage and permits a fresh retry", async () => {
  const f = await disclosureDeliveryFixture();
  await db.execute(
    sql`ALTER TABLE audit_log ADD CONSTRAINT evidence_receive_audit_fixture CHECK (action <> 'federation.evidence.receive') NOT VALID`,
  );
  try {
    await expect(f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).rejects.toThrow();
  } finally {
    await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT evidence_receive_audit_fixture`);
  }
  expect(await f.imported()).toHaveLength(0);
  expect(await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope)).toEqual(f.value);
});

test("disclosure delivery production ingress binds both authorizations to the requested recipient and read", async () => {
  const f = await disclosureDeliveryFixture(),
    { q, jws } = await f.downloadQuery();
  const ingress = createFederationIngress(db, f.source.signing);
  const post = (body = jws, cert = f.fingerprint) =>
    ingress.request("/federation/v1/disclosure-downloads", {
      method: "POST",
      body,
      headers: { "content-type": "application/jose", "x-kq-federation-cert": cert },
    });
  expect((await post(jws, "")).status).toBe(401);
  expect((await post(jws, f.providerFingerprint)).status).toBe(401);
  const swapped = await signFederationMessage(
    CommercialDisclosureDownloadQuerySchema,
    { ...q, authorizations: [q.authorizations[1], q.authorizations[0]] },
    f.keys.signing,
  );
  expect((await post(swapped)).status).toBe(401);
  const otherRead = await signFederationMessage(
    CommercialDisclosureDownloadQuerySchema,
    { ...q, readId: randomUUID() },
    f.keys.signing,
  );
  expect((await post(otherRead)).status).toBe(409);
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const original = (await f.service.list(f.sourceActor, f.revisionId)).data[0];
  if (!original) throw new Error("Missing approved disclosure");
  expect(await response.text()).toBe(original.approvalJws);
});

test("disclosure delivery human API enforces organization strict inputs and no-store for actual projected values", async () => {
  const f = await disclosureDeliveryFixture(),
    app = new Hono();
  let automation = false,
    actor = f.receiverActor;
  app.onError(createErrorHandler(pino({ enabled: false })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/", createFederationEvidenceRoutes(f.receiver));
  const root = "/federation/evidence-cases",
    path = `${root}/${f.scope.caseId}/disclosures`;
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await app.request(root)).status).toBe(200);
  expect((await post(root, { ...f.context, localOrgId: randomUUID() })).status).toBe(400);
  expect((await post(path, { ...f.scope, values: {} })).status).toBe(400);
  const imported = await post(path, f.scope);
  expect(imported.status).toBe(201);
  expect(imported.headers.get("cache-control")).toBe("no-store");
  expect(await imported.json()).toEqual({ disclosure: f.value });
  expect((await app.request(`${path}/${f.scope.grantId}`)).status).toBe(200);
  for (const [code, status] of [
    ["DELIVERY_UNAVAILABLE", 503],
    ["INVALID_RECEIPT_RESPONSE", 502],
  ] as const) {
    f.io.before = async () => {
      throw new FederationDeliveryError(code);
    };
    const unavailable = await post(path, f.scope);
    expect(unavailable.status).toBe(status);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toEqual({ error: { code } });
  }
  f.io.before = undefined;
  automation = true;
  expect((await app.request(root)).status).toBe(403);
  automation = false;
  actor = f.sourceActor;
  expect((await app.request(`${path}/${f.scope.grantId}`)).status).toBe(403);
});

test("disclosure delivery expiration while waiting for the publication lock cannot return prior cached values", async () => {
  const f = await disclosureDeliveryFixture();
  await f.receiver.import(f.receiverActor, f.scope.caseId, f.scope);
  let release: () => void = () => {},
    locked: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`received-disclosure:${f.recipient}:${f.scope.grantId}`}, 0))`,
    );
    locked();
    await hold;
  });
  await acquired;
  const pending = f.receiver.import(f.receiverActor, f.scope.caseId, f.scope).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  try {
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      const result = await db.execute(
        sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
      );
      if (Number(result[0]?.count) > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    setSystemTime(new Date(Date.now() + 31000));
    release();
    await blocker;
    const result = await pending;
    expect(result.value).toBeNull();
    expect(result.error).toBeTruthy();
  } finally {
    release();
    await blocker;
    await pending;
    setSystemTime();
  }
  expect(await f.imported()).toHaveLength(1);
});
