import type {
  QueueFailureCode,
  QueueTargetMode,
  QueueValidationMode,
  SandboxExecutionMode,
  SandboxSelfAccount,
  SandboxTrustedExecutionProfile,
  SchedulerQueueInventory,
} from "@kuintessence/shared";

export interface JobSpec {
  jobId: string;
  name: string;
  command: string;
  cpus: number;
  memoryMb: number;
  gpus: number;
  wallTimeSec: number;
  workingDir: string;
  envVars: Record<string, string>;
  queueName?: string;
  queueTargetMode?: QueueTargetMode;
  queueValidationMode?: QueueValidationMode;
  schedulerName?: string;
  qos?: string;
  stdinText?: string;
  restrictedNoEgress?: boolean;
  dataDeliveryCleanup?: Array<{
    bindingId: string;
    targetPath: string;
    method: "object-download" | "stage-copy" | "readonly-mount";
  }>;
  licensedMaterialCleanup?: Array<{
    selectorId: string;
    targetPath: string;
    sourcePath: string;
  }>;
  sandbox?: SandboxJobSpec;
}

export interface SandboxJobMount {
  descriptor: string;
  ioType: "Text" | "JSON" | "File" | "FileBatch";
  mode: "ReadOnly" | "WriteOnly";
  hostPath: string;
  relativePath: string;
  containerPath: string;
  expectedSha256?: string;
  inlineContentBase64?: string;
  batchEntries?: Array<{ relativePath: string; sha256: string; sizeBytes: number }>;
  sizeLimitBytes: number;
  required: boolean;
}

export type SandboxJobIdentity =
  | {
      mode: "SharedService" | "MappedAccount";
      backend: "Unix";
      accountId: string;
      username: string;
      uid: number;
      gid: number;
      schedulerAccount?: string;
      allowedQueues: string[];
    }
  | {
      mode: "SharedService" | "MappedAccount";
      backend: "Kubernetes";
      accountId: string;
      namespace: string;
      serviceAccount: string;
      quotaPolicy?: string;
    };

export interface SandboxJobSpec {
  language: "python" | "nodejs" | "bash";
  entrypoint: string;
  scriptContent: string;
  scriptHostPath: string;
  contextHostPath: string;
  runtimeKind: "OCI" | "SIF";
  runtimePath: string;
  executionMode: SandboxExecutionMode;
  runtimeAttestationId?: string;
  selfAccount?: SandboxSelfAccount;
  /** Bound only during trusted restricted-profile materialization. */
  apptainerPath?: string;
  /** Bound only from a locally attested immutable seccomp profile. */
  seccompProfilePath?: string;
  /** Scheduler nodes that have passed the runtime attestation probe. */
  attestedNodes?: string[];
  /** Signed immutable identity; never completed or replaced by the Agent. */
  executionProfile?: SandboxTrustedExecutionProfile;
  identity: SandboxJobIdentity;
  mounts: SandboxJobMount[];
  limits: { pids: number; outputBytes: number; logBytes: number };
  kubernetesArtifactPvc?: string;
}

export interface JobResult {
  schedulerJobId: string;
}

export interface QueueTargetValidation {
  targetMode: QueueTargetMode;
  queueName?: string;
}

export type QueueTargetValidationResult =
  | { accepted: true; resolvedQueueName: string }
  | { accepted: false; failureCode: QueueFailureCode };

export class QueueValidationError extends Error {
  constructor(readonly failureCode: QueueFailureCode) {
    super("Scheduler queue validation failed");
    this.name = "QueueValidationError";
  }
}

export class SchedulerSubmissionError extends Error {
  readonly failureCode = "SCHEDULER_SUBMIT_FAILED" as const;

  constructor(message = "Scheduler submission failed") {
    super(message);
    this.name = "SchedulerSubmissionError";
  }
}

export function isSchedulerQueueName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

