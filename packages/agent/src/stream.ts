import { Buffer } from "node:buffer";
import { rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  type AgentMessage,
  AgentMessageSchema,
  CancelJobAckSchema,
  ComputeHealthSchema,
  DataDeliveryRevokeAckSchema,
  DataScanFileSchema,
  DataScanResultSchema,
  type DispatchJob,
  FileTransferProgressSchema,
  GpuMetricSchema,
  HeartbeatSchema,
  InstalledSoftwareReportSchema,
  InstalledSpecSchema,
  JobLogsResponseSchema,
  JobStatusUpdateSchema,
  JobWorkRootReleaseAckSchema,
  PartUrlsRequestSchema,
  ComputeHealthState as ProtoComputeHealthState,
  JobStatus as ProtoJobStatus,
  QueueInventoryStatus as ProtoQueueInventoryStatus,
  QueueTargetMode as ProtoQueueTargetMode,
  QueueValidationMode as ProtoQueueValidationMode,
  SchedulerQueueState as ProtoSchedulerQueueState,
  SchedulerQueueType as ProtoSchedulerQueueType,
  QueueInventorySchema,
  QueueValidationShadowRejectionSchema,
  RegisterRequestSchema,
  SandboxArtifactReleaseAckSchema,
  SandboxCapabilitySchema,
  SandboxRuntimeCacheEntrySchema,
  SandboxRuntimeKind,
  SandboxSelfAccountSchema,
  SchedulerQueueFactSchema,
  SchedulerType,
  type ServerMessage,
  ShellExecResponseSchema,
  SoftwareOperationAction,
  SoftwareOperationResultSchema,
  SoftwareOperationStatus,
  SoftwarePolicyAckSchema,
  SshClosedSchema,
  SshOutputSchema,
  UploadedPartSchema,
} from "@kuintessence/proto";
import {
  createLogger,
  type InstalledSpec,
  type QueueFailureCode,
  type SchedulerQueueInventory,
  SchedulerQueueInventorySchema,
} from "@kuintessence/shared";
import type { Logger } from "pino";
import {
  COMPUTE_HEALTH_REASONS,
  type ComputeHealthObservation,
  JobLogUnavailableError,
  type JobSpec,
  type KuintessenceJobLookup,
  type SandboxJobSpec,
  type SchedulerAdapter,
  type Spawner,
  unknownComputeHealth,
} from "./adapters/base";
import { unavailableQueueInventory } from "./adapters/queue-inventory";
import type { DataDeliveryExecutor } from "./data-market/data-delivery";
import type {
  CpLocalDataScanner,
  CpLocalDataScanRequest,
  CpLocalDataScanResult,
} from "./data-market/data-scan";
import { ExecutorPool } from "./embedded/executor-pool";
import type { JobStatusReport } from "./embedded/job-executor";
import {
  buildCloudToClusterArgv,
  buildHostCloudToClusterArgv,
  hasPathTraversal,
  normalizeClusterToCloudSourceError,
} from "./file-transfer";
import type {
  LicensedMaterialResolver,
  PreparedLicensedMaterialMount,
} from "./licensed-material-resolver";
import { readDiskUsedPercent as defaultReadDiskUsedPercent } from "./monitor/disk";
import { readGpuMetrics as defaultReadGpuMetrics, type GpuMetric } from "./monitor/gpu";
import { readMetrics } from "./monitor/metrics";
import { createCachedSchedulerQueueDepthReader } from "./monitor/queue-depth";
import type { ExpectedOutput } from "./output-collector";
import type { ActiveRemoteJobs } from "./queue/active-remote-jobs";
import type { InboundAcks } from "./queue/inbound-acks";
import type {
  JobCleanupIntent,
  JobCleanupIntents,
  JobRevocationTombstones,
} from "./queue/job-cleanup-intents";
import type {
  HeartbeatSnapshot,
  OutboundQueue,
  OutboundItem as PersistedOutboundItem,
} from "./queue/outbound-queue";
import type { AgentSandboxCapability } from "./sandbox/capability";
import type { SandboxDispatchProcessor } from "./sandbox/dispatch-processor";
import {
  assertRestrictedExecutionProfileIdentity,
  type RestrictedExecutionProfile,
} from "./sandbox/restricted-execution-profile";
import { validateSandboxOutputs } from "./sandbox/stager";
import type { ServerClient, ServerReachabilityProbe } from "./server-client";
import type {
  SoftwareOperationAction as AgentSoftwareOperationAction,
  SpackManager,
  SpackMaterialContext,
} from "./spack";
import { activateWorkflowSpack, SPACK_ACTIVATION_FAILURE } from "./spack/workflow-activation";
import type { SshHandler, SshOutgoingMessage } from "./ssh";
import { multipartUploadFromFile } from "./staging/multipart-upload-from-file";
import { streamUploadToPresignedUrl } from "./staging/stream-upload";

// ---------------------------------------------------------------------------
// Tagged-union outbound queue item (in-memory variant — see outbound-queue.ts
// for the persistent variant with the same shape)
// ---------------------------------------------------------------------------

type OutboundItem =
  | {
      kind: "heartbeat";
      message: AgentMessage;
      sequence: bigint;
      recoveryFailureGeneration?: number;
    }
  | {
      kind: "jobStatus";
      report: JobStatusReport;
      eventId?: string;
      durablyPersisted?: boolean;
    }
  | {
      kind: "queueValidationShadowRejection";
      failureCode: QueueFailureCode;
      eventId: string;
      durablyPersisted?: boolean;
    }
  | {
      kind: "softwarePolicyAck";
      policyVersion: string;
      applied: boolean;
      error?: string;
    }
  | {
      kind: "softwareOperationResult";
      operationId: string;
      action: SoftwareOperationAction;
      status: SoftwareOperationStatus;
      spec: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
      installed?: InstalledSpec[];
    }
  | {
      kind: "sshOutput";
      sessionId: string;
      data: Uint8Array;
    }
  | {
      kind: "sshClosed";
      sessionId: string;
      reason: string;
      exitCode?: number;
    }
  | {
      kind: "shellExecResponse";
      requestId: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      error: string;
    }
  | {
      kind: "jobLogsResponse";
      requestId: string;
      text: string;
      error: string;
      unavailable: boolean;
    }
  | {
      kind: "fileTransferProgress";
      requestId: string;
      copiedBytes: number;
      state: "running" | "succeeded" | "failed";
      error: string;
      sha256: string;
      parts: { partNumber: number; etag: string }[];
    }
  | {
      kind: "partUrlsRequest";
      requestId: string;
      partNumbers: number[];
    }
  | {
      kind: "sandboxArtifactReleaseAck";
      requestId: string;
      releasedReplicaIds: string[];
      failures: Record<string, string>;
    }
  | {
      kind: "dataScanResult";
      request: CpLocalDataScanRequest;
      result?: CpLocalDataScanResult;
      error: string;
    }
  | {
      kind: "dataDeliveryRevokeAck";
      jobId: string;
      reasonCode: string;
    }
  | {
      kind: "cancelJobAck";
      jobId: string;
      revokedEpoch: number;
    }
  | {
      kind: "jobWorkRootReleaseAck";
      jobId: string;
    };

type QueueValidationShadowOutboxFailureOperation =
  | "acknowledge"
  | "enqueue"
  | "loadForReplay"
  | "missing"
  | "pendingCount";

const COMPUTE_HEALTH_REASON_SET = new Set<string>(COMPUTE_HEALTH_REASONS);
const MAX_PROTO_INT32 = 2_147_483_647;

function isValidComputeHealthObservation(value: unknown): value is ComputeHealthObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Partial<ComputeHealthObservation>;
  return (
    (health.state === "unknown" || health.state === "ready" || health.state === "unavailable") &&
    typeof health.observedAtUnixMs === "number" &&
    Number.isSafeInteger(health.observedAtUnixMs) &&
    health.observedAtUnixMs > 0 &&
    typeof health.nodeCount === "number" &&
    Number.isSafeInteger(health.nodeCount) &&
    health.nodeCount >= 0 &&
    health.nodeCount <= MAX_PROTO_INT32 &&
    typeof health.operationalNodeCount === "number" &&
    Number.isSafeInteger(health.operationalNodeCount) &&
    health.operationalNodeCount >= 0 &&
    health.operationalNodeCount <= health.nodeCount &&
    health.operationalNodeCount <= MAX_PROTO_INT32 &&
    (health.reason === undefined ||
      (typeof health.reason === "string" && COMPUTE_HEALTH_REASON_SET.has(health.reason)))
  );
}

function computeHealthStateToProto(
  state: ComputeHealthObservation["state"],
): ProtoComputeHealthState {
  switch (state) {
    case "unknown":
      return ProtoComputeHealthState.UNKNOWN;
    case "ready":
      return ProtoComputeHealthState.READY;
    case "unavailable":
      return ProtoComputeHealthState.UNAVAILABLE;
  }
}

function queueInventoryStatusToProto(
  status: SchedulerQueueInventory["status"],
): ProtoQueueInventoryStatus {
  switch (status) {
    case "unknown":
      return ProtoQueueInventoryStatus.UNKNOWN;
    case "available":
      return ProtoQueueInventoryStatus.AVAILABLE;
    case "unavailable":
      return ProtoQueueInventoryStatus.UNAVAILABLE;
    case "stale":
      return ProtoQueueInventoryStatus.STALE;
    case "unsupported":
      return ProtoQueueInventoryStatus.UNSUPPORTED;
  }
}

function schedulerQueueTypeToProto(
  type: SchedulerQueueInventory["queues"][number]["queueType"],
): ProtoSchedulerQueueType {
  switch (type) {
    case "partition":
      return ProtoSchedulerQueueType.PARTITION;
    case "execution":
      return ProtoSchedulerQueueType.EXECUTION;
    case "route":
      return ProtoSchedulerQueueType.ROUTE;
    case "namespace":
      return ProtoSchedulerQueueType.NAMESPACE;
    case "unknown":
      return ProtoSchedulerQueueType.UNKNOWN;
  }
}

function schedulerQueueStateToProto(
  state: SchedulerQueueInventory["queues"][number]["state"],
): ProtoSchedulerQueueState {
  switch (state) {
    case "up":
      return ProtoSchedulerQueueState.UP;
    case "down":
      return ProtoSchedulerQueueState.DOWN;
    case "unknown":
      return ProtoSchedulerQueueState.UNKNOWN;
  }
}

function queueTargetModeFromProto(value: ProtoQueueTargetMode): "default" | "named" | undefined {
  if (value === ProtoQueueTargetMode.DEFAULT) return "default";
  if (value === ProtoQueueTargetMode.NAMED) return "named";
  return undefined;
}

function queueValidationModeFromProto(
  value: ProtoQueueValidationMode,
): "off" | "shadow" | "enforce" | undefined {
  if (value === ProtoQueueValidationMode.OFF) return "off";
  if (value === ProtoQueueValidationMode.SHADOW) return "shadow";
  if (value === ProtoQueueValidationMode.ENFORCE) return "enforce";
  return undefined;
}

/** Fail a multipart transfer if the Server never returns presigned part URLs. */
const PART_URL_TIMEOUT_MS = 60_000;
const MAX_JOB_LOG_LINES = 5_000;
const MAX_JOB_LOG_BYTES = 1024 * 1024;
const DEFAULT_DATA_SCAN_TIMEOUT_MS = 300_000;
const MAX_COMPLETED_DATA_SCANS = 512;

function schedulerSubmissionTag(jobId: string): string {
  return `kq-${jobId.replaceAll("-", "").slice(0, 11)}`;
}

function schedulerLookupForSpec(spec: JobSpec): KuintessenceJobLookup & { schedulerName: string } {
  const identity = spec.sandbox?.identity;
  return {
    jobId: spec.jobId,
    schedulerName: spec.schedulerName ?? schedulerSubmissionTag(spec.jobId),
    ...(identity?.backend === "Unix" && identity.schedulerAccount
      ? { schedulerAccount: identity.schedulerAccount }
      : {}),
    ...(identity?.backend === "Kubernetes"
      ? { namespace: identity.namespace }
      : spec.queueName
        ? { namespace: spec.queueName }
        : {}),
  };
}

function limitJobLogBytes(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= MAX_JOB_LOG_BYTES) return text;
  let start = bytes.byteLength - MAX_JOB_LOG_BYTES;
  while (start < bytes.byteLength && (bytes[start] ?? 0) >> 6 === 2) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function isSafeRelativeDataScanPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split(/[\\/]/).some((segment) => segment === "" || segment === "..")
  );
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CP-local data scan timed out")), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers: enum mapping
// ---------------------------------------------------------------------------

function schedulerTypeToProto(s: string): SchedulerType {
  switch (s) {
    case "slurm":
      return SchedulerType.SLURM;
    case "pbs-pro":
      return SchedulerType.PBS_PRO;
    case "torque":
      return SchedulerType.TORQUE;
    case "kubernetes":
      return SchedulerType.KUBERNETES;
    default:
      return SchedulerType.UNSPECIFIED;
  }
}

function jobStatusToProto(s: JobStatusReport["status"]): ProtoJobStatus {
  switch (s) {
    case "queued":
      return ProtoJobStatus.QUEUED;
    case "running":
      return ProtoJobStatus.RUNNING;
    case "completed":
      return ProtoJobStatus.COMPLETED;
    case "failed":
      return ProtoJobStatus.FAILED;
    case "cancelled":
      return ProtoJobStatus.CANCELLED;
  }
}

function softwareOperationActionToAgent(
  action: SoftwareOperationAction,
): AgentSoftwareOperationAction | undefined {
  switch (action) {
    case SoftwareOperationAction.INSTALL:
      return "install";
    case SoftwareOperationAction.UNINSTALL:
      return "uninstall";
    case SoftwareOperationAction.LOAD:
      return "load";
    case SoftwareOperationAction.IMPORT_PREINSTALLED:
      return "import_preinstalled";
    default:
      return undefined;
  }
}

/** Build the outbound `jobStatus` AgentMessage from a {@link JobStatusReport}.
 *  Pure + exported so the report→proto field mapping (incl. `node`/`reason`,
 *  which the Server persists for remote-mode job detail) is unit-testable without
 *  driving the full dispatch/poll loop. */
