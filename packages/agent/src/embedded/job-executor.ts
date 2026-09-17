import { createLogger, type QueueFailureCode } from "@kuintessence/shared";
import type { Logger } from "pino";
import { type JobSpec, QueueValidationError, type SchedulerAdapter } from "../adapters/base";
import { queueFailureCode } from "../adapters/queue-inventory";
import type { ExpectedOutput } from "../output-collector";

const moduleLogger = createLogger("job-runner");
const STDOUT_CAPTURE_LINES = 200;
const STDOUT_DESCRIPTOR = "stdout";

type SubmissionAttempt =
  | {
      kind: "submitted";
      result: Awaited<ReturnType<SchedulerAdapter["submit"]>>;
    }
  | {
      kind: "interrupted";
      reason: "shutdown" | "user-cancel";
    };

export interface JobStatusReport {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  schedulerJobId?: string;
  exitCode?: number;
  message?: string;
  failureCode?: QueueFailureCode;
  /** Allocated node / node-list once the scheduler assigns one (Slurm `nodes`,
   *  PBS/Torque `exec_host`, K8s pod node). Surfaced in remote-mode job detail. */
  node?: string;
  /** Scheduler reason a job is pending/blocked (Slurm `state_reason`, PBS/Torque
   *  `comment`). Answers "why isn't it running yet" in remote-mode detail. */
  reason?: string;
  workingDir?: string;
  /** Text content of the job's expected output files, keyed by descriptor.
   *  Present only on a `completed` report; the Server extracts typed values from it. */
  collected?: Record<string, string>;
}

export interface JobRunnerDeps {
  adapter: SchedulerAdapter;
  pollIntervalMs?: number;
  /**
   * Hook called whenever job status changes.
   * Used to emit gRPC updates upstream.
   */
  onStatusUpdate: (report: JobStatusReport) => void | Promise<void>;
  /** Reads the job's expected output files into a descriptor→content map on
   *  completion. Injected (container-aware in production); omit to skip. */
  collectOutputs?: (
    outputs: ExpectedOutput[],
    workingDir: string,
  ) => Promise<Record<string, string>>;
  /** Ensures the job's working directory exists (container-aware `mkdir -p`)
   *  before submit, so `sbatch --chdir` and relative output collection work.
   *  Skipped for an empty workingDir. */
  ensureWorkingDir?: (path: string) => Promise<void>;
  /** For testability: allows tests to override Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  onSchedulerSubmitted?: (
    spec: JobSpec,
    schedulerJobId: string,
    expectedOutputs: ExpectedOutput[],
  ) => void | Promise<void>;
  onSchedulerSubmitting?: (spec: JobSpec) => void | Promise<void>;
  onQueueValidationShadowRejection?: (failureCode: QueueFailureCode) => void | Promise<void>;
  onJobFinished?: (jobId: string) => void | Promise<void>;
  validateSandboxOutputs?: (
    spec: NonNullable<JobSpec["sandbox"]>,
    schedulerJobId: string,
  ) => Promise<Record<string, string>>;
}

/**
 * Manages a single dispatched job lifecycle:
 * submit → poll for status changes → emit transitions → stop when terminal.
 * Supports cooperative cancellation via cancel().
 */
export class JobRunner {
  private stopRequested = false;
  private userCancelRequested = false;
  private killRequested = false;
  private killed = false;
  private schedulerJobId: string | null = null;
  private jobId: string | null = null;
  private jobFinished = false;
  private schedulerSubmissionStarted = false;
  private schedulerSubmissionSettled = false;
  private resolveSchedulerSubmission: (() => void) | undefined;
  private readonly schedulerSubmission = new Promise<void>((resolve) => {
    this.resolveSchedulerSubmission = resolve;
  });
  private logger: Logger;

  constructor(private deps: JobRunnerDeps) {
    this.logger = deps.logger ?? moduleLogger;
  }

