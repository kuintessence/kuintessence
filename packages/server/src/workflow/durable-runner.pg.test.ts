import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPgDb, jobs, users, workflowExecutionJobs, workflowRuns } from "@kuintessence/db";
import { extractRunGraph, WorkflowExecutionInterrupted, workflowDsl } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { stringify } from "yaml";
import { JobService } from "../services/job-service";
import { WorkflowAsyncRunner } from "./async-runner";
import { readWorkflowPublishedFiles, saveWorkflowPublishedFiles } from "./execution-jobs";
import { WorkflowExecutionJournalStore } from "./execution-journal";
import { completionFromJob, JobCompletionRegistry } from "./job-completion-registry";
import { createJobSubmitter } from "./job-submitter";
import { WorkflowRunRegistry } from "./run-registry";
import { createWorkflowRunner } from "./runner";
import { submitWorkflowJob } from "./submit-job";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Durable runner tests require an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const userId = randomUUID();
const runIds: string[] = [];
const runners: WorkflowAsyncRunner[] = [];
const registry = new WorkflowRunRegistry(db);
const journal = new WorkflowExecutionJournalStore(db);
const jobService = new JobService(db);
const completions = new JobCompletionRegistry({
  pollIntervalMs: 10,
  load: async (id) => {
    const job = await jobService.getById(id);
    return job ? completionFromJob(job) : null;
  },
});
const leaf = {
  type: "SoftwareUsecaseComputing",
  id: "solve",
  name: "solve",
  usecaseVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  softwareVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};
