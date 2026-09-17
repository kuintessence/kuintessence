import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  type AgentMessage,
  AgentService,
  type ComputeHealth,
  ComputeHealthState,
  HeartbeatAckSchema,
  JobStatusAckSchema,
  type QueueInventory,
  QueueInventoryStatus,
  QueueValidationShadowRejectionAckSchema,
  RegisterResponseSchema,
  type SandboxCapability,
  SandboxRuntimeKind,
  SchedulerQueueState,
  SchedulerQueueType,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  QueueFailureCodeSchema,
  SandboxRuntimeAttestationIdSchema,
  SandboxSelfAccountSchema,
} from "@kuintessence/shared";
import type { Logger } from "pino";
import { mtlsContext } from "../auth/mtls-context";
import type { AgentManager, ComputeHealthReport } from "../services/agent-manager";
import type { DataDeliveryRevocationOutbox } from "../services/data-delivery-revocations";
import type { DataScanCoordinator } from "../services/data-scan-coordinator";
import type { JobLogsService } from "../services/job-logs-service";
import type { JobService } from "../services/job-service";
import type { QueueInventoryService } from "../services/queue-inventory";
import type { QueueObservabilityService } from "../services/queue-observability";
import {
  QUEUE_SHADOW_REJECTION_METRIC,
  SCHEDULER_SUBMIT_FAILURE_METRIC,
} from "../services/queue-observability";
import type { SandboxArtifactReleaseService } from "../services/sandbox-artifact-release";
import type { ShellExecRegistry } from "../services/shell-exec-registry";
import type { SshGateway } from "../services/ssh-gateway";
import type { TransferRegistry } from "../services/transfer-registry";
import type { InstalledRegistry } from "../software-governance/installed-registry";
import type { SoftwareOperationService } from "../software-governance/operation-service";
import type { PolicyPusher } from "../software-governance/policy-pusher";
import type { PolicyStore } from "../software-governance/policy-store";
import type { JobCompletionRegistry } from "../workflow/job-completion-registry";
import type {
  AgentDispatcher,
  JobCancellationOutbox,
  JobWorkRootReleaseOutbox,
} from "./dispatcher";
import { protoToJobStatus, protoToSchedulerType } from "./enum-mapping";

const MAX_SAFE_PROTO_UNIX_MS = BigInt(Number.MAX_SAFE_INTEGER);

function sandboxRuntimeKindFact(kind: SandboxRuntimeKind): "OCI" | "SIF" | undefined {
  switch (kind) {
    case SandboxRuntimeKind.OCI:
      return "OCI";
    case SandboxRuntimeKind.SIF:
      return "SIF";
    default:
      return undefined;
  }
}

function safeProtoUnixMs(value: bigint): number | undefined {
  if (value <= 0n || value > MAX_SAFE_PROTO_UNIX_MS) return undefined;
  return Number(value);
}

function sandboxExecutionModeFact(
  capability: SandboxCapability,
): "RootImpersonation" | "SelfAccount" | undefined {
  if (capability.executionMode === "SelfAccount") return "SelfAccount";
  // rootMode predates executionMode and remains the compatibility proof for rolling upgrades.
  if (capability.executionMode === "RootImpersonation" || capability.rootMode) {
    return "RootImpersonation";
  }
  return undefined;
}

export function sandboxCapabilityFacts(capability: SandboxCapability | undefined) {
  if (!capability) return {};
  const readiness = ["ready", "degraded", "critical"].includes(capability.readiness)
    ? (capability.readiness as "ready" | "degraded" | "critical")
    : "critical";
  const executionMode = sandboxExecutionModeFact(capability);
  const selfAccount =
    executionMode === "SelfAccount" && capability.selfAccount
      ? SandboxSelfAccountSchema.safeParse({
          username: capability.selfAccount.username,
          uid: capability.selfAccount.uid,
          gid: capability.selfAccount.gid,
        })
      : undefined;
  return {
    rootMode: capability.rootMode,
    sandboxReadiness: readiness,
    sandboxCapabilities: {
      enabled: capability.enabled,
      networkIsolation: capability.networkIsolation,
      cgroups: capability.cgroups,
      seccomp: capability.seccomp,
      sifSignatureVerification: capability.sifSignatureVerification,
      ecl: capability.ecl,
      replayProtection: capability.replayProtection,
      missingRequirements: capability.missingRequirements,
      managedRoot: capability.managedRoot,
      ...(executionMode ? { executionMode } : {}),
      ...(selfAccount?.success ? { selfAccount: selfAccount.data } : {}),
      ...(capability.restrictedExecutionProfile
        ? { restrictedExecutionProfile: capability.restrictedExecutionProfile }
        : {}),
    },
    sandboxRuntimeCache: capability.runtimeCache.flatMap((runtime) => {
      const kind = sandboxRuntimeKindFact(runtime.kind);
      if (!kind || runtime.digest.length === 0) return [];
      const attestation = SandboxRuntimeAttestationIdSchema.safeParse(runtime.runtimeAttestationId);
      const expiresAtUnixMs = safeProtoUnixMs(runtime.expiresAtUnixMs);
      const attestedNodes = runtime.attestedNodes.filter((node) => node.trim().length > 0);
      return [
        {
          digest: runtime.digest,
          kind,
          signatureVerified: runtime.signatureVerified,
          ...(attestation.success ? { runtimeAttestationId: attestation.data } : {}),
          ...(attestedNodes.length > 0 ? { attestedNodes } : {}),
          ...(expiresAtUnixMs ? { expiresAtUnixMs } : {}),
        },
      ];
    }),
  };
}