export interface JobStatusResult {
  status: "queued" | "running" | "completed" | "failed";
  exitCode?: number;
  message?: string;
  /** Allocated node / node-list when the scheduler reports it (e.g. Slurm
   *  `nodes`). Optional — adapters that can't surface it leave it undefined. */
  node?: string;
  /** ISO start time when the scheduler reports it (e.g. Slurm `start_time`).
   *  Optional — undefined for not-yet-started jobs or adapters that omit it. */
  startedAt?: string;
  /** Scheduler-reported reason a job is pending/blocked (e.g. Slurm
   *  `state_reason` = "Resources"/"Priority"). Undefined when not meaningful. */
  reason?: string;
}

export const COMPUTE_HEALTH_CLI_TIMEOUT_MS = 10_000;

export type ComputeHealthState = "unknown" | "ready" | "unavailable";

export const COMPUTE_HEALTH_REASONS = [
  "scheduler_unavailable",
  "scheduler_command_failed",
  "no_operational_nodes",
  "invalid_scheduler_state",
  "unsupported_scheduler",
  "probe_timeout",
  "unknown",
] as const;

export type ComputeHealthReason = (typeof COMPUTE_HEALTH_REASONS)[number];

/** A scheduler-controller observation, separate from Server-Agent transport health. */
export interface ComputeHealthObservation {
  state: ComputeHealthState;
  observedAtUnixMs: number;
  nodeCount: number;
  operationalNodeCount: number;
  reason?: ComputeHealthReason;
}

export function unknownComputeHealth(reason: ComputeHealthReason): ComputeHealthObservation {
  return {
    state: "unknown",
    observedAtUnixMs: Date.now(),
    nodeCount: 0,
    operationalNodeCount: 0,
    reason,
  };
}

export function observedComputeHealth(
  nodeCount: number,
  operationalNodeCount: number,
): ComputeHealthObservation {
  return operationalNodeCount > 0
    ? {
        state: "ready",
        observedAtUnixMs: Date.now(),
        nodeCount,
        operationalNodeCount,
      }
    : {
        state: "unavailable",
        observedAtUnixMs: Date.now(),
        nodeCount,
        operationalNodeCount: 0,
        reason: "no_operational_nodes",
      };
}

/** Extract distinct host names from a PBS/Torque `exec_host` string like
 *  "node01/0*4+node02/0*4" or "node01/0+node01/1+node02/0" → "node01,node02".
 *  Undefined when absent/empty. Shared by the PBS Pro and Torque adapters. */
export function parseExecHost(execHost: string | undefined): string | undefined {
  if (!execHost?.trim()) return undefined;
  const hosts = execHost
    .split("+")
    .map((chunk) => chunk.split("/")[0]?.trim())
    .filter((h): h is string => !!h);
  const distinct = [...new Set(hosts)];
  return distinct.length > 0 ? distinct.join(",") : undefined;
}

/** HH:MM:SS wall-time formatting shared by the Slurm/PBS/Torque adapters. */
export function formatWallTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Append the shared submit-script tail (env exports + the command) and
 *  return the joined script. Single-quote values are shell-escaped. */