  /**
   * Submit a job, then poll status until terminal or cancelled.
   * Emits status updates via onStatusUpdate on every status transition.
   * Returns the scheduler job id on success, or null if submission failed.
   */
  async run(spec: JobSpec, expectedOutputs: ExpectedOutput[] = []): Promise<string | null> {
    this.jobId = spec.jobId;

    let attempt: SubmissionAttempt;
    try {
      attempt = await this.submitIfReady(spec);
    } catch (err) {
      if (this.stopRequested && !this.userCancelRequested) {
        this.markSchedulerSubmissionSettled();
        return null;
      }
      if (this.userCancelRequested && !this.schedulerSubmissionStarted) {
        await this.reportCancelledBeforeSubmission(spec);
        return null;
      }
      return this.reportSubmissionFailure(spec, err);
    }

    if (attempt.kind === "interrupted") {
      if (attempt.reason === "user-cancel") {
        await this.reportCancelledBeforeSubmission(spec);
      } else {
        this.markSchedulerSubmissionSettled();
      }
      return null;
    }

    const schedulerJobId = attempt.result.schedulerJobId;
    this.schedulerJobId = schedulerJobId;
    this.logger.info({ jobId: spec.jobId, schedulerJobId }, "Job submitted to scheduler");
    try {
      await this.deps.onSchedulerSubmitted?.(spec, schedulerJobId, expectedOutputs);
      await this.deps.onStatusUpdate({
        jobId: spec.jobId,
        status: "queued",
        schedulerJobId,
        workingDir: spec.workingDir,
      });
    } catch (err) {
      return this.reportSubmissionFailure(spec, err);
    }

    if (this.killRequested) {
      await this.killScheduler();
    }
    this.markSchedulerSubmissionSettled();

    await this.pollUntilTerminal(spec, schedulerJobId, expectedOutputs);
    return schedulerJobId;
  }

  private async submitIfReady(spec: JobSpec): Promise<SubmissionAttempt> {
    const { adapter, ensureWorkingDir } = this.deps;
    let interruption = this.submissionInterruption();
    if (interruption) return interruption;
    if (ensureWorkingDir && spec.workingDir && spec.sandbox?.runtimeKind !== "OCI") {
      await ensureWorkingDir(spec.workingDir);
    }
    interruption = this.submissionInterruption();
    if (interruption) return interruption;
    if (spec.sandbox?.runtimeKind === "OCI") {
      if (!adapter.stageSandboxInputs) {
        throw new Error("Kubernetes Sandbox managed PVC input stager is unavailable");
      }
      await adapter.stageSandboxInputs(spec.sandbox, spec.jobId);
    }
    interruption = this.submissionInterruption();
    if (interruption) return interruption;
    await this.validateQueueTarget(spec);
    interruption = this.submissionInterruption();
    if (interruption) return interruption;
    await this.deps.onSchedulerSubmitting?.(spec);
    interruption = this.submissionInterruption();
    if (interruption) return interruption;
    this.schedulerSubmissionStarted = true;
    return { kind: "submitted", result: await adapter.submit(spec) };
  }

  private submissionInterruption(): Extract<SubmissionAttempt, { kind: "interrupted" }> | null {
    if (this.userCancelRequested) return { kind: "interrupted", reason: "user-cancel" };
    if (this.stopRequested) return { kind: "interrupted", reason: "shutdown" };
    return null;
  }

  private async reportCancelledBeforeSubmission(spec: JobSpec): Promise<void> {
    try {
      await this.deps.onStatusUpdate({
        jobId: spec.jobId,
        status: "cancelled",
        workingDir: spec.workingDir,
      });
      await this.notifyJobFinished(spec.jobId);
    } finally {
      this.markSchedulerSubmissionSettled();
    }
  }

