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
  isSchedulerQueueName,
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

const logger = createLogger("torque-adapter");

const TORQUE_OPERATIONAL_NODE_STATES = new Set([
  "free",
  "job-exclusive",
  "job-sharing",
  "busy",
  "resv-exclusive",
  "resv-sharing",
]);
const TORQUE_NON_OPERATIONAL_NODE_STATES = new Set([
  "down",
  "offline",
  "state-unknown",
  "maintenance",
  "unknown",
]);

function torqueNodeIsOperational(value: string): boolean | undefined {
  const states = value
    .split(",")
    .map((state) => state.trim().toLowerCase())
    .filter((state) => state.length > 0);
  if (states.length === 0) return undefined;
  if (states.some((state) => TORQUE_NON_OPERATIONAL_NODE_STATES.has(state))) return false;
  return states.some((state) => TORQUE_OPERATIONAL_NODE_STATES.has(state)) ? true : undefined;
}

function parseTorqueComputeHealth(
  output: string,
): { nodeCount: number; operationalNodeCount: number } | undefined {
  const states: string[] = [];
  let currentState: string | undefined;
  let sawNode = false;

  const finishNode = (): boolean => {
    if (!sawNode) return true;
    if (currentState === undefined) return false;
    states.push(currentState);
    currentState = undefined;
    return true;
  };

  for (const rawLine of output.split("\n")) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      if (rawLine.includes("=") || !finishNode()) return undefined;
      sawNode = true;
      continue;
    }
    if (!sawNode) return undefined;
    const match = /^\s+state\s*=\s*(.+?)\s*$/.exec(rawLine);
    if (!match) continue;
    if (currentState !== undefined) return undefined;
    currentState = match[1] ?? "";
  }
  if (!finishNode()) return undefined;

  let operationalNodeCount = 0;
  for (const state of states) {
    const operational = torqueNodeIsOperational(state);
    if (operational === undefined) return undefined;
    if (operational) operationalNodeCount += 1;
  }
  return { nodeCount: states.length, operationalNodeCount };
}

function torqueQueueBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function torqueQueueState(
  enabled: boolean | undefined,
  started: boolean | undefined,
): SchedulerQueueFact["state"] {
  if (enabled === true && started === true) return "up";
  if (enabled === false || started === false) return "down";
  return "unknown";
}

function torqueQueueType(value: string | undefined): SchedulerQueueFact["queueType"] {
  if (value?.toLowerCase() === "execution") return "execution";
  if (value?.toLowerCase() === "route") return "route";
  return "unknown";
}

function parseTorqueDefaultQueue(output: string): string | null | undefined {
  const defaults = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const match = /\bdefault_queue\s*=\s*(\S+)\s*$/.exec(rawLine);
    if (!match) continue;
    const queueName = match[1];
    if (!queueName || !isSchedulerQueueName(queueName)) return null;
    defaults.add(queueName);
  }
  return defaults.size > 1 ? null : [...defaults][0];
}

interface TorqueQueueAttributes {
  queueType?: string;
  enabled?: string;
  started?: string;
  hasnodes?: string;
}

