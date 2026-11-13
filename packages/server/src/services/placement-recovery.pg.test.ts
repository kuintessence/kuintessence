import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
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
import {
  type ServerMessage,
  SoftwareOperationResultSchema,
  SoftwareOperationStatus,
} from "@kuintessence/proto";
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
beforeEach(async () => {
  await db.delete(softwareOperations).where(inArray(softwareOperations.agentId, [...agentIds]));
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
      softwareOperationReplayV1: true,
      federationInstallationV1: true,
      federationInstallationLeaseV1: true,
      federationInstallationMaterialLeaseV1: true,
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
    installInterrupt: (callback: (() => Promise<void>) | undefined) => {
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
  f.installInterrupt(undefined);
  const deadline = Date.now() + 7000;
  while (f.sent.length === 0) {
    if (Date.now() > deadline) throw new Error("Saved delivery deadline was not retried");
    await Bun.sleep(100);
    expect(await f.operations.requestInstallForJob(installationRequest(f, next))).toMatchObject({
      id: operationId,
    });
  }
  expect(f.sent).toHaveLength(1);
  await next.release();
});

function installationRequest(f: Awaited<ReturnType<typeof fixture>>, lease = f.lease) {
  return {
    jobId: f.jobId,
    agentId: agentIds[0],
    spec: "hello@1.0",
    requestedBy: userId,
    executionLease: lease,
  };
}
async function dueAgain(operationId: string) {
  await db
    .update(softwareOperations)
    .set({ nextDispatchAt: new Date(0) })
    .where(eq(softwareOperations.id, operationId));
}

test("pending delivery survives service replacement and retains the same operation with renewed tickets", async () => {
  const f = await fixture(true);
  f.installInterrupt(async () => {
    throw new Error("material service unavailable");
  });
  await expect(f.operations.requestInstallForJob(installationRequest(f))).rejects.toThrow(
    "delivery is pending",
  );
  const job = await service.getById(f.jobId);
  const id = job?.softwareRequirements?.[0]?.operationId;
  if (!id) throw new Error("Missing durable install intent");
  expect((await f.operations.getOperation(id))?.status).toBe("queued");
  expect(f.sent).toHaveLength(0);
  await f.lease.release();
  const next = await f.reacquire();
  let tickets = 0;
  const resumed = new SoftwareOperationService(
    db,
    f.dispatcher,
    new InstalledRegistry(db),
    async () => ({
      spackMaterialTicket: `renewed-ticket-${++tickets}`,
      spackManifestDigest: `sha256:${"b".repeat(64)}`,
    }),
    async () => {},
  );
  try {
    // The saved delivery deadline, rather than a new operation, controls concurrent recovery.
    await dueAgain(id);
    await Promise.all(
      Array.from({ length: 8 }, () => resumed.requestInstallForJob(installationRequest(f, next))),
    );
    expect(f.sent).toHaveLength(1);
    for (let round = 0; round < 2; round++) {
      const message = f.sent.at(-1)?.message;
      if (message?.payload.case !== "softwareOperationRequest")
        throw new Error("Missing install request");
      const request = message.payload.value;
      expect(request).toMatchObject({
        operationId: id,
        durableReplay: true,
        spackMaterialTicket: `renewed-ticket-${round + 1}`,
      });
      if (round === 0) {
        // No result has arrived, so recovery must resend the original operation.
        await dueAgain(id);
        await resumed.requestInstallForJob(installationRequest(f, next));
      }
    }
    await resumed.applyAgentResult(
      agentIds[0],
      create(SoftwareOperationResultSchema, {
        operationId: id,
        action: 1,
        spec: "hello@1.0",
        status: SoftwareOperationStatus.SUCCEEDED,
        replayed: true,
      }),
    );
    expect(await resumed.requestInstallForJob(installationRequest(f, next))).toMatchObject({
      id,
      status: "succeeded",
    });
    expect(f.sent).toHaveLength(2);
    expect(
      await db.select().from(softwareOperations).where(eq(softwareOperations.agentId, agentIds[0])),
    ).toHaveLength(1);
  } finally {
    await next.release();
  }
});

test("durable installation does not create an intent on an old Agent or send after cancellation", async () => {
  const f = await fixture(true);
  f.dispatcher.register(agentIds[0], {
    push: () => {
      throw new Error("Unexpected delivery");
    },
    close: () => {},
  });
  await expect(f.operations.requestInstallForJob(installationRequest(f))).rejects.toThrow(
    "software_operation_replay_v1",
  );
  expect((await service.getById(f.jobId))?.softwareRequirements?.[0]?.operationId).toBeUndefined();
  f.connect(agentIds[0]);
  f.installInterrupt(async () => {
    await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, f.jobId));
  });
  await expect(f.operations.requestInstallForJob(installationRequest(f))).rejects.toThrow(
    "Job stopped",
  );
  expect(f.sent).toHaveLength(0);
  await f.lease.release();
});