export function appendEnvAndCommand(lines: string[], spec: JobSpec): string {
  lines.push("");
  if (!spec.sandbox) {
    for (const [k, v] of Object.entries(spec.envVars)) {
      const escaped = v.replace(/'/g, `'\\''`);
      lines.push(`export ${k}='${escaped}'`);
    }
  }
  lines.push("");
  lines.push(
    spec.sandbox ? buildApptainerSandboxCommand(spec.sandbox) : commandWithOptionalStdin(spec),
  );
  return lines.join("\n");
}

export function schedulerCommand(spec: JobSpec, command: string[]): string[] {
  const sandbox = spec.sandbox;
  const identity = sandbox?.identity;
  if (!identity || identity.backend !== "Unix") return command;
  if (identity.uid <= 0 || identity.gid <= 0) {
    throw new Error("Sandbox execution account cannot use uid/gid 0");
  }
  if (spec.queueName && !identity.allowedQueues.includes(spec.queueName)) {
    throw new Error(`Sandbox execution account is not entitled to queue ${spec.queueName}`);
  }
  if (sandbox.executionMode === "SelfAccount") {
    assertSelfAccountSubmission(sandbox);
    return command;
  }
  return [
    "setpriv",
    `--reuid=${identity.uid}`,
    `--regid=${identity.gid}`,
    "--init-groups",
    "--",
    ...command,
  ];
}

function isCanonicalAbsolutePath(value: string | undefined): value is string {
  return !!value && /^\/[^\0\r\n ]+$/.test(value) && !value.split("/").includes("..");
}

function assertSelfAccountSubmission(sandbox: SandboxJobSpec): void {
  const identity = sandbox.identity;
  const selfAccount = sandbox.selfAccount;
  if (
    identity.backend !== "Unix" ||
    identity.mode !== "MappedAccount" ||
    !selfAccount ||
    selfAccount.uid <= 0 ||
    selfAccount.gid <= 0 ||
    identity.username !== selfAccount.username ||
    identity.uid !== selfAccount.uid ||
    identity.gid !== selfAccount.gid ||
    !/^[0-9a-f]{64}$/.test(sandbox.runtimeAttestationId ?? "") ||
    !isCanonicalAbsolutePath(sandbox.apptainerPath) ||
    !isCanonicalAbsolutePath(sandbox.seccompProfilePath) ||
    !sandbox.attestedNodes?.length ||
    sandbox.attestedNodes.some((node) => !/^[A-Za-z0-9._-]{1,255}$/.test(node)) ||
    sandbox.executionProfile
  ) {
    throw new Error("SelfAccount Sandbox submission does not match local execution facts");
  }
}

export function assertSandboxSchedulerMetadata(spec: JobSpec): void {
  if (spec.queueName && !isSchedulerQueueName(spec.queueName)) {
    throw new QueueValidationError("QUEUE_NOT_FOUND");
  }
  if (spec.restrictedNoEgress) {
    if (!spec.sandbox) {
      throw new Error("Restricted no-egress jobs require a verified trusted execution profile");
    }
    if (spec.sandbox.runtimeKind !== "SIF") {
      throw new Error("Restricted no-egress jobs require a pinned SIF execution profile");
    }
    if (!spec.sandbox.apptainerPath?.startsWith("/")) {
      throw new Error("Restricted no-egress jobs require a verified absolute Apptainer path");
    }
    const profile = spec.sandbox.executionProfile;
    if (!profile) {
      throw new Error("Restricted no-egress jobs require a signed trusted wrapper profile");
    }
    if (
      spec.sandbox.apptainerPath !== profile.apptainerCanonicalPath ||
      spec.sandbox.runtimePath !== profile.sifCanonicalPath ||
      spec.sandbox.runtimeKind !== "SIF"
    ) {
      throw new Error("Restricted no-egress job execution profile was altered after verification");
    }
    if (
      spec.sandbox.identity.backend !== "Unix" ||
      spec.sandbox.identity.mode !== "MappedAccount"
    ) {
      throw new Error("Restricted no-egress jobs require a mapped Unix execution identity");
    }
    if (spec.sandbox.mounts.some((mount) => mount.mode === "WriteOnly")) {
      throw new Error("Restricted no-egress jobs cannot expose writable output mounts");
    }
  }
  if (!spec.sandbox) return;
  if (spec.sandbox.executionMode === "SelfAccount") {
    assertSelfAccountSubmission(spec.sandbox);
  }
  const token = /^[A-Za-z0-9._-]{1,128}$/;
  if (!token.test(spec.schedulerName ?? spec.name)) {
    throw new Error("Sandbox job name is not scheduler-safe");
  }
  for (const [field, value] of [
    ["queue", spec.queueName],
    ["qos", spec.qos],
    [
      "scheduler account",
      spec.sandbox.identity.backend === "Unix" ? spec.sandbox.identity.schedulerAccount : undefined,
    ],
  ] as const) {
    if (value && !token.test(value)) throw new Error(`Sandbox ${field} is not scheduler-safe`);
  }
}

export function sandboxInterpreter(language: SandboxJobSpec["language"]): string {
  if (language === "python") return "/usr/bin/python3";
  if (language === "nodejs") return "/usr/bin/node";
  return "/bin/bash";
}

export function buildApptainerSandboxArgv(sandbox: SandboxJobSpec): string[] {
  if (sandbox.runtimeKind !== "SIF") throw new Error("HPC Sandbox requires a SIF runtime");
  const selfAccount = sandbox.executionMode === "SelfAccount";
  if (selfAccount) assertSelfAccountSubmission(sandbox);
  const hostPaths = [
    sandbox.scriptHostPath,
    sandbox.contextHostPath,
    ...sandbox.mounts.map((mount) => mount.hostPath),
  ];
  if (hostPaths.some((path) => !path.startsWith("/") || /[:,\r\n]/.test(path))) {
    throw new Error("Sandbox bind paths must be absolute managed paths without bind separators");
  }
  const binds = [
    `${sandbox.scriptHostPath}:/kq/script/${sandbox.entrypoint}:ro`,
    `${sandbox.contextHostPath}:/kq/context.json:ro`,
    ...sandbox.mounts.map(
      (mount) =>
        `${mount.hostPath}:${mount.containerPath}${mount.mode === "ReadOnly" ? ":ro" : ":rw"}`,
    ),
  ];
  return [
    selfAccount ? (sandbox.apptainerPath as string) : (sandbox.apptainerPath ?? "apptainer"),
    "exec",
    "--containall",
    "--cleanenv",
    "--no-home",
    "--no-eval",
    "--no-mount",
    "hostfs,cwd,home",
    "--net",
    "--network",
    "none",
    "--drop-caps",
    "all",
    "--security",
    selfAccount ? `no-new-privs,seccomp:${sandbox.seccompProfilePath}` : "no-new-privs",
    "--pwd",
    "/kq",
    ...binds.flatMap((bind) => ["--bind", bind]),
    sandbox.runtimePath,
    sandboxInterpreter(sandbox.language),
    `/kq/script/${sandbox.entrypoint}`,
  ];
}

export function buildApptainerSandboxCommand(sandbox: SandboxJobSpec): string {
  const fileBlocks = Math.max(1, Math.ceil(sandbox.limits.outputBytes / 512));
  const apptainerArgv = buildApptainerSandboxArgv(sandbox);
  const argv = buildTrustedSandboxArgv(sandbox, apptainerArgv).map(shellQuote).join(" ");
  return `set -o pipefail; (ulimit -u ${sandbox.limits.pids}; ulimit -f ${fileBlocks}; exec ${argv}) 2>&1 | head -c ${sandbox.limits.logBytes}`;
}

export function buildTrustedSandboxArgv(
  sandbox: SandboxJobSpec,
  apptainerArgv: string[],
): string[] {
  const profile = sandbox.executionProfile;
  if (!profile) return apptainerArgv;
  if (
    apptainerArgv[0] !== profile.apptainerCanonicalPath ||
    sandbox.runtimePath !== profile.sifCanonicalPath
  ) {
    throw new Error("Sandbox trusted execution profile does not match the rendered argv");
  }
  return [
    profile.trustedWrapperCanonicalPath,
    "--profile-id",
    profile.profileId,
    "--apptainer-path",
    profile.apptainerCanonicalPath,
    "--apptainer-sha256",
    profile.apptainerSha256,
    "--sif-path",
    profile.sifCanonicalPath,
    "--sif-sha256",
    profile.sifSha256,
    "--wrapper-sha256",
    profile.trustedWrapperSha256,
    "--",
    ...apptainerArgv,
  ];
}

export function commandWithOptionalStdin(spec: JobSpec): string {
  if (spec.stdinText === undefined) {
    return spec.command;
  }
  const stdinPath = `.kq-stdin-${spec.jobId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const delimiter = heredocDelimiter(spec.stdinText, spec.jobId);
  return [
    `cat > ${shellQuote(stdinPath)} <<'${delimiter}'`,
    spec.stdinText,
    delimiter,
    `sh -c ${shellQuote(spec.command)} < ${shellQuote(stdinPath)}`,
  ].join("\n");
}

function heredocDelimiter(value: string, jobId: string): string {
  const base = `__KQ_STDIN_${jobId.replace(/[^A-Za-z0-9_]/g, "_")}__`;
  let delimiter = base;
  let i = 0;
  while (value.split("\n").includes(delimiter)) {
    i += 1;
    delimiter = `${base}_${i}`;
  }
  return delimiter;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isRetainedSchedulerLogJobId(value: string | undefined): value is string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value ?? "",
  );
}

export class JobLogUnavailableError extends Error {
  constructor() {
    super("Job log file is not available");
    this.name = "JobLogUnavailableError";
  }
}

/** A job as enumerated from the scheduler's own queue (e.g. `squeue`). Used by
 *  the all-in-one TUI's local backend, which has no Server database to list from. */
export interface ListedJob {
  schedulerJobId: string;
  name: string;
  status: JobStatusResult["status"];
  queue?: string;
  submittedAt?: string;
}

/** Scheduler-specific context retained with a pre-submit cleanup intent. */
export interface KuintessenceJobLookup {
  jobId: string;
  schedulerName?: string;
  schedulerAccount?: string;
  namespace?: string;
}

/**
 * A crash-recovery lookup must distinguish a confirmed miss from an
 * unavailable or ambiguous scheduler response. Callers must fail closed on
 * `indeterminate`.
 */
export type KuintessenceJobLookupResult =
  | { status: "found"; schedulerJobId: string }
  | { status: "not_found" }
  | { status: "indeterminate"; reason: string };

/**
 * Minimal abstraction over Bun.spawn for testability.
 * Production: real Bun.spawn. Tests: mock implementation.
 */
export interface Spawner {
  run(
    command: string[],
    options?: { cwd?: string; timeoutMs?: number; stdin?: string },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export const realSpawner: Spawner = {
  async run(cmd, options) {
    const proc = Bun.spawn(cmd, {
      stdin: options?.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
      timeout: options?.timeoutMs,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  },
};

export interface SchedulerAdapter {
  readonly type: string;
  readonly version: string;

  submit(spec: JobSpec): Promise<JobResult>;
  cancel(schedulerJobId: string): Promise<void>;
  status(schedulerJobId: string): Promise<JobStatusResult>;

  inspectQueues?(): Promise<SchedulerQueueInventory>;
  validateQueueTarget?(target: QueueTargetValidation): Promise<QueueTargetValidationResult>;

  /**
   * Observe whether the scheduler control plane has any operational compute
   * node. Omitted by legacy/custom adapters; the stream reports unknown.
   */
  inspectComputeHealth?(): Promise<ComputeHealthObservation>;

  /**
   * Enumerate the current user's jobs from the scheduler queue. Optional —
   * not every scheduler exposes cheap enumeration. When absent, the all-in-one
   * TUI reports that local listing is unsupported for that scheduler type.
   */
  listJobs?(): Promise<ListedJob[]>;

  /** Find a submitted job through the scheduler's durable Kuintessence UUID metadata. */
  findByKuintessenceJobId?(lookup: KuintessenceJobLookup): Promise<KuintessenceJobLookupResult>;

  /**
   * Tail a job's stdout. The optional Server job id lets an adapter recover a
   * deterministic retained path after the scheduler purges its job record.
   */
  getJobLogs?(schedulerJobId: string, lines: number, jobId?: string): Promise<string>;
  prepareResume?(spec: JobSpec, schedulerJobId: string): void | Promise<void>;
  releaseJob?(schedulerJobId: string): void | Promise<void>;
  stageSandboxInputs?(sandbox: SandboxJobSpec, jobId: string): Promise<void>;
  stageSandboxOutputs?(sandbox: SandboxJobSpec, schedulerJobId: string): Promise<void>;
}
