import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  agents,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  users,
  workflowArtifacts,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import { WorkflowExecutionInterrupted, workflowDsl } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import {
  type LeasedWorkflowJournal,
  WorkflowExecutionJournalStore,
} from "../workflow/execution-journal";
import { completionFromJob } from "../workflow/job-completion-registry";
import { JobService } from "./job-service";
import { SandboxExecutionResolver } from "./sandbox-execution-resolver";
import { SandboxManifestSigner } from "./sandbox-manifest-signer";
import { SandboxNodeExecutor } from "./sandbox-node-executor";
import { PgArtifactStore, WorkflowArtifactService } from "./workflow-artifact";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Sandbox recovery requires an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const jobService = new JobService(db);
const userId = randomUUID();
const agentId = `sandbox-${randomUUID()}`;
const runIds: string[] = [];
const journal = new WorkflowExecutionJournalStore(db);
const artifacts = new PgArtifactStore(db);
const artifactService = new WorkflowArtifactService(artifacts);
const { privateKey } = generateKeyPairSync("ed25519");
const signer = new SandboxManifestSigner({
  keyId: "test",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const parsedNode = workflowDsl.WorkflowNodeSchema.parse({
  type: "Script",
  id: "transform",
  name: "transform",
  source: { type: "Inline", language: "python", content: "print('isolated fixture')" },
  runtimeProfileId: randomUUID(),
  executionIdentity: { type: "MappedAuto" },
  outputs: {
    result: { type: "File", durability: "Ephemeral", sizeHint: { type: "FixedBytes", bytes: 8 } },
  },
});
const node = (() => {
  if (parsedNode.type !== "Script") throw new Error("Expected Script fixture");
  return parsedNode;
})();
const invocation = (iteration = 0) => ({
  path: JSON.stringify(["node", "loop", "iteration", iteration, "node", node.id]),
});

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, role: "user" });
  await db.insert(agents).values({
    agentId,
    siteName: "Isolated Sandbox",
    siteId: "test-site",
    clusterId: "test-cluster",
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
});
afterAll(async () => {
  if (runIds.length) {
    await db.delete(jobDispatchOutbox).where(inArray(jobDispatchOutbox.workflowRunId, runIds));
    await db.delete(workflowRuns).where(inArray(workflowRuns.id, runIds));
  }
  await db.delete(jobs).where(eq(jobs.submittedBy, userId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end({ timeout: 5 });
});

async function fixture() {
  const runId = randomUUID();
  runIds.push(runId);
  await db
    .insert(workflowRuns)
    .values({ id: runId, name: "Sandbox recovery", status: "running", submittedBy: userId });
  const lease = await journal.acquire(runId);
  if (!lease) throw new Error("Missing lease");
  const runtime = {
    id: node.runtimeProfileId ?? "",
    language: "python" as const,
    ociDigest: null,
    sifDigest: `sha256:${"a".repeat(64)}`,
    adapters: ["slurm"],
  };
  const resolver = new SandboxExecutionResolver(db);
  spyOn(resolver, "resolveRuntime").mockImplementation(async () => runtime);
  const dispatched: string[] = [];
  let interrupt = false;
  let interruptPreparation = false;
  let refuseAuthorization = false;
  let cancelOnCompletion = false;
  async function complete(jobId: string) {
    const digest = createHash("sha256").update(jobId).digest("hex");
    await db
      .update(jobs)
      .set({
        agentId,
        status: "completed",
        dispatchEpoch: 1,
        collectedOutputs: {
          "$sandbox-artifact:result": JSON.stringify({
            descriptor: "result",
            sha256: digest,
            sizeBytes: 8,
            storageRef: `/isolated/${jobId}/result`,
          }),
        },
      })
      .where(eq(jobs.id, jobId));
  }
  const executor = (
    current: LeasedWorkflowJournal,
    scope: { orgId?: string | null } = { orgId: null },
  ) =>
    new SandboxNodeExecutor({
      db,
      jobService,
      resolver,
      signer,
      artifactService,
      workflowRunId: runId,
      executionLease: current,
      submittedBy: userId,
      userRole: "user",
      ...scope,
      defaultExecutionIdentity: { type: "MappedAuto" },
      limits: { pids: 16, outputBytes: 1024, logBytes: 1024 },
      resolvePolicy: async () => {
        throw new Error("Controlled placement does not sign or execute a script");
      },
      authorizeJobSubmission: async () => {
        if (refuseAuthorization) throw new WorkflowExecutionInterrupted("Projection unavailable");
      },
      orchestrator: {
        placeAndDispatch: async (input) => {
          dispatched.push(input.jobId);
          if (interruptPreparation)
            throw new WorkflowExecutionInterrupted("Preparation interrupted");
          await complete(input.jobId);
          return { selectedAgentId: agentId, dispatched: true, rejections: [] };
        },
      },
      awaitCompletion: async (jobId) => {
        if (interrupt) throw new WorkflowExecutionInterrupted("Restart after remote completion");
        if (cancelOnCompletion)
          await db
            .update(workflowRuns)
            .set({ status: "cancelling" })
            .where(eq(workflowRuns.id, runId));
        const saved = await jobService.getById(jobId);
        const completion = saved && completionFromJob(saved);
        if (!completion) throw new WorkflowExecutionInterrupted("Awaiting original job result");
        return completion;
      },
    });
  return {
    interruptPreparation: (value: boolean) => {
      interruptPreparation = value;
    },
    runId,
    lease,
    runtime,
    executor,
    dispatched,
    complete,
    interrupt: (value: boolean) => {
      interrupt = value;
    },
    cancelOnCompletion: () => {
      cancelOnCompletion = true;
    },
    refuseAuthorization: (value: boolean) => {
      refuseAuthorization = value;
    },
  };
}

test("Script recovery reuses the completed Job and artifact; loop invocations keep independent outputs", async () => {
  const f = await fixture();
  f.interrupt(true);
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "Restart after remote completion",
  );
  expect(f.dispatched).toHaveLength(1);
  await f.lease.release();
  const next = await journal.acquire(f.runId);
  if (!next) throw new Error("Missing new lease");
  f.interrupt(false);
  const first = await f.executor(next).execute(node, {}, invocation());
  const replay = await f.executor(next).execute(node, {}, invocation());
  expect(first.status).toBe("Succeeded");
  expect(replay).toEqual(first);
  expect(f.dispatched).toHaveLength(1);
  const second = await f.executor(next).execute(node, {}, invocation(1));
  expect(second.values?.result).not.toEqual(first.values?.result);
  expect(f.dispatched).toHaveLength(2);
  expect(
    await db.select().from(workflowExecutionJobs).where(eq(workflowExecutionJobs.runId, f.runId)),
  ).toHaveLength(2);
  const outputs = await db
    .select()
    .from(workflowArtifacts)
    .where(eq(workflowArtifacts.workflowRunId, f.runId));
  expect(outputs).toHaveLength(2);
  expect(new Set(outputs.map((output) => output.producerJobId)).size).toBe(2);
  await next.release();
});

test("a saved Job before authorization/placement is resumed once; changed code/runtime/identity cannot reuse it", async () => {
  const f = await fixture();
  f.refuseAuthorization(true);
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "Projection unavailable",
  );
  const [binding] = await db
    .select()
    .from(workflowExecutionJobs)
    .where(eq(workflowExecutionJobs.runId, f.runId));
  expect(binding).toBeDefined();
  expect(f.dispatched).toHaveLength(0);
  const changed = {
    ...node,
    source: { type: "Inline" as const, language: "python" as const, content: "different code" },
  };
  await expect(f.executor(f.lease).execute(changed, {}, invocation())).rejects.toThrow(
    "changed its job intent",
  );
  f.runtime.sifDigest = `sha256:${"b".repeat(64)}`;
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "changed its job intent",
  );
  f.runtime.sifDigest = `sha256:${"a".repeat(64)}`;
  await expect(
    f
      .executor(f.lease)
      .execute({ ...node, executionIdentity: { type: "SharedService" } }, {}, invocation()),
  ).rejects.toThrow("changed its job intent");
  f.refuseAuthorization(false);
  await f.executor(f.lease).execute(node, {}, invocation());
  expect(f.dispatched).toEqual([binding?.jobId ?? "missing"]);
  await f.lease.release();
});

