import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createPgDb,
  jobs,
  type PgTransaction,
  users,
  workflowExecutionJobs,
  workflowExecutionJournal,
  workflowExecutionLeases,
  workflowRuns,
} from "@kuintessence/db";
import {
  type JobSubmission,
  runWorkflow,
  WorkflowExecutionInterrupted,
  workflowDsl,
} from "@kuintessence/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { JobService } from "../services/job-service";
import { bindWorkflowExecutionJob } from "./execution-jobs";
import { type LeasedWorkflowJournal, WorkflowExecutionJournalStore } from "./execution-journal";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Workflow journal PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const runs: string[] = [];
const userId = crypto.randomUUID();
const jobService = new JobService(db);
beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: userId, email: `journal-${userId}@example.test`, role: "user" });
});
const store = new WorkflowExecutionJournalStore(db);
const entry = { kind: "node", status: "Succeeded", values: { count: 1 } } as const;

async function newRun() {
  const id = crypto.randomUUID();
  runs.push(id);
  await db.insert(workflowRuns).values({ id, name: "Isolated journal test", status: "running" });
  return id;
}

afterAll(async () => {
  if (runs.length) await db.delete(workflowRuns).where(inArray(workflowRuns.id, runs));
  await db.delete(jobs).where(eq(jobs.submittedBy, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end({ timeout: 5 });
});

test("concurrent workers obtain one lease, and released handles cannot write or release a new owner", async () => {
  const id = await newRun();
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.acquire(id)));
  const claimed = claims.filter((value) => value !== null);
  expect(claimed).toHaveLength(1);
  const first = claimed[0];
  if (!first) throw new Error("missing lease");
  await first.write("node", entry);
  await first.release();
  const next = await new WorkflowExecutionJournalStore(db).acquire(id);
  if (!next) throw new Error("missing new lease");
  await expect(first.write("stale", entry)).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await expect(first.renew()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await first.release();
  expect(await next.read("node")).toEqual(entry);
  await next.release();
});

test("expired lease cannot be renewed; takeover fences the previous owner", async () => {
  const id = await newRun();
  const first = await store.acquire(id);
  if (!first) throw new Error("missing lease");
  await db
    .update(workflowExecutionLeases)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(workflowExecutionLeases.runId, id));
  await expect(first.renew()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  const next = await store.acquire(id);
  if (!next) throw new Error("missing new lease");
  await expect(first.read("node")).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await next.renew();
  await next.write("node", entry);
});

test("journal survives a new engine/store instance, skips completed work and preserves file references", async () => {
  const id = await newRun();
  const first = await store.acquire(id);
  if (!first) throw new Error("missing lease");
  const definition = workflowDsl.WorkflowSchema.parse({
    name: "Recovery",
    parameters: [],
    spec: {
      nodeDrafts: ["a", "b"].map((nodeId) => ({ id: nodeId, name: nodeId, type: "NoAction" })),
      nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
    },
  });
  const file = { fileMetadataId: crypto.randomUUID(), fileMetadataName: "result.csv" };
  await expect(
    runWorkflow(
      definition,
      async (node) => {
        if (node.id === "b") throw new WorkflowExecutionInterrupted("Server restart");
        return { status: "Succeeded", values: { file } };
      },
      { journal: first },
    ),
  ).rejects.toThrow("Server restart");
  await first.release();
  const second = await new WorkflowExecutionJournalStore(db).acquire(id);
  if (!second) throw new Error("missing new lease");
  const executed: string[] = [];
  const result = await runWorkflow(
    definition,
    async (node, ctx) => {
      executed.push(node.id);
      expect(ctx.nodes).toMatchObject({ a: { values: { file } } });
      return { status: "Succeeded" };
    },
    { journal: second },
  );
  expect(executed).toEqual(["b"]);
  expect(result.status).toEqual({ a: "Succeeded", b: "Succeeded" });
});

test("checkpoint is immutable, run scoped, and JSONB field order does not cause a conflict", async () => {
  const left = await store.acquire(await newRun());
  const right = await store.acquire(await newRun());
  if (!left || !right) throw new Error("missing leases");
  const key = JSON.stringify(["node", "nested".repeat(600)]);
  await left.write(key, entry);
  await left.write(key, { values: { count: 1 }, status: "Succeeded", kind: "node" });
  await expect(left.write(key, { ...entry, values: { count: 2 } })).rejects.toThrow("immutable");
  expect(await left.read(key)).toEqual(entry);
  expect(await right.read(key)).toBeNull();
  await right.write(key, { ...entry, values: { count: 2 } });
});

test("lease expiry during an atomic operation rolls back all of its writes", async () => {
  const id = await newRun();
  const lease = await store.acquire(id);
  if (!lease) throw new Error("missing lease");
  await expect(
    lease.transaction(async (tx) => {
      await tx
        .update(workflowRuns)
        .set({ description: "must roll back" })
        .where(eq(workflowRuns.id, id));
      await tx
        .update(workflowExecutionLeases)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(workflowExecutionLeases.runId, id));
    }),
  ).rejects.toThrow("expired during transaction");
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  expect(run?.description).toBeNull();
  await lease.write("still-live-after-rollback", entry);
});

