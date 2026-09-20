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
  JobLogUnavailableError,
  type JobResult,
  type JobSpec,
  type JobStatusResult,
  type KuintessenceJobLookup,
  type KuintessenceJobLookupResult,
  type ListedJob,
  observedComputeHealth,
  type QueueTargetValidation,
  type QueueTargetValidationResult,
  realSpawner,
  type SchedulerAdapter,
  SchedulerSubmissionError,
  type Spawner,
  schedulerCommand,
  unknownComputeHealth,
} from "./base";
import {
  availableQueueInventory,
  SchedulerQueueInventoryCache,
  unavailableQueueInventory,
  validateQueueTarget,
} from "./queue-inventory";

const logger = createLogger("slurm-adapter");

/** Slurm job-state names that are NOT terminal — the runner must keep polling
 *  rather than report failure. CONFIGURING/REQUEUED-family are pre-run; the
 *  rest are running phases (COMPLETING is on every job's normal path). */
const SLURM_QUEUED = new Set([
  "PENDING",
  "CONFIGURING",
  "REQUEUED",
  "REQUEUE_HOLD",
  "REQUEUE_FED",
  "RESV_DEL_HOLD",
]);
const SLURM_RUNNING = new Set([
  "RUNNING",
  "COMPLETING",
  "SUSPENDED",
  "STAGE_OUT",
  "RESIZING",
  "SIGNALING",
]);
const SLURM_OPERATIONAL_NODE_STATES = new Set([
  "IDLE",
  "MIXED",
  "ALLOCATED",
  "COMPLETING",
  "RUNNING",
  "RESERVED",
]);
const SLURM_NON_OPERATIONAL_NODE_STATES = new Set([
  "DOWN",
  "DRAIN",
  "DRAINING",
  "DRAINED",
  "FAIL",
  "FAILING",
  "FAILED",
  "UNKNOWN",
  "NO_RESPOND",
  "NOT_RESPONDING",
  "FUTURE",
  "MAINT",
  "POWER_DOWN",
  "POWERED_DOWN",
  "POWERING_DOWN",
  "POWERING_UP",
]);

function slurmField(line: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1];
}

function slurmHostlistCount(value: string): number | undefined {
  if (value.includes("]") && !value.includes("[")) return undefined;
  const brackets = [...value.matchAll(/\[([^\]]+)\]/g)];
  if (brackets.length === 0) return value.includes("[") ? undefined : 1;

  let count = 1;
  for (const bracket of brackets) {
    const members = bracket[1]?.split(",") ?? [];
    if (members.length === 0) return undefined;
    let groupCount = 0;
    for (const member of members) {
      const range = /^(\d+)-(\d+)$/.exec(member);
      if (range) {
        const start = Number.parseInt(range[1] ?? "", 10);
        const end = Number.parseInt(range[2] ?? "", 10);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
          return undefined;
        }
        groupCount += end - start + 1;
      } else if (/^\d+$/.test(member)) {
        groupCount += 1;
      } else {
        return undefined;
      }
    }
    if (!Number.isSafeInteger(groupCount) || groupCount === 0) return undefined;
    count *= groupCount;
    if (!Number.isSafeInteger(count)) return undefined;
  }
  return count;
}

function slurmNodeIsOperational(value: string): boolean | undefined {
  const states = value
    .toUpperCase()
    .split(/[+*]/)
    .filter((state) => state.length > 0);
  if (states.length === 0) return undefined;
  if (states.some((state) => SLURM_NON_OPERATIONAL_NODE_STATES.has(state))) return false;
  return states.some((state) => SLURM_OPERATIONAL_NODE_STATES.has(state)) ? true : undefined;
}

function parseSlurmComputeHealth(
  output: string,
): { nodeCount: number; operationalNodeCount: number } | undefined {
  let nodeCount = 0;
  let operationalNodeCount = 0;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const nodeName = slurmField(line, "NodeName");
    if (!nodeName) return undefined;
    if (nodeName === "DEFAULT") continue;
    const state = slurmField(line, "State");
    const count = slurmHostlistCount(nodeName);
    const operational = state ? slurmNodeIsOperational(state) : undefined;
    if (count === undefined || operational === undefined) return undefined;
    nodeCount += count;
    if (operational) operationalNodeCount += count;
  }
  return { nodeCount, operationalNodeCount };
}

function slurmQueueState(value: string): SchedulerQueueFact["state"] {
  const state = value.toUpperCase();
  if (state === "UP") return "up";
  if (state === "DOWN" || state === "INACTIVE" || state === "DRAIN" || state === "DRAINING") {
    return "down";
  }
  return "unknown";
}