test("failed channel push stays queued; manifest changes and wrong-spec results cannot alter the operation", async () => {
  const f = await fixture(true);
  f.dispatcher.register(agentIds[0], {
    spackMaterialDeliveryV1: true,
    softwareOperationReplayV1: true,
    verifiedCertFingerprint: "verified",
    push: () => {
      throw new Error("channel closed");
    },
    close: () => {},
  });
  const op = await f.operations.requestInstallForJob(installationRequest(f));
  expect(op.status).toBe("queued");
  f.connect(agentIds[0]);
  await dueAgain(op.id);
  const changed = new SoftwareOperationService(
    db,
    f.dispatcher,
    new InstalledRegistry(db),
    async () => ({
      spackMaterialTicket: "changed-ticket",
      spackManifestDigest: `sha256:${"c".repeat(64)}`,
    }),
    async () => {},
  );
  await expect(changed.requestInstallForJob(installationRequest(f))).rejects.toThrow(
    "immutable intent",
  );
  expect(f.sent).toHaveLength(0);
  await f.operations.applyAgentResult(
    agentIds[0],
    create(SoftwareOperationResultSchema, {
      operationId: op.id,
      action: 1,
      status: SoftwareOperationStatus.SUCCEEDED,
      spec: "other@1",
    }),
  );
  expect((await f.operations.getOperation(op.id))?.status).toBe("queued");
  await dueAgain(op.id);
  await f.operations.requestInstallForJob(installationRequest(f));
  expect(f.sent).toHaveLength(1);
  await f.lease.release();
});

test("completion during material renewal returns the saved terminal result", async () => {
  const f = await fixture(true);
  const op = await f.operations.requestInstallForJob(installationRequest(f));
  await dueAgain(op.id);
  f.installInterrupt(async () => {
    await db
      .update(softwareOperations)
      .set({ status: "succeeded" })
      .where(eq(softwareOperations.id, op.id));
    throw new Error("terminal operations cannot renew credentials");
  });
  expect(await f.operations.requestInstallForJob(installationRequest(f))).toMatchObject({
    id: op.id,
    status: "succeeded",
  });
  expect(f.sent).toHaveLength(1);
  await f.lease.release();
});

test("legacy pending installations are not silently upgraded into replayable operations", async () => {
  const f = await fixture(true);
  const legacy = await f.operations.requestInstallForJob({
    jobId: f.jobId,
    agentId: agentIds[0],
    spec: "hello@1.0",
    requestedBy: userId,
  });
  await expect(f.operations.requestInstallForJob(installationRequest(f))).rejects.toThrow(
    "Legacy installation",
  );
  const [saved] = await db
    .select()
    .from(softwareOperations)
    .where(eq(softwareOperations.id, legacy.id));
  expect(saved).toMatchObject({ replayEnabled: false, manifestDigest: null });
  expect(f.sent).toHaveLength(1);
  await f.lease.release();
});

test("pinned installation persists the required material before preparation and cannot join a different pin", async () => {
  const f = await fixture(true);
  const expectedPin = f.spec.spackExecution?.pin;
  if (!expectedPin) throw new Error("Missing test execution pin");
  f.installInterrupt(async () => {
    const [saved] = await db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.agentId, agentIds[0]));
    expect(saved?.manifestDigest).toBe(expectedPin.manifestDigest);
  });
  const operation = await f.operations.requestInstallForJob({
    ...installationRequest(f),
    expectedPin,
  });
  await expect(
    f.operations.requestInstallForJob({
      ...installationRequest(f),
      expectedPin: { ...expectedPin, manifestDigest: `sha256:${"e".repeat(64)}` },
    }),
  ).rejects.toThrow("binding changed");
  expect(
    (await f.operations.requestInstallForJob({ ...installationRequest(f), expectedPin })).id,
  ).toBe(operation.id);
  expect(f.sent).toHaveLength(1);
  await f.lease.release();
});

