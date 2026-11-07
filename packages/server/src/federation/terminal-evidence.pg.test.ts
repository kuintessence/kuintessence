import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  federationCommercialAgreements,
  federationCommercialApprovalSyncs,
  federationCommercialAttempts,
  federationCommercialBills,
  federationCommercialDiscounts,
  federationCommercialSubmissions,
  federationOutbound,
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
} from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  type CommercialUsageCorrectionInput,
  CommercialUsageSchema,
  commercialAutomaticMeters,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialUsagePageSchema,
  CommercialUsageQuerySchema,
} from "@kuintessence/shared/federation/usage-exchange";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { revokeDataDeliveryJobs } from "../services/data-delivery";
import { DataGrantRevocationCoordinator } from "../services/data-delivery-revocations";
import { JobService } from "../services/job-service";
import { FederationAccountingCollection } from "./accounting-collection";
import { federationMaterialDigest } from "./assets";
import { FederationBillingService } from "./billing";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FabricClientFailure } from "./fabric-client";
import { createFederationIngress } from "./ingress";
import type { FederationSend } from "./outbound-client";
import { FederationPermissionService } from "./permissions";
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
