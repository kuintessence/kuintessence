// Test isolation: uses agent IDs prefixed "po-agent-", org/user emails "po-test-*"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agents,
  createPgDb,
  jobs,
  orgs,
  type PgDb,
  schedulerQueues,
  users,
} from "@kuintessence/db";
import type { ServerMessage } from "@kuintessence/proto";
import type { SandboxSignedManifest } from "@kuintessence/shared";
import { eq, like, notLike } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { PreferenceService } from "../preferences/preference-service";
import { AgentManager } from "./agent-manager";
import { DataPrerequisitePlacementGate, DataPrerequisitePlanner } from "./data-prerequisite";
import { JobService } from "./job-service";
import { availabilityRequestForRequirement, PlacementOrchestrator } from "./placement-orchestrator";
import { QueueInventoryService } from "./queue-inventory";
import { type QueueAccessContext, QueueRegistryService } from "./queue-registry";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

test("software placement preserves the frozen canonical asset identity", () => {
  expect(
    availabilityRequestForRequirement(
      {
        assetId: "00000000-0000-4000-8000-000000000001",
        name: "zlib",
        version: "1.3.1",
        installable: false,
      },
      ["lab-slurm23"],
    ),
  ).toEqual({
    assetRef: { kind: "spack-package", id: "00000000-0000-4000-8000-000000000001" },
    rawSpec: "zlib@1.3.1",
    targetAgentIds: ["lab-slurm23"],
    installable: false,
  });
});

