import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agents,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  softwareOperations,
  users,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import type { ServerMessage } from "@kuintessence/proto";
import {
  type JobSubmission,
  type JobSubmit,
  SPACK_PINNED_EXECUTION_PLACEHOLDER,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobDispatchOutbox } from "../grpc/job-dispatch-outbox";
import { PreferenceService } from "../preferences/preference-service";
import { InstalledRegistry } from "../software-governance/installed-registry";
import { SoftwareOperationService } from "../software-governance/operation-service";
import { bindWorkflowExecutionJob } from "../workflow/execution-jobs";
import {
  type LeasedWorkflowJournal,
  WorkflowExecutionJournalStore,
} from "../workflow/execution-journal";
import { AgentManager } from "./agent-manager";
import { JobService } from "./job-service";
import { type PlaceAndDispatchInput, PlacementOrchestrator } from "./placement-orchestrator";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Preparation recovery requires an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const userId = randomUUID();
const agentIds = [`prepare-a-${randomUUID()}`, `prepare-b-${randomUUID()}`] as const;
const runIds: string[] = [];
const service = new JobService(db);
const journal = new WorkflowExecutionJournalStore(db);
const agentManager = new AgentManager(db);
const preferences = new PreferenceService(db);

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, role: "user" });
  for (const agentId of agentIds)
    await agentManager.register({
      agentId,
      siteName: "Isolated preparation",
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
  await db.delete(softwareOperations).where(inArray(softwareOperations.agentId, [...agentIds]));
  await db.delete(agents).where(inArray(agents.agentId, [...agentIds]));
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end({ timeout: 5 });
});

async function fixture(install = false) {
  const runId = randomUUID();
  runIds.push(runId);
  await db
    .insert(workflowRuns)
    .values({ id: runId, name: "Preparation recovery", status: "running", submittedBy: userId });
  const lease = await journal.acquire(runId);
  if (!lease) throw new Error("Missing execution lease");
  const spec: JobSubmission = {
    nodeId: "solve",
    invocation: { path: '["node","solve"]' },
    name: "Preparation recovery",
    command: SPACK_PINNED_EXECUTION_PLACEHOLDER,
    envVars: {},
    inputStaging: [{ fileMetadataId: randomUUID(), stagePath: "input.txt" }],
    expectedOutputs: [],
    ...(install
      ? { softwareRequirements: [{ name: "hello", spec: "hello@1.0", installable: true }] }
      : {}),
    spackExecution: {
      spec: "hello@1.0",
      command: "hello",
      pin: {
        dagHash: "a".repeat(32),
        manifestDigest: `sha256:${"b".repeat(64)}`,
        lockfileDigest: `sha256:${"c".repeat(64)}`,
        spackVersion: "1.0.0",
        target: "linux-ubuntu24.04-x86_64",
      },
    },
  };
  const job: JobSubmit = {
    name: spec.name,
    command: spec.command,
    resources: { cpus: 1, memoryMb: 16 },
    inputStaging: spec.inputStaging,
    softwareRequirements: spec.softwareRequirements,
  };
  const binding = await bindWorkflowExecutionJob(lease, spec, (tx) =>
    service.submitInTransaction(tx, job, userId, {
      orgId: null,
      workflow: { runId, nodeId: spec.nodeId },
    }),
  );
  const dispatcher = new AgentDispatcher();
  const sent: { agentId: string; message: ServerMessage }[] = [];
  function connect(agentId: string) {
    dispatcher.register(agentId, {
      spackPinnedExecutionV1: true,
      spackMaterialDeliveryV1: true,
      verifiedCertFingerprint: "d".repeat(64),
      push: (message) => {
        sent.push({ agentId, message });
      },
      close: () => {},
    });
  }
  agentIds.forEach(connect);
  const outbox = new JobDispatchOutbox(db, dispatcher);
  let softwareReady = false;
  let installInterrupt: (() => Promise<void>) | undefined;
  const operations = new SoftwareOperationService(
    db,
    dispatcher,
    new InstalledRegistry(db),
    async () => {
      await installInterrupt?.();
      return {
        spackMaterialTicket: "test-ticket",
        spackManifestDigest: `sha256:${"b".repeat(64)}`,
      };
    },
    async () => {},
  );
  const orchestrator = new PlacementOrchestrator({
    db,
    agentManager,
    jobService: service,
    preferenceService: preferences,
    dispatcher,
    dispatchOutbox: outbox,
    ...(install
      ? {
          softwareOperations: operations,
          softwareInstallTimeoutMs: 100,
          softwareAvailability: {
            resolve: async (request) => {
              const available = (request.targetAgentIds ?? [...agentIds]).map((id) => ({
                agentId: id,
                siteName: "Isolated preparation",
                providerOrgId: null,
                status: "online",
                installMode: "explicit-install-grant" as const,
                reasons: [],
              }));
              return {
                spec: "hello@1.0",
                installedAvailable: softwareReady ? available : [],
                installableAvailable: !softwareReady && request.installable ? available : [],
                blocked: [],
                explanations: [],
              };
            },
          },
        }
      : {}),
  });
  let resolving = 0;
  let interrupt: (() => Promise<void>) | undefined;
  orchestrator.setInputUrlResolver(async ({ files }) => {
    resolving++;
    await interrupt?.();
    return files.map((file) => ({ ...file, sourceUrl: "https://files.test.invalid/input" }));
  });
  const input = (executionLease: LeasedWorkflowJournal): PlaceAndDispatchInput => ({
    jobId: binding.jobId,
    workflowRunId: runId,
    executionLease,
    job,
    userId,
    userRole: "user",
    orgId: null,
    preferredAgentIds: [agentIds[0]],
    spackExecution: spec.spackExecution,
  });
  async function reacquire() {
    const next = await journal.acquire(runId);
    if (!next) throw new Error("Recovery could not acquire the released lease");
    return next;
  }
  return {
    operations,
    softwareReady: () => {
      softwareReady = true;
    },
    installInterrupt: (callback: () => Promise<void>) => {
      installInterrupt = callback;
    },
    runId,
    jobId: binding.jobId,
    spec,
    lease,
    input,
    reacquire,
    dispatcher,
    outbox,
    orchestrator,
    sent,
    connect,
    resolving: () => resolving,
    interrupt: (callback: (() => Promise<void>) | undefined) => {
      interrupt = callback;
    },
  };
}

