import type { JobStatusName, usecase } from "@kuintessence/shared";

export interface JobCompletion {
  status: JobStatusName;
  collected: Record<string, string>;
  collectedFiles?: Record<string, usecase.FileInputValue>;
  errorMessage?: string;
  reason?: string;
  exitCode?: number;
}

/**
 * Bridges the async job model to the workflow engine's synchronous `awaitCompletion`
 * seam. The gRPC agent-handler calls `complete(jobId, …)` on a terminal
 * JobStatusUpdate; the job submitter calls `awaitCompletion(jobId)`. Either
 * order works — a completion arriving before its await is buffered.
 */
interface PendingEntry {
  resolve: (c: JobCompletion) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// setTimeout stores its delay in a signed 32-bit int; a larger value silently
// overflows and fires (almost) immediately. Clamp so a misconfigured timeout
// degrades to "wait the max" instead of "reject every job at once".
const MAX_TIMER_MS = 2_147_483_647;

export class JobCompletionRegistry {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly buffered = new Map<string, JobCompletion>();

  awaitCompletion(jobId: string, timeoutMs = 0): Promise<JobCompletion> {
    const early = this.buffered.get(jobId);
    if (early) {
      this.buffered.delete(jobId);
      return Promise.resolve(early);
    }
    const effectiveMs = Math.min(timeoutMs, MAX_TIMER_MS);
    return new Promise((resolve, reject) => {
      if (effectiveMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(jobId);
          reject(new Error(`job ${jobId} completion timed out after ${effectiveMs}ms`));
        }, effectiveMs);
        timer.unref();
        this.pending.set(jobId, { resolve, reject, timer });
        return;
      }
      this.pending.set(jobId, { resolve, reject });
    });
  }

  complete(jobId: string, completion: JobCompletion): void {
    const entry = this.pending.get(jobId);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.pending.delete(jobId);
      entry.resolve(completion);
      return;
    }
    this.buffered.set(jobId, completion);
  }
}