test("assigned Script resumes original preparation; an existing outbox never triggers another placement", async () => {
  const f = await fixture();
  f.refuseAuthorization(true);
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "Projection unavailable",
  );
  const [binding] = await db
    .select()
    .from(workflowExecutionJobs)
    .where(eq(workflowExecutionJobs.runId, f.runId));
  if (!binding) throw new Error("Missing binding");
  f.refuseAuthorization(false);
  await db
    .update(jobs)
    .set({ agentId, status: "queued", dispatchEpoch: 1 })
    .where(eq(jobs.id, binding.jobId));
  f.interruptPreparation(true);
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "Preparation interrupted",
  );
  await db.insert(jobDispatchOutbox).values({
    jobId: binding.jobId,
    agentId,
    dispatchEpoch: 1,
    payloadBase64: Buffer.from("not-dispatched-test-payload").toString("base64"),
    workflowRunId: f.runId,
  });
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toThrow(
    "Awaiting original job result",
  );
  expect(f.dispatched).toEqual([binding.jobId]);
  await f.complete(binding.jobId);
  expect((await f.executor(f.lease).execute(node, {}, invocation())).status).toBe("Succeeded");
  expect(f.dispatched).toEqual([binding.jobId]);
  await f.lease.release();
});

test("a stopped workflow and a lease belonging to another run cannot create a Script Job", async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(f.executor(f.lease, {}).execute(node, {}, invocation())).rejects.toThrow(
    "explicit organization scope",
  );
  await expect(f.executor(other.lease).execute(node, {}, invocation())).rejects.toThrow(
    "current run lease",
  );
  await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, f.runId));
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  expect(
    await db.select().from(workflowExecutionJobs).where(eq(workflowExecutionJobs.runId, f.runId)),
  ).toHaveLength(0);
});