test("federation installation requires its authorization service, lease and original execution pin", async () => {
  const f = await fixture(true);
  await db
    .update(workflowRuns)
    .set({ input: { yaml: "fixture", role: "user", federationReservationId: randomUUID() } })
    .where(eq(workflowRuns.id, f.runId));
  const expectedPin = f.spec.spackExecution?.pin;
  if (!expectedPin) throw new Error("Missing fixture pin");
  const request = { ...installationRequest(f), expectedPin };
  try {
    await expect(f.operations.requestInstallForJob(request)).rejects.toThrow(
      "authorization is unavailable",
    );
    const service = new SoftwareOperationService(
      db,
      f.dispatcher,
      new InstalledRegistry(db),
      async () => ({
        spackMaterialTicket: "test",
        spackManifestDigest: expectedPin.manifestDigest,
      }),
      async () => {},
      async () => async () => Number.POSITIVE_INFINITY,
    );
    await expect(
      service.requestInstallForJob({ ...request, executionLease: undefined }),
    ).rejects.toThrow("authorization is unavailable");
    await expect(
      service.requestInstallForJob({ ...request, expectedPin: undefined }),
    ).rejects.toThrow("saved software pin");
    await expect(
      service.requestInstallForJob({
        ...request,
        expectedPin: { ...expectedPin, dagHash: "b".repeat(32) },
      }),
    ).rejects.toThrow("saved software pin");
    expect(
      await db.select().from(softwareOperations).where(eq(softwareOperations.agentId, agentIds[0])),
    ).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.lease.release();
  }
});

test.each([
  "material-preparation",
  "retry",
] as const)("federation installation revoked during %s does not send or replace its durable operation", async (boundary) => {
  const f = await fixture(true);
  await db
    .update(workflowRuns)
    .set({ input: { yaml: "fixture", role: "user", federationReservationId: randomUUID() } })
    .where(eq(workflowRuns.id, f.runId));
  const expectedPin = f.spec.spackExecution?.pin;
  if (!expectedPin) throw new Error("Missing fixture pin");
  let revoked = false;
  let prepareCount = 0;
  const operations = new SoftwareOperationService(
    db,
    f.dispatcher,
    new InstalledRegistry(db),
    async () => {
      if (boundary === "material-preparation") revoked = true;
      return { spackMaterialTicket: "test", spackManifestDigest: expectedPin.manifestDigest };
    },
    async () => {},
    async (runId) => {
      expect(runId).toBe(f.runId);
      prepareCount++;
      return async () => {
        if (revoked)
          throw new WorkflowExecutionInterrupted("Federation authority revoked", {
            retryable: false,
          });
        return Number.POSITIVE_INFINITY;
      };
    },
  );
  const request = { ...installationRequest(f), expectedPin };
  try {
    if (boundary === "material-preparation") {
      await expect(operations.requestInstallForJob(request)).rejects.toThrow("authority revoked");
      expect(f.sent).toHaveLength(0);
    } else {
      const first = await operations.requestInstallForJob(request);
      expect(f.sent).toHaveLength(1);
      await dueAgain(first.id);
      revoked = true;
      await expect(operations.requestInstallForJob(request)).rejects.toThrow("authority revoked");
      expect(prepareCount).toBe(2);
      expect(f.sent).toHaveLength(1);
    }
    const rows = await db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.agentId, agentIds[0]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
  } finally {
    await f.lease.release();
  }
});

async function markFederationInstallation(f: Awaited<ReturnType<typeof fixture>>) {
  await db
    .update(workflowRuns)
    .set({
      input: { yaml: "fixture", role: "user", federationReservationId: randomUUID() },
    })
    .where(eq(workflowRuns.id, f.runId));
}

function federationInstallationService(
  f: Awaited<ReturnType<typeof fixture>>,
  beforeTicket?: (operationId: string) => Promise<void>,
) {
  const expectedPin = f.spec.spackExecution?.pin;
  if (!expectedPin) throw new Error("Missing fixture pin");
  return new SoftwareOperationService(
    db,
    f.dispatcher,
    new InstalledRegistry(db),
    async (input) => {
      await beforeTicket?.(input.operationId);
      return { spackMaterialTicket: "test", spackManifestDigest: expectedPin.manifestDigest };
    },
    async () => {},
    async () => async () => Number.POSITIVE_INFINITY,
  );
}

