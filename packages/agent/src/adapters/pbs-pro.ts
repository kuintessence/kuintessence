import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  type SchedulerQueueFact,
  type SchedulerQueueInventory,
} from "@kuintessence/shared";
import {
  appendEnvAndCommand,
  assertSandboxSchedulerMetadata,
  COMPUTE_HEALTH_CLI_TIMEOUT_MS,
  type ComputeHealthObservation,
  formatWallTime as formatWallTimeShared,
  isRetainedSchedulerLogJobId,
  type JobResult,
  type JobSpec,
  type JobStatusResult,
  type KuintessenceJobLookup,
  type KuintessenceJobLookupResult,
  type ListedJob,
  observedComputeHealth,
  parseExecHost,
  type QueueTargetValidation,
  type QueueTargetValidationResult,
  realSpawner,
  type SchedulerAdapter,
  SchedulerSubmissionError,
  type Spawner,
  schedulerCommand,
  shellQuote,
  unknownComputeHealth,
} from "./base";
import {
  availableQueueInventory,
  SchedulerQueueInventoryCache,
  unavailableQueueInventory,
  validateQueueTarget,
} from "./queue-inventory";

const logger = createLogger("pbs-pro-adapter");

const PBS_OPERATIONAL_NODE_STATES = new Set([
  "free",
  "job-exclusive",
  "job-sharing",
  "busy",
  "resv-exclusive",
  "resv-sharing",
]);
const PBS_NON_OPERATIONAL_NODE_STATES = new Set([
  "down",
  "offline",
  "state-unknown",
  "maintenance",
  "unresolvable",
  "provisioning",
  "wait-provisioning",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pbsNodeIsOperational(value: string): boolean | undefined {
  const states = value
    .split(",")
    .map((state) => state.trim().toLowerCase())
    .filter((state) => state.length > 0);
  if (states.length === 0) return undefined;
  if (states.some((state) => PBS_NON_OPERATIONAL_NODE_STATES.has(state))) return false;
  return states.some((state) => PBS_OPERATIONAL_NODE_STATES.has(state)) ? true : undefined;
}

function parsePbsProComputeHealth(
  output: string,
): { nodeCount: number; operationalNodeCount: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.nodes)) return undefined;

  let operationalNodeCount = 0;
  const nodes = Object.values(parsed.nodes);
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.state !== "string") return undefined;
    const operational = pbsNodeIsOperational(node.state);
    if (operational === undefined) return undefined;
    if (operational) operationalNodeCount += 1;
  }
  return { nodeCount: nodes.length, operationalNodeCount };
}

function pbsQueueBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function pbsQueueState(
  enabled: boolean | undefined,
  started: boolean | undefined,
): SchedulerQueueFact["state"] {
  if (enabled === true && started === true) return "up";
  if (enabled === false || started === false) return "down";
  return "unknown";
}

function pbsQueueType(value: unknown): SchedulerQueueFact["queueType"] {
  if (typeof value !== "string") return "unknown";
  if (value.toLowerCase() === "execution") return "execution";
  if (value.toLowerCase() === "route") return "route";
  return "unknown";
}

function parsePbsDefaultQueue(output: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const servers = parsed.Server ?? parsed.server;
  if (!isRecord(servers)) return null;
  const defaults = new Set<string>();
  for (const server of Object.values(servers)) {
    if (!isRecord(server)) return null;
    const value = server.default_queue;
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) return null;
    defaults.add(value);
  }
  return defaults.size > 1 ? null : [...defaults][0];
}

function parsePbsProQueueInventory(
  serverOutput: string,
  queueOutput: string,
  observedAt = new Date(),
): SchedulerQueueInventory {
  const defaultQueueName = parsePbsDefaultQueue(serverOutput);
  if (defaultQueueName === null) return unavailableQueueInventory("invalid_output", observedAt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(queueOutput) as unknown;
  } catch {
    return unavailableQueueInventory("invalid_output", observedAt);
  }
  if (!isRecord(parsed)) return unavailableQueueInventory("invalid_output", observedAt);
  const sourceQueues = parsed.Queue ?? parsed.queue;
  if (!isRecord(sourceQueues)) return unavailableQueueInventory("invalid_output", observedAt);

  const queues: SchedulerQueueFact[] = [];
  for (const [queueName, rawQueue] of Object.entries(sourceQueues)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(queueName) || !isRecord(rawQueue)) {
      return unavailableQueueInventory("invalid_output", observedAt);
    }
    const enabled = pbsQueueBoolean(rawQueue.enabled);
    const started = pbsQueueBoolean(rawQueue.started);
    const state = pbsQueueState(enabled, started);
    const hasComputeTargets = pbsQueueBoolean(rawQueue.hasnodes);
    queues.push({
      queueName,
      queueType: pbsQueueType(rawQueue.queue_type),
      isDefault: queueName === defaultQueueName,
      state,
      acceptsSubmissions: state === "up",
      ...(hasComputeTargets === undefined ? {} : { hasComputeTargets }),
      observedAt,
    });
  }
  return availableQueueInventory(queues, observedAt);
}