test("pre-envelope interruption resumes the original Job, Agent and epoch with its pinned intent", async () => {
  const f = await fixture();
  f.interrupt(async () => {
    await f.lease.release();
    throw new Error("Worker stopped while preparing file delivery");
  });
  await expect(f.orchestrator.placeAndDispatch(f.input(f.lease))).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  const assigned = await service.getById(f.jobId);
  expect(assigned).toMatchObject({ agentId: agentIds[0], status: "queued", dispatchEpoch: 1 });
  expect(f.sent).toHaveLength(0);
  expect(
    await db.select().from(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, f.jobId)),
  ).toHaveLength(0);
  f.interrupt(undefined);
  const next = await f.reacquire();
  const result = await f.orchestrator.placeAndDispatch({
    ...f.input(next),
    preferredAgentIds: [agentIds[1]],
  });
  expect(result).toMatchObject({ selectedAgentId: agentIds[0], dispatched: true });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({
    agentId: agentIds[0],
    message: {
      payload: {
        case: "dispatchJob",
        value: {
          jobId: f.jobId,
          dispatchEpoch: 1n,
          command: SPACK_PINNED_EXECUTION_PLACEHOLDER,
          spackExecution: f.spec.spackExecution,
        },
      },
    },
  });
  expect((await service.getById(f.jobId))?.dispatchEpoch).toBe(1);
  expect(
    await db.select().from(workflowExecutionJobs).where(eq(workflowExecutionJobs.runId, f.runId)),
  ).toHaveLength(1);
  expect(await f.orchestrator.placeAndDispatch(f.input(next))).toMatchObject({
    pendingDelivery: true,
  });
  expect(f.resolving()).toBe(2);
  expect(f.sent).toHaveLength(1);
  await next.release();
});

test("recovery waits for the original Agent instead of moving an assigned Job", async () => {
  const f = await fixture();
  f.interrupt(async () => {
    await f.lease.release();
    throw new Error("Interrupted preparation");
  });
  await expect(f.orchestrator.placeAndDispatch(f.input(f.lease))).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  f.interrupt(undefined);
  const next = await f.reacquire();
  f.dispatcher.unregister(agentIds[0]);
  await expect(f.orchestrator.placeAndDispatch(f.input(next))).rejects.toThrow(
    "Original Agent is unavailable",
  );
  expect(f.sent).toHaveLength(0);
  expect(await service.getById(f.jobId)).toMatchObject({
    status: "queued",
    agentId: agentIds[0],
    dispatchEpoch: 1,
  });
  f.connect(agentIds[0]);
  expect(await f.orchestrator.placeAndDispatch(f.input(next))).toMatchObject({ dispatched: true });
  await next.release();
});

test("losing the lease after the epoch check cannot commit or send a dispatch", async () => {
  const f = await fixture();
  const original = service.claimDispatchEpoch.bind(service);
  const claim = spyOn(service, "claimDispatchEpoch").mockImplementation(async (...args) => {
    const accepted = await original(...args);
    await f.lease.release();
    return accepted;
  });
  try {
    await expect(f.orchestrator.placeAndDispatch(f.input(f.lease))).rejects.toBeInstanceOf(
      WorkflowExecutionInterrupted,
    );
  } finally {
    claim.mockRestore();
  }
  expect(f.sent).toHaveLength(0);
  expect(
    await db.select().from(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, f.jobId)),
  ).toHaveLength(0);
  const next = await f.reacquire();
  await expect(service.claimDispatchEpoch(f.jobId, 1, f.lease)).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  await expect(
    service.updateStatus(
      f.jobId,
      "failed",
      undefined,
      undefined,
      "Stale worker failure",
      undefined,
      undefined,
      undefined,
      undefined,
      f.lease,
    ),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect((await service.getById(f.jobId))?.status).toBe("queued");
  await expect(f.orchestrator.placeAndDispatch(f.input(f.lease))).rejects.toBeInstanceOf(
    WorkflowExecutionInterrupted,
  );
  expect(await f.orchestrator.placeAndDispatch(f.input(next))).toMatchObject({ dispatched: true });
  expect((await service.getById(f.jobId))?.dispatchEpoch).toBe(1);
  await next.release();
});

