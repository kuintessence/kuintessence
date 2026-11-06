import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import {
  agents,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  runSqliteMigrations,
  users,
} from "@kuintessence/db";
import { type ServerMessage, ServerMessageSchema } from "@kuintessence/proto";
import {
  SPACK_EXECUTION_PLACEHOLDER,
  SPACK_PINNED_EXECUTION_PLACEHOLDER,
  type SpackExecutionPin,
} from "@kuintessence/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { InboundAcks } from "../packages/agent/src/queue/inbound-acks";
import { workflowSpackIntent } from "../packages/agent/src/spack/workflow-activation";
import { AgentDispatcher } from "../packages/server/src/grpc/dispatcher";
import { JobDispatchOutbox } from "../packages/server/src/grpc/job-dispatch-outbox";
import { JobService } from "../packages/server/src/services/job-service";
import {
  completionFromJob,
  JobCompletionRegistry,
} from "../packages/server/src/workflow/job-completion-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Dispatch PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const jobService = new JobService(db);
const userId = crypto.randomUUID();
const agentId = `outbox-${crypto.randomUUID()}`;
const jobIds: string[] = [];

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, role: "user" });
  await db.insert(agents).values({
    agentId,
    siteName: "Isolated dispatch test",
    schedulerType: "slurm",
    schedulerVersion: "test",
    status: "online",
    lastHeartbeat: new Date(),
  });
});
afterAll(async () => {
  if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end({ timeout: 5 });
});

async function dispatchFixture(pin?: SpackExecutionPin) {
  const job = await jobService.submit(
    {
      name: "Durable dispatch",
      command: pin ? SPACK_PINNED_EXECUTION_PLACEHOLDER : SPACK_EXECUTION_PLACEHOLDER,
      resources: { cpus: 1, memoryMb: 16 },
    },
    userId,
  );
  jobIds.push(job.id);
  const assigned = await jobService.assignToAgent(job.id, agentId);
  const dispatcher = new AgentDispatcher();
  const message = dispatcher.buildDispatchJob(job.id, {
    jobIdInternal: job.id,
    dispatchEpoch: assigned.dispatchEpoch,
    name: job.name,
    command: job.command,
    resources: { cpus: 1, memoryMb: 16 },
    spackExecution: { spec: "hello@1.0", command: "hello --count 1", ...(pin ? { pin } : {}) },
  });
  return { jobId: job.id, dispatcher, message, outbox: new JobDispatchOutbox(db, dispatcher) };
}

test("retains an authorized dispatch across channel loss and replays its exact bytes after restart", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  dispatcher.register(agentId, {
    push: () => {
      throw new Error("stream disconnected");
    },
    close: () => {},
  });
  expect(await outbox.enqueue(agentId, message)).toEqual({ sent: false, pending: true });
  expect((await jobService.getById(jobId))?.status).toBe("queued");
  const [saved] = await db
    .select()
    .from(jobDispatchOutbox)
    .where(eq(jobDispatchOutbox.jobId, jobId));
  expect(saved?.acknowledgedAt).toBeNull();
  const delivered: ServerMessage[] = [];
  const restartedDispatcher = new AgentDispatcher();
  restartedDispatcher.register(agentId, {
    push: (value) => {
      delivered.push(value);
    },
    close: () => {},
  });
  await new JobDispatchOutbox(db, restartedDispatcher).redeliver(agentId);
  const replayed = delivered.find(
    (value) => value.payload.case === "dispatchJob" && value.payload.value.jobId === jobId,
  );
  expect(replayed).toBeDefined();
  if (!replayed) throw new Error("missing replay");
  expect(toBinary(ServerMessageSchema, replayed)).toEqual(toBinary(ServerMessageSchema, message));
});

