import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import type { ExpectedOutput } from "../output-collector";
import { JobRunner, type JobRunnerDeps, type JobStatusReport } from "./job-executor";

export interface ExecutorPoolDeps {
  adapter: SchedulerAdapter;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onTransition: (report: JobStatusReport) => void | Promise<void>;
  collectOutputs?: JobRunnerDeps["collectOutputs"];
  ensureWorkingDir?: JobRunnerDeps["ensureWorkingDir"];
  onSchedulerSubmitted?: JobRunnerDeps["onSchedulerSubmitted"];
  onSchedulerSubmitting?: JobRunnerDeps["onSchedulerSubmitting"];
  onQueueValidationShadowRejection?: JobRunnerDeps["onQueueValidationShadowRejection"];
  onJobFinished?: JobRunnerDeps["onJobFinished"];
  validateSandboxOutputs?: JobRunnerDeps["validateSandboxOutputs"];
  logger?: JobRunnerDeps["logger"];
}

export class ExecutorPoolStoppedError extends Error {
  constructor() {
    super("Executor pool is stopping");
    this.name = "ExecutorPoolStoppedError";
  }
}

/**
 * Manages multiple active JobRunner instances keyed by jobId. Replaces the
 * daemon's hand-rolled `Map<jobId, JobRunner>` and backs the all-in-one CLI's
 * local submit. Server-free by construction.
 */
export class ExecutorPool {
  private active = new Map<string, JobRunner>();
  private done = new Map<string, Promise<void>>();
  private accepting = true;

  constructor(private deps: ExecutorPoolDeps) {}

  async submit(
    spec: JobSpec,
    opts: { expectedOutputs?: ExpectedOutput[] } = {},
  ): Promise<{ jobId: string }> {
    if (!this.accepting) throw new ExecutorPoolStoppedError();
    if (this.active.has(spec.jobId)) {
      throw new Error(`Job ${spec.jobId} is already active`);
    }
    const runner = new JobRunner({
      adapter: this.deps.adapter,
      pollIntervalMs: this.deps.pollIntervalMs,
      sleep: this.deps.sleep,
      collectOutputs: this.deps.collectOutputs,
      ensureWorkingDir: this.deps.ensureWorkingDir,
      onSchedulerSubmitted: this.deps.onSchedulerSubmitted,
      onSchedulerSubmitting: this.deps.onSchedulerSubmitting,
      onQueueValidationShadowRejection: this.deps.onQueueValidationShadowRejection,
      onJobFinished: this.deps.onJobFinished,
      validateSandboxOutputs: this.deps.validateSandboxOutputs,
      onStatusUpdate: this.deps.onTransition,
      logger: this.deps.logger?.child({ jobId: spec.jobId }),
    });
    this.active.set(spec.jobId, runner);
    const p = runner
      .run(spec, opts.expectedOutputs ?? [])
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(spec.jobId);
        this.done.delete(spec.jobId);
      });
    this.done.set(spec.jobId, p);
    return { jobId: spec.jobId };
  }

  async resume(
    spec: JobSpec,
    schedulerJobId: string,
    opts: { expectedOutputs?: ExpectedOutput[] } = {},
  ): Promise<{ jobId: string }> {
    if (!this.accepting) throw new ExecutorPoolStoppedError();
    if (this.active.has(spec.jobId)) {
      return { jobId: spec.jobId };
    }
    const runner = new JobRunner({
      adapter: this.deps.adapter,
      pollIntervalMs: this.deps.pollIntervalMs,
      sleep: this.deps.sleep,
      collectOutputs: this.deps.collectOutputs,
      ensureWorkingDir: this.deps.ensureWorkingDir,
      onSchedulerSubmitted: this.deps.onSchedulerSubmitted,
      onSchedulerSubmitting: this.deps.onSchedulerSubmitting,
      onQueueValidationShadowRejection: this.deps.onQueueValidationShadowRejection,
      onJobFinished: this.deps.onJobFinished,
      validateSandboxOutputs: this.deps.validateSandboxOutputs,
      onStatusUpdate: this.deps.onTransition,
      logger: this.deps.logger?.child({ jobId: spec.jobId }),
    });
    this.active.set(spec.jobId, runner);
    const p = runner
      .resume(spec, schedulerJobId, opts.expectedOutputs ?? [])
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(spec.jobId);
        this.done.delete(spec.jobId);
      });
    this.done.set(spec.jobId, p);
    return { jobId: spec.jobId };
  }

  /** User-initiated cancel: stop polling AND kill the cluster job. */
  async cancel(jobId: string): Promise<void> {
    const runner = this.active.get(jobId);
    if (!runner) return;
    await runner.cancelAndKill();
    await runner.waitForPendingCancellation();
  }

  get(jobId: string): JobRunner | undefined {
    return this.active.get(jobId);
  }

  listActive(): string[] {
    return [...this.active.keys()];
  }

  await(jobId: string): Promise<void> {
    return this.done.get(jobId) ?? Promise.resolve();
  }

  /** Stop polling all jobs without killing them (agent shutdown). */
  stopAll(): void {
    this.accepting = false;
    for (const r of this.active.values()) r.cancel();
  }
}
