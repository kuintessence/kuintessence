import { createLogger, type JobStatusName, type usecase } from "@kuintessence/shared";

const logger = createLogger("job-completion-registry");

export interface JobCompletion {
  status: JobStatusName;
  collected: Record<string, string>;
  collectedFiles?: Record<string, usecase.FileInputValue>;
  errorMessage?: string;
  reason?: string;
  exitCode?: number;
}

export function collectedForJobCompletion(
  restrictedNoEgress: boolean,
  collected: Record<string, string>,
): Record<string, string> {
  return restrictedNoEgress ? {} : collected;
}

export function completionFromJob(job: {
  status: string;
  restrictedNoEgress: boolean;
  collectedOutputs: Record<string, string> | null;
  errorMessage: string | null;
  reason: string | null;
  exitCode: number | null;
}): JobCompletion | null {
  if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled")
    return null;
  return {
    status: job.status,
    collected: collectedForJobCompletion(job.restrictedNoEgress, job.collectedOutputs ?? {}),
    ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.exitCode !== null ? { exitCode: job.exitCode } : {}),
  };
}

interface PendingEntry {
  resolve: (c: JobCompletion) => void;
  reject: (e: unknown) => void;
  dispose: () => void;
}

interface PendingJob {
  entries: Set<PendingEntry>;
  refreshing: boolean;
  notified: boolean;
  warned: boolean;
  poll?: ReturnType<typeof setTimeout>;
}

const MAX_TIMER_MS = 2_147_483_647;

/** With a loader, the database is authoritative and complete() only wakes readers. */
export class JobCompletionRegistry {
  private readonly pending = new Map<string, PendingJob>();
  private readonly buffered = new Map<string, JobCompletion>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly options: {
      load?: (jobId: string) => Promise<JobCompletion | null>;
      pollIntervalMs?: number;
    } = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 1 ||
      this.pollIntervalMs > MAX_TIMER_MS
    )
      throw new Error("Invalid job completion polling interval");
  }

  awaitCompletion(jobId: string, timeoutMs = 0, signal?: AbortSignal): Promise<JobCompletion> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const early = this.buffered.get(jobId);
    if (early && !this.options.load) {
      this.buffered.delete(jobId);
      return Promise.resolve(early);
    }
    const group = this.pending.get(jobId) ?? {
      entries: new Set<PendingEntry>(),
      refreshing: false,
      notified: false,
      warned: false,
    };
    this.pending.set(jobId, group);
    const promise = new Promise<JobCompletion>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        this.remove(jobId, group, entry);
        reject(signal?.reason);
      };
      const entry: PendingEntry = {
        resolve,
        reject,
        dispose: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      group.entries.add(entry);
      const effectiveMs = Math.min(timeoutMs, MAX_TIMER_MS);
      if (effectiveMs > 0) {
        timer = setTimeout(() => {
          this.remove(jobId, group, entry);
          reject(new Error(`job ${jobId} completion timed out after ${effectiveMs}ms`));
        }, effectiveMs);
        timer.unref();
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
    if (this.options.load) void this.refresh(jobId, group);
    return promise;
  }

  complete(jobId: string, completion: JobCompletion): void {
    const group = this.pending.get(jobId);
    if (this.options.load) {
      if (group) void this.refresh(jobId, group);
      return;
    }
    if (!group) {
      this.buffered.set(jobId, completion);
      return;
    }
    this.resolve(jobId, group, completion);
  }

  private remove(jobId: string, group: PendingJob, entry: PendingEntry): void {
    entry.dispose();
    group.entries.delete(entry);
    if (group.entries.size === 0 && this.pending.get(jobId) === group) {
      if (group.poll) clearTimeout(group.poll);
      this.pending.delete(jobId);
    }
  }

  private resolve(jobId: string, group: PendingJob, completion: JobCompletion): void {
    for (const entry of group.entries) {
      this.remove(jobId, group, entry);
      entry.resolve(completion);
    }
  }

  private async refresh(jobId: string, group: PendingJob): Promise<void> {
    const load = this.options.load;
    if (!load || this.pending.get(jobId) !== group) return;
    if (group.refreshing) {
      group.notified = true;
      return;
    }
    if (group.poll) clearTimeout(group.poll);
    group.refreshing = true;
    try {
      do {
        group.notified = false;
        const completion = await load(jobId);
        group.warned = false;
        if (this.pending.get(jobId) !== group) return;
        if (completion) {
          this.resolve(jobId, group, completion);
          return;
        }
      } while (group.notified);
    } catch (err) {
      if (!group.warned) logger.warn({ err, jobId }, "Job completion read failed; will retry");
      group.warned = true;
    } finally {
      group.refreshing = false;
      if (this.pending.get(jobId) === group) {
        group.poll = setTimeout(() => {
          void this.refresh(jobId, group);
        }, this.pollIntervalMs);
        group.poll.unref();
      }
    }
  }
}
