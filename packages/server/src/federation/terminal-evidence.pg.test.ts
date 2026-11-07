import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agentJobStatusEvents,
  agents,
  auditLog,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationCommercialAgreements,
  federationCommercialAttempts,
  federationCommercialSubmissions,
  federationReservations,
  federationSigningKeys,
  federationSites,
  federationTerminalEvidence,
  federationUsageReports,
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
import {
  FederationAcceptanceSchema,
  type FederationAgreement,
} from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialUsageSchema,
  commercialAutomaticMeters,
} from "@kuintessence/shared/federation/commercial";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "../routes/federation-commercial";
import { revokeDataDeliveryJobs } from "../services/data-delivery";
import { DataGrantRevocationCoordinator } from "../services/data-delivery-revocations";
import { JobService } from "../services/job-service";
import { federationMaterialDigest } from "./assets";
import { FederationCommercialAgreementService } from "./commercial-agreements";
import { FederationCommercialSubmissionService } from "./commercial-submissions";
import { FederationCommercialWorker } from "./commercial-worker";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";
import { FederationUsageService } from "./usage";

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