function slurmQueueNodeCount(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count > 0 : undefined;
}

function parseSlurmQueueInventory(
  output: string,
  observedAt = new Date(),
): SchedulerQueueInventory {
  const queues: SchedulerQueueFact[] = [];
  const names = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const queueName = slurmField(line, "PartitionName");
    const defaultValue = slurmField(line, "Default");
    const rawState = slurmField(line, "State");
    if (
      !queueName ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(queueName) ||
      names.has(queueName) ||
      (defaultValue !== "YES" && defaultValue !== "NO") ||
      !rawState
    ) {
      return unavailableQueueInventory("invalid_output", observedAt);
    }
    names.add(queueName);
    const state = slurmQueueState(rawState);
    queues.push({
      queueName,
      queueType: "partition",
      isDefault: defaultValue === "YES",
      state,
      acceptsSubmissions: state === "up",
      ...(slurmQueueNodeCount(slurmField(line, "TotalNodes")) === undefined
        ? {}
        : { hasComputeTargets: slurmQueueNodeCount(slurmField(line, "TotalNodes")) }),
      observedAt,
    });
  }
  return availableQueueInventory(queues, observedAt);
}

/**
 * Map a raw Slurm job-state + exit code to a JobStatusResult. Shared by the
 * squeue/sacct/scontrol paths so a non-terminal state (esp. COMPLETING, or a
 * job still RUNNING when squeue is transiently empty) is never mis-reported as
 * failed. Genuinely terminal-but-bad states (FAILED/CANCELLED/TIMEOUT/…) and a
 * COMPLETED with a non-zero exit fall through to failed.
 */
/** Convert Slurm `squeue --json` `start_time` to ISO. Newer Slurm emits an
 *  object `{ set, infinite, number }`, older a bare epoch-seconds number. A
 *  zero/unset value (not-yet-started) yields undefined. */
function slurmJsonNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  const number = (value as { number?: unknown }).number;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function slurmStateName(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.find((state): state is string => typeof state === "string") ?? "";
}

function slurmEpochToIso(value: unknown): string | undefined {
  const epoch = slurmJsonNumber(value);
  if (epoch === undefined || epoch <= 0) return undefined;
  return new Date(epoch * 1000).toISOString();
}

function mapSlurmState(state: string, exitCode: number): JobStatusResult {
  if (SLURM_QUEUED.has(state)) return { status: "queued" };
  if (SLURM_RUNNING.has(state)) return { status: "running" };
  if (state === "COMPLETED" && exitCode === 0) return { status: "completed", exitCode: 0 };
  return { status: "failed", exitCode, message: `Slurm state: ${state}` };
}

/**
 * Map a bare Slurm state name (from `squeue %T`, no exit code available) to a
 * coarse listing status. Terminal-but-bad states map to "failed"; COMPLETED to
 * "completed" — though completed jobs usually drop out of squeue entirely.
 */
function mapSlurmStateName(state: string): ListedJob["status"] {
  if (SLURM_QUEUED.has(state)) return "queued";
  if (SLURM_RUNNING.has(state)) return "running";
  if (state === "COMPLETED") return "completed";
  return "failed";
}

function isSlurmJobRecordMissing(stderr: string): boolean {
  return /invalid job id/i.test(stderr);
}

type JobLogReadResult =
  | { kind: "available"; text: string }
  | { kind: "missing" }
  | { kind: "failed"; error: Error };

export interface SlurmAdapterDeps {
  spawner?: Spawner;
  /** Override for stdout/stderr when a job has no explicit working directory. */
  logDir?: string;
  /**
   * Which backend to use when a job is no longer visible in squeue.
   * - `"sacct"` (default): runs `sacct -j <id>` — production Slurm clusters with
   *   accounting enabled.
   * - `"scontrol"`: runs `scontrol show job <id>` — works even when Slurm
   *   accounting storage is disabled (e.g. the nathanhess/slurm:full test image).
   */
  terminalStatusBackend?: "sacct" | "scontrol";
  queueInventoryRefreshMs?: number;
  queueInventoryTimeoutMs?: number;
}

export class SlurmAdapter implements SchedulerAdapter {
  readonly type = "slurm";
  private spawner: Spawner;
  private logDir: string;
  private terminalStatusBackend: "sacct" | "scontrol";
  private queueInventoryTimeoutMs: number;
  private queueInventoryCache: SchedulerQueueInventoryCache;

