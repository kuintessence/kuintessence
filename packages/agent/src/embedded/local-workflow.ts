import { randomUUID } from "node:crypto";
import {
  createLogger,
  createUsecaseExecutor,
  extractRunGraph,
  type JobStatusName,
  type JobSubmission,
  type ResolvedPackage,
  type RunResult,
  runWorkflow,
  type WorkflowRunRecordResult,
  type WorkflowRunStore,
  type workflowDsl,
} from "@kuintessence/shared";
import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import { createOutputCollector, type ExpectedOutput, hostOutputReader } from "../output-collector";
import { ExecutorPool, type ExecutorPoolDeps } from "./executor-pool";
import type { JobStatusReport } from "./job-executor";
import { LocalFileStager } from "./local-file-stager";

const logger = createLogger("local-workflow");

/** Defaults applied to a job whose `JobSubmission` declares no resources. */
const DEFAULT_RESOURCES = { cpus: 1, memoryMb: 1024, gpus: 0, wallTimeSec: 3600 } as const;

/** Outcome of a recorded local workflow run: the engine result plus the run-store id
 *  it was persisted under (so the caller can read the run back for a detail view). */
export interface LocalRunOutcome {
  runId: string;
  result: RunResult;
}

/** Reserved collected-output descriptor under which a job's captured standard
 *  output is exposed to workflow value extraction. A `valueOutput` may read it via
 *  `from.collectedOutDescriptor: "stdout"`. A file output declaring this same
 *  descriptor takes precedence — stdout is only filled when the key is unused. */
export const STDOUT_DESCRIPTOR = "stdout";

/** Upper bound on stdout lines captured for value extraction. Large enough to
 *  hold a script's full result block, unlike the TUI's small tail. */
const STDOUT_CAPTURE_LINES = 10_000;

/** Outcome of one launched local job: terminal status plus collected outputs.
 *  `schedulerJobId` is the scheduler's own id (Slurm/PBS/etc.), carried so the
 *  workflow runner can tail the job's stdout via the adapter after completion. */
export interface LaunchOutcome {
  status: "completed" | "failed";
  collected?: Record<string, string>;
  schedulerJobId?: string;
  errorMessage?: string;
  exitCode?: number;
}

/** Result shape the shared usecase executor's `submitJob` seam expects. */
export interface SubmitJobResult {
  jobId: string;
  status: JobStatusName;
  collected: Record<string, string>;
  errorMessage?: string;
  exitCode?: number;
}

/**
 * Submits a materialized {@link JobSubmission} and awaits its terminal status.
 * This is the local backing for the shared executor's `submitJob` seam, so the
 * embedded runner reuses the SAME `createUsecaseExecutor` the Server uses.
 * Server-free: backed by the embedded {@link ExecutorPool}.
 */
export interface LocalJobLauncher {
  submitJob(spec: JobSubmission): Promise<SubmitJobResult>;
  /**
   * Run a fully-formed {@link JobSpec} (command + resources) and await its
   * terminal status. The `submitJob` path uses this after materializing a
   * {@link JobSubmission} into a {@link JobSpec}.
   */
  submitAndWait(
    spec: JobSpec,
    opts?: { expectedOutputs?: ExpectedOutput[] },
  ): Promise<LaunchOutcome>;
}

/**
 * Owns an {@link ExecutorPool} and exposes both a low-level
 * `submit-and-await-terminal-status` surface and the {@link JobSubmission}-shaped
 * `submitJob` the shared usecase executor calls. The pool reports terminal
 * status via `onTransition`; a per-job completion promise keyed by `report.jobId`
 * resolves when a `completed`/`failed` transition arrives.
 */
export class PoolJobLauncher implements LocalJobLauncher {
  private readonly pool: ExecutorPool;
  private readonly pending = new Map<string, (outcome: LaunchOutcome) => void>();
  /** Base directory jobs run in; expected-output relative paths resolve here. */
  private readonly workingDir: string;
  /** Kept so the `submitJob` path can tail a completed job's stdout via the
   *  adapter's optional `getJobLogs` — the pool itself does not re-expose it. */
  private readonly adapter: SchedulerAdapter;
  /** Copies an input submission's staged files into the run dir before submit. */
  private readonly stager: LocalFileStager;

  constructor(
    deps: Omit<ExecutorPoolDeps, "onTransition" | "collectOutputs"> & {
      workingDir?: string;
      stager?: LocalFileStager;
    },
  ) {
    this.workingDir = deps.workingDir ?? process.cwd();
    this.adapter = deps.adapter;
    this.stager = deps.stager ?? new LocalFileStager();
    this.pool = new ExecutorPool({
      ...deps,
      collectOutputs: createOutputCollector(hostOutputReader, deps.logger),
      onTransition: (report) => this.onTransition(report),
    });
  }

  private onTransition(report: JobStatusReport): void {
    if (report.status !== "completed" && report.status !== "failed") {
      return;
    }
    const resolve = this.pending.get(report.jobId);
    if (!resolve) {
      return;
    }
    this.pending.delete(report.jobId);
    resolve({
      status: report.status,
      ...(report.collected ? { collected: report.collected } : {}),
      ...(report.schedulerJobId ? { schedulerJobId: report.schedulerJobId } : {}),
      ...(report.message ? { errorMessage: report.message } : {}),
      ...(report.exitCode !== undefined ? { exitCode: report.exitCode } : {}),
    });
  }