test("a durable placement refuses a different principal, run or missing outbox", async () => {
  const f = await fixture();
  await expect(
    f.orchestrator.placeAndDispatch({ ...f.input(f.lease), userId: randomUUID() }),
  ).rejects.toThrow("principal");
  await expect(
    f.orchestrator.placeAndDispatch({ ...f.input(f.lease), workflowRunId: randomUUID() }),
  ).rejects.toThrow("run and dispatch outbox");
  const legacy = new PlacementOrchestrator({
    db,
    agentManager,
    jobService: service,
    preferenceService: preferences,
    dispatcher: f.dispatcher,
  });
  await expect(legacy.placeAndDispatch(f.input(f.lease))).rejects.toThrow(
    "run and dispatch outbox",
  );
  expect((await service.getById(f.jobId))?.status).toBe("pending");
  expect(f.sent).toHaveLength(0);
  await f.lease.release();
});

test("installation wait survives lease loss and resumes on its original Agent with the same operation", async () => {
  const f = await fixture(true);
  const waiting = f.orchestrator.placeAndDispatch(f.input(f.lease));
  const caught = waiting.catch((error: unknown) => error);
  const deadline = Date.now() + 4000;
  while (!f.sent.some((item) => item.message.payload.case === "softwareOperationRequest")) {
    if (Date.now() > deadline) throw new Error("Installation was not dispatched");
    await Bun.sleep(10);
  }
  await f.lease.release();
  expect(await caught).toBeInstanceOf(WorkflowExecutionInterrupted);
  const saved = await service.getById(f.jobId);
  const opId = saved?.softwareRequirements?.[0]?.operationId;
  if (!opId) throw new Error("Missing persistent operation binding");
  expect(saved).toMatchObject({ status: "pending", agentId: null });
  const next = await f.reacquire();
  f.dispatcher.unregister(agentIds[0]);
  await expect(
    f.orchestrator.placeAndDispatch({ ...f.input(next), preferredAgentIds: [agentIds[1]] }),
  ).rejects.toThrow("Original Agent");
  f.connect(agentIds[0]);
  await db
    .update(softwareOperations)
    .set({ status: "succeeded" })
    .where(eq(softwareOperations.id, opId));
  f.softwareReady();
  expect(
    await f.orchestrator.placeAndDispatch({ ...f.input(next), preferredAgentIds: [agentIds[1]] }),
  ).toMatchObject({ selectedAgentId: agentIds[0], dispatched: true });
  expect(
    f.sent.filter((item) => item.message.payload.case === "softwareOperationRequest"),
  ).toHaveLength(1);
  expect((await service.getById(f.jobId))?.softwareRequirements?.[0]?.operationId).toBe(opId);
  await db.delete(softwareOperations).where(eq(softwareOperations.id, opId));
  expect(await f.orchestrator.placeAndDispatch(f.input(next))).toMatchObject({
    pendingDelivery: true,
  });
  await next.release();
});

test("a stale workflow lease cannot bind or send a new installation", async () => {
  const f = await fixture(true);
  await f.lease.release();
  await expect(
    f.operations.requestInstallForJob({
      jobId: f.jobId,
      agentId: agentIds[0],
      spec: "hello@1.0",
      requestedBy: userId,
      executionLease: f.lease,
    }),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  expect((await service.getById(f.jobId))?.softwareRequirements?.[0]?.operationId).toBeUndefined();
  expect(f.sent).toHaveLength(0);
});

test("lease loss during material preparation prevents late install delivery and retains its operation binding", async () => {
  const f = await fixture(true);
  f.installInterrupt(() => f.lease.release());
  await expect(
    f.operations.requestInstallForJob({
      jobId: f.jobId,
      agentId: agentIds[0],
      spec: "hello@1.0",
      requestedBy: userId,
      executionLease: f.lease,
    }),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  const job = await service.getById(f.jobId);
  const operationId = job?.softwareRequirements?.[0]?.operationId;
  if (!operationId) throw new Error("Missing committed operation");
  expect(job?.status).toBe("pending");
  expect(f.sent).toHaveLength(0);
  const next = await f.reacquire();
  expect(
    await f.operations.requestInstallForJob({
      jobId: f.jobId,
      agentId: agentIds[0],
      spec: "hello@1.0",
      requestedBy: userId,
      executionLease: next,
    }),
  ).toMatchObject({ id: operationId, status: "queued" });
  expect(f.sent).toHaveLength(0);
  await next.release();
});