function hasKuintessenceJobId(value: unknown, jobId: string): boolean {
  if (typeof value === "string") {
    return value.split(",").some((entry) => entry.trim() === `KQ_JOB_ID=${jobId}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>).KQ_JOB_ID === jobId;
  }
  return false;
}

/** Map a PBS Pro single-letter job state to a listing status (no exit code). */
function mapPbsStateName(state: string): ListedJob["status"] {
  if (["Q", "H", "W", "T", "M", "B"].includes(state)) return "queued";
  if (["R", "E", "S", "U"].includes(state)) return "running";
  if (state === "F") return "completed";
  return "failed";
}

export interface PbsProAdapterDeps {
  spawner?: Spawner;
  logDir?: string;
  queueInventoryRefreshMs?: number;
  queueInventoryTimeoutMs?: number;
}

export class PbsProAdapter implements SchedulerAdapter {
  readonly type = "pbs-pro";
  private spawner: Spawner;
  private logDir: string;
  private queueInventoryTimeoutMs: number;
  private queueInventoryCache: SchedulerQueueInventoryCache;

  constructor(
    readonly version: string,
    deps: PbsProAdapterDeps = {},
  ) {
    this.spawner = deps.spawner ?? realSpawner;
    this.logDir = deps.logDir ?? tmpdir();
    this.queueInventoryTimeoutMs = deps.queueInventoryTimeoutMs ?? COMPUTE_HEALTH_CLI_TIMEOUT_MS;
    this.queueInventoryCache = new SchedulerQueueInventoryCache(
      deps.queueInventoryRefreshMs ?? 120_000,
    );
  }

  formatWallTime(seconds: number): string {
    return formatWallTimeShared(seconds);
  }

  buildSubmitScript(spec: JobSpec): string {
    assertSandboxSchedulerMetadata(spec);
    const lines: string[] = ["#!/bin/bash"];
    const executionRoot = spec.workingDir || this.logDir;
    lines.push(`#PBS -N ${spec.schedulerName ?? spec.name}`);
    lines.push(`#PBS -v KQ_JOB_ID=${spec.jobId}`);
    lines.push(`#PBS -o ${join(executionRoot, `kq-pbs-${spec.jobId}.out`)}`);
    lines.push(`#PBS -e ${join(executionRoot, `kq-pbs-${spec.jobId}.err`)}`);
    const select = `select=1:ncpus=${spec.cpus}:mem=${spec.memoryMb}mb${
      spec.gpus > 0 ? `:ngpus=${spec.gpus}` : ""
    }`;
    lines.push(`#PBS -l ${select}`);
    if (spec.queueName) {
      lines.push(`#PBS -q ${spec.queueName}`);
    }
    if (spec.qos) {
      lines.push(`#PBS -l qos=${spec.qos}`);
    }
    if (spec.sandbox?.identity.backend === "Unix" && spec.sandbox.identity.schedulerAccount) {
      lines.push(`#PBS -A ${spec.sandbox.identity.schedulerAccount}`);
    }
    if (spec.wallTimeSec > 0) {
      lines.push(`#PBS -l walltime=${this.formatWallTime(spec.wallTimeSec)}`);
    }
    lines.push(`cd -- ${shellQuote(executionRoot)} || exit 1`);
    return appendEnvAndCommand(lines, spec);
  }

  async submit(spec: JobSpec): Promise<JobResult> {
    const script = this.buildSubmitScript(spec);
    const command = schedulerCommand(spec, ["qsub"]);
    try {
      const { exitCode, stdout, stderr } = await this.spawner.run(command, { stdin: script });
      if (exitCode !== 0) {
        logger.warn(
          { jobId: spec.jobId, exitCode, stderr: stderr.trim() },
          "PBS Pro submission rejected",
        );
        throw new SchedulerSubmissionError("qsub failed");
      }
      // PBS Pro output: "12345.server" — take first whitespace-delimited token
      const schedulerJobId = stdout.trim().split(/\s+/)[0] ?? "";
      if (!schedulerJobId) {
        logger.warn({ jobId: spec.jobId }, "PBS Pro submission returned no job id");
        throw new SchedulerSubmissionError("qsub returned no job id");
      }
      logger.info({ jobId: spec.jobId, schedulerJobId }, "Job submitted to PBS Pro");
      return { schedulerJobId };
    } catch (err) {
      if (err instanceof SchedulerSubmissionError) throw err;
      logger.warn({ jobId: spec.jobId, err }, "PBS Pro submission command failed");
      throw new SchedulerSubmissionError("qsub failed");
    }
  }

  async inspectQueues(): Promise<SchedulerQueueInventory> {
    return this.queueInventoryCache.inspect(() => this.inspectQueuesNow());
  }

  async validateQueueTarget(target: QueueTargetValidation): Promise<QueueTargetValidationResult> {
    return validateQueueTarget(await this.inspectQueuesNow(), target);
  }

  private async inspectQueuesNow(): Promise<SchedulerQueueInventory> {
    try {
      const server = await this.spawner.run(["qstat", "-Bf", "-F", "json"], {
        timeoutMs: this.queueInventoryTimeoutMs,
      });
      if (server.exitCode !== 0) return unavailableQueueInventory("command_failed");
      const queues = await this.spawner.run(["qstat", "-Qf", "-F", "json"], {
        timeoutMs: this.queueInventoryTimeoutMs,
      });
      if (queues.exitCode !== 0) return unavailableQueueInventory("command_failed");
      return parsePbsProQueueInventory(server.stdout, queues.stdout);
    } catch {
      return unavailableQueueInventory("command_failed");
    }
  }

  async cancel(schedulerJobId: string): Promise<void> {
    const { exitCode, stderr } = await this.spawner.run(["qdel", schedulerJobId]);
    if (exitCode !== 0) {
      throw new Error(`qdel failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  }

  async inspectComputeHealth(): Promise<ComputeHealthObservation> {
    try {
      const result = await this.spawner.run(["pbsnodes", "-a", "-F", "json"], {
        timeoutMs: COMPUTE_HEALTH_CLI_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return unknownComputeHealth("scheduler_command_failed");
      const parsed = parsePbsProComputeHealth(result.stdout);
      return parsed
        ? observedComputeHealth(parsed.nodeCount, parsed.operationalNodeCount)
        : unknownComputeHealth("invalid_scheduler_state");
    } catch {
      return unknownComputeHealth("scheduler_command_failed");
    }
  }

  async findByKuintessenceJobId(
    lookup: KuintessenceJobLookup,
  ): Promise<KuintessenceJobLookupResult> {
    try {
      const { exitCode, stdout, stderr } = await this.spawner.run(["qstat", "-f", "-F", "json"]);
      if (exitCode !== 0) {
        return { status: "indeterminate", reason: `qstat failed: ${stderr.trim()}` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return { status: "indeterminate", reason: "qstat returned non-JSON output" };
      }
      const jobs = (parsed as { Jobs?: Record<string, { Variable_List?: unknown }> }).Jobs;
      if (!jobs) return { status: "not_found" };
      const matches = Object.entries(jobs).filter(([, job]) =>
        hasKuintessenceJobId(job.Variable_List, lookup.jobId),
      );
      if (matches.length === 0) return { status: "not_found" };
      if (matches.length !== 1) {
        return { status: "indeterminate", reason: "multiple PBS Pro jobs share Kuintessence UUID" };
      }
      const schedulerJobId = matches[0]?.[0];
      if (!schedulerJobId) {
        return { status: "indeterminate", reason: "PBS Pro lookup returned an invalid job id" };
      }
      return { status: "found", schedulerJobId };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : "PBS Pro lookup failed",
      };
    }
  }

  async getJobLogs(schedulerJobId: string, lines: number, jobId?: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = await this.queryJob(schedulerJobId);
    } catch (error) {
      if (isRetainedSchedulerLogJobId(jobId)) {
        const persistedLog = await this.spawner.run([
          "tail",
          "-n",
          String(lines),
          join(this.logDir, `kq-pbs-${jobId}.out`),
        ]);
        if (persistedLog.exitCode === 0) return persistedLog.stdout;
      }
      throw error;
    }
    const data = parsed as { Jobs?: Record<string, { Output_Path?: string }> };
    const jobs = data.Jobs ?? {};
    const job = jobs[schedulerJobId] ?? Object.values(jobs)[0];
    const raw = job?.Output_Path;
    if (!raw) return "";
    // Output_Path is "host:/abs/path" — on the login node the path is local.
    const path = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const tail = await this.spawner.run(["tail", "-n", String(lines), path]);
    if (tail.exitCode !== 0) {
      return "(job output not available yet — PBS spools stdout until the job completes)";
    }
    return tail.stdout;
  }

  async listJobs(): Promise<ListedJob[]> {
    const { exitCode, stdout, stderr } = await this.spawner.run(["qstat", "-f", "-F", "json"]);
    if (exitCode !== 0) {
      throw new Error(`qstat failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    if (!stdout.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("qstat returned non-JSON output");
    }
    const data = parsed as {
      Jobs?: Record<
        string,
        { Job_Name?: string; job_state?: string; queue?: string; qtime?: string }
      >;
    };
    return Object.entries(data.Jobs ?? {}).map(([id, job]) => ({
      schedulerJobId: id,
      name: job.Job_Name ?? "",
      status: mapPbsStateName(job.job_state ?? ""),
      queue: job.queue,
      submittedAt: job.qtime,
    }));
  }

  async status(schedulerJobId: string): Promise<JobStatusResult> {
    let parsed: unknown;
    try {
      parsed = await this.queryJob(schedulerJobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "qstat returned no data";
      return { status: "failed", message };
    }
    const data = parsed as {
      Jobs?: Record<
        string,
        { job_state?: string; Exit_status?: number; exec_host?: string; comment?: string }
      >;
    };
    const jobs = data.Jobs ?? {};
    const job = jobs[schedulerJobId] ?? Object.values(jobs)[0];
    if (!job) return { status: "failed", message: "job not found" };

    const state = job.job_state ?? "";
    const node = parseExecHost(job.exec_host);
    const reason = job.comment?.trim() || undefined;
    const withNode = (r: JobStatusResult): JobStatusResult => ({
      ...r,
      ...(node ? { node } : {}),
      ...(reason ? { reason } : {}),
    });
    // PBS Pro states. Non-terminal states beyond Q/H must NOT be reported as
    // failed, or the runner kills a job that is still pending/running:
    //   Q queued · H held · W waiting (deferred start) · T transiting · M moved
    //   B begun (array parent) · R running · E exiting · S/U suspended · F finished
    if (["Q", "H", "W", "T", "M", "B"].includes(state)) return withNode({ status: "queued" });
    if (["R", "E", "S", "U"].includes(state)) return withNode({ status: "running" });
    if (state === "F") {
      const exitStatus = job.Exit_status ?? 0;
      if (exitStatus === 0) return withNode({ status: "completed", exitCode: 0 });
      return withNode({ status: "failed", exitCode: exitStatus, message: `Exit ${exitStatus}` });
    }
    return withNode({ status: "failed", message: `State: ${state}` });
  }

  private async queryJob(schedulerJobId: string): Promise<unknown> {
    const primary = await this.runQstat(["qstat", "-f", "-F", "json", schedulerJobId]);
    if (primary.ok) return primary.parsed;
    const historical = await this.runQstat(["qstat", "-x", "-f", "-F", "json", schedulerJobId]);
    if (historical.ok) return historical.parsed;
    throw new Error(historical.message ?? primary.message ?? "qstat returned no data");
  }

  private async runQstat(
    command: string[],
  ): Promise<{ ok: true; parsed: unknown } | { ok: false; message: string }> {
    const { exitCode, stdout, stderr } = await this.spawner.run(command);
    if (exitCode !== 0 || !stdout.trim()) {
      return { ok: false, message: `qstat returned no data: ${stderr.trim()}` };
    }
    try {
      return { ok: true, parsed: JSON.parse(stdout) as unknown };
    } catch {
      return { ok: false, message: "qstat returned non-JSON output" };
    }
  }
}