describe("PlacementOrchestrator", () => {
  let db: PgDb;
  let agentManager: AgentManager;
  let jobService: JobService;
  let preferenceService: PreferenceService;
  let dispatcher: AgentDispatcher;
  let orchestrator: PlacementOrchestrator;
  let userId: string;
  let orgId: string;
  const cleanupJobIds: string[] = [];

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    agentManager = new AgentManager(db);
    jobService = new JobService(db);
    preferenceService = new PreferenceService(db);
    dispatcher = new AgentDispatcher();
    orchestrator = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
    });

    const [org] = await db.insert(orgs).values({ name: "po-test-org" }).returning();
    if (!org) throw new Error("failed to create test org");
    orgId = org.id;

    const [user] = await db
      .insert(users)
      .values({ email: "po-test@kuintessence.test", role: "user", orgId })
      .returning();
    if (!user) throw new Error("failed to create test user");
    userId = user.id;

    // Ensure test agents are clean before starting (jobs first to satisfy FK)
    await db.delete(jobs).where(like(jobs.name, "po-test-%"));
    await db.delete(schedulerQueues).where(like(schedulerQueues.queueId, "po-%"));
    await db.delete(agents).where(eq(agents.agentId, "po-agent-1"));
    await db.delete(agents).where(eq(agents.agentId, "po-agent-2"));
  });

  beforeEach(async () => {
    // Neutralise pollution from a dev stack sharing this Postgres: take any
    // non-suite agent (e.g. a running local agent) offline so placement only
    // considers the po-agent-* this suite registers. Tests run sequentially, so
    // this never races another suite's agents.
    await db.update(agents).set({ status: "offline" }).where(notLike(agents.agentId, "po-agent-%"));
  });

  afterAll(async () => {
    // Delete jobs first to satisfy FK constraint (jobs.agent_id → agents.agent_id)
    for (const id of cleanupJobIds) {
      await db.delete(jobs).where(eq(jobs.id, id));
    }
    await db.delete(jobs).where(like(jobs.name, "po-test-%"));
    await db.delete(schedulerQueues).where(like(schedulerQueues.queueId, "po-%"));
    await db.delete(agents).where(eq(agents.agentId, "po-agent-1"));
    await db.delete(agents).where(eq(agents.agentId, "po-agent-2"));
    await db.delete(users).where(eq(users.email, "po-test@kuintessence.test"));
    await db.delete(orgs).where(like(orgs.name, "po-test-%"));
  });

  function mockChannel() {
    const messages: ServerMessage[] = [];
    return {
      messages,
      push: (m: ServerMessage) => messages.push(m),
      close: () => {},
    };
  }

  function sandboxManifest(jobId: string, digest: string): SandboxSignedManifest {
    return {
      jobId,
      script: {
        language: "python",
        entrypoint: "main.py",
        contentBase64: Buffer.from("print('ok')\n").toString("base64"),
        sha256: "1".repeat(64),
        bundleSha256: "2".repeat(64),
      },
      runtime: {
        profileId: "00000000-0000-0000-0000-000000000222",
        kind: "SIF",
        digest,
      },
      executionMode: "RootImpersonation",
      identity: {
        mode: "MappedAccount",
        accountId: "00000000-0000-0000-0000-000000000333",
        backend: "Unix",
        username: "scientist",
        uid: 1001,
        gid: 1001,
        schedulerAccount: null,
        allowedQueues: [],
      },
      mounts: [
        {
          descriptor: "input",
          ioType: "File",
          mode: "ReadOnly",
          relativePath: "inputs/data",
          containerPath: "/kq/inputs/input",
          expectedSha256: "3".repeat(64),
          inlineContentBase64: null,
          batchEntries: [],
          sizeLimitBytes: 1_024,
          required: true,
        },
      ],
      limits: { pids: 16, outputBytes: 1_024, logBytes: 1_024 },
      networkDisabled: true,
      envelope: {
        keyId: "test",
        nonce: "nonce-1234567890123456",
        issuedAtUnixMs: 1,
        expiresAtUnixMs: 2,
        manifestSha256: "4".repeat(64),
        signatureBase64: "c2ln",
      },
    };
  }

  test("returns null selectedAgentId when no agents online", async () => {
    // Ensure no po-agent is registered at this point
    await db.delete(agents).where(eq(agents.agentId, "po-agent-1"));
    await db.delete(agents).where(eq(agents.agentId, "po-agent-2"));
    await db.update(agents).set({ status: "offline" }).where(notLike(agents.agentId, "po-agent-%"));

    const job = await jobService.submit(
      {
        name: "po-test-no-agents",
        command: "echo",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: { name: job.name, command: job.command, resources: { cpus: 1, memoryMb: 1024 } },
      userId,
      userRole: "user",
      orgId,
    });
    expect(r.selectedAgentId).toBeNull();
    expect(r.rejections).toHaveLength(0);
    expect(r.dispatched).toBe(false);
  });

  test("places job on online agent and pushes dispatch", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);

    const job = await jobService.submit(
      {
        name: "po-test-place",
        command: "echo",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: { name: job.name, command: job.command, resources: { cpus: 1, memoryMb: 1024 } },
      userId,
      userRole: "user",
      orgId,
    });

    expect(r.selectedAgentId).toBe("po-agent-1");
    expect(r.dispatched).toBe(true);
    expect(ch.messages).toHaveLength(1);
    expect(ch.messages[0]?.payload.case).toBe("dispatchJob");

    const updated = await jobService.getById(job.id);
    expect(updated?.agentId).toBe("po-agent-1");
    expect(updated?.providerOrgId).toBe(orgId);
    expect(updated?.status).toBe("queued");

    dispatcher.unregister("po-agent-1");
  });

  test("compute-health gate is first in preview and prevents dispatch when enforced", async () => {
    const observedAt = new Date();
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      computeHealthV1: true,
    });
    await agentManager.heartbeat(
      {
        agentId: "po-agent-1",
        cpuUsagePercent: 10,
        memoryUsedMb: 1_024,
        memoryTotalMb: 8_192,
        computeHealth: {
          state: "unavailable",
          observedAtUnixMs: BigInt(observedAt.getTime()),
          nodeCount: 2,
          operationalNodeCount: 0,
          reason: "no_operational_nodes",
        },
      },
      observedAt,
    );
    const channel = mockChannel();
    dispatcher.register("po-agent-1", channel);
    const healthGated = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      computeHealth: { enforce: true, now: () => observedAt },
    });
    const jobInput = {
      name: "po-test-compute-health-gate",
      command: "echo",
      resources: { cpus: 1, memoryMb: 1_024 },
    };

    const preview = await healthGated.runWithTrace({
      job: jobInput,
      userId,
      userRole: "user",
      orgId,
      preview: true,
    });
    expect(preview.stages[0]?.name).toBe("compute-health");
    expect(preview.stages[0]?.rejected[0]?.reason).toContain("no_operational_nodes");
    expect(preview.finalDecision).toBeNull();

    const job = await jobService.submit(jobInput, userId);
    cleanupJobIds.push(job.id);
    const result = await healthGated.placeAndDispatch({
      jobId: job.id,
      job: jobInput,
      userId,
      userRole: "user",
      orgId,
    });

    expect(result.selectedAgentId).toBeNull();
    expect(result.dispatched).toBe(false);
    expect(result.trace?.stages[0]?.name).toBe("compute-health");
    expect(result.rejections).toContainEqual({
      stage: "compute-health",
      agentId: "po-agent-1",
      reason: "compute health reports unavailable: no_operational_nodes",
    });
    expect(channel.messages).toHaveLength(0);

    dispatcher.unregister("po-agent-1");
  });

  test("persists restricted-data-isolation preflight rejection before dispatch", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await db
      .update(agents)
      .set({
        sandboxReadiness: "ready",
        sandboxRuntimeCache: [
          {
            kind: "SIF",
            digest: `sha256:${"a".repeat(64)}`,
            signatureVerified: true,
          },
        ],
        restrictedDataIsolation: false,
      })
      .where(eq(agents.agentId, "po-agent-1"));
    const channel = mockChannel();
    dispatcher.register("po-agent-1", channel);
    const jobInput = {
      name: "po-test-restricted-isolation-trace",
      command: "sandbox-manifest",
      resources: { cpus: 1, memoryMb: 1_024 },
    };
    const job = await jobService.submit(jobInput, userId);
    cleanupJobIds.push(job.id);

    const result = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: jobInput,
      userId,
      userRole: "user",
      orgId,
      restrictedNoEgress: true,
      sandboxExecution: {
        runtimeDigests: { SIF: `sha256:${"a".repeat(64)}` },
        build: async () => sandboxManifest(job.id, `sha256:${"a".repeat(64)}`),
      },
    });

    expect(result.selectedAgentId).toBeNull();
    expect(result.dispatched).toBe(false);
    expect(result.rejections).toContainEqual({
      stage: "restricted-data-isolation",
      agentId: "po-agent-1",
      reason:
        "Restricted no-egress jobs require an Agent advertising trusted restricted-data isolation",
    });
    expect(result.trace?.stages).toEqual([
      {
        name: "restricted-data-isolation",
        inputCount: 1,
        passed: [],
        rejected: [
          {
            agent: {
              agentId: "po-agent-1",
              siteName: "po-site",
              schedulerType: "slurm",
              schedulerVersion: "23.02.7",
            },
            reason:
              "Restricted no-egress jobs require an Agent advertising trusted restricted-data isolation",
          },
        ],
      },
    ]);
    expect((await jobService.getById(job.id))?.placementTrace).toEqual(result.trace);
    expect(channel.messages).toHaveLength(0);

    dispatcher.unregister("po-agent-1");
  });

  test("passes resolved queue metadata to the dispatched job", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);
    await db.insert(schedulerQueues).values({
      queueId: "po-q",
      name: "PO GPU Queue",
      providerOrgId: orgId,
      agentId: "po-agent-1",
      schedulerType: "slurm",
      queueName: "gpu",
      qos: "normal",
      enabled: true,
    });
    const queueAccess = { context: null as QueueAccessContext | null };
    const queueAware = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      queueRegistry: {
        resolveForSubmit: async (_queueId: string | undefined, ctx: QueueAccessContext) => {
          queueAccess.context = ctx;
          return {
            queueId: "po-q",
            agentId: "po-agent-1",
            schedulerType: "slurm",
            queueName: "gpu",
            qos: "normal",
            policyTags: [],
          };
        },
        inspectPreferredForSubmit: async () => ({ selections: [], rejections: [] }),
        assertDispatchTargetAvailable: async () => {},
      } as never,
    });

    const job = await jobService.submit(
      {
        name: "po-test-queue-dispatch",
        command: "echo",
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "po-q" },
      },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await queueAware.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { queueId: "po-q" },
      },
      userId,
      userRole: "user",
      orgId,
    });

    expect(r.selectedAgentId).toBe("po-agent-1");
    expect(queueAccess.context?.userId).toBe(userId);
    const dispatch = ch.messages.find((m) => m.payload.case === "dispatchJob");
    expect(dispatch?.payload.case).toBe("dispatchJob");
    if (dispatch?.payload.case === "dispatchJob") {
      expect(dispatch.payload.value.queueName).toBe("gpu");
      expect(dispatch.payload.value.qos).toBe("normal");
    }

    dispatcher.unregister("po-agent-1");
  });

  test("blocks dispatch when queue inventory becomes unavailable after initial resolution", async () => {
    let now = new Date("2026-08-20T01:00:00.000Z");
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const channel = mockChannel();
    dispatcher.register("po-agent-1", channel);
    const inventory = new QueueInventoryService(db, {
      maxAgeSec: 10,
      recoveryHoldSec: 20,
      now: () => now,
    });
    await inventory.declareCapability("po-agent-1", true);
    await inventory.reconcile("po-agent-1", {
      status: "available",
      defaultQueueName: "batch",
      observedAt: now,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt: now,
        },
      ],
    });
    await db.insert(schedulerQueues).values({
      queueId: "po-final-nogo",
      name: "PO final no-go queue",
      providerOrgId: orgId,
      agentId: "po-agent-1",
      schedulerType: "slurm",
      queueName: "batch",
      enabled: true,
    });
    const queueRegistry = new QueueRegistryService(db, undefined, {
      inventory,
      validationMode: "enforce",
    });
    const queueAware = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      queueRegistry,
    });
    let stagingCalls = 0;
    queueAware.setInputStager(async () => {
      stagingCalls += 1;
      now = new Date("2026-08-20T01:00:01.000Z");
      await inventory.reconcile("po-agent-1", {
        status: "unavailable",
        reason: "command_failed",
        observedAt: now,
        queues: [],
      });
    });
    const jobInput = {
      name: "po-test-final-queue-nogo",
      command: "echo",
      resources: { cpus: 1, memoryMb: 1_024 },
      workingDir: "/work",
      inputStaging: [{ fileMetadataId: "fm-final-nogo", stagePath: "input.dat" }],
      schedulingStrategy: { queueId: "po-final-nogo" },
    };
    const job = await jobService.submit(jobInput, userId);
    cleanupJobIds.push(job.id);

    const result = await queueAware.placeAndDispatch({
      jobId: job.id,
      job: jobInput,
      userId,
      userRole: "user",
      orgId,
    });

    expect(stagingCalls).toBe(1);
    expect(result.selectedAgentId).toBe("po-agent-1");
    expect(result.dispatched).toBe(false);
    expect(channel.messages).toHaveLength(0);
    expect(await inventory.getForAgent("po-agent-1")).toMatchObject({
      status: "unavailable",
      noGoReason: "command_failed",
      recoveredAt: null,
    });
    expect(await jobService.getById(job.id)).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("Queue validation blocks dispatch"),
    });

    dispatcher.unregister("po-agent-1");
  });

  test("uses preferred queue metadata as a soft placement preference", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site-a",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await agentManager.register({
      agentId: "po-agent-2",
      siteName: "po-site-b",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await agentManager.heartbeat({
      agentId: "po-agent-1",
      cpuUsagePercent: 5,
      memoryUsedMb: 100,
      memoryTotalMb: 32_000,
    });
    await agentManager.heartbeat({
      agentId: "po-agent-2",
      cpuUsagePercent: 80,
      memoryUsedMb: 100,
      memoryTotalMb: 32_000,
    });
    const ch1 = mockChannel();
    const ch2 = mockChannel();
    dispatcher.register("po-agent-1", ch1);
    dispatcher.register("po-agent-2", ch2);
    const queueAware = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      queueRegistry: {
        resolveForSubmit: async () => null,
        inspectPreferredForSubmit: async () => ({
          selections: [
            {
              queueId: "po-prefer-q",
              agentId: "po-agent-2",
              schedulerType: "slurm",
              queueName: "fast",
              qos: "burst",
              policyTags: [],
            },
          ],
          rejections: [
            {
              queueId: "po-prefer-stale",
              code: "QUEUE_INVENTORY_UNAVAILABLE",
              reason: "stale",
            },
          ],
        }),
        assertDispatchTargetAvailable: async () => {},
      } as never,
    });

    const job = await jobService.submit(
      {
        name: "po-test-prefer-queue-dispatch",
        command: "echo",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await queueAware.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        schedulingStrategy: { preferredQueueIds: ["po-prefer-q"] },
      },
      userId,
      userRole: "user",
      orgId,
    });

    expect(r.selectedAgentId).toBe("po-agent-2");
    expect(r.trace?.softPreferenceRejections).toEqual([
      {
        queueId: "po-prefer-stale",
        code: "QUEUE_INVENTORY_UNAVAILABLE",
        reason: "stale",
      },
    ]);
    expect(ch1.messages).toHaveLength(0);
    const dispatch = ch2.messages.find((m) => m.payload.case === "dispatchJob");
    expect(dispatch?.payload.case).toBe("dispatchJob");
    if (dispatch?.payload.case === "dispatchJob") {
      expect(dispatch.payload.value.queueName).toBe("fast");
      expect(dispatch.payload.value.qos).toBe("burst");
    }

    dispatcher.unregister("po-agent-1");
    dispatcher.unregister("po-agent-2");
  });

  test("malformed inputStaging fileMetadataId does not block placement (locality best-effort)", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);

    // An orchestrator WITH db actually runs deriveDataSites. A non-UUID
    // fileMetadataId makes its uuid-column query throw; placement must swallow
    // it and still place the job (locality is a soft hint, never a gate).
    const orchestratorWithDb = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      db,
    });

    const job = await jobService.submit(
      { name: "po-test-bad-staging", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestratorWithDb.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        workingDir: "/work",
        inputStaging: [{ fileMetadataId: "not-a-uuid", stagePath: "in.dat" }],
      },
      userId,
      userRole: "user",
      orgId,
    });

    expect(r.selectedAgentId).toBe("po-agent-1");
    expect(r.dispatched).toBe(true);

    dispatcher.unregister("po-agent-1");
  });

  test("fails fast when DB-online agents have no live Server channel", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    // Deliberately do NOT register a dispatcher channel — pushDispatchJob fails.
    dispatcher.unregister("po-agent-1");

    const job = await jobService.submit(
      { name: "po-test-nochannel", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: { name: job.name, command: job.command, resources: { cpus: 1, memoryMb: 1024 } },
      userId,
      userRole: "user",
      orgId,
    });

    expect(r.selectedAgentId).toBeNull();
    expect(r.dispatched).toBe(false);
    const failed = await jobService.getById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe(
      "No live agent channel is available for this job. Wait for the agent to reconnect and retry.",
    );
  });

  test("stages input files before dispatching the job", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);

    const staged: Array<{
      jobId: string;
      workflowRunId?: string;
      agentId: string;
      actorUserId: string;
      workingDir: string;
      files: unknown[];
    }> = [];
    orchestrator.setInputStager(async (a) => {
      staged.push(a);
    });

    const job = await jobService.submit(
      { name: "po-test-stage", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      workflowRunId: "00000000-0000-4000-8000-000000000101",
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        workingDir: "/work",
        inputStaging: [{ fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" }],
        expectedOutputs: [{ descriptor: "archive", path: "result.tar.gz", isBatch: false }],
        fileOutputDescriptors: ["archive"],
      },
      userId,
      userRole: "user",
      orgId,
    });
    orchestrator.setInputStager(undefined);

    expect(r.dispatched).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.jobId).toBe(job.id);
    expect(staged[0]?.workflowRunId).toBe("00000000-0000-4000-8000-000000000101");
    expect(staged[0]?.agentId).toBe("po-agent-1");
    expect(staged[0]?.actorUserId).toBe(userId);
    expect(staged[0]?.workingDir).toBe("/work");
    expect(staged[0]?.files).toEqual([{ fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" }]);
    const dispatch = ch.messages.find((message) => message.payload.case === "dispatchJob");
    expect(dispatch?.payload.case).toBe("dispatchJob");
    if (dispatch?.payload.case === "dispatchJob") {
      expect(dispatch.payload.value.fileOutputDescriptors).toEqual(["archive"]);
    }

    dispatcher.unregister("po-agent-1");
  });

  test("dispatches input URLs when the Agent owns the implicit working directory", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);
    let genericStagerCalled = false;
    orchestrator.setInputStager(async () => {
      genericStagerCalled = true;
    });
    orchestrator.setInputUrlResolver(async (input) =>
      input.files.map((file) => ({
        ...file,
        sourceUrl: `https://storage.example/${file.fileMetadataId}`,
      })),
    );

    const job = await jobService.submit(
      { name: "po-test-implicit-stage", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);
    const result = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        inputStaging: [{ fileMetadataId: "fm-1", stagePath: "inputs/data.txt" }],
      },
      userId,
      userRole: "user",
      orgId,
    });
    orchestrator.setInputStager(undefined);
    orchestrator.setInputUrlResolver(undefined);

    expect(result.dispatched).toBe(true);
    expect(genericStagerCalled).toBe(false);
    const dispatch = ch.messages.find((message) => message.payload.case === "dispatchJob");
    expect(dispatch?.payload.case).toBe("dispatchJob");
    if (dispatch?.payload.case === "dispatchJob") {
      expect(dispatch.payload.value.workingDir).toBe("");
      expect(dispatch.payload.value.inputStaging[0]?.sourceUrl).toBe(
        "https://storage.example/fm-1",
      );
    }
    dispatcher.unregister("po-agent-1");
  });

  test("dispatches Sandbox Artifact URLs without invoking generic pre-staging", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      sandboxReadiness: "ready",
      sandboxCapabilities: { managedRoot: "/var/lib/kuintessence/sandbox" },
      sandboxRuntimeCache: [{ digest, kind: "SIF", signatureVerified: true }],
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);
    let genericStagerCalled = false;
    orchestrator.setInputStager(async () => {
      genericStagerCalled = true;
    });
    const resolved: unknown[] = [];
    orchestrator.setInputUrlResolver(async (input) => {
      resolved.push(input);
      return input.files.map((file) => ({
        ...file,
        sourceUrl: `https://storage.example/${file.fileMetadataId}`,
      }));
    });
    const job = await jobService.submit(
      {
        name: "po-test-sandbox-stage",
        command: "sandbox-manifest",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);
    const result = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        inputStaging: [{ fileMetadataId: "fm-1", stagePath: "inputs/data" }],
      },
      userId,
      userRole: "user",
      orgId,
      sandboxExecution: {
        runtimeDigests: { SIF: digest },
        build: async () => sandboxManifest(job.id, digest),
      },
    });
    orchestrator.setInputStager(undefined);
    orchestrator.setInputUrlResolver(undefined);
    expect(genericStagerCalled).toBe(false);
    expect(resolved).toHaveLength(1);
    expect(result.dispatched).toBe(true);
    const dispatch = ch.messages.find((message) => message.payload.case === "dispatchJob");
    expect(dispatch?.payload.case).toBe("dispatchJob");
    if (dispatch?.payload.case === "dispatchJob") {
      expect(dispatch.payload.value.inputStaging).toHaveLength(1);
      expect(dispatch.payload.value.inputStaging[0]?.fileMetadataId).toBe("fm-1");
      expect(dispatch.payload.value.inputStaging[0]?.stagePath).toBe("inputs/data");
      expect(dispatch.payload.value.inputStaging[0]?.sourceUrl).toBe(
        "https://storage.example/fm-1",
      );
    }
    dispatcher.unregister("po-agent-1");
  });

  test("fails closed when Sandbox Artifact URLs cannot be minted", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      sandboxReadiness: "ready",
      sandboxCapabilities: { managedRoot: "/var/lib/kuintessence/sandbox" },
      sandboxRuntimeCache: [{ digest, kind: "SIF", signatureVerified: true }],
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);
    const resolved: Array<{
      jobId: string;
      actorUserId: string;
      workflowRunId?: string;
      files: Array<{ fileMetadataId: string; stagePath: string }>;
    }> = [];
    orchestrator.setInputUrlResolver(async (input) => {
      resolved.push(input);
      throw new Error("presign denied");
    });
    const job = await jobService.submit(
      {
        name: "po-test-sandbox-url-failure",
        command: "sandbox-manifest",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);
    const result = await orchestrator.placeAndDispatch({
      jobId: job.id,
      workflowRunId: "00000000-0000-4000-8000-000000000102",
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        inputStaging: [
          { fileMetadataId: "fm-1", stagePath: "inputs/data-a" },
          { fileMetadataId: "fm-revoked", stagePath: "inputs/data-b" },
        ],
      },
      userId,
      userRole: "user",
      orgId,
      sandboxExecution: {
        runtimeDigests: { SIF: digest },
        build: async () => sandboxManifest(job.id, digest),
      },
    });
    orchestrator.setInputUrlResolver(undefined);
    expect(result.dispatched).toBe(false);
    expect(resolved).toEqual([
      {
        jobId: job.id,
        workflowRunId: "00000000-0000-4000-8000-000000000102",
        actorUserId: userId,
        files: [
          { fileMetadataId: "fm-1", stagePath: "inputs/data-a" },
          { fileMetadataId: "fm-revoked", stagePath: "inputs/data-b" },
        ],
      },
    ]);
    expect(ch.messages.some((message) => message.payload.case === "dispatchJob")).toBe(false);
    const failed = await jobService.getById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("Input URL resolution failed: presign denied");
    dispatcher.unregister("po-agent-1");
  });

  test("a staging failure aborts dispatch (dispatched false, no DispatchJob pushed)", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);

    orchestrator.setInputStager(async () => {
      throw new Error("transfer failed");
    });

    const job = await jobService.submit(
      { name: "po-test-stagefail", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
        workingDir: "/work",
        inputStaging: [{ fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" }],
      },
      userId,
      userRole: "user",
      orgId,
    });
    orchestrator.setInputStager(undefined);

    expect(r.selectedAgentId).toBe("po-agent-1");
    expect(r.dispatched).toBe(false);
    expect(ch.messages.some((m) => m.payload.case === "dispatchJob")).toBe(false);
    const failed = await jobService.getById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("Input staging failed: transfer failed");

    dispatcher.unregister("po-agent-1");
  });

  test("rejection trace recorded when guest role", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch = mockChannel();
    dispatcher.register("po-agent-1", ch);

    const job = await jobService.submit(
      {
        name: "po-test-guest",
        command: "echo",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
    );
    cleanupJobIds.push(job.id);

    const r = await orchestrator.placeAndDispatch({
      jobId: job.id,
      job: { name: job.name, command: job.command, resources: { cpus: 1, memoryMb: 1024 } },
      userId,
      userRole: "guest",
      orgId,
    });

    expect(r.selectedAgentId).toBeNull();
    expect(r.dispatched).toBe(false);
    expect(r.rejections.some((rj) => rj.stage === "permission")).toBe(true);
    const failed = await jobService.getById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe(
      "No eligible agent found for this job. Open the placement tab for rejection details.",
    );
    dispatcher.unregister("po-agent-1");
    // Agent cleanup is handled by afterAll (must delete jobs before agents due to FK)
  });

  test("hard-rejects non-local candidates from persisted data bindings before the eight placement stages", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site-a",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await agentManager.register({
      agentId: "po-agent-2",
      siteName: "po-site-b",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const ch1 = mockChannel();
    const ch2 = mockChannel();
    dispatcher.register("po-agent-1", ch1);
    dispatcher.register("po-agent-2", ch2);
    const gate = new DataPrerequisitePlacementGate(
      new DataPrerequisitePlanner({
        resolveVersion: async ({ versionId, manifestDigest }) => ({
          id: versionId,
          manifestDigest,
          available: true,
        }),
        listLocations: async () => [
          {
            locationId: "po-location-b",
            agentId: "po-agent-2",
            siteId: "po-site-b",
            clusterId: "cluster-b",
            kind: "cp-local",
          },
        ],
        verifyAccess: async () => true,
      }),
    );
    const dataAware = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      dataPrerequisites: gate,
      loadPersistedDataPrerequisites: async () => [
        {
          assetId: "00000000-0000-4000-8000-000000000901",
          versionId: "00000000-0000-4000-8000-000000000902",
          manifestDigest: "manifest-901",
          requiredPaths: ["input/mesh.dat"],
        },
      ],
    });
    dataAware.setDataDeliveryResolver(async () => []);
    const job = await jobService.submit(
      { name: "po-test-data-locality", command: "echo", resources: { cpus: 1, memoryMb: 1024 } },
      userId,
    );
    cleanupJobIds.push(job.id);
    const result = await dataAware.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 1024 },
      },
      userId,
      userRole: "user",
      orgId,
    });
    expect(result.selectedAgentId).toBe("po-agent-2");
    expect(result.dispatched).toBe(true);
    expect(ch1.messages.some((message) => message.payload.case === "dispatchJob")).toBe(false);
    expect(ch2.messages.some((message) => message.payload.case === "dispatchJob")).toBe(true);
    dispatcher.unregister("po-agent-1");
    dispatcher.unregister("po-agent-2");
  });

  test("fails before staging when Agent-managed data is mixed with NetDrive artifacts", async () => {
    await agentManager.register({
      agentId: "po-agent-1",
      siteName: "po-site",
      providerOrgId: orgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const channel = mockChannel();
    dispatcher.register("po-agent-1", channel);
    const dataAware = new PlacementOrchestrator({
      agentManager,
      jobService,
      preferenceService,
      dispatcher,
      loadPersistedDataPrerequisites: async () => [
        {
          assetId: "00000000-0000-4000-8000-000000000911",
          versionId: "00000000-0000-4000-8000-000000000912",
          manifestDigest: "manifest-912",
          requiredPaths: ["input/data.dat"],
        },
      ],
    });
    dataAware.setDataDeliveryResolver(async () => [
      {
        bindingId: "00000000-0000-4000-8000-000000000913",
        inputDescriptor: "dataset",
        locationId: "00000000-0000-4000-8000-000000000914",
        assetId: "00000000-0000-4000-8000-000000000911",
        versionId: "00000000-0000-4000-8000-000000000912",
        manifestDigest: "manifest-912",
        selectedEntries: [{ path: "data.dat", sha256: "fixture", sizeBytes: 1 }],
        stagePath: "dataset",
        method: "object-download",
        restricted: false,
        leaseId: "00000000-0000-4000-8000-000000000915",
        leaseExpiresAtUnixMs: Date.now() + 60_000,
      },
    ]);
    let staged = false;
    dataAware.setInputStager(async () => {
      staged = true;
    });
    const job = await jobService.submit(
      { name: "po-test-managed-mixed-io", command: "echo", resources: { cpus: 1, memoryMb: 64 } },
      userId,
    );
    cleanupJobIds.push(job.id);

    const result = await dataAware.placeAndDispatch({
      jobId: job.id,
      job: {
        name: job.name,
        command: job.command,
        resources: { cpus: 1, memoryMb: 64 },
        workingDir: "/server/work/job",
        inputStaging: [{ fileMetadataId: "file-1", stagePath: "input.dat" }],
        expectedOutputs: [
          { descriptor: "archive", path: "archive.tar.gz", isBatch: false, pathsOnly: true },
        ],
        fileOutputDescriptors: ["archive"],
      },
      userId,
      userRole: "user",
      orgId,
    });

    expect(result.dispatched).toBe(false);
    expect(staged).toBe(false);
    expect(channel.messages.some((message) => message.payload.case === "dispatchJob")).toBe(false);
    const failed = await jobService.getById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toContain("cannot mix Agent-managed data");
    dispatcher.unregister("po-agent-1");
  });
});
