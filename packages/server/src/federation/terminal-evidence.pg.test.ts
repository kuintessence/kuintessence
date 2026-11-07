import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agentJobStatusEvents,
  agents,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  federationAgreements,
  federationBudgets,
  federationReservations,
  federationTerminalEvidence,
  federationWorkflowBindings,
  jobDataBindings,
  jobs,
  orgs,
  users,
  workflowExecutionJobs,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import { FederationAcceptanceSchema } from "@kuintessence/shared/federation";
import { eq, sql } from "drizzle-orm";
import { revokeDataDeliveryJobs } from "../services/data-delivery";
import { DataGrantRevocationCoordinator } from "../services/data-delivery-revocations";
import { JobService } from "../services/job-service";
import { federationMaterialDigest } from "./assets";
import { testAgreement, testDelegation } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Terminal evidence tests require an isolated kuintessence_unit_* database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

async function fixture(
  options: { federated?: boolean; startedAt?: Date | null; scheduler?: string } = {},
) {
  const orgId = randomUUID(),
    userId = randomUUID(),
    jobId = randomUUID(),
    runId = randomUUID();
  const agentId = `terminal-${randomUUID()}`,
    reservationId = randomUUID();
  const terms = testAgreement(randomUUID(), randomUUID());
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
  const finish = (eventId = "completion") =>
    service.updateStatus(
      jobId,
      "completed",
      "scheduler-42",
      agentId,
      undefined,
      0,
      { result: "private output probe" },
      eventId,
      { node: "node-1" },
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
