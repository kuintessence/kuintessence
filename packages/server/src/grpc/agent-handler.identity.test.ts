import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  AgentMessageSchema,
  CancelJobAckSchema,
  DataScanResultSchema,
  FileTransferProgressSchema,
  HeartbeatSchema,
  JobLogsResponseSchema,
  JobStatusUpdateSchema,
  JobWorkRootReleaseAckSchema,
  PartUrlsRequestSchema,
  JobStatus as ProtoJobStatus,
  RegisterRequestSchema,
  SchedulerType,
  type ServerMessage,
  SoftwareOperationAction,
  SoftwareOperationResultSchema,
  SoftwareOperationStatus,
  UploadedPartSchema,
} from "@kuintessence/proto";
import pino from "pino";
import type { AgentManager } from "../services/agent-manager";
import type { JobLogsService } from "../services/job-logs-service";
import type { JobService, SchedulerRuntimeDetails } from "../services/job-service";
import type { TransferRegistry } from "../services/transfer-registry";
import type { InstalledRegistry } from "../software-governance/installed-registry";
import { JobCompletionRegistry } from "../workflow/job-completion-registry";
import type { AgentMetricsRecorder } from "./agent-handler";
import { registerAgentHandler } from "./agent-handler";
import { AgentDispatcher } from "./dispatcher";

const silent = pino({ level: "silent" });

type ConnectImpl = (requests: AsyncIterable<unknown>) => AsyncIterable<unknown>;

function createMockRouter(): { router: ConnectRouter; handlers: { connect?: ConnectImpl } } {
  const handlers: { connect?: ConnectImpl } = {};
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
  for (const item of items) yield item;
}