export function jobStatusReportToProto(report: JobStatusReport, eventId = ""): AgentMessage {
  return create(AgentMessageSchema, {
    payload: {
      case: "jobStatus",
      value: create(JobStatusUpdateSchema, {
        jobId: report.jobId,
        status: jobStatusToProto(report.status),
        schedulerJobId: report.schedulerJobId ?? "",
        message: report.message ?? "",
        failureCode: report.failureCode ?? "",
        exitCode: report.exitCode,
        node: report.node ?? "",
        reason: report.reason ?? "",
        collected: report.collected ?? {},
        eventId,
        workingDir: report.workingDir ?? "",
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// AgentStream deps
// ---------------------------------------------------------------------------

export interface AgentStreamDeps {
  client: ServerClient;
  /**
   * Rebuilds the HTTP/2 transport for each reconnect attempt. A transport
   * created before a Server container restart can retain the old container IP
   * and wait forever on a dead session, so production wiring must provide
   * this factory while tests may continue to inject a stable fake client.
   */
  clientFactory?: () => ServerClient;
  adapter: SchedulerAdapter;
  agentId: string;
  siteName: string;
  heartbeatIntervalMs: number;
  /** Optional JobRunner polling override. Production keeps its 10-second default. */
  jobPollIntervalMs?: number;
  /** Optional JobRunner sleep seam for deterministic unit tests. */
  jobSleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Reconnect wait after a stream error or close. Default: 5000 ms. */
  reconnectBackoffMs?: number;
  /** Maximum wait for RegisterResponse. The established stream has no total deadline. */
  registrationTimeoutMs?: number;
  /** Maximum wait for a negotiated primary-stream HeartbeatAck. */
  heartbeatAckTimeoutMs?: number;
  /** Maximum shutdown wait for software cancellation, cleanup and result persistence. */
  softwareOperationShutdownTimeoutMs?: number;
  /** Workflow load deadline, capped at 60 seconds by the activation helper. */
  spackActivationTimeoutMs?: number;
  /** Syntax-only shell validation seam; never executes the activation shell. */
  spackActivationSpawner?: Spawner;
  /** Independent mTLS reachability check for detecting a half-open bidi stream. */
  reachabilityProbe?: ServerReachabilityProbe;
  /** Delay between reachability probes after registration is accepted. */
  reachabilityProbeIntervalMs?: number;
  /** Injected sleep for tests. Default: Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional durable spillover for offline periods. When the connectRPC
   * stream is down, status updates and heartbeats are persisted here and
   * replayed in (created_at, id) order on the next successful reconnect.
   * If omitted, the AgentStream behaves as before — drops while offline.
   */
  outboundQueue?: OutboundQueue;
  /**
   * Optional dispatch-ack tracker. When present, every received DispatchJob
   * is persisted BEFORE being handed to the runner; the row is marked acked
   * after the runner emits its first status update. On reconnect, any rows
   * still pending an ack get a replayed JobStatusReport so a disconnect
   * between dispatch-receive and ack-send does not cause Server re-dispatch.
   */
  inboundAcks?: InboundAcks;
  activeRemoteJobs?: ActiveRemoteJobs;
  cleanupIntents?: JobCleanupIntents;
  revocationTombstones?: JobRevocationTombstones;

  /**
   * optional SpackManager. When present, inbound
   * SoftwarePolicyUpdate / SpecDistribute messages are routed here and
   * the corresponding ack message is queued back to the Server.
   */
  spackManager?: SpackManager;

  /**
   * installed Spack spec list to ride along with every
   * Heartbeat. The Agent index.ts hydrates this once at boot via
   * SpackManager.installedList(). When the list refreshes after an
   * install/uninstall the agent should swap in a new list via the
   * setInstalledSoftware() setter. Omitted means unknown, not an empty
   * inventory; only successfully read snapshots may clear the Server ledger.
   */
  installedSoftware?: InstalledSpec[];

  /**
   * injected metrics readers. Tests pass deterministic stubs;
   * production hands in the real readers. Each is best-effort and may
   * return empty/0/null without raising.
   */
  readGpuMetrics?: () => Promise<GpuMetric[]>;
  readDiskUsedPercent?: () => Promise<number | null>;
  readSchedulerQueueDepth?: () => Promise<number>;
  schedulerMetricsRefreshMs?: number;
  schedulerCliTimeoutMs?: number;
  metricsSpawner?: Spawner;

  /**
   * optional SshHandler factory. The factory receives the
   * stream's outbound enqueue callback so the handler can push SshOutput
   * / SshClosed messages back through the same connectRPC channel that
   * carries heartbeats and job-status updates. When absent, the agent
   * acks every SshOpen with a synthetic SshClosed reason="ssh handler
   * disabled" so the Server gateway doesn't hang waiting for output.
   */
  sshHandlerFactory?: (enqueue: (msg: SshOutgoingMessage) => void) => SshHandler;

  /**
   * P4-f — reads a completed job's expected output files into a
   * descriptor→content map (container-aware in production). Passed through to
   * each JobRunner; the collected map rides the terminal JobStatusUpdate so the
   * Server can extract typed workflow values. When absent, no outputs are collected.
   */
  collectOutputs?: (
    outputs: ExpectedOutput[],
    workingDir: string,
  ) => Promise<Record<string, string>>;

  /**
   * P5 — ensure a dispatched job's run directory exists (container-aware
   * `mkdir -p`) before submit, so `sbatch --chdir` and relative output
   * collection have a real directory. No-op for an empty workingDir.
   */
  ensureWorkingDir?: (path: string) => Promise<void>;

  /**
   * Container id for the Docker-hosted Slurm (container spawner backend), used
   * by the file-transfer relay's `docker exec`. Sourced from the agent's
   * Zod-validated config; undefined in host mode (file transfers then no-op).
   */
  slurmContainerId?: string;

  /**
   * Cloud→cluster download tuning, sourced from the agent's Zod-validated
   * config. `fileTransferMaxRetries` caps consecutive curl attempts and
   * `fileTransferRetryBackoffSec` is the sleep between them; the in-container
   * loop resumes a partial file via `curl -C -` so a blip doesn't restart at 0.
   * Optional (matching the other injected deps); defaults applied at the use site.
   */
  fileTransferMaxRetries?: number;
  fileTransferRetryBackoffSec?: number;
  fileTransferConnectTo?: string;
  containerFileTransferConnectTo?: string;
  sandboxProcessor?: Pick<SandboxDispatchProcessor, "prepare">;
  assertSandboxRuntimeAttestation?: (
    sandbox: SandboxJobSpec,
    runtimeDigest: string,
  ) => void | Promise<void>;
  sandboxCapability?: AgentSandboxCapability;
  restrictedExecutionProfile?: RestrictedExecutionProfile;
  assertRestrictedExecutionProfileIdentity?: (profile: RestrictedExecutionProfile) => Promise<void>;
  removeRestrictedWorkRoot?: (jobId: string) => Promise<void>;
  /** Deprecated compatibility input. Restricted admission uses the validated profile only. */
  restrictedDataIsolation?: boolean;
  releaseSandboxArtifacts?: (
    items: Array<{ replicaId: string; storageRef: string }>,
  ) => Promise<{ releasedReplicaIds: string[]; failures: Record<string, string> }>;
  licensedMaterialResolver?: Pick<LicensedMaterialResolver, "prepare" | "release">;
  prepareJobWorkRoot?: (jobId: string) => Promise<string>;
  removeJobWorkRoot?: (jobId: string) => Promise<void>;
  stageInputFile?: (sourceUrl: string, targetPath: string) => Promise<void>;
  dataScanner?: CpLocalDataScanner;
  dataScanTimeoutMs?: number;
  dataDeliveryExecutor?: Pick<DataDeliveryExecutor, "prepare" | "release" | "recover">;
}

const DEFAULT_FILE_TRANSFER_MAX_RETRIES = 3;
const DEFAULT_FILE_TRANSFER_RETRY_BACKOFF_SEC = 2;

function throwIfTransferAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("TRANSFER_CANCELLED");
}

// ---------------------------------------------------------------------------
// AgentStream
// ---------------------------------------------------------------------------

/**
 * Long-running bidirectional stream manager.
 *
 * Lifecycle:
 *   1. start() enters a reconnect loop.
 *   2. Each iteration calls runOnce(), which opens a single bidi stream,
 *      sends a register message, and concurrently:
 *        - drains the outbound queue (job status updates + heartbeats)
 *        - processes inbound ServerMessages (dispatchJob, cancelJob, etc.)
 *   3. If the stream closes or throws, runOnce() returns and the loop
 *      waits reconnectBackoffMs before retrying.
 *   4. stop() sets running=false, stops the executor pool's polling (without
 *      killing cluster jobs), and wakes the outbound generator so it can exit
 *      cleanly.
 */
export class AgentStream {
  private running = true;
  private connected = false;
  private outboundQueue: OutboundItem[] = [];
  private readonly outboundResolvers = new Set<() => void>();
  private readonly pendingPartUrlRequests = new Map<
    string,
    {
      resolve: (urls: { partNumber: number; url: string }[]) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly activeFileTransfers = new Map<string, AbortController>();
  private pool: ExecutorPool;
  private logger: Logger;
  private sleep: (ms: number) => Promise<void>;
  private reconnectBackoffMs: number;
  private registrationTimeoutMs: number;
  private heartbeatAckTimeoutMs: number;
  private reachabilityProbeIntervalMs: number;
  private currentStreamController: AbortController | undefined;
  private streamAttemptCompletion: Promise<void> = Promise.resolve();
  private readonly lifecycleController = new AbortController();
  private persistentQueue: OutboundQueue | undefined;
  private inboundAcks: InboundAcks | undefined;
  private activeRemoteJobs: ActiveRemoteJobs | undefined;
  private cleanupIntents: JobCleanupIntents | undefined;
  private revocationTombstones: JobRevocationTombstones | undefined;
  private spackManager: SpackManager | undefined;
  private installedSoftware: InstalledSpec[];
  private installedSoftwareKnown: boolean;
  private softwareOperationQueue: Promise<void> = Promise.resolve();
  private readonly pendingSoftwareResultSpills = new Set<Promise<void>>();
  private softwareOperationShutdown: Promise<void> | undefined;
  private readonly spackActivations = new Map<string, { epoch: number; controller: AbortController }>();
  private readonly pendingSpackPreparations = new Set<Promise<void>>();
  private readonly pendingSpackLoadCleanups = new Set<Promise<void>>();
  private readonly preparingSpackDispatches = new Set<string>();
  private readonly spackDispatchEpochs = new WeakMap<JobSpec, number>();
  private readGpuMetricsFn: () => Promise<GpuMetric[]>;
  private readDiskUsedPercentFn: () => Promise<number | null>;
  private readSchedulerQueueDepthFn: () => Promise<number>;
  private sshHandler: SshHandler | undefined;
  private licensedMaterialMounts = new Map<string, PreparedLicensedMaterialMount[]>();
  private restrictedWorkRoots = new Set<string>();
  private managedWorkRootsAwaitingServerRelease = new Set<string>();
  private unreconciledSubmittedJobs = new Map<string, string>();
  private readonly completedDataScans = new Map<string, OutboundItem>();
  private readonly pendingDataScans = new Map<string, Promise<void>>();
  private readonly pendingJobCancellations = new Map<
    string,
    { revokedEpoch: number; settle: Promise<void> }
  >();
  private readonly sandboxRuntimeDigests = new WeakMap<JobSpec, string>();
  /**
   * Tracks which dispatchIds we have already marked acked during this
   * runner-lifetime so onStatusUpdate doesn't issue redundant SQL UPDATEs
   * for every status transition (queued -> running -> completed -> ...).
   */
  private ackedDispatches = new Set<string>();
  private readonly dispatchIdsByJob = new Map<string, string>();
  private heartbeatSequence = 0n;
  private heartbeatAckSupported = false;
  private jobStatusAckSupported = false;
  private queueValidationShadowRejectionAckSupported = false;
  private computeHealthV1Supported = false;
  private readonly computeHealthV1Capable: boolean;
  private queueInventoryV1Supported = false;
  private readonly queueInventoryV1Capable: boolean;
  private heartbeatTimer:
    | { owner: AbortController; handle: ReturnType<typeof setInterval> }
    | undefined;
  private heartbeatPreparationAttempt: AbortController | undefined;
  private readonly pendingHeartbeatAcks = new Map<bigint, ReturnType<typeof setTimeout>>();
  private readonly pendingJobStatusAcks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingQueueValidationShadowRejectionAcks = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private queueValidationShadowOutboxUnavailable = false;
  private queueValidationShadowOutboxFailureGeneration = 0;
  private readonly queueValidationShadowOutboxFailures =
    new Set<QueueValidationShadowOutboxFailureOperation>();
  private readonly pendingQueueValidationShadowRejectionEnqueues = new Map<
    string,
    QueueFailureCode
  >();
  private readonly pendingQueueValidationShadowRejectionDeletes = new Set<string>();
  private queueValidationShadowOutboxRecoveryHeartbeat:
    | { sequence: bigint; failureGeneration: number }
    | undefined;
  private heartbeatFollowUpRequested = false;

  constructor(private deps: AgentStreamDeps) {
    this.logger = deps.logger ?? createLogger("agent-stream");
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.reconnectBackoffMs = deps.reconnectBackoffMs ?? 5_000;
    this.registrationTimeoutMs = deps.registrationTimeoutMs ?? 30_000;
    this.heartbeatAckTimeoutMs = deps.heartbeatAckTimeoutMs ?? 10_000;
    this.reachabilityProbeIntervalMs = deps.reachabilityProbeIntervalMs ?? 30_000;
    this.computeHealthV1Capable = typeof deps.adapter.inspectComputeHealth === "function";
    this.queueInventoryV1Capable = typeof deps.adapter.inspectQueues === "function";
    this.persistentQueue = deps.outboundQueue;
    this.inboundAcks = deps.inboundAcks;
    this.activeRemoteJobs = deps.activeRemoteJobs;
    this.cleanupIntents = deps.cleanupIntents;
    this.revocationTombstones = deps.revocationTombstones;
    this.spackManager = deps.spackManager;
    this.installedSoftware = deps.installedSoftware ?? [];
    this.installedSoftwareKnown = deps.installedSoftware !== undefined;
    this.readGpuMetricsFn = deps.readGpuMetrics ?? (() => defaultReadGpuMetrics());
    this.readDiskUsedPercentFn = deps.readDiskUsedPercent ?? (() => defaultReadDiskUsedPercent());
    this.readSchedulerQueueDepthFn =
      deps.readSchedulerQueueDepth ??
      createCachedSchedulerQueueDepthReader({
        schedulerType: deps.adapter.type,
        spawner: deps.metricsSpawner,
        refreshIntervalMs: deps.schedulerMetricsRefreshMs ?? 120_000,
        timeoutMs: deps.schedulerCliTimeoutMs ?? 5_000,
      });
    this.sshHandler = deps.sshHandlerFactory
      ? deps.sshHandlerFactory((m) => this.enqueueSshOutgoing(m))
      : undefined;
    // Single job-lifecycle manager shared with the all-in-one CLI. The
    // per-dispatch ack/enqueue logic that used to live in a per-job
    // onStatusUpdate closure routes by report.jobId here (dispatchId === jobId
    // === report.jobId in this daemon path), so one shared onTransition is an
    // exact equivalent. Terminal-job removal from the active set is handled by
    // ExecutorPool's run().finally(), replacing the old `runners.delete(...)`.
    this.pool = new ExecutorPool({
      adapter: deps.adapter,
      pollIntervalMs: deps.jobPollIntervalMs,
      sleep: deps.jobSleep,
      collectOutputs: deps.collectOutputs,
      ensureWorkingDir: deps.ensureWorkingDir,
      onSchedulerSubmitting: async (spec) => {
        await this.cleanupIntents?.recordSchedulerSubmitting(
          spec.jobId,
          schedulerLookupForSpec(spec),
        );
        if (spec.sandbox) {
          const assertRuntimeAttestation = deps.assertSandboxRuntimeAttestation;
          if (!assertRuntimeAttestation) {
            throw new Error(
              "Sandbox runtime attestation verifier is unavailable before scheduler submission",
            );
          }
          const runtimeDigest = this.sandboxRuntimeDigests.get(spec);
          if (!runtimeDigest) {
            throw new Error(
              "Sandbox runtime attestation digest is unavailable before scheduler submission",
            );
          }
          await assertRuntimeAttestation(spec.sandbox, runtimeDigest);
        }
        const spackEpoch = this.spackDispatchEpochs.get(spec);
        if (spackEpoch !== undefined) {
          await this.assertDispatchEpochAllowed(spec.jobId, spackEpoch);
          this.lifecycleController.signal.throwIfAborted();
        }
      },
      onQueueValidationShadowRejection: (failureCode) =>
        this.enqueueQueueValidationShadowRejection(failureCode),
      onSchedulerSubmitted: async (spec, schedulerJobId, expectedOutputs) => {
        try {
          await this.cleanupIntents?.recordSchedulerSubmitted(spec.jobId, schedulerJobId);
          await this.activeRemoteJobs?.recordSubmitted({ spec, schedulerJobId, expectedOutputs });
        } catch (err) {
          const recoveryErrors: unknown[] = [err];
          try {
            await deps.adapter.cancel(schedulerJobId);
          } catch (cancelError) {
            recoveryErrors.push(cancelError);
            try {
              await this.activeRemoteJobs?.recordSubmitted({
                spec,
                schedulerJobId,
                expectedOutputs,
              });
              this.logger.warn(
                { err, jobId: spec.jobId, schedulerJobId },
                "Active remote job persistence recovered after scheduler cancellation failed",
              );
              return;
            } catch (reconcileError) {
              recoveryErrors.push(reconcileError);
              this.unreconciledSubmittedJobs.set(spec.jobId, schedulerJobId);
            }
          }
          this.logger.error(
            {
              err: new AggregateError(recoveryErrors, "active job persistence failed"),
              jobId: spec.jobId,
              schedulerJobId,
            },
            "Failed to persist active remote job; scheduler submission was cancelled or retained for recovery",
          );
          throw new AggregateError(recoveryErrors, "Active remote job persistence failed");
        }
      },
      onJobFinished: async (jobId) => {
        const unreconciledSchedulerJobId = this.unreconciledSubmittedJobs.get(jobId);
        if (unreconciledSchedulerJobId) {
          this.logger.error(
            { jobId, schedulerJobId: unreconciledSchedulerJobId },
            "Retaining cleanup intent because submitted scheduler job could not be reconciled",
          );
          return;
        }
        const mounts = this.licensedMaterialMounts.get(jobId);
        const [dataCleanup, licensedCleanup, restrictedRootCleanup] = await Promise.allSettled([
          this.deps.dataDeliveryExecutor?.release(jobId),
          mounts && this.deps.licensedMaterialResolver
            ? this.deps.licensedMaterialResolver.release(mounts)
            : Promise.resolve(),
          this.restrictedWorkRoots.has(jobId)
            ? this.removeRestrictedWorkRoot(jobId)
            : Promise.resolve(),
        ]);
        if (dataCleanup.status === "rejected") {
          this.logger.error(
            { err: dataCleanup.reason, jobId },
            "Failed to release Data Market delivery paths",
          );
        }
        if (licensedCleanup.status === "fulfilled") {
          if (mounts) {
            this.licensedMaterialMounts.delete(jobId);
          }
        }
        if (licensedCleanup.status === "rejected") {
          this.logger.error(
            { err: licensedCleanup.reason, jobId },
            "Failed to release licensed material mounts",
          );
        }
        if (restrictedRootCleanup.status === "fulfilled") {
          this.restrictedWorkRoots.delete(jobId);
        } else {
          this.logger.error(
            { err: restrictedRootCleanup.reason, jobId },
            "Failed to remove restricted execution work root",
          );
        }
        if (
          dataCleanup.status === "fulfilled" &&
          licensedCleanup.status === "fulfilled" &&
          restrictedRootCleanup.status === "fulfilled"
        ) {
          try {
            await this.activeRemoteJobs?.markFinished(jobId);
            await this.cleanupIntents?.clear(jobId);
          } catch (err) {
            this.logger.error({ err, jobId }, "Failed to clear durable job cleanup state");
          }
        } else {
          this.logger.warn(
            { jobId },
            "Retaining active job cleanup metadata for retry after restart",
          );
        }
      },
      onTransition: (report) => this.onJobTransition(report),
      validateSandboxOutputs: async (sandbox, schedulerJobId) => {
        if (sandbox.runtimeKind === "OCI") {
          if (!deps.adapter.stageSandboxOutputs) {
            throw new Error("Kubernetes Sandbox managed PVC collector is unavailable");
          }
          await deps.adapter.stageSandboxOutputs(sandbox, schedulerJobId);
        }
        const facts = await validateSandboxOutputs(sandbox);
        return Object.fromEntries(
          facts.map((fact) => [`$sandbox-artifact:${fact.descriptor}`, JSON.stringify(fact)]),
        );
      },
      logger: this.logger,
    });
  }

  /**
   * Shared status-update handler for every job the {@link ExecutorPool} runs.
   * Marks the inbound dispatch acked on the FIRST status update of any kind
   * (the {@link ackedDispatches} Set keeps later transitions cheap), then
   * routes the report onto the outbound queue / persistent spillover.
   */
  private async onJobTransition(report: JobStatusReport): Promise<void> {
    const dispatchId = this.dispatchIdsByJob.get(report.jobId) ?? report.jobId;
    await this.enqueueStatusUpdate(report);
    if (this.inboundAcks && !this.ackedDispatches.has(dispatchId)) {
      try {
        await this.inboundAcks.markAcked(dispatchId);
        this.ackedDispatches.add(dispatchId);
      } catch (err) {
        this.logger.error({ err, dispatchId }, "Failed to mark inbound dispatch acked");
      }
    }
    if (
      (report.status === "failed" || report.status === "cancelled") &&
      this.managedWorkRootsAwaitingServerRelease.has(report.jobId)
    ) {
      await this.releaseImplicitJobWorkRoot(report.jobId).catch((err) => {
        this.logger.error({ err, jobId: report.jobId }, "Failed to release managed Job work root");
      });
    }
  }

  // ---------------------------------------------------------------------------
  // SSH outbound enqueue. Mirrors the policy-ack path: live
  // delivery only (a half-typed shell on a dropped connection is not worth
  // replaying after reconnect). The persistent queue is intentionally NOT
  // used here because the Server gateway re-issues a fresh SshOpen on every
  // new WebSocket session anyway.
  // ---------------------------------------------------------------------------

  private enqueueSshOutgoing(msg: SshOutgoingMessage): void {
    if (!this.connected) {
      this.logger.warn(
        { kind: msg.kind, sessionId: msg.sessionId },
        "SSH outbound dropped: stream offline",
      );
      return;
    }
    if (msg.kind === "sshOutput") {
      this.outboundQueue.push({
        kind: "sshOutput",
        sessionId: msg.sessionId,
        data: msg.data ?? new Uint8Array(0),
      });
    } else {
      this.outboundQueue.push({
        kind: "sshClosed",
        sessionId: msg.sessionId,
        reason: msg.reason ?? "",
        exitCode: msg.exitCode,
      });
    }
    this.signalOutbound();
  }

  /**
   * Replace the cached installed-software list. Called by the bootstrap
   * after a successful install/uninstall so the next Heartbeat carries
   * the fresh ledger to the Server. Cheap; immutable copy.
   */
  setInstalledSoftware(specs: InstalledSpec[]): void {
    this.installedSoftware = [...specs];
    this.installedSoftwareKnown = true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.recoverOrphanedCleanupIntents();
    await this.recoverActiveRemoteJobs();
    while (this.running) {
      const attempt = Promise.withResolvers<void>();
      this.streamAttemptCompletion = attempt.promise;
      try {
        await this.runOnce();
      } catch (err) {
        if (this.running) {
          this.logger.error({ err }, "Stream error — will reconnect");
        }
      } finally {
        attempt.resolve();
      }
      if (this.running) {
        // The Server stream just dropped; the Server has freed its side of any SSH
        // sessions, so our ssh2 channels are now orphaned. Tear them down before
        // reconnecting — otherwise they leak on the cluster login node until the
        // node's own timeout (the agent-side mirror of the Server's orphan cleanup).
        this.sshHandler?.shutdown("server stream lost");
        this.logger.info({ backoffMs: this.reconnectBackoffMs }, "Reconnecting after backoff");
        await this.waitForReconnectBackoff();
      }
    }
    await this.softwareOperationShutdown;
  }

  stop(): Promise<void> {
    if (this.softwareOperationShutdown) return this.softwareOperationShutdown;
    this.running = false;
    this.lifecycleController.abort(new Error("agent shutdown"));
    this.currentStreamController?.abort(new Error("agent shutdown"));
    this.stopHeartbeatTimer();
    this.clearHeartbeatAckDeadlines();
    this.clearJobStatusAckDeadlines();
    this.clearQueueValidationShadowRejectionAckDeadlines();
    this.heartbeatPreparationAttempt = undefined;
    this.pool.stopAll(); // stop polling WITHOUT killing cluster jobs
    this.sshHandler?.shutdown("agent shutdown"); // tear down live ssh2 sessions
    for (const controller of this.activeFileTransfers.values()) {
      controller.abort("agent shutdown");
    }
    this.activeFileTransfers.clear();
    this.signalOutbound(); // wake the generator so it can exit
    this.softwareOperationShutdown = this.drainSoftwareOperations();
    return this.softwareOperationShutdown;
  }

  private async drainSoftwareOperations(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = async () => {
      // The final disconnect must register its spills before an empty queue is considered drained.
      await this.streamAttemptCompletion;
      let pending: Promise<void>;
      do {
        pending = this.softwareOperationQueue;
        await Promise.all([
          pending,
          ...this.pendingSoftwareResultSpills,
          ...this.pendingSpackPreparations,
          ...this.pendingSpackLoadCleanups,
        ]);
      } while (
        pending !== this.softwareOperationQueue ||
        this.pendingSoftwareResultSpills.size > 0 ||
        this.pendingSpackPreparations.size > 0 ||
        this.pendingSpackLoadCleanups.size > 0
      );
    };
    try {
      await Promise.race([
        drained(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(
              "Software operation shutdown wait expired; cleanup may still be pending",
            );
            resolve();
          }, this.deps.softwareOperationShutdownTimeoutMs ?? 5_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private waitForReconnectBackoff(): Promise<void> {
    const signal = this.lifecycleController.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.sleep(this.reconnectBackoffMs).then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async recoverActiveRemoteJobs(): Promise<void> {
    if (!this.activeRemoteJobs) return;
    try {
      const active = await this.activeRemoteJobs.listActive();
      const revokedJobIds = new Set(
        ((await this.cleanupIntents?.list()) ?? [])
          .filter((intent) => intent.revoked)
          .map((intent) => intent.jobId),
      );
      for (const job of active) {
        if (
          revokedJobIds.has(job.jobId) ||
          ((await this.revocationTombstones?.revokedEpoch(job.jobId)) ?? 0) > 0
        ) {
          this.logger.warn({ jobId: job.jobId }, "Skipping revoked job recovery");
          continue;
        }
        const mounts =
          job.spec.licensedMaterialCleanup ??
          protectedMountsFromExpectedOutputs(job.expectedOutputs);
        if (mounts.length > 0) this.licensedMaterialMounts.set(job.jobId, mounts);
        const spec = job.spec;
        if (spec.restrictedNoEgress) this.restrictedWorkRoots.add(job.jobId);
        await this.deps.dataDeliveryExecutor?.recover(
          job.jobId,
          (spec.dataDeliveryCleanup ?? []).map((delivery) => ({
            ...delivery,
            protectedPath: true,
          })),
        );
        await this.pool.resume(spec, job.schedulerJobId, {
          expectedOutputs: job.expectedOutputs,
        });
      }
      if (active.length > 0) {
        this.logger.info({ count: active.length }, "Recovered active remote jobs");
      }
    } catch (err) {
      this.logger.error({ err }, "Failed to recover active remote jobs");
    }
  }

  private async recoverOrphanedCleanupIntents(): Promise<void> {
    if (!this.cleanupIntents) return;
    try {
      const [intents, active] = await Promise.all([
        this.cleanupIntents.list(),
        this.activeRemoteJobs?.listActive() ?? Promise.resolve([]),
      ]);
      const activeJobIds = new Set(active.map((job) => job.jobId));
      for (const intent of intents) {
        if (activeJobIds.has(intent.jobId) && !intent.revoked) continue;
        try {
          const find = this.deps.adapter.findByKuintessenceJobId;
          if (!find) {
            throw new Error("scheduler adapter cannot reconcile Kuintessence UUID metadata");
          }
          const lookup = await find.call(this.deps.adapter, {
            jobId: intent.jobId,
            schedulerName: intent.schedulerSubmissionTag,
            schedulerAccount: intent.schedulerAccount,
            namespace: intent.schedulerNamespace,
          });
          if (lookup.status === "indeterminate") {
            throw new Error(`scheduler UUID lookup is indeterminate: ${lookup.reason}`);
          }
          if (lookup.status === "found") {
            await this.deps.adapter.cancel(lookup.schedulerJobId);
          }
          const cleanupResults = await Promise.allSettled([
            (async () => {
              if (intent.dataDeliveries.length === 0) return;
              const executor = this.deps.dataDeliveryExecutor;
              if (!executor) throw new Error("Data Market cleanup executor is unavailable");
              await executor.recover(
                intent.jobId,
                intent.dataDeliveries.map((delivery) => ({ ...delivery, protectedPath: true })),
              );
              await executor.release(intent.jobId);
            })(),
            (async () => {
              if (intent.licensedMounts.length === 0) return;
              const resolver = this.deps.licensedMaterialResolver;
              if (!resolver) throw new Error("Licensed material cleanup resolver is unavailable");
              await resolver.release(intent.licensedMounts);
            })(),
            intent.restrictedWorkRoot
              ? this.removeRestrictedWorkRoot(intent.jobId)
              : Promise.resolve(),
          ]);
          const failures = cleanupResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "Orphaned job cleanup failed");
          }
          await this.activeRemoteJobs?.markFinished(intent.jobId);
          await this.cleanupIntents.clear(intent.jobId);
        } catch (err) {
          this.logger.error(
            { err, jobId: intent.jobId },
            "Failed to recover orphaned job cleanup intent; retaining for retry",
          );
        }
      }
    } catch (err) {
      this.logger.error({ err }, "Failed to load durable job cleanup intents");
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound queue helpers
  // ---------------------------------------------------------------------------

  /**
   * Push a job status report onto the outbound queue.
   *
   * When the stream is currently connected, the report is appended to the
   * in-memory queue and the outbound generator is woken so it goes out on
   * the wire ASAP. When the stream is offline, the report is persisted
   * into the SQLite-backed `OutboundQueue` (if configured) so it can be
   * replayed on the next reconnect.
   */
  async enqueueStatusUpdate(report: JobStatusReport): Promise<void> {
    const terminal =
      report.status === "completed" || report.status === "failed" || report.status === "cancelled";
    if (terminal && this.persistentQueue) {
      const durable = await this.persistentQueue.enqueueJobStatus(report);
      if (this.connected) {
        this.outboundQueue.push({
          kind: "jobStatus",
          report,
          eventId: durable.item.kind === "jobStatus" ? durable.item.eventId : undefined,
          durablyPersisted: true,
        });
        this.signalOutbound();
      }
      return;
    }
    if (this.connected) {
      this.outboundQueue.push({ kind: "jobStatus", report });
      this.signalOutbound();
    } else if (this.persistentQueue) {
      await this.persistentQueue.enqueueJobStatus(report);
    } else {
      this.logger.warn(
        { jobId: report.jobId, status: report.status },
        "Status update dropped: stream offline and no persistent queue configured",
      );
    }
  }

  private async enqueueQueueValidationShadowRejection(
    failureCode: QueueFailureCode,
  ): Promise<void> {
    if (this.persistentQueue) {
      const eventId = crypto.randomUUID();
      let durable: Awaited<ReturnType<OutboundQueue["enqueueQueueValidationShadowRejection"]>>;
      try {
        durable = await this.persistentQueue.enqueueQueueValidationShadowRejection(
          failureCode,
          eventId,
        );
      } catch (err) {
        this.pendingQueueValidationShadowRejectionEnqueues.set(eventId, failureCode);
        this.markQueueValidationShadowOutboxUnavailable("enqueue", err);
        throw err;
      }
      if (this.pendingQueueValidationShadowRejectionEnqueues.size === 0) {
        this.markQueueValidationShadowOutboxOperationRecovered("enqueue");
      }
      if (this.connected && durable.item.kind === "queueValidationShadowRejection") {
        this.outboundQueue.push({ ...durable.item, durablyPersisted: true });
        this.signalOutbound();
      }
      return;
    }
    if (this.connected) {
      this.outboundQueue.push({
        kind: "queueValidationShadowRejection",
        failureCode,
        eventId: crypto.randomUUID(),
      });
      this.signalOutbound();
      return;
    }
    this.logger.warn(
      { failureCode },
      "Queue validation shadow rejection dropped without a persistent outbound queue",
    );
  }

  private markQueueValidationShadowOutboxUnavailable(
    operation: QueueValidationShadowOutboxFailureOperation,
    err?: unknown,
  ): void {
    const newFailure = !this.queueValidationShadowOutboxFailures.has(operation);
    this.queueValidationShadowOutboxFailures.add(operation);
    this.queueValidationShadowOutboxUnavailable = true;
    if (newFailure) this.queueValidationShadowOutboxFailureGeneration += 1;
    this.queueValidationShadowOutboxRecoveryHeartbeat = undefined;
    if (newFailure) {
      this.logger.error(
        { err, operation },
        "Queue validation shadow outbox is unavailable; queue inventory readiness withheld",
      );
    }
    this.heartbeatFollowUpRequested = true;
    if (this.connected) this.flushHeartbeatFollowUp();
  }

  private markQueueValidationShadowOutboxOperationRecovered(
    operation: QueueValidationShadowOutboxFailureOperation,
  ): void {
    if (!this.queueValidationShadowOutboxFailures.delete(operation)) return;
    this.queueValidationShadowOutboxRecoveryHeartbeat = undefined;
    this.logger.info({ operation }, "Queue validation shadow outbox operation recovered");
    this.heartbeatFollowUpRequested = true;
    if (this.connected) this.flushHeartbeatFollowUp();
  }

  private async acknowledgePersistedQueueValidationShadowRejection(
    eventId: string,
  ): Promise<boolean | undefined> {
    if (!this.persistentQueue) return undefined;
    try {
      const deleted = await this.persistentQueue.acknowledgeQueueValidationShadowRejection(eventId);
      this.pendingQueueValidationShadowRejectionDeletes.delete(eventId);
      if (this.pendingQueueValidationShadowRejectionDeletes.size === 0) {
        this.markQueueValidationShadowOutboxOperationRecovered("acknowledge");
      }
      return deleted;
    } catch (err) {
      this.pendingQueueValidationShadowRejectionDeletes.add(eventId);
      this.markQueueValidationShadowOutboxUnavailable("acknowledge", err);
      return undefined;
    }
  }

  private async retryPendingQueueValidationShadowRejectionEnqueues(): Promise<void> {
    if (!this.persistentQueue || this.pendingQueueValidationShadowRejectionEnqueues.size === 0) {
      return;
    }
    for (const [eventId, failureCode] of this.pendingQueueValidationShadowRejectionEnqueues) {
      try {
        const durable = await this.persistentQueue.enqueueQueueValidationShadowRejection(
          failureCode,
          eventId,
        );
        this.pendingQueueValidationShadowRejectionEnqueues.delete(eventId);
        if (this.connected && durable.item.kind === "queueValidationShadowRejection") {
          this.outboundQueue.push({ ...durable.item, durablyPersisted: true });
          this.signalOutbound();
        }
      } catch (err) {
        this.markQueueValidationShadowOutboxUnavailable("enqueue", err);
      }
    }
    if (this.pendingQueueValidationShadowRejectionEnqueues.size === 0) {
      this.markQueueValidationShadowOutboxOperationRecovered("enqueue");
    }
  }

  private async retryPendingQueueValidationShadowRejectionDeletes(): Promise<void> {
    if (!this.persistentQueue || this.pendingQueueValidationShadowRejectionDeletes.size === 0) {
      return;
    }
    for (const eventId of this.pendingQueueValidationShadowRejectionDeletes) {
      try {
        await this.persistentQueue.acknowledgeQueueValidationShadowRejection(eventId);
        this.pendingQueueValidationShadowRejectionDeletes.delete(eventId);
      } catch (err) {
        this.markQueueValidationShadowOutboxUnavailable("acknowledge", err);
      }
    }
    if (this.pendingQueueValidationShadowRejectionDeletes.size === 0) {
      this.markQueueValidationShadowOutboxOperationRecovered("acknowledge");
    }
  }

  private enqueueHeartbeat(): void {
    if (this.connected) {
      this.heartbeatFollowUpRequested = true;
      this.flushHeartbeatFollowUp();
    } else if (this.persistentQueue) {
      const m = readMetrics();
      this.persistentQueue
        .enqueueHeartbeat({
          cpuUsagePercent: m.cpuUsagePercent,
          memoryUsedMb: m.memoryUsedMb,
          memoryTotalMb: m.memoryTotalMb,
          runningJobs: this.pool.listActive().length,
          queuedJobs: 0, // pendingCount unknowable here without async; replay-time field is informational
        })
        .catch((err) => {
          this.logger.error({ err }, "Failed to persist heartbeat");
        });
    }
  }

  private flushHeartbeatFollowUp(): void {
    if (!this.connected || !this.heartbeatFollowUpRequested) return;
    if (
      this.heartbeatPreparationAttempt === this.currentStreamController ||
      (this.heartbeatAckSupported && this.pendingHeartbeatAcks.size > 0) ||
      (!this.heartbeatAckSupported && this.outboundQueue.some((item) => item.kind === "heartbeat"))
    ) {
      return;
    }
    const attempt = this.currentStreamController;
    if (!attempt || attempt.signal.aborted) return;
    this.heartbeatFollowUpRequested = false;
    this.heartbeatPreparationAttempt = attempt;
    void this.prepareLiveHeartbeat()
      .then((heartbeat) => {
        if (this.heartbeatPreparationAttempt === attempt) {
          this.heartbeatPreparationAttempt = undefined;
        }
        if (
          !this.running ||
          !this.connected ||
          this.currentStreamController !== attempt ||
          attempt.signal.aborted
        ) {
          return;
        }
        if (
          heartbeat.recoveryFailureGeneration !== undefined &&
          heartbeat.recoveryFailureGeneration ===
            this.queueValidationShadowOutboxFailureGeneration &&
          this.queueValidationShadowOutboxFailures.size === 0
        ) {
          this.queueValidationShadowOutboxRecoveryHeartbeat = {
            sequence: heartbeat.sequence,
            failureGeneration: heartbeat.recoveryFailureGeneration,
          };
        }
        this.beginHeartbeatAckDeadline(heartbeat.sequence);
        this.outboundQueue.push(heartbeat);
        this.signalOutbound();
      })
      .catch((err) => {
        if (this.heartbeatPreparationAttempt === attempt) {
          this.heartbeatPreparationAttempt = undefined;
        }
        if (this.currentStreamController === attempt && !attempt.signal.aborted) {
          this.heartbeatFollowUpRequested = true;
          this.logger.error({ err }, "Failed to prepare heartbeat");
        }
      });
  }

  private signalOutbound(): void {
    const resolvers = [...this.outboundResolvers];
    this.outboundResolvers.clear();
    for (const resolve of resolvers) resolve();
  }

  private waitForOutbound(signal: AbortSignal): Promise<void> {
    if (this.outboundQueue.length > 0) return Promise.resolve();
    if (signal.aborted) return Promise.reject(this.abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.outboundResolvers.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(this.abortReason(signal));
      };
      this.outboundResolvers.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Server stream aborted");
  }

  private isCurrentStreamAttempt(attempt: AbortController): boolean {
    return this.currentStreamController === attempt && !attempt.signal.aborted;
  }

  // ---------------------------------------------------------------------------
  // Outbound async generator
  // ---------------------------------------------------------------------------

  private async *replayPersistentQueue(
    attempt: AbortController,
  ): AsyncGenerator<AgentMessage, boolean> {
    if (!this.persistentQueue) return true;
    const signal = attempt.signal;
    let pending: Awaited<ReturnType<OutboundQueue["loadForReplay"]>>;
    try {
      pending = await this.persistentQueue.loadForReplay();
      if (!this.isCurrentStreamAttempt(attempt)) return false;
      this.markQueueValidationShadowOutboxOperationRecovered("loadForReplay");
    } catch (err) {
      if (!this.isCurrentStreamAttempt(attempt)) return false;
      this.markQueueValidationShadowOutboxUnavailable("loadForReplay", err);
      return false;
    }

    for (const replay of pending) {
      if (!this.isCurrentStreamAttempt(attempt)) return false;
      const heartbeatSequence =
        replay.item.kind === "heartbeat" ? this.nextHeartbeatSequence() : 0n;
      const message = this.itemToProto(replay.item, heartbeatSequence);
      if (replay.item.kind === "jobStatus") {
        this.beginJobStatusAckDeadline(replay.item.eventId);
      } else if (replay.item.kind === "queueValidationShadowRejection") {
        this.beginQueueValidationShadowRejectionAckDeadline(replay.item.eventId);
      } else if (replay.item.kind === "heartbeat") {
        this.beginHeartbeatAckDeadline(heartbeatSequence);
      }
      yield message;
      if (signal.aborted) return false;
      if (replay.item.kind === "jobStatus" && this.jobStatusAckSupported) continue;
      if (replay.item.kind === "queueValidationShadowRejection") {
        if (this.queueValidationShadowRejectionAckSupported) continue;
        await this.acknowledgePersistedQueueValidationShadowRejection(replay.item.eventId);
        continue;
      }
      await replay.acknowledge();
    }
    return true;
  }

  private async *generateOutbound(
    registration: Promise<boolean>,
    attempt: AbortController,
  ): AsyncGenerator<AgentMessage> {
    const signal = attempt.signal;
    // First message: register
    yield create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: this.deps.agentId,
          siteName: this.deps.siteName,
          schedulerType: schedulerTypeToProto(this.deps.adapter.type),
          schedulerVersion: this.deps.adapter.version,
          sandboxCapability: this.sandboxCapabilityToProto(),
          restrictedDataIsolation: this.hasTrustedRestrictedExecutionProfile(),
          computeHealthV1: this.computeHealthV1Capable,
          queueInventoryV1: this.queueInventoryV1Capable,
          spackMaterialDeliveryV1: this.spackManager?.requireServerMaterials === true,
        }),
      },
    });

    const accepted = await registration;
    if (!accepted || signal.aborted || !this.running) return;

    // ---------------------------------------------------------------------
    // Replay any inbound dispatches we received but never acked.
    //
    // This MUST run before drainOnReconnect so the synthesized status
    // reports land in the same connection as any other queued reports.
    // We synthesize one report per pending dispatch:
    //
    //   - Live Spack preparations retain their pending receipt until their real first report.
    //   - If a runner is still alive locally for that jobId, replay
    //     `running` (the runner will continue emitting real updates,
    //     idempotent on the Server side).
    //   - Otherwise, replay `failed` with a clear reason — this is the
    //     "agent restarted before ack" path. Server job-service idempotency
    //     ensures we don't accidentally clobber a richer status that
    //     already landed.
    //
    // After yielding, mark the row acked so a follow-on reconnect doesn't
    // replay it again.
    // ---------------------------------------------------------------------
    if (this.inboundAcks) {
      try {
        const pending = await this.inboundAcks.pendingInbound();
        for (const row of pending) {
          if (signal.aborted) return;
          if (this.preparingSpackDispatches.has(row.dispatchId)) continue;
          const haveLocalRunner = this.pool.get(row.jobId) !== undefined;
          const replayReport: JobStatusReport = haveLocalRunner
            ? { jobId: row.jobId, status: "running" }
            : {
                jobId: row.jobId,
                status: "failed",
                message: "agent restarted before ack",
              };
          if (this.persistentQueue) {
            await this.persistentQueue.enqueueJobStatus(replayReport);
            await this.inboundAcks.markAcked(row.dispatchId);
            this.ackedDispatches.add(row.dispatchId);
            continue;
          }

          yield this.reportToProto(replayReport);
          if (signal.aborted) return;
          if (!this.jobStatusAckSupported) {
            await this.inboundAcks.markAcked(row.dispatchId);
            this.ackedDispatches.add(row.dispatchId);
          }
        }
      } catch (err) {
        this.logger.error({ err }, "Failed to replay pending inbound dispatch acks");
      }
    }

    let persistentReplayPending = false;
    if (this.persistentQueue) {
      persistentReplayPending = !(yield* this.replayPersistentQueue(attempt));
    }

    try {
      while (this.running && !signal.aborted) {
        await this.waitForOutbound(signal);
        if (!this.running || signal.aborted) break;

        while (this.outboundQueue.length > 0) {
          const item = this.outboundQueue.shift();
          if (!item) continue;

          if (item.kind === "heartbeat") {
            yield item.message;
            // Repeated proto fields cannot distinguish unknown from empty.
            // Retry authoritative empty snapshots on each live heartbeat,
            // including after reconnect; use current state, not a stale queue item.
            if (
              !signal.aborted &&
              this.installedSoftwareKnown &&
              this.installedSoftware.length === 0
            ) {
              yield create(AgentMessageSchema, {
                payload: {
                  case: "installedSoftwareReport",
                  value: create(InstalledSoftwareReportSchema, {
                    agentId: this.deps.agentId,
                    installed: [],
                    reportedAt: BigInt(Date.now()),
                  }),
                },
              });
            }
            if (!this.heartbeatAckSupported) this.flushHeartbeatFollowUp();
          } else if (item.kind === "jobStatus") {
            const message = this.reportToProto(item.report, item.eventId);
            if (item.eventId) this.beginJobStatusAckDeadline(item.eventId);
            yield message;
            if (item.eventId && !this.jobStatusAckSupported) {
              await this.persistentQueue?.acknowledgeJobStatus(item.eventId);
            }
          } else if (item.kind === "queueValidationShadowRejection") {
            this.beginQueueValidationShadowRejectionAckDeadline(item.eventId);
            yield this.queueValidationShadowRejectionToProto(item.failureCode, item.eventId);
            if (!this.queueValidationShadowRejectionAckSupported) {
              await this.acknowledgePersistedQueueValidationShadowRejection(item.eventId);
            }
          } else if (item.kind === "softwarePolicyAck") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "softwarePolicyAck",
                value: create(SoftwarePolicyAckSchema, {
                  policyVersion: item.policyVersion,
                  applied: item.applied,
                  error: item.error,
                }),
              },
            });
          } else if (item.kind === "softwareOperationResult") {
            yield this.softwareOperationResultToProto(item);
          } else if (item.kind === "sshOutput") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "sshOutput",
                value: create(SshOutputSchema, {
                  sessionId: item.sessionId,
                  data: item.data,
                }),
              },
            });
          } else if (item.kind === "sshClosed") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "sshClosed",
                value: create(SshClosedSchema, {
                  sessionId: item.sessionId,
                  reason: item.reason,
                  exitCode: item.exitCode,
                }),
              },
            });
          } else if (item.kind === "shellExecResponse") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "shellExecResponse",
                value: create(ShellExecResponseSchema, {
                  requestId: item.requestId,
                  stdout: item.stdout,
                  stderr: item.stderr,
                  exitCode: item.exitCode,
                  error: item.error,
                }),
              },
            });
          } else if (item.kind === "jobLogsResponse") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "jobLogsResponse",
                value: create(JobLogsResponseSchema, {
                  requestId: item.requestId,
                  text: item.text,
                  error: item.error,
                  unavailable: item.unavailable,
                }),
              },
            });
          } else if (item.kind === "partUrlsRequest") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "partUrlsRequest",
                value: create(PartUrlsRequestSchema, {
                  requestId: item.requestId,
                  partNumbers: item.partNumbers,
                }),
              },
            });
          } else if (item.kind === "sandboxArtifactReleaseAck") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "sandboxArtifactReleaseAck",
                value: create(SandboxArtifactReleaseAckSchema, {
                  requestId: item.requestId,
                  releasedReplicaIds: item.releasedReplicaIds,
                  failures: item.failures,
                }),
              },
            });
          } else if (item.kind === "dataScanResult") {
            yield this.dataScanResultToProto(item);
          } else if (item.kind === "dataDeliveryRevokeAck") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "dataDeliveryRevokeAck",
                value: create(DataDeliveryRevokeAckSchema, item),
              },
            });
          } else if (item.kind === "cancelJobAck") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "cancelJobAck",
                value: create(CancelJobAckSchema, {
                  jobId: item.jobId,
                  revokedEpoch: BigInt(item.revokedEpoch),
                }),
              },
            });
          } else if (item.kind === "jobWorkRootReleaseAck") {
            yield create(AgentMessageSchema, {
              payload: {
                case: "jobWorkRootReleaseAck",
                value: create(JobWorkRootReleaseAckSchema, { jobId: item.jobId }),
              },
            });
          } else {
            // fileTransferProgress
            yield create(AgentMessageSchema, {
              payload: {
                case: "fileTransferProgress",
                value: create(FileTransferProgressSchema, {
                  requestId: item.requestId,
                  copiedBytes: BigInt(item.copiedBytes),
                  state: item.state,
                  error: item.error,
                  sha256: item.sha256,
                  parts: item.parts.map((p) =>
                    create(UploadedPartSchema, { partNumber: p.partNumber, etag: p.etag }),
                  ),
                }),
              },
            });
          }
        }
        if (persistentReplayPending && !signal.aborted) {
          persistentReplayPending = !(yield* this.replayPersistentQueue(attempt));
        }
      }
    } finally {
      this.stopHeartbeatTimer(attempt);
    }
  }

  // ---------------------------------------------------------------------------
  // Proto encoders (shared between live and replay paths)
  // ---------------------------------------------------------------------------

  private reportToProto(report: JobStatusReport, eventId = ""): AgentMessage {
    return jobStatusReportToProto(report, eventId);
  }

  private snapshotToProto(s: HeartbeatSnapshot, sequence: bigint): AgentMessage {
    return create(AgentMessageSchema, {
      payload: {
        case: "heartbeat",
        value: create(HeartbeatSchema, {
          agentId: this.deps.agentId,
          cpuUsagePercent: s.cpuUsagePercent,
          memoryUsedMb: BigInt(s.memoryUsedMb),
          memoryTotalMb: BigInt(s.memoryTotalMb),
          runningJobs: s.runningJobs,
          queuedJobs: s.queuedJobs,
          sandboxCapability: this.sandboxCapabilityToProto(),
          restrictedDataIsolation: this.hasTrustedRestrictedExecutionProfile(),
          sequence,
        }),
      },
    });
  }

  private computeHealthToProto(observation: ComputeHealthObservation) {
    return create(ComputeHealthSchema, {
      state: computeHealthStateToProto(observation.state),
      observedAtUnixMs: BigInt(observation.observedAtUnixMs),
      nodeCount: observation.nodeCount,
      operationalNodeCount: observation.operationalNodeCount,
      reason: observation.reason ?? "",
    });
  }

  private queueInventoryToProto(inventory: SchedulerQueueInventory) {
    return create(QueueInventorySchema, {
      status: queueInventoryStatusToProto(inventory.status),
      defaultQueueName: inventory.defaultQueueName ?? "",
      reason: inventory.reason ?? "",
      observedAtUnixMs: BigInt(inventory.observedAt.getTime()),
      queues: inventory.queues.map((queue) =>
        create(SchedulerQueueFactSchema, {
          queueName: queue.queueName,
          queueType: schedulerQueueTypeToProto(queue.queueType),
          isDefault: queue.isDefault,
          state: schedulerQueueStateToProto(queue.state),
          acceptsSubmissions: queue.acceptsSubmissions,
          ...(queue.hasComputeTargets === undefined
            ? {}
            : { hasComputeTargets: queue.hasComputeTargets }),
          observedAtUnixMs: BigInt(queue.observedAt.getTime()),
        }),
      ),
    });
  }

  private async inspectComputeHealth(): Promise<ComputeHealthObservation> {
    const inspect = this.deps.adapter.inspectComputeHealth;
    if (!inspect) return unknownComputeHealth("unsupported_scheduler");
    try {
      const observation = await inspect.call(this.deps.adapter);
      return isValidComputeHealthObservation(observation)
        ? observation
        : unknownComputeHealth("invalid_scheduler_state");
    } catch {
      return unknownComputeHealth("scheduler_command_failed");
    }
  }

  private async inspectQueues(): Promise<SchedulerQueueInventory> {
    const inspect = this.deps.adapter.inspectQueues;
    if (!inspect) return unavailableQueueInventory("unsupported_scheduler");
    try {
      const result = SchedulerQueueInventorySchema.safeParse(await inspect.call(this.deps.adapter));
      return result.success ? result.data : unavailableQueueInventory("invalid_output");
    } catch {
      return unavailableQueueInventory("command_failed");
    }
  }

  private itemToProto(item: PersistedOutboundItem, heartbeatSequence = 0n): AgentMessage {
    if (item.kind === "jobStatus") return this.reportToProto(item.report, item.eventId);
    if (item.kind === "queueValidationShadowRejection") {
      return this.queueValidationShadowRejectionToProto(item.failureCode, item.eventId);
    }
    if (item.kind === "heartbeat") return this.snapshotToProto(item.snapshot, heartbeatSequence);
    return this.softwareOperationResultToProto(item);
  }

  private queueValidationShadowRejectionToProto(
    failureCode: QueueFailureCode,
    eventId: string,
  ): AgentMessage {
    return create(AgentMessageSchema, {
      payload: {
        case: "queueValidationShadowRejection",
        value: create(QueueValidationShadowRejectionSchema, { failureCode, eventId }),
      },
    });
  }

  private async prepareLiveHeartbeat(): Promise<Extract<OutboundItem, { kind: "heartbeat" }>> {
    const m = readMetrics();
    await this.retryPendingQueueValidationShadowRejectionEnqueues();
    await this.retryPendingQueueValidationShadowRejectionDeletes();
    let queuedJobs = 0;
    let outboxProbeGeneration: number | undefined;
    if (this.persistentQueue) {
      try {
        queuedJobs = await this.persistentQueue.pendingCount();
        this.markQueueValidationShadowOutboxOperationRecovered("pendingCount");
      } catch (err) {
        this.markQueueValidationShadowOutboxUnavailable("pendingCount", err);
      }
    }
    if (
      this.queueValidationShadowOutboxUnavailable &&
      this.queueValidationShadowOutboxFailures.size === 0
    ) {
      outboxProbeGeneration = this.queueValidationShadowOutboxFailureGeneration;
    }
    const [gpus, diskUsedPercent, schedulerQueuedJobs, computeHealth, queueInventory] =
      await Promise.all([
        this.readGpuMetricsFn().catch(() => [] as GpuMetric[]),
        this.readDiskUsedPercentFn().catch(() => null),
        this.readSchedulerQueueDepthFn().catch(() => 0),
        this.computeHealthV1Supported
          ? this.inspectComputeHealth()
          : Promise.resolve<ComputeHealthObservation | undefined>(undefined),
        this.queueInventoryV1Supported
          ? this.inspectQueues()
          : Promise.resolve<SchedulerQueueInventory | undefined>(undefined),
      ]);
    const sequence = this.nextHeartbeatSequence();
    const reportOutboxUnavailable =
      queueInventory !== undefined && this.queueValidationShadowOutboxUnavailable;
    const reportedQueueInventory =
      queueInventory && reportOutboxUnavailable
        ? unavailableQueueInventory("command_failed")
        : queueInventory;
    const recoveryFailureGeneration =
      reportOutboxUnavailable &&
      outboxProbeGeneration === this.queueValidationShadowOutboxFailureGeneration &&
      this.queueValidationShadowOutboxFailures.size === 0 &&
      this.heartbeatAckSupported &&
      sequence !== 0n
        ? this.queueValidationShadowOutboxFailureGeneration
        : undefined;
    return {
      kind: "heartbeat",
      sequence,
      recoveryFailureGeneration,
      message: create(AgentMessageSchema, {
        payload: {
          case: "heartbeat",
          value: create(HeartbeatSchema, {
            agentId: this.deps.agentId,
            cpuUsagePercent: m.cpuUsagePercent,
            memoryUsedMb: BigInt(m.memoryUsedMb),
            memoryTotalMb: BigInt(m.memoryTotalMb),
            runningJobs: this.pool.listActive().length,
            queuedJobs,
            installedSoftware: this.installedSoftware.map((s) =>
              create(InstalledSpecSchema, {
                name: s.name,
                version: s.version,
                hash: s.hash,
                compiler: s.compiler ?? "",
                arch: s.arch ?? "",
                spec: s.spec,
              }),
            ),
            gpus: gpus.map((g) =>
              create(GpuMetricSchema, {
                index: g.index,
                model: g.model,
                memUsedMb: BigInt(g.memUsedMb),
                memTotalMb: BigInt(g.memTotalMb),
                utilPercent: g.utilPercent,
              }),
            ),
            diskUsedPercent: diskUsedPercent ?? 0,
            schedulerQueuedJobs,
            sandboxCapability: this.sandboxCapabilityToProto(),
            restrictedDataIsolation: this.hasTrustedRestrictedExecutionProfile(),
            sequence,
            ...(computeHealth ? { computeHealth: this.computeHealthToProto(computeHealth) } : {}),
            ...(reportedQueueInventory
              ? { queueInventory: this.queueInventoryToProto(reportedQueueInventory) }
              : {}),
          }),
        },
      }),
    };
  }

  private sandboxCapabilityToProto() {
    const capability = this.deps.sandboxCapability;
    if (!capability) return undefined;
    const now = Date.now();
    const expiredRuntimeAttestation = capability.runtimeCache.some(
      (runtime) =>
        runtime.runtimeAttestationId !== undefined &&
        (runtime.expiresAtUnixMs === undefined || runtime.expiresAtUnixMs <= now),
    );
    const runtimeCache = capability.runtimeCache.filter(
      (runtime) =>
        runtime.runtimeAttestationId === undefined ||
        (runtime.expiresAtUnixMs !== undefined && runtime.expiresAtUnixMs > now),
    );
    const attestationExpiredWithoutReplacement =
      expiredRuntimeAttestation &&
      !runtimeCache.some((runtime) => runtime.runtimeAttestationId !== undefined);
    const missingRequirements = [
      ...capability.missingRequirements,
      ...(attestationExpiredWithoutReplacement ? ["runtime-attestation-expired"] : []),
    ];
    return create(SandboxCapabilitySchema, {
      enabled: capability.enabled,
      rootMode: capability.rootMode,
      networkIsolation: capability.networkIsolation,
      cgroups: capability.cgroups,
      seccomp: capability.seccomp,
      sifSignatureVerification: capability.sifSignatureVerification,
      ecl: capability.ecl,
      replayProtection: capability.replayProtection,
      runtimeCache: runtimeCache.map((runtime) =>
        create(SandboxRuntimeCacheEntrySchema, {
          digest: runtime.digest,
          kind: runtime.kind === "OCI" ? SandboxRuntimeKind.OCI : SandboxRuntimeKind.SIF,
          signatureVerified: runtime.signatureVerified,
          runtimeAttestationId: runtime.runtimeAttestationId ?? "",
          attestedNodes: runtime.attestedNodes ?? [],
          expiresAtUnixMs: BigInt(runtime.expiresAtUnixMs ?? 0),
        }),
      ),
      readiness: attestationExpiredWithoutReplacement ? "critical" : capability.readiness,
      missingRequirements,
      managedRoot: capability.managedRoot,
      executionMode: capability.executionMode === "Disabled" ? "" : capability.executionMode,
      ...(capability.selfAccount
        ? { selfAccount: create(SandboxSelfAccountSchema, capability.selfAccount) }
        : {}),
      ...(this.deps.restrictedExecutionProfile?.executionProfile
        ? {
            restrictedExecutionProfile: this.deps.restrictedExecutionProfile.executionProfile,
          }
        : {}),
    });
  }

  private hasTrustedRestrictedExecutionProfile(): boolean {
    return this.deps.restrictedExecutionProfile?.ready === true;
  }

  private softwareOperationResultToProto(
    item: Omit<Extract<OutboundItem, { kind: "softwareOperationResult" }>, "kind">,
  ): AgentMessage {
    return create(AgentMessageSchema, {
      payload: {
        case: "softwareOperationResult",
        value: create(SoftwareOperationResultSchema, {
          operationId: item.operationId,
          action: item.action,
          status: item.status,
          spec: item.spec,
          stdout: item.stdout ?? "",
          stderr: item.stderr ?? "",
          exitCode: item.exitCode ?? 0,
          error: item.error ?? "",
          installed: (item.installed ?? []).map((s) =>
            create(InstalledSpecSchema, {
              name: s.name,
              version: s.version,
              hash: s.hash,
              compiler: s.compiler ?? "",
              arch: s.arch ?? "",
              spec: s.spec,
            }),
          ),
        }),
      },
    });
  }

  private dataScanResultToProto(
    item: Extract<OutboundItem, { kind: "dataScanResult" }>,
  ): AgentMessage {
    const result = item.result;
    return create(AgentMessageSchema, {
      payload: {
        case: "dataScanResult",
        value: create(DataScanResultSchema, {
          requestId: item.request.requestId,
          importId: item.request.importId,
          assetId: item.request.assetId,
          versionId: item.request.versionId,
          managedRootId: item.request.managedRootId,
          providerOrgId: item.request.providerOrgId,
          relativePath: isSafeRelativeDataScanPath(item.request.relativePath)
            ? item.request.relativePath
            : "",
          agentId: result?.agentId ?? this.deps.agentId,
          manifestDigest: result?.manifestDigest ?? "",
          contentSha256: result?.contentSha256 ?? "",
          totalSizeBytes: BigInt(result?.totalSizeBytes ?? 0),
          format: result?.format ?? "",
          files: (result?.files ?? []).map((file) =>
            create(DataScanFileSchema, {
              relativePath: file.path,
              sha256: file.sha256,
              sizeBytes: BigInt(file.sizeBytes),
            }),
          ),
          attestationAlgorithm: result?.attestationAlgorithm ?? "",
          attestationKeyId: result?.attestationKeyId ?? "",
          attestationSignature: result?.attestationSignature ?? "",
          scannedAtUnixMs: BigInt(result?.scannedAtUnixMs ?? 0),
          error: item.error,
        }),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Single stream iteration
  // ---------------------------------------------------------------------------

  private async runOnce(): Promise<void> {
    const controller = new AbortController();
    this.currentStreamController = controller;
    let registrationSettled = false;
    let resolveRegistration: (accepted: boolean) => void = () => {};
    const registration = new Promise<boolean>((resolve) => {
      resolveRegistration = resolve;
    });
    const settleRegistration = (accepted: boolean) => {
      if (registrationSettled) return;
      registrationSettled = true;
      resolveRegistration(accepted);
    };
    controller.signal.addEventListener("abort", () => settleRegistration(false), { once: true });
    const registrationTimer = setTimeout(() => {
      controller.abort(new Error("Server registration timed out"));
    }, this.registrationTimeoutMs);
    let reachabilityTask: Promise<void> | undefined;
    try {
      const client = this.deps.clientFactory?.() ?? this.deps.client;
      const responseStream = client.connect(this.generateOutbound(registration, controller), {
        signal: controller.signal,
      });
      const iterator = responseStream[Symbol.asyncIterator]();
      try {
        while (!controller.signal.aborted) {
          const next = await this.nextServerMessage(iterator, controller.signal);
          if (next.done) break;
          const serverMsg = next.value;
          const message = serverMsg as ServerMessage;
          const registrationRejected =
            message.payload.case === "registerResponse" && !message.payload.value.accepted;
          if (message.payload.case === "registerResponse") {
            clearTimeout(registrationTimer);
            if (message.payload.value.accepted) {
              this.connected = true;
              this.heartbeatAckSupported = message.payload.value.heartbeatAckSupported;
              this.jobStatusAckSupported = message.payload.value.jobStatusAckSupported;
              this.queueValidationShadowRejectionAckSupported =
                message.payload.value.queueValidationShadowRejectionAckSupported;
              this.computeHealthV1Supported =
                this.computeHealthV1Capable && message.payload.value.computeHealthV1Supported;
              this.queueInventoryV1Supported =
                this.queueInventoryV1Capable && message.payload.value.queueInventoryV1Supported;
              if (this.queueValidationShadowRejectionAckSupported && !this.persistentQueue) {
                this.markQueueValidationShadowOutboxUnavailable("missing");
              }
              this.startHeartbeatTimer(controller);
              if (this.queueValidationShadowOutboxUnavailable || this.heartbeatFollowUpRequested) {
                this.enqueueHeartbeat();
              }
              reachabilityTask ??= this.runReachabilityProbeLoop(controller);
            }
            settleRegistration(message.payload.value.accepted);
          }
          await this.handleServerMessage(message);
          if (registrationRejected) {
            controller.abort(new Error("Server rejected registration"));
            break;
          }
        }
      } finally {
        const close = iterator.return?.();
        if (close) {
          void Promise.resolve(close).catch((err) => {
            this.logger.debug({ err }, "Server response iterator return failed");
          });
        }
      }
    } finally {
      clearTimeout(registrationTimer);
      controller.abort(new Error("Server stream ended"));
      await reachabilityTask;
      settleRegistration(false);
      if (this.currentStreamController === controller) {
        this.currentStreamController = undefined;
      }
      if (this.heartbeatPreparationAttempt === controller) {
        this.heartbeatPreparationAttempt = undefined;
      }
      this.connected = false;
      this.stopHeartbeatTimer(controller);
      this.heartbeatAckSupported = false;
      this.jobStatusAckSupported = false;
      this.queueValidationShadowRejectionAckSupported = false;
      this.computeHealthV1Supported = false;
      this.queueInventoryV1Supported = false;
      this.clearHeartbeatAckDeadlines();
      this.queueValidationShadowOutboxRecoveryHeartbeat = undefined;
      if (this.queueValidationShadowOutboxUnavailable) {
        this.heartbeatFollowUpRequested = true;
      }
      this.clearJobStatusAckDeadlines();
      this.clearQueueValidationShadowRejectionAckDeadlines();
      // Flush any in-memory items that didn't make it across the wire into
      // the persistent queue so they survive the disconnect and can be
      // replayed on the next reconnect.
      this.spillInMemoryToPersistent();
    }
  }

  private nextServerMessage(
    iterator: AsyncIterator<unknown>,
    signal: AbortSignal,
  ): Promise<IteratorResult<unknown>> {
    if (signal.aborted) return Promise.reject(this.abortReason(signal));
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(this.abortReason(signal));
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([iterator.next(), aborted]).finally(removeAbortListener);
  }

  /**
   * Move any items still buffered in the in-memory queue into the persistent
   * SQLite queue (best-effort). Software result writes are tracked by shutdown;
   * other writes are fire-and-forget. Heartbeats are dropped because a stale
   * CPU sample is not worth replaying. Status updates are persisted.
   */
  private spillInMemoryToPersistent(): void {
    if (!this.persistentQueue) {
      this.outboundQueue = this.outboundQueue.filter(
        (item) => item.kind === "queueValidationShadowRejection",
      );
      return;
    }
    const buf = this.outboundQueue.splice(0, this.outboundQueue.length);
    for (const item of buf) {
      if (item.kind === "queueValidationShadowRejection") {
        if (item.durablyPersisted) continue;
        this.persistentQueue
          .enqueueQueueValidationShadowRejection(item.failureCode, item.eventId)
          .catch((err) => {
            this.markQueueValidationShadowOutboxUnavailable("enqueue", err);
            this.logger.error(
              { err, eventId: item.eventId },
              "Failed to spill queue validation shadow rejection",
            );
          });
      } else if (item.kind === "jobStatus") {
        if (item.durablyPersisted) continue;
        this.persistentQueue.enqueueJobStatus(item.report).catch((err) => {
          this.logger.error(
            { err, jobId: item.report.jobId },
            "Failed to spill status update to persistent queue",
          );
        });
      } else if (item.kind === "softwareOperationResult") {
        const spill = this.persistentQueue
          .enqueueSoftwareOperationResult(item)
          .catch((err) => {
            this.logger.error(
              { err, operationId: item.operationId },
              "Failed to spill software operation result to persistent queue",
            );
          })
          .finally(() => {
            this.pendingSoftwareResultSpills.delete(spill);
          });
        this.pendingSoftwareResultSpills.add(spill);
      }
    }
  }

  private async runReachabilityProbeLoop(controller: AbortController): Promise<void> {
    const probe = this.deps.reachabilityProbe;
    if (!probe) return;
    let consecutiveFailures = 0;
    while (this.running && !controller.signal.aborted) {
      await this.waitForProbeInterval(controller.signal);
      if (!this.running || controller.signal.aborted) return;
      try {
        await probe(controller.signal);
        consecutiveFailures = 0;
      } catch (err) {
        if (controller.signal.aborted || !this.running) return;
        consecutiveFailures += 1;
        this.logger.warn({ err, consecutiveFailures }, "Server reachability probe failed");
        if (consecutiveFailures >= 2) {
          controller.abort(
            err instanceof Error ? err : new Error("Server reachability probe failed"),
          );
          return;
        }
      }
    }
  }

  private nextHeartbeatSequence(): bigint {
    if (!this.heartbeatAckSupported) return 0n;
    this.heartbeatSequence += 1n;
    return this.heartbeatSequence;
  }

  private beginHeartbeatAckDeadline(sequence: bigint): void {
    if (!this.heartbeatAckSupported || sequence === 0n) return;
    const attempt = this.currentStreamController;
    const timer = setTimeout(() => {
      this.pendingHeartbeatAcks.delete(sequence);
      if (attempt && this.currentStreamController === attempt && !attempt.signal.aborted) {
        attempt.abort(new Error(`Heartbeat acknowledgement timed out for sequence ${sequence}`));
      }
    }, this.heartbeatAckTimeoutMs);
    this.pendingHeartbeatAcks.set(sequence, timer);
  }

  private startHeartbeatTimer(owner: AbortController): void {
    if (!this.isCurrentStreamAttempt(owner)) return;
    if (this.heartbeatTimer?.owner === owner) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer.handle);
    const handle = setInterval(() => {
      if (!this.isCurrentStreamAttempt(owner)) {
        this.stopHeartbeatTimer(owner);
        return;
      }
      this.enqueueHeartbeat();
    }, this.deps.heartbeatIntervalMs);
    this.heartbeatTimer = { owner, handle };
  }

  private stopHeartbeatTimer(owner?: AbortController): void {
    const timer = this.heartbeatTimer;
    if (!timer || (owner && timer.owner !== owner)) return;
    clearInterval(timer.handle);
    if (this.heartbeatTimer === timer) this.heartbeatTimer = undefined;
  }

  private acknowledgeHeartbeat(sequence: bigint): void {
    const timer = this.pendingHeartbeatAcks.get(sequence);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingHeartbeatAcks.delete(sequence);
    const recovery = this.queueValidationShadowOutboxRecoveryHeartbeat;
    if (
      recovery?.sequence === sequence &&
      recovery.failureGeneration === this.queueValidationShadowOutboxFailureGeneration &&
      this.queueValidationShadowOutboxFailures.size === 0
    ) {
      this.queueValidationShadowOutboxUnavailable = false;
      this.queueValidationShadowOutboxRecoveryHeartbeat = undefined;
      this.logger.info(
        { sequence },
        "Queue validation shadow outbox recovered after Server observed unavailable state",
      );
      this.enqueueHeartbeat();
    }
    this.flushHeartbeatFollowUp();
  }

  private clearHeartbeatAckDeadlines(): void {
    for (const timer of this.pendingHeartbeatAcks.values()) clearTimeout(timer);
    this.pendingHeartbeatAcks.clear();
  }

  private beginJobStatusAckDeadline(eventId: string): void {
    if (!this.jobStatusAckSupported || this.pendingJobStatusAcks.has(eventId)) return;
    const attempt = this.currentStreamController;
    const timer = setTimeout(() => {
      this.pendingJobStatusAcks.delete(eventId);
      if (attempt && this.currentStreamController === attempt && !attempt.signal.aborted) {
        attempt.abort(new Error(`Job status acknowledgement timed out for event ${eventId}`));
      }
    }, this.heartbeatAckTimeoutMs);
    this.pendingJobStatusAcks.set(eventId, timer);
  }

  private clearJobStatusAckDeadline(eventId: string): void {
    const timer = this.pendingJobStatusAcks.get(eventId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingJobStatusAcks.delete(eventId);
  }

  private clearJobStatusAckDeadlines(): void {
    for (const timer of this.pendingJobStatusAcks.values()) clearTimeout(timer);
    this.pendingJobStatusAcks.clear();
  }

  private beginQueueValidationShadowRejectionAckDeadline(eventId: string): void {
    if (
      !this.queueValidationShadowRejectionAckSupported ||
      this.pendingQueueValidationShadowRejectionAcks.has(eventId)
    ) {
      return;
    }
    const attempt = this.currentStreamController;
    const timer = setTimeout(() => {
      this.pendingQueueValidationShadowRejectionAcks.delete(eventId);
      if (attempt && this.currentStreamController === attempt && !attempt.signal.aborted) {
        attempt.abort(
          new Error(
            `Queue validation shadow rejection acknowledgement timed out for event ${eventId}`,
          ),
        );
      }
    }, this.heartbeatAckTimeoutMs);
    this.pendingQueueValidationShadowRejectionAcks.set(eventId, timer);
  }

  private clearQueueValidationShadowRejectionAckDeadline(eventId: string): void {
    const timer = this.pendingQueueValidationShadowRejectionAcks.get(eventId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingQueueValidationShadowRejectionAcks.delete(eventId);
  }

  private clearQueueValidationShadowRejectionAckDeadlines(): void {
    for (const timer of this.pendingQueueValidationShadowRejectionAcks.values()) {
      clearTimeout(timer);
    }
    this.pendingQueueValidationShadowRejectionAcks.clear();
  }

  private waitForProbeInterval(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.reachabilityProbeIntervalMs);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound message handler
  // ---------------------------------------------------------------------------

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    const { payload } = msg;
    if (!payload || payload.case === undefined) {
      this.logger.warn("Received ServerMessage with no payload");
      return;
    }

    if (payload.case === "registerResponse") {
      const r = payload.value;
      this.logger.info({ accepted: r.accepted, message: r.message }, "Registration response");
      if (!r.accepted) {
        this.logger.error("Server rejected registration — will reconnect");
        // stop the current stream by stopping iteration (runOnce will return,
        // then the outer loop retries after backoff)
      }
      return;
    }

    if (payload.case === "heartbeatAck") {
      this.acknowledgeHeartbeat(payload.value.sequence);
      return;
    }

    if (payload.case === "jobStatusAck") {
      this.clearJobStatusAckDeadline(payload.value.eventId);
      const deleted = await this.persistentQueue?.acknowledgeJobStatus(payload.value.eventId);
      if (deleted === false) {
        this.logger.debug(
          { eventId: payload.value.eventId },
          "Ignoring unknown or duplicate job status acknowledgement",
        );
      }
      return;
    }

    if (payload.case === "queueValidationShadowRejectionAck") {
      this.clearQueueValidationShadowRejectionAckDeadline(payload.value.eventId);
      const deleted = await this.acknowledgePersistedQueueValidationShadowRejection(
        payload.value.eventId,
      );
      if (deleted === false) {
        this.logger.debug(
          { eventId: payload.value.eventId },
          "Ignoring unknown or duplicate queue validation shadow rejection acknowledgement",
        );
      }
      return;
    }

    if (payload.case === "dispatchJob") {
      const dj = payload.value;
      const queueTargetMode = queueTargetModeFromProto(dj.queueTargetMode);
      const queueValidationMode = queueValidationModeFromProto(dj.queueValidationMode);
      const dispatchEpoch = Number(dj.dispatchEpoch);
      if (!Number.isSafeInteger(dispatchEpoch) || dispatchEpoch < 0) {
        this.logger.error({ jobId: dj.jobId }, "Rejecting dispatch with invalid epoch");
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Dispatch rejected: invalid dispatch epoch",
        });
        return;
      }
      if (!(await this.isDispatchEpochAllowed(dj.jobId, dispatchEpoch))) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Dispatch rejected: job was revoked before this dispatch epoch",
        });
        return;
      }
      this.logger.info({ jobId: dj.jobId, name: dj.name }, "Dispatching job");

      // Persist the inbound dispatch BEFORE handing it to the runner. If the
      // process crashes between this line and the first onStatusUpdate, the
      // row stays acked_at=NULL and gets a replayed status report on the
      // next reconnect (see generateOutbound). The proto has no separate
      // dispatch_id field, so we use jobId — onConflictDoNothing makes the
      // duplicate-delivery case (Server re-dispatches mid-recovery) safe.
      const dispatchId = `${dj.jobId}:${dispatchEpoch}`;
      if (this.inboundAcks) {
        try {
          const accepted = await this.inboundAcks.persistInbound({
            dispatchId,
            jobId: dj.jobId,
            payload: {
              name: dj.name,
              schedulerName: schedulerSubmissionTag(dj.jobId),
              command: dj.command,
              ...(dj.spackExecution
                ? {
                    spackExecution: {
                      spec: dj.spackExecution.spec,
                      command: dj.spackExecution.command,
                    },
                  }
                : {}),
              cpus: dj.cpus,
              memoryMb: Number(dj.memoryMb),
              gpus: dj.gpus,
              wallTimeSec: Number(dj.wallTimeSec),
              workingDir: dj.workingDir,
              queueName: dj.queueName,
              queueTargetMode,
              queueValidationMode,
              qos: dj.qos,
              stdinText: dj.stdinText,
            },
          });
          if (!accepted) {
            this.logger.info({ dispatchId }, "Ignoring duplicate durable dispatch delivery");
            return;
          }
        } catch (err) {
          this.logger.error({ err, dispatchId }, "Failed to persist inbound dispatch");
          await this.onJobTransition({
            jobId: dj.jobId,
            status: "failed",
            message: "Agent could not durably persist the dispatch",
          });
          return;
        }
      }
      if (this.dispatchIdsByJob.has(dj.jobId) || this.pool.get(dj.jobId)) {
        this.logger.warn({ dispatchId }, "Ignoring concurrent dispatch for an active job");
        return;
      }
      this.dispatchIdsByJob.set(dj.jobId, dispatchId);

      if (dj.spackExecution && dj.sandboxExecution) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: SPACK_ACTIVATION_FAILURE,
        });
        return;
      }
      const expectedOutputs: ExpectedOutput[] = dj.expectedOutputs.map((o) => ({
        descriptor: o.descriptor,
        path: o.path,
        isBatch: o.isBatch,
        pathsOnly: o.pathsOnly,
      }));
      if (dj.restrictedNoEgress && !this.hasTrustedRestrictedExecutionProfile()) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Restricted no-egress dispatch requires a validated trusted execution profile",
        });
        return;
      }
      if (dj.restrictedNoEgress && expectedOutputs.length > 0) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Restricted no-egress dispatch cannot declare outputs",
        });
        return;
      }
      if (dj.restrictedNoEgress && !dj.sandboxExecution) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message:
            "Restricted no-egress dispatch rejects raw scheduler commands; a signed trusted profile is required",
        });
        return;
      }
      if (dj.restrictedNoEgress && dj.sandboxExecution?.networkDisabled !== true) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Restricted no-egress dispatch requires a network-disabled trusted profile",
        });
        return;
      }
      if (dj.restrictedNoEgress && dj.dataDeliveries.length > 0) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message:
            "Restricted no-egress inputs must be materialized as signed Sandbox input mounts",
        });
        return;
      }
      if (dj.licensedMaterialMounts.length > 0 && !dj.restrictedNoEgress) {
        await this.onJobTransition({
          jobId: dj.jobId,
          status: "failed",
          message: "Licensed material mounts require restricted no-egress execution",
        });
        return;
      }
      if (dj.sandboxExecution) {
        const sandboxExecution = dj.sandboxExecution;
        if (dj.licensedMaterialMounts.length > 0) {
          await this.onJobTransition({
            jobId: dj.jobId,
            status: "failed",
            message: "Licensed material mounts are unsupported for Sandbox jobs",
          });
          return;
        }
        const processor = this.deps.sandboxProcessor;
        if (!processor) {
          await this.onJobTransition({
            jobId: dj.jobId,
            status: "failed",
            message: "Sandbox execution is unsupported by this Agent",
          });
          return;
        }
        processor
          .prepare(
            dj.jobId,
            sandboxExecution,
            dj.inputStaging.map((input) => ({
              stagePath: input.stagePath,
              sourceUrl: input.sourceUrl,
              ...(input.deliveryLeaseId
                ? {
                    deliveryLeaseId: input.deliveryLeaseId,
                    deliveryLeaseExpiresAtUnixMs: input.deliveryLeaseExpiresAtUnixMs,
                  }
                : {}),
            })),
          )
          .then(async (prepared) => {
            const profile = this.deps.restrictedExecutionProfile;
            if (
              dj.restrictedNoEgress &&
              (!profile?.ready ||
                prepared.runtimeDigest !== profile.runtimeDigest ||
                !profile.executionProfile ||
                !prepared.sandbox.executionProfile ||
                prepared.sandbox.executionProfile.profileId !==
                  profile.executionProfile.profileId ||
                prepared.sandbox.executionProfile.apptainerSha256 !==
                  profile.executionProfile.apptainerSha256 ||
                prepared.sandbox.executionProfile.sifSha256 !==
                  profile.executionProfile.sifSha256 ||
                prepared.sandbox.executionProfile.trustedWrapperSha256 !==
                  profile.executionProfile.trustedWrapperSha256)
            ) {
              throw new Error(
                "Restricted no-egress Sandbox runtime does not match the pinned profile",
              );
            }
            if (dj.restrictedNoEgress && profile) {
              await (
                this.deps.assertRestrictedExecutionProfileIdentity ??
                assertRestrictedExecutionProfileIdentity
              )(profile);
            }
            const sandboxOutputs: ExpectedOutput[] = prepared.sandbox.mounts
              .filter((mount) => mount.mode === "WriteOnly")
              .map((mount) => ({
                descriptor: mount.descriptor,
                path: mount.relativePath,
                isBatch: mount.ioType === "FileBatch",
              }));
            if (dj.restrictedNoEgress && sandboxOutputs.length > 0) {
              throw new Error("Restricted no-egress Sandbox cannot expose output mounts");
            }
            if (
              dj.restrictedNoEgress &&
              (prepared.sandbox.identity.backend !== "Unix" ||
                prepared.sandbox.identity.mode !== "MappedAccount")
            ) {
              throw new Error(
                "Restricted no-egress Sandbox requires a mapped Unix execution identity",
              );
            }
            const spec: JobSpec = {
              jobId: dj.jobId,
              name: dj.name,
              schedulerName: schedulerSubmissionTag(dj.jobId),
              command: "sandbox-manifest",
              cpus: dj.cpus,
              memoryMb: Number(dj.memoryMb),
              gpus: dj.gpus,
              wallTimeSec: Number(dj.wallTimeSec),
              workingDir: prepared.workingDir,
              envVars: {},
              queueName: dj.queueName || undefined,
              ...(queueTargetMode ? { queueTargetMode } : {}),
              ...(queueValidationMode ? { queueValidationMode } : {}),
              qos: dj.qos || undefined,
              sandbox: prepared.sandbox,
              restrictedNoEgress: dj.restrictedNoEgress,
            };
            if (dj.restrictedNoEgress) this.restrictedWorkRoots.add(dj.jobId);
            if (dj.restrictedNoEgress) {
              await this.cleanupIntents?.recordRestrictedWorkRoot(dj.jobId);
            }
            await this.assertDispatchEpochAllowed(dj.jobId, dispatchEpoch);
            this.sandboxRuntimeDigests.set(spec, prepared.runtimeDigest);
            return this.pool.submit(spec, { expectedOutputs: sandboxOutputs });
          })
          .catch(async (err) => {
            if (dj.restrictedNoEgress) {
              await this.removeRestrictedWorkRoot(dj.jobId).catch((cleanupError) => {
                this.logger.error(
                  { err: cleanupError, jobId: dj.jobId },
                  "Failed to remove rejected restricted work root",
                );
              });
              this.restrictedWorkRoots.delete(dj.jobId);
            }
            if (!this.running) {
              this.logger.info({ jobId: dj.jobId }, "Sandbox preparation stopped for shutdown");
              return;
            }
            if (await this.reportCancelledDispatchIfRevoked(dj.jobId, dispatchEpoch)) return;
            const message = err instanceof Error ? err.message : "Sandbox dispatch rejected";
            this.logger.warn({ jobId: dj.jobId, err }, "Sandbox dispatch rejected");
            await this.onJobTransition({ jobId: dj.jobId, status: "failed", message });
          });
        return;
      }
      const spec: JobSpec = {
        jobId: dj.jobId,
        name: dj.name,
        schedulerName: schedulerSubmissionTag(dj.jobId),
        command: dj.command,
        cpus: dj.cpus,
        memoryMb: Number(dj.memoryMb),
        gpus: dj.gpus,
        wallTimeSec: Number(dj.wallTimeSec),
        workingDir: dj.workingDir,
        envVars: Object.fromEntries(Object.entries(dj.envVars)),
        queueName: dj.queueName || undefined,
        ...(queueTargetMode ? { queueTargetMode } : {}),
        ...(queueValidationMode ? { queueValidationMode } : {}),
        qos: dj.qos || undefined,
        stdinText: dj.stdinText || undefined,
        restrictedNoEgress: dj.restrictedNoEgress,
      };
      if (dj.spackExecution) this.preparingSpackDispatches.add(dispatchId);
      const preparation = this.submitWithLicensedMaterials(
        dj,
        spec,
        expectedOutputs,
        dispatchEpoch,
      ).catch(async (err) => {
        if (!this.running) {
          this.logger.info({ jobId: dj.jobId }, "Job preparation stopped for shutdown");
          return;
        }
        if (await this.reportCancelledDispatchIfRevoked(dj.jobId, dispatchEpoch)) return;
        const message = dj.spackExecution
          ? SPACK_ACTIVATION_FAILURE
          : err instanceof Error
            ? err.message
            : "Licensed material preparation failed";
        this.logger.error(
          { jobId: dj.jobId, ...(dj.spackExecution ? {} : { err }) },
          "Job dispatch rejected",
        );
        await this.onJobTransition({ jobId: dj.jobId, status: "failed", message });
      });
      if (dj.spackExecution) {
        const tracked = preparation.catch(() => {
          this.logger.error({ jobId: dj.jobId }, "Failed to report Spack dispatch failure");
        });
        this.pendingSpackPreparations.add(tracked);
        void tracked.then(() => {
          this.pendingSpackPreparations.delete(tracked);
          this.preparingSpackDispatches.delete(dispatchId);
        });
      }
      return;
    }

    if (payload.case === "cancelJob") {
      const { jobId } = payload.value;
      const revokedEpoch = Number(payload.value.revokedEpoch);
      if (!Number.isSafeInteger(revokedEpoch) || revokedEpoch < 0) {
        this.logger.error({ jobId }, "Rejecting cancellation with invalid revocation epoch");
        return;
      }
      if (!this.revocationTombstones) {
        this.logger.error(
          { jobId },
          "Rejecting cancellation without a durable revocation tombstone",
        );
        return;
      }
      try {
        await this.requestJobCancellation(jobId, revokedEpoch);
      } catch (err) {
        this.logger.error({ err, jobId }, "Job cancellation did not safely converge");
        return;
      }
      return;
    }

    if (payload.case === "releaseJobWorkRoot") {
      const { jobId } = payload.value;
      try {
        await this.removeJobWorkRoot(jobId);
      } catch (err) {
        this.logger.error({ err, jobId }, "Failed to release managed Job work root");
        return;
      }
      this.outboundQueue.push({ kind: "jobWorkRootReleaseAck", jobId });
      this.signalOutbound();
      return;
    }

    if (payload.case === "dataDeliveryRevoke") {
      const { destroyRestrictedWorkRoot, jobId, reasonCode } = payload.value;
      const revokedEpoch = Number(payload.value.revokedEpoch);
      if (!Number.isSafeInteger(revokedEpoch) || revokedEpoch < 0) {
        this.logger.error({ jobId }, "Rejecting revocation with invalid epoch");
        return;
      }
      this.logger.warn({ jobId, reasonCode }, "Data delivery lease revoked");
      if (!this.cleanupIntents) {
        this.logger.error(
          { jobId },
          "Rejecting revocation because no durable cleanup journal is configured",
        );
        return;
      }
      try {
        if (!this.revocationTombstones) {
          throw new Error("durable revocation tombstone store is not configured");
        }
        await this.revocationTombstones.record(jobId, revokedEpoch);
        await this.cleanupIntents.recordRevoked(jobId, {
          reason: reasonCode,
          destroyRestrictedWorkRoot,
        });
      } catch (err) {
        this.logger.error({ err, jobId }, "Failed to persist data delivery revocation intent");
        return;
      }
      if (destroyRestrictedWorkRoot) this.restrictedWorkRoots.add(jobId);
      await this.revokeDataDelivery(jobId, destroyRestrictedWorkRoot, reasonCode);
      return;
    }

    if (payload.case === "sandboxArtifactRelease") {
      const release = this.deps.releaseSandboxArtifacts;
      const request = payload.value;
      const execute = release
        ? release(
            request.items.map((item) => ({
              replicaId: item.replicaId,
              storageRef: item.storageRef,
            })),
          )
        : Promise.resolve({
            releasedReplicaIds: [],
            failures: Object.fromEntries(
              request.items.map((item) => [item.replicaId, "Sandbox artifact GC is unavailable"]),
            ),
          });
      execute
        .then((result) => {
          this.outboundQueue.push({
            kind: "sandboxArtifactReleaseAck",
            requestId: request.requestId,
            ...result,
          });
          this.signalOutbound();
        })
        .catch((error) => {
          this.outboundQueue.push({
            kind: "sandboxArtifactReleaseAck",
            requestId: request.requestId,
            releasedReplicaIds: [],
            failures: Object.fromEntries(
              request.items.map((item) => [
                item.replicaId,
                error instanceof Error ? error.message : "Sandbox artifact GC failed",
              ]),
            ),
          });
          this.signalOutbound();
        });
      return;
    }

    if (payload.case === "dataScanRequest") {
      const request: CpLocalDataScanRequest = {
        requestId: payload.value.requestId,
        importId: payload.value.importId,
        assetId: payload.value.assetId,
        versionId: payload.value.versionId,
        managedRootId: payload.value.managedRootId,
        relativePath: payload.value.relativePath,
        providerOrgId: payload.value.providerOrgId,
      };
      this.handleDataScanRequest(request);
      return;
    }

    if (payload.case === "softwarePolicyUpdate") {
      const update = payload.value;
      this.logger.info(
        { policyVersion: update.policyVersion, lockEnabled: update.lockEnabled },
        "Software policy update received",
      );
      this.applyPolicyAndAck(update).catch((err) => {
        this.logger.error({ err }, "Failed to apply software policy");
      });
      return;
    }

    if (payload.case === "specDistribute") {
      const distribute = payload.value;
      this.logger.info(
        { spec: distribute.spec, buildcacheUrl: distribute.buildcacheUrl },
        "Spec distribute received",
      );
      this.handleSpecDistribute(distribute.spec, distribute.buildcacheUrl).catch((err) => {
        this.logger.error({ err, spec: distribute.spec }, "Failed to distribute spec");
      });
      return;
    }

    if (payload.case === "softwareOperationRequest") {
      const request = payload.value;
      this.logger.info(
        { operationId: request.operationId, action: request.action, spec: request.spec },
        "Software operation received",
      );
      // Include inventory updates in the queue so an older success cannot undo a later withdrawal.
      this.softwareOperationQueue = this.softwareOperationQueue
        .then(async () => {
          if (this.lifecycleController.signal.aborted) {
            await this.enqueueSoftwareOperationResult({
              operationId: request.operationId,
              action: request.action,
              status: SoftwareOperationStatus.FAILED,
              spec: request.spec,
              error: "Agent stopped before queued software operation could begin",
            });
            return;
          }
          await this.handleSoftwareOperation(request.operationId, request.action, request.spec, {
            operationId: request.operationId,
            ticket: request.spackMaterialTicket,
            manifestDigest: request.spackManifestDigest,
          });
        })
        .catch((err) => {
          this.logger.error(
            { err, operationId: request.operationId, spec: request.spec },
            "Failed to run software operation",
          );
          return this.enqueueSoftwareOperationResult({
            operationId: request.operationId,
            action: request.action,
            status: SoftwareOperationStatus.FAILED,
            spec: request.spec,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return;
    }

    if (payload.case === "sshOpen") {
      const open = payload.value;
      if (!this.sshHandler) {
        this.logger.warn(
          { sessionId: open.sessionId },
          "SshOpen received but no SshHandler attached — replying with synthetic close",
        );
        this.enqueueSshOutgoing({
          kind: "sshClosed",
          sessionId: open.sessionId,
          reason: "ssh handler disabled",
        });
        return;
      }
      this.sshHandler.handleOpen({
        sessionId: open.sessionId,
        host: open.host,
        port: open.port,
        username: open.username,
        password: open.auth?.password || undefined,
        privateKey: open.auth?.privateKey || undefined,
        passphrase: open.auth?.passphrase || undefined,
        expectedHostKeySha256: open.hostKeySha256 || undefined,
      });
      return;
    }

    if (payload.case === "sshData") {
      const ssh = payload.value;
      if (!this.sshHandler) {
        this.logger.debug({ sessionId: ssh.sessionId }, "SshData with no handler — dropping");
        return;
      }
      this.sshHandler.handleData(ssh.sessionId, Buffer.from(ssh.data));
      return;
    }

    if (payload.case === "sshClose") {
      const ssh = payload.value;
      if (!this.sshHandler) {
        this.logger.debug({ sessionId: ssh.sessionId }, "SshClose with no handler — dropping");
        return;
      }
      this.sshHandler.handleClose(ssh.sessionId, ssh.reason);
      return;
    }

    if (payload.case === "sshResize") {
      const ssh = payload.value;
      if (!this.sshHandler) {
        this.logger.debug({ sessionId: ssh.sessionId }, "SshResize with no handler — dropping");
        return;
      }
      this.sshHandler.handleResize(ssh.sessionId, ssh.cols, ssh.rows);
      return;
    }

    if (payload.case === "shellExecRequest") {
      const req = payload.value;
      void this.runShellExec(req.requestId, req.input, req.timeoutSec || 30);
      return;
    }

    if (payload.case === "jobLogsRequest") {
      const request = payload.value;
      if (request.restrictedNoEgress) {
        this.outboundQueue.push({
          kind: "jobLogsResponse",
          requestId: request.requestId,
          text: "",
          error: "Restricted no-egress job logs are unavailable",
          unavailable: false,
        });
        this.wakeOutbound();
      } else {
        void this.runJobLogs(
          request.requestId,
          request.schedulerJobId,
          request.lines,
          request.jobId,
        );
      }
      return;
    }

    if (payload.case === "fileTransferRequest") {
      const r = payload.value;
      this.activeFileTransfers.get(r.requestId)?.abort("superseded transfer request");
      const controller = new AbortController();
      this.activeFileTransfers.set(r.requestId, controller);
      void this.runFileTransfer(
        {
          requestId: r.requestId,
          direction: r.direction,
          sourceUrl: r.sourceUrl,
          sourcePath: r.sourcePath,
          targetUrl: r.targetUrl,
          targetPath: r.targetPath,
          totalBytes: Number(r.totalBytes),
          uploadId: r.uploadId,
          partSize: Number(r.partSize),
        },
        controller.signal,
      ).finally(() => {
        if (this.activeFileTransfers.get(r.requestId) === controller) {
          this.activeFileTransfers.delete(r.requestId);
        }
      });
      return;
    }

    if (payload.case === "fileTransferCancel") {
      const requestId = payload.value.requestId;
      this.activeFileTransfers.get(requestId)?.abort("transfer cancelled by Server");
      this.pendingPartUrlRequests.get(requestId)?.reject(new Error("TRANSFER_CANCELLED"));
      this.pendingPartUrlRequests.delete(requestId);
      return;
    }

    if (payload.case === "partUrlsResponse") {
      const r = payload.value;
      const pending = this.pendingPartUrlRequests.get(r.requestId);
      if (pending) {
        this.pendingPartUrlRequests.delete(r.requestId);
        pending.resolve(r.urls.map((u) => ({ partNumber: u.partNumber, url: u.url })));
      }
      return;
    }

    this.logger.warn(
      { case: (payload as { case: string }).case },
      "Unknown ServerMessage payload case — ignoring",
    );
  }

  private handleDataScanRequest(request: CpLocalDataScanRequest): void {
    const completed = this.completedDataScans.get(request.requestId);
    if (completed) {
      this.outboundQueue.push(completed);
      this.signalOutbound();
      return;
    }
    if (this.pendingDataScans.has(request.requestId)) return;
    const pending = this.runDataScan(request).finally(() => {
      this.pendingDataScans.delete(request.requestId);
    });
    this.pendingDataScans.set(request.requestId, pending);
  }

  private async runDataScan(request: CpLocalDataScanRequest): Promise<void> {
    const scanner = this.deps.dataScanner;
    let item: Extract<OutboundItem, { kind: "dataScanResult" }>;
    if (!scanner) {
      item = {
        kind: "dataScanResult",
        request,
        error: "CP-local data scanning requires an Agent mTLS signing key",
      };
    } else {
      try {
        const result = await withTimeout(
          scanner.scan(request),
          this.deps.dataScanTimeoutMs ?? DEFAULT_DATA_SCAN_TIMEOUT_MS,
        );
        item = { kind: "dataScanResult", request, result, error: "" };
      } catch (error) {
        item = {
          kind: "dataScanResult",
          request,
          error: error instanceof Error ? error.message : "CP-local data scan failed",
        };
      }
    }
    this.completedDataScans.set(request.requestId, item);
    if (this.completedDataScans.size > MAX_COMPLETED_DATA_SCANS) {
      const oldest = this.completedDataScans.keys().next().value;
      if (oldest) this.completedDataScans.delete(oldest);
    }
    this.outboundQueue.push(item);
    this.signalOutbound();
  }

  private async submitWithLicensedMaterials(
    dispatch: DispatchJob,
    spec: JobSpec,
    expectedOutputs: ExpectedOutput[],
    dispatchEpoch: number,
  ): Promise<void> {
    if (dispatch.spackExecution) {
      await this.assertDispatchEpochAllowed(spec.jobId, dispatchEpoch);
      this.lifecycleController.signal.throwIfAborted();
      const controller = new AbortController();
      this.spackActivations.set(spec.jobId, { epoch: dispatchEpoch, controller });
      try {
        const command = await activateWorkflowSpack({
          execution: {
            spec: dispatch.spackExecution.spec,
            command: dispatch.spackExecution.command,
          },
          command: dispatch.command,
          manager: this.spackManager,
          signal: AbortSignal.any([this.lifecycleController.signal, controller.signal]),
          timeoutMs: this.deps.spackActivationTimeoutMs,
          spawner: this.deps.spackActivationSpawner,
          invalidate: (hashes) => this.invalidateInstalledSoftware(hashes),
          schedule: (prepare) => {
            const pending = this.softwareOperationQueue.then(prepare);
            // Hold the shared store queue until the actual load and cleanup settle.
            this.softwareOperationQueue = pending.then(
              () => {},
              () => {},
            );
            return pending;
          },
          trackCleanup: (pending) => {
            this.pendingSpackLoadCleanups.add(pending);
            void pending.then(() => this.pendingSpackLoadCleanups.delete(pending));
          },
        });
        await this.assertDispatchEpochAllowed(spec.jobId, dispatchEpoch);
        this.lifecycleController.signal.throwIfAborted();
        spec = { ...spec, command };
      } finally {
        this.spackActivations.delete(spec.jobId);
      }
    }
    const hasSpecializedManagedRoot =
      dispatch.dataDeliveries.length > 0 || dispatch.licensedMaterialMounts.length > 0;
    const requiresImplicitFileWorkRoot =
      !spec.workingDir &&
      !hasSpecializedManagedRoot &&
      (dispatch.inputStaging.length > 0 ||
        dispatch.fileOutputDescriptors.length > 0 ||
        expectedOutputs.length > 0);
    const requiresManagedWorkRoot = requiresImplicitFileWorkRoot || hasSpecializedManagedRoot;
    const prepareJobWorkRoot = this.deps.prepareJobWorkRoot;
    if (requiresImplicitFileWorkRoot && (!prepareJobWorkRoot || !this.deps.removeJobWorkRoot)) {
      throw new Error("Agent-managed Job working directory is unavailable");
    }
    const managedSpec =
      prepareJobWorkRoot && requiresManagedWorkRoot
        ? { ...spec, workingDir: await prepareJobWorkRoot(spec.jobId) }
        : spec;
    if (requiresImplicitFileWorkRoot) {
      this.managedWorkRootsAwaitingServerRelease.add(spec.jobId);
    }
    const deliveryExecutor = this.deps.dataDeliveryExecutor;
    if (dispatch.dataDeliveries.length > 0 && !deliveryExecutor) {
      throw new Error("Data Market delivery is unavailable on this Agent");
    }
    try {
      const delivered = deliveryExecutor
        ? await deliveryExecutor.prepare(managedSpec.jobId, dispatch.dataDeliveries, {
            beforeSideEffect: async (delivery) => {
              await this.cleanupIntents?.recordDataDelivery(managedSpec.jobId, {
                bindingId: delivery.bindingId,
                targetPath: delivery.targetPath,
                method: delivery.method,
              });
            },
          })
        : [];
      const dataDeliveryCleanup = delivered.map(({ bindingId, targetPath, method }) => ({
        bindingId,
        targetPath,
        method,
      }));
      const deliveredSpec: JobSpec = {
        ...managedSpec,
        ...(dataDeliveryCleanup.length > 0 ? { dataDeliveryCleanup } : {}),
      };
      if (requiresImplicitFileWorkRoot) {
        await this.stageDispatchInputs(dispatch, deliveredSpec);
      }
      const mounts = dispatch.licensedMaterialMounts;
      let protectedExpectedOutputs = expectedOutputs;
      if (mounts.length > 0) {
        const resolver = this.deps.licensedMaterialResolver;
        if (!resolver) throw new Error("Licensed material resolver is unavailable on this Agent");
        const requests = mounts.map((mount) => ({
          selectorId: mount.selector,
          targetPath: mount.targetPath,
          fingerprint: mount.expectedFingerprint,
          requiredElements: mount.requiredElements,
        }));
        const prepared = await resolver.prepare(requests, deliveredSpec.workingDir, {
          beforeMount: async (mount) => {
            await this.cleanupIntents?.recordLicensedMount(deliveredSpec.jobId, mount);
          },
        });
        this.licensedMaterialMounts.set(deliveredSpec.jobId, prepared);
        const protectedPaths = prepared.flatMap((mount) => [mount.targetPath, mount.sourcePath]);
        const protectedMounts = prepared.map((mount) => ({
          selectorId: mount.selectorId,
          sourcePath: mount.sourcePath,
          targetPath: mount.targetPath,
        }));
        protectedExpectedOutputs = expectedOutputs.map((output) => ({
          ...output,
          protectedPaths,
          protectedMounts,
        }));
      }
      const protectedSpec: JobSpec =
        mounts.length > 0
          ? {
              ...deliveredSpec,
              licensedMaterialCleanup: this.licensedMaterialMounts.get(deliveredSpec.jobId) ?? [],
            }
          : deliveredSpec;
      await this.assertDispatchEpochAllowed(protectedSpec.jobId, dispatchEpoch);
      this.lifecycleController.signal.throwIfAborted();
      if (dispatch.spackExecution) {
        this.spackDispatchEpochs.set(protectedSpec, dispatchEpoch);
      }
      await this.pool.submit(protectedSpec, { expectedOutputs: protectedExpectedOutputs });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await this.releaseLicensedMaterials(managedSpec.jobId);
      } catch (err) {
        cleanupErrors.push(err);
      }
      try {
        await deliveryExecutor?.release(managedSpec.jobId);
      } catch (err) {
        cleanupErrors.push(err);
      }
      try {
        await this.releaseImplicitJobWorkRoot(managedSpec.jobId);
      } catch (err) {
        cleanupErrors.push(err);
      }
      if (cleanupErrors.length === 0) {
        try {
          await this.cleanupIntents?.clear(managedSpec.jobId);
        } catch (err) {
          cleanupErrors.push(err);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Job submission and cleanup failed");
      }
      throw error;
    }
  }

  private async stageDispatchInputs(dispatch: DispatchJob, spec: JobSpec): Promise<void> {
    for (const [index, input] of dispatch.inputStaging.entries()) {
      if (!input.sourceUrl) {
        throw new Error(`Workflow input ${input.fileMetadataId} has no download URL`);
      }
      const targetPath = join(spec.workingDir, input.stagePath);
      if (this.deps.stageInputFile) {
        await this.deps.stageInputFile(input.sourceUrl, targetPath);
      } else if (this.deps.slurmContainerId) {
        await this.runCloudToCluster(
          `${spec.jobId}-input-${index}`,
          this.deps.slurmContainerId,
          input.sourceUrl,
          targetPath,
          new AbortController().signal,
          false,
        );
      } else {
        await this.runHostCloudToCluster(
          `${spec.jobId}-input-${index}`,
          input.sourceUrl,
          targetPath,
          new AbortController().signal,
          false,
        );
      }
    }
  }

  private async releaseLicensedMaterials(jobId: string): Promise<void> {
    const mounts = this.licensedMaterialMounts.get(jobId);
    if (mounts && this.deps.licensedMaterialResolver) {
      await this.deps.licensedMaterialResolver.release(mounts);
      this.licensedMaterialMounts.delete(jobId);
    }
  }

  private async releaseImplicitJobWorkRoot(jobId: string): Promise<void> {
    if (!this.managedWorkRootsAwaitingServerRelease.has(jobId)) return;
    await this.removeJobWorkRoot(jobId);
    this.managedWorkRootsAwaitingServerRelease.delete(jobId);
  }

  private async removeJobWorkRoot(jobId: string): Promise<void> {
    const remove = this.deps.removeJobWorkRoot;
    if (!remove) return;
    await remove(jobId);
  }

  private async requestJobCancellation(jobId: string, revokedEpoch: number): Promise<void> {
    const tombstones = this.revocationTombstones;
    if (!tombstones) throw new Error("durable revocation tombstone store is not configured");
    await tombstones.record(jobId, revokedEpoch);
    const activation = this.spackActivations.get(jobId);
    if (activation && activation.epoch <= revokedEpoch) {
      activation.controller.abort();
    }

    const existingIntent = await this.findCleanupIntent(jobId);
    if (existingIntent) {
      await this.cleanupIntents?.recordRevoked(jobId, {
        reason: "JOB_CANCELLED",
        destroyRestrictedWorkRoot: false,
      });
    }

    const pending = this.pendingJobCancellations.get(jobId);
    if (pending) {
      pending.revokedEpoch = Math.max(pending.revokedEpoch, revokedEpoch);
      await pending.settle;
      return;
    }

    const entry: { revokedEpoch: number; settle: Promise<void> } = {
      revokedEpoch,
      settle: Promise.resolve(),
    };
    const settled = this.settleJobCancellation(jobId).then(() => {
      this.outboundQueue.push({
        kind: "cancelJobAck",
        jobId,
        revokedEpoch: entry.revokedEpoch,
      });
      this.signalOutbound();
    });
    entry.settle = settled.finally(() => {
      if (this.pendingJobCancellations.get(jobId) === entry) {
        this.pendingJobCancellations.delete(jobId);
      }
    });
    this.pendingJobCancellations.set(jobId, entry);
    await entry.settle;
  }

  private async settleJobCancellation(jobId: string): Promise<void> {
    const hadActiveRunner = this.pool.get(jobId) !== undefined;
    if (hadActiveRunner) {
      await this.pool.cancel(jobId);
      await this.pool.await(jobId);
    }

    const [active, intent] = await Promise.all([
      this.activeRemoteJobs?.listActive() ?? Promise.resolve([]),
      this.findCleanupIntent(jobId),
    ]);
    const activeJob = active.find((job) => job.jobId === jobId);
    const unreconciledSchedulerJobId = this.unreconciledSubmittedJobs.get(jobId);
    const schedulerJobId =
      activeJob?.schedulerJobId ?? intent?.schedulerJobId ?? unreconciledSchedulerJobId;

    if (!activeJob && !intent && !schedulerJobId && !hadActiveRunner) {
      this.logger.info({ jobId }, "Cancellation converged for unknown job");
      return;
    }

    if (schedulerJobId) {
      await this.cancelSchedulerJobOrConfirmAbsent(jobId, schedulerJobId, intent);
    } else {
      const lookup = await this.lookupSchedulerJob(jobId, intent);
      if (lookup.status === "found") {
        await this.deps.adapter.cancel(lookup.schedulerJobId);
      }
    }

    if (intent) await this.cleanupCancellationIntent(intent);
    await this.activeRemoteJobs?.markFinished(jobId);
    if (intent) await this.cleanupIntents?.clear(jobId);
    this.unreconciledSubmittedJobs.delete(jobId);
    await this.releaseImplicitJobWorkRoot(jobId);
  }

  private async cancelSchedulerJobOrConfirmAbsent(
    jobId: string,
    schedulerJobId: string,
    intent: JobCleanupIntent | undefined,
  ): Promise<void> {
    try {
      await this.deps.adapter.cancel(schedulerJobId);
    } catch (cancelError) {
      let lookup: Awaited<ReturnType<NonNullable<SchedulerAdapter["findByKuintessenceJobId"]>>>;
      try {
        lookup = await this.lookupSchedulerJob(jobId, intent);
      } catch (lookupError) {
        throw new AggregateError(
          [cancelError, lookupError],
          "Scheduler cancellation failed and its final state could not be reconciled",
        );
      }
      if (lookup.status === "not_found") return;
      throw new AggregateError(
        [cancelError],
        "Scheduler cancellation failed while the job remains present",
      );
    }
  }

  private async lookupSchedulerJob(
    jobId: string,
    intent: JobCleanupIntent | undefined,
  ): Promise<Awaited<ReturnType<NonNullable<SchedulerAdapter["findByKuintessenceJobId"]>>>> {
    const find = this.deps.adapter.findByKuintessenceJobId;
    if (!find) {
      throw new Error("scheduler adapter cannot reconcile Kuintessence UUID metadata");
    }
    const lookup = await find.call(this.deps.adapter, {
      jobId,
      schedulerName: intent?.schedulerSubmissionTag ?? schedulerSubmissionTag(jobId),
      schedulerAccount: intent?.schedulerAccount,
      namespace: intent?.schedulerNamespace,
    });
    if (lookup.status === "indeterminate") {
      throw new Error(`scheduler UUID lookup is indeterminate: ${lookup.reason}`);
    }
    return lookup;
  }

  private async findCleanupIntent(jobId: string): Promise<JobCleanupIntent | undefined> {
    const intents = await this.cleanupIntents?.list();
    return intents?.find((intent) => intent.jobId === jobId);
  }

  private async cleanupCancellationIntent(intent: JobCleanupIntent): Promise<void> {
    const cleanup = await Promise.allSettled([
      (async () => {
        if (intent.dataDeliveries.length === 0) return;
        const executor = this.deps.dataDeliveryExecutor;
        if (!executor) throw new Error("Data Market cleanup executor is unavailable");
        await executor.recover(
          intent.jobId,
          intent.dataDeliveries.map((delivery) => ({ ...delivery, protectedPath: true })),
        );
        await executor.release(intent.jobId);
      })(),
      (async () => {
        if (intent.licensedMounts.length === 0) return;
        const resolver = this.deps.licensedMaterialResolver;
        if (!resolver) throw new Error("Licensed material cleanup resolver is unavailable");
        await resolver.release(intent.licensedMounts);
      })(),
      intent.restrictedWorkRoot ? this.removeRestrictedWorkRoot(intent.jobId) : Promise.resolve(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Cancellation cleanup failed");
    }
    this.licensedMaterialMounts.delete(intent.jobId);
    if (intent.restrictedWorkRoot) this.restrictedWorkRoots.delete(intent.jobId);
  }

  private async isDispatchEpochAllowed(jobId: string, dispatchEpoch: number): Promise<boolean> {
    const revokedEpoch = await this.revocationTombstones?.revokedEpoch(jobId);
    if (revokedEpoch === undefined || dispatchEpoch > revokedEpoch) return true;
    this.logger.warn(
      { jobId, dispatchEpoch, revokedEpoch },
      "Rejecting dispatch fenced by durable revocation",
    );
    return false;
  }

  private async reportCancelledDispatchIfRevoked(
    jobId: string,
    dispatchEpoch: number,
  ): Promise<boolean> {
    try {
      if (await this.isDispatchEpochAllowed(jobId, dispatchEpoch)) return false;
    } catch (err) {
      this.logger.error(
        { err, jobId, dispatchEpoch },
        "Failed to read durable revocation while classifying dispatch rejection",
      );
      return false;
    }
    await this.onJobTransition({ jobId, status: "cancelled" });
    return true;
  }

  private async assertDispatchEpochAllowed(jobId: string, dispatchEpoch: number): Promise<void> {
    if (!(await this.isDispatchEpochAllowed(jobId, dispatchEpoch))) {
      throw new Error("Dispatch rejected: job was revoked before this dispatch epoch");
    }
  }

  private async revokeDataDelivery(
    jobId: string,
    destroyRestrictedWorkRoot: boolean,
    reasonCode: string,
  ): Promise<void> {
    const schedulerCancellation = this.pool.get(jobId)
      ? this.pool.cancel(jobId)
      : Promise.resolve();
    const mounts = this.licensedMaterialMounts.get(jobId);
    const cleanup = await Promise.allSettled([
      schedulerCancellation,
      this.deps.dataDeliveryExecutor?.release(jobId) ?? Promise.resolve(),
      mounts && this.deps.licensedMaterialResolver
        ? this.deps.licensedMaterialResolver.release(mounts)
        : Promise.resolve(),
      destroyRestrictedWorkRoot ? this.removeRestrictedWorkRoot(jobId) : Promise.resolve(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      this.logger.error(
        { err: new AggregateError(failures), jobId },
        "Data delivery revocation cleanup failed; durable intent retained",
      );
      return;
    }
    this.licensedMaterialMounts.delete(jobId);
    if (destroyRestrictedWorkRoot) this.restrictedWorkRoots.delete(jobId);
    try {
      await this.activeRemoteJobs?.markFinished(jobId);
      await this.cleanupIntents?.clear(jobId);
      this.outboundQueue.push({ kind: "dataDeliveryRevokeAck", jobId, reasonCode });
      this.signalOutbound();
    } catch (error) {
      this.logger.error({ err: error, jobId }, "Data delivery cleanup state could not be cleared");
    }
  }

  private async removeRestrictedWorkRoot(jobId: string): Promise<void> {
    const remove = this.deps.removeRestrictedWorkRoot;
    if (!remove) throw new Error("Restricted execution work-root cleanup is unavailable");
    await remove(jobId);
  }

  private wakeOutbound(): void {
    this.signalOutbound();
  }

  private emitProgress(
    requestId: string,
    copiedBytes: number,
    state: "running" | "succeeded" | "failed",
    error = "",
    sha256 = "",
    parts: { partNumber: number; etag: string }[] = [],
  ): void {
    this.outboundQueue.push({
      kind: "fileTransferProgress",
      requestId,
      copiedBytes,
      state,
      error,
      sha256,
      parts,
    });
    this.wakeOutbound();
  }

  private async runFileTransfer(
    req: {
      requestId: string;
      direction: string;
      sourceUrl: string;
      sourcePath: string;
      targetUrl: string;
      targetPath: string;
      totalBytes: number;
      uploadId: string;
      partSize: number;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const containerId = this.deps.slurmContainerId;
    // Defense in depth: reject paths that escape the per-job run dir via `..`
    // (stagePath is user-authored and unvalidated upstream — tbd #12). Covers
    // both download targetPath and upload sourcePath at the single chokepoint.
    const guardedPath =
      req.direction === "cloud_to_cluster"
        ? req.targetPath
        : req.direction === "cluster_to_cloud"
          ? req.sourcePath
          : "";
    if (guardedPath && hasPathTraversal(guardedPath)) {
      this.emitProgress(req.requestId, 0, "failed", "transfer path must not contain '..'");
      return;
    }
    try {
      throwIfTransferAborted(signal);
      if (req.direction === "cloud_to_cluster") {
        if (containerId) {
          await this.runCloudToCluster(
            req.requestId,
            containerId,
            req.sourceUrl,
            req.targetPath,
            signal,
          );
        } else {
          await this.runHostCloudToCluster(req.requestId, req.sourceUrl, req.targetPath, signal);
        }
      } else if (req.direction === "cluster_to_cloud") {
        if (containerId) {
          await this.runClusterToCloud(
            req.requestId,
            containerId,
            req.sourcePath,
            req.targetUrl,
            req.uploadId,
            req.partSize,
            signal,
          );
        } else {
          await this.runHostClusterToCloud(
            req.requestId,
            req.sourcePath,
            req.targetUrl,
            req.uploadId,
            req.partSize,
            signal,
          );
        }
      } else {
        this.emitProgress(req.requestId, 0, "failed", `unsupported direction ${req.direction}`);
      }
    } catch (err) {
      this.emitProgress(
        req.requestId,
        0,
        "failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async runCloudToCluster(
    requestId: string,
    containerId: string,
    url: string,
    targetPath: string,
    signal: AbortSignal,
    reportProgress = true,
  ): Promise<void> {
    // url + targetPath are passed as positional args (not interpolated) — see
    // file-transfer.ts. targetPath derives from an unvalidated workflow
    // stagePath and runs as root, so interpolation would be a root RCE vector.
    const partialPath = `${targetPath}.kq-transfer-${requestId}.part`;
    const argv = buildCloudToClusterArgv(
      containerId,
      url,
      partialPath,
      this.deps.fileTransferMaxRetries ?? DEFAULT_FILE_TRANSFER_MAX_RETRIES,
      this.deps.fileTransferRetryBackoffSec ?? DEFAULT_FILE_TRANSFER_RETRY_BACKOFF_SEC,
      this.deps.containerFileTransferConnectTo ?? this.deps.fileTransferConnectTo ?? "",
    );
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal });

    const poller = reportProgress
      ? setInterval(async () => {
          const stat = Bun.spawn(
            ["docker", "exec", "-u", "root", containerId, "stat", "-c", "%s", partialPath],
            { stdout: "pipe", stderr: "ignore" },
          );
          const out = (await new Response(stat.stdout).text()).trim();
          await stat.exited;
          const bytes = Number.parseInt(out, 10);
          if (!Number.isNaN(bytes) && bytes > 0) {
            this.emitProgress(requestId, bytes, "running");
          }
        }, 500)
      : undefined;

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      throwIfTransferAborted(signal);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || stdout.trim() || "curl failed");
      }
      const statProc = Bun.spawn(
        ["docker", "exec", "-u", "root", containerId, "stat", "-c", "%s", partialPath],
        { stdout: "pipe", stderr: "ignore" },
      );
      const finalSize =
        Number.parseInt((await new Response(statProc.stdout).text()).trim(), 10) || 0;
      await statProc.exited;
      throwIfTransferAborted(signal);
      const publish = Bun.spawn(
        ["docker", "exec", "-u", "root", containerId, "mv", "-f", "--", partialPath, targetPath],
        { stdout: "ignore", stderr: "pipe" },
      );
      const publishError = await new Response(publish.stderr).text();
      if ((await publish.exited) !== 0) {
        throw new Error(publishError.trim() || "failed to publish downloaded file");
      }
      if (reportProgress) this.emitProgress(requestId, finalSize, "succeeded");
    } finally {
      if (poller) clearInterval(poller);
      const cleanup = Bun.spawn(
        ["docker", "exec", "-u", "root", containerId, "rm", "-f", "--", partialPath],
        { stdout: "ignore", stderr: "ignore" },
      );
      await cleanup.exited.catch(() => -1);
    }
  }

  private async runHostCloudToCluster(
    requestId: string,
    url: string,
    targetPath: string,
    signal: AbortSignal,
    reportProgress = true,
  ): Promise<void> {
    const partialPath = `${targetPath}.kq-transfer-${requestId}.part`;
    const argv = buildHostCloudToClusterArgv(
      url,
      partialPath,
      this.deps.fileTransferMaxRetries ?? DEFAULT_FILE_TRANSFER_MAX_RETRIES,
      this.deps.fileTransferRetryBackoffSec ?? DEFAULT_FILE_TRANSFER_RETRY_BACKOFF_SEC,
      this.deps.fileTransferConnectTo ?? "",
    );
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal });

    const poller = reportProgress
      ? setInterval(async () => {
          const result = await stat(partialPath).catch(() => null);
          if (result && result.size > 0) {
            this.emitProgress(requestId, result.size, "running");
          }
        }, 500)
      : undefined;

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      throwIfTransferAborted(signal);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || stdout.trim() || "curl failed");
      }
      const finalSize = (await stat(partialPath).catch(() => null))?.size ?? 0;
      await rename(partialPath, targetPath);
      if (reportProgress) this.emitProgress(requestId, finalSize, "succeeded");
    } finally {
      if (poller) clearInterval(poller);
      await rm(partialPath, { force: true });
    }
  }

  private async runClusterToCloud(
    requestId: string,
    containerId: string,
    sourcePath: string,
    uploadUrl: string,
    uploadId: string,
    partSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (uploadId) {
      await this.runClusterToCloudMultipart(requestId, containerId, sourcePath, partSize, signal);
      return;
    }
    await this.runClusterToCloudSinglePut(requestId, containerId, sourcePath, uploadUrl, signal);
  }

  private async runHostClusterToCloud(
    requestId: string,
    sourcePath: string,
    uploadUrl: string,
    uploadId: string,
    partSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (uploadId) {
      await this.runHostClusterToCloudMultipart(requestId, sourcePath, partSize, signal);
      return;
    }
    await this.runHostClusterToCloudSinglePut(requestId, sourcePath, uploadUrl, signal);
  }

  private async runHostClusterToCloudSinglePut(
    requestId: string,
    sourcePath: string,
    uploadUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    let copied = 0;
    let lastEmit = 0;
    try {
      const { size, sha256 } = await streamUploadToPresignedUrl({
        source: Bun.file(sourcePath).stream() as AsyncIterable<Uint8Array>,
        uploadUrl,
        tmpPath: join(tmpdir(), `kq-upload-${requestId}.bin`),
        signal,
        onProgress: (bytes) => {
          copied = bytes;
          const now = Date.now();
          if (now - lastEmit > 400) {
            this.emitProgress(requestId, copied, "running");
            lastEmit = now;
          }
        },
      });
      this.emitProgress(requestId, size, "succeeded", "", sha256);
    } catch (err) {
      this.emitProgress(requestId, copied, "failed", normalizeClusterToCloudSourceError(err));
    }
  }

  /**
   * Legacy single-PUT path: spool `cat` to a temp file then PUT the whole object
   * to one presigned URL. Kept for back-compat; the Server now always issues a
   * multipart upload for cluster_to_cloud (so `uploadId` is normally non-empty).
   */
  private async runClusterToCloudSinglePut(
    requestId: string,
    containerId: string,
    sourcePath: string,
    uploadUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    const proc = Bun.spawn(["docker", "exec", "-u", "root", containerId, "cat", sourcePath], {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    // Drain stderr concurrently regardless of outcome — `cat` writes nothing on
    // success, but a never-read stderr pipe could fill (~64 KiB) and block the
    // process on a warning. `.catch` keeps the unconsumed-on-success path from
    // surfacing as an unhandled rejection.
    const stderrText = new Response(proc.stderr).text().catch(() => "");
    const tmpPath = join(tmpdir(), `kq-upload-${requestId}.bin`);
    let copied = 0;
    let lastEmit = 0;
    try {
      const { size, sha256 } = await streamUploadToPresignedUrl({
        source: proc.stdout as AsyncIterable<Uint8Array>,
        uploadUrl,
        tmpPath,
        signal,
        onProgress: (bytes) => {
          copied = bytes;
          const now = Date.now();
          if (now - lastEmit > 400) {
            this.emitProgress(requestId, copied, "running");
            lastEmit = now;
          }
        },
        beforePut: async () => {
          const exit = await proc.exited;
          if (exit !== 0) {
            throw new Error((await stderrText).trim() || "cat failed");
          }
        },
      });
      this.emitProgress(requestId, size, "succeeded", "", sha256);
    } catch (err) {
      this.emitProgress(requestId, copied, "failed", normalizeClusterToCloudSourceError(err));
    }
  }

  /**
   * Multipart path: spool `cat` to a temp file (bounded memory), then upload it
   * in fixed-size parts via presigned URLs minted by the Server over the
   * bidirectional stream (PartUrlsRequest → PartUrlsResponse). The Server completes
   * the multipart upload from the `parts`/`sha256` reported on the final
   * `succeeded` progress event.
   */
  private async runClusterToCloudMultipart(
    requestId: string,
    containerId: string,
    sourcePath: string,
    partSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    const tmpPath = join(tmpdir(), `kq-upload-${requestId}.bin`);
    let copied = 0;
    try {
      const spooledSize = await this.spoolFromContainer(containerId, sourcePath, tmpPath, signal);
      let lastEmit = 0;
      const { parts, sha256, size } = await multipartUploadFromFile({
        filePath: tmpPath,
        size: spooledSize,
        partSize,
        getPartUrls: (partNumbers) => this.requestPartUrls(requestId, partNumbers, signal),
        connectTo: this.deps.fileTransferConnectTo ?? "",
        maxRetries: this.deps.fileTransferMaxRetries ?? DEFAULT_FILE_TRANSFER_MAX_RETRIES,
        retryBackoffMs:
          (this.deps.fileTransferRetryBackoffSec ?? DEFAULT_FILE_TRANSFER_RETRY_BACKOFF_SEC) * 1000,
        signal,
        onProgress: (bytes) => {
          copied = bytes;
          const now = Date.now();
          if (now - lastEmit > 400) {
            this.emitProgress(requestId, copied, "running");
            lastEmit = now;
          }
        },
      });
      this.emitProgress(requestId, size, "succeeded", "", sha256, parts);
    } catch (err) {
      this.emitProgress(requestId, copied, "failed", normalizeClusterToCloudSourceError(err));
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  private async runHostClusterToCloudMultipart(
    requestId: string,
    sourcePath: string,
    partSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    let copied = 0;
    try {
      const sourceStat = await stat(sourcePath);
      let lastEmit = 0;
      const { parts, sha256, size } = await multipartUploadFromFile({
        filePath: sourcePath,
        size: sourceStat.size,
        partSize,
        getPartUrls: (partNumbers) => this.requestPartUrls(requestId, partNumbers, signal),
        connectTo: this.deps.fileTransferConnectTo ?? "",
        maxRetries: this.deps.fileTransferMaxRetries ?? DEFAULT_FILE_TRANSFER_MAX_RETRIES,
        retryBackoffMs:
          (this.deps.fileTransferRetryBackoffSec ?? DEFAULT_FILE_TRANSFER_RETRY_BACKOFF_SEC) * 1000,
        signal,
        onProgress: (bytes) => {
          copied = bytes;
          const now = Date.now();
          if (now - lastEmit > 400) {
            this.emitProgress(requestId, copied, "running");
            lastEmit = now;
          }
        },
      });
      this.emitProgress(requestId, size, "succeeded", "", sha256, parts);
    } catch (err) {
      this.emitProgress(requestId, copied, "failed", normalizeClusterToCloudSourceError(err));
    }
  }

  /**
   * Spool `cat <sourcePath>` from the cluster container to a local temp file and
   * return the byte count. Throws if `cat` exits non-zero (drains stderr the
   * same way the single-PUT path does so a warning can't block the pipe).
   */
  private async spoolFromContainer(
    containerId: string,
    sourcePath: string,
    tmpPath: string,
    signal: AbortSignal,
  ): Promise<number> {
    const proc = Bun.spawn(["docker", "exec", "-u", "root", containerId, "cat", sourcePath], {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const stderrText = new Response(proc.stderr).text().catch(() => "");
    const sink = Bun.file(tmpPath).writer();
    let spooledSize = 0;
    try {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
        throwIfTransferAborted(signal);
        sink.write(chunk);
        spooledSize += chunk.byteLength;
      }
    } finally {
      await sink.end();
    }
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error(
        normalizeClusterToCloudSourceError((await stderrText).trim() || "cat failed"),
      );
    }
    return spooledSize;
  }

  /**
   * Ask the Server for presigned URLs for the given part numbers and await the
   * matching PartUrlsResponse on the inbound stream. Rejects after
   * {@link PART_URL_TIMEOUT_MS} so a lost response fails the transfer instead of
   * hanging the upload forever.
   */
  private requestPartUrls(
    requestId: string,
    partNumbers: number[],
    signal: AbortSignal,
  ): Promise<{ partNumber: number; url: string }[]> {
    return new Promise((resolve, reject) => {
      throwIfTransferAborted(signal);
      const timer = setTimeout(() => {
        this.pendingPartUrlRequests.delete(requestId);
        reject(new Error("timed out waiting for part URLs"));
      }, PART_URL_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timer);
        this.pendingPartUrlRequests.delete(requestId);
        reject(new Error("TRANSFER_CANCELLED"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingPartUrlRequests.set(requestId, {
        resolve: (urls) => {
          signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          resolve(urls);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(error);
        },
      });
      this.outboundQueue.push({ kind: "partUrlsRequest", requestId, partNumbers });
      this.wakeOutbound();
    });
  }

  private async runShellExec(requestId: string, input: string, timeoutSec: number): Promise<void> {
    this.logger.info({ requestId, timeoutSec }, "Agent shell command started");
    const containerId = this.deps.slurmContainerId;
    const argv: string[] = containerId
      ? ["docker", "exec", containerId, "bash", "-lc", input]
      : ["bash", "-lc", input];
    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    let error = "";
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, timeoutSec * 1000);
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      exitCode = await proc.exited;
      clearTimeout(timer);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.outboundQueue.push({
      kind: "shellExecResponse",
      requestId,
      stdout,
      stderr,
      exitCode,
      error,
    });
    this.logger.info({ requestId, exitCode, error }, "Agent shell command finished");
    this.signalOutbound();
  }

  private async runJobLogs(
    requestId: string,
    schedulerJobId: string,
    requestedLines: number,
    jobId: string,
  ): Promise<void> {
    let text = "";
    let error = "";
    let unavailable = false;
    try {
      if (!this.deps.adapter.getJobLogs) {
        throw new Error(`Job logs are not supported by ${this.deps.adapter.type}`);
      }
      const lines = Math.max(1, Math.min(MAX_JOB_LOG_LINES, requestedLines || 1_000));
      text = limitJobLogBytes(await this.deps.adapter.getJobLogs(schedulerJobId, lines, jobId));
    } catch (err) {
      if (err instanceof JobLogUnavailableError) {
        unavailable = true;
      } else {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 4_096);
      }
    }
    this.outboundQueue.push({ kind: "jobLogsResponse", requestId, text, error, unavailable });
    this.wakeOutbound();
  }

  /**
   * apply a Server-pushed policy via SpackManager and queue an ack
   * back to the Server. When no SpackManager is attached we ack `applied=false`
   * with an explicit error so the Server policy push is not lost in silence.
   *
   * Idempotency lives inside SpackManager.applyPolicy (policy_version
   * compare). The wire-level guarantee here is: every received update
   * results in exactly one ack, success or failure.
   */
  private async applyPolicyAndAck(update: {
    policyVersion: string;
    allowList: string[];
    denyList: string[];
    lockEnabled: boolean;
    mirrors: Array<{ name: string; url: string; priority: number }>;
    preinstallList: string[];
  }): Promise<void> {
    let ack: { policyVersion: string; applied: boolean; error?: string };
    if (!this.spackManager) {
      ack = {
        policyVersion: update.policyVersion,
        applied: false,
        error: "no SpackManager attached on this agent",
      };
    } else {
      ack = await this.spackManager.applyPolicy({
        policyVersion: update.policyVersion,
        lockEnabled: update.lockEnabled,
        allowList: update.allowList,
        denyList: update.denyList,
        mirrors: update.mirrors.map((m) => ({
          name: m.name,
          url: m.url,
          priority: m.priority,
        })),
        preinstallList: update.preinstallList,
      });
    }
    this.enqueueSoftwarePolicyAck(ack);
  }

  /**
   * invoke `SpackManager.importBuildcache` for a single spec.
   *
   * For now the buildcache URL is informational only — the Spack CLI side
   * (Buildcache.importBuildcache) takes a spec list, not a URL. A future
   * commit will let the agent register a one-shot mirror for the URL,
   * import the spec, then drop the mirror.
   */
  private async handleSpecDistribute(spec: string, _buildcacheUrl: string): Promise<void> {
    if (!this.spackManager?.available) {
      this.logger.warn({ spec }, "SpecDistribute received but spack unavailable on this agent");
      return;
    }
    await this.spackManager.importBuildcache([spec]);
  }

  private async handleSoftwareOperation(
    operationId: string,
    protoAction: SoftwareOperationAction,
    spec: string,
    materials?: SpackMaterialContext,
  ): Promise<void> {
    const normalizedSpec = spec.trim();
    const action = softwareOperationActionToAgent(protoAction);
    if (!action) {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.REJECTED,
        spec: normalizedSpec,
        error: "unsupported software operation action",
      });
      return;
    }
    if (normalizedSpec.length === 0) {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.REJECTED,
        spec: normalizedSpec,
        error: "spec is empty",
      });
      return;
    }
    if (!this.spackManager?.available) {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.FAILED,
        spec: normalizedSpec,
        error: "spack is unavailable on this Agent",
      });
      return;
    }
    const policyRejection = this.spackManager.policyRejectionForOperation(action, normalizedSpec);
    if (policyRejection) {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.REJECTED,
        spec: normalizedSpec,
        error: policyRejection,
      });
      return;
    }
    await this.enqueueSoftwareOperationResult({
      operationId,
      action: protoAction,
      status: SoftwareOperationStatus.RUNNING,
      spec: normalizedSpec,
    });
    let outcome: Awaited<ReturnType<SpackManager["runSoftwareOperation"]>>;
    try {
      outcome = await this.spackManager.runSoftwareOperation(
        action,
        normalizedSpec,
        action === "install" ? materials : undefined,
        this.lifecycleController.signal,
      );
    } catch (err) {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.FAILED,
        spec: normalizedSpec,
        error: this.lifecycleController.signal.aborted
          ? "Software operation cancelled during Agent shutdown"
          : `software operation failed: ${streamErrorMessage(err)}`,
      });
      return;
    }
    if (outcome.outcome === "rejected") {
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.REJECTED,
        spec: normalizedSpec,
        error: outcome.reason,
        stdout: outcome.stdout,
      });
      return;
    }
    if (outcome.outcome === "failed") {
      this.invalidateInstalledSoftware(outcome.invalidatedHashes ?? []);
      await this.enqueueSoftwareOperationResult({
        operationId,
        action: protoAction,
        status: SoftwareOperationStatus.FAILED,
        spec: normalizedSpec,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
      });
      return;
    }
    if (action !== "load") {
      this.setInstalledSoftware(outcome.installed);
    }
    await this.enqueueSoftwareOperationResult({
      operationId,
      action: protoAction,
      status: SoftwareOperationStatus.SUCCEEDED,
      spec: normalizedSpec,
      stdout: outcome.stdout,
      exitCode: 0,
      installed: action === "load" ? [] : outcome.installed,
    });
  }

  private invalidateInstalledSoftware(hashes: string[]): void {
    if (hashes.length === 0 || !this.installedSoftwareKnown) return;
    const invalidated = new Set(hashes);
    this.setInstalledSoftware(
      this.installedSoftware.filter((spec) => !invalidated.has(spec.hash)),
    );
  }

  private enqueueSoftwarePolicyAck(ack: {
    policyVersion: string;
    applied: boolean;
    error?: string;
  }): void {
    if (this.connected) {
      this.outboundQueue.push({
        kind: "softwarePolicyAck",
        policyVersion: ack.policyVersion,
        applied: ack.applied,
        error: ack.error,
      });
      this.signalOutbound();
    } else {
      this.logger.warn(
        { policyVersion: ack.policyVersion },
        "Software policy ack dropped: stream offline",
      );
    }
  }

  private async enqueueSoftwareOperationResult(
    item: Omit<Extract<OutboundItem, { kind: "softwareOperationResult" }>, "kind">,
  ): Promise<void> {
    if (this.running && this.connected) {
      this.outboundQueue.push({ kind: "softwareOperationResult", ...item });
      this.signalOutbound();
    } else if (this.persistentQueue) {
      await this.persistentQueue.enqueueSoftwareOperationResult(item).catch((err) => {
        this.logger.error(
          { err, operationId: item.operationId },
          "Failed to persist software operation result while stream offline",
        );
      });
    } else {
      this.logger.warn(
        { operationId: item.operationId, spec: item.spec },
        "Software operation result dropped: stream offline",
      );
    }
  }
}

function protectedMountsFromExpectedOutputs(
  expectedOutputs: ExpectedOutput[],
): PreparedLicensedMaterialMount[] {
  const unique = new Map<string, PreparedLicensedMaterialMount>();
  for (const output of expectedOutputs) {
    for (const mount of output.protectedMounts ?? []) {
      unique.set(`${mount.targetPath}\0${mount.sourcePath}`, mount);
    }
  }
  return [...unique.values()];
}

function streamErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
