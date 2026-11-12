import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { jobWorkRootReleases, type PgDb, workflowOutputPublications } from "@kuintessence/db";
import type { usecase } from "@kuintessence/shared";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

export interface PublicationFile {
  descriptor: string;
  batch: boolean;
  source: string;
  target: string;
  fileName: string;
  transferId: string;
}
export interface PublicationInput {
  jobId: string;
  ownerId: string;
  agentId: string;
  workflowRunId?: string;
  files: PublicationFile[];
  outputs: Array<{ descriptor: string; path: string; isBatch: boolean; paths: string[] }>;
}
export interface PublicationRecord {
  input: PublicationInput;
  files: Record<string, usecase.FileValue>;
  released: boolean;
}
export interface PublicationSummary {
  jobId: string;
  state: "pending" | "published";
  totalFiles: number;
  publishedFiles: number;
  files: Record<string, usecase.FileInputValue>;
  transferIds: string[];
}
export interface PublicationStore {
  enqueue(input: PublicationInput): Promise<PublicationRecord>;
  get(jobId: string): Promise<PublicationRecord | undefined>;
  pending(): Promise<string[]>;
  claim(jobId: string, token: string): Promise<boolean>;
  renew(jobId: string, token: string): Promise<boolean>;
  save(jobId: string, token: string, files: PublicationRecord["files"]): Promise<void>;
  finish(jobId: string, token: string): Promise<void>;
  retry(jobId: string, token: string, error: string): Promise<void>;
}
export class PgPublicationStore implements PublicationStore {
  constructor(private readonly db: PgDb) {}
  async enqueue(input: PublicationInput) {
    await this.db
      .insert(workflowOutputPublications)
      .values({ jobId: input.jobId, input })
      .onConflictDoNothing();
    const row = await this.get(input.jobId);
    if (!row) throw new Error("Workflow output publication unavailable");
    // Transfer IDs belong to the first durable attempt.
    const binding = (value: PublicationInput) => ({
      ...value,
      files: value.files.map(({ transferId: _id, ...file }) => file),
    });
    if (!isDeepStrictEqual(binding(row.input), binding(input)))
      throw new Error("Workflow publication binding changed");
    return row;
  }
  async get(jobId: string) {
    const [row] = await this.db
      .select()
      .from(workflowOutputPublications)
      .where(eq(workflowOutputPublications.jobId, jobId))
      .limit(1);
    return row
      ? { input: row.input, files: row.files, released: row.releasedAt !== null }
      : undefined;
  }
  async pending() {
    const rows = await this.db
      .select({ id: workflowOutputPublications.jobId })
      .from(workflowOutputPublications)
      .where(
        and(
          isNull(workflowOutputPublications.releasedAt),
          lte(workflowOutputPublications.nextAttemptAt, sql`clock_timestamp()`),
          or(
            isNull(workflowOutputPublications.leaseUntil),
            lte(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
          ),
        ),
      )
      .orderBy(asc(workflowOutputPublications.nextAttemptAt), asc(workflowOutputPublications.jobId))
      .limit(100);
    return rows.map((row) => row.id);
  }
  async claim(jobId: string, token: string) {
    const rows = await this.db
      .update(workflowOutputPublications)
      .set({ token, leaseUntil: sql`clock_timestamp() + interval '15 minutes'` })
      .where(
        and(
          eq(workflowOutputPublications.jobId, jobId),
          isNull(workflowOutputPublications.releasedAt),
          or(
            isNull(workflowOutputPublications.leaseUntil),
            lte(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
          ),
        ),
      )
      .returning({ id: workflowOutputPublications.jobId });
    return rows.length === 1;
  }
  async renew(jobId: string, token: string): Promise<boolean> {
    const rows = await this.db
      .update(workflowOutputPublications)
      .set({ leaseUntil: sql`clock_timestamp() + interval '15 minutes'` })
      .where(
        and(
          eq(workflowOutputPublications.jobId, jobId),
          eq(workflowOutputPublications.token, token),
          isNull(workflowOutputPublications.releasedAt),
          gt(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: workflowOutputPublications.jobId });
    return rows.length === 1;
  }
  async save(jobId: string, token: string, files: PublicationRecord["files"]) {
    const rows = await this.db
      .update(workflowOutputPublications)
      .set({ files, leaseUntil: sql`clock_timestamp() + interval '15 minutes'` })
      .where(
        and(
          eq(workflowOutputPublications.jobId, jobId),
          eq(workflowOutputPublications.token, token),
          isNull(workflowOutputPublications.releasedAt),
          gt(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: workflowOutputPublications.jobId });
    if (!rows.length) throw new Error("Workflow publication lease lost");
  }
  async finish(jobId: string, token: string) {
    const rows = await this.db
      .update(workflowOutputPublications)
      .set({ releasedAt: sql`clock_timestamp()`, leaseUntil: null, token: null, error: null })
      .where(
        and(
          eq(workflowOutputPublications.jobId, jobId),
          eq(workflowOutputPublications.token, token),
          isNull(workflowOutputPublications.releasedAt),
          gt(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: workflowOutputPublications.jobId });
    if (!rows.length) throw new Error("Workflow publication lease lost");
  }
  async enqueueRelease(input: PublicationInput, token: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workflowOutputPublications)
        .where(
          and(
            eq(workflowOutputPublications.jobId, input.jobId),
            eq(workflowOutputPublications.token, token),
            isNull(workflowOutputPublications.releasedAt),
            gt(workflowOutputPublications.leaseUntil, sql`clock_timestamp()`),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !row ||
        row.token !== token ||
        row.releasedAt !== null ||
        !isDeepStrictEqual(row.input, input) ||
        !row.leaseUntil ||
        row.input.files.some((file) => !row.files[file.transferId])
      )
        throw new Error("Workflow publication lease lost or outputs incomplete");
      await tx
        .insert(jobWorkRootReleases)
        .values({ agentId: row.input.agentId, jobId: row.jobId })
        .onConflictDoNothing({ target: jobWorkRootReleases.jobId });
      const [release] = await tx
        .select()
        .from(jobWorkRootReleases)
        .where(eq(jobWorkRootReleases.jobId, row.jobId))
        .limit(1);
      if (!release || release.agentId !== row.input.agentId)
        throw new Error("Workflow publication release binding changed");
    });
  }
  async retry(jobId: string, token: string, error: string) {
    // Expired owners may relinquish only their own claim, without changing results.
    await this.db
      .update(workflowOutputPublications)
      .set({
        error,
        leaseUntil: null,
        token: null,
        nextAttemptAt: sql`clock_timestamp() + interval '30 seconds'`,
      })
      .where(
        and(
          eq(workflowOutputPublications.jobId, jobId),
          eq(workflowOutputPublications.token, token),
          isNull(workflowOutputPublications.releasedAt),
        ),
      );
  }
}

export function publicationRunAllowsDelivery(
  run: { status: string; submittedBy: string | null },
  ownerId: string,
): boolean {
  return run.submittedBy === ownerId && !["cancelling", "cancelled"].includes(run.status);
}

export class WorkflowOutputPublisher {
  private readonly activeRecoveries = new Set<string>();
  constructor(
    private readonly deps: {
      store: PublicationStore;
      authorize(input: PublicationInput): Promise<void>;
      publish(
        input: PublicationInput,
        file: PublicationFile,
        signal: AbortSignal,
      ): Promise<usecase.FileValue>;
      heartbeatMs?: number;
      transferTimeoutMs?: number;
      release(input: PublicationInput, token: string): Promise<void>;
    },
  ) {}
  async inspect(jobId: string): Promise<PublicationSummary | undefined> {
    const record = await this.deps.store.get(jobId);
    if (!record) return undefined;
    await this.deps.authorize(record.input);
    const transferIds = record.input.files.map((file) => file.transferId);
    const publishedFiles = transferIds.filter((id) => record.files[id] !== undefined).length;
    return {
      jobId,
      state: publishedFiles === transferIds.length ? "published" : "pending",
      totalFiles: transferIds.length,
      publishedFiles,
      files: result(record),
      transferIds,
    };
  }
  async collect(input: PublicationInput): Promise<Record<string, usecase.FileInputValue>> {
    await this.deps.store.enqueue(input);
    return this.process(input.jobId);
  }
  async recover(): Promise<void> {
    const ids = (await this.deps.store.pending())
      .filter((id) => !this.activeRecoveries.has(id))
      .slice(0, Math.max(0, 4 - this.activeRecoveries.size));
    await Promise.allSettled(
      ids.map(async (id) => {
        this.activeRecoveries.add(id);
        try {
          await this.process(id);
        } finally {
          this.activeRecoveries.delete(id);
        }
      }),
    );
  }
  async process(jobId: string): Promise<Record<string, usecase.FileInputValue>> {
    const token = randomUUID();
    const existing = await this.deps.store.get(jobId);
    if (!existing) throw new Error("Workflow output publication unavailable");
    if (existing.released) {
      await this.deps.authorize(existing.input);
      return result(existing);
    }
    if (!(await this.deps.store.claim(jobId, token)))
      throw new Error("Workflow publication already active");
    const controller = new AbortController();
    const ensureLease = async () => {
      if (controller.signal.aborted) throw new Error("Workflow publication lease lost");
      if (!(await this.deps.store.renew(jobId, token))) {
        controller.abort();
        throw new Error("Workflow publication lease lost");
      }
    };
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void ensureLease()
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false;
        });
    }, this.deps.heartbeatMs ?? 30_000);
    heartbeat.unref();
    try {
      const record = await this.deps.store.get(jobId);
      if (!record) throw new Error("Workflow output publication unavailable");
      await this.deps.authorize(record.input);
      for (const file of record.input.files) {
        if (record.files[file.transferId]) continue;
        await ensureLease();
        await this.deps.authorize(record.input);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.deps.transferTimeoutMs ?? 6 * 60 * 60_000),
        ]);
        const value = await new Promise<usecase.FileValue>((resolve, reject) => {
          const abort = () =>
            reject(new Error("Workflow output transfer interrupted or timed out"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else
            this.deps
              .publish(record.input, file, signal)
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", abort));
        });
        await ensureLease();
        record.files[file.transferId] = value;
        await this.deps.store.save(jobId, token, record.files);
      }
      await this.deps.authorize(record.input);
      await ensureLease();
      await this.deps.release(record.input, token);
      await this.deps.store.finish(jobId, token);
      return result(record);
    } catch (error) {
      // Persist a fixed diagnostic; transport errors can contain signed URLs or tokens.
      await this.deps.store.retry(
        jobId,
        token,
        "Workflow output publication pending; retry required",
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      controller.abort();
    }
  }
}
function result(record: PublicationRecord): Record<string, usecase.FileInputValue> {
  const values: Record<string, usecase.FileInputValue> = {};
  for (const output of record.input.outputs) if (output.isBatch) values[output.descriptor] = [];
  for (const file of record.input.files) {
    const value = record.files[file.transferId];
    if (!value) continue;
    if (file.batch) {
      const existing = values[file.descriptor];
      values[file.descriptor] = [...(Array.isArray(existing) ? existing : []), value];
    } else values[file.descriptor] = value;
  }
  return values;
}