async function drain<T>(stream: AsyncIterable<T>): Promise<void> {
  for await (const _ of stream) {
    // discard outbound frames
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const messages: T[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

async function collectServer(stream: AsyncIterable<unknown>): Promise<ServerMessage[]> {
  return (await collect(stream)) as ServerMessage[];
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function registerMsg(agentId: string) {
  return create(AgentMessageSchema, {
    payload: {
      case: "register",
      value: create(RegisterRequestSchema, {
        agentId,
        siteName: "site",
        schedulerType: SchedulerType.SLURM,
        schedulerVersion: "23.02.7",
      }),
    },
  });
}

describe("agent-handler identity pinning", () => {
  test("redelivers cancellations on register and accepts only the registered Agent ACK", async () => {
    const calls: string[] = [];
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      jobCancellations: {
        redeliver: async (agentId) => {
          calls.push(`redeliver:${agentId}`);
          return 1;
        },
        acknowledge: async (agentId, jobId, revokedEpoch) => {
          calls.push(`ack:${agentId}:${jobId}:${revokedEpoch}`);
          return true;
        },
      },
    });
    const acknowledgement = create(AgentMessageSchema, {
      payload: {
        case: "cancelJobAck",
        value: create(CancelJobAckSchema, { jobId: "job-1", revokedEpoch: 7n }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), acknowledgement)));

    expect(calls).toEqual(["redeliver:agent-1", "ack:agent-1:job-1:7"]);
  });

  test("redelivers Job work-root releases and accepts the registered Agent ACK", async () => {
    const calls: string[] = [];
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      jobWorkRootReleases: {
        redeliver: async (agentId) => {
          calls.push(`redeliver:${agentId}`);
          return 1;
        },
        acknowledge: async (agentId, jobId) => {
          calls.push(`ack:${agentId}:${jobId}`);
          return true;
        },
      },
    });
    const acknowledgement = create(AgentMessageSchema, {
      payload: {
        case: "jobWorkRootReleaseAck",
        value: create(JobWorkRootReleaseAckSchema, { jobId: "job-1" }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), acknowledgement)));

    expect(calls).toEqual(["redeliver:agent-1", "ack:agent-1:job-1"]);
  });

  test("fences status and cancellation ACK messages from a replaced Agent stream", async () => {
    const calls: string[] = [];
    const dispatcher = new AgentDispatcher();
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {
        updateStatus: async () => {
          calls.push("status");
        },
      } as unknown as JobService,
      logger: silent,
      dispatcher,
      jobCancellations: {
        redeliver: async () => 0,
        acknowledge: async () => {
          calls.push("cancel-ack");
          return true;
        },
      },
    });
    let releaseOld: (() => void) | undefined;
    const oldReleased = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const staleStatus = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: "job-stale",
          status: ProtoJobStatus.COMPLETED,
          eventId: "stale-status",
        }),
      },
    });
    const staleCancellationAck = create(AgentMessageSchema, {
      payload: {
        case: "cancelJobAck",
        value: create(CancelJobAckSchema, { jobId: "job-stale", revokedEpoch: 9n }),
      },
    });
    async function* oldRequests() {
      yield registerMsg("agent-1");
      await oldReleased;
      yield staleStatus;
      yield staleCancellationAck;
    }

    if (!handlers.connect) throw new Error("connect handler not registered");
    const oldStream = drain(handlers.connect(oldRequests()));
    while (!dispatcher.isOnline("agent-1")) await settle();
    await drain(handlers.connect(iter(registerMsg("agent-1"))));
    releaseOld?.();
    await oldStream;

    expect(calls).toEqual([]);
  });

  test("routes a CP-local scan only under the registered Agent identity", async () => {
    const accepted: Array<{ registeredAgentId: string; resultAgentId: string; requestId: string }> =
      [];
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      dataScanCoordinator: {
        onAgentConnected: async () => undefined,
        acceptAgentResult: async (registeredAgentId, result) => {
          accepted.push({
            registeredAgentId,
            resultAgentId: result.agentId,
            requestId: result.requestId,
          });
        },
      },
    });
    const scanResult = create(AgentMessageSchema, {
      payload: {
        case: "dataScanResult",
        value: create(DataScanResultSchema, {
          requestId: "request-1",
          importId: "import-1",
          assetId: "asset-1",
          versionId: "version-1",
          managedRootId: "root-1",
          relativePath: "cohort",
          providerOrgId: "provider-org",
          agentId: "agent-1",
          manifestDigest: "a".repeat(64),
          contentSha256: "b".repeat(64),
          format: "directory",
          attestationAlgorithm: "rsa-sha256",
          attestationKeyId: "key-1",
          attestationSignature: "signature",
          scannedAtUnixMs: BigInt(1),
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), scanResult)));
    expect(accepted).toEqual([
      { registeredAgentId: "agent-1", resultAgentId: "agent-1", requestId: "request-1" },
    ]);
  });

  test("acks a job status event only after the registered Agent update succeeds", async () => {
    const calls: Array<
      [
        string,
        string,
        string | undefined,
        string | undefined,
        string | undefined,
        number | undefined,
        Record<string, string> | undefined,
        string | undefined,
        SchedulerRuntimeDetails | undefined,
      ]
    > = [];
    const fakeJob = {
      updateStatus: async (
        jobId: string,
        status: string,
        sched?: string,
        expectedAgentId?: string,
        message?: string,
        exitCode?: number,
        collected?: Record<string, string>,
        eventId?: string,
        schedulerDetails?: SchedulerRuntimeDetails,
      ) => {
        calls.push([
          jobId,
          status,
          sched,
          expectedAgentId,
          message,
          exitCode,
          collected,
          eventId,
          schedulerDetails,
        ]);
      },
    } as unknown as JobService;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: fakeJob,
      logger: silent,
      dispatcher: new AgentDispatcher(),
    });

    const status = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: "job-1",
          status: ProtoJobStatus.COMPLETED,
          schedulerJobId: "scheduler-1",
          message: "finished",
          exitCode: 0,
          collected: { result: "ok" },
          eventId: "status-event-1",
          node: "compute-03",
          reason: "None",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collectServer(handlers.connect(iter(registerMsg("agent-1"), status)));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "job-1",
      "completed",
      "scheduler-1",
      "agent-1",
      "finished",
      0,
      { result: "ok" },
      "status-event-1",
      { node: "compute-03", reason: "None" },
    ]);
    expect(responses.map((message) => message.payload.case)).toEqual([
      "registerResponse",
      "jobStatusAck",
    ]);
    expect(responses[1]?.payload).toMatchObject({
      case: "jobStatusAck",
      value: { eventId: "status-event-1" },
    });
  });

  test("does not ack a job status event when persistence fails", async () => {
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {
        updateStatus: async () => {
          throw new Error("database unavailable");
        },
      } as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
    });

    const status = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: "job-1",
          status: ProtoJobStatus.COMPLETED,
          eventId: "status-event-failed",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collectServer(handlers.connect(iter(registerMsg("agent-1"), status)));
    expect(responses.map((message) => message.payload.case)).toEqual(["registerResponse"]);
  });

  test("projects the sticky persisted terminal status instead of a late Agent status", async () => {
    const completionRegistry = new JobCompletionRegistry();
    const completion = completionRegistry.awaitCompletion("job-sticky");
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {
        updateStatus: async () => ({
          status: "cancelled",
          collectedOutputs: { saved: "value" },
          errorMessage: "Exit 9",
          reason: "Scheduler preemption",
          exitCode: 9,
        }),
      } as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      jobCompletionRegistry: completionRegistry,
    });
    const status = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: "job-sticky",
          status: ProtoJobStatus.COMPLETED,
          eventId: "status-event-sticky",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collectServer(handlers.connect(iter(registerMsg("agent-1"), status)));
    expect(await completion).toEqual({
      status: "cancelled",
      collected: { saved: "value" },
      errorMessage: "Exit 9",
      reason: "Scheduler preemption",
      exitCode: 9,
    });
    expect(responses[1]?.payload).toMatchObject({
      case: "jobStatusAck",
      value: { eventId: "status-event-sticky" },
    });
  });

  test("advertises heartbeat ACK support and acks only applied heartbeat sequences", async () => {
    const heartbeatSequences: bigint[] = [];
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {
        register: async () => undefined,
        heartbeat: async () => undefined,
      } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, { sequence: 41n }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collectServer(
      handlers.connect(iter(registerMsg("agent-1"), heartbeat)),
    );
    for (const response of responses) {
      if (response.payload.case === "heartbeatAck") {
        heartbeatSequences.push(response.payload.value.sequence);
      }
    }
    expect(responses[0]?.payload).toMatchObject({
      case: "registerResponse",
      value: {
        accepted: true,
        heartbeatAckSupported: true,
        jobStatusAckSupported: true,
      },
    });
    expect(heartbeatSequences).toEqual([41n]);
  });

  test("does not ack a heartbeat sequence when the Agent heartbeat update fails", async () => {
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {
        register: async () => undefined,
        heartbeat: async () => {
          throw new Error("database unavailable");
        },
      } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
    });
    const heartbeat = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, { sequence: 42n }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const responses = await collectServer(
      handlers.connect(iter(registerMsg("agent-1"), heartbeat)),
    );
    expect(responses.map((message) => message.payload.case)).toEqual(["registerResponse"]);
  });

  test("jobStatus before register is ignored (no updateStatus call)", async () => {
    let called = false;
    const fakeJob = {
      updateStatus: async () => {
        called = true;
      },
    } as unknown as JobService;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {} as unknown as AgentManager,
      jobService: fakeJob,
      logger: silent,
      dispatcher: new AgentDispatcher(),
    });

    const status = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, { jobId: "job-1", status: ProtoJobStatus.COMPLETED }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(status)));
    expect(called).toBe(false);
  });

  test("softwareOperationResult ingest failure does not stop later jobStatus handling", async () => {
    const calls: Array<[string, string, string | undefined, string | undefined]> = [];
    const fakeJob = {
      updateStatus: async (
        jobId: string,
        status: string,
        sched?: string,
        expectedAgentId?: string,
      ) => {
        calls.push([jobId, status, sched, expectedAgentId]);
      },
    } as unknown as JobService;
    const fakeSoftwareOperations = {
      applyAgentResult: async () => {
        throw new Error("database temporarily unavailable");
      },
    };

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: fakeJob,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      softwareOperations: fakeSoftwareOperations,
    });

    const operationResult = create(AgentMessageSchema, {
      payload: {
        case: "softwareOperationResult",
        value: create(SoftwareOperationResultSchema, {
          operationId: "00000000-0000-0000-0000-000000000001",
          action: SoftwareOperationAction.INSTALL,
          status: SoftwareOperationStatus.SUCCEEDED,
          spec: "zlib@1.3",
          exitCode: 0,
        }),
      },
    });
    const status = create(AgentMessageSchema, {
      payload: {
        case: "jobStatus",
        value: create(JobStatusUpdateSchema, {
          jobId: "job-after-software-result",
          status: ProtoJobStatus.COMPLETED,
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), operationResult, status)));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["job-after-software-result", "completed", undefined, "agent-1"]);
  });

  test("heartbeat installed-software and metrics are attributed to the registered agent", async () => {
    const replacedFor: string[] = [];
    const metricAgentIds: string[] = [];
    const fakeInstalled = {
      replaceForAgent: async (agentId: string) => {
        replacedFor.push(agentId);
      },
    } as unknown as InstalledRegistry;
    const fakeMetrics = {
      record: async (samples: Array<{ agentId: string }>) => {
        for (const s of samples) metricAgentIds.push(s.agentId);
      },
    } as unknown as AgentMetricsRecorder;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {
        register: async () => undefined,
        heartbeat: async () => undefined,
      } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      installedRegistry: fakeInstalled,
      metricsRecorder: fakeMetrics,
    });

    const hb = create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: "agent-EVIL",
          diskUsedPercent: 42,
          installedSoftware: [
            { name: "gromacs", version: "2024.1", hash: "abc", spec: "gromacs@2024.1" },
          ],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), hb)));

    expect(replacedFor).toEqual(["agent-1"]);
    expect(metricAgentIds.every((id) => id === "agent-1")).toBe(true);
    expect(metricAgentIds.length).toBeGreaterThan(0);
  });

  test("agent register pushes the latest stored software policy", async () => {
    const pushed: Array<{
      agentId: string;
      version: string;
      allowList: string[];
      denyList: string[];
    }> = [];
    const fakePolicyStore = {
      getForAgent: async (agentId: string) => ({
        agentId,
        scope: "agent",
        version: "v-reconnect",
        allowList: ["gromacs@*"],
        denyList: ["lammps@*"],
        lockEnabled: true,
        mirrors: [{ name: "central", url: "https://mirror.example.com", priority: 0 }],
        preinstallList: ["gromacs@2024.1"],
        updatedAt: new Date("2026-06-22T00:00:00.000Z"),
      }),
    };
    const fakePolicyPusher = {
      pushToAgent: (
        agentId: string,
        payload: {
          version: string;
          allowList: string[];
          denyList: string[];
        },
      ) => {
        pushed.push({
          agentId,
          version: payload.version,
          allowList: payload.allowList,
          denyList: payload.denyList,
        });
        return true;
      },
    };

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      policyStore: fakePolicyStore,
      policyPusher: fakePolicyPusher,
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"))));
    await settle();

    expect(pushed).toEqual([
      {
        agentId: "agent-1",
        version: "v-reconnect",
        allowList: ["gromacs@*"],
        denyList: ["lammps@*"],
      },
    ]);
  });

  test("partUrlsRequest after register mints urls and pushes a PartUrlsResponse", async () => {
    const mintCalls: Array<{ requestId: string; partNumbers: number[] }> = [];
    const minted = [
      { partNumber: 1, url: "https://minio/part-1" },
      { partNumber: 2, url: "https://minio/part-2" },
    ];
    const fakeMinter = {
      mintPartUrlsFor: async (requestId: string, partNumbers: number[]) => {
        mintCalls.push({ requestId, partNumbers });
        return minted;
      },
    };

    const pushed: Array<{
      agentId: string;
      requestId: string;
      urls: { partNumber: number; url: string }[];
    }> = [];
    class RecordingDispatcher extends AgentDispatcher {
      override pushPartUrlsResponse(
        agentId: string,
        requestId: string,
        urls: { partNumber: number; url: string }[],
      ): boolean {
        pushed.push({ agentId, requestId, urls });
        return true;
      }
    }
    const fakeDispatcher = new RecordingDispatcher();

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: fakeDispatcher,
      partUrlMinter: fakeMinter,
    });

    const req = create(AgentMessageSchema, {
      payload: {
        case: "partUrlsRequest",
        value: create(PartUrlsRequestSchema, {
          requestId: "transfer-9",
          partNumbers: [1, 2],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), req)));

    expect(mintCalls).toEqual([{ requestId: "transfer-9", partNumbers: [1, 2] }]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.agentId).toBe("agent-1");
    expect(pushed[0]?.requestId).toBe("transfer-9");
    expect(pushed[0]?.urls).toEqual(minted);
  });

  test("partUrlsRequest before register is ignored (minter not called)", async () => {
    let called = false;
    const fakeMinter = {
      mintPartUrlsFor: async () => {
        called = true;
        return [];
      },
    };

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {} as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      partUrlMinter: fakeMinter,
    });

    const req = create(AgentMessageSchema, {
      payload: {
        case: "partUrlsRequest",
        value: create(PartUrlsRequestSchema, { requestId: "transfer-9", partNumbers: [1] }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(req)));
    expect(called).toBe(false);
  });

  test("fileTransferProgress parts reach the transfer registry", async () => {
    const updates: Array<{ requestId: string; event: { parts?: unknown } }> = [];
    const fakeRegistry = {
      update: (requestId: string, event: { parts?: unknown }) => {
        updates.push({ requestId, event });
      },
    } as unknown as TransferRegistry;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      transferRegistry: fakeRegistry,
    });

    const progress = create(AgentMessageSchema, {
      payload: {
        case: "fileTransferProgress",
        value: create(FileTransferProgressSchema, {
          requestId: "transfer-9",
          copiedBytes: 10n,
          state: "succeeded",
          sha256: "deadbeef",
          parts: [
            create(UploadedPartSchema, { partNumber: 1, etag: "e1" }),
            create(UploadedPartSchema, { partNumber: 2, etag: "e2" }),
          ],
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), progress)));

    expect(updates).toHaveLength(1);
    expect(updates[0]?.event.parts).toEqual([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2" },
    ]);
  });

  test("jobLogsResponse resolves the pending Server request", async () => {
    const resolved: unknown[] = [];
    const jobLogsService = {
      resolve: (requestId: string, result: unknown) => {
        resolved.push({ requestId, result });
        return true;
      },
    } as Pick<JobLogsService, "resolve">;
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      jobLogsService,
    });
    const response = create(AgentMessageSchema, {
      payload: {
        case: "jobLogsResponse",
        value: create(JobLogsResponseSchema, {
          requestId: "logs-1",
          text: "done\n",
          unavailable: true,
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(registerMsg("agent-1"), response)));

    expect(resolved).toEqual([
      { requestId: "logs-1", result: { text: "done\n", error: "", unavailable: true } },
    ]);
  });
});