function definition(parallel = 1) {
  return workflowDsl.WorkflowSchema.parse({
    name: "Durable loop",
    parameters: [],
    spec: {
      nodeDrafts: [
        {
          type: "Loop",
          id: "loop",
          name: "loop",
          mode: "ForEach",
          over: { expr: "[1,2,3]" },
          maxIterations: 3,
          maxParallel: parallel,
          body: { nodeDrafts: [leaf] },
          outputs: [],
        },
      ],
    },
  });
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, role: "user" });
});
afterAll(async () => {
  await Promise.all(runners.map((runner) => runner.stop()));
  if (runIds.length) await db.delete(workflowRuns).where(inArray(workflowRuns.id, runIds));
  await db.delete(jobs).where(eq(jobs.submittedBy, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end({ timeout: 5 });
});

function harness(options: { restartAt?: number; hold?: boolean } = {}) {
  const scheduled: Array<() => Promise<void>> = [];
  const executed: string[] = [];
  const submitted = new Set<string>();
  const allSubmitted = Promise.withResolvers<void>();
  let restartAt = options.restartAt ?? 0;
  function make() {
    const runner = new WorkflowAsyncRunner({
      registry,
      journal,
      schedule: (task) => {
        scheduled.push(task);
      },
      cancelSubmittedJobs: async (id) => {
        for (const jobId of await registry.listJobIds(id)) {
          const job = await jobService.getById(jobId);
          if (job && !["completed", "failed", "cancelled"].includes(job.status))
            await jobService.updateStatus(jobId, "cancelled");
        }
      },
      makeRunner: (submittedBy, role, runId, _placement, orgId, lease) => {
        if (!lease) throw new Error("Fixture requires durable execution");
        return createWorkflowRunner({
          journal: lease,
          resolvePackage: async () => ({
            usecase: { commandFile: "echo", inputSlots: [] },
            software: { kind: "Bare" },
            arguments: [],
            environments: [],
            filesomeInputs: [],
            filesomeOutputs: [],
            valueOutputs: [],
          }),
          submitJob: createJobSubmitter({
            submit: async (spec) => {
              const job = await submitWorkflowJob({
                jobService,
                spec,
                submittedBy,
                role,
                runId,
                orgId,
                lease,
                workingDirBase: "/isolated",
              });
              submitted.add(job.id);
              if (submitted.size === 3) allSubmitted.resolve();
              return job;
            },
            dispatch: async (jobId) => {
              const job = await jobService.getById(jobId);
              if (job?.status === "pending" && !options.hold) {
                executed.push(jobId);
                await jobService.updateStatus(
                  jobId,
                  "completed",
                  undefined,
                  undefined,
                  undefined,
                  0,
                  {},
                );
              }
            },
            awaitCompletion: async (jobId) => {
              const completion = await completions.awaitCompletion(jobId, 5000, lease.signal);
              if (restartAt && executed.length === restartAt) {
                restartAt = 0;
                throw new WorkflowExecutionInterrupted("Worker stopped after Job completion");
              }
              return completion;
            },
          }),
        });
      },
    });
    runners.push(runner);
    return runner;
  }
  async function submit(runner: WorkflowAsyncRunner, parallel = 1) {
    const result = await runner.submit({
      yaml: stringify(definition(parallel)),
      submittedBy: userId,
      role: "user",
      executionModel: "durable-v2",
      authorizeRun: async () => {},
    });
    runIds.push(result.runId);
    return result.runId;
  }
  async function drain() {
    while (scheduled.length) await scheduled.shift()?.();
  }
  return {
    make,
    submit,
    drain,
    scheduled,
    executed,
    submitted,
    allSubmitted: allSubmitted.promise,
  };
}

test("new async runner resumes a partial loop and reuses the completed Job missing its node checkpoint", async () => {
  const h = harness({ restartAt: 2 });
  const first = h.make();
  const id = await h.submit(first);
  await h.drain();
  expect(await registry.getById(id)).toMatchObject({
    status: "running",
    errorCode: "WORKFLOW_RECOVERY_PENDING",
    input: { executionModel: "durable-v2", orgId: null },
  });
  expect(h.executed).toHaveLength(2);
  await first.stop();
  const next = h.make();
  expect(await next.recoverInterruptedRuns(true)).toEqual({ resumed: 1, failedInterrupted: 0 });
  await h.drain();
  expect(await registry.getById(id)).toMatchObject({
    status: "completed",
    errorCode: null,
    errorMessage: null,
  });
  expect(h.executed).toHaveLength(3);
  expect(h.submitted.size).toBe(3);
  expect(await registry.listJobIds(id)).toHaveLength(3);
  expect(Object.keys((await registry.getById(id))?.stepJobs ?? {})).toHaveLength(1);
});

test("cancellation covers all parallel loop invocations rather than only the last static node mapping", async () => {
  const h = harness({ hold: true });
  const runner = h.make();
  const id = await h.submit(runner, 3);
  const execute = h.scheduled.shift();
  if (!execute) throw new Error("Missing scheduled execution");
  const running = execute();
  await h.allSubmitted;
  expect(await registry.listJobIds(id)).toHaveLength(3);
  expect(await runner.cancel(id)).toBe("cancelling");
  await h.drain();
  await running;
  expect((await registry.getById(id))?.status).toBe("cancelled");
  const rows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.id, [...h.submitted]));
  expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
});

test("changed checkpoints require reconciliation and are excluded from automatic recovery scans", async () => {
  const h = harness({ restartAt: 1 });
  const runner = h.make();
  const id = await h.submit(runner);
  await h.drain();
  const run = await registry.getById(id);
  if (!run?.input) throw new Error("Missing saved input");
  await db
    .update(workflowRuns)
    .set({
      input: { ...run.input, yaml: run.input.yaml.replace("Durable loop", "Changed definition") },
    })
    .where(eq(workflowRuns.id, id));
  const recovered = h.make();
  await recovered.recoverInterruptedRuns(true);
  await h.drain();
  expect(await registry.getById(id)).toMatchObject({
    status: "running",
    errorCode: "WORKFLOW_RECONCILING",
  });
  expect((await registry.listRunnableDurableRuns()).some((item) => item.id === id)).toBe(false);
  expect(h.executed).toHaveLength(1);
  await recovered.cancel(id);
  await h.drain();
  expect((await registry.getById(id))?.status).toBe("cancelled");
});