  private async reportSubmissionFailure(spec: JobSpec, err: unknown): Promise<null> {
    this.logger.error({ jobId: spec.jobId, err }, "Job submission failed");
    try {
      await this.deps.onStatusUpdate({
        jobId: spec.jobId,
        status: "failed",
        message: err instanceof Error ? err.message : "submit failed",
        failureCode: queueFailureCode(err),
        workingDir: spec.workingDir,
      });
      await this.notifyJobFinished(spec.jobId);
    } finally {
      this.markSchedulerSubmissionSettled();
    }
    return null;
  }

  private markSchedulerSubmissionSettled(): void {
    if (this.schedulerSubmissionSettled) return;
    this.schedulerSubmissionSettled = true;
    this.resolveSchedulerSubmission?.();
  }

  private async validateQueueTarget(spec: JobSpec): Promise<void> {
    if (
      (spec.queueValidationMode !== "shadow" && spec.queueValidationMode !== "enforce") ||
      (spec.queueTargetMode !== "default" && spec.queueTargetMode !== "named")
    ) {
      return;
    }
    const validate = this.deps.adapter.validateQueueTarget;
    if (!validate) return;
    const result = await validate.call(this.deps.adapter, {
      targetMode: spec.queueTargetMode,
      ...(spec.queueName ? { queueName: spec.queueName } : {}),
    });
    if (result.accepted) return;
    this.logger.warn(
      { jobId: spec.jobId, failureCode: result.failureCode, mode: spec.queueValidationMode },
      "Scheduler queue validation rejected dispatch",
    );
    if (spec.queueValidationMode === "shadow") {
      try {
        await this.deps.onQueueValidationShadowRejection?.(result.failureCode);
      } catch (err) {
        this.logger.warn(
          { jobId: spec.jobId, failureCode: result.failureCode, err },
          "Failed to report scheduler queue validation shadow rejection",
        );
      }
      return;
    }
    if (spec.queueValidationMode === "enforce") {
      throw new QueueValidationError(result.failureCode);
    }
  }

  async resume(
    spec: JobSpec,
    schedulerJobId: string,
    expectedOutputs: ExpectedOutput[] = [],
  ): Promise<string> {
    this.jobId = spec.jobId;
    this.schedulerJobId = schedulerJobId;
    await this.deps.adapter.prepareResume?.(spec, schedulerJobId);
    this.logger.info({ jobId: spec.jobId, schedulerJobId }, "Resuming scheduler job polling");
    await this.pollUntilTerminal(spec, schedulerJobId, expectedOutputs);
    return schedulerJobId;
  }