test("lost receipt replays the same epoch and the real Agent SQLite inbox admits it only once", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  const delivered: ServerMessage[] = [];
  dispatcher.register(agentId, {
    push: (value) => {
      delivered.push(value);
    },
    close: () => {},
  });
  await outbox.enqueue(agentId, message);
  await new JobDispatchOutbox(db, dispatcher).redeliver(agentId);
  const sqlite = new Database(":memory:");
  try {
    runSqliteMigrations(sqlite);
    const inboxDb = drizzle(sqlite, { schema });
    let admitted = 0;
    for (const item of delivered) {
      if (item.payload.case !== "dispatchJob" || item.payload.value.jobId !== jobId) continue;
      const dispatch = item.payload.value;
      // New inbox instances share durable state, as after an Agent restart.
      if (
        await new InboundAcks(inboxDb).persistInbound({
          dispatchId: `${jobId}:${dispatch.dispatchEpoch}`,
          jobId,
          payload: { command: dispatch.command },
        })
      )
        admitted++;
    }
    expect(
      delivered.filter(
        (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
      ),
    ).toHaveLength(2);
    expect(admitted).toBe(1);
  } finally {
    sqlite.close();
  }
  await outbox.acknowledge("unrelated-agent", jobId);
  const [before] = await db
    .select()
    .from(jobDispatchOutbox)
    .where(eq(jobDispatchOutbox.jobId, jobId));
  expect(before?.acknowledgedAt).toBeNull();
  await outbox.acknowledge(agentId, jobId);
  delivered.length = 0;
  await outbox.redeliver(agentId);
  expect(
    delivered.some(
      (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
    ),
  ).toBe(false);
});

test("committed envelopes cannot be changed and revoked jobs are never replayed", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  await outbox.enqueue(agentId, message);
  const changed = structuredClone(message);
  if (changed.payload.case !== "dispatchJob") throw new Error("invalid fixture");
  changed.payload.value.command = "different";
  await expect(outbox.enqueue(agentId, changed)).rejects.toThrow("cannot be replaced");
  await jobService.cancel(jobId);
  const delivered: ServerMessage[] = [];
  dispatcher.register(agentId, {
    push: (value) => {
      delivered.push(value);
    },
    close: () => {},
  });
  await outbox.redeliver(agentId);
  expect(
    delivered.some(
      (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
    ),
  ).toBe(false);
  expect(await outbox.enqueue(agentId, message)).toEqual({ sent: false, pending: false });
});

test("rejects a wrong Agent or epoch before saving or sending a dispatch", async () => {
  const { jobId, message, outbox } = await dispatchFixture();
  expect(await outbox.enqueue("unrelated-agent", message)).toEqual({ sent: false, pending: false });
  const changed = structuredClone(message);
  if (changed.payload.case !== "dispatchJob") throw new Error("invalid fixture");
  changed.payload.value.dispatchEpoch++;
  expect(await outbox.enqueue(agentId, changed)).toEqual({ sent: false, pending: false });
  expect(
    await db.select().from(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId)),
  ).toHaveLength(0);
});