  constructor(
    readonly version: string,
    deps: SlurmAdapterDeps = {},
  ) {
    this.spawner = deps.spawner ?? realSpawner;
    this.logDir = deps.logDir ?? tmpdir();
    this.terminalStatusBackend = deps.terminalStatusBackend ?? "sacct";
    this.queueInventoryTimeoutMs = deps.queueInventoryTimeoutMs ?? COMPUTE_HEALTH_CLI_TIMEOUT_MS;
    this.queueInventoryCache = new SchedulerQueueInventoryCache(deps.queueInventoryRefreshMs);
  }

  formatWallTime(seconds: number): string {
    return formatWallTimeShared(seconds);
  }

  buildSubmitScript(spec: JobSpec): string {
    assertSandboxSchedulerMetadata(spec);
    const lines: string[] = ["#!/bin/bash"];
    const executionRoot = spec.workingDir || this.logDir;
    const logPath = join(executionRoot, `kq-${spec.jobId}.out`);
    lines.push(`#SBATCH --job-name=${spec.schedulerName ?? spec.name}`);
    lines.push(`#SBATCH --comment=KQ_JOB_ID=${spec.jobId}`);
    lines.push(`#SBATCH --cpus-per-task=${spec.cpus}`);
    lines.push(`#SBATCH --mem=${spec.memoryMb}M`);
    lines.push(`#SBATCH --output=${logPath}`);
    lines.push(`#SBATCH --error=${logPath}`);
    if (spec.queueName) {
      lines.push(`#SBATCH --partition=${spec.queueName}`);
    }
    if (spec.qos) {
      lines.push(`#SBATCH --qos=${spec.qos}`);
    }
    if (spec.sandbox?.identity.backend === "Unix" && spec.sandbox.identity.schedulerAccount) {
      lines.push(`#SBATCH --account=${spec.sandbox.identity.schedulerAccount}`);
    }
    if (spec.sandbox?.executionMode === "SelfAccount") {
      lines.push(`#SBATCH --nodelist=${spec.sandbox.attestedNodes?.join(",")}`);
    }
    if (spec.wallTimeSec > 0) {
      lines.push(`#SBATCH --time=${this.formatWallTime(spec.wallTimeSec)}`);
    }
    if (spec.gpus > 0) {
      lines.push(`#SBATCH --gpus=${spec.gpus}`);
    }
    lines.push(`#SBATCH --chdir=${executionRoot}`);
    return appendEnvAndCommand(lines, spec);
  }

  async submit(spec: JobSpec): Promise<JobResult> {
    const script = this.buildSubmitScript(spec);
    const command = schedulerCommand(spec, ["sbatch", "--parsable"]);
    try {
      const { exitCode, stdout, stderr } = await this.spawner.run(command, { stdin: script });

      if (exitCode !== 0) {
        logger.warn(
          { jobId: spec.jobId, exitCode, stderr: stderr.trim() },
          "Slurm submission rejected",
        );
        throw new SchedulerSubmissionError("sbatch failed");
      }

      const schedulerJobId = stdout.trim().split(";")[0]?.trim() ?? "";
      if (!schedulerJobId) {
        logger.warn({ jobId: spec.jobId }, "Slurm submission returned no job id");
        throw new SchedulerSubmissionError("sbatch returned no job id");
      }
      logger.info({ jobId: spec.jobId, schedulerJobId }, "Job submitted to Slurm");
      return { schedulerJobId };
    } catch (err) {
      if (err instanceof SchedulerSubmissionError) throw err;
      logger.warn({ jobId: spec.jobId, err }, "Slurm submission command failed");
      throw new SchedulerSubmissionError("sbatch failed");
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
      const result = await this.spawner.run(["scontrol", "show", "partition", "-o"], {
        timeoutMs: this.queueInventoryTimeoutMs,
      });
      if (result.exitCode !== 0) return unavailableQueueInventory("command_failed");
      return parseSlurmQueueInventory(result.stdout);
    } catch {
      return unavailableQueueInventory("command_failed");
    }
  }

