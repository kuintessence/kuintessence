import { localJobs, type SqliteDb } from "@kuintessence/db";
import { desc, eq, notInArray } from "drizzle-orm";

/** A job kq submitted on this node, persisted in the all-in-one binary's local
 *  SQLite store so it survives scheduler-queue eviction and TUI restarts. */
export interface PersistedLocalJob {
  jobId: string;
  schedulerJobId?: string;
  name?: string;
  status: string;
  command: string;
  cpus: number;
  memoryMb: number;
  gpus?: number;
  wallTimeSec?: number;
  exitCode?: number;
  submittedAt: Date;
}

/** Persistence seam for the all-in-one (local) backend. Implemented over the
 *  shared `local_jobs` SQLite table; injected so the backend stays unit-testable
 *  with an in-memory store. */
export interface LocalJobStore {
  /** Insert (or upsert by jobId) a job kq just submitted. */
  record(job: Omit<PersistedLocalJob, "exitCode">): void;
  /** Persisted jobs, most-recently-submitted first; `limit` caps the count. */
  list(limit?: number): PersistedLocalJob[];
  /** The freshest persisted job matching the scheduler id (or, as a fallback,
   *  the kq job id), or undefined — for the detail view. */
  findBySchedulerId(id: string): PersistedLocalJob | undefined;
  /** Update a persisted job's status (+ exit code) by its scheduler id; a no-op
   *  when the scheduler id is unknown (job submitted outside kq). */
  updateStatusBySchedulerId(schedulerJobId: string, status: string, exitCode?: number): void;
}

type Row = typeof localJobs.$inferSelect;

function toPersisted(row: Row): PersistedLocalJob {
  return {
    jobId: row.jobId,
    schedulerJobId: row.schedulerJobId ?? undefined,
    name: row.name ?? undefined,
    status: row.status,
    command: row.command,
    cpus: row.cpus,
    memoryMb: row.memoryMb,
    gpus: row.gpus ?? undefined,
    wallTimeSec: row.wallTimeSec ?? undefined,
    exitCode: row.exitCode ?? undefined,
    submittedAt: row.submittedAt,
  };
}

/** SQLite-backed {@link LocalJobStore} over the `local_jobs` table (shared
 *  schema from `@kuintessence/db`). Synchronous (bun:sqlite). */
export class SqliteLocalJobStore implements LocalJobStore {
  /** `maxRows` bounds the table on a long-lived login-node install: each
   *  `record` prunes everything past the most-recent N (the heartbeat queue
   *  caps itself the same way). Generous vs the ~50-row list window. */
  constructor(
    private readonly db: SqliteDb,
    private readonly maxRows = 500,
  ) {}

  record(job: Omit<PersistedLocalJob, "exitCode">): void {
    const now = new Date();
    this.db
      .insert(localJobs)
      .values({
        jobId: job.jobId,
        schedulerJobId: job.schedulerJobId ?? null,
        name: job.name ?? null,
        status: job.status,
        command: job.command,
        cpus: job.cpus,
        memoryMb: job.memoryMb,
        gpus: job.gpus ?? null,
        wallTimeSec: job.wallTimeSec ?? null,
        submittedAt: job.submittedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: localJobs.jobId,
        set: {
          schedulerJobId: job.schedulerJobId ?? null,
          name: job.name ?? null,
          status: job.status,
          updatedAt: now,
        },
      })
      .run();
    // Prune everything past the most-recent maxRows so the table stays bounded.
    const keep = this.db
      .select({ id: localJobs.jobId })
      .from(localJobs)
      .orderBy(desc(localJobs.submittedAt))
      .limit(this.maxRows);
    this.db.delete(localJobs).where(notInArray(localJobs.jobId, keep)).run();
  }

  list(limit?: number): PersistedLocalJob[] {
    const q = this.db.select().from(localJobs).orderBy(desc(localJobs.submittedAt));
    const rows = limit !== undefined ? q.limit(limit).all() : q.all();
    return rows.map(toPersisted);
  }

  findBySchedulerId(id: string): PersistedLocalJob | undefined {
    // Prefer the freshest match: scheduler ids can be recycled, so two rows may
    // share one — the most recently submitted is the live one.
    const bySched = this.db
      .select()
      .from(localJobs)
      .where(eq(localJobs.schedulerJobId, id))
      .orderBy(desc(localJobs.submittedAt))
      .limit(1)
      .all();
    if (bySched[0]) return toPersisted(bySched[0]);
    const byJob = this.db.select().from(localJobs).where(eq(localJobs.jobId, id)).limit(1).all();
    return byJob[0] ? toPersisted(byJob[0]) : undefined;
  }

  updateStatusBySchedulerId(schedulerJobId: string, status: string, exitCode?: number): void {
    // Only overwrite exit_code when one is supplied — a status-only re-poll must
    // not wipe a previously-recorded exit code.
    const set =
      exitCode !== undefined
        ? { status, exitCode, updatedAt: new Date() }
        : { status, updatedAt: new Date() };
    this.db.update(localJobs).set(set).where(eq(localJobs.schedulerJobId, schedulerJobId)).run();
  }
}