function computeHealthFacts(health: ComputeHealth | undefined) {
  if (!health) return {};
  return {
    computeHealth: {
      state: protoToComputeHealthState(health.state),
      observedAtUnixMs: health.observedAtUnixMs,
      nodeCount: health.nodeCount,
      operationalNodeCount: health.operationalNodeCount,
      ...(health.reason ? { reason: health.reason } : {}),
    },
  };
}

function protoToComputeHealthState(state: ComputeHealthState): ComputeHealthReport["state"] {
  switch (state) {
    case ComputeHealthState.READY:
      return "ready";
    case ComputeHealthState.UNAVAILABLE:
      return "unavailable";
    default:
      return "unknown";
  }
}

function queueInventoryFacts(inventory: QueueInventory): unknown {
  return {
    status: protoToQueueInventoryStatus(inventory.status),
    ...(inventory.defaultQueueName ? { defaultQueueName: inventory.defaultQueueName } : {}),
    ...(inventory.reason ? { reason: inventory.reason } : {}),
    observedAt: protoDate(inventory.observedAtUnixMs),
    queues: inventory.queues.map((queue) => ({
      queueName: queue.queueName,
      queueType: protoToSchedulerQueueType(queue.queueType),
      isDefault: queue.isDefault,
      state: protoToSchedulerQueueState(queue.state),
      acceptsSubmissions: queue.acceptsSubmissions,
      ...(queue.hasComputeTargets === undefined
        ? {}
        : { hasComputeTargets: queue.hasComputeTargets }),
      observedAt: protoDate(queue.observedAtUnixMs),
    })),
  };
}

function protoDate(value: bigint): Date | undefined {
  const unixMs = safeProtoUnixMs(value);
  return unixMs === undefined ? undefined : new Date(unixMs);
}

function protoToQueueInventoryStatus(
  status: QueueInventoryStatus,
): "unknown" | "available" | "unavailable" | "stale" | "unsupported" {
  switch (status) {
    case QueueInventoryStatus.AVAILABLE:
      return "available";
    case QueueInventoryStatus.UNAVAILABLE:
      return "unavailable";
    case QueueInventoryStatus.STALE:
      return "stale";
    case QueueInventoryStatus.UNSUPPORTED:
      return "unsupported";
    default:
      return "unknown";
  }
}

function protoToSchedulerQueueType(
  queueType: SchedulerQueueType,
): "partition" | "execution" | "route" | "namespace" | "unknown" {
  switch (queueType) {
    case SchedulerQueueType.PARTITION:
      return "partition";
    case SchedulerQueueType.EXECUTION:
      return "execution";
    case SchedulerQueueType.ROUTE:
      return "route";
    case SchedulerQueueType.NAMESPACE:
      return "namespace";
    default:
      return "unknown";
  }
}

function protoToSchedulerQueueState(state: SchedulerQueueState): "up" | "down" | "unknown" {
  switch (state) {
    case SchedulerQueueState.UP:
      return "up";
    case SchedulerQueueState.DOWN:
      return "down";
    default:
      return "unknown";
  }
}

export function collectedForJobCompletion(
  restrictedNoEgress: boolean,
  collected: Record<string, string>,
): Record<string, string> {
  return restrictedNoEgress ? {} : collected;
}

export interface AgentMetricsRecorder {
  /**
   * Persist one or more metric samples for an agent. Implementations
   * MUST be append-only and tolerant of high-frequency writes
   * (heartbeat-rate). Failures are caller-handled.
   */
  record(
    samples: Array<{
      agentId: string;
      metric: string;
      value: number;
      payload?: Record<string, unknown>;
      ts?: Date;
    }>,
  ): Promise<void>;
}