test("per-job artifact registration is immutable, concurrent-idempotent and preserves persistence metadata", async () => {
  const f = await fixture();
  await f.executor(f.lease).execute(node, {}, invocation());
  const jobId = f.dispatched[0];
  if (!jobId) throw new Error("Missing job");
  const input = {
    workflowRunId: f.runId,
    producerNodeId: node.id,
    producerJobId: jobId,
    descriptor: "extra",
    ioType: "File" as const,
    contentHash: "c".repeat(64),
    sizeBytes: 8,
    durability: "Persistent" as const,
    ownerId: userId,
    agentId,
    siteId: "test-site",
    clusterId: "test-cluster",
    storageRef: "/isolated/extra",
  };
  const registrations = await Promise.all(
    Array.from({ length: 8 }, () => artifacts.registerLocal(input)),
  );
  expect(new Set(registrations.map((entry) => entry.artifact.id)).size).toBe(1);
  const id = registrations[0]?.artifact.id;
  if (!id) throw new Error("Missing artifact");
  const persisted = new Date();
  await db
    .update(workflowArtifacts)
    .set({ persistentAt: persisted })
    .where(eq(workflowArtifacts.id, id));
  expect((await artifacts.registerLocal(input)).artifact.persistentAt).toEqual(persisted);
  await expect(artifacts.registerLocal({ ...input, contentHash: "d".repeat(64) })).rejects.toThrow(
    "immutable",
  );
  await expect(artifacts.registerLocal({ ...input, producerNodeId: "different" })).rejects.toThrow(
    "immutable",
  );
  const legacy = await artifacts.registerLocal({ ...input, producerJobId: null });
  expect(legacy.artifact.id).not.toBe(id);
  expect(
    (await artifacts.registerLocal({ ...input, producerJobId: null, contentHash: "e".repeat(64) }))
      .artifact.contentHash,
  ).toBe("e".repeat(64));
  await f.lease.release();
});

test("cancellation during completion prevents a late Script worker from publishing artifacts", async () => {
  const f = await fixture();
  f.cancelOnCompletion();
  await expect(f.executor(f.lease).execute(node, {}, invocation())).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  expect(f.dispatched).toHaveLength(1);
  expect(
    await db.select().from(workflowArtifacts).where(eq(workflowArtifacts.workflowRunId, f.runId)),
  ).toHaveLength(0);
});
