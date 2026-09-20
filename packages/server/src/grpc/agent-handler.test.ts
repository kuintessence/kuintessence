// Test isolation: uses agent IDs prefixed "grpc-test-agent" and a per-run email
// to avoid collision with other test suites running in parallel.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  agentInstalledSoftware,
  agentMetrics,
  agents,
  createPgDb,
  jobs,
  orgs,
  type PgDb,
  users,
} from "@kuintessence/db";
import {
  AgentMessageSchema,
  ComputeHealthSchema,
  ComputeHealthState,
  GpuMetricSchema,
  HeartbeatSchema,
  InstalledSoftwareReportSchema,
  InstalledSpecSchema,
  JobStatusUpdateSchema,
  JobStatus as ProtoJobStatus,
  QueueInventorySchema,
  QueueInventoryStatus,
  QueueValidationShadowRejectionSchema,
  RegisterRequestSchema,
  SandboxCapabilitySchema,
  SandboxRuntimeCacheEntrySchema,
  SandboxRuntimeKind,
  SandboxSelfAccountSchema,
  SchedulerQueueFactSchema,
  SchedulerQueueState,
  SchedulerQueueType,
  SchedulerType,
} from "@kuintessence/proto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { AgentManager } from "../services/agent-manager";
import { JobService } from "../services/job-service";
import type { QueueInventoryService } from "../services/queue-inventory";
import {
  emptyQueueObservabilitySnapshot,
  QueueObservabilityService,
} from "../services/queue-observability";
import { InstalledRegistry } from "../software-governance/installed-registry";
import { PgAgentMetricsRecorder } from "../software-governance/metrics-recorder";
import {
  collectedForJobCompletion,
  registerAgentHandler,
  sandboxCapabilityFacts,
} from "./agent-handler";
import { AgentDispatcher } from "./dispatcher";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const TEST_USER_EMAIL = `grpc-test-${crypto.randomUUID()}@kuintessence.test`;
const testLogger = pino({ level: "silent" });

function createQueueObservability(db: PgDb): QueueObservabilityService {
  return new QueueObservabilityService(db, {
    getCoverage: async () => emptyQueueObservabilitySnapshot().coverage,
  });
}

test("restricted no-egress completion discards a malicious Agent payload", () => {
  expect(collectedForJobCompletion(true, { stdout: "secret", artifact: "base64-data" })).toEqual(
    {},
  );
  expect(collectedForJobCompletion(false, { result: "safe" })).toEqual({ result: "safe" });
});

test("normalizes SelfAccount capability and rejects unsafe runtime attestation timestamps", () => {
  const attestationId = "a".repeat(64);
  const facts = sandboxCapabilityFacts(
    create(SandboxCapabilitySchema, {
      enabled: true,
      readiness: "ready",
      executionMode: "SelfAccount",
      selfAccount: create(SandboxSelfAccountSchema, {
        username: "kqagent",
        uid: 1001,
        gid: 1001,
      }),
      runtimeCache: [
        create(SandboxRuntimeCacheEntrySchema, {
          digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          kind: SandboxRuntimeKind.SIF,
          signatureVerified: true,
          runtimeAttestationId: attestationId,
          attestedNodes: ["compute-01", "  "],
          expiresAtUnixMs: 1_725_000_000_000n,
        }),
        create(SandboxRuntimeCacheEntrySchema, {
          digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          kind: SandboxRuntimeKind.OCI,
          signatureVerified: true,
          runtimeAttestationId: attestationId,
          attestedNodes: ["compute-02"],
          expiresAtUnixMs: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        }),
      ],
    }),
  );

  expect(facts).toEqual({
    rootMode: false,
    sandboxReadiness: "ready",
    sandboxCapabilities: {
      enabled: true,
      networkIsolation: false,
      cgroups: false,
      seccomp: false,
      sifSignatureVerification: false,
      ecl: false,
      replayProtection: false,
      missingRequirements: [],
      managedRoot: "",
      executionMode: "SelfAccount",
      selfAccount: { username: "kqagent", uid: 1001, gid: 1001 },
    },
    sandboxRuntimeCache: [
      {
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        kind: "SIF",
        signatureVerified: true,
        runtimeAttestationId: attestationId,
        attestedNodes: ["compute-01"],
        expiresAtUnixMs: 1_725_000_000_000,
      },
      {
        digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        kind: "OCI",
        signatureVerified: true,
        runtimeAttestationId: attestationId,
        attestedNodes: ["compute-02"],
      },
    ],
  });

  expect(
    sandboxCapabilityFacts(
      create(SandboxCapabilitySchema, {
        rootMode: true,
      }),
    ),
  ).toMatchObject({ sandboxCapabilities: { executionMode: "RootImpersonation" } });
});