export interface AgentHandlerDeps {
  agentManager: AgentManager;
  jobService: JobService;
  logger: Logger;
  dispatcher: AgentDispatcher;
  /** Optional: when present, heartbeat installed_software is mirrored here. */
  installedRegistry?: InstalledRegistry;
  softwareOperations?: Pick<SoftwareOperationService, "applyAgentResult">;
  policyStore?: Pick<PolicyStore, "getForAgent">;
  policyPusher?: Pick<PolicyPusher, "pushToAgent">;
  /** Optional: when present, GPU/disk/queue-depth samples land here. */
  metricsRecorder?: AgentMetricsRecorder;
  /** Optional: persists Agent-reported scheduler queue inventory. */
  queueInventory?: QueueInventoryService;
  /** Durable, idempotent low-cardinality queue event counters. */
  queueObservability?: Pick<QueueObservabilityService, "recordEvent">;
  /**
   * Optional: when present, SshOutput / SshClosed AgentMessages are
   * routed to the gateway's session registry so the bytes land on the
   * subscribed WebSocket client.
   */
  sshGateway?: SshGateway;
  /**
   * Optional: when present, ShellExecResponse AgentMessages resolve the
   * matching pending Server-side HTTP request (terminal one-shot exec).
   */
  shellExecRegistry?: ShellExecRegistry;
  jobLogsService?: Pick<JobLogsService, "resolve">;
  /**
   * Optional: when present, FileTransferProgress events are routed to
   * the matching transfer listener so the Server's Transfer row tracks
   * real bytes copied.
   */
  transferRegistry?: TransferRegistry;
  /**
   * Optional: when present, terminal JobStatusUpdates resolve the matching
   * workflow engine `awaitCompletion(jobId)` with the agent's collected outputs.
   */
  jobCompletionRegistry?: JobCompletionRegistry;
  /**
   * Optional: when present, an agent PartUrlsRequest is resolved into a set
   * of presigned multipart part URLs (TransferRunner implements it). The
   * ownerId is looked up Server-side by requestId so the agent never asserts
   * an owner.
   */
  partUrlMinter?: {
    mintPartUrlsFor(
      requestId: string,
      partNumbers: number[],
    ): Promise<{ partNumber: number; url: string }[]>;
  };
  sandboxArtifactRelease?: Pick<SandboxArtifactReleaseService, "resolve">;
  dataScanCoordinator?: Pick<DataScanCoordinator, "acceptAgentResult" | "onAgentConnected">;
  dataDeliveryRevocations?: Pick<DataDeliveryRevocationOutbox, "acknowledge" | "redeliver">;
  jobCancellations?: Pick<JobCancellationOutbox, "acknowledge" | "redeliver">;
  jobWorkRootReleases?: Pick<JobWorkRootReleaseOutbox, "acknowledge" | "redeliver">;
}

async function pushLatestStoredPolicy(
  agentId: string,
  policyStore: Pick<PolicyStore, "getForAgent">,
  policyPusher: Pick<PolicyPusher, "pushToAgent">,
  logger: Logger,
): Promise<void> {
  const policy = await policyStore.getForAgent(agentId);
  if (!policy) return;
  const pushed = policyPusher.pushToAgent(agentId, {
    version: policy.version,
    allowList: policy.allowList,
    denyList: policy.denyList,
    lockEnabled: policy.lockEnabled,
    mirrors: policy.mirrors,
    preinstallList: policy.preinstallList,
  });
  if (!pushed) {
    logger.warn(
      { agentId, policyVersion: policy.version },
      "Stored software policy was not pushed after agent register",
    );
  }
}

/**
 * Register the AgentService handler on a connectRPC router.
 *
 * The Connect RPC is bidirectional: Agent sends register → Server acks →
 * both sides continue to exchange heartbeats, status updates, and dispatches.
 *
 * Outbound messages (DispatchJob, CancelJob) are pushed by AgentDispatcher via
 * an in-memory per-stream outbound queue. The generator drains that queue,
 * suspending with a Promise when empty, and resuming when the dispatcher pushes
 * a new message or the inbound stream closes.
 */
