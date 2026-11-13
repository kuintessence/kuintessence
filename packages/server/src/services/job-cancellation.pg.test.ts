import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  agents,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  jobCancellations,
  jobDataBindings,
  jobs,
  softwareOperations,
  users,
  workflowRuns,
} from "@kuintessence/db";
import type { ServerMessage } from "@kuintessence/proto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AgentDispatcher, JobCancellationOutbox } from "../grpc/dispatcher";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { cancelWorkflowJobs } from "../workflow/cancel-jobs";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { revokeDataDeliveryJobs } from "./data-delivery";
import { DataGrantRevocationCoordinator } from "./data-delivery-revocations";
import { JobService } from "./job-service";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Cancellation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const userId = crypto.randomUUID();
const agentIds = ["installer-a", "installer-b", "compute"].map(
  (name) => `${name}-${crypto.randomUUID()}`,
);
const [installerA, installerB, compute] = agentIds as [string, string, string];
const jobIds: string[] = [];
const service = new JobService(db);

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, role: "user" });
  await db.insert(agents).values(
    agentIds.map((agentId) => ({
      agentId,
      siteName: "cancellation fixture",
      schedulerType: "slurm",
      schedulerVersion: "fixture",
    })),
  );
});
afterAll(async () => {
  await db.delete(jobs).where(inArray(jobs.id, jobIds));
  await db.delete(softwareOperations).where(inArray(softwareOperations.agentId, agentIds));
  await db.delete(agents).where(inArray(agents.agentId, agentIds));
  await db.delete(dataAssets).where(eq(dataAssets.ownerUserId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

async function fixture(status = "pending", computeAgent: string | null = null) {
  const id = crypto.randomUUID();
  jobIds.push(id);
  await db.insert(jobs).values({
    id,
    name: "federation cancellation",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    submittedBy: userId,
    agentId: computeAgent,
    status,
    dispatchEpoch: computeAgent ? 2 : 0,
  });
  await db.insert(softwareOperations).values(
    [
      { agentId: installerA, status: "running" },
      { agentId: installerB, status: "failed" },
    ].map((target) => ({
      ...target,
      requestedBy: userId,
      action: "install",
      spec: "fixture@1",
      replayEnabled: true,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      federationJobId: id,
    })),
  );
  return id;
}

async function receipts(jobId: string) {
  return db.select().from(jobCancellations).where(eq(jobCancellations.jobId, jobId));
}

test("cancelling a pending unplaced Job atomically captures all installation Agents, including failed operations", async () => {
  const jobId = await fixture();
  const cancelled = await service.cancel(jobId);
  expect(cancelled.agentId).toBeNull();
  expect(cancelled.revokedEpoch).toBe(1);
  expect((await receipts(jobId)).map((row) => row.agentId).sort()).toEqual(
    [installerA, installerB].sort(),
  );
  expect(
    (await receipts(jobId)).every((row) => row.requiresInstallationStop && !row.acknowledgedAt),
  ).toBe(true);
});

test("reconnect and Server restart retain separate compute/install recipients and require every matching stop ACK", async () => {
  const jobId = await fixture("running", compute);
  const cancelled = await service.updateStatus(jobId, "cancelled");
  const dispatcher = new AgentDispatcher();
  const sent = new Map<string, ServerMessage[]>();
  const first = new JobCancellationOutbox(db, dispatcher);
  expect(await first.deliverJob(jobId)).toBe(3); // Offline delivery retains all recipients.
  for (const agentId of agentIds) {
    const messages: ServerMessage[] = [];
    sent.set(agentId, messages);
    dispatcher.register(agentId, { push: (message) => messages.push(message), close: () => {} });
  }
  const recovered = new JobCancellationOutbox(db, dispatcher);
  await recovered.redeliver();
  for (const agentId of agentIds)
    expect(
      sent
        .get(agentId)
        ?.some(
          (message) =>
            message.payload.case === "cancelJob" && message.payload.value.jobId === jobId,
        ),
    ).toBe(true);
  let finished = false;
  const waiting = first.waitForAcknowledgement(jobId, cancelled.revokedEpoch).then(() => {
    finished = true;
  });
  expect(await recovered.acknowledge(installerA, jobId, cancelled.revokedEpoch)).toBe(false);
  expect(await recovered.acknowledge(installerA, jobId, cancelled.revokedEpoch - 1, true)).toBe(
    false,
  );
  expect(await recovered.acknowledge("wrong-agent", jobId, cancelled.revokedEpoch, true)).toBe(
    false,
  );
  expect(await recovered.acknowledge(installerA, jobId, cancelled.revokedEpoch, true)).toBe(true);
  expect(await recovered.acknowledge(compute, jobId, cancelled.revokedEpoch)).toBe(true);
  await Bun.sleep(25);
  expect(finished).toBe(false);
  expect(await recovered.acknowledge(installerB, jobId, cancelled.revokedEpoch, true)).toBe(true);
  await waiting; // Different outbox instance receives the ACK; database polling must converge.
  expect(finished).toBe(true);
  expect(await recovered.acknowledge(installerB, jobId, cancelled.revokedEpoch, true)).toBe(true);
});

test("adding installation stop requirements invalidates an earlier ordinary ACK and cannot be downgraded", async () => {
  const jobId = await fixture("pending", installerA);
  const outbox = new JobCancellationOutbox(db, new AgentDispatcher());
  await outbox.enqueue(installerA, jobId, 3);
  expect(await outbox.acknowledge(installerA, jobId, 3)).toBe(true);
  await service.updateStatus(jobId, "cancelled");
  expect((await receipts(jobId)).find((row) => row.agentId === installerA)).toMatchObject({
    revokedEpoch: 3,
    requiresInstallationStop: true,
    acknowledgedAt: null,
  });
  await outbox.enqueue(installerA, jobId, 1);
  expect(await outbox.acknowledge(installerA, jobId, 3)).toBe(false);
  expect(await outbox.acknowledge(installerA, jobId, 3, true)).toBe(true);
  await service.updateStatus(jobId, "cancelled");
  expect(
    (await receipts(jobId)).find((row) => row.agentId === installerA)?.acknowledgedAt,
  ).toBeInstanceOf(Date);
  await outbox.enqueue(installerA, jobId, 4);
  expect(
    (await receipts(jobId)).find((row) => row.agentId === installerA)?.acknowledgedAt,
  ).toBeNull();
  expect((await receipts(jobId)).find((row) => row.agentId === installerB)?.revokedEpoch).toBe(3);
});

test.each([
  "failed",
  "completed",
])("Workflow cancellation fences lingering installations without rewriting a %s Job", async (status) => {
  const jobId = await fixture(status, compute);
  const job = await service.updateStatus(jobId, "cancelled");
  expect(job.status).toBe(status);
  expect(job.revokedEpoch).toBe(3);
  expect((await receipts(jobId)).map((row) => row.agentId).sort()).toEqual(
    [installerA, installerB].sort(),
  );
});

test("failure saving installation cancellation rolls back the Job status too", async () => {
  const jobId = await fixture();
  await db.execute(
    sql`CREATE FUNCTION cancellation_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture interruption'; END; $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER cancellation_fixture_reject BEFORE INSERT ON job_cancellations FOR EACH ROW EXECUTE FUNCTION cancellation_fixture_reject()`,
  );
  try {
    await expect(service.cancel(jobId)).rejects.toThrow();
    expect((await service.getById(jobId))?.status).toBe("pending");
    expect(await receipts(jobId)).toEqual([]);
  } finally {
    await db.execute(sql`DROP TRIGGER cancellation_fixture_reject ON job_cancellations`);
    await db.execute(sql`DROP FUNCTION cancellation_fixture_reject()`);
  }
});

test("new cancellation epoch supersedes only its own recipient and rejects an obsolete ACK", async () => {
  const jobId = await fixture();
  await service.cancel(jobId);
  const outbox = new JobCancellationOutbox(db, new AgentDispatcher());
  await outbox.enqueue(installerA, jobId, 2);
  expect(await outbox.acknowledge(installerA, jobId, 1, true)).toBe(false);
  expect(await outbox.acknowledge(installerB, jobId, 1, true)).toBe(true);
  expect(
    await db
      .select()
      .from(jobCancellations)
      .where(and(eq(jobCancellations.jobId, jobId), eq(jobCancellations.agentId, installerA))),
  ).toMatchObject([{ revokedEpoch: 2, acknowledgedAt: null }]);
});

test.each([
  "asset",
  "grant",
])("%s revocation cancels installations even before compute placement", async (kind) => {
  const jobId = await fixture();
  const assetId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await db.insert(dataAssets).values({
    id: assetId,
    ownerKind: "user",
    ownerUserId: userId,
    kind: "reference-data",
    name: "cancel fixture",
    lifecycle: "published",
    visibility: "private",
    accessMode: "request",
    sensitivity: "internal",
  });
  await db.insert(dataAssetVersions).values({
    id: versionId,
    dataAssetId: assetId,
    version: "1",
    status: "ready",
    immutableAt: new Date(),
    manifestDigest: `sha256:${"b".repeat(64)}`,
  });
  await db.insert(dataGrants).values({
    id: grantId,
    dataAssetId: assetId,
    dataAssetVersionId: versionId,
    subjectKind: "user",
    subjectId: userId,
    capabilities: ["use"],
  });
  await db.insert(jobDataBindings).values({
    jobId,
    inputDescriptor: "data",
    source: "data-market",
    assetId,
    versionId,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    authorizationSubjectIds: [`user:${userId}`],
  });
  try {
    if (kind === "asset")
      expect(
        await revokeDataDeliveryJobs({
          db,
          assetId,
          reasonCode: "ASSET_REVOKED",
          dispatcher: {
            pushDataDeliveryRevoke: () => {
              throw new Error("Unplaced Job cannot have a compute recipient");
            },
          },
        }),
      ).toBe(1);
    else
      await new DataGrantRevocationCoordinator(db, {
        redeliver: async () => {
          throw new Error("Unplaced Job cannot have a compute recipient");
        },
      }).revoke({ grantId, reason: "fixture" });
    expect((await service.getById(jobId))?.status).toBe("cancelled");
    expect((await receipts(jobId)).map((row) => row.agentId).sort()).toEqual(
      [installerA, installerB].sort(),
    );
    expect((await receipts(jobId)).every((row) => row.requiresInstallationStop)).toBe(true);

    const registry = new WorkflowRunRegistry(db);
    const runId = await registry.createRun(
      "revoked input",
      userId,
      { nodes: [], edges: [] },
      { yaml: "name: fixture\nspec:\n  nodeDrafts: []\n", role: "user" },
    );
    const cancellations = new JobCancellationOutbox(db, new AgentDispatcher());
    const scheduled: (() => Promise<void>)[] = [];
    const nodeStatus = kind === "asset" ? "Cancelled" : "Failed";
    const result = {
      status: { install: nodeStatus },
      values: { install: { status: nodeStatus, values: {} } },
    } as const;
    const runner = new WorkflowAsyncRunner({
      registry,
      schedule: (task) => scheduled.push(task),
      makeRunner: (_user, _role, id) => async () => {
        if (!id) throw new Error("Workflow ID missing");
        await registry.recordStepJob(id, "install", jobId);
        return result;
      },
      cancelSubmittedJobs: (id) =>
        cancelWorkflowJobs(id, registry, service, cancellations, {
          complete: () => {},
        }),
    });
    try {
      await registry.queueAuthorizedRun(runId);
      await runner.resumeAfterApproval(runId);
      const execute = scheduled.shift();
      if (!execute) throw new Error("Execution not scheduled");
      const finishing = execute();
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await registry.getById(runId))?.status === "cancelling") break;
        await Bun.sleep(5);
      }
      expect(await registry.getById(runId)).toMatchObject({
        status: "cancelling",
        completedAt: null,
        result,
      });
      const epoch = (await service.getById(jobId))?.revokedEpoch ?? 0;
      expect(await cancellations.acknowledge(installerA, jobId, epoch, true)).toBe(true);
      await Bun.sleep(25);
      expect((await registry.getById(runId))?.status).toBe("cancelling");
      expect(await cancellations.acknowledge(installerB, jobId, epoch, true)).toBe(true);
      await finishing;
      expect(await registry.getById(runId)).toMatchObject({
        status: kind === "asset" ? "cancelled" : "failed",
        result,
        errorCode: kind === "asset" ? null : "WORKFLOW_NODE_FAILED",
      });
    } finally {
      await runner.stop();
      await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
    }
  } finally {
    await db.delete(dataAssets).where(eq(dataAssets.id, assetId));
  }
});

test("production Workflow cancellation coordinator waits for every installer before marking the run cancelled", async () => {
  const jobId = await fixture();
  const registry = new WorkflowRunRegistry(db);
  const runId = await registry.createRun(
    "installation cancellation",
    userId,
    { nodes: [], edges: [] },
    { yaml: "name: fixture\nspec:\n  nodeDrafts: []\n", role: "user" },
  );
  await registry.queueAuthorizedRun(runId);
  await registry.claimForExecution(runId);
  await registry.recordStepJob(runId, "install", jobId);
  const cancellations = new JobCancellationOutbox(db, new AgentDispatcher());
  const scheduled: (() => Promise<void>)[] = [];
  const completed: string[] = [];
  const runner = new WorkflowAsyncRunner({
    registry,
    schedule: (task) => scheduled.push(task),
    makeRunner: () => async () => {
      throw new Error("Cancellation must not execute");
    },
    cancelSubmittedJobs: (id) =>
      cancelWorkflowJobs(id, registry, service, cancellations, {
        complete: (id) => {
          completed.push(id);
        },
      }),
  });
  try {
    expect(await runner.cancel(runId)).toBe("cancelling");
    const finish = scheduled.shift();
    if (!finish) throw new Error("Cancellation not scheduled");
    const finishing = finish();
    for (let attempt = 0; attempt < 200 && (await receipts(jobId)).length < 2; attempt++)
      await Bun.sleep(5);
    const epoch = (await service.getById(jobId))?.revokedEpoch ?? 0;
    expect(await cancellations.acknowledge(installerA, jobId, epoch, true)).toBe(true);
    await Bun.sleep(25);
    expect((await registry.getById(runId))?.status).toBe("cancelling");
    expect(completed).toEqual([]);
    expect(await cancellations.acknowledge(installerB, jobId, epoch, true)).toBe(true);
    await finishing;
    expect((await registry.getById(runId))?.status).toBe("cancelled");
    expect(completed).toEqual([jobId]);
  } finally {
    await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
  }
});