test("cancellation prevents reads, progress writes and new claims", async () => {
  const id = await newRun();
  const lease = await store.acquire(id);
  if (!lease) throw new Error("missing lease");
  await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, id));
  await expect(lease.write("after-cancel", entry)).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  await expect(lease.read("before-cancel")).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect(await store.acquire(id)).toBeNull();
  expect(
    await db.select().from(workflowExecutionJournal).where(eq(workflowExecutionJournal.runId, id)),
  ).toHaveLength(0);
});

function jobIntent(index = 0): JobSubmission {
  return {
    nodeId: "work",
    invocation: { path: JSON.stringify(["node", "loop", "iteration", index, "node", "work"]) },
    name: "Isolated durable job",
    command: "__KQ_TEST_PLACEHOLDER__",
    envVars: {},
    inputStaging: [],
    expectedOutputs: [],
    spackExecution: { spec: "hello@1.0", command: "hello" },
  };
}
function submitInLease(lease: LeasedWorkflowJournal) {
  return (tx: PgTransaction, intent: JobSubmission) =>
    jobService.submitInTransaction(
      tx,
      {
        name: intent.name,
        command: intent.command,
        resources: { cpus: 1, memoryMb: 16 },
      },
      userId,
      { workflow: { runId: lease.runId, nodeId: intent.nodeId } },
    );
}

test("concurrent duplicate invocations create one Job and retain the full pending Spack intent", async () => {
  const id = await newRun();
  const lease = await store.acquire(id);
  if (!lease) throw new Error("missing lease");
  let created = 0;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      bindWorkflowExecutionJob(lease, jobIntent(), async (tx, intent) => {
        created++;
        return submitInLease(lease)(tx, intent);
      }),
    ),
  );
  expect(created).toBe(1);
  expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
  expect(results.filter((result) => !result.reused)).toHaveLength(1);
  const saved = await db
    .select()
    .from(workflowExecutionJobs)
    .where(eq(workflowExecutionJobs.runId, id));
  expect(saved).toHaveLength(1);
  expect(saved[0]?.dispatchState).toBe("pending");
  expect(saved[0]?.intent.spackExecution).toEqual(jobIntent().spackExecution);
  await expect(
    bindWorkflowExecutionJob(lease, { ...jobIntent(), command: "different" }, submitInLease(lease)),
  ).rejects.toThrow("changed its job intent");
  const otherIteration = await bindWorkflowExecutionJob(lease, jobIntent(1), submitInLease(lease));
  expect(otherIteration.jobId).not.toBe(results[0]?.jobId);
});

test("crash after Job commit but before node checkpoint reuses the Job on recovery", async () => {
  const id = await newRun();
  let lease = await store.acquire(id);
  if (!lease) throw new Error("missing lease");
  const definition = workflowDsl.WorkflowSchema.parse({
    name: "Job recovery",
    parameters: [],
    spec: {
      nodeDrafts: [{ id: "work", name: "work", type: "NoAction" }],
    },
  });
  let crash = true;
  let created = 0;
  const jobIds: string[] = [];
  const executor = async (
    _node: workflowDsl.WorkflowNode,
    _ctx: Record<string, unknown>,
    invocation?: { path: string },
  ) => {
    if (!lease) throw new Error("missing lease");
    const result = await bindWorkflowExecutionJob(
      lease,
      { ...jobIntent(), invocation },
      async (tx, intent) => {
        created++;
        if (!lease) throw new Error("missing lease");
        return submitInLease(lease)(tx, intent);
      },
    );
    jobIds.push(result.jobId);
    if (crash) throw new WorkflowExecutionInterrupted("restart after job commit");
    return { status: "Succeeded" as const, values: { jobId: result.jobId } };
  };
  await expect(runWorkflow(definition, executor, { journal: lease })).rejects.toThrow(
    "restart after job commit",
  );
  await lease.release();
  lease = await new WorkflowExecutionJournalStore(db).acquire(id);
  if (!lease) throw new Error("missing resumed lease");
  crash = false;
  const result = await runWorkflow(definition, executor, { journal: lease });
  expect(result.status.work).toBe("Succeeded");
  expect(created).toBe(1);
  expect(jobIds).toHaveLength(2);
  expect(new Set(jobIds).size).toBe(1);
});

test("failed binding insert rolls Job and legacy workflow mapping back together", async () => {
  const id = await newRun();
  const lease = await store.acquire(id);
  if (!lease) throw new Error("missing lease");
  let rolledBackJobId = "";
  await expect(
    bindWorkflowExecutionJob(lease, jobIntent(), async (tx, intent) => {
      const job = await submitInLease(lease)(tx, intent);
      rolledBackJobId = job.id;
      return { id: crypto.randomUUID() };
    }),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect(await db.select().from(jobs).where(eq(jobs.id, rolledBackJobId))).toHaveLength(0);
  expect(
    await db.select().from(workflowExecutionJobs).where(eq(workflowExecutionJobs.runId, id)),
  ).toHaveLength(0);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  expect(run?.stepJobs).toEqual({});
});