test("background scanner resumes durable work while leaving a live legacy workflow alone", async () => {
  const h = harness({ restartAt: 1 });
  const first = h.make();
  const id = await h.submit(first);
  await h.drain();
  await first.stop();
  const workflow = definition();
  const legacyId = await registry.createRun("Legacy active", userId, extractRunGraph(workflow), {
    yaml: stringify(workflow),
    role: "user",
  });
  runIds.push(legacyId);
  await registry.queueAuthorizedRun(legacyId);
  await registry.claimForExecution(legacyId);
  const next = h.make();
  next.startRecovery();
  try {
    const deadline = Date.now() + 8000;
    while (!h.scheduled.length) {
      if (Date.now() >= deadline)
        throw new Error("Background recovery did not schedule the saved run");
      await Bun.sleep(20);
    }
    await h.drain();
    expect((await registry.getById(id))?.status).toBe("completed");
    expect(h.executed).toHaveLength(3);
    expect((await registry.getById(legacyId))?.status).toBe("running");
  } finally {
    await next.stop();
  }
});

async function manualRun() {
  const workflow = definition();
  const id = await registry.createRun(workflow.name, userId, extractRunGraph(workflow), {
    yaml: stringify(workflow),
    role: "user",
    orgId: null,
    executionModel: "durable-v2",
  });
  runIds.push(id);
  await registry.queueAuthorizedRun(id);
  await registry.claimForExecution(id);
  return id;
}

test("heartbeat keeps an idle executor leased and cancellation aborts its result wait", async () => {
  const id = await manualRun();
  const lease = await journal.acquire(id, 500);
  if (!lease) throw new Error("Missing lease");
  const stop = lease.startHeartbeat();
  try {
    await Bun.sleep(1100);
    expect(await journal.acquire(id)).toBeNull();
    expect((await registry.listRunnableDurableRuns()).some((item) => item.id === id)).toBe(false);
    const waiting = completions.awaitCompletion(randomUUID(), 2000, lease.signal);
    const rejected = waiting.catch((error: unknown) => error);
    await registry.requestCancel(id);
    expect(await rejected).toBeInstanceOf(WorkflowExecutionInterrupted);
    expect(lease.signal.aborted).toBe(true);
    await expect(
      lease.write("late", { kind: "node", status: "Succeeded", values: {} }),
    ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  } finally {
    await stop();
    await lease.release();
  }
});

test("published file lists survive lease replacement and cannot be changed on replay", async () => {
  const id = await manualRun();
  const lease = await journal.acquire(id);
  if (!lease) throw new Error("Missing lease");
  const job = await submitWorkflowJob({
    jobService,
    submittedBy: userId,
    role: "user",
    orgId: null,
    runId: id,
    lease,
    spec: {
      nodeId: "solve",
      invocation: { path: '["node","solve"]' },
      name: "Files",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    },
  });
  const files = { results: [{ fileMetadataId: randomUUID(), fileMetadataName: "result.csv" }] };
  await expect(saveWorkflowPublishedFiles(lease, job.id, files)).rejects.toMatchObject({
    retryable: false,
  });
  await jobService.updateStatus(job.id, "completed");
  await saveWorkflowPublishedFiles(lease, job.id, files);
  await lease.release();
  const next = await journal.acquire(id);
  if (!next) throw new Error("Missing replacement lease");
  expect(await readWorkflowPublishedFiles(next, job.id)).toEqual(files);
  await saveWorkflowPublishedFiles(next, job.id, files);
  await expect(saveWorkflowPublishedFiles(next, job.id, {})).rejects.toMatchObject({
    retryable: false,
  });
  await expect(readWorkflowPublishedFiles(lease, job.id)).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  expect(
    (
      await db.select().from(workflowExecutionJobs).where(eq(workflowExecutionJobs.jobId, job.id))
    )[0]?.publishedFiles,
  ).toEqual(files);
  await next.release();
});

test("stale executors cannot finalize a run owned by a new lease", async () => {
  const id = await manualRun();
  const first = await journal.acquire(id);
  if (!first) throw new Error("Missing first lease");
  await first.release();
  const next = await journal.acquire(id);
  if (!next) throw new Error("Missing next lease");
  await expect(registry.completeRun(id, { status: {}, values: {} }, first)).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  await expect(registry.requestInterrupt(id, "Old executor failed", first)).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  expect((await registry.getById(id))?.status).toBe("running");
  expect(await registry.completeRun(id, { status: {}, values: {} }, next)).toBe(true);
  await next.release();
});