export function registerAgentHandler(router: ConnectRouter, deps: AgentHandlerDeps): void {
  const {
    agentManager,
    jobService,
    logger,
    dispatcher,
    installedRegistry,
    softwareOperations,
    policyStore,
    policyPusher,
    metricsRecorder,
    queueInventory,
    queueObservability,
    sshGateway,
    shellExecRegistry,
    jobLogsService,
    transferRegistry,
    jobCompletionRegistry,
    partUrlMinter,
    sandboxArtifactRelease,
    dataScanCoordinator,
    dataDeliveryRevocations,
    jobCancellations,
    jobWorkRootReleases,
  } = deps;

  router.service(AgentService, {
    async *connect(requests: AsyncIterable<AgentMessage>): AsyncIterable<ServerMessage> {
      // Per-stream outbound queue
      const outbound: ServerMessage[] = [];
      let resolver: (() => void) | null = null;
      let registeredAgentId: string | null = null;
      let computeHealthV1 = false;
      let queueInventoryV1 = false;
      let active = true;
      const requestIterator = requests[Symbol.asyncIterator]();

      const channel = {
        push: (m: ServerMessage) => {
          if (!active) {
            throw new Error("agent stream closed");
          }
          outbound.push(m);
          if (resolver) {
            resolver();
            resolver = null;
          }
        },
        close: () => {
          if (!active) return;
          active = false;
          void requestIterator.return?.();
          if (resolver) {
            resolver();
            resolver = null;
          }
        },
      };

      // Process inbound messages in background so outbound generator can run concurrently.
      // The IIFE result is consumed by the surrounding bidi handler; any rejection
      // (AbortError on agent disconnect, malformed payload, etc.) must NOT propagate
      // as an unhandled promise rejection — that crashes the entire Server process.
      const reader = (async () => {
        while (active) {
          const next = await requestIterator.next();
          if (next.done || !active) break;
          const msg = next.value;
          const payload = msg.payload;
          if (
            registeredAgentId !== null &&
            !dispatcher.isCurrentChannel(registeredAgentId, channel)
          ) {
            logger.warn(
              { agentId: registeredAgentId },
              "Ignoring message from replaced Agent stream",
            );
            channel.close();
            break;
          }

          if (payload.case === "register") {
            const reg = payload.value;

            // Pin the body agentId to the verified certificate when mTLS context
            // is present; development mode without that context trusts the body.
            const verifiedAgentId = mtlsContext.getStore()?.agentId ?? null;
            if (verifiedAgentId !== null && verifiedAgentId !== reg.agentId) {
              logger.warn(
                { bodyAgentId: reg.agentId, verifiedAgentId },
                "Rejecting register: body agentId does not match verified mTLS cert",
              );
              channel.push(
                create(ServerMessageSchema, {
                  payload: {
                    case: "registerResponse",
                    value: create(RegisterResponseSchema, {
                      accepted: false,
                      message: `agentId mismatch: cert binds ${verifiedAgentId}, body claimed ${reg.agentId}`,
                    }),
                  },
                }),
              );
              continue;
            }
            if (verifiedAgentId !== null) {
              const existing = await agentManager.getById(reg.agentId);
              if (!existing) {
                logger.warn(
                  { agentId: reg.agentId },
                  "Rejecting register: verified mTLS agent is not registered in Server",
                );
                channel.push(
                  create(ServerMessageSchema, {
                    payload: {
                      case: "registerResponse",
                      value: create(RegisterResponseSchema, {
                        accepted: false,
                        message: "agent is not registered; run kq agent register first",
                      }),
                    },
                  }),
                );
                continue;
              }
            }

            try {
              await agentManager.register({
                agentId: reg.agentId,
                siteName: reg.siteName,
                schedulerType: protoToSchedulerType(reg.schedulerType),
                schedulerVersion: reg.schedulerVersion,
                restrictedDataIsolation: reg.restrictedDataIsolation,
                computeHealthV1: reg.computeHealthV1,
                ...sandboxCapabilityFacts(reg.sandboxCapability),
              });
              await queueInventory?.declareCapability(reg.agentId, reg.queueInventoryV1);
              logger.info({ agentId: reg.agentId }, "Agent registered via gRPC");
              registeredAgentId = reg.agentId;
              computeHealthV1 = reg.computeHealthV1;
              queueInventoryV1 = reg.queueInventoryV1;
              dispatcher.register(registeredAgentId, channel);
              await jobCancellations?.redeliver(registeredAgentId);
              await dataDeliveryRevocations?.redeliver(registeredAgentId);
              await jobWorkRootReleases?.redeliver(registeredAgentId);
              await dataScanCoordinator?.onAgentConnected(registeredAgentId);
              channel.push(
                create(ServerMessageSchema, {
                  payload: {
                    case: "registerResponse",
                    value: create(RegisterResponseSchema, {
                      accepted: true,
                      message: "Registered",
                      heartbeatAckSupported: true,
                      jobStatusAckSupported: true,
                      computeHealthV1Supported: true,
                      queueInventoryV1Supported: queueInventory !== undefined,
                      queueValidationShadowRejectionAckSupported: queueObservability !== undefined,
                    }),
                  },
                }),
              );
              if (policyStore && policyPusher) {
                try {
                  await pushLatestStoredPolicy(reg.agentId, policyStore, policyPusher, logger);
                } catch (err) {
                  logger.error(
                    { err, agentId: reg.agentId },
                    "Failed to push stored software policy after agent register",
                  );
                }
              }
            } catch (err) {
              logger.error({ err, agentId: reg.agentId }, "Agent registration failed");
              channel.push(
                create(ServerMessageSchema, {
                  payload: {
                    case: "registerResponse",
                    value: create(RegisterResponseSchema, {
                      accepted: false,
                      message: err instanceof Error ? err.message : "registration failed",
                    }),
                  },
                }),
              );
            }
            continue;
          }

          if (payload.case === "heartbeat") {
            const hb = payload.value;
            if (registeredAgentId === null) {
              logger.warn("heartbeat before register — ignoring");
              continue;
            }
            try {
              await agentManager.heartbeat({
                agentId: registeredAgentId,
                cpuUsagePercent: hb.cpuUsagePercent,
                memoryUsedMb: Number(hb.memoryUsedMb),
                memoryTotalMb: Number(hb.memoryTotalMb),
                runningJobs: hb.runningJobs,
                queuedJobs: hb.queuedJobs,
                restrictedDataIsolation: hb.restrictedDataIsolation,
                ...sandboxCapabilityFacts(hb.sandboxCapability),
                ...(computeHealthV1 ? computeHealthFacts(hb.computeHealth) : {}),
              });
            } catch (err) {
              logger.warn({ err, agentId: registeredAgentId }, "Heartbeat for unknown agent");
              continue;
            }
            let queueInventoryMetric: { status: string; reason: string | null } | undefined;
            let queueInventoryPersisted = !(queueInventoryV1 && hb.queueInventory);
            if (queueInventory && queueInventoryV1 && hb.queueInventory) {
              try {
                const reconciled = await queueInventory.reconcile(
                  registeredAgentId,
                  queueInventoryFacts(hb.queueInventory),
                );
                queueInventoryMetric = {
                  status: reconciled.status,
                  reason: reconciled.reason,
                };
                queueInventoryPersisted = true;
              } catch (err) {
                logger.error(
                  { err, agentId: registeredAgentId },
                  "Failed to reconcile scheduler queue inventory",
                );
              }
            }
            if (hb.sequence > 0n && queueInventoryPersisted) {
              channel.push(
                create(ServerMessageSchema, {
                  payload: {
                    case: "heartbeatAck",
                    value: create(HeartbeatAckSchema, { sequence: hb.sequence }),
                  },
                }),
              );
            }

            // when the heartbeat carries installed-software,
            // mirror it into the per-agent ledger. This is fire-and-forget
            // so the heartbeat ingest path stays fast; the registry's
            // delete-stale + insert pass is bounded by the agent's local
            // installed-list size.
            if (installedRegistry && hb.installedSoftware.length > 0) {
              installedRegistry
                .replaceForAgent(
                  registeredAgentId,
                  hb.installedSoftware.map((s) => ({
                    name: s.name,
                    version: s.version,
                    hash: s.hash,
                    compiler: s.compiler || undefined,
                    arch: s.arch || undefined,
                    spec: s.spec,
                  })),
                )
                .catch((err) => {
                  logger.error(
                    { err, agentId: registeredAgentId },
                    "Failed to refresh installed-software ledger from heartbeat",
                  );
                });
            }

            // append GPU / disk / scheduler-queue samples.
            if (metricsRecorder) {
              const samples: Parameters<AgentMetricsRecorder["record"]>[0] = [];
              const now = new Date();
              if (typeof hb.diskUsedPercent === "number" && hb.diskUsedPercent > 0) {
                samples.push({
                  agentId: registeredAgentId,
                  metric: "disk_used_percent",
                  value: hb.diskUsedPercent,
                  ts: now,
                });
              }
              if (hb.schedulerQueuedJobs > 0) {
                samples.push({
                  agentId: registeredAgentId,
                  metric: "scheduler_queued_jobs",
                  value: hb.schedulerQueuedJobs,
                  ts: now,
                });
              }
              if (queueInventoryMetric) {
                samples.push({
                  agentId: registeredAgentId,
                  metric: "queue_inventory_available",
                  value: queueInventoryMetric.status === "available" ? 1 : 0,
                  payload: queueInventoryMetric,
                  ts: now,
                });
              }
              for (const g of hb.gpus) {
                samples.push({
                  agentId: registeredAgentId,
                  metric: "gpu",
                  value: g.utilPercent,
                  payload: {
                    index: g.index,
                    model: g.model,
                    memUsedMb: Number(g.memUsedMb),
                    memTotalMb: Number(g.memTotalMb),
                  },
                  ts: now,
                });
              }
              if (samples.length > 0) {
                metricsRecorder.record(samples).catch((err) => {
                  logger.error(
                    { err, agentId: registeredAgentId },
                    "Failed to record agent metrics",
                  );
                });
              }
            }
            continue;
          }

          if (payload.case === "installedSoftwareReport") {
            // out-of-band installed-list refresh (used when the
            // list is too large to ride along with a heartbeat). Same
            // ingest contract as the heartbeat path.
            if (registeredAgentId === null) {
              logger.warn("installedSoftwareReport before register — ignoring");
              continue;
            }
            if (installedRegistry) {
              const report = payload.value;
              await installedRegistry
                .replaceForAgent(
                  registeredAgentId,
                  report.installed.map((s) => ({
                    name: s.name,
                    version: s.version,
                    hash: s.hash,
                    compiler: s.compiler || undefined,
                    arch: s.arch || undefined,
                    spec: s.spec,
                  })),
                )
                .catch((err) => {
                  logger.error(
                    { err, agentId: registeredAgentId },
                    "Failed to apply installed-software report",
                  );
                });
            }
            continue;
          }

          if (payload.case === "softwarePolicyAck") {
            // agent ack for a previously-pushed policy. We log
            // it for now; a future commit can persist the ack into an
            // audit trail keyed on (agentId, policyVersion).
            const ack = payload.value;
            logger.info(
              {
                policyVersion: ack.policyVersion,
                applied: ack.applied,
                error: ack.error,
              },
              "Agent acked software policy",
            );
            continue;
          }

          if (payload.case === "softwareOperationResult") {
            if (registeredAgentId === null) {
              logger.warn("softwareOperationResult before register — ignoring");
              continue;
            }
            if (softwareOperations) {
              try {
                await softwareOperations.applyAgentResult(registeredAgentId, payload.value);
              } catch (err) {
                logger.error(
                  { err, agentId: registeredAgentId, operationId: payload.value.operationId },
                  "Failed to apply software operation result",
                );
              }
            } else {
              logger.debug(
                { operationId: payload.value.operationId },
                "softwareOperationResult with no operation service",
              );
            }
            continue;
          }

          if (payload.case === "queueValidationShadowRejection") {
            if (registeredAgentId === null) {
              logger.warn("queueValidationShadowRejection before register — ignoring");
              continue;
            }
            const failureCode = QueueFailureCodeSchema.safeParse(payload.value.failureCode);
            if (!failureCode.success) {
              logger.warn(
                { agentId: registeredAgentId },
                "Ignoring queue validation shadow rejection with invalid failure code",
              );
              continue;
            }
            if (!payload.value.eventId) {
              logger.warn(
                { agentId: registeredAgentId },
                "Ignoring legacy queue validation shadow rejection without event id",
              );
              continue;
            }
            if (!queueObservability) {
              logger.warn(
                { agentId: registeredAgentId, eventId: payload.value.eventId },
                "Queue observability counter is unavailable; withholding shadow rejection ack",
              );
              continue;
            }
            try {
              await queueObservability.recordEvent({
                agentId: registeredAgentId,
                eventId: payload.value.eventId,
                metric: QUEUE_SHADOW_REJECTION_METRIC,
                failureCode: failureCode.data,
              });
              channel.push(
                create(ServerMessageSchema, {
                  payload: {
                    case: "queueValidationShadowRejectionAck",
                    value: create(QueueValidationShadowRejectionAckSchema, {
                      eventId: payload.value.eventId,
                    }),
                  },
                }),
              );
            } catch (err) {
              logger.error(
                { err, agentId: registeredAgentId, eventId: payload.value.eventId },
                "Failed to persist queue validation shadow rejection",
              );
            }
            continue;
          }

          if (payload.case === "jobStatus") {
            const update = payload.value;
            if (registeredAgentId === null) {
              logger.warn({ jobId: update.jobId }, "jobStatus before register — ignoring");
              continue;
            }
            try {
              const internalStatus = protoToJobStatus(update.status);
              const terminal =
                internalStatus === "completed" ||
                internalStatus === "failed" ||
                internalStatus === "cancelled";
              const failureCode = QueueFailureCodeSchema.safeParse(update.failureCode);
              const persistedJob = await jobService.updateStatus(
                update.jobId,
                internalStatus,
                update.schedulerJobId || undefined,
                registeredAgentId,
                update.message || undefined,
                update.exitCode,
                terminal ? update.collected : undefined,
                update.eventId || undefined,
                {
                  ...(update.node ? { node: update.node } : {}),
                  reason: failureCode.success ? failureCode.data : update.reason || null,
                },
              );
              if (update.workingDir && !persistedJob.workingDir) {
                await jobService.setWorkingDir(update.jobId, update.workingDir);
              }
              if (failureCode.success && failureCode.data === "SCHEDULER_SUBMIT_FAILED") {
                if (!update.eventId) {
                  logger.warn(
                    { agentId: registeredAgentId, jobId: update.jobId },
                    "Scheduler submission failure lacks event id and is excluded from reliable metrics",
                  );
                } else if (queueObservability) {
                  await queueObservability.recordEvent({
                    agentId: registeredAgentId,
                    eventId: update.eventId,
                    metric: SCHEDULER_SUBMIT_FAILURE_METRIC,
                    failureCode: failureCode.data,
                  });
                } else {
                  throw new Error(
                    "Queue observability is unavailable for a durable scheduler submission failure",
                  );
                }
              }
              logger.info(
                { jobId: update.jobId, status: internalStatus, agentId: registeredAgentId },
                "Job status update from agent",
              );
              if (
                jobCompletionRegistry &&
                (persistedJob.status === "completed" ||
                  persistedJob.status === "failed" ||
                  persistedJob.status === "cancelled")
              ) {
                jobCompletionRegistry.complete(update.jobId, {
                  status: persistedJob.status,
                  collected: collectedForJobCompletion(
                    persistedJob.restrictedNoEgress,
                    persistedJob.collectedOutputs ?? {},
                  ),
                  ...(persistedJob.errorMessage ? { errorMessage: persistedJob.errorMessage } : {}),
                  ...(persistedJob.reason ? { reason: persistedJob.reason } : {}),
                  ...(persistedJob.exitCode !== null ? { exitCode: persistedJob.exitCode } : {}),
                });
              }
              if (update.eventId) {
                channel.push(
                  create(ServerMessageSchema, {
                    payload: {
                      case: "jobStatusAck",
                      value: create(JobStatusAckSchema, { eventId: update.eventId }),
                    },
                  }),
                );
              } else {
                logger.warn(
                  { jobId: update.jobId, agentId: registeredAgentId },
                  "Applied legacy job status update without event id; acknowledgement omitted",
                );
              }
            } catch (err) {
              logger.error({ err, jobId: update.jobId }, "Failed to apply job status update");
            }
            continue;
          }

          if (payload.case === "dataDeliveryRevokeAck") {
            if (registeredAgentId === null) continue;
            await dataDeliveryRevocations?.acknowledge(
              registeredAgentId,
              payload.value.jobId,
              payload.value.reasonCode,
            );
            continue;
          }

          if (payload.case === "cancelJobAck") {
            if (registeredAgentId === null) {
              logger.warn("cancelJobAck before register — ignoring");
              continue;
            }
            const revokedEpoch = Number(payload.value.revokedEpoch);
            if (!Number.isSafeInteger(revokedEpoch) || revokedEpoch < 0) {
              logger.warn(
                { agentId: registeredAgentId, jobId: payload.value.jobId },
                "Ignoring cancellation acknowledgement with invalid revocation epoch",
              );
              continue;
            }
            const acknowledged = await jobCancellations?.acknowledge(
              registeredAgentId,
              payload.value.jobId,
              revokedEpoch,
            );
            if (acknowledged === false) {
              logger.warn(
                { agentId: registeredAgentId, jobId: payload.value.jobId, revokedEpoch },
                "Ignoring unknown or stale cancellation acknowledgement",
              );
            }
            continue;
          }

          if (payload.case === "jobWorkRootReleaseAck") {
            if (registeredAgentId === null) {
              logger.warn("jobWorkRootReleaseAck before register — ignoring");
              continue;
            }
            const acknowledged = await jobWorkRootReleases?.acknowledge(
              registeredAgentId,
              payload.value.jobId,
            );
            if (acknowledged === false) {
              logger.warn(
                { agentId: registeredAgentId, jobId: payload.value.jobId },
                "Ignoring unknown Job work-root release acknowledgement",
              );
            }
            continue;
          }

          if (payload.case === "sandboxArtifactReleaseAck") {
            if (registeredAgentId === null) {
              logger.warn("sandboxArtifactReleaseAck before register — ignoring");
              continue;
            }
            const ack = payload.value;
            const resolved = sandboxArtifactRelease?.resolve({
              requestId: ack.requestId,
              releasedReplicaIds: ack.releasedReplicaIds,
              failures: ack.failures,
            });
            if (!resolved) {
              logger.warn(
                { agentId: registeredAgentId, requestId: ack.requestId },
                "Unknown Sandbox artifact release acknowledgement",
              );
            }
            continue;
          }

          if (payload.case === "dataScanResult") {
            if (registeredAgentId === null) {
              logger.warn("dataScanResult before register — ignoring");
              continue;
            }
            const result = payload.value;
            if (dataScanCoordinator) {
              await dataScanCoordinator
                .acceptAgentResult(registeredAgentId, {
                  requestId: result.requestId,
                  importId: result.importId,
                  assetId: result.assetId,
                  versionId: result.versionId,
                  agentId: result.agentId,
                  managedRootId: result.managedRootId,
                  relativePath: result.relativePath,
                  providerOrgId: result.providerOrgId,
                  manifestDigest: result.manifestDigest,
                  contentSha256: result.contentSha256,
                  totalSizeBytes: Number(result.totalSizeBytes),
                  format: result.format,
                  files: result.files.map((file) => ({
                    path: file.relativePath,
                    digest: file.sha256,
                    sizeBytes: Number(file.sizeBytes),
                    mediaType: file.mediaType || undefined,
                  })),
                  attestationAlgorithm: result.attestationAlgorithm,
                  attestationKeyId: result.attestationKeyId,
                  attestationSignature: result.attestationSignature,
                  scannedAt: new Date(Number(result.scannedAtUnixMs)),
                  error: result.error || undefined,
                })
                .catch((err) => {
                  logger.warn(
                    { err, agentId: registeredAgentId, requestId: result.requestId },
                    "Rejected Agent data scan result",
                  );
                });
            } else {
              logger.debug({ requestId: result.requestId }, "dataScanResult with no coordinator");
            }
            continue;
          }

          // reverse SSH stream. The gateway consumes both
          // sshOutput and sshClosed; if no gateway is wired (dev/test
          // mode without WebSocket support) we silently drop, since the
          // Server can't fan out to a non-existent client anyway.
          if (payload.case === "sshOutput" || payload.case === "sshClosed") {
            if (sshGateway) {
              sshGateway.handleAgentMessage(msg);
            } else {
              logger.debug({ case: payload.case }, "SSH frame received but no gateway attached");
            }
            continue;
          }

          if (payload.case === "shellExecResponse") {
            const r = payload.value;
            if (shellExecRegistry) {
              shellExecRegistry.resolve(r.requestId, {
                stdout: r.stdout,
                stderr: r.stderr,
                exitCode: r.exitCode,
                error: r.error,
              });
            } else {
              logger.debug({ requestId: r.requestId }, "shellExecResponse with no registry");
            }
            continue;
          }

          if (payload.case === "jobLogsResponse") {
            const response = payload.value;
            if (jobLogsService) {
              jobLogsService.resolve(response.requestId, {
                text: response.text,
                error: response.error,
                unavailable: response.unavailable,
              });
            } else {
              logger.debug({ requestId: response.requestId }, "jobLogsResponse with no service");
            }
            continue;
          }

          if (payload.case === "fileTransferProgress") {
            const p = payload.value;
            const state = (p.state === "succeeded" || p.state === "failed" ? p.state : "running") as
              | "running"
              | "succeeded"
              | "failed";
            if (transferRegistry) {
              transferRegistry.update(p.requestId, {
                copiedBytes: Number(p.copiedBytes),
                state,
                error: p.error || undefined,
                sha256: p.sha256 || undefined,
                parts: p.parts.map((x) => ({ partNumber: x.partNumber, etag: x.etag })),
              });
            } else {
              logger.debug({ requestId: p.requestId }, "fileTransferProgress with no registry");
            }
            continue;
          }

          if (payload.case === "partUrlsRequest") {
            const reqv = payload.value;
            if (registeredAgentId === null) {
              logger.warn("partUrlsRequest before register — ignoring");
              continue;
            }
            if (partUrlMinter) {
              const agentId = registeredAgentId;
              void partUrlMinter
                .mintPartUrlsFor(reqv.requestId, reqv.partNumbers)
                .then((urls) => dispatcher.pushPartUrlsResponse(agentId, reqv.requestId, urls))
                .catch((err) =>
                  logger.error({ err, requestId: reqv.requestId }, "mintPartUrls failed"),
                );
            }
            continue;
          }

          logger.warn({ case: payload.case }, "Unknown AgentMessage payload case");
        }
        // Inbound stream ended — signal the outbound generator to stop
        channel.close();
      })().catch((err) => {
        // AbortError ("The connection was closed") fires whenever the
        // agent's client disconnects mid-stream — completely normal during
        // reconnects, image rebuilds, etc. Anything else we want to see.
        if (isExpectedStreamDisconnect(err)) {
          logger.debug(
            { agentId: registeredAgentId },
            "Inbound stream aborted (client disconnected)",
          );
        } else {
          logger.error({ err, agentId: registeredAgentId }, "Inbound stream reader crashed");
        }
        channel.close();
      });

      // Drain the outbound queue, yielding messages as they arrive.
      try {
        while (active) {
          while (outbound.length > 0) {
            const m = outbound.shift();
            if (m) yield m;
          }
          if (!active) break;
          // Suspend until dispatcher pushes a message or inbound stream ends
          await new Promise<void>((resolve) => {
            resolver = resolve;
            if (!active || outbound.length > 0) {
              resolver = null;
              resolve();
            }
          });
        }
        // Drain any remaining messages before closing
        while (outbound.length > 0) {
          const m = outbound.shift();
          if (m) yield m;
        }
      } finally {
        if (registeredAgentId) {
          dispatcher.unregister(registeredAgentId, channel);
          // The agent's stream just dropped — its ssh2 channels are gone, so
          // free any SSH sessions bound to it instead of leaving clients on a
          // frozen terminal that still holds their concurrent-session slot.
          const orphaned = sshGateway?.closeSessionsForAgent(registeredAgentId);
          if (orphaned) {
            logger.info({ agentId: registeredAgentId, orphaned }, "Closed orphaned SSH sessions");
          }
        }
        await reader.catch(() => {});
      }
    },
  });
}

function isExpectedStreamDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ABORT_ERR" || code === "ECONNRESET" || error.message === "aborted";
}