  /**
   * Adapt a materialized {@link JobSubmission} into a {@link JobSpec}, run it on
   * the pool, and map the terminal status onto the shared executor's contract.
   * Input files are staged into the job's run dir by local filesystem copy (no
   * NetDrive) BEFORE submit, so they exist when the job runs; in local mode each
   * `fileMetadataId` is a source path on this host (see {@link LocalFileStager}).
   */
  async submitJob(spec: JobSubmission): Promise<SubmitJobResult> {
    const jobId = randomUUID();
    await this.stager.stage(spec.inputStaging, this.workingDir);
    const outcome = await this.submitAndWait(toJobSpec(jobId, spec, this.workingDir), {
      expectedOutputs: spec.expectedOutputs,
    });
    const collected = { ...(outcome.collected ?? {}) };
    await this.captureStdout(collected, outcome.schedulerJobId);
    return {
      jobId,
      status: outcome.status,
      collected,
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    };
  }

  /**
   * Best-effort: tail the completed job's stdout via the adapter and expose it
   * under {@link STDOUT_DESCRIPTOR} so workflow value extraction can read it. Skipped
   * when the adapter cannot tail logs, when the scheduler id is unknown, or when
   * a file output already claimed the descriptor (file wins). Never throws and
   * never fails the job — a logging-tail problem must not break a finished run.
   */
  private async captureStdout(
    collected: Record<string, string>,
    schedulerJobId: string | undefined,
  ): Promise<void> {
    if (!this.adapter.getJobLogs || !schedulerJobId || STDOUT_DESCRIPTOR in collected) {
      return;
    }
    try {
      collected[STDOUT_DESCRIPTOR] = await this.adapter.getJobLogs(
        schedulerJobId,
        STDOUT_CAPTURE_LINES,
      );
    } catch (err) {
      logger.warn({ schedulerJobId, err }, "Failed to capture job stdout for value extraction");
    }
  }

  async submitAndWait(
    spec: JobSpec,
    opts: { expectedOutputs?: ExpectedOutput[] } = {},
  ): Promise<LaunchOutcome> {
    const terminal = new Promise<LaunchOutcome>((resolve) => {
      this.pending.set(spec.jobId, resolve);
    });
    await this.pool.submit(spec, opts);
    // Resolve on whichever happens first: the terminal `completed`/`failed`
    // transition, or the pool's run-completion. The latter also fires when the
    // pool is stopped/cancelled mid-flight (the runner's poll loop breaks without
    // emitting a terminal transition) — without this race `submitAndWait` would
    // hang forever on shutdown and the workflow run would never be recorded.
    const stopped = this.pool.await(spec.jobId).then(async (): Promise<LaunchOutcome> => {
      if (this.pending.delete(spec.jobId)) {
        return { status: "failed" };
      }
      return terminal;
    });
    return Promise.race([terminal, stopped]);
  }

  /** Stop polling all pool jobs without killing them (agent/CLI shutdown). */
  stopAll(): void {
    this.pool.stopAll();
  }
}

/** Build a {@link JobSpec} from a materialized {@link JobSubmission}, filling
 *  scheduler defaults for any resource the node did not declare. */
function toJobSpec(jobId: string, spec: JobSubmission, workingDir: string): JobSpec {
  return {
    jobId,
    name: spec.name,
    command: spec.command,
    cpus: spec.resources?.cpus ?? DEFAULT_RESOURCES.cpus,
    memoryMb: DEFAULT_RESOURCES.memoryMb,
    gpus: DEFAULT_RESOURCES.gpus,
    wallTimeSec: spec.resources?.wallTimeSec ?? DEFAULT_RESOURCES.wallTimeSec,
    workingDir,
    envVars: spec.envVars,
    ...(spec.stdinText !== undefined ? { stdinText: spec.stdinText } : {}),
  };
}

/** Resolves a node's usecase package from a local catalog (no Postgres). */
export interface LocalPackageResolver {
  resolvePackage(usecaseVersionId: string, softwareVersionId: string): Promise<ResolvedPackage>;
}

export interface LocalWorkflowRunnerDeps {
  launcher: LocalJobLauncher;
  runStore: WorkflowRunStore;
  packageStore: LocalPackageResolver;
}

/**
 * Runs workflows locally on the embedded executor pool with no Server.
 *
 * `run` reuses the shared {@link runWorkflow} engine for control flow AND the
 * shared {@link createUsecaseExecutor} for per-leaf execution — the SAME executor
 * the Server uses; only the package SOURCE (a local YAML catalog via
 * {@link LocalPackageResolver}) and the launcher differ. The finished run is
 * persisted via {@link WorkflowRunStore.recordRun}.
 */
export class LocalWorkflowRunner {
  constructor(private readonly deps: LocalWorkflowRunnerDeps) {}

  async run(wf: workflowDsl.Workflow, submittedBy: string): Promise<LocalRunOutcome> {
    const executor = createUsecaseExecutor({
      resolvePackage: (usecaseVersionId, softwareVersionId) =>
        this.deps.packageStore.resolvePackage(usecaseVersionId, softwareVersionId),
      submitJob: (spec) => this.deps.launcher.submitJob(spec),
    });
    const result = await runWorkflow(wf, executor);
    logger.info({ name: wf.name, submittedBy }, "Local workflow run finished");
    const runId = await this.deps.runStore.recordRun(
      wf.name ?? "local",
      submittedBy,
      toRecordResult(result),
      extractRunGraph(wf),
    );
    return { runId, result };
  }
}

/** Map the engine's {@link RunResult} onto the run-store's persisted shape. The
 *  node-status enum is a string subtype, so it carries through verbatim. */
function toRecordResult(result: RunResult): WorkflowRunRecordResult {
  const values: WorkflowRunRecordResult["values"] = {};
  for (const [id, entry] of Object.entries(result.values)) {
    values[id] = {
      status: entry.status,
      values: entry.values,
      ...(entry.failure ? { failure: entry.failure } : {}),
    };
  }
  return { status: { ...result.status }, values };
}