test("outbox persistence failure prevents delivery", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  let sent = 0;
  dispatcher.register(agentId, {
    push: () => {
      sent++;
    },
    close: () => {},
  });
  await db.execute(
    sql`CREATE FUNCTION kq_test_dispatch_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch persistence failure'; END $$`,
  );
  try {
    await db.execute(
      sql`CREATE TRIGGER kq_test_dispatch_failure BEFORE INSERT ON job_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION kq_test_dispatch_failure()`,
    );
    await expect(outbox.enqueue(agentId, message)).rejects.toThrow();
    expect(sent).toBe(0);
    expect(
      await db.select().from(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS kq_test_dispatch_failure ON job_dispatch_outbox`);
    await db.execute(sql`DROP FUNCTION kq_test_dispatch_failure()`);
  }
});

test("stopped durable runs cannot dispatch and Agent receipts update the durable invocation", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  const runId = crypto.randomUUID();
  await db
    .insert(schema.workflowRuns)
    .values({ id: runId, name: "Durable outbox scope", status: "running", submittedBy: userId });
  try {
    await db.insert(schema.workflowExecutionLeases).values({ runId });
    await db.insert(schema.workflowExecutionJobs).values({
      runId,
      jobId,
      pathHash: "a".repeat(64),
      path: '["node","work"]',
      nodeId: "work",
      intent: {
        nodeId: "work",
        name: "work",
        command: "true",
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      },
    });
    await outbox.enqueue(agentId, message);
    await db
      .update(schema.workflowRuns)
      .set({ status: "cancelling" })
      .where(eq(schema.workflowRuns.id, runId));
    const delivered: ServerMessage[] = [];
    dispatcher.register(agentId, {
      push: (value) => {
        delivered.push(value);
      },
      close: () => {},
    });
    await outbox.redeliver(agentId);
    expect(
      delivered.some(
        (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
      ),
    ).toBe(false);
    // A late receipt still records what the Agent received; it cannot resume the run.
    await outbox.acknowledge(agentId, jobId);
    const [invocation] = await db
      .select()
      .from(schema.workflowExecutionJobs)
      .where(eq(schema.workflowExecutionJobs.jobId, jobId));
    expect(invocation?.dispatchState).toBe("acknowledged");
    expect(
      (await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)))[0]
        ?.status,
    ).toBe("cancelling");
  } finally {
    await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId));
    await db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
  }
});

test("two recovery workers claim a due envelope only once before the retry interval", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  await outbox.enqueue(agentId, message);
  await db
    .update(jobDispatchOutbox)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(jobDispatchOutbox.jobId, jobId));
  const delivered: ServerMessage[] = [];
  dispatcher.register(agentId, {
    push: (value) => {
      delivered.push(value);
    },
    close: () => {},
  });
  await Promise.all([outbox.redeliver(), new JobDispatchOutbox(db, dispatcher).redeliver()]);
  expect(
    delivered.filter(
      (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
    ),
  ).toHaveLength(1);
});

test("a legacy workflow that times out cannot start a queued job after Agent reconnection", async () => {
  const { jobId, dispatcher, message, outbox } = await dispatchFixture();
  const runId = crypto.randomUUID();
  await db
    .insert(schema.workflowRuns)
    .values({ id: runId, name: "Legacy parent", status: "running", submittedBy: userId });
  try {
    expect(await outbox.enqueue(agentId, message, runId)).toEqual({ sent: false, pending: true });
    await db
      .update(schema.workflowRuns)
      .set({ status: "failed" })
      .where(eq(schema.workflowRuns.id, runId));
    const delivered: ServerMessage[] = [];
    dispatcher.register(agentId, {
      push: (value) => {
        delivered.push(value);
      },
      close: () => {},
    });
    await outbox.redeliver(agentId);
    expect(
      delivered.some(
        (item) => item.payload.case === "dispatchJob" && item.payload.value.jobId === jobId,
      ),
    ).toBe(false);
    const [saved] = await db
      .select()
      .from(jobDispatchOutbox)
      .where(eq(jobDispatchOutbox.jobId, jobId));
    expect(saved?.workflowRunId).toBe(runId);
  } finally {
    await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId));
    await db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
  }
});

test("a new completion registry reads the sticky result committed before the process restarted", async () => {
  const { jobId } = await dispatchFixture();
  await jobService.updateStatus(
    jobId,
    "completed",
    "scheduler-1",
    agentId,
    undefined,
    0,
    { output: "persisted result" },
    crypto.randomUUID(),
  );
  const registry = new JobCompletionRegistry({
    load: async (id) => {
      const job = await jobService.getById(id);
      return job ? completionFromJob(job) : null;
    },
  });
  const result = await registry.awaitCompletion(jobId, 1000);
  expect(result).toEqual({
    status: "completed",
    collected: { output: "persisted result" },
    exitCode: 0,
  });
  // A late Agent message cannot overwrite the already committed terminal result.
  await jobService.updateStatus(
    jobId,
    "failed",
    "scheduler-1",
    agentId,
    "late error",
    1,
    {},
    crypto.randomUUID(),
  );
  expect(await registry.awaitCompletion(jobId, 1000)).toEqual(result);
});

test("pinned dispatch survives restart without downgrading to a legacy channel or losing its SQLite intent", async () => {
  const pin: SpackExecutionPin = {
    dagHash: "a".repeat(32),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    lockfileDigest: `sha256:${"c".repeat(64)}`,
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
  };
  const { jobId, message, outbox } = await dispatchFixture(pin);
  expect(await outbox.enqueue(agentId, message)).toEqual({ sent: false, pending: true });
  const dispatcher = new AgentDispatcher();
  const delivered: ServerMessage[] = [];
  const channel = {
    push: (value: ServerMessage) => {
      if (value.payload.case === "dispatchJob" && value.payload.value.jobId === jobId)
        delivered.push(value);
    },
    close: () => {},
  };
  dispatcher.register(agentId, channel);
  const restarted = new JobDispatchOutbox(db, dispatcher);
  await restarted.redeliver(agentId);
  expect(delivered).toHaveLength(0);
  dispatcher.register(agentId, {
    ...channel,
    spackPinnedExecutionV1: true,
    verifiedCertFingerprint: "d".repeat(64),
  });
  await restarted.redeliver(agentId);
  expect(delivered).toHaveLength(1);
  const replay = delivered[0];
  if (!replay || replay.payload.case !== "dispatchJob" || !replay.payload.value.spackExecution)
    throw new Error("missing pinned replay");
  expect(toBinary(ServerMessageSchema, replay)).toEqual(toBinary(ServerMessageSchema, message));
  const sqlite = new Database(":memory:");
  try {
    runSqliteMigrations(sqlite);
    const inbox = new InboundAcks(drizzle(sqlite, { schema }));
    await inbox.persistInbound({
      dispatchId: `${jobId}:${replay.payload.value.dispatchEpoch}`,
      jobId,
      payload: {
        command: replay.payload.value.command,
        spackExecution: workflowSpackIntent(replay.payload.value.spackExecution),
      },
    });
    expect((await inbox.pendingInbound())[0]?.payload).toMatchObject({
      command: SPACK_PINNED_EXECUTION_PLACEHOLDER,
      spackExecution: { pin },
    });
  } finally {
    sqlite.close();
  }
});
