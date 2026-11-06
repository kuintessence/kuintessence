import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  jobDispatchOutbox,
  jobs,
  type PgDb,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import { type ServerMessage, ServerMessageSchema } from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { AgentDispatcher } from "./dispatcher";

const logger = createLogger("job-dispatch-outbox");

/** Stores the exact authorized envelope. Retries never change Agent, epoch, URLs or signatures. */
export class JobDispatchOutbox {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  async enqueue(
    agentId: string,
    message: ServerMessage,
    workflowRunId?: string,
  ): Promise<{ sent: boolean; pending: boolean }> {
    if (message.payload.case !== "dispatchJob") throw new Error("Expected a job dispatch message");
    const payload = message.payload.value;
    const epoch = Number(payload.dispatchEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid dispatch epoch");
    const bytes = toBinary(ServerMessageSchema, message);
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("Dispatch envelope exceeds 16 MiB");
    const encoded = Buffer.from(bytes).toString("base64");
    const accepted = await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, payload.jobId)).for("update");
      if (
        !job ||
        job.status !== "queued" ||
        job.agentId !== agentId ||
        job.dispatchEpoch !== epoch ||
        job.revokedEpoch >= epoch
      )
        return false;
      const [invocation] = await tx
        .select({ runId: workflowExecutionJobs.runId })
        .from(workflowExecutionJobs)
        .where(eq(workflowExecutionJobs.jobId, job.id));
      if (workflowRunId && invocation && invocation.runId !== workflowRunId)
        throw new Error("Dispatch workflow does not match the persisted invocation");
      const runId = workflowRunId ?? invocation?.runId;
      if (runId) {
        const [run] = await tx
          .select({ status: workflowRuns.status, submittedBy: workflowRuns.submittedBy })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId));
        if (!run || run.status !== "running" || run.submittedBy !== job.submittedBy) return false;
      }
      await tx
        .insert(jobDispatchOutbox)
        .values({
          jobId: job.id,
          agentId,
          dispatchEpoch: epoch,
          payloadBase64: encoded,
          workflowRunId: runId ?? null,
        })
        .onConflictDoNothing();
      const [saved] = await tx
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, job.id));
      if (
        !saved ||
        saved.agentId !== agentId ||
        saved.dispatchEpoch !== epoch ||
        saved.payloadBase64 !== encoded ||
        saved.workflowRunId !== (runId ?? null)
      )
        throw new Error("A committed dispatch envelope cannot be replaced");
      return true;
    });
    if (!accepted) return { sent: false, pending: false };
    // After commit, a delivery failure must not turn an accepted job into a failed job.
    try {
      const sent = await this.deliver(payload.jobId, true);
      return { sent, pending: !sent };
    } catch {
      logger.warn({ jobId: payload.jobId }, "Dispatch retained for retry after delivery failure");
      return { sent: false, pending: true };
    }
  }

  async acknowledge(agentId: string, jobId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [received] = await tx
        .update(jobDispatchOutbox)
        .set({ acknowledgedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(jobDispatchOutbox.jobId, jobId),
            eq(jobDispatchOutbox.agentId, agentId),
            isNull(jobDispatchOutbox.acknowledgedAt),
          ),
        )
        .returning({ jobId: jobDispatchOutbox.jobId });
      if (received)
        await tx
          .update(workflowExecutionJobs)
          .set({ dispatchState: "acknowledged" })
          .where(eq(workflowExecutionJobs.jobId, jobId));
    });
  }

  async redeliver(agentId?: string): Promise<void> {
    const rows = await this.db
      .select({ jobId: jobDispatchOutbox.jobId })
      .from(jobDispatchOutbox)
      .innerJoin(jobs, eq(jobs.id, jobDispatchOutbox.jobId))
      .leftJoin(workflowRuns, eq(workflowRuns.id, jobDispatchOutbox.workflowRunId))
      .where(
        and(
          isNull(jobDispatchOutbox.acknowledgedAt),
          eq(jobs.status, "queued"),
          lt(jobs.revokedEpoch, jobDispatchOutbox.dispatchEpoch),
          or(isNull(jobDispatchOutbox.workflowRunId), eq(workflowRuns.status, "running")),
          eq(jobs.agentId, jobDispatchOutbox.agentId),
          eq(jobs.dispatchEpoch, jobDispatchOutbox.dispatchEpoch),
          agentId
            ? eq(jobDispatchOutbox.agentId, agentId)
            : lte(jobDispatchOutbox.nextAttemptAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(jobDispatchOutbox.nextAttemptAt))
      .limit(50);
    for (const row of rows) {
      try {
        await this.deliver(row.jobId, agentId !== undefined);
      } catch {
        logger.warn({ jobId: row.jobId }, "Dispatch retry deferred");
      }
    }
  }

  private async deliver(jobId: string, force: boolean): Promise<boolean> {
    const delivery = await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      const [saved] = await tx
        .select()
        .from(jobDispatchOutbox)
        .where(
          and(
            eq(jobDispatchOutbox.jobId, jobId),
            isNull(jobDispatchOutbox.acknowledgedAt),
            force ? undefined : lte(jobDispatchOutbox.nextAttemptAt, sql`clock_timestamp()`),
          ),
        )
        .for("update");
      if (
        !job ||
        !saved ||
        job.status !== "queued" ||
        job.agentId !== saved.agentId ||
        job.dispatchEpoch !== saved.dispatchEpoch ||
        job.revokedEpoch >= saved.dispatchEpoch
      )
        return null;
      if (saved.workflowRunId) {
        const [run] = await tx
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, saved.workflowRunId));
        if (run?.status !== "running") return null;
      }
      await tx
        .update(jobDispatchOutbox)
        .set({ nextAttemptAt: sql`clock_timestamp() + interval '10 seconds'` })
        .where(eq(jobDispatchOutbox.jobId, jobId));
      return { agentId: saved.agentId, epoch: saved.dispatchEpoch, encoded: saved.payloadBase64 };
    });
    if (!delivery) return false;
    const message = fromBinary(ServerMessageSchema, Buffer.from(delivery.encoded, "base64"));
    if (
      message.payload.case !== "dispatchJob" ||
      message.payload.value.jobId !== jobId ||
      message.payload.value.dispatchEpoch !== BigInt(delivery.epoch)
    )
      throw new Error("Invalid persisted dispatch envelope");
    return this.dispatcher.pushPreparedDispatch(delivery.agentId, message);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }

  private tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.redeliver()
      .catch(() => logger.error("Dispatch outbox scan failed; will retry"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