function parseTorqueQueueInventory(
  serverOutput: string,
  queuesOutput: string,
  observedAt = new Date(),
): SchedulerQueueInventory {
  const defaultQueueName = parseTorqueDefaultQueue(serverOutput);
  if (defaultQueueName === null) return unavailableQueueInventory("invalid_output", observedAt);

  const queues = new Map<string, TorqueQueueAttributes>();
  let activeQueue: string | undefined;
  for (const rawLine of queuesOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const create = /^create\s+queue\s+(\S+)\s*$/.exec(line);
    const heading = /^Queue\s+(\S+)\s*$/.exec(line);
    if (create || heading) {
      const queueName = (create ?? heading)?.[1];
      if (!queueName || !isSchedulerQueueName(queueName) || queues.has(queueName)) {
        return unavailableQueueInventory("invalid_output", observedAt);
      }
      queues.set(queueName, {});
      activeQueue = queueName;
      continue;
    }
    const explicitAttribute = /^set\s+queue\s+(\S+)\s+(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    const nestedAttribute = /^(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    const queueName = explicitAttribute?.[1] ?? activeQueue;
    const attribute = explicitAttribute?.[2] ?? nestedAttribute?.[1];
    const value = explicitAttribute?.[3] ?? nestedAttribute?.[2];
    if (!queueName || !attribute || value === undefined || !queues.has(queueName)) continue;
    const attributes = queues.get(queueName);
    if (!attributes) return unavailableQueueInventory("invalid_output", observedAt);
    if (attribute === "queue_type") attributes.queueType = value;
    if (attribute === "enabled") attributes.enabled = value;
    if (attribute === "started") attributes.started = value;
    if (attribute === "hasnodes") attributes.hasnodes = value;
  }

  const facts: SchedulerQueueFact[] = [];
  for (const [queueName, attributes] of queues) {
    const enabled = torqueQueueBoolean(attributes.enabled);
    const started = torqueQueueBoolean(attributes.started);
    const state = torqueQueueState(enabled, started);
    const hasComputeTargets = torqueQueueBoolean(attributes.hasnodes);
    facts.push({
      queueName,
      queueType: torqueQueueType(attributes.queueType),
      isDefault: queueName === defaultQueueName,
      state,
      acceptsSubmissions: state === "up",
      ...(hasComputeTargets === undefined ? {} : { hasComputeTargets }),
      observedAt,
    });
  }
  return availableQueueInventory(facts, observedAt);
}

function hasKuintessenceJobId(record: string, jobId: string): boolean {
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,])KQ_JOB_ID=${escapedJobId}(?:$|[\\s,])`, "m").test(record);
}

function parseQstatAttribute(output: string, name: string): string | undefined {
  const lines = output.split("\n");
  const prefix = `${name} =`;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(prefix)) continue;
    let value = trimmed.slice(prefix.length).trim();
    for (let next = index + 1; lines[next]?.startsWith("\t"); next += 1) {
      value += lines[next]?.trim() ?? "";
    }
    return value;
  }
  return undefined;
}

/** Map a Torque single-letter job state to a listing status (no exit code). */
function mapTorqueStateName(state: string): ListedJob["status"] {
  if (["Q", "H", "W", "T"].includes(state)) return "queued";
  if (["R", "E", "S"].includes(state)) return "running";
  if (state === "C") return "completed";
  return "failed";
}

export interface TorqueAdapterDeps {
  spawner?: Spawner;
  logDir?: string;
  queueInventoryRefreshMs?: number;
  queueInventoryTimeoutMs?: number;
}

export class TorqueAdapter implements SchedulerAdapter {
  readonly type = "torque";
  private spawner: Spawner;
  private logDir: string;
  private queueInventoryTimeoutMs: number;
  private queueInventoryCache: SchedulerQueueInventoryCache;

  constructor(
    readonly version: string,
    deps: TorqueAdapterDeps = {},
  ) {
    this.spawner = deps.spawner ?? realSpawner;
    this.logDir = deps.logDir ?? tmpdir();
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
    lines.push(`#PBS -N ${spec.schedulerName ?? spec.name}`);
    lines.push(`#PBS -v KQ_JOB_ID=${spec.jobId}`);
    lines.push(`#PBS -o ${join(executionRoot, `kq-torque-${spec.jobId}.out`)}`);
    lines.push(`#PBS -e ${join(executionRoot, `kq-torque-${spec.jobId}.err`)}`);
    // Torque uses nodes=N:ppn=N rather than select=
    lines.push(`#PBS -l nodes=1:ppn=${spec.cpus}`);
    lines.push(`#PBS -l mem=${spec.memoryMb}mb`);
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
    if (spec.gpus > 0) {
      lines.push(`#PBS -l gpus=${spec.gpus}`);
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
          "Torque submission rejected",
        );
        throw new SchedulerSubmissionError("qsub failed");
      }
      const schedulerJobId = stdout.trim().split(/\s+/)[0] ?? "";
      if (!schedulerJobId) {
        logger.warn({ jobId: spec.jobId }, "Torque submission returned no job id");
        throw new SchedulerSubmissionError("qsub returned no job id");
      }
      logger.info({ jobId: spec.jobId, schedulerJobId }, "Job submitted to Torque");
      return { schedulerJobId };
    } catch (err) {
      if (err instanceof SchedulerSubmissionError) throw err;
      logger.warn({ jobId: spec.jobId, err }, "Torque submission command failed");
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
      const server = await this.spawner.run(["qmgr", "-c", "list server"], {
        timeoutMs: this.queueInventoryTimeoutMs,
      });
      if (server.exitCode !== 0) return unavailableQueueInventory("command_failed");
      const queues = await this.spawner.run(["qmgr", "-c", "list queue"], {
        timeoutMs: this.queueInventoryTimeoutMs,
      });
      if (queues.exitCode !== 0) return unavailableQueueInventory("command_failed");
      return parseTorqueQueueInventory(server.stdout, queues.stdout);
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
      const result = await this.spawner.run(["pbsnodes", "-a"], {
        timeoutMs: COMPUTE_HEALTH_CLI_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return unknownComputeHealth("scheduler_command_failed");
      const parsed = parseTorqueComputeHealth(result.stdout);
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
      const { exitCode, stdout, stderr } = await this.spawner.run(["qstat", "-f"]);
      if (exitCode !== 0) {
        return { status: "indeterminate", reason: `qstat failed: ${stderr.trim()}` };
      }
      const matches = stdout
        .split(/(?=^Job Id:\s*)/m)
        .filter((record) => hasKuintessenceJobId(record, lookup.jobId))
        .map((record) => /^Job Id:\s*(\S+)/m.exec(record)?.[1])
        .filter((schedulerJobId): schedulerJobId is string => !!schedulerJobId);
      if (matches.length === 0) return { status: "not_found" };
      if (matches.length !== 1) {
        return { status: "indeterminate", reason: "multiple Torque jobs share Kuintessence UUID" };
      }
      const schedulerJobId = matches[0];
      if (!schedulerJobId) {
        return { status: "indeterminate", reason: "Torque lookup returned an invalid job id" };
      }
      return { status: "found", schedulerJobId };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : "Torque lookup failed",
      };
    }
  }

  async getJobLogs(schedulerJobId: string, lines: number, jobId?: string): Promise<string> {
    const { exitCode, stdout, stderr } = await this.spawner.run(["qstat", "-f", schedulerJobId]);
    if (exitCode !== 0 || !stdout.trim()) {
      if (isRetainedSchedulerLogJobId(jobId)) {
        const persistedLog = await this.spawner.run([
          "tail",
          "-n",
          String(lines),
          join(this.logDir, `kq-torque-${jobId}.out`),
        ]);
        if (persistedLog.exitCode === 0) return persistedLog.stdout;
      }
      throw new Error(`qstat failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const raw = parseQstatAttribute(stdout, "Output_Path");
    if (!raw) return "";
    const path = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const tail = await this.spawner.run(["tail", "-n", String(lines), path]);
    if (tail.exitCode !== 0) {
      return "(job output not available yet — Torque spools stdout until the job completes)";
    }
    return tail.stdout;
  }

  async listJobs(): Promise<ListedJob[]> {
    // Older Torque qstat has no JSON; parse the tabular output. Columns:
    // Job-id | Name | User | Time | S(tate) | Queue. A dashed line separates the
    // header from rows.
    const { exitCode, stdout, stderr } = await this.spawner.run(["qstat"]);
    if (exitCode !== 0) {
      throw new Error(`qstat failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const lines = stdout.split("\n");
    const sepIdx = lines.findIndex((l) => /^-{3,}/.test(l.trim()));
    const rows = sepIdx >= 0 ? lines.slice(sepIdx + 1) : [];
    const jobs: ListedJob[] = [];
    for (const line of rows) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 6) continue;
      const [id, name, , , state, queue] = cols;
      if (!id) continue;
      jobs.push({
        schedulerJobId: id,
        name: name ?? "",
        status: mapTorqueStateName(state ?? ""),
        queue: queue || undefined,
      });
    }
    return jobs;
  }

  async status(schedulerJobId: string): Promise<JobStatusResult> {
    const { exitCode, stdout } = await this.spawner.run(["qstat", "-f", schedulerJobId]);
    if (exitCode !== 0 || !stdout.trim()) {
      return { status: "failed", message: "qstat returned no data" };
    }
    // Torque qstat -f output is plain "key = value" lines (not JSON)
    const lines = stdout.split("\n").map((l) => l.trim());
    const stateMatch = lines.find((l) => l.startsWith("job_state ="));
    const exitStatusMatch = lines.find((l) => l.startsWith("exit_status ="));
    const execHostMatch = lines.find((l) => l.startsWith("exec_host ="));
    const commentMatch = lines.find((l) => l.startsWith("comment ="));
    const state = stateMatch?.split("=")[1]?.trim() ?? "";
    const node = parseExecHost(execHostMatch?.split("=")[1]?.trim());
    // The comment value can itself contain "=", so take everything after the first.
    const reason = commentMatch?.slice(commentMatch.indexOf("=") + 1).trim() || undefined;
    const withNode = (r: JobStatusResult): JobStatusResult => ({
      ...r,
      ...(node ? { node } : {}),
      ...(reason ? { reason } : {}),
    });

    // Torque states. Non-terminal states beyond Q/H must NOT be reported as
    // failed, or the runner kills a job that is still pending/running:
    //   Q queued · H held · W waiting (deferred start `-a`) · T transiting
    //   R running · E exiting · S suspended (preempted, will resume) · C complete
    if (state === "Q" || state === "H" || state === "W" || state === "T") {
      return withNode({ status: "queued" });
    }
    if (state === "R" || state === "E" || state === "S") return withNode({ status: "running" });
    if (state === "C") {
      const rawExitCode = exitStatusMatch
        ? Number.parseInt(exitStatusMatch.split("=")[1]?.trim() ?? "0", 10)
        : 0;
      if (rawExitCode === 0) return withNode({ status: "completed", exitCode: 0 });
      return withNode({ status: "failed", exitCode: rawExitCode, message: `Exit ${rawExitCode}` });
    }
    return withNode({ status: "failed", message: `State: ${state}` });
  }
}
