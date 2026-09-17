import type { JobReadScope } from "../auth/job-access";

export type JobLogAccessScope = JobReadScope | "authorization_service";

export interface JobLogAccessEvent {
  actorUserId: string;
  jobId: string;
  access: "tail" | "stream";
  scope: JobLogAccessScope;
}

interface PendingAudit {
  expiresAt: number;
  promise: Promise<void>;
}

export class JobLogAccessAuditor {
  private readonly pending = new Map<string, PendingAudit>();

  constructor(
    private readonly sink: (event: JobLogAccessEvent) => Promise<void>,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async record(event: JobLogAccessEvent): Promise<void> {
    if (event.scope === "owner") return;
    const now = this.now();
    const key = `${event.actorUserId}:${event.jobId}:${event.access}`;
    const existing = this.pending.get(key);
    if (existing && existing.expiresAt > now) {
      await existing.promise;
      return;
    }

    const promise = this.sink(event);
    const pending = { expiresAt: now + this.ttlMs, promise };
    this.pending.set(key, pending);
    try {
      await promise;
    } catch (error) {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      throw error;
    }
    this.pruneExpired(now);
  }

  private pruneExpired(now: number): void {
    if (this.pending.size < 1_000) return;
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(key);
    }
  }
}