  private async pollUntilTerminal(
    spec: JobSpec,
    schedulerJobId: string,
    expectedOutputs: ExpectedOutput[],
  ): Promise<void> {
    const { adapter, onStatusUpdate, pollIntervalMs = 10_000 } = this.deps;
    const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    let lastStatus: JobStatusReport["status"] = "queued";
    // Also track node/reason: a queued job's `reason` ("why isn't it running")
    // and a running job's `node` often change *without* a status transition, and
    // the Server should see those updates too — emit on any of the three changing.
    let lastNode: string | undefined;
    let lastReason: string | undefined;
    let terminal = false;

    while (!this.shouldStopPolling()) {
      await sleep(pollIntervalMs);
      if (this.shouldStopPolling()) break;

      let result: Awaited<ReturnType<typeof adapter.status>>;
      try {
        result = await adapter.status(schedulerJobId);
      } catch (err) {
        this.logger.warn({ jobId: spec.jobId, err }, "Status poll failed; will retry");
        continue;
      }

      const statusChanged = result.status !== lastStatus;
      if (statusChanged || result.node !== lastNode || result.reason !== lastReason) {
        lastStatus = result.status;
        lastNode = result.node;
        lastReason = result.reason;
        let reportStatus = result.status;
        let reportMessage = result.message;
        let collected: Record<string, string> | undefined;
        if (statusChanged && result.status === "completed") {
          try {
            if (spec.restrictedNoEgress) {
              collected = undefined;
            } else if (spec.sandbox) {
              if (!this.deps.validateSandboxOutputs) {
                throw new Error("Sandbox output validator is unavailable");
              }
              const sandboxFacts = await this.deps.validateSandboxOutputs(
                spec.sandbox,
                schedulerJobId,
              );
              collected = { ...(collected ?? {}), ...sandboxFacts };
            }
            if (!spec.restrictedNoEgress) {
              collected = {
                ...(collected ?? {}),
                ...(await this.collectTerminalOutputs(
                  expectedOutputs,
                  spec.workingDir,
                  schedulerJobId,
                )),
              };
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "output collection failed";
            this.logger.error({ jobId: spec.jobId, err }, "Output collection failed");
            reportStatus = "failed";
            reportMessage = `output collection failed: ${message}`;
          }
        }
        await onStatusUpdate({
          jobId: spec.jobId,
          status: reportStatus,
          schedulerJobId,
          exitCode: result.exitCode,
          message: reportMessage,
          node: result.node,
          reason: result.reason,
          collected,
          workingDir: spec.workingDir,
        });
      }

      if (result.status === "completed" || result.status === "failed") {
        terminal = true;
        break;
      }
    }

    if (terminal) {
      await adapter.releaseJob?.(schedulerJobId);
      await this.notifyJobFinished(spec.jobId);
    }
  }

  private async collectTerminalOutputs(
    expectedOutputs: ExpectedOutput[],
    workingDir: string,
    schedulerJobId: string,
  ): Promise<Record<string, string>> {
    const collected =
      this.deps.collectOutputs && expectedOutputs.length > 0
        ? await this.deps.collectOutputs(expectedOutputs, workingDir)
        : {};
    if (!this.deps.adapter.getJobLogs || STDOUT_DESCRIPTOR in collected) {
      return collected;
    }
    try {
      collected[STDOUT_DESCRIPTOR] = await this.deps.adapter.getJobLogs(
        schedulerJobId,
        STDOUT_CAPTURE_LINES,
      );
    } catch (err) {
      this.logger.warn(
        { schedulerJobId, err },
        "Failed to capture job stdout for value extraction",
      );
    }
    return collected;
  }

  /**
   * Signal the polling loop to stop WITHOUT killing the cluster job. Idempotent.
   * Used on agent shutdown (`stop()`): the scheduler job keeps running and the
   * agent re-attaches to it on reconnect.
   */
  cancel(): void {
    this.stopRequested = true;
  }

  /**
   * User-initiated cancel: stop polling AND kill the cluster job (scancel/qdel).
   * Idempotent — the scheduler is asked to cancel at most once.
   */
  async cancelAndKill(): Promise<void> {
    this.userCancelRequested = true;
    this.killRequested = true;
    await this.killScheduler();
  }

  private shouldStopPolling(): boolean {
    return this.stopRequested || this.userCancelRequested;
  }

  async waitForPendingCancellation(): Promise<void> {
    if (!this.killRequested || this.killed || this.schedulerSubmissionSettled) return;
    await this.schedulerSubmission;
  }

  /** Ask the scheduler to cancel the job at most once. No-op without an id. */
  private async killScheduler(): Promise<void> {
    if (this.killed || !this.schedulerJobId) return;
    this.killed = true;
    try {
      await this.deps.adapter.cancel(this.schedulerJobId);
      this.logger.info(
        { jobId: this.jobId, schedulerJobId: this.schedulerJobId },
        "Scheduler job cancelled",
      );
      if (this.jobId) {
        await this.notifyJobFinished(this.jobId);
      }
    } catch (err) {
      this.logger.warn(
        { jobId: this.jobId, schedulerJobId: this.schedulerJobId, err },
        "Failed to cancel scheduler job",
      );
    }
  }

  private async notifyJobFinished(jobId: string): Promise<void> {
    if (this.jobFinished) return;
    this.jobFinished = true;
    await this.deps.onJobFinished?.(jobId);
  }
}

export { JobRunner as JobExecutor };