// Protocol authorization is injected here; real protocol checks are covered by assets.pg.test.ts.
test.each([
  [true, true],
  [true, false],
  [false, true],
] as const)("installation authority is not shared across jobs: federation=%s/%s", async (firstFederated, secondFederated) => {
  const first = await fixture(true);
  const second = await fixture(true);
  try {
    if (firstFederated) await markFederationInstallation(first);
    if (secondFederated) await markFederationInstallation(second);
    const operations = federationInstallationService(first);
    const a = await operations.requestInstallForJob({
      ...installationRequest(first),
      expectedPin: first.spec.spackExecution?.pin,
    });
    const b = await operations.requestInstallForJob({
      ...installationRequest(second),
      expectedPin: second.spec.spackExecution?.pin,
    });
    expect(a.id).not.toBe(b.id);
    const rows = await db
      .select()
      .from(softwareOperations)
      .where(inArray(softwareOperations.id, [a.id, b.id]));
    expect(rows.find((row) => row.id === a.id)?.federationJobId).toBe(
      firstFederated ? first.jobId : null,
    );
    expect(rows.find((row) => row.id === b.id)?.federationJobId).toBe(
      secondFederated ? second.jobId : null,
    );
    expect(first.sent).toHaveLength(2);
    await dueAgain(a.id);
    expect(
      (
        await operations.requestInstallForJob({
          ...installationRequest(first),
          expectedPin: first.spec.spackExecution?.pin,
        })
      ).id,
    ).toBe(a.id);
    expect(first.sent).toHaveLength(3);
  } finally {
    await first.lease.release();
    await second.lease.release();
  }
});

test("a foreign or legacy installation association cannot replace federation authority", async () => {
  const owner = await fixture(true);
  const other = await fixture(true);
  try {
    await markFederationInstallation(owner);
    await markFederationInstallation(other);
    const operations = federationInstallationService(owner);
    const operation = await operations.requestInstallForJob({
      ...installationRequest(owner),
      expectedPin: owner.spec.spackExecution?.pin,
    });
    await db
      .update(jobs)
      .set({
        softwareRequirements: [
          { name: "hello", spec: "hello@1.0", installable: true, operationId: operation.id },
        ],
      })
      .where(eq(jobs.id, other.jobId));
    await expect(
      operations.requestInstallForJob({
        ...installationRequest(other),
        expectedPin: other.spec.spackExecution?.pin,
      }),
    ).rejects.toThrow("binding changed");
    await db
      .update(softwareOperations)
      .set({ federationJobId: null })
      .where(eq(softwareOperations.id, operation.id));
    await expect(
      operations.requestInstallForJob({
        ...installationRequest(owner),
        expectedPin: owner.spec.spackExecution?.pin,
      }),
    ).rejects.toThrow("binding changed");
    expect(owner.sent).toHaveLength(1);
    expect(
      await db.select().from(softwareOperations).where(eq(softwareOperations.agentId, agentIds[0])),
    ).toHaveLength(1);
  } finally {
    await owner.lease.release();
    await other.lease.release();
  }
});

test("changing the installation authority during ticket preparation prevents delivery", async () => {
  const f = await fixture(true);
  try {
    await markFederationInstallation(f);
    const operations = federationInstallationService(f, async (operationId) => {
      await db
        .update(softwareOperations)
        .set({ federationJobId: null })
        .where(eq(softwareOperations.id, operationId));
    });
    await expect(
      operations.requestInstallForJob({
        ...installationRequest(f),
        expectedPin: f.spec.spackExecution?.pin,
      }),
    ).rejects.toThrow("immutable intent");
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.lease.release();
  }
});

test("database rejects a federation installation without durable material authority", async () => {
  await expect(
    db
      .insert(softwareOperations)
      .values({
        agentId: agentIds[0],
        requestedBy: userId,
        action: "install",
        spec: "hello@1.0",
        federationJobId: randomUUID(),
      })
      .execute(),
  ).rejects.toThrow();
});