// ---------------------------------------------------------------------------
// Minimal mock router — captures the connect handler so we can invoke it
// directly without a real HTTP server.
// ---------------------------------------------------------------------------
type ConnectImpl = (requests: AsyncIterable<unknown>) => AsyncIterable<unknown>;

interface MockHandlers {
  connect?: ConnectImpl;
}

function createMockRouter(): { router: ConnectRouter; handlers: MockHandlers } {
  const handlers: MockHandlers = {};
  const router = {
    service: (_service: unknown, impls: { connect?: ConnectImpl }) => {
      handlers.connect = impls.connect;
      return router;
    },
    rpc: () => router,
    handlers: [],
  } as unknown as ConnectRouter;
  return { router, handlers };
}

async function* iter<T>(...items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

// Identity pinning (commit ad35d56): heartbeat / jobStatus / installed-software
// frames are ignored until a `register` frame establishes the stream identity.
// Every stream that sends those frames must open with this register frame.
function registerFrame() {
  return create(AgentMessageSchema, {
    payload: {
      case: "register",
      value: create(RegisterRequestSchema, {
        agentId: "grpc-test-agent-1",
        siteName: "grpc-test-site",
        schedulerType: SchedulerType.SLURM,
        schedulerVersion: "23.02.7",
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-handler", () => {
  let db: PgDb;
  let agentManager: AgentManager;
  let jobService: JobService;
  let testUserId: string;
  let testOrgId: string;
  let testJobId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    agentManager = new AgentManager(db);
    jobService = new JobService(db);

    const [org] = await db.insert(orgs).values({ name: "test-org-grpc" }).returning();
    if (!org) throw new Error("failed to create org");
    testOrgId = org.id;

    const [user] = await db
      .insert(users)
      .values({ email: TEST_USER_EMAIL, role: "user", orgId: testOrgId })
      .returning();
    if (!user) throw new Error("failed to create user");
    testUserId = user.id;

    const job = await jobService.submit(
      {
        name: "test-grpc-job",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobId = job.id;
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.id, testJobId));
    await db
      .delete(agentInstalledSoftware)
      .where(eq(agentInstalledSoftware.agentId, "grpc-test-agent-1"));
    await db.delete(agentMetrics).where(eq(agentMetrics.agentId, "grpc-test-agent-1"));
    await db.delete(agents).where(eq(agents.agentId, "grpc-test-agent-1"));
    await db.delete(users).where(eq(users.id, testUserId));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("registers an agent and yields acceptance", async () => {
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
    });

    const registerMsg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "grpc-test-agent-1",
          siteName: "grpc-test-site",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "23.02.7",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(registerMsg)));
    expect(responses.length).toBe(1);

    const reply = responses[0] as { payload: { case: string; value: { accepted: boolean } } };
    expect(reply.payload.case).toBe("registerResponse");
    expect(reply.payload.value.accepted).toBe(true);

    // Verify the agent was actually persisted
    const stored = await agentManager.getById("grpc-test-agent-1");
    expect(stored?.siteName).toBe("grpc-test-site");
    expect(stored?.schedulerType).toBe("slurm");
  });

  test("negotiates and persists a v1 compute-health heartbeat", async () => {
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
    });
    const observedAt = BigInt(Date.now());
    const register = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "grpc-test-agent-1",
          siteName: "grpc-test-site",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "23.02.7",
          computeHealthV1: true,
        }),
      },
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 42.5,
          memoryUsedMb: 8_192n,
          memoryTotalMb: 32_768n,
          computeHealth: create(ComputeHealthSchema, {
            state: ComputeHealthState.READY,
            observedAtUnixMs: observedAt,
            nodeCount: 2,
            operationalNodeCount: 2,
          }),
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(register, heartbeat)));
    const response = responses[0] as {
      payload: { case: string; value: { accepted: boolean; computeHealthV1Supported: boolean } };
    };
    expect(response.payload.case).toBe("registerResponse");
    expect(response.payload.value.accepted).toBe(true);
    expect(response.payload.value.computeHealthV1Supported).toBe(true);

    const stored = await agentManager.getById("grpc-test-agent-1");
    expect(stored?.computeHealthCapable).toBe(true);
    expect(stored?.computeHealthStatus).toBe("ready");
    expect(stored?.computeHealthObservedAt?.getTime()).toBe(Number(observedAt));
    expect(stored?.computeHealthNodeCount).toBe(2);
    expect(stored?.computeHealthOperationalNodeCount).toBe(2);
  });

  test("negotiates queue inventory and reconciles an additive heartbeat field", async () => {
    const capabilityCalls: Array<{ agentId: string; enabled: boolean }> = [];
    const reconciliationCalls: Array<{ agentId: string; inventory: unknown }> = [];
    const inventory = {
      declareCapability: async (agentId: string, enabled: boolean) => {
        capabilityCalls.push({ agentId, enabled });
      },
      reconcile: async (agentId: string, queueInventory: unknown) => {
        reconciliationCalls.push({ agentId, inventory: queueInventory });
        return { status: "available", reason: null, observedAt: new Date() };
      },
    } as unknown as QueueInventoryService;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueInventory: inventory,
    });
    const observedAt = BigInt(Date.now());
    const register = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "grpc-test-agent-1",
          siteName: "grpc-test-site",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "23.02.7",
          queueInventoryV1: true,
        }),
      },
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 42.5,
          memoryUsedMb: 8_192n,
          memoryTotalMb: 32_768n,
          sequence: 5n,
          queueInventory: create(QueueInventorySchema, {
            status: QueueInventoryStatus.AVAILABLE,
            defaultQueueName: "batch",
            observedAtUnixMs: observedAt,
            queues: [
              create(SchedulerQueueFactSchema, {
                queueName: "batch",
                queueType: SchedulerQueueType.PARTITION,
                isDefault: true,
                state: SchedulerQueueState.UP,
                acceptsSubmissions: true,
                observedAtUnixMs: observedAt,
              }),
            ],
          }),
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(register, heartbeat)));
    const response = responses[0] as {
      payload: { case: string; value: { queueInventoryV1Supported: boolean } };
    };
    expect(response.payload.case).toBe("registerResponse");
    expect(response.payload.value.queueInventoryV1Supported).toBe(true);
    expect(capabilityCalls).toEqual([{ agentId: "grpc-test-agent-1", enabled: true }]);
    expect(reconciliationCalls).toHaveLength(1);
    expect(
      responses.some(
        (item) => (item as { payload?: { case?: string } }).payload?.case === "heartbeatAck",
      ),
    ).toBe(true);
  });

  test("withholds heartbeat acknowledgement when queue inventory persistence fails", async () => {
    const inventory = {
      declareCapability: async () => {},
      reconcile: async () => {
        throw new Error("inventory store unavailable");
      },
    } as unknown as QueueInventoryService;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueInventory: inventory,
    });
    const observedAt = BigInt(Date.now());
    const register = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "grpc-test-agent-1",
          siteName: "grpc-test-site",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "23.02.7",
          queueInventoryV1: true,
        }),
      },
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 42.5,
          memoryUsedMb: 8_192n,
          memoryTotalMb: 32_768n,
          sequence: 7n,
          queueInventory: create(QueueInventorySchema, {
            status: QueueInventoryStatus.UNAVAILABLE,
            reason: "command_failed",
            observedAtUnixMs: observedAt,
          }),
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(register, heartbeat)));

    expect(
      responses.some(
        (response) =>
          (response as { payload?: { case?: string } }).payload?.case === "heartbeatAck",
      ),
    ).toBe(false);
  });

  test("processes heartbeat without yielding a response", async () => {
    // Ensure agent exists first (re-register idempotently)
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
    });

    const heartbeatMsg = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 42.5,
          memoryUsedMb: 8192n,
          memoryTotalMb: 32768n,
          runningJobs: 2,
          queuedJobs: 5,
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(registerFrame(), heartbeatMsg)));
    // The only response is the register ack; the heartbeat itself yields none.
    expect(responses.length).toBe(1);

    // Verify metrics were applied
    const updated = await agentManager.getById("grpc-test-agent-1");
    expect(updated?.cpuUsagePercent).toBe(43); // Math.round(42.5)
    expect(updated?.memoryUsedMb).toBe(8192);
  });

  test("processes job status update and persists new status", async () => {
    // The job must be owned by the registering agent for the audit's
    // ownership-guarded updateStatus to match (commit a7ed48e).
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await jobService.assignToAgent(testJobId, "grpc-test-agent-1");

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
    });

    const statusMsg = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: testJobId,
          status: ProtoJobStatus.RUNNING,
          schedulerJobId: "slurm-99999",
          message: "started",
          node: "compute-02",
          reason: "Priority",
          workingDir: `/managed/jobs/${testJobId}`,
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(registerFrame(), statusMsg)));
    // The only response is the register ack; the status update yields none.
    expect(responses.length).toBe(1);

    const updated = await jobService.getById(testJobId);
    expect(updated?.status).toBe("running");
    expect(updated?.schedulerJobId).toBe("slurm-99999");
    expect(updated?.node).toBe("compute-02");
    expect(updated?.reason).toBe("Priority");
    expect(updated?.workingDir).toBe(`/managed/jobs/${testJobId}`);
  });

  test("records a scheduler submission failure once for a replayed event id", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const job = await jobService.submit(
      {
        name: "test-grpc-submit-failure",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    await jobService.assignToAgent(job.id, "grpc-test-agent-1");
    const queueObservability = createQueueObservability(db);
    const before = (await queueObservability.snapshot()).failures.schedulerSubmitFailures
      .SCHEDULER_SUBMIT_FAILED;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueObservability,
    });
    const statusMsg = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: job.id,
          status: ProtoJobStatus.FAILED,
          message: "scheduler submit failed",
          failureCode: "SCHEDULER_SUBMIT_FAILED",
          eventId: "grpc-submit-failure-1",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await collect(handlers.connect(iter(registerFrame(), statusMsg, statusMsg)));

    const after = (await queueObservability.snapshot()).failures.schedulerSubmitFailures
      .SCHEDULER_SUBMIT_FAILED;
    expect(after - before).toBe(1);
    await db.delete(jobs).where(eq(jobs.id, job.id));
  });

  test("withholds the job status ACK until a scheduler failure counter claim succeeds", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const job = await jobService.submit(
      {
        name: "test-grpc-submit-failure-retry",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    await jobService.assignToAgent(job.id, "grpc-test-agent-1");
    const queueObservability = createQueueObservability(db);
    const before = (await queueObservability.snapshot()).failures.schedulerSubmitFailures
      .SCHEDULER_SUBMIT_FAILED;
    let recordAttempts = 0;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueObservability: {
        recordEvent: async (event) => {
          recordAttempts += 1;
          if (recordAttempts === 1) throw new Error("counter store unavailable");
          return queueObservability.recordEvent(event);
        },
      },
    });
    const statusMsg = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: job.id,
          status: ProtoJobStatus.FAILED,
          message: "scheduler submit failed",
          failureCode: "SCHEDULER_SUBMIT_FAILED",
          eventId: "grpc-submit-failure-retry-1",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(registerFrame(), statusMsg, statusMsg)));

    const after = (await queueObservability.snapshot()).failures.schedulerSubmitFailures
      .SCHEDULER_SUBMIT_FAILED;
    const acknowledgements = responses.filter(
      (response) =>
        (response as { payload?: { case?: string; value?: { eventId?: string } } }).payload
          ?.case === "jobStatusAck" &&
        (response as { payload: { value: { eventId?: string } } }).payload.value.eventId ===
          "grpc-submit-failure-retry-1",
    );
    expect(recordAttempts).toBe(2);
    expect(after - before).toBe(1);
    expect(acknowledgements).toHaveLength(1);
    await db.delete(jobs).where(eq(jobs.id, job.id));
  });

  test("acknowledges and records a replayed shadow queue rejection once", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const queueObservability = createQueueObservability(db);
    const before = (await queueObservability.snapshot()).failures.shadowRejections
      .QUEUE_NOT_ACCEPTING;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueObservability,
    });
    const shadowRejection = create(AgentMessageSchema, {
      payload: {
        case: "queueValidationShadowRejection",
        value: create(QueueValidationShadowRejectionSchema, {
          failureCode: "QUEUE_NOT_ACCEPTING",
          eventId: "grpc-shadow-rejection-1",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(
      handlers.connect(iter(registerFrame(), shadowRejection, shadowRejection)),
    );

    const after = (await queueObservability.snapshot()).failures.shadowRejections
      .QUEUE_NOT_ACCEPTING;
    expect(after - before).toBe(1);
    const acknowledgements = responses.filter(
      (response) =>
        (response as { payload?: { case?: string } }).payload?.case ===
        "queueValidationShadowRejectionAck",
    ) as Array<{ payload: { value: { eventId: string } } }>;
    expect(acknowledgements).toHaveLength(2);
    expect(
      acknowledgements.every(
        (response) => response.payload.value.eventId === "grpc-shadow-rejection-1",
      ),
    ).toBe(true);
  });

  test("withholds a shadow rejection ACK when its durable counter claim fails", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      queueObservability: {
        recordEvent: async () => {
          throw new Error("counter store unavailable");
        },
      },
    });
    const shadowRejection = create(AgentMessageSchema, {
      payload: {
        case: "queueValidationShadowRejection",
        value: create(QueueValidationShadowRejectionSchema, {
          failureCode: "QUEUE_CHANGED",
          eventId: "grpc-shadow-rejection-failed-claim",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collect(handlers.connect(iter(registerFrame(), shadowRejection)));

    expect(
      responses.some(
        (response) =>
          (response as { payload?: { case?: string } }).payload?.case ===
          "queueValidationShadowRejectionAck",
      ),
    ).toBe(false);
  });

  test("legacy nonempty heartbeat replaces the registry before the stream completes", async () => {
    // Make sure the agent exists
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    const installedRegistry = new InstalledRegistry(db);
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      installedRegistry,
    });

    const hb = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 10,
          memoryUsedMb: 1n,
          memoryTotalMb: 1n,
          runningJobs: 0,
          queuedJobs: 0,
          installedSoftware: [
            create(InstalledSpecSchema, {
              name: "gromacs",
              version: "2024.1",
              hash: "hash-grpc-1",
              spec: "gromacs@2024.1",
            }),
          ],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await collect(handlers.connect(iter(registerFrame(), hb)));

    const out = await installedRegistry.listForAgent("grpc-test-agent-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "gromacs",
      version: "2024.1",
      hash: "hash-grpc-1",
      spec: "gromacs@2024.1",
    });
  });

  test("empty heartbeat leaves the previously known installed registry unchanged", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const installedRegistry = new InstalledRegistry(db);
    await installedRegistry.replaceForAgent("grpc-test-agent-1", [
      { name: "hello", version: "2.12.1", hash: "keep-on-empty-hb", spec: "hello@2.12.1" },
    ]);
    const before = await installedRegistry.listForAgent("grpc-test-agent-1");
    const replacements: Array<Parameters<InstalledRegistry["replaceForAgent"]>> = [];
    const replace = installedRegistry.replaceForAgent.bind(installedRegistry);
    installedRegistry.replaceForAgent = async (...args) => {
      replacements.push(args);
      await replace(...args);
    };
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      installedRegistry,
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          installedSoftware: [],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await collect(handlers.connect(iter(registerFrame(), heartbeat)));

    expect(replacements).toEqual([]);
    expect(await installedRegistry.listForAgent("grpc-test-agent-1")).toEqual(before);
  });

  test("explicit empty installed report clears only the registered stream identity", async () => {
    const otherAgentId = `grpc-test-agent-inventory-${crypto.randomUUID()}`;
    const installedRegistry = new InstalledRegistry(db);
    for (const agentId of ["grpc-test-agent-1", otherAgentId]) {
      await agentManager.register({
        agentId,
        siteName: "grpc-test-site",
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      });
    }
    try {
      for (const agentId of ["grpc-test-agent-1", otherAgentId]) {
        await installedRegistry.replaceForAgent(agentId, [
          { name: "hello", version: "2.12.1", hash: "before-empty-report", spec: "hello@2.12.1" },
        ]);
      }
      const otherBefore = await installedRegistry.listForAgent(otherAgentId);
      const replacements: Array<Parameters<InstalledRegistry["replaceForAgent"]>> = [];
      const replace = installedRegistry.replaceForAgent.bind(installedRegistry);
      installedRegistry.replaceForAgent = async (...args) => {
        replacements.push(args);
        await replace(...args);
      };
      const { router, handlers } = createMockRouter();
      registerAgentHandler(router, {
        agentManager,
        jobService,
        logger: testLogger,
        dispatcher: new AgentDispatcher(),
        installedRegistry,
      });
      const report = create(AgentMessageSchema, {
        payload: {
          case: "installedSoftwareReport",
          value: create(InstalledSoftwareReportSchema, {
            agentId: otherAgentId,
            installed: [],
          }),
        },
      });

      if (!handlers.connect) throw new Error("connect handler not registered");
      await collect(handlers.connect(iter(registerFrame(), report)));

      expect(replacements).toEqual([["grpc-test-agent-1", []]]);
      expect(await installedRegistry.listForAgent("grpc-test-agent-1")).toEqual([]);
      expect(await installedRegistry.listForAgent(otherAgentId)).toEqual(otherBefore);
    } finally {
      await db
        .delete(agentInstalledSoftware)
        .where(eq(agentInstalledSoftware.agentId, otherAgentId));
      await db.delete(agents).where(eq(agents.agentId, otherAgentId));
    }
  });

  test("installed report before stream registration cannot clear an existing agent", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const installedRegistry = new InstalledRegistry(db);
    await installedRegistry.replaceForAgent("grpc-test-agent-1", [
      { name: "hello", version: "2.12.1", hash: "keep-before-register", spec: "hello@2.12.1" },
    ]);
    const before = await installedRegistry.listForAgent("grpc-test-agent-1");
    const replacements: Array<Parameters<InstalledRegistry["replaceForAgent"]>> = [];
    const replace = installedRegistry.replaceForAgent.bind(installedRegistry);
    installedRegistry.replaceForAgent = async (...args) => {
      replacements.push(args);
      await replace(...args);
    };
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      installedRegistry,
    });
    const report = create(AgentMessageSchema, {
      payload: {
        case: "installedSoftwareReport",
        value: create(InstalledSoftwareReportSchema, {
          agentId: "grpc-test-agent-1",
          installed: [],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await collect(handlers.connect(iter(report, registerFrame())));

    expect(replacements).toEqual([]);
    expect(await installedRegistry.listForAgent("grpc-test-agent-1")).toEqual(before);
  });

  test("delayed nonempty replacement finishes before a later empty report on the same stream", async () => {
    const installedRegistry = new InstalledRegistry(db);
    const replace = installedRegistry.replaceForAgent.bind(installedRegistry);
    const barriers: { started?: () => void; release?: () => void } = {};
    const started = new Promise<void>((resolve) => {
      barriers.started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      barriers.release = resolve;
    });
    const events: string[] = [];
    const writes: Promise<void>[] = [];
    installedRegistry.replaceForAgent = (agentId, specs) => {
      const write = (async () => {
        const label = specs.length > 0 ? "nonempty" : "empty";
        events.push(`${label}-started`);
        if (specs.length > 0) {
          barriers.started?.();
          await released;
        }
        await replace(agentId, specs);
        events.push(`${label}-finished`);
      })();
      writes.push(write);
      return write;
    };
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      installedRegistry,
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          installedSoftware: [
            create(InstalledSpecSchema, {
              name: "hello",
              version: "2.12.1",
              hash: "delayed-nonempty",
              spec: "hello@2.12.1",
            }),
          ],
        }),
      },
    });
    const report = create(AgentMessageSchema, {
      payload: {
        case: "installedSoftwareReport",
        value: create(InstalledSoftwareReportSchema, {
          agentId: "grpc-test-agent-1",
          installed: [],
        }),
      },
    });
    let reportRequested = false;
    async function* requests() {
      yield registerFrame();
      yield heartbeat;
      reportRequested = true;
      yield report;
    }
    if (!handlers.connect) throw new Error("connect handler not registered");
    const running = collect(handlers.connect(requests()));
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Stream ended before the nonempty replacement started");
        }),
      ]);
      // Let an unawaited reader advance; only the explicit barrier releases the write.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(reportRequested).toBe(false);
      expect(events).toEqual(["nonempty-started"]);
    } finally {
      barriers.release?.();
      try {
        await running;
      } finally {
        await Promise.all(writes);
      }
    }

    expect(reportRequested).toBe(true);
    expect(events).toEqual([
      "nonempty-started",
      "nonempty-finished",
      "empty-started",
      "empty-finished",
    ]);
    expect(await installedRegistry.listForAgent("grpc-test-agent-1")).toEqual([]);
  });

  test("heartbeat with gpus + disk + queue records metrics samples", async () => {
    await agentManager.register({
      agentId: "grpc-test-agent-1",
      siteName: "grpc-test-site",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    const recorder = new PgAgentMetricsRecorder(db);
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager,
      jobService,
      logger: testLogger,
      dispatcher: new AgentDispatcher(),
      metricsRecorder: recorder,
    });

    const hb = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "grpc-test-agent-1",
          cpuUsagePercent: 10,
          memoryUsedMb: 1n,
          memoryTotalMb: 1n,
          runningJobs: 0,
          queuedJobs: 0,
          diskUsedPercent: 55,
          schedulerQueuedJobs: 7,
          gpus: [
            create(GpuMetricSchema, {
              index: 0,
              model: "A100",
              memUsedMb: 1024n,
              memTotalMb: 40960n,
              utilPercent: 35,
            }),
          ],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await collect(handlers.connect(iter(registerFrame(), hb)));

    // Allow the fire-and-forget insert to flush.
    let rows: Array<{ metric: string; value: number }> = [];
    for (let i = 0; i < 50; i++) {
      const data = await db
        .select()
        .from(agentMetrics)
        .where(eq(agentMetrics.agentId, "grpc-test-agent-1"));
      if (data.length >= 3) {
        rows = data.map((r) => ({ metric: r.metric, value: r.value }));
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const metricsSeen = rows.map((r) => r.metric).sort();
    expect(metricsSeen).toEqual(["disk_used_percent", "gpu", "scheduler_queued_jobs"]);
  });
});