  async listJobs(): Promise<ListedJob[]> {
    // Stable across Slurm 20.x/23.x: the old-style `-o` template with `%T`
    // (full state name) avoids the version-sensitive `--json` schema. `--me`
    // scopes to the current user. Fields: jobid|name|state|partition|submit.
    const { exitCode, stdout, stderr } = await this.spawner.run([
      "squeue",
      "--me",
      "--noheader",
      "-o",
      "%i|%j|%T|%P|%V",
    ]);
    if (exitCode !== 0) {
      throw new Error(`squeue failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const jobs: ListedJob[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [id, name, state, queue, submittedAt] = trimmed.split("|").map((f) => f.trim());
      if (!id) continue;
      jobs.push({
        schedulerJobId: id,
        name: name ?? "",
        status: mapSlurmStateName(state ?? ""),
        queue: queue || undefined,
        submittedAt: submittedAt || undefined,
      });
    }
    return jobs;
  }

  async findByKuintessenceJobId(
    lookup: KuintessenceJobLookup,
  ): Promise<KuintessenceJobLookupResult> {
    const command = [
      "squeue",
      "--noheader",
      ...(lookup.schedulerName ? ["--name", lookup.schedulerName] : []),
      ...(lookup.schedulerAccount ? ["--account", lookup.schedulerAccount] : ["--me"]),
      "--format=%i|%j|%k|%a",
    ];
    try {
      const { exitCode, stdout, stderr } = await this.spawner.run(command);
      if (exitCode !== 0) {
        return { status: "indeterminate", reason: `squeue failed: ${stderr.trim()}` };
      }
      const expectedComment = `KQ_JOB_ID=${lookup.jobId}`;
      const matches = stdout
        .split("\n")
        .map((line) =>
          line
            .trim()
            .split("|")
            .map((field) => field.trim()),
        )
        .filter(
          ([schedulerJobId, name, comment, account]) =>
            !!schedulerJobId &&
            comment === expectedComment &&
            (!lookup.schedulerName || name === lookup.schedulerName) &&
            (!lookup.schedulerAccount || account === lookup.schedulerAccount),
        );
      if (matches.length === 0) return { status: "not_found" };
      if (matches.length !== 1) {
        return { status: "indeterminate", reason: "multiple Slurm jobs share Kuintessence UUID" };
      }
      const schedulerJobId = matches[0]?.[0];
      if (!schedulerJobId) {
        return { status: "indeterminate", reason: "Slurm lookup returned an invalid job id" };
      }
      return { status: "found", schedulerJobId };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : "squeue lookup failed",
      };
    }
  }

  async cancel(schedulerJobId: string): Promise<void> {
    const { exitCode, stderr } = await this.spawner.run(["scancel", schedulerJobId]);
    if (exitCode !== 0) {
      throw new Error(`scancel failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  }

  async inspectComputeHealth(): Promise<ComputeHealthObservation> {
    try {
      const result = await this.spawner.run(["scontrol", "show", "nodes", "-o"], {
        timeoutMs: COMPUTE_HEALTH_CLI_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return unknownComputeHealth("scheduler_command_failed");
      const parsed = parseSlurmComputeHealth(result.stdout);
      return parsed
        ? observedComputeHealth(parsed.nodeCount, parsed.operationalNodeCount)
        : unknownComputeHealth("invalid_scheduler_state");
    } catch {
      return unknownComputeHealth("scheduler_command_failed");
    }
  }

  async getJobLogs(schedulerJobId: string, lines: number, jobId?: string): Promise<string> {
    // `scontrol show job -o` prints one line of key=value pairs incl. StdOut.
    const scontrol = await this.spawner.run(["scontrol", "show", "job", schedulerJobId, "-o"]);
    const retainedPath = isRetainedSchedulerLogJobId(jobId)
      ? join(this.logDir, `kq-${jobId}.out`)
      : undefined;

    if (scontrol.exitCode !== 0) {
      const retained = retainedPath ? await this.tailLog(retainedPath, lines) : undefined;
      if (retained?.kind === "available") return retained.text;
      if (retained?.kind === "failed") throw retained.error;
      if (retained?.kind === "missing" && isSlurmJobRecordMissing(scontrol.stderr)) {
        throw new JobLogUnavailableError();
      }
      throw new Error(
        `scontrol show job failed (exit ${scontrol.exitCode}): ${scontrol.stderr.trim()}`,
      );
    }
    const match = /StdOut=(\S+)/.exec(scontrol.stdout);
    const path = match?.[1];
    if (!path) {
      if (!retainedPath) return "";
      return this.unwrapLogRead(await this.tailLog(retainedPath, lines));
    }
    const primary = await this.tailLog(path, lines);
    if (primary.kind === "available") return primary.text;

    if (retainedPath && retainedPath !== path) {
      const retained = await this.tailLog(retainedPath, lines);
      if (retained.kind === "available") return retained.text;
      if (retained.kind === "failed") throw retained.error;
      if (primary.kind === "failed") throw primary.error;
      throw new JobLogUnavailableError();
    }
    return this.unwrapLogRead(primary);
  }

  private async tailLog(path: string, lines: number): Promise<JobLogReadResult> {
    const tail = await this.spawner.run(["tail", "-n", String(lines), path]);
    if (tail.exitCode === 0) return { kind: "available", text: tail.stdout };
    if (/no such file or directory/i.test(tail.stderr)) return { kind: "missing" };
    return {
      kind: "failed",
      error: new Error(`tail job stdout failed (exit ${tail.exitCode}): ${tail.stderr.trim()}`),
    };
  }

  private unwrapLogRead(result: JobLogReadResult): string {
    if (result.kind === "available") return result.text;
    if (result.kind === "missing") throw new JobLogUnavailableError();
    throw result.error;
  }

  async status(schedulerJobId: string): Promise<JobStatusResult> {
    const { exitCode, stdout } = await this.spawner.run(["squeue", "--json", "-j", schedulerJobId]);

    if (exitCode !== 0 || !stdout.trim()) {
      return this.checkCompleted(schedulerJobId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return this.checkCompleted(schedulerJobId);
    }

    const data = parsed as {
      jobs?: Array<{
        job_id?: number | string;
        job_state?: unknown;
        exit_code?: { return_code?: unknown };
        nodes?: string;
        start_time?: unknown;
        state_reason?: string;
      }>;
    };
    const jobsArr = data.jobs ?? [];
    // Some Slurm builds' `squeue --json -j <id>` ignore the -j filter and return
    // every job, so we must select the requested one by job_id rather than take
    // jobs[0]. Compared as strings so the match is schema-agnostic (some builds
    // emit job_id as a string). Fall back to the sole entry when job_id is absent
    // (older format / a correctly-filtered single result).
    const job =
      jobsArr.find((j) => j.job_id != null && String(j.job_id) === schedulerJobId) ??
      (jobsArr.length === 1 ? jobsArr[0] : undefined);
    if (!job) return this.checkCompleted(schedulerJobId);

    const state = slurmStateName(job.job_state);
    const result = mapSlurmState(state, slurmJsonNumber(job.exit_code?.return_code) ?? 0);
    const node = typeof job.nodes === "string" && job.nodes.trim() ? job.nodes : undefined;
    const startedAt = slurmEpochToIso(job.start_time);
    const reason = job.state_reason && job.state_reason !== "None" ? job.state_reason : undefined;
    return {
      ...result,
      ...(node ? { node } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private async checkCompleted(schedulerJobId: string): Promise<JobStatusResult> {
    if (this.terminalStatusBackend === "scontrol") {
      return this.scontrolStatus(schedulerJobId);
    }
    return this.sacctStatus(schedulerJobId);
  }

  private async sacctStatus(schedulerJobId: string): Promise<JobStatusResult> {
    const { exitCode: sacctExitCode, stdout } = await this.spawner.run([
      "sacct",
      "-j",
      schedulerJobId,
      "--format=State,ExitCode",
      "--noheader",
      "--parsable2",
    ]);
    if (sacctExitCode !== 0) {
      return this.scontrolStatus(schedulerJobId);
    }

    const firstLine = stdout.trim().split("\n")[0];
    if (!firstLine) {
      return this.scontrolStatus(schedulerJobId);
    }

    const parts = firstLine.split("|");
    const state = parts[0] ?? "";
    const exitCodeStr = parts[1]?.split(":")[0] ?? "1";
    const exitCode = Number.parseInt(exitCodeStr, 10);
    return mapSlurmState(state, exitCode);
  }

  private async scontrolStatus(schedulerJobId: string): Promise<JobStatusResult> {
    const {
      exitCode: spawnExit,
      stdout,
      stderr,
    } = await this.spawner.run(["scontrol", "show", "job", schedulerJobId]);

    if (spawnExit !== 0) {
      return {
        status: "failed",
        message: `scontrol show job failed (exit ${spawnExit}): ${stderr.trim()}`,
      };
    }

    const stateMatch = /JobState=(\w+)/.exec(stdout);
    const exitCodeMatch = /ExitCode=(\d+):(\d+)/.exec(stdout);

    if (!stateMatch) {
      return { status: "failed", message: "scontrol output did not contain JobState" };
    }

    const jobState = stateMatch[1] ?? "";
    const exitA = exitCodeMatch ? Number.parseInt(exitCodeMatch[1] ?? "1", 10) : 1;
    return mapSlurmState(jobState, exitA);
  }
}
